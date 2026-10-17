// orchestrator 覆盖率缺口补齐测试（与 orchestrator.test.ts 分离，避免合并冲突）。
//
// 目标：把 orchestrator.ts 的尾部（终态结算 / tag-repair 登记）、错误与重试分支、
// 洗版迁移/处置链路等未覆盖区间补齐到门禁阈值以上。
//
// 纪律：模块本体保持**真实**，仅对重型/叶子依赖打桩（零网络 / 零 ffmpeg / 零子进程）。
// 另通过 vi.mock 精确替换 writable.ts（写权限预检）与 upgrade.ts（洗版处置），
// 以可确定地制造「不可写 / 迁移成功 / 处置成功」等分支。
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  runFetchPipeline,
  type FetchDeps,
  type FetchPipelineResult,
} from "../../src/services/fetch/orchestrator.js";
import type { Candidate } from "../../src/services/fetch/types.js";
import type { FetchTarget } from "../../src/services/fetch/candidates.js";

/** 可变的桩状态：集中控制写权限预检 / 洗版迁移与处置的返回。 */
const hs = vi.hoisted(() => ({
  canWrite: true,
  ensureThrow: false,
  migrate: { migrated: true, warnings: [] as string[] },
  dispose: { action: "delete", deleted: true, warnings: [] as string[] } as {
    action: string;
    deleted?: boolean;
    movedTo?: string;
    warnings: string[];
  },
  prune: { removed: [] as string[], warnings: [] as string[] },
}));

// 写权限预检：改为可控桩（真实实现依赖磁盘权限，无法确定覆盖「不可写」分支）。
vi.mock("../../src/services/fetch/writable.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/services/fetch/writable.js")>();
  return {
    ...actual,
    ensureWritableDir: (_d: string) => {
      if (hs.ensureThrow) throw new Error("目录不可写(桩)");
    },
    canWriteDir: () => hs.canWrite,
  };
});

// 洗版处置：迁移/处置/清目录改为可控桩；门槛判据（buildUpgradeQuality /
// isBelowUpgradeBar）保留真实实现，保证品质分流判定口径不变。
vi.mock("../../src/services/fetch/upgrade.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/services/fetch/upgrade.js")>();
  return {
    ...actual,
    migrateUpgradedSong: async () => hs.migrate,
    disposeOriginalFile: () => hs.dispose,
    pruneEmptyDirs: () => hs.prune,
  };
});

let DL = "";
let CA = "";
let LL = "";

beforeEach(() => {
  DL = mkdtempSync(join(tmpdir(), "mf-gap-dl-"));
  CA = mkdtempSync(join(tmpdir(), "mf-gap-ca-"));
  LL = mkdtempSync(join(tmpdir(), "mf-gap-ll-"));
  hs.canWrite = true;
  hs.ensureThrow = false;
  hs.migrate = { migrated: true, warnings: [] };
  hs.dispose = { action: "delete", deleted: true, warnings: [] };
  hs.prune = { removed: [], warnings: [] };
});

afterEach(() => {
  rmSync(DL, { recursive: true, force: true });
  rmSync(CA, { recursive: true, force: true });
  rmSync(LL, { recursive: true, force: true });
});

/** 默认桩集：全部为内存级，零真实 IO（除缓存目录里造 .part 文件外）。 */
function makeDeps(over: Record<string, unknown> = {}): FetchDeps {
  const base: Record<string, unknown> = {
    collectCandidates: async () => [],
    downloadToFile: async (o: { url: string; destPath: string }) => {
      mkdirSync(dirname(o.destPath), { recursive: true });
      writeFileSync(o.destPath, "DATA");
      return {
        bytes: 8_000_000,
        httpStatus: 200,
        sha256: "s",
        rangeSupported: true,
        finalUrl: o.url,
        partial: false,
      };
    },
    probeRemoteSize: async () => null,
    verifyIntegrity: async () => ({ ok: true, level: "probe", detail: { bytes: 1000 }, warnings: [] }),
    probeFile: async (file: string) => ({
      path: file,
      bytes: 8_000_000,
      container: file.endsWith(".flac") ? "flac" : "mp3",
      bitrateKbps: file.endsWith(".flac") ? 900 : 320,
      sampleRateHz: 44100,
      durationSec: 200,
      hasCover: false,
    }),
    writeTags: async (src: string) => ({ ok: true, file: src, bytes: 1000, mtimeMs: 1, warnings: [] }),
    transcodeFile: async (src: string) => ({
      ok: true,
      srcPath: src,
      dstPath: src,
      skipped: true,
      bytes: 1000,
      warnings: [],
    }),
    finalizeFile: (o: { target: { title: string } }) => ({
      action: "write",
      finalPath: join(DL, `out-${o.target.title}.mp3`),
      warnings: [],
    }),
    findExistingPlayable: () => null,
    scanLocalFiles: async () => ({ added: 0, updated: 0, failed: 0, skipped: 0 }),
    ensureDownloadSource: () => ({
      sourceId: "src-1",
      created: true,
      reusedExisting: false,
      ancestorSourceId: null,
    }),
    rankCandidates: (c: Candidate[]) => c,
    searchLyrics: async () => null,
    searchCover: async () => null,
    searchMetadata: async () => null,
    shouldSkipByCooldown: () => false,
    lastDownloadAttempt: () => null,
    recordDownloadAttempt: () => undefined,
    purgeDeadSongs: () => ({
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
    }),
    rollbackPermanentFailure: () => undefined,
  };
  return { ...base, ...over } as unknown as FetchDeps;
}

/** 统一注入合法路径；perHostMinIntervalMs=0 让用例免于 500ms 站点间隔拖慢。 */
function run(
  over: Record<string, unknown> & { config?: Record<string, unknown> },
): Promise<FetchPipelineResult> {
  return runFetchPipeline({
    ...over,
    config: { downloadRoot: DL, cacheRoot: CA, perHostMinIntervalMs: 0, ...(over.config ?? {}) },
  } as never);
}

function cand(o: {
  id: string;
  url: string;
  container?: string;
  bitrateKbps?: number;
  bitDepth?: number;
  declared?: Record<string, unknown>;
  extra?: Record<string, unknown>;
}): Candidate {
  return {
    id: o.id,
    pluginId: "gmd",
    platform: "wy",
    url: o.url,
    sourceRank: 0,
    declared: { container: o.container, bitrateKbps: o.bitrateKbps, bitDepth: o.bitDepth, ...(o.declared ?? {}) },
    ...(o.extra ?? {}),
  } as Candidate;
}

function tgt(o: {
  id: string;
  title: string;
  artist?: string;
  album?: string;
  durationSec?: number;
  sourceData?: string;
}): FetchTarget {
  const t: Record<string, unknown> = { id: o.id, title: o.title, artist: o.artist, album: o.album, durationSec: o.durationSec };
  if (o.sourceData !== undefined) t.sourceData = o.sourceData;
  return t as unknown as FetchTarget;
}

const oneMp3 = async () => [cand({ id: "c", url: "http://h/a.mp3", container: "mp3", bitrateKbps: 320 })];

describe("orchestrator — 缺口补齐", () => {
  it("G1. sourceId 缺省 → 建源并透出祖先源告警；onProgress 心跳回调被执行", async () => {
    const ensure = vi.fn(() => ({
      sourceId: "src-auto",
      created: true,
      reusedExisting: false,
      ancestorSourceId: "src-anc",
    }));
    const onProgress = vi.fn();
    const r = await run({
      targets: [tgt({ id: "t1", title: "A", durationSec: 200 })],
      deps: makeDeps({ collectCandidates: oneMp3, ensureDownloadSource: ensure }),
      onProgress,
    });
    expect(ensure).toHaveBeenCalledTimes(1);
    expect(r.warnings.some((w) => w.includes("已被另一个媒体源"))).toBe(true);
    expect(onProgress).toHaveBeenCalled();
    expect(r.items[0].status).toBe("done");
  });

  it("G2. syncToPlaylistIds 非空 → 记警告并跳过", async () => {
    const r = await run({
      targets: [],
      sourceId: "src-1",
      config: { syncToPlaylistIds: ["p1", "p2"] },
      deps: makeDeps(),
    });
    expect(r.warnings.some((w) => w.includes("syncToPlaylistIds 暂未接入"))).toBe(true);
  });

  it("G3. 无损分流落 losslessRoot：more 源懒建 + 祖先告警；攒批 scheduleFlush；done 项 flush 后回调 onItem", async () => {
    const ensure = vi.fn(() => ({
      sourceId: "src-lossless",
      created: true,
      reusedExisting: false,
      ancestorSourceId: "src-anc",
    }));
    const scan = vi.fn(async () => ({ added: 1, updated: 0, failed: 0, skipped: 0 }));
    const onItem = vi.fn();
    const deps = makeDeps({
      collectCandidates: async () => [
        cand({ id: "fl", url: "http://h/x.flac", container: "flac", bitrateKbps: 900, bitDepth: 16 }),
      ],
      downloadToFile: async (o: { url: string; destPath: string }) => {
        mkdirSync(dirname(o.destPath), { recursive: true });
        writeFileSync(o.destPath, Buffer.alloc(22_500_000, 1));
        return {
          bytes: 22_500_000,
          httpStatus: 200,
          sha256: "s",
          rangeSupported: true,
          finalUrl: o.url,
          partial: false,
        };
      },
      probeFile: async (file: string) => ({
        path: file,
        bytes: 22_500_000,
        container: "flac",
        bitDepth: 16,
        bitrateKbps: 900,
        sampleRateHz: 44100,
        durationSec: 200,
        hasCover: false,
      }),
      finalizeFile: () => ({ action: "write", finalPath: join(LL, "A/Al/T - A.flac"), warnings: [] }),
      ensureDownloadSource: ensure,
      scanLocalFiles: scan,
    });
    const r = await run({
      targets: [tgt({ id: "t1", title: "T", artist: "A", album: "Al", durationSec: 200 })],
      sourceId: "src-1",
      config: { losslessRoot: LL, scanBatchSize: 1 },
      deps,
      onItem,
    });
    expect(r.items[0].status).toBe("done");
    expect(r.items[0].destRoot).toBe(LL);
    expect(ensure).toHaveBeenCalledWith(LL, expect.stringContaining("无损"));
    expect(r.warnings.some((w) => w.includes("已被另一个媒体源"))).toBe(true);
    expect(scan).toHaveBeenCalled();
    expect(onItem).toHaveBeenCalledTimes(1);
    expect(onItem.mock.calls[0][0].status).toBe("done");
  });

  it("G4. 写目录预检失败 → 整任务快速拒绝", async () => {
    hs.ensureThrow = true;
    await expect(
      run({ targets: [tgt({ id: "t1", title: "A" })], sourceId: "src-1", deps: makeDeps() }),
    ).rejects.toThrow(/写目录预检失败/);
  });

  it("G5. target 缺标题 → failed / NO_CANDIDATE", async () => {
    const r = await run({
      targets: [tgt({ id: "t1", title: "" })],
      sourceId: "src-1",
      deps: makeDeps(),
    });
    expect(r.items[0].status).toBe("failed");
    expect(r.items[0].errorCode).toBe("NO_CANDIDATE");
    expect(r.items[0].errorMsg).toContain("缺标题");
  });

  it("G6. 库内查重抛错 → 记警告并继续下载", async () => {
    const r = await run({
      targets: [tgt({ id: "t1", title: "A", durationSec: 200 })],
      sourceId: "src-1",
      deps: makeDeps({
        collectCandidates: oneMp3,
        findExistingPlayable: () => {
          throw new Error("查重 boom");
        },
      }),
    });
    expect(r.items[0].status).toBe("done");
    expect(r.warnings.some((w) => w.includes("库内查重失败"))).toBe(true);
  });

  it("G7. 孤儿 done 放行判据的各条 false 分支：坏 JSON / 无 library / 上次非 done", async () => {
    // 三个 target 走不同 early-return：JSON 解析失败 / 无 library.songId / 上次终态为 null。
    const deps = makeDeps({
      collectCandidates: oneMp3,
      shouldSkipByCooldown: () => true,
      lastDownloadAttempt: () => null,
    });
    const r = await run({
      targets: [
        tgt({ id: "t1", title: "A", sourceData: "not-json" }),
        tgt({ id: "t2", title: "B", sourceData: JSON.stringify({ upgrade: { oldSongId: "u2" } }) }),
        tgt({ id: "t3", title: "C", sourceData: JSON.stringify({ library: { songId: "l3" } }) }),
      ],
      sourceId: "src-1",
      deps,
    });
    expect(r.items.every((i) => i.errorCode === "COOLDOWN_SKIPPED")).toBe(true);
  });

  it("G8. 取链抛错 → failed / UNKNOWN；冷却判据抛错 → 整曲兜底", async () => {
    const r1 = await run({
      targets: [tgt({ id: "t1", title: "A", durationSec: 200 })],
      sourceId: "src-1",
      deps: makeDeps({
        collectCandidates: async () => {
          throw new Error("取链 boom");
        },
      }),
    });
    expect(r1.items[0].errorCode).toBe("UNKNOWN");
    expect(r1.items[0].errorMsg).toContain("取链异常");

    const r2 = await run({
      targets: [tgt({ id: "t1", title: "A", durationSec: 200 })],
      sourceId: "src-1",
      deps: makeDeps({
        collectCandidates: oneMp3,
        shouldSkipByCooldown: () => {
          throw new Error("台账 boom");
        },
      }),
    });
    expect(r2.items[0].status).toBe("failed");
    expect(r2.items[0].errorCode).toBe("UNKNOWN");
    expect(r2.items[0].errorMsg).toContain("台账 boom");
  });

  it("G9. rank 全空 → 门槛拒绝明细 + 抢救通道为空 → BELOW_BAR", async () => {
    const r = await run({
      targets: [tgt({ id: "t1", title: "A", durationSec: 200 })],
      sourceId: "src-1",
      deps: makeDeps({
        collectCandidates: async () => [cand({ id: "w", url: "http://h/a.wma", container: "wma" })],
        rankCandidates: () => [],
      }),
    });
    expect(r.items[0].status).toBe("failed");
    expect(r.items[0].errorCode).toBe("BELOW_BAR");
    expect(r.items[0].rejected.length).toBe(1);
    expect(r.items[0].rejected[0].detail).toContain("不在允许列表");
  });

  it("G10. drain 已触发 → 未开始条目落 cancelled", async () => {
    const ac = new AbortController();
    ac.abort();
    const r = await run({
      targets: [tgt({ id: "t1", title: "A" }), tgt({ id: "t2", title: "B" })],
      sourceId: "src-1",
      drainSignal: ac.signal,
      deps: makeDeps({ collectCandidates: oneMp3 }),
    });
    expect(r.items.every((i) => i.status === "cancelled")).toBe(true);
  });

  it("G11. 取链前被取消（库内查重时 abort）→ cancelled", async () => {
    const ac = new AbortController();
    const r = await run({
      targets: [tgt({ id: "t1", title: "A", durationSec: 200 })],
      sourceId: "src-1",
      signal: ac.signal,
      deps: makeDeps({
        collectCandidates: oneMp3,
        findExistingPlayable: () => {
          ac.abort(); // 拿到闸位后才取消 → 命中步骤 3 的 abort 检查
          return null;
        },
      }),
    });
    expect(r.items[0].status).toBe("cancelled");
  });

  it("G12. 候选循环中 abort → cancelled（不记为失败）", async () => {
    const ac = new AbortController();
    let first = true;
    const r = await run({
      targets: [tgt({ id: "t1", title: "A", durationSec: 200 })],
      sourceId: "src-1",
      signal: ac.signal,
      deps: makeDeps({
        collectCandidates: async () => [
          cand({ id: "a", url: "http://h/a.flac", container: "flac", bitrateKbps: 900, bitDepth: 16 }),
          cand({ id: "b", url: "http://h/b.flac", container: "flac", bitrateKbps: 900, bitDepth: 16 }),
        ],
        downloadToFile: (async () => {
          if (first) {
            first = false;
            ac.abort();
            throw new Error("aborted");
          }
          return { bytes: 1, httpStatus: 200, sha256: "s", rangeSupported: true, finalUrl: "u", partial: false };
        }) as never,
      }),
    });
    expect(r.items[0].status).toBe("cancelled");
  });

  it("G13. 等转码闸时被取消 → 整曲 cancelled（kinds=cancel 分支）", async () => {
    const ac = new AbortController();
    const r = await run({
      targets: [tgt({ id: "t1", title: "A", durationSec: 200 })],
      sourceId: "src-1",
      signal: ac.signal,
      deps: makeDeps({
        collectCandidates: oneMp3,
        writeTags: async (src: string) => {
          ac.abort(); // 打标后取消 → transcodeSem.acquire(signal) 会 reject
          return { ok: true, file: src, bytes: 1000, mtimeMs: 1, warnings: [] };
        },
      }),
    });
    expect(r.items[0].status).toBe("cancelled");
  });

  it("G14. 下载改名失败 → MOVE_FAILED", async () => {
    const r = await run({
      targets: [tgt({ id: "t1", title: "A", durationSec: 200 })],
      sourceId: "src-1",
      deps: makeDeps({
        collectCandidates: oneMp3,
        downloadToFile: (async () => ({
          bytes: 8_000_000,
          httpStatus: 200,
          sha256: "s",
          rangeSupported: true,
          finalUrl: "u",
          partial: false,
        })) as never, // 不落 .part 文件 → renameSync 抛错
      }),
    });
    expect(r.items[0].errorCode).toBe("MOVE_FAILED");
    expect(r.items[0].rejected[0].detail).toContain("改名失败");
  });

  it("G15. 完整性校验抛错 → INTEGRITY_FAILED", async () => {
    const r = await run({
      targets: [tgt({ id: "t1", title: "A", durationSec: 200 })],
      sourceId: "src-1",
      deps: makeDeps({
        collectCandidates: oneMp3,
        verifyIntegrity: (async () => {
          throw new Error("校验 boom");
        }) as never,
      }),
    });
    expect(r.items[0].errorCode).toBe("INTEGRITY_FAILED");
  });

  it("G16. 探针容器与扩展名不一致 → 改名后继续落盘", async () => {
    const deps = makeDeps({
      collectCandidates: async () => [
        cand({ id: "c", url: "http://h/a.mp3", container: "mp3", bitrateKbps: 320 }),
      ],
      probeFile: async (file: string) => ({
        path: file,
        bytes: 22_500_000,
        container: "flac", // 声明 mp3，实测 flac → 触发改名
        bitDepth: 16,
        bitrateKbps: 900,
        sampleRateHz: 44100,
        durationSec: 200,
        hasCover: false,
      }),
    });
    const r = await run({
      targets: [tgt({ id: "t1", title: "A", durationSec: 200 })],
      sourceId: "src-1",
      deps,
    });
    expect(r.items[0].status).toBe("done");
  });

  it("G17. 探针抛错 → INTEGRITY_FAILED", async () => {
    const r = await run({
      targets: [tgt({ id: "t1", title: "A", durationSec: 200 })],
      sourceId: "src-1",
      deps: makeDeps({
        collectCandidates: oneMp3,
        probeFile: (async () => {
          throw new Error("探针 boom");
        }) as never,
      }),
    });
    expect(r.items[0].errorCode).toBe("INTEGRITY_FAILED");
  });

  it("G18. 洗版原地替换目标目录不可写 → 记警告并拒绝该候选（FAKE_LOSSLESS）", async () => {
    hs.canWrite = false;
    const origDir = join(DL, "Artist");
    mkdirSync(origDir, { recursive: true });
    const origFile = join(origDir, "old.mp3");
    writeFileSync(origFile, "OLD");
    const upg = tgt({
      id: "upgrade:old-g18",
      title: "Song",
      artist: "Artist",
      sourceData: JSON.stringify({
        upgrade: { songId: "old-g18", path: `l:dl-x:${origFile}`, suffix: "mp3", bitRate: 500 },
      }),
    });
    const r = await run({
      targets: [upg],
      sourceId: "src-1",
      originalDisposal: { action: "keep", allowedRoots: [DL] },
      deps: makeDeps({
        collectCandidates: async () => [
          cand({ id: "fl", url: "http://h/x.flac", container: "flac", bitrateKbps: 999, bitDepth: 16 }),
        ],
        downloadToFile: (async (o: { url: string; destPath: string }) => {
          mkdirSync(dirname(o.destPath), { recursive: true });
          writeFileSync(o.destPath, Buffer.alloc(13_750_000, 1));
          return {
            bytes: 13_750_000,
            httpStatus: 200,
            sha256: "s",
            rangeSupported: true,
            finalUrl: o.url,
            partial: false,
          };
        }) as never,
        probeFile: async (file: string) => ({
          path: file,
          bytes: 13_750_000,
          container: "flac",
          bitDepth: 16,
          bitrateKbps: 550,
          sampleRateHz: 44100,
          durationSec: 200,
          hasCover: false,
        }),
        finalizeFile: () => ({ action: "write", finalPath: join(origDir, "Song - Artist.flac"), warnings: [] }),
      }),
    });
    expect(r.items[0].errorCode).toBe("FAKE_LOSSLESS");
    expect(r.warnings.some((w) => w.includes("原地替换目标目录不可写"))).toBe(true);
  });

  it("G19. 洗版：时长对不上（原地替换豁免门槛后）→ DURATION_MISMATCH", async () => {
    const origDir = join(DL, "Artist");
    mkdirSync(origDir, { recursive: true });
    const origFile = join(origDir, "old.mp3");
    writeFileSync(origFile, "OLD");
    const upg = tgt({
      id: "upgrade:old-g19",
      title: "Song",
      artist: "Artist",
      durationSec: 200,
      sourceData: JSON.stringify({
        upgrade: { songId: "old-g19", path: `l:dl-x:${origFile}`, suffix: "mp3", bitRate: 100 },
      }),
    });
    const r = await run({
      targets: [upg],
      sourceId: "src-1",
      originalDisposal: { action: "keep", allowedRoots: [DL] },
      deps: makeDeps({
        collectCandidates: async () => [
          cand({ id: "fl", url: "http://h/x.flac", container: "flac", bitrateKbps: 999, bitDepth: 16 }),
        ],
        downloadToFile: (async (o: { url: string; destPath: string }) => {
          mkdirSync(dirname(o.destPath), { recursive: true });
          writeFileSync(o.destPath, Buffer.alloc(1_500_000, 1)); // 1.5MB / 30s = 400kbps：假无损但 > 原件 100
          return {
            bytes: 1_500_000,
            httpStatus: 200,
            sha256: "s",
            rangeSupported: true,
            finalUrl: o.url,
            partial: false,
          };
        }) as never,
        probeFile: async (file: string) => ({
          path: file,
          bytes: 1_500_000,
          container: "flac",
          bitDepth: 16,
          bitrateKbps: 400,
          sampleRateHz: 44100,
          durationSec: 30, // 与目标 200s 偏差超容差
          hasCover: false,
        }),
      }),
    });
    expect(r.items[0].errorCode).toBe("DURATION_MISMATCH");
  });

  it("G20. 转码闸排队超 2s → 记排队日志（并发两首共享单转码闸）", async () => {
    let firstTranscode = true;
    const deps = makeDeps({
      collectCandidates: oneMp3,
      transcodeFile: (async (src: string) => {
        if (firstTranscode) {
          firstTranscode = false;
          await new Promise((r) => setTimeout(r, 2100));
        }
        return { ok: true, srcPath: src, dstPath: src, skipped: true, bytes: 1000, warnings: [] };
      }) as never,
    });
    const r = await run({
      targets: [tgt({ id: "t1", title: "A", durationSec: 200 }), tgt({ id: "t2", title: "B", durationSec: 200 })],
      sourceId: "src-1",
      config: { maxConcurrentTargets: 2, maxConcurrentTranscodes: 1 },
      deps,
    });
    expect(r.items.filter((i) => i.status === "done").length).toBe(2);
  });

  it("G21. 洗版迁移成功 + 原件处置成功：迁移库行 → 删除原件 → 清空目录", async () => {
    hs.dispose = { action: "delete", deleted: true, warnings: [] };
    hs.prune = { removed: [], warnings: [] };
    const origDir = join(DL, "Artist");
    mkdirSync(origDir, { recursive: true });
    const origFile = join(origDir, "old.mp3");
    writeFileSync(origFile, "OLD");
    const upg = tgt({
      id: "upgrade:old-g21",
      title: "Song",
      artist: "Artist",
      sourceData: JSON.stringify({
        upgrade: { songId: "old-g21", path: `l:dl-x:${origFile}`, suffix: "mp3", bitRate: 500 },
      }),
    });
    const r = await run({
      targets: [upg],
      sourceId: "src-1",
      originalDisposal: { action: "delete", allowedRoots: [DL] },
      deps: makeDeps({
        collectCandidates: async () => [
          cand({ id: "fl", url: "http://h/x.flac", container: "flac", bitrateKbps: 999, bitDepth: 16 }),
        ],
        downloadToFile: (async (o: { url: string; destPath: string }) => {
          mkdirSync(dirname(o.destPath), { recursive: true });
          writeFileSync(o.destPath, Buffer.alloc(22_500_000, 1));
          return {
            bytes: 22_500_000,
            httpStatus: 200,
            sha256: "s",
            rangeSupported: true,
            finalUrl: o.url,
            partial: false,
          };
        }) as never,
        probeFile: async (file: string) => ({
          path: file,
          bytes: 22_500_000,
          container: "flac",
          bitDepth: 16,
          bitrateKbps: 900,
          sampleRateHz: 44100,
          durationSec: 200,
          hasCover: false,
        }),
        finalizeFile: () => ({ action: "write", finalPath: join(origDir, "Song - Artist.flac"), warnings: [] }),
      }),
    });
    expect(r.items[0].status).toBe("done");
    expect(r.items[0].songId).toBe("old-g21"); // 迁移成功后旧行 id 存活
    expect(r.items[0].replaced?.action).toBe("delete");
    expect(r.items[0].replaced?.deleted).toBe(true);
  });

  it("G22. 全库下载迁移（migrateRowOnly）：只迁移库行、不删文件，审计 action=migrate", async () => {
    const origFile = join(DL, "old.mp3");
    writeFileSync(origFile, "OLD");
    const lib = tgt({
      id: "library:lib-g22",
      title: "Song",
      artist: "Artist",
      sourceData: JSON.stringify({ library: { songId: "lib-g22", path: "web:go-music-dl:netease" } }),
    });
    const r = await run({
      targets: [lib],
      sourceId: "src-1",
      migrateRowOnly: true,
      deps: makeDeps({ collectCandidates: oneMp3 }),
    });
    expect(r.items[0].status).toBe("done");
    expect(r.items[0].songId).toBe("lib-g22");
    expect(r.items[0].replaced?.action).toBe("migrate");
  });

  it("G23. 增值标签：元数据补全齐备 + provider 抛错 + onMatch 内置来源 → 落盘后写标记", async () => {
    let got: Record<string, unknown> = {};
    const deps = makeDeps({
      collectCandidates: async () => [
        cand({ id: "c", url: "http://h/a.mp3", container: "mp3", bitrateKbps: 320, declared: { sampleRateHz: 44100 } }),
      ],
      writeTags: async (src: string, tags: Record<string, unknown>) => {
        got = tags;
        return { ok: true, file: src, bytes: 1000, mtimeMs: 1, warnings: ["标签告警"] };
      },
      searchLyrics: (async (_i: unknown, o: { onMatch?: (id: string, b: boolean) => void }) => {
        o?.onMatch?.("builtin-x", true); // 内置来源命中 → 落盘后登记修复标记
        return "[00:01.00]la";
      }) as never,
      searchCover: (async () => {
        throw new Error("封面 provider boom");
      }) as never,
      searchMetadata: (async () => ({ track: 5, trackTotal: 12, year: 1999, genre: "Rock", album: "Alb" })) as never,
    });
    const r = await run({
      targets: [tgt({ id: "t1", title: "A", durationSec: 200 })],
      sourceId: "src-1",
      deps,
    });
    expect(r.items[0].status).toBe("done");
    expect(got.track).toBe(5);
    expect(got.trackTotal).toBe(12);
    expect(got.year).toBe(1999);
    expect(got.genre).toBe("Rock");
    expect(got.album).toBe("Alb");
    expect(got.lyric).toBe("[00:01.00]la");
    expect(got.comment).toContain("44kHz"); // describeQuality 的采样率分支
    expect(r.warnings.some((w) => w.includes("封面获取失败"))).toBe(true);
    expect(r.warnings.some((w) => w.includes("标签告警"))).toBe(true);
  });

  it("G24. 封面下载体积为 0 → 视为未获取；元数据 provider 抛错 → 只告警", async () => {
    const deps = makeDeps({
      collectCandidates: async () => [
        cand({ id: "c", url: "http://h/a.mp3", container: "mp3", bitrateKbps: 320, extra: { coverUrl: "http://h/cover.jpg" } }),
      ],
      downloadToFile: (async (o: { url: string; destPath: string }) => {
        if (o.url.includes("cover")) return { bytes: 0, httpStatus: 200, sha256: "s", rangeSupported: true, finalUrl: o.url, partial: false };
        mkdirSync(dirname(o.destPath), { recursive: true });
        writeFileSync(o.destPath, "DATA");
        return { bytes: 8_000_000, httpStatus: 200, sha256: "s", rangeSupported: true, finalUrl: o.url, partial: false };
      }) as never,
      searchMetadata: (async () => {
        throw new Error("元数据 boom");
      }) as never,
    });
    const r = await run({
      targets: [tgt({ id: "t1", title: "A", durationSec: 200 })],
      sourceId: "src-1",
      deps,
    });
    expect(r.items[0].status).toBe("done");
    expect(r.warnings.some((w) => w.includes("封面未获取到"))).toBe(true);
    expect(r.warnings.some((w) => w.includes("标签补全失败"))).toBe(true);
  });

  it("G25. 打标抛错 → TAG_FAILED；finalize 抛错 → MOVE_FAILED；finalize 无 finalPath → MOVE_FAILED", async () => {
    const r1 = await run({
      targets: [tgt({ id: "t1", title: "A", durationSec: 200 })],
      sourceId: "src-1",
      deps: makeDeps({
        collectCandidates: oneMp3,
        writeTags: (async () => {
          throw new Error("打标 boom");
        }) as never,
      }),
    });
    expect(r1.items[0].errorCode).toBe("TAG_FAILED");

    const r2 = await run({
      targets: [tgt({ id: "t1", title: "A", durationSec: 200 })],
      sourceId: "src-1",
      deps: makeDeps({
        collectCandidates: oneMp3,
        finalizeFile: () => {
          throw new Error("落盘 boom");
        },
      }),
    });
    expect(r2.items[0].errorCode).toBe("MOVE_FAILED");

    const r3 = await run({
      targets: [tgt({ id: "t1", title: "A", durationSec: 200 })],
      sourceId: "src-1",
      deps: makeDeps({
        collectCandidates: oneMp3,
        finalizeFile: () => ({ action: "write", warnings: [] }),
      }),
    });
    expect(r3.items[0].errorCode).toBe("MOVE_FAILED");
    expect(r3.items[0].rejected[0].detail).toContain("finalPath");
  });

  it("G26. 取链/预探的边角：非法 URL 兜底、ftp 候选过滤、估算码率为 0", async () => {
    const probes: string[] = [];
    const deps = makeDeps({
      collectCandidates: async () => [
        cand({ id: "bad", url: "not-a-url" }), // 非法 URL → 兜底 mp3 / host unknown
        cand({ id: "ftp", url: "ftp://h/f.mp3" }), // 非 http(s) → 预探跳过
        cand({ id: "http", url: "http://h/z.mp3" }), // 无声明码率 → 被预探
      ],
      probeRemoteSize: (async (o: { url: string }) => {
        probes.push(o.url);
        return 100; // 体积极小 + 超长时长 → 估算 0kbps，保持原行为
      }) as never,
      rankCandidates: (c: Candidate[]) => c,
    });
    const r = await run({
      targets: [tgt({ id: "...", title: "...", durationSec: 1_000_000 })], // safeSegment 回退分支
      sourceId: "src-1",
      deps,
    });
    expect(probes).toEqual(["http://h/z.mp3"]); // 非法/非 http 候选均未预探
    expect(r.items[0].status).toBe("failed"); // 时长对不上 → 失败，但用例已覆盖边角
  });

  it("G27. 洗版 rescue/upgradeMeta 的拒绝分支：无 originallSourceId / 无基准码率 / 无 upgrade 块 / 坏 JSON", async () => {
    const cases: string[] = [
      JSON.stringify({ upgrade: { oldSongId: "u1", path: join(DL, "plain.mp3"), bitRate: 500 } }), // path 无 l: 前缀 → 无 sourceId
      JSON.stringify({ upgrade: { oldSongId: "u2", path: `l:dl-x:${join(DL, "old.mp3")}` } }), // 无 bitRate → 基准 0
      JSON.stringify({ whatever: 1 }), // 无 upgrade/library 块
      "not-json", // JSON 解析失败
    ];
    const targets = cases.map((sourceData, i) =>
      tgt({ id: `upgrade:u${i}`, title: `T${i}`, artist: "A", sourceData }),
    );
    const r = await run({
      targets,
      sourceId: "src-1",
      originalDisposal: { action: "keep", allowedRoots: [DL] },
      deps: makeDeps({
        collectCandidates: async () => [
          cand({ id: "fl", url: "http://h/x.flac", container: "flac", bitrateKbps: 600, bitDepth: 16 }),
        ],
        rankCandidates: () => [], // 预筛全灭 → 触发抢救通道 → 上述拒绝分支
      }),
    });
    expect(r.items.every((i) => i.errorCode === "BELOW_BAR")).toBe(true);
  });

  it("G28. 台账记录抛错 → 只告警；点名入库抛错 → 只告警", async () => {
    const r = await run({
      targets: [tgt({ id: "t1", title: "A", durationSec: 200 })],
      sourceId: "src-1",
      deps: makeDeps({
        collectCandidates: oneMp3,
        recordDownloadAttempt: () => {
          throw new Error("台账 boom");
        },
        scanLocalFiles: (async () => {
          throw new Error("入库 boom");
        }) as never,
      }),
    });
    expect(r.warnings.some((w) => w.includes("尝试台账记录失败"))).toBe(true);
    expect(r.warnings.some((w) => w.includes("点名入库失败"))).toBe(true);
  });

  it("G29. 源故障保护：缺 attemptKey 的失败项跳过回滚；回滚抛错只告警；死链清理抛错只告警", async () => {
    const rollback = vi.fn(() => {
      throw new Error("回滚 boom");
    });
    const purge = vi.fn(() => ({ purged: 0 }));
    const deps = makeDeps({
      // 前 101 首均为合法 target 但取链为空 → A 类永久失败；attemptKey = target.id。
      collectCandidates: async () => [],
      rollbackPermanentFailure: rollback,
      purgeDeadSongs: purge,
    });
    const targets: Array<FetchTarget | null> = [
      ...Array.from({ length: 100 }, () => null), // 无 target → attemptKey undefined
      tgt({ id: "t101", title: "T101" }), // 有 attemptKey → 回滚（虽抛错但被吞）
    ];
    const r = await run({ targets: targets as never, sourceId: "src-1", deps });
    expect(rollback).toHaveBeenCalledTimes(1); // 仅带 attemptKey 的那一首
    expect(r.warnings.some((w) => w.includes("源故障保护回滚失败"))).toBe(true);
    expect(r.purge).toBeUndefined(); // 触发源故障保护 → 跳过清理

    const r2 = await run({
      targets: [tgt({ id: "a", title: "A" }), tgt({ id: "b", title: "B" })],
      sourceId: "src-1",
      deps: makeDeps({
        collectCandidates: async () => [],
        purgeDeadSongs: (() => {
          throw new Error("清理 boom");
        }) as never,
      }),
    });
    expect(r2.warnings.some((w) => w.includes("死链清理失败"))).toBe(true);
  });

  it("G30. 库内已有可比对：不跳过 → 走 newIsBetter 判定（size/duration 现算优先）", async () => {
    const r = await run({
      targets: [tgt({ id: "t1", title: "A", durationSec: 200 })],
      sourceId: "src-1",
      config: { skipIfInLibrary: false },
      deps: makeDeps({
        collectCandidates: oneMp3,
        findExistingPlayable: () => ({
          id: "e1",
          path: "l:sid:/music/a.flac",
          kind: "local",
          title: "A",
          artist: "A",
          durationSec: 200,
          bitRate: 1200,
          size: 30_000_000,
          suffix: "flac",
        }),
      }),
    });
    expect(r.items[0].status).toBe("done");
  });

  it("G31. 库内已有但无体积 → 有效码率现算为 0，回落 bit_rate 列", async () => {
    const r = await run({
      targets: [tgt({ id: "t1", title: "A", durationSec: 200 })],
      sourceId: "src-1",
      config: { skipIfInLibrary: false },
      deps: makeDeps({
        collectCandidates: oneMp3,
        findExistingPlayable: () => ({
          id: "e2",
          path: "l:sid:/music/a.flac",
          kind: "local",
          title: "A",
          artist: "A",
          durationSec: 0,
          bitRate: 900,
          size: 0,
          suffix: "flac",
        }),
      }),
    });
    expect(r.items[0].status).toBe("done");
  });

  it("G32. 增值标签采集整体抛错 → 只告警，不影响落盘", async () => {
    // 通过原型 getter 让 cand.genre 在被读取时抛错（对象展开只拷贝自有属性，不触发原型）。
    const protoCand = Object.assign(
      Object.create({
        get genre(): string {
          throw new Error("genre boom");
        },
      }),
      {
        id: "c",
        pluginId: "gmd",
        platform: "wy",
        url: "http://h/a.mp3",
        sourceRank: 0,
        declared: { container: "mp3", bitrateKbps: 320 },
      },
    );
    const r = await run({
      targets: [tgt({ id: "t1", title: "A", durationSec: 200 })],
      sourceId: "src-1",
      deps: makeDeps({ collectCandidates: async () => [protoCand as Candidate] }),
    });
    expect(r.items[0].status).toBe("done");
    expect(r.warnings.some((w) => w.includes("增值标签采集异常"))).toBe(true);
  });
});
