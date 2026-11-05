// 回归守卫(2026-11-05):曲末预热窗口由 9s 上调到 30s。
//
// 事故:240 HIVI dur=262s 那首在 9s 窗口里零 `DrainPreheat` 行 —— 设备 5s 采样 + 约 10s
// 缓冲让上报位置永远落后真实进度,末次采样距曲末常在 20s 以上,窗口整首都没进过,于是
// 切歌之后才现算音源(该次空窗 33s)。本文件守卫「窗口是 30s」,防止凭手感再调回个位数。
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  DRAIN_PREHEAT_LEAD_MS,
  preheatNextOnDrain,
  resetDrainPreheatForTest,
  setDrainPreheatExecutorForTest,
} from "../src/services/player/drainPreheat.js";
import type { QueuePeekSource } from "../src/services/player/preProbeScheduler.js";

/** order 模式:currentIndex=0,下一首 = idx 1。 */
function queue2(): QueuePeekSource {
  return {
    items: [{ songId: "cur-aaaa" }, { songId: "next-bbbb" }],
    currentIndex: 0,
    playMode: "order",
  };
}

/** 让 fire-and-forget 的 runPreheat 跑完一轮(执行器是 async,宏任务即够)。 */
function flush(): Promise<void> {
  return new Promise((r) => setTimeout(r, 0));
}

describe("曲末预热窗口(2026-11-05 240 现场)", () => {
  const calls: string[] = [];

  beforeEach(() => {
    calls.length = 0;
    resetDrainPreheatForTest();
    setDrainPreheatExecutorForTest(async (id) => {
      calls.push(id);
      return { row: {}, reason: "local-stat-ok" };
    });
  });

  afterEach(() => resetDrainPreheatForTest());

  it("窗口 = 30s:距曲末 31s 不预热,29s 预热", async () => {
    expect(DRAIN_PREHEAT_LEAD_MS).toBe(30_000);
    const dur = 262_000;
    preheatNextOnDrain("dev-a", queue2(), dur - 31_000, dur);
    await flush();
    expect(calls).toEqual([]);
    preheatNextOnDrain("dev-a", queue2(), dur - 29_000, dur);
    await flush();
    expect(calls).toEqual(["next-bbbb"]);
  });

  it("幂等:同一代次(同 player + 同下一首)只真跑一次", async () => {
    const dur = 200_000;
    preheatNextOnDrain("dev-b", queue2(), dur - 20_000, dur);
    await flush();
    preheatNextOnDrain("dev-b", queue2(), dur - 5_000, dur);
    await flush();
    expect(calls).toEqual(["next-bbbb"]);
  });

  it("时长未知(dur<=0)不预热(没有曲末可算)", async () => {
    preheatNextOnDrain("dev-c", queue2(), 100_000, 0);
    await flush();
    expect(calls).toEqual([]);
  });
});
