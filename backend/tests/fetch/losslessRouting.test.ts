// 下载品质分流（产品定调 2026-10-11）：源本身达标无损 → 成品直接落 losslessRoot。
//
// 判据**复用洗版同一套门槛**（isBelowUpgradeBar / buildUpgradeQuality）：
//   压缩无损（flac/alac/ape）≥700kbps；未压缩（wav/aiff）≥1400kbps；有损容器一律不算。
// 关键不变量：判据取**转码前**的源探针 —— 转码会把成品统一变成 flac，只看最终容器无法
// 区分「真无损」与「有损转 flac」。
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  runFetchPipeline,
  type FetchDeps,
  type FetchPipelineResult,
  type RunFetchPipelineOptions,
} from "../../src/services/fetch/orchestrator.js";
import { finalizeFile } from "../../src/services/fetch/finalize.js";
import { resolveFetchConfig, type FetchConfig } from "../../src/services/fetch/config.js";
import type { Candidate } from "../../src/services/fetch/types.js";
import type { FetchTarget } from "../../src/services/fetch/candidates.js";

let DL = "";
let LL = "";
let CA = "";

beforeEach(() => {
  DL = mkdtempSync(join(tmpdir(), "mf-lr-dl-"));
  LL = mkdtempSync(join(tmpdir(), "mf-lr-ll-"));
  CA = mkdtempSync(join(tmpdir(), "mf-lr-ca-"));
});

afterEach(() => {
  for (const d of [DL, LL, CA]) rmSync(d, { recursive: true, force: true });
});

// ==================== finalizeFile：destRootOverride ====================

describe("finalizeFile.destRootOverride", () => {
  function cfg(partial: Partial<FetchConfig> = {}): FetchConfig {
    return resolveFetchConfig({ downloadRoot: DL, cacheRoot: CA, losslessRoot: LL, ...partial });
  }

  it("保留命名模板的相对目录结构，只换根（downloadRoot 不被触碰）", () => {
    const cache = join(CA, "tmp.flac");
    writeFileSync(cache, "FLAC-BYTES");
    const r = finalizeFile({
      cachePath: cache,
      target: { title: "T", artist: "A", album: "Al" },
      probed: { container: "flac" },
      config: cfg(),
      destRootOverride: LL,
    });
    expect(r.action).toBe("write");
    expect(r.finalPath).toBe(join(LL, "A/Al/T - A.flac"));
    expect(r.relativePath).toBe("A/Al/T - A.flac");
    expect(existsSync(join(DL, "A/Al/T - A.flac"))).toBe(false);
    expect(existsSync(r.finalPath as string)).toBe(true);
  });

  it("不给 destRootOverride → 行为照旧落 downloadRoot", () => {
    const cache = join(CA, "tmp.flac");
    writeFileSync(cache, "FLAC-BYTES");
    const r = finalizeFile({
      cachePath: cache,
      target: { title: "T", artist: "A", album: "Al" },
      probed: { container: "flac" },
      config: cfg(),
    });
    expect(r.finalPath).toBe(join(DL, "A/Al/T - A.flac"));
  });

  it("destDirOverride 优先于 destRootOverride（原地替换语义更强）", () => {
    const cache = join(CA, "tmp.flac");
    writeFileSync(cache, "FLAC-BYTES");
    const inPlaceDir = join(DL, "orig");
    mkdirSync(inPlaceDir, { recursive: true });
    const r = finalizeFile({
      cachePath: cache,
      target: { title: "T", artist: "A", album: "Al" },
      probed: { container: "flac" },
      config: cfg(),
      destDirOverride: inPlaceDir,
      destRootOverride: LL,
    });
    expect(r.finalPath).toBe(join(inPlaceDir, "T - A.flac"));
  });
});

// ==================== 流水线：按源品质分流 ====================

async function defaultDownload(o: { url: string; destPath: string }) {
  mkdirSync(dirname(o.destPath), { recursive: true });
  writeFileSync(o.destPath, "DATA");
  return {
    bytes: o.url.includes("flac") ? 22_500_000 : 8_000_000,
    httpStatus: 200,
    sha256: `sha-${o.url}`,
    rangeSupported: true,
    finalUrl: o.url,
    partial: false,
  };
}

const SRC_DOWNLOAD = "src-download";
const SRC_LOSSLESS = "src-lossless";

function makeDeps(over: Record<string, any> = {}): FetchDeps {
  const base = {
    collectCandidates: (async () => []) as any,
    downloadToFile: defaultDownload as any,
    probeRemoteSize: (async () => null) as any,
    verifyIntegrity: (async () => ({ ok: true, level: "probe", detail: { bytes: 1000 }, warnings: [] })) as any,
    // 探针按**落盘文件的扩展名**给容器/体量：.flac → 900kbps（达标）；其余 → 320kbps。
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
    writeTags: (async (src: string) => ({ ok: true, file: src, bytes: 1000, mtimeMs: Date.now(), warnings: [] })) as any,
    transcodeFile: (async (src: string) => ({
      ok: true,
      srcPath: src,
      dstPath: src,
      skipped: true,
      bytes: 1000,
      warnings: [],
    })) as any,
    finalizeFile: (() => ({ action: "write", finalPath: join(DL, "out.bin"), warnings: [] })) as any,
    findExistingPlayable: (() => null) as any,
    scanLocalFiles: (async () => ({ added: 1, updated: 0, failed: 0, skipped: 0 })) as any,
    ensureDownloadSource: ((root: string) => ({
      sourceId: String(root) === LL ? SRC_LOSSLESS : SRC_DOWNLOAD,
      created: true,
      reusedExisting: false,
      ancestorSourceId: null,
    })) as any,
    rankCandidates: ((c: Candidate[]) => c) as any,
    searchLyrics: (async () => null) as any,
    searchCover: (async () => null) as any,
    isRecentlyAttempted: (() => false) as any,
    recordDownloadAttempt: (() => undefined) as any,
  };
  return { ...base, ...over } as unknown as FetchDeps;
}

function cand(o: { id: string; url: string; container?: string; bitrateKbps?: number; bitDepth?: number }): Candidate {
  return {
    id: o.id,
    pluginId: "gmd",
    platform: "wy",
    url: o.url,
    sourceRank: 0,
    declared: { container: o.container, bitrateKbps: o.bitrateKbps, bitDepth: o.bitDepth },
  } as Candidate;
}

function tgt(o: { id: string; title: string; artist?: string; album?: string; durationSec?: number }): FetchTarget {
  return { id: o.id, title: o.title, artist: o.artist, album: o.album, durationSec: o.durationSec } as FetchTarget;
}

function run(
  over: Omit<Partial<RunFetchPipelineOptions>, "config"> & { config?: Partial<FetchConfig> },
): Promise<FetchPipelineResult> {
  return runFetchPipeline({
    ...over,
    config: {
      downloadRoot: DL,
      cacheRoot: CA,
      losslessRoot: LL,
      scanBatchSize: 1,
      ...(over.config ?? {}),
    },
  });
}

describe("runFetchPipeline 品质分流", () => {
  it("源为无损达标（flac 900kbps）→ 落 losslessRoot，并按无损媒体源入库", async () => {
    const fin = vi.fn(() => ({ action: "write", finalPath: join(LL, "A/Al/T - A.flac"), warnings: [] }));
    const scan = vi.fn(async () => ({ added: 1, updated: 0, failed: 0, skipped: 0 }));
    const deps = makeDeps({
      collectCandidates: async () => [cand({ id: "c1", url: "http://h/song.flac", container: "flac", bitrateKbps: 900, bitDepth: 16 })],
      finalizeFile: fin as any,
      scanLocalFiles: scan as any,
    });
    const r = await run({
      targets: [tgt({ id: "t1", title: "T", artist: "A", album: "Al", durationSec: 200 })],
      sourceId: SRC_DOWNLOAD,
      deps,
    });
    expect(r.items[0].status).toBe("done");
    expect(r.items[0].destRoot).toBe(LL);
    // finalize 拿到 destRootOverride；且不得给 destDirOverride（非原地替换）。
    const arg = fin.mock.calls[0][0] as any;
    expect(arg.destRootOverride).toBe(LL);
    expect(arg.destDirOverride).toBeUndefined();
    // 入库必须走**无损**媒体源，否则扫描器在下载源下找不到文件。
    expect(scan).toHaveBeenCalledWith(SRC_LOSSLESS, [join(LL, "A/Al/T - A.flac")], undefined, undefined);
  });

  it("源为有损（mp3 320kbps）→ 照旧落 downloadRoot，不产生 destRoot", async () => {
    const fin = vi.fn(() => ({ action: "write", finalPath: join(DL, "A/Al/T - A.mp3"), warnings: [] }));
    const scan = vi.fn(async () => ({ added: 1, updated: 0, failed: 0, skipped: 0 }));
    const deps = makeDeps({
      collectCandidates: async () => [cand({ id: "c1", url: "http://h/song.mp3", container: "mp3", bitrateKbps: 320 })],
      finalizeFile: fin as any,
      scanLocalFiles: scan as any,
    });
    const r = await run({
      targets: [tgt({ id: "t1", title: "T", artist: "A", album: "Al", durationSec: 200 })],
      sourceId: SRC_DOWNLOAD,
      deps,
    });
    expect(r.items[0].status).toBe("done");
    expect(r.items[0].destRoot).toBeUndefined();
    const arg = fin.mock.calls[0][0] as any;
    expect(arg.destRootOverride).toBeUndefined();
    expect(scan).toHaveBeenCalledWith(SRC_DOWNLOAD, [join(DL, "A/Al/T - A.mp3")], undefined, undefined);
  });

  it("losslessRoot 与 downloadRoot 相同 → 不分流（避免无谓建源）", async () => {
    const fin = vi.fn(() => ({ action: "write", finalPath: join(DL, "out.flac"), warnings: [] }));
    const deps = makeDeps({
      collectCandidates: async () => [cand({ id: "c1", url: "http://h/song.flac", container: "flac", bitrateKbps: 900, bitDepth: 16 })],
      finalizeFile: fin as any,
    });
    const r = await run({
      targets: [tgt({ id: "t1", title: "T", artist: "A", album: "Al", durationSec: 200 })],
      sourceId: SRC_DOWNLOAD,
      // 同根：loadlessRoot === downloadRoot
      config: { losslessRoot: DL },
      deps,
    });
    expect(r.items[0].destRoot).toBeUndefined();
    expect((fin.mock.calls[0][0] as any).destRootOverride).toBeUndefined();
  });
});
