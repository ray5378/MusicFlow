// ==================== batchPacer 批量节拍器专项测试 ====================
// 覆盖 P0/P1/P2 三阶段核心:档位并发、全局闸互斥/FIFO、批间睡眠。
import { describe, it, expect, beforeEach } from "vitest";
import { acquireBatchLock, batchConcurrency, sleepBetweenBatch, _resetPacerForTest, sleep } from "../../src/services/plugin/batchPacer.js";
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

  it("批间睡眠: full 档不睡(<30ms), slow 档至少睡 100ms", async () => {
    setSetting("batch_pace", "full");
    const t0 = Date.now();
    await sleepBetweenBatch();
    expect(Date.now() - t0).toBeLessThan(30);
    setSetting("batch_pace", "slow");
    const t1 = Date.now();
    await sleepBetweenBatch();
    expect(Date.now() - t1).toBeGreaterThanOrEqual(100);
  });
});
