// MUST be the first import:隔离 DATA_DIR 后再加载后端模块。
import "../plugins/_env.js";

// shared.ts 的**扫描任务 TTL 清扫**补测(shared.ts:210-218)。
//
// 为什么单独一个文件:清扫定时器是模块加载时用 setInterval 建起来的(5 分钟一轮),
// 要让它被假时钟接管,必须在 import shared.js **之前**装好 vi.useFakeTimers()。
//
// 产品契约(内存红线 + 可用性,两条必须同时成立):
//   ① 完成/失败/停止的扫描任务要**保留 30 分钟** —— 前端是靠轮询 GET 任务状态取
//      结果的,清得太早用户会看到「任务不见了」却不知道扫没扫完;
//   ② 保留期满必须清掉 —— scanJobs 是进程内 Map,不清就会随每次扫描**无界增长**,
//      长期运行的机器上这是一个只会涨不会落的泄漏;
//   ③ **running 中的任务永不被清** —— 并发扫描正是靠 scanJobs 里的 running 记录
//      判定「已有扫描在跑」,把它清掉等于放行并发扫描(重复全量扫库)。
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from "vitest";

type Any = any;

let shared: typeof import("../../src/routes/api/shared.js");

beforeAll(async () => {
  // 关键:先装假时钟,再加载模块 —— 模块顶层的 setInterval 才会被接管。
  vi.useFakeTimers();
  shared = await import("../../src/routes/api/shared.js");
});

afterAll(() => {
  vi.useRealTimers();
});

/** 放进一条扫描任务记录。startedAt 用假时钟的当前时刻。 */
function put(id: string, status: string) {
  shared.scanJobs.set(id, { status, startedAt: new Date().toISOString() });
}

beforeEach(() => {
  shared.scanJobs.clear();
});

afterEach(() => {
  // 用例之间不留残留:scanJobs 是模块级 Map,污染会波及本文件后续用例。
  shared.scanJobs.clear();
});

describe("scanJobs TTL 清扫(30 分钟)", () => {
  it("保留期内不清:前端靠轮询取结果,5 分钟内必须还能查到", () => {
    put("just-done", "done");
    vi.advanceTimersByTime(5 * 60 * 1000); // 清扫跑了 1 轮,但任务才 5 分钟
    expect(shared.scanJobs.has("just-done")).toBe(true);
  });

  it("满 30 分钟清掉已完成的任务(Map 有界,不会随扫描次数无增长)", () => {
    put("old-done", "done");
    put("old-failed", "failed");
    put("old-stopped", "stopped");

    for (let i = 0; i < 6; i++) vi.advanceTimersByTime(5 * 60 * 1000); // 累计 30 分钟

    expect(shared.scanJobs.has("old-done")).toBe(false);
    expect(shared.scanJobs.has("old-failed")).toBe(false);
    expect(shared.scanJobs.has("old-stopped")).toBe(false);
  });

  it("running 中的任务永不被清(清掉就等于放行并发扫描)", () => {
    put("still-running", "running");
    put("finished", "done");

    for (let i = 0; i < 12; i++) vi.advanceTimersByTime(5 * 60 * 1000); // 累计 60 分钟

    expect(shared.scanJobs.has("still-running")).toBe(true); // 跑再久也留着
    expect(shared.scanJobs.has("finished")).toBe(false);
  });

  it("清扫按**条目自身**的起始时间判定:后加的任务不会被一并清掉", () => {
    put("early", "done");
    vi.advanceTimersByTime(20 * 60 * 1000); // 20 分钟后才出现第二条
    put("late", "done");
    vi.advanceTimersByTime(15 * 60 * 1000); // 总计 35 分钟:early 满 30 分钟,late 只有 15 分钟

    expect(shared.scanJobs.has("early")).toBe(false);
    expect(shared.scanJobs.has("late")).toBe(true);
  });

  it("SCAN_JOB_TTL_MS 就是 30 分钟(常量被改小会让前端拿不到结果)", () => {
    expect(shared.SCAN_JOB_TTL_MS).toBe(30 * 60 * 1000);
  });
});
