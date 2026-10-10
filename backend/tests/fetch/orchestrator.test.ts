// orchestrator 流水线测试：**全程用 deps 注入桩**，零真实网络 / 零真实 ffmpeg。
// 唯一涉及真实文件系统的是「缓存目录里的 .part → 正确扩展名」这一步 rename（用 os.tmpdir），
// 数据库侧仅做只读反查（setup.ts 已建表）。
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  runFetchPipeline,
  type FetchDeps,
  type FetchPipelineResult,
  type RunFetchPipelineOptions,
} from "../../src/services/fetch/orchestrator.js";
import { rankCandidates as realRankCandidates } from "../../src/services/fetch/quality.js";
import type { Candidate } from "../../src/services/fetch/types.js";
import type { FetchConfig } from "../../src/services/fetch/config.js";
import type { FetchTarget } from "../../src/services/fetch/candidates.js";

// ==================== 现场 ====================

let DL = "";
let CA = "";

beforeEach(() => {
  DL = mkdtempSync(join(tmpdir(), "mf-orch-dl-"));
  CA = mkdtempSync(join(tmpdir(), "mf-orch-ca-"));
});

afterEach(() => {
  rmSync(DL, { recursive: true, force: true });
  rmSync(CA, { recursive: true, force: true });
});

// ==================== 桩 ====================

async function defaultDownload(o: { url: string; destPath: string }) {
  if (o.url.includes("fail")) {
    const e = new Error("源站 403") as Error & { code: string };
    e.code = "HTTP_403";
    throw e;
  }
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

type AnyDeps = { [K in keyof FetchDeps]?: any };

function makeDeps(over: AnyDeps = {}): FetchDeps {
  const base: FetchDeps = {
    collectCandidates: (async () => []) as any,
    downloadToFile: defaultDownload as any,
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
    finalizeFile: (() => ({ action: "write", finalPath: join(DL, "out.mp3"), warnings: [] })) as any,
    findExistingPlayable: (() => null) as any,
    scanLocalFiles: (async () => ({ added: 0, updated: 0, failed: 0, skipped: 0 })) as any,
    ensureDownloadSource: (() => ({
      sourceId: "src-1",
      created: true,
      reusedExisting: false,
      ancestorSourceId: null,
    })) as any,
    rankCandidates: ((c: Candidate[]) => c) as any,
    // 增值项（歌词/封面 provider）：默认关闭，避免单测触达真实插件沙箱。
    searchLyrics: (async () => null) as any,
    searchCover: (async () => null) as any,
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

// ==================== 用例 ====================

describe("runFetchPipeline", () => {
  it("1. 本地已有 → skipped + ALREADY_IN_LIBRARY，零取链零下载（需求 3）", async () => {
    const collect = vi.fn(async () => [cand({ id: "c1", url: "http://h/a.mp3", container: "mp3", bitrateKbps: 320 })]);
    const dl = vi.fn(defaultDownload);
    const deps = makeDeps({
      collectCandidates: collect,
      downloadToFile: dl,
      findExistingPlayable: () => ({
        songId: "s1",
        path: "l:src:/m/a.mp3",
        kind: "local",
        title: "Song",
        artist: "A",
        album: "",
        durationSec: 200,
      }),
    });
    const r = await run({
      targets: [tgt({ id: "t1", title: "Song", artist: "A", durationSec: 200 })],
      sourceId: "src-1",
      deps,
    });
    expect(r.items[0].status).toBe("skipped");
    expect(r.items[0].errorCode).toBe("ALREADY_IN_LIBRARY");
    expect(collect).not.toHaveBeenCalled();
    expect(dl).not.toHaveBeenCalled();
  });

  it("2. 只下最高音质：flac 失败后 320k 一次都没被尝试（strictBestTier）", async () => {
    const dl = vi.fn(defaultDownload);
    const deps = makeDeps({
      collectCandidates: async () => [
        cand({ id: "c128", url: "http://h/128.mp3", container: "mp3", bitrateKbps: 128 }),
        cand({ id: "c320", url: "http://h/320.mp3", container: "mp3", bitrateKbps: 320 }),
        cand({ id: "cflac", url: "http://h/fail.flac", container: "flac", bitrateKbps: 900, bitDepth: 16 }),
      ],
      downloadToFile: dl,
      rankCandidates: realRankCandidates as any,
    });
    const r = await run({
      targets: [tgt({ id: "t1", title: "Song", durationSec: 200 })],
      sourceId: "src-1",
      config: { quality: { preferLossless: false } },
      deps,
    });
    expect(r.items[0].status).toBe("failed");
    expect(dl).toHaveBeenCalledTimes(1);
    expect(dl.mock.calls[0][0].url).toContain("flac");
    expect(dl.mock.calls.some((c: any[]) => String(c[0].url).includes("320"))).toBe(false);
  });

  it("3. 同档内可换源：第一个 flac 失败 → 第二个 flac 成功（attempts=2）", async () => {
    const dl = vi.fn(defaultDownload);
    const deps = makeDeps({
      collectCandidates: async () => [
        cand({ id: "f1", url: "http://h/fail.flac", container: "flac", bitrateKbps: 900, bitDepth: 16 }),
        cand({ id: "f2", url: "http://h/ok.flac", container: "flac", bitrateKbps: 900, bitDepth: 16 }),
      ],
      downloadToFile: dl,
    });
    const r = await run({ targets: [tgt({ id: "t1", title: "Song", durationSec: 200 })], sourceId: "src-1", deps });
    expect(r.items[0].status).toBe("done");
    expect(r.items[0].attempts).toBe(2);
    expect(dl).toHaveBeenCalledTimes(2);
  });

  it("4. strictBestTier=false 时允许降档：flac 失败后 320k 被尝试", async () => {
    const dl = vi.fn(defaultDownload);
    const deps = makeDeps({
      collectCandidates: async () => [
        cand({ id: "f1", url: "http://h/fail.flac", container: "flac", bitrateKbps: 900, bitDepth: 16 }),
        cand({ id: "m320", url: "http://h/320.mp3", container: "mp3", bitrateKbps: 320 }),
      ],
      downloadToFile: dl,
    });
    const r = await run({
      targets: [tgt({ id: "t1", title: "Song", durationSec: 200 })],
      sourceId: "src-1",
      config: { strictBestTier: false },
      deps,
    });
    expect(r.items[0].status).toBe("done");
    expect(dl).toHaveBeenCalledTimes(2);
    expect(String(dl.mock.calls[1][0].url)).toContain("320");
  });

  it("5. 完整性失败 → 换候选；全失败 → failed + 最后错误码，rejected 长度=尝试次数", async () => {
    const verify = vi.fn(async () => ({
      ok: false,
      level: "probe",
      code: "INTEGRITY_FAILED",
      detail: { bytes: 1 },
      warnings: ["文件头不是音频"],
    }));
    const deps = makeDeps({
      collectCandidates: async () => [
        cand({ id: "a", url: "http://h/a.flac", container: "flac", bitrateKbps: 900, bitDepth: 16 }),
        cand({ id: "b", url: "http://h/b.flac", container: "flac", bitrateKbps: 900, bitDepth: 16 }),
      ],
      verifyIntegrity: verify,
    });
    const r = await run({ targets: [tgt({ id: "t1", title: "Song", durationSec: 200 })], sourceId: "src-1", deps });
    const it0 = r.items[0];
    expect(it0.status).toBe("failed");
    expect(it0.errorCode).toBe("INTEGRITY_FAILED");
    expect(it0.attempts).toBe(2);
    expect(it0.rejected.length).toBe(it0.attempts);
  });

  it("6. 假无损被拒 → FAKE_LOSSLESS，且不落盘", async () => {
    const finalize = vi.fn(() => ({ action: "write" as const, finalPath: join(DL, "x.mp3"), warnings: [] }));
    const deps = makeDeps({
      collectCandidates: async () => [
        cand({ id: "fl", url: "http://h/fake.flac", container: "flac", bitrateKbps: 900, bitDepth: 16 }),
      ],
      probeFile: async (file: string) => ({
        path: file,
        bytes: 1000,
        container: "flac",
        bitDepth: 16,
        durationSec: undefined,
        bitrateKbps: 300,
        hasCover: false,
      }),
      finalizeFile: finalize,
    });
    const r = await run({ targets: [tgt({ id: "t1", title: "Song" })], sourceId: "src-1", deps });
    expect(r.items[0].status).toBe("failed");
    expect(r.items[0].rejected[0].reason).toBe("FAKE_LOSSLESS");
    expect(finalize).not.toHaveBeenCalled();
  });

  it("7. 试听片段被拒（时长超差），不落盘", async () => {
    const finalize = vi.fn();
    const deps = makeDeps({
      collectCandidates: oneMp3,
      probeFile: async (file: string) => ({
        path: file,
        bytes: 8_000_000,
        container: "mp3",
        bitrateKbps: 320,
        sampleRateHz: 44100,
        durationSec: 30,
        hasCover: false,
      }),
      finalizeFile: finalize,
    });
    const r = await run({ targets: [tgt({ id: "t1", title: "Song", durationSec: 200 })], sourceId: "src-1", deps });
    expect(r.items[0].status).toBe("failed");
    expect(r.items[0].rejected[0].detail).toMatch(/时长/);
    expect(finalize).not.toHaveBeenCalled();
  });

  it("8. 任务内重复 target → 第二个 DUPLICATE_TARGET", async () => {
    const deps = makeDeps({ collectCandidates: oneMp3 });
    const r = await run({
      targets: [
        tgt({ id: "t1", title: "Same", artist: "A", durationSec: 200 }),
        tgt({ id: "t2", title: "Same", artist: "A", durationSec: 200 }),
      ],
      sourceId: "src-1",
      deps,
    });
    expect(r.items[0].status).toBe("done");
    expect(r.items[1].status).toBe("skipped");
    expect(r.items[1].errorCode).toBe("DUPLICATE_TARGET");
  });

  it("9. dryRun → 全 queued，且不下载/不落盘/不入库", async () => {
    const dl = vi.fn();
    const fin = vi.fn();
    const scan = vi.fn(async () => ({ added: 0, updated: 0, failed: 0, skipped: 0 }));
    const deps = makeDeps({ collectCandidates: oneMp3, downloadToFile: dl, finalizeFile: fin, scanLocalFiles: scan });
    const r = await run({
      targets: [tgt({ id: "t1", title: "A", durationSec: 200 }), tgt({ id: "t2", title: "B", durationSec: 200 })],
      sourceId: "src-1",
      dryRun: true,
      deps,
    });
    expect(r.items.length).toBe(2);
    expect(r.items.every((i) => i.status === "queued")).toBe(true);
    expect(dl).not.toHaveBeenCalled();
    expect(fin).not.toHaveBeenCalled();
    expect(scan).not.toHaveBeenCalled();
  });

  it("10. 转码开关：开→调用且 finalPath 来自转码后路径；关→不调用", async () => {
    const captured: string[] = [];
    const fin = vi.fn((o: any) => {
      captured.push(o.cachePath);
      return { action: "write" as const, finalPath: join(DL, "f.flac"), warnings: [] };
    });
    const tr = vi.fn(async (src: string) => ({
      ok: true,
      srcPath: src,
      dstPath: src.replace(/\.mp3$/, ".flac"),
      skipped: false,
      bytes: 1000,
      warnings: [],
    }));
    const deps = makeDeps({ collectCandidates: oneMp3, finalizeFile: fin, transcodeFile: tr });
    const r = await run({ targets: [tgt({ id: "t1", title: "A", durationSec: 200 })], sourceId: "src-1", deps });
    expect(r.items[0].status).toBe("done");
    expect(tr).toHaveBeenCalledTimes(1);
    expect(String(captured[0]).endsWith(".flac")).toBe(true);

    const tr2 = vi.fn();
    const deps2 = makeDeps({ collectCandidates: oneMp3, transcodeFile: tr2 });
    await run({
      targets: [tgt({ id: "t1", title: "A", durationSec: 200 })],
      sourceId: "src-1",
      config: { transcodeEnabled: false },
      deps: deps2,
    });
    expect(tr2).not.toHaveBeenCalled();
  });

  it("11. 转码失败 = 硬前置失败：候选判失败换下一候选，绝不落未转码成品（产品定调 2026-10-10）", async () => {
    const tr = vi.fn(async () => {
      throw new Error("ffmpeg boom");
    });
    const deps = makeDeps({ collectCandidates: oneMp3, transcodeFile: tr });
    const r = await run({ targets: [tgt({ id: "t1", title: "A", durationSec: 200 })], sourceId: "src-1", deps });
    expect(r.items[0].status).toBe("failed");
    expect(r.items[0].errorCode).toBe("TRANSCODE_FAILED");
  });

  it("12. 落盘时已存在更优文件（finalize=keep）→ skipped，且不再试其他候选", async () => {
    const dl = vi.fn(defaultDownload);
    const deps = makeDeps({
      collectCandidates: async () => [
        cand({ id: "a", url: "http://h/a.flac", container: "flac", bitrateKbps: 900, bitDepth: 16 }),
        cand({ id: "b", url: "http://h/b.flac", container: "flac", bitrateKbps: 900, bitDepth: 16 }),
      ],
      downloadToFile: dl,
      finalizeFile: () => ({ action: "keep" as const, warnings: [] }),
    });
    const r = await run({ targets: [tgt({ id: "t1", title: "A", durationSec: 200 })], sourceId: "src-1", deps });
    expect(r.items[0].status).toBe("skipped");
    expect(r.items[0].errorCode).toBe("ALREADY_IN_LIBRARY");
    expect(r.items[0].attempts).toBe(1);
    expect(dl).toHaveBeenCalledTimes(1);
  });

  it("13. 入库攒批：scanBatchSize=3 时 5 首成功 → scanLocalFiles 调 2 次（3+2）", async () => {
    const scan = vi.fn(async () => ({ added: 1, updated: 0, failed: 0, skipped: 0 }));
    const fin = vi.fn((o: any) => ({
      action: "write" as const,
      finalPath: join(DL, `${o.target.title}.mp3`),
      warnings: [],
    }));
    const deps = makeDeps({ collectCandidates: oneMp3, finalizeFile: fin, scanLocalFiles: scan });
    const targets = ["A", "B", "C", "D", "E"].map((s, i) => tgt({ id: `t${i}`, title: s, durationSec: 200 }));
    const r = await run({ targets, sourceId: "src-1", config: { scanBatchSize: 3 }, deps });
    expect(r.items.filter((i) => i.status === "done").length).toBe(5);
    expect(scan).toHaveBeenCalledTimes(2);
    expect(scan.mock.calls[0][1].length).toBe(3);
    expect(scan.mock.calls[1][1].length).toBe(2);
    expect(r.counts.added).toBe(2);
  });

  it("14. abort → 剩余 target 全 cancelled", async () => {
    const ac = new AbortController();
    ac.abort();
    const deps = makeDeps({ collectCandidates: oneMp3 });
    const r = await run({
      targets: [tgt({ id: "t1", title: "A" }), tgt({ id: "t2", title: "B" })],
      sourceId: "src-1",
      signal: ac.signal,
      deps,
    });
    expect(r.items.length).toBe(2);
    expect(r.items.every((i) => i.status === "cancelled")).toBe(true);
  });

  it("15. 非法配置（cacheRoot 在 downloadRoot 内）→ 整体失败，warnings 含中文原因", async () => {
    const r = await run({
      targets: [tgt({ id: "t1", title: "A" })],
      sourceId: "src-1",
      config: { downloadRoot: "/MUSIC/DL", cacheRoot: "/MUSIC/DL/cache" },
      deps: makeDeps(),
    });
    expect(r.items.length).toBe(0);
    expect(r.warnings.some((w) => w.includes("cacheRoot 位于 downloadRoot 之内"))).toBe(true);
  });

  it("16. 无质量声明的候选（聚合源）在 dryRun 下判为 queued，不再 BELOW_BAR（生产回归）", async () => {
    // 贴近真实：go-music-dl 只给 URL + 平台歌曲 id，不声明容器/比特率。
    const bare: Candidate = {
      id: "go-music-dl:kg:B6A303C9CDA8E6C4C0B2FB0B23A570C6",
      pluginId: "go-music-dl",
      platform: "kg",
      url: "https://cdn.example.com/x.mp3",
      sourceRank: 0,
      title: "Shape of You",
      artist: "Ed Sheeran",
    };
    const deps = makeDeps({ collectCandidates: async () => [bare], rankCandidates: realRankCandidates as any });
    const r = await run({
      targets: [tgt({ id: "t1", title: "Shape of You", artist: "Ed Sheeran", durationSec: 200 })],
      sourceId: "src-1",
      dryRun: true,
      deps,
    });
    expect(r.items[0].status).toBe("queued");
    expect(r.items[0].errorCode).toBeUndefined();
  });

  it("17. 增值标签：genre / lyric / cover 都写入，封面优先用候选自带 coverUrl", async () => {
    let got: any;
    const writeTags = vi.fn(async (src: string, tags: any) => {
      got = tags;
      return { ok: true, file: src, bytes: 1000, mtimeMs: Date.now(), warnings: [] };
    });
    const coverSearch = vi.fn(async () => "http://h/should-not-be-called.jpg");
    const deps = makeDeps({
      collectCandidates: async () => [
        {
          ...cand({ id: "c", url: "http://h/a.mp3", container: "mp3", bitrateKbps: 320 }),
          title: "Song",
          artist: "A",
          album: "Alb",
          genre: "Pop",
          coverUrl: "http://h/cover.jpg",
        },
      ],
      writeTags,
      searchLyrics: (async () => "[00:01.00]la la") as any,
      searchCover: coverSearch as any,
    });
    const r = await run({
      targets: [tgt({ id: "t1", title: "Song", artist: "A", album: "Alb", durationSec: 200 })],
      sourceId: "src-1",
      deps,
    });
    expect(r.items[0].status).toBe("done");
    expect(got.genre).toBe("Pop");
    expect(got.lyric).toBe("[00:01.00]la la");
    expect(Buffer.isBuffer(got.cover)).toBe(true);
    expect((got.cover as Buffer).length).toBeGreaterThan(0);
    expect(coverSearch).not.toHaveBeenCalled(); // 候选自带 coverUrl → 不调 provider
  });

  it("18. 无候选封面 → 回落 searchCover provider 取图", async () => {
    const coverSearch = vi.fn(async () => "http://h/from-provider.jpg");
    const writeTags = vi.fn(async (src: string, tags: any) => {
      expect(Buffer.isBuffer(tags.cover)).toBe(true);
      return { ok: true, file: src, bytes: 1000, mtimeMs: Date.now(), warnings: [] };
    });
    const deps = makeDeps({ collectCandidates: oneMp3, searchCover: coverSearch as any, writeTags });
    const r = await run({ targets: [tgt({ id: "t1", title: "A", durationSec: 200 })], sourceId: "src-1", deps });
    expect(r.items[0].status).toBe("done");
    expect(coverSearch).toHaveBeenCalledTimes(1);
  });

  it("19. 增值项全失败不致命：仍 done，只多 warnings（歌词/封面各一条）", async () => {
    const deps = makeDeps({
      collectCandidates: async () => [
        {
          ...cand({ id: "c", url: "http://h/a.mp3", container: "mp3", bitrateKbps: 320 }),
          coverUrl: "http://h/fail-cover.jpg",
        },
      ],
      searchLyrics: (async () => {
        throw new Error("lyric provider down");
      }) as any,
      searchCover: (async () => {
        throw new Error("cover provider down");
      }) as any,
    });
    const r = await run({ targets: [tgt({ id: "t1", title: "A", durationSec: 200 })], sourceId: "src-1", deps });
    expect(r.items[0].status).toBe("done");
    expect(r.warnings.some((w) => w.includes("歌词获取失败"))).toBe(true);
    expect(r.warnings.some((w) => w.includes("封面下载失败") || w.includes("封面获取失败"))).toBe(true);
  });

  it("20. 转码透传响度归一化参数（cfg 默认开，目标 -14 LUFS）", async () => {
    const seen: any[] = [];
    const tr = vi.fn(async (src: string, o: any) => {
      seen.push(o);
      return { ok: true, srcPath: src, dstPath: src.replace(/\.mp3$/, ".flac"), skipped: false, bytes: 1000, warnings: [] };
    });
    const deps = makeDeps({ collectCandidates: oneMp3, transcodeFile: tr });
    await run({ targets: [tgt({ id: "t1", title: "A", durationSec: 200 })], sourceId: "src-1", deps });
    expect(tr).toHaveBeenCalledTimes(1);
    expect(seen[0].loudnessNormalize).toBe(true);
    expect(seen[0].loudnessTargetLufs).toBe(-14);
    expect(seen[0].loudnessTwoPass).toBe(true);
  });
});
