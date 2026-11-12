// PATCH22 转码总闸（maxConcurrentTranscodes）测试：同一时刻最多 N 首歌在跑
// ffmpeg 转码，超出 FIFO 排队。姿势同 orchestrator.test.ts —— 全程 deps 注入桩，
// 零真实网络 / 零真实 ffmpeg / 零 DB 写。
//
// 覆盖三组：
//   A. 并发峰值：上限 2 时，6 首目标流水线的 transcodeFile 同时在跑数 ≤ 2（且能到 2，
//      证明不是被退化成串行）；
//   B. 失败释放：转码抛错（硬前置失败路径）也经 finally 释放闸位，后续歌照常推进；
//   C. 配置归一化：缺省 4、夹值 1..16。
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { runFetchPipeline, type FetchDeps } from "../../src/services/fetch/orchestrator.js";
import { resolveFetchConfig } from "../../src/services/fetch/config.js";
import type { Candidate } from "../../src/services/fetch/types.js";
import type { FetchTarget } from "../../src/services/fetch/candidates.js";

let DL = "";
let CA = "";

beforeEach(() => {
  DL = mkdtempSync(join(tmpdir(), "mf-tcgate-dl-"));
  CA = mkdtempSync(join(tmpdir(), "mf-tcgate-ca-"));
});

afterEach(() => {
  rmSync(DL, { recursive: true, force: true });
  rmSync(CA, { recursive: true, force: true });
});

async function defaultDownload(o: { url: string; destPath: string }) {
  mkdirSync(dirname(o.destPath), { recursive: true });
  writeFileSync(o.destPath, "DATA");
  return {
    bytes: 8_000_000,
    httpStatus: 200,
    sha256: `sha-${o.url}`,
    rangeSupported: true,
    finalUrl: o.url,
    partial: false,
  };
}

type AnyDeps = { [K in keyof FetchDeps]?: any };

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
    writeTags: (async (src: string) => ({ ok: true, file: src, bytes: 1000, mtimeMs: Date.now(), warnings: [] })) as any,
    transcodeFile: (async (src: string) => ({
      ok: true,
      srcPath: src,
      dstPath: src,
      skipped: true,
      bytes: 1000,
      warnings: [],
    })) as any,
    finalizeFile: ((src: { cachePath: string }) => ({
      action: "write",
      finalPath: join(DL, "out.mp3"),
      warnings: [],
    })) as any,
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
    searchMetadata: (async () => null) as any,
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

function cand(o: { id: string }): Candidate {
  return {
    id: o.id,
    pluginId: "gmd",
    platform: "wy",
    url: `http://h/${o.id}.mp3`,
    sourceRank: 0,
    declared: { container: "mp3", bitrateKbps: 320 },
  };
}

function tgt(o: { id: string; title: string }): FetchTarget {
  return { id: o.id, title: o.title, artist: "A", album: "", durationSec: 200 };
}

const oneMp3 = async () => [cand({ id: "c" })];

function run(
  over: Omit<Partial<Parameters<typeof runFetchPipeline>[0]>, "config"> & {
    config?: Record<string, unknown>;
  },
): Promise<any> {
  return runFetchPipeline({
    ...over,
    config: { downloadRoot: DL, cacheRoot: CA, ...(over.config ?? {}) },
  } as any);
}

describe("PATCH22 转码总闸 maxConcurrentTranscodes", () => {
  it("A. 上限 2：6 首目标的转码并发峰值 ≤ 2，且能到 2（闸在放行不是串行）", async () => {
    // 用「测试代管闸门」代替固定 sleep：转码进来先挂起，由用例放行。这样峰值判据与
    // 磁盘/CPU 负载无关 —— 原写法 sleep 250ms，CI 上第二首进闸要 1~4s（/tmp 写 8MB 的
    // 真实 I/O 在并行跑 628 个用例时被拖慢）→ peak=1 假红（2026-11-12 全量跑实测）。
    let cur = 0;
    let peak = 0;
    const pending: Array<() => void> = [];
    const tr = async (src: string) => {
      cur++;
      peak = Math.max(peak, cur);
      await new Promise<void>((resolve) => {
        pending.push(() => {
          cur--;
          resolve();
        });
      });
      return { ok: true, srcPath: src, dstPath: src.replace(/\.mp3$/, ".flac"), skipped: false, bytes: 1000, warnings: [] };
    };
    const deps = makeDeps({ collectCandidates: oneMp3, transcodeFile: tr });
    const targets = Array.from({ length: 6 }, (_, i) => tgt({ id: `t${i}`, title: `Song ${i}` }));
    const done = run({
      targets,
      sourceId: "src-1",
      config: { transcodeEnabled: true, transcodeTarget: "flac", transcodeLoudnessNormalize: false, maxConcurrentTranscodes: 2, perHostMinIntervalMs: 0, maxConcurrentDownloads: 3 },
      deps,
    });

    const waitFor = async (cond: () => boolean, why: string): Promise<void> => {
      const deadline = Date.now() + 10_000;
      while (!cond()) {
        if (Date.now() > deadline) throw new Error(`等待超时：${why}`);
        await new Promise((r) => setTimeout(r, 5));
      }
    };
    // 闸上限 2 ⇒ 第 2 首**必然**能进闸；若被退化成串行，这里会 10s 后明确失败。
    await waitFor(() => pending.length >= 2, "第 2 首转码进闸（闸=2 时应立即放行）");
    expect(peak).toBe(2);

    // 逐批放行（每批 ≤2），直到 6 首全部转码完成。
    let entered = 0;
    while (entered < 6) {
      if (pending.length === 0) {
        await waitFor(() => pending.length > 0, "下一首转码进闸");
        continue;
      }
      const batch = pending.splice(0, pending.length);
      entered += batch.length;
      batch.forEach((fn) => fn());
    }
    const r = await done;
    expect(r.items.map((x: any) => x.status)).toEqual(Array(6).fill("done"));
    expect(peak).toBeLessThanOrEqual(2);
    expect(peak).toBe(2);
  }, 30_000);

  it("B. 转码抛错经 finally 释放闸位：失败歌照常收尾，其余歌不被卡死", async () => {
    let calls = 0;
    const tr = async () => {
      calls++;
      throw new Error("ffmpeg boom");
    };
    const deps = makeDeps({ collectCandidates: oneMp3, transcodeFile: tr });
    const targets = Array.from({ length: 3 }, (_, i) => tgt({ id: `t${i}`, title: `Song ${i}` }));
    const r = await run({
      targets,
      sourceId: "src-1",
      config: { transcodeEnabled: true, transcodeTarget: "flac", transcodeLoudnessNormalize: false, maxConcurrentTranscodes: 1 },
      deps,
    });
    expect(calls).toBe(3);
    expect(r.items.map((x: any) => x.status)).toEqual(Array(3).fill("failed"));
    expect(r.items[0].errorCode).toBe("TRANSCODE_FAILED");
  });

  it("C. 配置归一化：缺省 4，夹值 1..16", () => {
    expect(resolveFetchConfig({}).maxConcurrentTranscodes).toBe(4);
    expect(resolveFetchConfig({ maxConcurrentTranscodes: 99 } as any).maxConcurrentTranscodes).toBe(16);
    expect(resolveFetchConfig({ maxConcurrentTranscodes: 0 } as any).maxConcurrentTranscodes).toBe(1);
    expect(resolveFetchConfig({ maxConcurrentTranscodes: 7 } as any).maxConcurrentTranscodes).toBe(7);
    expect(resolveFetchConfig({ maxConcurrentTranscodes: "x" } as any).maxConcurrentTranscodes).toBe(4);
  });
});
