// 排空式取消（drain）通道测试。
//
// 背景：手动点「取消」旧行为是硬 abort，会把在途下载弃掉、把已下载到缓存待转码的歌在
// `transcodeSem.acquire(signal)` 排队时抛 AbortError —— 缓存文件永远不再转码/落地。
// 新通道 drain 与硬 abort **完全并行**：不再开始新工作，但把已开始/已缓存的工作走完。
//
// 覆盖三组：
//   A. drain 语义：已准入的 target 全部走完到 done；未准入的 target 落 cancelled；
//      在途转码不被中断。
//   B. 硬 abort 语义（回归守卫）：在途项被中断、未开始项 cancelled，既有行为未被改坏。
//   C. jobRunner 排空收尾：drain 后任务终态 cancelled，且 targets 里未处理的项在 items
//      中出现并标 cancelled（UI 重试能挑出恢复）。
//
// A/B 全程用 orchestrator 的 deps 注入伪造（零真实网络 / 零真实 ffmpeg）。
// C 用假子进程注入 runner（不真实 fork），库行走真实 sqlite（tests/setup.ts 已按文件隔离）。
import "../plugins/_env.js";

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import {
  runFetchPipeline,
  type FetchDeps,
  type FetchPipelineResult,
  type RunFetchPipelineOptions,
} from "../../src/services/fetch/orchestrator.js";
import type { Candidate } from "../../src/services/fetch/types.js";
import type { FetchConfig } from "../../src/services/fetch/config.js";
import type { FetchTarget } from "../../src/services/fetch/candidates.js";
import { _setForkImplForTest } from "../../src/batch/runner.js";
import { startFetchJob, drainFetchJob, abortFetchJob } from "../../src/services/fetch/jobRunner.js";
import {
  createFetchJob,
  getFetchJob,
  updateFetchJobStatus,
  _resetFetchJobsForTest,
} from "../../src/services/fetch/jobStore.js";
import { saveFetchConfigOverride } from "../../src/services/fetch/configStore.js";
import { setSetting, _resetSettingsCacheForTest } from "../../src/services/settings.js";
import { FETCH_CONFIG_KEY } from "../../src/services/fetch/configStore.js";
import { _resetPacerForTest } from "../../src/services/plugin/batchPacer.js";

let DL = "";
let CA = "";

beforeEach(() => {
  DL = mkdtempSync(join(tmpdir(), "mf-drain-dl-"));
  CA = mkdtempSync(join(tmpdir(), "mf-drain-ca-"));
});

afterEach(() => {
  rmSync(DL, { recursive: true, force: true });
  rmSync(CA, { recursive: true, force: true });
});

// ==================== 伪造 deps ====================

type AnyDeps = { [K in keyof FetchDeps]?: any };

const emptyPurge = {
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
  details: [] as unknown[],
};

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

function makeDeps(over: AnyDeps = {}): FetchDeps {
  const base: FetchDeps = {
    collectCandidates: (async () => []) as any,
    downloadToFile: defaultDownload as any,
    probeRemoteSize: (async () => null) as any,
    verifyIntegrity: (async () => ({ ok: true, level: "probe", detail: { bytes: 1000 }, warnings: [] })) as any,
    probeFile: (async (file: string) => ({
      path: file,
      bytes: 8_000_000,
      container: "mp3",
      bitrateKbps: 320,
      sampleRateHz: 44100,
      durationSec: 200,
      hasCover: false,
    })) as any,
    writeTags: (async (src: string) => ({ ok: true, file: src, bytes: 1000, mtimeMs: Date.now(), warnings: [] })) as any,
    transcodeFile: (async (src: string) => ({
      ok: true,
      srcPath: src,
      dstPath: src.replace(/\.mp3$/, ".flac"),
      skipped: false,
      bytes: 1000,
      warnings: [],
    })) as any,
    finalizeFile: ((o: any) => ({
      action: "write",
      finalPath: join(DL, `${o?.target?.title ?? "out"}.flac`),
      warnings: [],
    })) as any,
    findExistingPlayable: (() => null) as any,
    scanLocalFiles: (async () => ({ added: 1, updated: 0, failed: 0, skipped: 0 })) as any,
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
    purgeDeadSongs: (() => ({ ...emptyPurge })) as any,
    rollbackPermanentFailure: (() => undefined) as any,
  };
  return { ...base, ...over } as FetchDeps;
}

function cand(id: string): Candidate {
  return {
    id,
    pluginId: "gmd",
    platform: "wy",
    url: `http://h/${id}.mp3`,
    sourceRank: 0,
    declared: { container: "mp3", bitrateKbps: 320 },
  };
}

function tgt(id: string, title: string): FetchTarget {
  return { id, title, artist: "A", album: "", durationSec: 200 };
}

const oneCand = async () => [cand("c0")];
const twoCand = async () => [cand("c0"), cand("c1")];

function run(
  over: Omit<Partial<RunFetchPipelineOptions>, "config"> & { config?: Partial<FetchConfig> },
): Promise<FetchPipelineResult> {
  return runFetchPipeline({
    ...over,
    config: {
      downloadRoot: DL,
      cacheRoot: CA,
      transcodeEnabled: true,
      transcodeTarget: "flac",
      transcodeLoudnessNormalize: false,
      maxConcurrentTargets: 1,
      maxConcurrentTranscodes: 1,
      maxConcurrentDownloads: 4,
      perHostMinIntervalMs: 0,
      ...(over.config ?? {}),
    } as any,
  });
}

// ==================== A. drain 语义 ====================

describe("drain 排空式取消（orchestrator）", () => {
  it("A. drain 后：已准入项走完到 done（含转码），未准入项 cancelled", async () => {
    const drainAc = new AbortController();
    const trCalls: string[] = [];
    const collect = async () => [cand("c0")];
    const transcode = async (src: string) => {
      trCalls.push(src);
      // 第一个 target 进入转码时触发 drain：此后不得再开始新 target。
      if (trCalls.length === 1) drainAc.abort();
      await new Promise((r) => setTimeout(r, 20));
      return { ok: true, srcPath: src, dstPath: src.replace(/\.mp3$/, ".flac"), skipped: false, bytes: 1000, warnings: [] };
    };
    const deps = makeDeps({ collectCandidates: collect, transcodeFile: transcode });

    const r = await run({
      targets: [tgt("t0", "S0"), tgt("t1", "S1"), tgt("t2", "S2")],
      sourceId: "src-1",
      deps,
      drainSignal: drainAc.signal,
    });

    expect(r.items).toHaveLength(3);
    // 已准入项（t0）转码未被中断、走完到 done 且拿到 finalPath。
    expect(r.items[0].status).toBe("done");
    expect(r.items[0].finalPath).toBeTruthy();
    expect(trCalls).toHaveLength(1);
    // 未准入项（t1/t2）落 cancelled，且从未开始（没有转码/下载）。
    expect(r.items[1].status).toBe("cancelled");
    expect(r.items[2].status).toBe("cancelled");
    expect(r.items[1].errorMsg).toContain("取消");
  });

  it("A2. drain 在入队前即触发：全部未开始 → 全部 cancelled（不启动任何下载）", async () => {
    const drainAc = new AbortController();
    drainAc.abort();
    const dl = async (o: { url: string; destPath: string }) => defaultDownload(o);
    const deps = makeDeps({ collectCandidates: oneCand, downloadToFile: dl as any });
    const r = await run({
      targets: [tgt("t0", "S0"), tgt("t1", "S1")],
      sourceId: "src-1",
      deps,
      drainSignal: drainAc.signal,
    });
    expect(r.items.every((i) => i.status === "cancelled")).toBe(true);
  });
});

// ==================== B. 硬 abort 语义（回归守卫） ====================

describe("硬 abort（orchestrator，回归守卫）", () => {
  it("B. 硬 abort 后在途项被中断、未开始项 cancelled（既有行为未被改坏）", async () => {
    const hardAc = new AbortController();
    let collectCalls = 0;
    let dlCalls = 0;
    let abortedOnce = false;
    const collect = async () => {
      collectCalls++;
      return [cand("c0"), cand("c1")];
    };
    const dl = async (o: { url: string; destPath: string }) => {
      dlCalls++;
      if (!abortedOnce) {
        abortedOnce = true;
        hardAc.abort(); // 在途下载时触发硬 abort
        throw new Error("aborted mid-download");
      }
      return defaultDownload(o);
    };
    const tr = async (src: string) => ({
      ok: true,
      srcPath: src,
      dstPath: src.replace(/\.mp3$/, ".flac"),
      skipped: false,
      bytes: 1000,
      warnings: [],
    });
    const deps = makeDeps({ collectCandidates: collect, downloadToFile: dl as any, transcodeFile: tr });

    const r = await run({
      targets: [tgt("t0", "S0"), tgt("t1", "S1"), tgt("t2", "S2")],
      sourceId: "src-1",
      deps,
      signal: hardAc.signal,
    });

    expect(r.items).toHaveLength(3);
    // 在途项被中断（曾开始下载 → collect/下载被调用过），终态 cancelled。
    expect(collectCalls).toBe(1);
    expect(dlCalls).toBe(1);
    expect(r.items[0].status).toBe("cancelled");
    // 未开始项 cancelled。
    expect(r.items[1].status).toBe("cancelled");
    expect(r.items[2].status).toBe("cancelled");
    // 硬 abort 不得让在途项继续走转码。
    expect(r.items[0].finalPath).toBeFalsy();
  });
});

// ==================== C. jobRunner 排空收尾 ====================

type FakeScript = (msg: any, fake: FakeChild) => void;

class FakeChild extends EventEmitter {
  connected = true;
  killed = false;
  pid = 4321;
  sent: any[] = [];
  private script: FakeScript;

  constructor(script: FakeScript) {
    super();
    this.script = script;
  }

  send(msg: any): boolean {
    this.sent.push(msg);
    this.script(msg, this);
    return true;
  }

  kill(): boolean {
    this.killed = true;
    return true;
  }
}

function tick(ms = 5): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

describe("drain 排空收尾（jobRunner）", () => {
  beforeEach(() => {
    _resetFetchJobsForTest();
    _resetPacerForTest();
    _resetSettingsCacheForTest();
  });
  afterEach(() => {
    _setForkImplForTest(null as any);
    _resetFetchJobsForTest();
    _resetPacerForTest();
    setSetting(FETCH_CONFIG_KEY, "");
    _resetSettingsCacheForTest();
  });

  it("C. drain 后任务终态 cancelled，未处理 targets 补写为 cancelled 条目", async () => {
    // 写目录预检读生效配置（settings 覆盖），指向临时目录，避免触达默认 /MUSIC。
    saveFetchConfigOverride({ downloadRoot: DL, cacheRoot: CA } as any);

    const job = createFetchJob({
      kind: "manual",
      targets: { targets: [tgt("t0", "S0"), tgt("t1", "S1"), tgt("t2", "S2")] },
      config: { chunkSize: 3 },
    });

    // 假子进程：收到 run 后待命；收到 drain（排空）后按语义返回本片结果（此片 hasMore 仍为
    // true —— 模拟多片任务中途排空，故 jobRunner 必须自己补终态）。
    const fake = new FakeChild((msg, f) => {
      if (msg.type === "drain") {
        setTimeout(() => {
          f.emit("message", { type: "result", jobId: msg.jobId, result: { hasMore: true, counts: {} }, rss: 1 });
        }, 0);
      }
    });
    _setForkImplForTest((() => fake) as any);
    setImmediate(() => fake.emit("message", { type: "ready", pid: fake.pid }));

    startFetchJob(job.id);
    // 等批量子进程收到 run（说明控制器已注册、drain 监听已挂好）。
    for (let i = 0; i < 400 && !fake.sent.some((m) => m.type === "run"); i++) await tick();
    expect(fake.sent.some((m) => m.type === "run")).toBe(true);

    // 排空式取消：只 abort drain。
    expect(drainFetchJob(job.id)).toBe(true);
    // 子进程应收到 drain 消息（而非 abort）。
    expect(fake.sent.some((m) => m.type === "drain")).toBe(true);
    expect(fake.sent.some((m) => m.type === "abort")).toBe(false);

    // 等排空收尾落库。
    let status = "";
    for (let i = 0; i < 400; i++) {
      const j = getFetchJob(job.id);
      status = j?.status ?? "";
      if (["done", "partial", "failed", "cancelled"].includes(status)) break;
      await tick();
    }

    expect(status).toBe("cancelled");
    const done = getFetchJob(job.id)!;
    expect(done.error).toContain("排空收尾");
    // 未处理的 3 个 target 全部补写为 cancelled 条目（任务记录完整，UI 可重试恢复）。
    expect(done.items).toHaveLength(3);
    expect(done.items.map((i) => i.targetId).sort()).toEqual(["t0", "t1", "t2"]);
    expect(done.items.every((i) => i.status === "cancelled")).toBe(true);
    expect(done.items.every((i) => i.errorMsg?.includes("未开始"))).toBe(true);

    // 任务已结束，控制器被移除：再次 drain/abort 均返回 false。
    expect(drainFetchJob(job.id)).toBe(false);
    expect(abortFetchJob(job.id)).toBe(false);
  });

  it("D. 最后一片已真正跑完（done）后触发 drain：终态仍为 done，不被降级为 cancelled", async () => {
    saveFetchConfigOverride({ downloadRoot: DL, cacheRoot: CA } as any);

    const job = createFetchJob({
      kind: "manual",
      targets: { targets: [tgt("t0", "S0"), tgt("t1", "S1"), tgt("t2", "S2")] },
      config: { chunkSize: 3 },
    });

    // 假子进程：收到 run 后延迟一小段再「真正跑完」——先按末片语义落 done 终态，
    // 再返回 hasMore:false。这个延迟窗口正是我们要构造的竞态区间：子进程已算完，
    // 但主循环尚未恢复。
    const fake = new FakeChild((msg, f) => {
      if (msg.type === "run") {
        // 注意：IPC 消息的 jobId 是 runner 生成的批 id，真实 fetch 任务 id 在 args.jobId。
        const realJobId = msg.args?.jobId as string;
        setTimeout(() => {
          updateFetchJobStatus(realJobId, "done");
          f.emit("message", { type: "result", jobId: msg.jobId, result: { hasMore: false, counts: { added: 0 } }, rss: 1 });
        }, 20);
      }
    });
    _setForkImplForTest((() => fake) as any);
    setImmediate(() => fake.emit("message", { type: "ready", pid: fake.pid }));

    startFetchJob(job.id);
    for (let i = 0; i < 400 && !fake.sent.some((m) => m.type === "run"); i++) await tick();
    expect(fake.sent.some((m) => m.type === "run")).toBe(true);

    // 在「子进程已落 done、主循环尚未恢复」的窗口内点取消 → 只 abort drain。
    expect(drainFetchJob(job.id)).toBe(true);

    // 等子进程真正跑完 + 主循环收尾（收尾的可观测副作用=未开始条目的补写，故以此为信号）。
    for (let i = 0; i < 400; i++) {
      const j = getFetchJob(job.id);
      if (j && j.status === "done" && j.items.length === 3) break;
      await tick();
    }
    const fin = getFetchJob(job.id)!;
    // 关键断言：取消**不得**把已完成的作业降级为 cancelled。
    expect(fin.status).toBe("done");
    expect(fin.error ?? "").not.toContain("排空收尾");
    // 未开始条目补写照旧（与终态守卫无关）：任务记录依旧完整、可重试。
    expect(fin.items.map((i) => i.targetId).sort()).toEqual(["t0", "t1", "t2"]);
    expect(fin.items.every((i) => i.status === "cancelled")).toBe(true);
  });
});
