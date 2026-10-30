// ==================== 曲末预热的下推钩子(2026-10-30) ====================
//
// 锁住三条:
//   1. 预热**判出可播源**之后才下推(outcome=skip 无源时不下推);
//   2. 钩子抛错被吞掉,不冒泡到 tracker(红线与预热本体一致);
//   3. 注销(null)后完全不触发。
import { describe, it, expect, beforeEach } from "vitest";
import {
  preheatNextOnDrain,
  setDrainPreheatExecutorForTest,
  setDrainPreheatWarmHook,
  resetDrainPreheatForTest,
  type DrainPreheatResolveResult,
} from "../../src/services/player/drainPreheat.js";
import type { QueuePeekSource } from "../../src/services/player/preProbeScheduler.js";

const DUR_MS = 250_000;
/** 窗口内(时长 − 9000ms 之后)。 */
const POS_IN_WINDOW = DUR_MS - 8_000;

function peekOf(songIds: string[], currentIndex = 0): QueuePeekSource {
  return { items: songIds.map((songId) => ({ songId })), currentIndex, playMode: "order" };
}

async function flush(): Promise<void> {
  for (let i = 0; i < 5; i++) await Promise.resolve();
  await new Promise((r) => setTimeout(r, 0));
}

let warmed: string[] = [];

function install(result: DrainPreheatResolveResult): void {
  setDrainPreheatExecutorForTest(async () => result);
}

beforeEach(() => {
  resetDrainPreheatForTest();
  warmed = [];
  setDrainPreheatWarmHook((songId) => warmed.push(songId));
});

describe("drainPreheat 下推钩子", () => {
  it("判出可播源后下推下一首的 songId", async () => {
    install({ row: { id: "r" }, reason: "local-probe-ok" });
    preheatNextOnDrain("player-1", peekOf(["cur", "next"]), POS_IN_WINDOW, DUR_MS);
    await flush();
    expect(warmed).toEqual(["next"]);
  });

  it("缓存命中(cached)同样下推 —— 主进程命中不代表子进程命中", async () => {
    install({ row: { id: "r" }, reason: "fresh-cache" });
    preheatNextOnDrain("player-1", peekOf(["cur", "next"]), POS_IN_WINDOW, DUR_MS);
    await flush();
    expect(warmed).toEqual(["next"]);
  });

  it("无源(skip)不下推", async () => {
    install({ row: null, reason: "no-row" });
    preheatNextOnDrain("player-1", peekOf(["cur", "next"]), POS_IN_WINDOW, DUR_MS);
    await flush();
    expect(warmed).toHaveLength(0);
  });

  it("钩子抛错不外泄(不得冒到 tracker)", async () => {
    install({ row: { id: "r" }, reason: "local-probe-ok" });
    setDrainPreheatWarmHook(() => {
      throw new Error("hook boom");
    });
    expect(() =>
      preheatNextOnDrain("player-1", peekOf(["cur", "next"]), POS_IN_WINDOW, DUR_MS),
    ).not.toThrow();
    await flush();
  });

  it("注销后完全不触发", async () => {
    install({ row: { id: "r" }, reason: "local-probe-ok" });
    setDrainPreheatWarmHook(null);
    preheatNextOnDrain("player-1", peekOf(["cur", "next"]), POS_IN_WINDOW, DUR_MS);
    await flush();
    expect(warmed).toHaveLength(0);
  });
});
