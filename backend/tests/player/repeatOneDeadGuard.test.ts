// ==================== 单曲循环防死循环守卫（2026-10-27 240 事故） ====================
//
// 事故：`playMode="one"` 的 `pickNext` 恒返回 currentIndex。一首被判死的曲（30s 截断 / 无源）
// 在 auto-advance / judgePlayable 判跳后**又回到自己**，用户听到的是「歌每 30 秒重播一次」。
//
// 修法（本文件锁住的契约）：
//   ① 同一 songId 连续被判死 2 次 ⇒ 单曲循环下**不再重播它**，改播下一首；
//   ② 「成功播放 ≥30s 且当前没被判死」⇒ 计数清零（偶发一次失败的好歌不该被放逐）；
//      30s 截断的坏歌**恰好也能播到 30s**，所以清零必须叠加「没被判死」这个条件；
//   ③ 单曲队列（只有这一首）⇒ 无下一首，停止推进并 warn；
//   ④ 非 repeat-one 模式行为**完全不变**（顺序模式下判死照旧跳过、不计数）。
//
// 本文件只测队列决策：players/ctrls/persist/emit/probe 全部就地替身，不 cast、不碰设备。
import "../plugins/_env.js";

import { describe, it, expect, vi, beforeEach } from "vitest";

/** 被判死的曲目（等价于 streamFallback 的负缓存内容）。 */
const dead = vi.hoisted(() => new Set<string>());
vi.mock("../../src/services/source/online/streamFallback.js", async (importOriginal) => {
  const actual = await importOriginal<any>();
  return {
    ...actual,
    getCachedPlayability: (songId: string) => (dead.has(songId) ? "unplayable" : "unknown"),
    markUnplayable: (songId: string) => {
      dead.add(songId);
    },
  };
});

import { QueueController } from "../../src/services/player/QueueController.js";

beforeEach(() => {
  dead.clear();
});

interface Harness {
  qc: any;
  q: any;
  /** playCurrent 实际被要求播的 index 序列。 */
  played: number[];
  /** reportAllUnplayable（= 停止推进）被调次数。 */
  stopped: () => number;
}

function setupQC(songIds: string[], playMode: string): Harness {
  const qc: any = new QueueController();
  const q: any = {
    items: songIds.map((s) => ({ songId: s, title: s })),
    currentIndex: 0,
    playMode,
    isActive: true,
    ended: false,
  };
  qc.queues.set("d1", q);
  const played: number[] = [];
  // playCurrent 是唯一"真的会去 cast"的地方：替身只记录落点，顺带验证 judgePlayable 未被调用。
  qc.playCurrent = async () => {
    played.push(q.currentIndex);
  };
  qc.persist = () => {};
  qc.emit = () => {};
  qc.snapshot = () => ({});
  qc.schedulePreProbe = () => {};
  qc.schedulePrefetch = () => {};
  let stopped = 0;
  qc.reportAllUnplayable = () => {
    stopped++;
  };
  return { qc, q, played, stopped: () => stopped };
}

const advance = (h: Harness) => h.qc.handleDecision("advance", "sendspin:d1");

describe("单曲循环：同一首连判死 2 次 ⇒ 跳下一首", () => {
  it("第 1 次判死仍给一次重播；第 2 次判死改播下一首", async () => {
    const h = setupQC(["a", "b", "c"], "one");
    dead.add("a"); // streamEngine 已写负缓存（30s 截断）

    await advance(h);
    expect(h.played).toEqual([0]); // 第 1 次：重播 a（上游偶发截断会自愈）
    expect(h.q.currentIndex).toBe(0);

    await advance(h);
    expect(h.played).toEqual([0, 1]); // 第 2 次：不再重播 a，改播 b
    expect(h.q.currentIndex).toBe(1);
    expect(h.stopped()).toBe(0);
  });

  it("单曲队列（只有这一首）⇒ 无下一首：停止推进并 warn，不再重播", async () => {
    const h = setupQC(["only"], "one");
    dead.add("only");
    h.qc.repeatDeadStrikes.set("only", 1); // 已判死过一次

    await advance(h);
    expect(h.played).toEqual([]); // 不再重播
    expect(h.stopped()).toBe(1); // 走「整队无源」停止路径（保留队列，等源恢复）
  });
});

describe("计数清零：成功播放 ≥30s", () => {
  it("播够 30s 且未被判死 ⇒ 计数清零（偶发失败不被累积成放逐）", async () => {
    const h = setupQC(["a", "b"], "one");
    h.qc.repeatDeadStrikes.set("a", 1);
    h.qc.lastPos.set("d1", 31_000); // 设备上报播放到 31s，且负缓存已不在（源恢复）

    await advance(h);
    expect(h.qc.repeatDeadStrikes.has("a")).toBe(false); // 清零
    expect(h.played).toEqual([0]); // 正常重播
  });

  it("播到 30s 但**仍被判死**（30s 截断）⇒ 不清零，计数继续累积到放逐", async () => {
    const h = setupQC(["a", "b"], "one");
    dead.add("a");
    h.qc.repeatDeadStrikes.set("a", 1);
    h.qc.lastPos.set("d1", 30_000); // 截断曲目恰好也播到 30s

    await advance(h);
    expect(h.qc.repeatDeadStrikes.get("a")).toBe(2); // 第 2 次判死
    expect(h.played).toEqual([1]); // 直接改播 b（不再重播 a）
  });
});

describe("非 repeat-one 模式行为不变", () => {
  it("order 模式：判死不计数，pickNext 照旧前进", async () => {
    const h = setupQC(["a", "b", "c"], "order");
    dead.add("a");

    await advance(h);
    expect(h.played).toEqual([1]);
    expect(h.qc.repeatDeadStrikes.size).toBe(0);
  });

  it("one 模式但曲目没被判死：正常重播，不计数", async () => {
    const h = setupQC(["a", "b"], "one");

    await advance(h);
    await advance(h);
    expect(h.played).toEqual([0, 0]); // 单曲循环语义不变
    expect(h.qc.repeatDeadStrikes.size).toBe(0);
  });
});
