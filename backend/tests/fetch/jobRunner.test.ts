// jobRunner 后台分片跑批单元测试：全程 vi.mock 打桩，零真实 fork / 零真实网络 / 零真实 ffmpeg。
//
// 覆盖重点（drain-cancel.test.ts 已覆盖的取消语义不重复）：
//   - startFetchJob 重入守卫、写目录预检失败快速失败、逐片续批循环；
//   - 排空(drain)/完全停止(hard abort)两套收尾语义（补写未开始条目、终态守卫）；
//   - 全库下载自动续批 maybeContinueLibraryJob 的各分支（进度闸 / 开关 / 让渡 / 会话标记）；
//   - 洗版自动续批 maybeContinueUpgradeJob 的各分支（零尝试闸 / 开关 / 让渡 / 会话标记）；
//   - 终态自动增量扫描 autoScanAfterJob 的守卫、标签修复入队与扫描转发；
//   - boot 恢复 resumeInterruptedFetchJobs 的跳过在跑任务与恢复计数。
//
// 说明：jobRunner 直接 import db/index.js 的 sqlite 做 hasAnyActiveJob 计数；本文件保留真实
// sqlite（tests/setup.ts 已按文件隔离建表），仅按需 spyOn prepare 控制「是否有活动任务」。

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ==================== 模块打桩（必须在被测模块 import 之前声明，vi.mock 会被提升） ====================

vi.mock("../../src/batch/runner.js", () => ({
  runBatchJob: vi.fn(),
}));
vi.mock("../../src/services/plugin/batchPacer.js", () => ({
  sleepBetweenBatch: vi.fn(async () => {}),
  ensureBaseBatchLimit: vi.fn(),
}));
vi.mock("../../src/services/fetch/configStore.js", () => ({
  currentFetchConfig: vi.fn(),
}));
vi.mock("../../src/services/fetch/writable.js", () => ({
  ensureWritableDir: vi.fn(),
}));
vi.mock("../../src/services/fetch/library.js", () => ({
  buildLibraryContinuation: vi.fn(),
  libraryBatchProgressed: vi.fn(),
}));
vi.mock("../../src/services/fetch/upgrade.js", () => ({
  buildUpgradeContinuation: vi.fn(),
}));
vi.mock("../../src/services/fetch/autoSession.js", () => ({
  setAutoSession: vi.fn(),
}));
vi.mock("../../src/services/fetch/tagRepair.js", () => ({
  enqueueTagRepairs: vi.fn(),
}));
vi.mock("../../src/services/fetch/jobStore.js", () => ({
  getFetchJob: vi.fn(),
  updateFetchJobStatus: vi.fn(),
  saveFetchJobItems: vi.fn(),
  collectInterruptedFetchJobIds: vi.fn(),
}));

import { runBatchJob } from "../../src/batch/runner.js";
import { sleepBetweenBatch, ensureBaseBatchLimit } from "../../src/services/plugin/batchPacer.js";
import { currentFetchConfig } from "../../src/services/fetch/configStore.js";
import { ensureWritableDir } from "../../src/services/fetch/writable.js";
import {
  buildLibraryContinuation,
  libraryBatchProgressed,
} from "../../src/services/fetch/library.js";
import { buildUpgradeContinuation } from "../../src/services/fetch/upgrade.js";
import { setAutoSession } from "../../src/services/fetch/autoSession.js";
import { enqueueTagRepairs } from "../../src/services/fetch/tagRepair.js";
import {
  getFetchJob,
  updateFetchJobStatus,
  saveFetchJobItems,
  collectInterruptedFetchJobIds,
} from "../../src/services/fetch/jobStore.js";
import {
  startFetchJob,
  abortFetchJob,
  drainFetchJob,
  resumeInterruptedFetchJobs,
  BOOT_RESUME_DELAY_MS,
} from "../../src/services/fetch/jobRunner.js";
import { sqlite } from "../../src/db/index.js";

// ==================== 公用工具 ====================

/** 让后台 fire-and-forget 的异步循环跑完（纯微任务 + 若干宏任务轮次）。 */
async function flushAll(rounds = 12): Promise<void> {
  for (let i = 0; i < rounds; i++) {
    await new Promise((r) => setImmediate(r));
  }
}

const CFG = {
  downloadRoot: "/tmp/mf-jobrunner-dl",
  cacheRoot: "/tmp/mf-jobrunner-ca",
  maxConcurrentJobs: 2,
  libraryAutoContinue: true,
  upgradeAutoContinue: true,
};

/** 构造一条任务记录（字段与 jobStore.FetchJobRecord 对齐，按需覆盖）。 */
function jobRec(over: Record<string, any> = {}): any {
  return {
    id: "j0",
    kind: "manual",
    status: "done",
    sourceId: null,
    targets: { targets: [] },
    items: [],
    imports: [],
    config: {},
    counts: { total: 0, done: 0, failed: 0, skipped: 0, added: 0, updated: 0, bytes: 0 },
    error: null,
    createdAt: "",
    startedAt: null,
    finishedAt: null,
    updatedAt: "",
    ...over,
  };
}

function item(targetId: string, status = "done"): any {
  return { id: targetId, targetId, status, attempts: 1, rejected: [] };
}

// getFetchJob 由「以 id 查询的内存表」驱动，便于一测多任务。
let jobs: Map<string, any>;
let prepareSpy: any;

beforeEach(() => {
  vi.resetAllMocks();
  jobs = new Map();
  vi.mocked(currentFetchConfig).mockReturnValue({ ...CFG } as any);
  vi.mocked(ensureWritableDir).mockImplementation(() => {});
  vi.mocked(runBatchJob).mockResolvedValue({ result: { hasMore: false, counts: {} }, childRss: 1 } as any);
  vi.mocked(sleepBetweenBatch).mockResolvedValue();
  vi.mocked(libraryBatchProgressed).mockReturnValue(true);
  vi.mocked(buildLibraryContinuation).mockReturnValue({ job: null, enqueued: 0, remaining: 0 } as any);
  vi.mocked(buildUpgradeContinuation).mockReturnValue({ job: null, enqueued: 0, remaining: 0 } as any);
  vi.mocked(collectInterruptedFetchJobIds).mockReturnValue([]);
  vi.mocked(getFetchJob).mockImplementation((id: any) => jobs.get(id) ?? null);
  // 默认「当前无活动任务」。
  prepareSpy = vi.spyOn(sqlite, "prepare").mockReturnValue({ get: () => ({ n: 0 }) } as any);
});

afterEach(() => {
  prepareSpy?.mockRestore();
});

// ==================== startFetchJob：守卫与预检 ====================

describe("startFetchJob 守卫与预检", () => {
  it("重入守卫：同一 jobId 已在跑时不重复启动循环", async () => {
    let release: (v: any) => void = () => {};
    vi.mocked(runBatchJob).mockReturnValue(new Promise((r) => { release = r; }) as any);
    jobs.set("re1", jobRec({ id: "re1", status: "running" }));

    startFetchJob("re1");
    startFetchJob("re1"); // 第二次应被守卫挡下
    await flushAll(3);
    expect(runBatchJob).toHaveBeenCalledTimes(1);

    release({ result: { hasMore: false, counts: {} }, childRss: 1 });
    await flushAll(6);
    expect(abortFetchJob("re1")).toBe(false); // 循环结束后控制器已清理
  });

  it("预检失败：currentFetchConfig 抛错 → 任务快速失败，不进循环", async () => {
    vi.mocked(currentFetchConfig).mockImplementation(() => {
      throw new Error("config boom");
    });
    startFetchJob("pf-cfg");
    await flushAll(3);
    expect(runBatchJob).not.toHaveBeenCalled();
    expect(updateFetchJobStatus).toHaveBeenCalledWith("pf-cfg", "failed", { error: "config boom" });
    expect(abortFetchJob("pf-cfg")).toBe(false);
  });

  it("预检失败：写目录不可写 → 快速失败，且已按配置设置批量并发下限", async () => {
    vi.mocked(ensureWritableDir).mockImplementation(() => {
      throw new Error("EACCES: 目录不可写");
    });
    startFetchJob("pf-dir");
    await flushAll(3);
    expect(ensureBaseBatchLimit).toHaveBeenCalledWith(CFG.maxConcurrentJobs);
    expect(runBatchJob).not.toHaveBeenCalled();
    expect(updateFetchJobStatus).toHaveBeenCalledWith("pf-dir", "failed", { error: "EACCES: 目录不可写" });
  });
});

// ==================== 逐片续批循环 ====================

describe("逐片续批循环", () => {
  it("hasMore 为真则递增 chunk 并继续，直到 hasMore 为假", async () => {
    vi.mocked(runBatchJob)
      .mockResolvedValueOnce({ result: { hasMore: true }, childRss: 1 } as any)
      .mockResolvedValueOnce({ result: { hasMore: true }, childRss: 1 } as any)
      .mockResolvedValue({ result: { hasMore: false }, childRss: 1 } as any);
    jobs.set("loop1", jobRec({ id: "loop1", status: "done" }));

    startFetchJob("loop1");
    await flushAll(12);

    expect(runBatchJob).toHaveBeenCalledTimes(3);
    expect(vi.mocked(runBatchJob).mock.calls.map((c) => (c[1] as any).chunk)).toEqual([0, 1, 2]);
    expect(sleepBetweenBatch).toHaveBeenCalledTimes(2);
    expect(abortFetchJob("loop1")).toBe(false);
  });

  it("runBatchJob 返回空结果（result 缺失）→ 直接结束循环", async () => {
    vi.mocked(runBatchJob).mockResolvedValue(null as any);
    jobs.set("loop2", jobRec({ id: "loop2", status: "done" }));

    startFetchJob("loop2");
    await flushAll(8);
    expect(runBatchJob).toHaveBeenCalledTimes(1);
    expect(abortFetchJob("loop2")).toBe(false);
  });
});

// ==================== 排空(drain) / 完全停止(hard) 收尾 ====================

describe("排空与完全停止收尾", () => {
  it("排空收尾：补写未开始条目并落 cancelled 终态（同步 counts.total）", async () => {
    jobs.set(
      "dr1",
      jobRec({
        id: "dr1",
        status: "running",
        targets: { targets: [{ id: "t0" }, { id: "t1" }, { id: "t2" }] },
        items: [item("t0")],
      }),
    );

    startFetchJob("dr1");
    expect(drainFetchJob("dr1")).toBe(true);
    await flushAll(10);

    expect(saveFetchJobItems).toHaveBeenCalledTimes(1);
    const call = vi.mocked(saveFetchJobItems).mock.calls[0];
    expect(call[0]).toBe("dr1");
    expect((call[1] as any[]).map((i) => i.targetId).sort()).toEqual(["t0", "t1", "t2"]);
    expect(call[2]).toEqual({ total: 3 });
    expect(updateFetchJobStatus).toHaveBeenCalledWith("dr1", "cancelled", {
      error: "用户取消（排空收尾）",
    });
    expect(abortFetchJob("dr1")).toBe(false);
  });

  it("排空收尾：任务记录不存在时安全返回", async () => {
    jobs.clear(); // getFetchJob 一律 null
    startFetchJob("dr-null");
    drainFetchJob("dr-null");
    await flushAll(8);
    expect(saveFetchJobItems).not.toHaveBeenCalled();
    expect(updateFetchJobStatus).not.toHaveBeenCalled();
  });

  it("排空收尾：条目已齐全则不补写；已完成(done)任务不被降级", async () => {
    jobs.set(
      "dr2",
      jobRec({
        id: "dr2",
        status: "done",
        targets: { targets: [{ id: "t0" }] },
        items: [item("t0")],
      }),
    );
    startFetchJob("dr2");
    drainFetchJob("dr2");
    await flushAll(10);
    expect(saveFetchJobItems).not.toHaveBeenCalled();
    expect(updateFetchJobStatus).not.toHaveBeenCalled();
  });

  it("排空收尾：pending / cancelled 仍在跑窗口内的任务均落 cancelled", async () => {
    for (const st of ["pending", "cancelled"] as const) {
      const id = `st-${st}`;
      jobs.set(id, jobRec({ id, status: st, targets: { targets: [{ id: "t0" }] }, items: [] }));
      startFetchJob(id);
      drainFetchJob(id);
    }
    await flushAll(12);
    expect(updateFetchJobStatus).toHaveBeenCalledWith("st-pending", "cancelled", {
      error: "用户取消（排空收尾）",
    });
    expect(updateFetchJobStatus).toHaveBeenCalledWith("st-cancelled", "cancelled", {
      error: "用户取消（排空收尾）",
    });
  });

  it("排空收尾：读取任务抛错被吞掉，流程不中断", async () => {
    vi.mocked(getFetchJob).mockImplementation(() => {
      throw new Error("read boom");
    });
    startFetchJob("dr3");
    drainFetchJob("dr3");
    await flushAll(10);
    expect(saveFetchJobItems).not.toHaveBeenCalled();
    expect(abortFetchJob("dr3")).toBe(false);
  });

  it("完全停止（hard abort）：落 cancelled 终态并说明用户完全停止", async () => {
    let release: (v: any) => void = () => {};
    vi.mocked(runBatchJob).mockReturnValue(new Promise((r) => { release = r; }) as any);
    jobs.set("hb1", jobRec({ id: "hb1", status: "running", targets: { targets: [{ id: "t0" }] } }));

    startFetchJob("hb1");
    expect(abortFetchJob("hb1")).toBe(true);
    release({ result: { hasMore: false, counts: {} }, childRss: 1 });
    await flushAll(10);
    expect(updateFetchJobStatus).toHaveBeenCalledWith("hb1", "cancelled", { error: "用户完全停止" });
    expect(abortFetchJob("hb1")).toBe(false);
  });

  it("完全停止：分片间硬停 → 循环顶部退出", async () => {
    vi.mocked(runBatchJob).mockResolvedValue({ result: { hasMore: true }, childRss: 1 } as any);
    vi.mocked(sleepBetweenBatch).mockImplementation(async () => {
      abortFetchJob("hb2");
    });
    jobs.set("hb2", jobRec({ id: "hb2", status: "running" }));

    startFetchJob("hb2");
    await flushAll(12);
    expect(updateFetchJobStatus).toHaveBeenCalledWith("hb2", "cancelled", { error: "用户完全停止" });
  });

  it("排空：分片间 drain → 循环顶部退出并走排空收尾", async () => {
    vi.mocked(runBatchJob).mockResolvedValue({ result: { hasMore: true }, childRss: 1 } as any);
    vi.mocked(sleepBetweenBatch).mockImplementation(async () => {
      drainFetchJob("dr-top");
    });
    jobs.set(
      "dr-top",
      jobRec({ id: "dr-top", status: "running", targets: { targets: [{ id: "t0" }] }, items: [] }),
    );

    startFetchJob("dr-top");
    await flushAll(12);
    expect(updateFetchJobStatus).toHaveBeenCalledWith("dr-top", "cancelled", {
      error: "用户取消（排空收尾）",
    });
  });

  it("批量异常且未取消 → failed 终态", async () => {
    vi.mocked(runBatchJob).mockRejectedValue(new Error("子进程崩了"));
    jobs.set("f1", jobRec({ id: "f1", status: "running" }));
    startFetchJob("f1");
    await flushAll(10);
    expect(updateFetchJobStatus).toHaveBeenCalledWith("f1", "failed", { error: "子进程崩了" });
  });

  it("批量异常但已被硬停 → cancelled 终态", async () => {
    let reject: (e: any) => void = () => {};
    vi.mocked(runBatchJob).mockReturnValue(new Promise((_, rj) => { reject = rj; }) as any);
    jobs.set("c1", jobRec({ id: "c1", status: "running" }));
    startFetchJob("c1");
    abortFetchJob("c1");
    reject(new Error("aborted"));
    await flushAll(10);
    expect(updateFetchJobStatus).toHaveBeenCalledWith("c1", "cancelled", { error: "aborted" });
  });
});

// ==================== 全库下载自动续批 ====================

describe("maybeContinueLibraryJob 全库自动续批", () => {
  it("有进展 + 开关开启 → 置会话标记并开下一批", async () => {
    vi.mocked(buildLibraryContinuation).mockReturnValue({
      job: { id: "next-lib" },
      enqueued: 2,
      remaining: 1,
    } as any);
    jobs.set(
      "lib1",
      jobRec({
        id: "lib1",
        kind: "library",
        status: "done",
        config: { __library: { migrateRowOnly: true } },
        counts: { total: 2, done: 2, failed: 0, skipped: 0, added: 0 },
      }),
    );
    jobs.set("next-lib", jobRec({ id: "next-lib", kind: "library", status: "done", config: {} }));

    startFetchJob("lib1");
    await flushAll(16);

    expect(setAutoSession).toHaveBeenCalledWith("library", true);
    expect(vi.mocked(runBatchJob).mock.calls.some((c) => (c[1] as any).jobId === "next-lib")).toBe(true);
  });

  it("无进展（全部跳过）→ 清会话标记并停链", async () => {
    vi.mocked(libraryBatchProgressed).mockReturnValue(false);
    jobs.set(
      "lib-np",
      jobRec({
        id: "lib-np",
        kind: "library",
        status: "done",
        config: { __library: {} },
        counts: { total: 5, done: 0, failed: 0, skipped: 5, added: 0 },
      }),
    );
    startFetchJob("lib-np");
    await flushAll(10);
    expect(setAutoSession).toHaveBeenCalledWith("library", false);
    expect(buildLibraryContinuation).not.toHaveBeenCalled();
  });

  it("自动续批开关关闭 → 清会话标记", async () => {
    vi.mocked(currentFetchConfig).mockReturnValue({ ...CFG, libraryAutoContinue: false } as any);
    jobs.set(
      "lib-off",
      jobRec({ id: "lib-off", kind: "library", status: "done", config: { __library: {} } }),
    );
    startFetchJob("lib-off");
    await flushAll(10);
    expect(setAutoSession).toHaveBeenCalledWith("library", false);
  });

  it("有其它活动任务 → 让渡（不建批、不改会话标记）", async () => {
    prepareSpy.mockReturnValue({ get: () => ({ n: 1 }) } as any);
    jobs.set(
      "lib-busy",
      jobRec({ id: "lib-busy", kind: "library", status: "done", config: { __library: {} } }),
    );
    startFetchJob("lib-busy");
    await flushAll(10);
    expect(buildLibraryContinuation).not.toHaveBeenCalled();
    expect(setAutoSession).not.toHaveBeenCalledWith("library", expect.anything());
  });

  it("活动任务查询抛错 → 保守视为有任务在跑（让渡）", async () => {
    prepareSpy.mockImplementation(() => {
      throw new Error("db down");
    });
    jobs.set(
      "lib-err",
      jobRec({ id: "lib-err", kind: "library", status: "done", config: { __library: {} } }),
    );
    startFetchJob("lib-err");
    await flushAll(10);
    expect(buildLibraryContinuation).not.toHaveBeenCalled();
  });

  it("无待下项 → 清会话标记", async () => {
    vi.mocked(buildLibraryContinuation).mockReturnValue({ job: null, enqueued: 0, remaining: 0 } as any);
    jobs.set(
      "lib-done",
      jobRec({ id: "lib-done", kind: "library", status: "done", config: { __library: {} } }),
    );
    startFetchJob("lib-done");
    await flushAll(10);
    expect(setAutoSession).toHaveBeenCalledWith("library", false);
  });

  it("任务已取消（library 且非点名批次）→ 清会话标记；点名批次(cancelled) 不清标记", async () => {
    jobs.set(
      "lib-cxl",
      jobRec({ id: "lib-cxl", kind: "library", status: "cancelled", config: { __library: {} } }),
    );
    jobs.set(
      "lib-cxl-named",
      jobRec({
        id: "lib-cxl-named",
        kind: "library",
        status: "cancelled",
        config: { __library: { noAutoContinue: true } },
      }),
    );
    startFetchJob("lib-cxl");
    startFetchJob("lib-cxl-named");
    await flushAll(12);
    expect(setAutoSession).toHaveBeenCalledWith("library", false);
    // 点名批次不参与续批链，取消它不应清会话标记。
    expect(setAutoSession).toHaveBeenCalledTimes(1);
  });

  it("硬停止 → 清会话标记", async () => {
    let release: (v: any) => void = () => {};
    vi.mocked(runBatchJob).mockReturnValue(new Promise((r) => { release = r; }) as any);
    jobs.set(
      "lib-hard",
      jobRec({ id: "lib-hard", kind: "library", status: "running", config: { __library: {} } }),
    );
    startFetchJob("lib-hard");
    abortFetchJob("lib-hard");
    release({ result: { hasMore: false, counts: {} }, childRss: 1 });
    await flushAll(10);
    expect(setAutoSession).toHaveBeenCalledWith("library", false);
  });

  it("非全库任务（无 __library）/ 点名批次(noAutoContinue) → 直接返回", async () => {
    jobs.set("plain", jobRec({ id: "plain", status: "done", config: {} }));
    jobs.set(
      "named",
      jobRec({
        id: "named",
        kind: "library",
        status: "done",
        config: { __library: { noAutoContinue: true } },
      }),
    );
    startFetchJob("plain");
    startFetchJob("named");
    await flushAll(12);
    expect(buildLibraryContinuation).not.toHaveBeenCalled();
  });

  it("config 为字符串：JSON 合法则解析生效；非法则视为无标记", async () => {
    vi.mocked(buildLibraryContinuation).mockReturnValue({
      job: { id: "next-json" },
      enqueued: 1,
      remaining: 0,
    } as any);
    jobs.set(
      "lib-json",
      jobRec({
        id: "lib-json",
        kind: "library",
        status: "done",
        config: JSON.stringify({ __library: {} }),
        counts: { total: 1, done: 1 },
      }),
    );
    jobs.set("next-json", jobRec({ id: "next-json", kind: "library", status: "done", config: {} }));
    jobs.set("lib-bad-json", jobRec({ id: "lib-bad-json", kind: "library", status: "done", config: "not-json{" }));

    startFetchJob("lib-json");
    startFetchJob("lib-bad-json");
    await flushAll(16);

    expect(setAutoSession).toHaveBeenCalledWith("library", true);
    expect(buildLibraryContinuation).toHaveBeenCalledTimes(1);
  });
});

// ==================== 洗版自动续批 ====================

describe("maybeContinueUpgradeJob 洗版自动续批", () => {
  it("有进展 + 开关开启 → 置会话标记并开下一批", async () => {
    vi.mocked(buildUpgradeContinuation).mockReturnValue({
      job: { id: "next-up" },
      enqueued: 1,
      remaining: 0,
    } as any);
    jobs.set(
      "up1",
      jobRec({
        id: "up1",
        kind: "upgrade",
        status: "done",
        config: { __upgrade: {} },
        counts: { total: 1, done: 1, failed: 0, skipped: 0 },
      }),
    );
    jobs.set("next-up", jobRec({ id: "next-up", kind: "upgrade", status: "done", config: {} }));

    startFetchJob("up1");
    await flushAll(16);

    expect(setAutoSession).toHaveBeenCalledWith("upgrade", true);
    expect(vi.mocked(runBatchJob).mock.calls.some((c) => (c[1] as any).jobId === "next-up")).toBe(true);
  });

  it("零尝试闸：total>0 但 done/failed/skipped 全 0 → 清会话标记停链", async () => {
    jobs.set(
      "up-zero",
      jobRec({
        id: "up-zero",
        kind: "upgrade",
        status: "done",
        config: { __upgrade: {} },
        counts: { total: 5, done: 0, failed: 0, skipped: 0 },
      }),
    );
    startFetchJob("up-zero");
    await flushAll(10);
    expect(setAutoSession).toHaveBeenCalledWith("upgrade", false);
    expect(buildUpgradeContinuation).not.toHaveBeenCalled();
  });

  it("自动续批开关关闭 → 清会话标记", async () => {
    vi.mocked(currentFetchConfig).mockReturnValue({ ...CFG, upgradeAutoContinue: false } as any);
    jobs.set(
      "up-off",
      jobRec({
        id: "up-off",
        kind: "upgrade",
        status: "done",
        config: { __upgrade: {} },
        counts: { total: 1, done: 1 },
      }),
    );
    startFetchJob("up-off");
    await flushAll(10);
    expect(setAutoSession).toHaveBeenCalledWith("upgrade", false);
  });

  it("有其它活动任务 → 让渡（不建批）", async () => {
    prepareSpy.mockReturnValue({ get: () => ({ n: 1 }) } as any);
    jobs.set(
      "up-busy",
      jobRec({
        id: "up-busy",
        kind: "upgrade",
        status: "done",
        config: { __upgrade: {} },
        counts: { total: 1, done: 1 },
      }),
    );
    startFetchJob("up-busy");
    await flushAll(10);
    expect(buildUpgradeContinuation).not.toHaveBeenCalled();
    expect(setAutoSession).not.toHaveBeenCalledWith("upgrade", expect.anything());
  });

  it("无可洗项 → 清会话标记", async () => {
    vi.mocked(buildUpgradeContinuation).mockReturnValue({ job: null, enqueued: 0, remaining: 0 } as any);
    jobs.set(
      "up-done",
      jobRec({
        id: "up-done",
        kind: "upgrade",
        status: "done",
        config: { __upgrade: {} },
        counts: { total: 1, done: 1 },
      }),
    );
    startFetchJob("up-done");
    await flushAll(10);
    expect(setAutoSession).toHaveBeenCalledWith("upgrade", false);
  });

  it("任务已取消 → 清会话标记；点名批次(noAutoContinue) 不清", async () => {
    jobs.set(
      "up-cxl",
      jobRec({ id: "up-cxl", kind: "upgrade", status: "cancelled", config: { __upgrade: {} } }),
    );
    jobs.set(
      "up-cxl-named",
      jobRec({
        id: "up-cxl-named",
        kind: "upgrade",
        status: "cancelled",
        config: { __upgrade: { noAutoContinue: true } },
      }),
    );
    startFetchJob("up-cxl");
    startFetchJob("up-cxl-named");
    await flushAll(12);
    expect(setAutoSession).toHaveBeenCalledWith("upgrade", false);
    expect(setAutoSession).toHaveBeenCalledTimes(1);
  });

  it("硬停止 → 清会话标记", async () => {
    let release: (v: any) => void = () => {};
    vi.mocked(runBatchJob).mockReturnValue(new Promise((r) => { release = r; }) as any);
    jobs.set(
      "up-hard",
      jobRec({ id: "up-hard", kind: "upgrade", status: "running", config: { __upgrade: {} } }),
    );
    startFetchJob("up-hard");
    abortFetchJob("up-hard");
    release({ result: { hasMore: false, counts: {} }, childRss: 1 });
    await flushAll(10);
    expect(setAutoSession).toHaveBeenCalledWith("upgrade", false);
  });

  it("非洗版任务 / 点名批次 → 直接返回", async () => {
    jobs.set("up-plain", jobRec({ id: "up-plain", status: "done", config: { __upgrade: { noAutoContinue: true } } }));
    jobs.set("up-nomark", jobRec({ id: "up-nomark", kind: "upgrade", status: "done", config: {} }));
    startFetchJob("up-plain");
    startFetchJob("up-nomark");
    await flushAll(12);
    expect(buildUpgradeContinuation).not.toHaveBeenCalled();
  });
});

// ==================== 终态自动增量扫描 ====================

describe("autoScanAfterJob 终态自动扫描", () => {
  it("done + added>0 → 转发扫描任务并去重入队标签修复", async () => {
    jobs.set(
      "scan1",
      jobRec({
        id: "scan1",
        status: "done",
        sourceId: "src-1",
        counts: { added: 3, done: 3 },
        imports: [
          { itemId: "i0", songId: "s0", result: "added" },
          { itemId: "i1", songId: "s0", result: "updated" },
          { itemId: "i2", songId: "s1", result: "skipped" },
        ],
      }),
    );
    startFetchJob("scan1");
    await flushAll(12);
    expect(enqueueTagRepairs).toHaveBeenCalledWith(["s0"]);
    expect(vi.mocked(runBatchJob).mock.calls.some((c) => c[0] === "scan")).toBe(true);
  });

  it("cancelled + added>0 → 仍转发扫描", async () => {
    jobs.set(
      "scan2",
      jobRec({ id: "scan2", status: "cancelled", sourceId: "src-1", counts: { added: 1 } }),
    );
    startFetchJob("scan2");
    await flushAll(12);
    expect(vi.mocked(runBatchJob).mock.calls.some((c) => c[0] === "scan")).toBe(true);
  });

  it("done + added=0 → 不转发扫描（标签修复仍入队）", async () => {
    jobs.set(
      "scan3",
      jobRec({
        id: "scan3",
        status: "done",
        sourceId: "src-1",
        counts: { added: 0 },
        imports: [{ itemId: "i0", songId: "s9", result: "added" }],
      }),
    );
    startFetchJob("scan3");
    await flushAll(12);
    expect(enqueueTagRepairs).toHaveBeenCalledWith(["s9"]);
    expect(vi.mocked(runBatchJob).mock.calls.some((c) => c[0] === "scan")).toBe(false);
  });

  it("failed / cancelled+added=0 / 无 sourceId → 直接返回不做任何事", async () => {
    jobs.set("scan4", jobRec({ id: "scan4", status: "failed", sourceId: "src-1", counts: { added: 5 } }));
    jobs.set("scan5", jobRec({ id: "scan5", status: "cancelled", sourceId: "src-1", counts: { added: 0 } }));
    jobs.set("scan6", jobRec({ id: "scan6", status: "done", sourceId: null, counts: { added: 5 } }));
    startFetchJob("scan4");
    startFetchJob("scan5");
    startFetchJob("scan6");
    await flushAll(12);
    expect(enqueueTagRepairs).not.toHaveBeenCalled();
    expect(vi.mocked(runBatchJob).mock.calls.some((c) => c[0] === "scan")).toBe(false);
  });

  it("标签修复入队抛错被吞掉；扫描任务失败走 catch", async () => {
    vi.mocked(enqueueTagRepairs).mockImplementation(() => {
      throw new Error("queue down");
    });
    vi.mocked(runBatchJob).mockImplementation(async (kind: any) => {
      if (kind === "scan") throw new Error("scan fail");
      return { result: { hasMore: false, counts: {} }, childRss: 1 } as any;
    });
    jobs.set(
      "scan7",
      jobRec({
        id: "scan7",
        status: "done",
        sourceId: "src-1",
        counts: { added: 2 },
        imports: [{ itemId: "i0", songId: "s7", result: "added" }],
      }),
    );
    startFetchJob("scan7");
    await flushAll(14);
    expect(vi.mocked(runBatchJob).mock.calls.some((c) => c[0] === "scan")).toBe(true);
  });
});

// ==================== boot 恢复 ====================

describe("resumeInterruptedFetchJobs boot 恢复", () => {
  it("为中断任务重新入队，已在推进的跳过", async () => {
    let release: (v: any) => void = () => {};
    vi.mocked(runBatchJob).mockReturnValue(new Promise((r) => { release = r; }) as any);
    jobs.set("a", jobRec({ id: "a", status: "running", config: {} }));
    jobs.set("b", jobRec({ id: "b", status: "running", config: {} }));

    startFetchJob("a"); // 先让 "a" 处于「本进程已在跑」
    vi.mocked(collectInterruptedFetchJobIds).mockReturnValue(["a", "b"]);
    expect(resumeInterruptedFetchJobs()).toBe(1);
    await flushAll(10);
    // "b" 被重新入队并起跑；"a" 未重复推进。
    expect(vi.mocked(runBatchJob).mock.calls.some((c) => (c[1] as any).jobId === "b")).toBe(true);

    release({ result: { hasMore: false, counts: {} }, childRss: 1 });
    await flushAll(6);
  });

  it("无中断任务 → 返回 0", () => {
    vi.mocked(collectInterruptedFetchJobIds).mockReturnValue([]);
    expect(resumeInterruptedFetchJobs()).toBe(0);
  });

  it("单个恢复失败落 failed（boot 恢复失败），不拖累其它任务", async () => {
    // 构造：写目录预检抛错触发 startFetchJob 内部快速失败，且 updateFetchJobStatus 首次调用抛错
    // → 异常冒出到 resumeInterruptedFetchJobs 的 catch，落「boot 恢复失败」终态。
    vi.mocked(ensureWritableDir).mockImplementation(() => {
      throw new Error("EACCES");
    });
    vi.mocked(updateFetchJobStatus).mockImplementation((_id: any, status: any, extra: any) => {
      if (status === "failed" && !String(extra?.error ?? "").startsWith("boot 恢复失败")) {
        throw new Error("db error");
      }
    });
    vi.mocked(collectInterruptedFetchJobIds).mockReturnValue(["x"]);
    expect(resumeInterruptedFetchJobs()).toBe(0);
    expect(updateFetchJobStatus).toHaveBeenCalledWith("x", "failed", {
      error: "boot 恢复失败: db error",
    });
  });

  it("BOOT_RESUME_DELAY_MS 常量=60s", () => {
    expect(BOOT_RESUME_DELAY_MS).toBe(60_000);
  });
});
