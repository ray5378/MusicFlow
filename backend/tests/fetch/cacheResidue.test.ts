// ==================== 缓存残留回归守卫（v4.6.22） ====================
//
// 背景：240 生产实测下载缓存目录 /MUSIC/DOWNLOADCACHE 残留 13.9G / 3002 个 mp3 —— 根因是
// 「转码成功后原始源文件不删」（+ finalize keep 不清产物 + cleanup 不删空目录）。本文件锁定
// orchestrator.tryCandidate / cleanup 的清理语义，防止回归：
//   R1 下载转码成功 → 缓存源被删且候选目录被清（cacheRoot 无残留）；
//   R2 transcodeKeepOriginal = true → 源文件保留在缓存目录（不删）；
//   R3 转码 skipped（dstPath === 源）→ 源文件不得被误删（防过度修复）；
//   R4 finalize 返回 keep → 本次缓存产物被清理；
//   R5 洗版原地替换（inPlace）转码成功 → 缓存清空；
//   R6 洗版原地替换 + finalize keep → 产物被清理。
//
// 唯一涉及真实文件系统的是 cacheRoot 下的落盘与清理（用 os.tmpdir 真实临时目录）。DB 侧
// 由 tests/setup.ts 建表，无需额外导入。
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, extname, join } from "node:path";
import {
  runFetchPipeline,
  type FetchDeps,
  type FetchPipelineResult,
  type RunFetchPipelineOptions,
} from "../../src/services/fetch/orchestrator.js";
import type { Candidate } from "../../src/services/fetch/types.js";
import type { FetchConfig } from "../../src/services/fetch/config.js";
import type { FetchTarget } from "../../src/services/fetch/candidates.js";

// ==================== 现场 ====================

let DL = "";
let CA = "";

beforeEach(() => {
  DL = mkdtempSync(join(tmpdir(), "mf-res-dl-"));
  CA = mkdtempSync(join(tmpdir(), "mf-res-ca-"));
});

afterEach(() => {
  rmSync(DL, { recursive: true, force: true });
  rmSync(CA, { recursive: true, force: true });
});

// ==================== 桩 ====================

type AnyDeps = { [K in keyof FetchDeps]?: any };

/** 真实落盘的下载桩：写 <destPath>（.part），8MB = 320kbps / 200s。 */
async function defaultDownload(o: { url: string; destPath: string }) {
  mkdirSync(dirname(o.destPath), { recursive: true });
  writeFileSync(o.destPath, Buffer.alloc(8_000_000, 1));
  return {
    bytes: 8_000_000,
    httpStatus: 200,
    sha256: `sha-${o.url}`,
    rangeSupported: true,
    finalUrl: o.url,
    partial: false,
  };
}

/** 「真换封装」转码桩：写 dst（目标容器），并（可选）记录 src 路径。 */
function transcodeChanging(target: "flac" | "alac" | "wav", seen?: string[]) {
  return vi.fn((src: string) => {
    seen?.push(src);
    const dst = src.replace(/\.[^.]+$/, target === "alac" ? ".m4a" : `.${target}`);
    writeFileSync(dst, Buffer.alloc(22_500_000, 2));
    return {
      ok: true as const,
      srcPath: src,
      dstPath: dst,
      skipped: false,
      bytes: 22_500_000,
      warnings: [] as string[],
    };
  });
}

/** finalize 桩：真实把缓存成品搬到最终位置（模拟生产 finalize 的 rename 语义）。 */
function movingFinalize() {
  return vi.fn((o: { cachePath: string; destDirOverride?: string; destRootOverride?: string }) => {
    const destDir = o.destDirOverride ?? o.destRootOverride ?? DL;
    const finalPath = join(destDir, basename(o.cachePath));
    mkdirSync(dirname(finalPath), { recursive: true });
    if (existsSync(o.cachePath)) renameSync(o.cachePath, finalPath);
    return { action: "write" as const, finalPath, warnings: [] as string[] };
  });
}

function makeDeps(over: AnyDeps = {}): FetchDeps {
  const base: FetchDeps = {
    collectCandidates: (async () => []) as any,
    downloadToFile: defaultDownload as any,
    probeRemoteSize: (async () => null) as any,
    verifyIntegrity: (async () => ({ ok: true, level: "probe", detail: { bytes: 1000 }, warnings: [] })) as any,
    probeFile: (async (file: string) => {
      const flac = file.endsWith(".flac");
      return {
        path: file,
        bytes: flac ? 22_500_000 : 8_000_000,
        container: flac ? "flac" : "mp3",
        bitDepth: flac ? 16 : undefined,
        bitrateKbps: flac ? 900 : 320,
        sampleRateHz: 44100,
        durationSec: 200,
        hasCover: false,
      };
    }) as any,
    writeTags: (async (src: string) => ({
      ok: true,
      file: src,
      bytes: 1000,
      mtimeMs: Date.now(),
      warnings: [],
    })) as any,
    transcodeFile: transcodeChanging("flac") as any,
    finalizeFile: movingFinalize() as any,
    findExistingPlayable: (() => null) as any,
    scanLocalFiles: (async () => ({ added: 0, updated: 0, failed: 0, skipped: 0 })) as any,
    ensureDownloadSource: (() => ({
      sourceId: "src-1",
      created: true,
      reusedExisting: false,
      ancestorSourceId: null,
    })) as any,
    rankCandidates: ((c: Candidate[]) => c) as any,
    searchLyrics: (async () => null) as any,
    searchCover: (async () => null) as any,
    shouldSkipByCooldown: (() => false) as any,
    lastDownloadAttempt: (() => null) as any,
    recordDownloadAttempt: (() => undefined) as any,
    purgeDeadSongs: (() => ({
      enabled: true,
      threshold: 2,
      candidates: 0,
      purged: 0,
      skippedLocal: 0,
      deferred: 0,
      playlistEntries: 0,
      covers: 0,
      lyrics: 0,
      errors: 0,
      details: [],
    })) as any,
    rollbackPermanentFailure: (() => undefined) as any,
  };
  return { ...base, ...over } as FetchDeps;
}

function cand(o: {
  id: string;
  url: string;
  container?: string;
  bitrateKbps?: number;
  bitDepth?: number;
}): Candidate {
  return {
    id: o.id,
    pluginId: "gmd",
    platform: "wy",
    url: o.url,
    sourceRank: 0,
    declared: { container: o.container, bitrateKbps: o.bitrateKbps, bitDepth: o.bitDepth },
  };
}

function tgt(o: { id: string; title: string; artist?: string; album?: string; durationSec?: number }): FetchTarget {
  return { id: o.id, title: o.title, artist: o.artist, album: o.album, durationSec: o.durationSec };
}

/** 统一注入合法的下载/缓存目录（避免 orchestrator 真的去 /MUSIC 下建目录）。 */
function run(
  over: Omit<Partial<RunFetchPipelineOptions>, "config"> & { config?: Partial<FetchConfig> },
): Promise<FetchPipelineResult> {
  return runFetchPipeline({
    ...over,
    config: { downloadRoot: DL, cacheRoot: CA, ...(over.config ?? {}) },
  });
}

const oneMp3 = async () => [cand({ id: "c", url: "http://h/a.mp3", container: "mp3", bitrateKbps: 320 })];

/** cacheRoot 下递归条目（含目录）。为空数组 = 既无残留文件、也无残留空目录。 */
function cacheEntries(): string[] {
  try {
    return readdirSync(CA, { recursive: true }) as string[];
  } catch {
    return [];
  }
}

/** 洗版原地替换用例的公共现场：准备原件 + 目标（假无损但高于原件 → 触发 inPlace）。 */
function inPlaceScene(songId: string) {
  const origDir = join(DL, "Artist");
  mkdirSync(origDir, { recursive: true });
  const origFile = join(origDir, "old.mp3");
  writeFileSync(origFile, "OLD");
  const target: FetchTarget = {
    id: `upgrade:${songId}`,
    title: "Song",
    artist: "Artist",
    sourceData: JSON.stringify({
      upgrade: { songId, path: `l:dl-x:${origFile}`, suffix: "mp3", bitRate: 500 },
    }),
  };
  return { origDir, origFile, target };
}

// ==================== 用例 ====================

describe("缓存残留回归守卫（v4.6.22）", () => {
  it("R1. 下载转码成功 → 缓存源被删 + 候选目录被清（cacheRoot 无残留）", async () => {
    const seen: string[] = [];
    const deps = makeDeps({
      collectCandidates: oneMp3,
      transcodeFile: transcodeChanging("flac", seen) as any,
      finalizeFile: movingFinalize() as any,
    });
    const r = await run({
      targets: [tgt({ id: "t1", title: "Song", artist: "A", durationSec: 200 })],
      sourceId: "src-1",
      deps,
    });
    expect(r.items[0].status).toBe("done");
    expect(seen).toHaveLength(1);
    // 源（.mp3）被删（产物 .flac 已搬到 DL）
    expect(existsSync(seen[0])).toBe(false);
    // 无残留：既没有残留文件，也没有残留空目录
    expect(cacheEntries()).toEqual([]);
  });

  it("R2. transcodeKeepOriginal = true → 源文件保留在缓存目录（不删）", async () => {
    const seen: string[] = [];
    const deps = makeDeps({
      collectCandidates: oneMp3,
      transcodeFile: transcodeChanging("flac", seen) as any,
      finalizeFile: movingFinalize() as any,
    });
    const r = await run({
      targets: [tgt({ id: "t2", title: "Song", artist: "A", durationSec: 200 })],
      sourceId: "src-1",
      deps,
      config: { transcodeKeepOriginal: true },
    });
    expect(r.items[0].status).toBe("done");
    expect(seen).toHaveLength(1);
    // 源文件按开关语义保留（留在 cacheRoot，不进音乐库）
    expect(existsSync(seen[0])).toBe(true);
  });

  it("R3. 转码 skipped（dstPath === 源）→ 源文件不得被误删（防过度修复）", async () => {
    const seen: string[] = [];
    const deps = makeDeps({
      collectCandidates: oneMp3,
      transcodeFile: (async (src: string) => {
        seen.push(src);
        return { ok: true as const, srcPath: src, dstPath: src, skipped: true, bytes: 8_000_000, warnings: [] };
      }) as any,
      finalizeFile: movingFinalize() as any,
    });
    const r = await run({
      targets: [tgt({ id: "t3", title: "Song", artist: "A", durationSec: 200 })],
      sourceId: "src-1",
      deps,
    });
    expect(r.items[0].status).toBe("done");
    // 产物即源本身，应被 finalize 搬到最终位置（而不是被删掉）
    expect(existsSync(join(DL, basename(seen[0])))).toBe(true);
  });

  it("R4. finalize 返回 keep → 本次缓存产物被清理", async () => {
    const deps = makeDeps({
      collectCandidates: oneMp3,
      finalizeFile: (() => ({ action: "keep" as const, warnings: [] })) as any,
    });
    const r = await run({
      targets: [tgt({ id: "t4", title: "Song", artist: "A", durationSec: 200 })],
      sourceId: "src-1",
      deps,
    });
    expect(r.items[0].status).toBe("skipped");
    expect(cacheEntries()).toEqual([]);
  });

  it("R5. 洗版原地替换（inPlace）转码成功 → 缓存清空", async () => {
    const { origFile, target } = inPlaceScene("old-r5");
    const seen: string[] = [];
    const deps = makeDeps({
      collectCandidates: async () => [
        cand({ id: "fl", url: "http://h/x.flac", container: "flac", bitrateKbps: 999, bitDepth: 16 }),
      ],
      downloadToFile: (async (o: { url: string; destPath: string }) => {
        mkdirSync(dirname(o.destPath), { recursive: true });
        writeFileSync(o.destPath, Buffer.alloc(13_750_000, 1)); // 550kbps：假无损但 > 原件基准 500
        return { bytes: 13_750_000, httpStatus: 200, sha256: "s", rangeSupported: true, finalUrl: o.url, partial: false };
      }) as any,
      probeFile: (async (file: string) => {
        const ext = extname(file).slice(1).toLowerCase();
        const lossless = ext === "flac" || ext === "m4a" || ext === "wav";
        return {
          path: file,
          bytes: 13_750_000,
          container: ext || "mp3",
          bitDepth: lossless ? 16 : undefined,
          bitrateKbps: 550,
          sampleRateHz: 44100,
          durationSec: 200,
          hasCover: false,
        };
      }) as any,
      // 换到 wav：dstPath ≠ 源，触发「转码成功后删源」（洗版与下载共用 tryCandidate）
      transcodeFile: transcodeChanging("wav", seen) as any,
      finalizeFile: movingFinalize() as any,
      scanLocalFiles: (async () => ({ added: 1, updated: 0, failed: 0, skipped: 0 })) as any,
    });
    const r = await run({
      targets: [target],
      sourceId: "src-1",
      deps,
      config: { transcodeTarget: "wav" },
      originalDisposal: { action: "keep", allowedRoots: [DL] },
    });
    expect(r.items[0].status).toBe("done");
    expect(r.items[0].inPlace).toEqual({ fsPath: origFile, sourceId: "dl-x" });
    expect(seen).toHaveLength(1);
    expect(existsSync(seen[0])).toBe(false); // 转码源（.flac）被删
    expect(cacheEntries()).toEqual([]); // 无残留
  });

  it("R6. 洗版原地替换 + finalize keep → 产物被清理（无残留）", async () => {
    const { target } = inPlaceScene("old-r6");
    const deps = makeDeps({
      collectCandidates: async () => [
        cand({ id: "fl", url: "http://h/x.flac", container: "flac", bitrateKbps: 999, bitDepth: 16 }),
      ],
      downloadToFile: (async (o: { url: string; destPath: string }) => {
        mkdirSync(dirname(o.destPath), { recursive: true });
        writeFileSync(o.destPath, Buffer.alloc(13_750_000, 1));
        return { bytes: 13_750_000, httpStatus: 200, sha256: "s", rangeSupported: true, finalUrl: o.url, partial: false };
      }) as any,
      probeFile: (async (file: string) => {
        const ext = extname(file).slice(1).toLowerCase();
        const lossless = ext === "flac" || ext === "m4a" || ext === "wav";
        return {
          path: file,
          bytes: 13_750_000,
          container: ext || "mp3",
          bitDepth: lossless ? 16 : undefined,
          bitrateKbps: 550,
          sampleRateHz: 44100,
          durationSec: 200,
          hasCover: false,
        };
      }) as any,
      transcodeFile: transcodeChanging("wav") as any,
      finalizeFile: (() => ({ action: "keep" as const, warnings: [] })) as any,
    });
    const r = await run({
      targets: [target],
      sourceId: "src-1",
      deps,
      config: { transcodeTarget: "wav" },
      originalDisposal: { action: "keep", allowedRoots: [DL] },
    });
    expect(r.items[0].status).toBe("skipped");
    expect(cacheEntries()).toEqual([]);
  });
});
