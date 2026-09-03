// ==================== batchPacer 批量节拍器专项测试 ====================
// 覆盖 P0/P1/P2 三阶段核心:档位并发、全局闸互斥/FIFO、批间睡眠、交互优先让行。
import { describe, it, expect, beforeEach } from "vitest";
import {
  acquireBatchLock, batchConcurrency, sleepBetweenBatch, _resetPacerForTest, sleep,
  markInteractiveStart, markInteractiveEnd, isInteractiveActive, interactiveConcurrency,
  setBatchConcurrencyLimit, registerBatchWorker, unregisterBatchWorker, _batchLimitForTest,
} from "../../src/services/plugin/batchPacer.js";
import { setSetting } from "../../src/services/settings.js";

describe("batchPacer 批量节拍器", () => {
  beforeEach(() => { _resetPacerForTest(); });

  it("档位并发: slow=1 / standard=2 / full=4", () => {
    setSetting("batch_pace", "slow");
    expect(batchConcurrency()).toBe(1);
    setSetting("batch_pace", "standard");
    expect(batchConcurrency()).toBe(2);
    setSetting("batch_pace", "full");
    expect(batchConcurrency()).toBe(4);
  });

  it("未知档位回退 standard", () => {
    setSetting("batch_pace", "nonsense");
    expect(batchConcurrency()).toBe(2);
  });

  it("全局闸互斥:未释放前第二把拿不到,释放后立即获得", async () => {
    const release1 = await acquireBatchLock();
    let secondGot = false;
    const second = (async () => { const r = await acquireBatchLock(); secondGot = true; return r; })();
    await sleep(50);
    expect(secondGot).toBe(false); // 第一把未释放 → 第二把必须等待
    release1();
    const release2 = await second;
    expect(secondGot).toBe(true);
    release2();
  });

  it("全局闸 FIFO:三个请求按序获得执行权", async () => {
    const order: number[] = [];
    const t1 = (async () => { const r = await acquireBatchLock(); order.push(1); await sleep(20); r(); })();
    const t2 = (async () => { const r = await acquireBatchLock(); order.push(2); r(); })();
    const t3 = (async () => { const r = await acquireBatchLock(); order.push(3); r(); })();
    await Promise.all([t1, t2, t3]);
    expect(order).toEqual([1, 2, 3]);
  });

  it("释放函数幂等:重复调用只唤醒一次,不破坏队列", async () => {
    const release1 = await acquireBatchLock();
    let secondGot = false;
    const second = (async () => { const r = await acquireBatchLock(); secondGot = true; return r; })();
    release1();
    release1(); // 重复释放应无副作用
    const release2 = await second;
    expect(secondGot).toBe(true);
    release2();
  });

  it("批间睡眠: full 档不睡(<50ms), slow 档至少睡 100ms", async () => {
    setSetting("batch_pace", "full");
    const t0 = Date.now();
    await sleepBetweenBatch();
    // full 档 sleepMs=0 → setTimeout(0)。CI 负载下事件循环可能推迟数 ms,
    // 留到 <50ms(仍远低于 slow 的 120ms)即可证明「不主动睡」。
    expect(Date.now() - t0).toBeLessThan(50);
    setSetting("batch_pace", "slow");
    const t1 = Date.now();
    await sleepBetweenBatch();
    expect(Date.now() - t1).toBeGreaterThanOrEqual(100);
  });

  // ---------- 交互优先(用户前端操作让行) ----------
  it("交互窗口内批量并发压到 1(不限档位)", () => {
    for (const pace of ["slow", "standard", "full"] as const) {
      setSetting("batch_pace", pace);
      markInteractiveStart();
      expect(isInteractiveActive()).toBe(true);
      expect(batchConcurrency()).toBe(1); // 后台单线程,让位用户
      markInteractiveEnd();
      expect(isInteractiveActive()).toBe(false);
    }
    // 退出交互窗口后恢复正常档位并发
    setSetting("batch_pace", "standard");
    expect(batchConcurrency()).toBe(2);
  });

  it("交互窗口内批间睡眠放大 4 倍(slow 120→≥460ms)", async () => {
    setSetting("batch_pace", "slow");
    markInteractiveStart();
    const t0 = Date.now();
    await sleepBetweenBatch();
    const elapsed = Date.now() - t0;
    markInteractiveEnd();
    // 目标 120×4=480ms。Node 定时器在 CI 负载下可能早 1~2ms 触发(曾实测 479ms),
    // 断言放 460 仍远高于非交互路径上限(ELD ×2 = 240ms),语义(放大 4 倍)不丢。
    expect(elapsed).toBeGreaterThanOrEqual(460);
  });

  it("交互操作自身并发不受退让影响(interactiveConcurrency = 档位基础并发)", () => {
    setSetting("batch_pace", "standard");
    markInteractiveStart();
    expect(interactiveConcurrency()).toBe(2); // 用户导入全速,不自我节流
    markInteractiveEnd();
    setSetting("batch_pace", "full");
    markInteractiveStart();
    expect(interactiveConcurrency()).toBe(4);
    markInteractiveEnd();
  });

  it("计数成对:嵌套交互(搜索+导入)结束一个仍处于窗口,全部结束才退出", () => {
    markInteractiveStart(); // 搜索
    markInteractiveStart(); // 导入
    expect(isInteractiveActive()).toBe(true);
    markInteractiveEnd();   // 搜索结束
    expect(isInteractiveActive()).toBe(true); // 导入仍在 → 后台继续让路
    markInteractiveEnd();   // 导入结束
    expect(isInteractiveActive()).toBe(false);
  });

  it("多余 end 不产生负计数(reset 后语义正确)", () => {
    markInteractiveEnd(); // 无 start 的 end → 忽略
    markInteractiveEnd();
    expect(isInteractiveActive()).toBe(false);
  });
});

describe("批量闸多核并发(worker 化后)", () => {
  it("setBatchConcurrencyLimit(2) 后两个任务可同时持锁", async () => {
    setBatchConcurrencyLimit(2);
    const r1 = await acquireBatchLock();
    const r2 = await acquireBatchLock();
    // 两个都拿到锁(并发 2);第三个必须排队
    let thirdGot = false;
    const third = (async () => { const r = await acquireBatchLock(); thirdGot = true; r(); })();
    await sleep(30);
    expect(thirdGot).toBe(false);
    r1();
    await sleep(10);
    expect(thirdGot).toBe(true); // r1 释放后有空位(仍 1 个持锁 < 2),third 进入
    r2();
    await sleep(10);
    // third 已执行并释放;补一次获取再释放确保无残留
    const leftover = await acquireBatchLock();
    leftover();
  });

  it("并发上限回 1(无 worker)时退化为互斥", async () => {
    setBatchConcurrencyLimit(1);
    const r1 = await acquireBatchLock();
    let secondGot = false;
    const second = (async () => { const r = await acquireBatchLock(); secondGot = true; r(); })();
    await sleep(30);
    expect(secondGot).toBe(false);
    r1();
    await sleep(10);
    expect(secondGot).toBe(true);
    // second 已释放;补一次获取再释放确保无残留
    const leftover = await acquireBatchLock();
    leftover();
  });

  it("registerBatchWorker 提升上限、unregister 回退(按 id 幂等)", async () => {
    _resetPacerForTest();
    registerBatchWorker("a");
    registerBatchWorker("a"); // 同一 id 重复注册只算一次
    registerBatchWorker("b"); // 2 个插件 → 并发 2
    expect(_batchLimitForTest()).toBe(2);
    const r1 = await acquireBatchLock();
    const r2 = await acquireBatchLock();
    let thirdGot = false;
    const third = (async () => { const r = await acquireBatchLock(); thirdGot = true; r(); })();
    await sleep(30);
    expect(thirdGot).toBe(false);
    r1(); r2();
    await sleep(10);
    expect(thirdGot).toBe(true);
    unregisterBatchWorker("a");
    unregisterBatchWorker("missing-id"); // 幂等删除不存在的 id,不影响上限
    expect(_batchLimitForTest()).toBe(1);
    unregisterBatchWorker("b"); // 全注销 → 并发 1
    expect(_batchLimitForTest()).toBe(1);
  });
});
