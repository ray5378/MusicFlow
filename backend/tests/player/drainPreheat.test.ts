// ==================== 曲末提前预解析下一首（C 方案）单测 ====================
//
// 锁住四条红线（见 src/services/player/drainPreheat.ts 文件头）：
//   1. 只在「位置 ≥ 时长 − 9000ms」窗口内触发；
//   2. 幂等：同一 (player, 下一曲) 只预热一次（否则 500ms 节拍会每拍抢一次 IO）；
//   3. 换歌 / reset 后能对新歌再来一次；
//   4. 拿不到下一首（队列末尾 / 无队列）不触发、不抛；预热抛错被吞掉，不冒泡到 tracker。
//
// 另锁 PlaybackTracker 侧的接线语义：钩子是**纯通知**，抛错不得影响 update()/tick()
// 的判定结果（那是播放正确性的根，为省 2 秒而让切歌判定失效是本末倒置）。
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  DRAIN_PREHEAT_LEAD_MS,
  preheatNextOnDrain,
  peekNextSongId,
  resetDrainPreheat,
  resetDrainPreheatForTest,
  setDrainPreheatExecutorForTest,
  drainPreheatMarksForTest,
  type DrainPreheatResolveResult,
} from "../../src/services/player/drainPreheat.js";
import { PlaybackTracker } from "../../src/services/player/PlaybackTracker.js";
import {
  PlaybackState,
  toCompareState,
  type PlayerState,
  type PlayMode,
} from "../../src/services/player/types.js";
import type { QueuePeekSource } from "../../src/services/player/preProbeScheduler.js";

/** 本曲已知时长（ms）—— 取实测那首的 250s，窗口下沿 = 250000 − 9000 = 241000。 */
const DUR_MS = 250_000;
const THRESHOLD_MS = DUR_MS - DRAIN_PREHEAT_LEAD_MS;

/** 队列只读视图（`QueueData` 结构性满足 QueuePeekSource）。 */
function peekOf(songIds: string[], currentIndex: number, playMode: PlayMode = "order"): QueuePeekSource {
  return { items: songIds.map((songId) => ({ songId })), currentIndex, playMode };
}

/** 预热是 fire-and-forget：等微任务与一个宏任务跑完再断言。 */
async function flush(): Promise<void> {
  for (let i = 0; i < 5; i++) await Promise.resolve();
  await new Promise((r) => setTimeout(r, 0));
}

/** 记录真实执行过预热的 songId。 */
const calls: string[] = [];

function installSpy(
  result: DrainPreheatResolveResult = { row: { id: "resolved" }, reason: "local-probe-ok" },
): void {
  calls.length = 0;
  setDrainPreheatExecutorForTest(async (songId: string) => {
    calls.push(songId);
    return result;
  });
}

beforeEach(() => {
  resetDrainPreheatForTest();
  calls.length = 0;
});

afterEach(() => {
  resetDrainPreheatForTest();
});

describe("drainPreheat:窗口与幂等", () => {
  it("pos 未到 dur − 9000 不触发；到达下沿才触发", async () => {
    installSpy();
    const peek = peekOf(["a", "b"], 0);

    preheatNextOnDrain("dev1", peek, THRESHOLD_MS - 1, DUR_MS);
    await flush();
    expect(calls).toEqual([]);
    expect(drainPreheatMarksForTest()).toEqual([]);

    preheatNextOnDrain("dev1", peek, THRESHOLD_MS, DUR_MS);
    await flush();
    expect(calls).toEqual(["b"]);
  });

  it("进入窗口后同一首反复 tick 只真跑一次（幂等，不能每 500ms 抢一次 IO）", async () => {
    installSpy();
    const peek = peekOf(["a", "b"], 0);

    for (let i = 0; i < 20; i++) {
      preheatNextOnDrain("dev1", peek, THRESHOLD_MS + i * 500, DUR_MS);
    }
    await flush();
    expect(calls).toEqual(["b"]);
    expect(drainPreheatMarksForTest()).toEqual([["dev1", "b"]]);
  });

  it("位置外推越过时长（pos > dur）仍算在窗口内，不会因越界漏掉预热", async () => {
    installSpy();
    preheatNextOnDrain("dev1", peekOf(["a", "b"], 0), DUR_MS + 3_000, DUR_MS);
    await flush();
    expect(calls).toEqual(["b"]);
  });

  it("时长未知（durMs <= 0）不触发：没有「曲末」可算", async () => {
    installSpy();
    preheatNextOnDrain("dev1", peekOf(["a", "b"], 0), 100_000, 0);
    await flush();
    expect(calls).toEqual([]);
  });

  it("不同 player 各自独立记账（同一首在两个设备上都要预热）", async () => {
    installSpy();
    const peek = peekOf(["a", "b"], 0);
    preheatNextOnDrain("dev1", peek, THRESHOLD_MS, DUR_MS);
    preheatNextOnDrain("dev2", peek, THRESHOLD_MS, DUR_MS);
    await flush();
    expect(calls).toEqual(["b", "b"]);
  });
});

describe("drainPreheat:切歌与清理", () => {
  it("切到新歌后能为新歌的下一首再次触发", async () => {
    installSpy();
    const queue = ["a", "b", "c"];

    preheatNextOnDrain("dev1", peekOf(queue, 0), THRESHOLD_MS, DUR_MS); // 下一首 = b
    await flush();
    preheatNextOnDrain("dev1", peekOf(queue, 1), THRESHOLD_MS, DUR_MS); // 下一首 = c
    await flush();

    expect(calls).toEqual(["b", "c"]);
  });

  it("resetDrainPreheat（切歌/seek 调用）后同一首还能再预热一次", async () => {
    installSpy();
    const peek = peekOf(["a", "b"], 0);

    preheatNextOnDrain("dev1", peek, THRESHOLD_MS, DUR_MS);
    await flush();
    expect(calls).toEqual(["b"]);

    resetDrainPreheat("dev1");
    preheatNextOnDrain("dev1", peek, THRESHOLD_MS, DUR_MS);
    await flush();
    expect(calls).toEqual(["b", "b"]);
  });

  it("单曲循环（playMode=one）下「下一首」是自己：已预热过就不再重复", async () => {
    installSpy();
    const peek = peekOf(["a"], 0, "one");
    preheatNextOnDrain("dev1", peek, THRESHOLD_MS, DUR_MS);
    await flush();
    preheatNextOnDrain("dev1", peek, THRESHOLD_MS + 500, DUR_MS);
    await flush();
    expect(calls).toEqual(["a"]);
  });
});

describe("drainPreheat:拿不到下一首 / 异常", () => {
  it("队列末尾（order 模式无后续）不触发、不抛", async () => {
    installSpy();
    expect(() => preheatNextOnDrain("dev1", peekOf(["a", "b"], 1), THRESHOLD_MS, DUR_MS)).not.toThrow();
    await flush();
    expect(calls).toEqual([]);
    expect(drainPreheatMarksForTest()).toEqual([]);
  });

  it("没有队列（peek=undefined / 空队列）不触发、不抛", async () => {
    installSpy();
    expect(() => preheatNextOnDrain("dev1", undefined, THRESHOLD_MS, DUR_MS)).not.toThrow();
    expect(() => preheatNextOnDrain("dev1", peekOf([], -1), THRESHOLD_MS, DUR_MS)).not.toThrow();
    expect(() => preheatNextOnDrain("", peekOf(["a", "b"], 0), THRESHOLD_MS, DUR_MS)).not.toThrow();
    await flush();
    expect(calls).toEqual([]);
  });

  it("预热执行抛错被吞掉（不冒泡），且幂等标记照旧落地 —— 不重试风暴", async () => {
    calls.length = 0;
    setDrainPreheatExecutorForTest(async (songId: string) => {
      calls.push(songId);
      throw new Error("resolve boom");
    });
    const peek = peekOf(["a", "b"], 0);

    expect(() => preheatNextOnDrain("dev1", peek, THRESHOLD_MS, DUR_MS)).not.toThrow();
    await flush();
    // 再 tick 三次：失败过一次也不再重跑
    preheatNextOnDrain("dev1", peek, THRESHOLD_MS + 500, DUR_MS);
    preheatNextOnDrain("dev1", peek, THRESHOLD_MS + 1_000, DUR_MS);
    await flush();

    expect(calls).toEqual(["b"]);
    expect(drainPreheatMarksForTest()).toEqual([["dev1", "b"]]);
  });

  it("resolve 判无源（row=null）不抛、不写任何状态，标记仍落地", async () => {
    installSpy({ row: null, reason: "all-failed" });
    expect(() => preheatNextOnDrain("dev1", peekOf(["a", "b"], 0), THRESHOLD_MS, DUR_MS)).not.toThrow();
    await flush();
    expect(calls).toEqual(["b"]);
    expect(drainPreheatMarksForTest()).toEqual([["dev1", "b"]]);
  });
});

describe("peekNextSongId:四种 playMode 全覆盖（复用 peekUpcomingPositions，不自己重写）", () => {
  it("order / all / one / shuffle", () => {
    expect(peekNextSongId(peekOf(["a", "b", "c"], 0, "order"))).toBe("b");
    // all：走到末尾回绕到队首
    expect(peekNextSongId(peekOf(["a", "b", "c"], 2, "all"))).toBe("a");
    // one：下一首永远是当前曲
    expect(peekNextSongId(peekOf(["a", "b"], 1, "one"))).toBe("b");
    // shuffle：沿洗牌序前进（shuffleOrder 缺失 ⇒ 触底，无下一首）
    expect(peekNextSongId({ items: [{ songId: "a" }, { songId: "b" }], currentIndex: 0, playMode: "shuffle" }))
      .toBeUndefined();
    expect(
      peekNextSongId({
        items: [{ songId: "a" }, { songId: "b" }],
        currentIndex: 0,
        playMode: "shuffle",
        shuffleOrder: [0, 1],
        shufflePos: 0,
      }),
    ).toBe("b");
  });
});

describe("PlaybackTracker.onPositionAdvance:纯通知接线", () => {
  function st(state: PlaybackState, uri = "u1", pos = 0, dur = 100): PlayerState {
    return {
      playerId: "dlna:d1",
      playbackState: state,
      position: pos,
      duration: dur,
      mediaUri: uri,
      updatedAt: Date.now(),
    };
  }

  it("update() 在 PLAYING 且时长已知时回调 (位置, 时长)", () => {
    const t = new PlaybackTracker();
    const seen: Array<[number, number]> = [];
    t.onPositionAdvance = (p, d) => seen.push([p, d]);
    t.setExpectedDuration(250);
    t.update(toCompareState(st(PlaybackState.PLAYING, "u1", 240)));
    expect(seen).toEqual([[240, 250]]);
  });

  it("tick() 用外推位置回调（不报位置的设备只有这条会推进）", () => {
    const t = new PlaybackTracker();
    const now = Date.now();
    t.update(toCompareState(st(PlaybackState.PLAYING, "u1", 240)));
    const seen: Array<[number, number]> = [];
    t.onPositionAdvance = (p, d) => seen.push([p, d]);
    t.setExpectedDuration(250);
    t.tick(now + 1_000);
    expect(seen).toHaveLength(1);
    expect(seen[0][1]).toBe(250);
    // 外推位置 = 末次上报位置 + 墙钟流逝（st() 的 updatedAt 与 now 之间有几毫秒抖动，
    // 故用区间断言而不是精确相等）。
    expect(seen[0][0]).toBeGreaterThanOrEqual(241);
    expect(seen[0][0]).toBeLessThan(242);
  });

  it("时长未知（0）不回调：没有「曲末」可算", () => {
    const t = new PlaybackTracker();
    const seen: Array<[number, number]> = [];
    t.onPositionAdvance = (p, d) => seen.push([p, d]);
    t.setExpectedDuration(0);
    t.update(toCompareState(st(PlaybackState.PLAYING, "u1", 240)));
    expect(seen).toEqual([]);
  });

  it("钩子抛错绝不影响结束判定（update / tick 的返回值与无钩子时逐字一致）", () => {
    const boom = () => {
      throw new Error("hook boom");
    };

    const withHook = new PlaybackTracker();
    withHook.onPositionAdvance = boom;
    withHook.setExpectedDuration(100);
    expect(() => withHook.update(toCompareState(st(PlaybackState.PLAYING, "u1", 95)))).not.toThrow();
    expect(withHook.update(toCompareState(st(PlaybackState.IDLE, "u1", 100)))).toBe("advance");

    const withTick = new PlaybackTracker();
    withTick.onPositionAdvance = boom;
    withTick.setExpectedDuration(100);
    withTick.update(toCompareState(st(PlaybackState.PLAYING, "u1", 100)));
    const nowT = Date.now();
    expect(() => withTick.tick(nowT)).not.toThrow();
    // 位置已到时长 + 过宽限 ⇒ 照旧 advance
    expect(withTick.tick(nowT + 9_000)).toBe("advance");
  });
});
