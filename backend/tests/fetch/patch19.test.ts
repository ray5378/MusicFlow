// PATCH19 回归测试：任务级并行（批量闸保底下限）+ 全库记账终态化 + boot 恢复收集。
import "../plugins/_env.js";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  _batchLimitForTest,
  _resetPacerForTest,
  ensureBaseBatchLimit,
  registerBatchWorker,
  unregisterBatchWorker,
} from "../../src/services/plugin/batchPacer.js";
import {
  ensureLibraryAttemptsTable,
  recordLibraryAttempt,
  resetLibraryAttempts,
} from "../../src/services/fetch/library.js";
import {
  collectInterruptedFetchJobIds,
  createFetchJob,
  _resetFetchJobsForTest,
  getFetchJob,
  updateFetchJobStatus,
} from "../../src/services/fetch/jobStore.js";
import { sqlite } from "../../src/db/index.js";
import { resolveFetchConfig } from "../../src/services/fetch/config.js";

describe("batchPacer — ensureBaseBatchLimit 保底下限", () => {
  beforeEach(() => _resetPacerForTest());
  afterEach(() => _resetPacerForTest());

  it("保底下限生效：limit 至少为 floor", () => {
    ensureBaseBatchLimit(3);
    expect(_batchLimitForTest()).toBe(3);
  });

  it("批量闸硬上限 16：floor 开再大也封顶 16", () => {
    ensureBaseBatchLimit(99);
    expect(_batchLimitForTest()).toBe(16);
    ensureBaseBatchLimit(16);
    expect(_batchLimitForTest()).toBe(16);
  });

  it("插件并行资格与 floor 取大者；注销后回落到 floor 而不是 1", () => {
    ensureBaseBatchLimit(2);
    registerBatchWorker("plug-a");
    expect(_batchLimitForTest()).toBe(2); // max(floor=2, size=1)
    registerBatchWorker("plug-b");
    expect(_batchLimitForTest()).toBe(2); // max(floor=2, size=2)
    registerBatchWorker("plug-c");
    expect(_batchLimitForTest()).toBe(3); // max(floor=2, size=3)
    unregisterBatchWorker("plug-c");
    unregisterBatchWorker("plug-b");
    unregisterBatchWorker("plug-a");
    expect(_batchLimitForTest()).toBe(2); // 回落 floor，不再退化串行
  });

  it("floor 调回 1 恢复旧串行语义", () => {
    ensureBaseBatchLimit(2);
    expect(_batchLimitForTest()).toBe(2);
    ensureBaseBatchLimit(1);
    expect(_batchLimitForTest()).toBe(1);
  });

  it("maxConcurrentJobs 配置夹紧到 1..16（下载/洗版/全库共用同一字段）", () => {
    expect(resolveFetchConfig({ maxConcurrentJobs: 99 }).maxConcurrentJobs).toBe(16);
    expect(resolveFetchConfig({ maxConcurrentJobs: 16 }).maxConcurrentJobs).toBe(16);
    expect(resolveFetchConfig({ maxConcurrentJobs: 0 }).maxConcurrentJobs).toBe(1);
    expect(resolveFetchConfig({ maxConcurrentJobs: -3 }).maxConcurrentJobs).toBe(1);
    expect(resolveFetchConfig({}).maxConcurrentJobs).toBe(2);
  });
});

describe("recordLibraryAttempt — 终态 UPSERT 记账", () => {
  beforeEach(() => {
    ensureLibraryAttemptsTable();
    resetLibraryAttempts();
  });
  afterEach(() => resetLibraryAttempts());

  it("首次写入 + 重复记账覆盖状态与时间（冷却起点后移）", async () => {
    recordLibraryAttempt("s1", "b1", "done");
    let row = sqlite
      .prepare("SELECT song_id, batch_id, status, attempted_at FROM fetch_library_attempts WHERE song_id='s1'")
      .get() as any;
    expect(row.status).toBe("done");
    expect(row.batch_id).toBe("b1");
    const at1 = row.attempted_at;

    // 同一首重试失败：UPSERT 覆盖（旧行为 INSERT OR IGNORE 会保留 done 旧账）。
    await new Promise((r) => setTimeout(r, 5));
    recordLibraryAttempt("s1", "b2", "failed");
    row = sqlite
      .prepare("SELECT batch_id, status, attempted_at FROM fetch_library_attempts WHERE song_id='s1'")
      .get() as any;
    expect(row.status).toBe("failed");
    expect(row.batch_id).toBe("b2");
    expect(row.attempted_at >= at1).toBe(true);
  });

  it("空 songId 不写行", () => {
    recordLibraryAttempt("", "b1", "done");
    const n = sqlite.prepare("SELECT COUNT(*) AS n FROM fetch_library_attempts").get() as { n: number };
    expect(n.n).toBe(0);
  });
});

describe("collectInterruptedFetchJobIds — boot 恢复收集（不落终态）", () => {
  beforeEach(() => _resetFetchJobsForTest());
  afterEach(() => _resetFetchJobsForTest());

  it("只收集 pending/running，且不改任何行", () => {
    const a = createFetchJob({
      kind: "manual",
      targets: { targets: [{ id: "t1", title: "A", durationSec: 1 }] },
    });
    const b = createFetchJob({
      kind: "manual",
      targets: { targets: [{ id: "t2", title: "B", durationSec: 1 }] },
    });
    updateFetchJobStatus(b.id, "running");
    const done = createFetchJob({
      kind: "manual",
      targets: { targets: [{ id: "t3", title: "C", durationSec: 1 }] },
    });
    updateFetchJobStatus(done.id, "done");

    const ids = collectInterruptedFetchJobIds();
    expect(ids).toContain(a.id);
    expect(ids).toContain(b.id);
    expect(ids).not.toContain(done.id);
    // 不落终态：行保持原状，交给 resumeInterruptedFetchJobs 续跑。
    expect(getFetchJob(a.id)?.status).toBe("pending");
    expect(getFetchJob(b.id)?.status).toBe("running");
  });

  it("无遗留任务返回空数组", () => {
    expect(collectInterruptedFetchJobIds()).toEqual([]);
  });
});
