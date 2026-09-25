// QueueController 的「目标不可播 ⇒ 不起播、不推进、不计失败」硬限制测试。
//
// 锁死 2026-09-25 定稿:目标没有在线播放器时**不开始播放**(长久以来的既有行为)。
// 判据统一来自 playTarget.checkPlayTarget —— 本文件把它 mock 掉,只验证 QueueController
// 对判据的**反应**;判据本身的语义由 tests/services/playTarget.test.ts 钉死。
//
// 真机病灶(2026-09-25):音流把内容投进零成员群组后,playMedia 必抛「无在线成员」;
// 旧实现把它当普通 cast 失败 ⇒ castFailStreak++ 累加到 max(2, 2×曲数),且每一拍都交给
// handleDecision("stalled") 放行切歌 ⇒ **边失败边切歌**:6 分钟空转 787 次、
// 队列 idx 从 293 被推到 49(用户视感 = 疯狂切歌)。
//
// 两组对照,证明既没漏掉新护栏、也没把正常失败路径一起关掉:
//   ① 判据不可播  ⇒ 不起播(连 cast 都不发)、失败后不计数不切歌;
//   ② 判据可播    ⇒ 照常起播;cast 失败仍走既有 castFailStreak + stalled 通道。
import { describe, it, expect, beforeEach, vi } from "vitest";
import { QueueController } from "../../src/services/player/QueueController.js";
import { PlaybackState } from "../../src/services/player/types.js";

// 判据由本测试驱动:replies 是「按调用次序」的剧本,耗尽后沿用最后一次答复
// (这样既能造「起播前放行、cast 失败时已不可播」的竞态,也能造稳定不可播)。
type Reply = { playable: boolean; reason?: string };
const replies: Reply[] = [];
let last: Reply = { playable: true };
vi.mock("../../src/services/playTarget.js", () => ({
  checkPlayTarget: () => {
    if (replies.length > 0) last = replies.shift()!;
    return last;
  },
}));

const DEV = "g1";          // QueueController 的 key 是裸 id
const PID = "group:g1";    // player.playerId 带前缀

interface Harness {
  qc: QueueController;
  any: any;
  player: any;
  ctrl: any;
  played: string[];
  /** 剧本:按调用次序答复判据。 */
  setReplies(r: Reply[]): void;
  /** 让 cast 抛错(模拟"判据放行但投不出去")。 */
  setFailCast(v: boolean): void;
}

function makeQC(): Harness {
  const qc = new QueueController();
  const any = qc as any;
  const played: string[] = [];
  let failCast = false;
  const player = {
    playerId: PID,
    playMedia: vi.fn(async (item: any) => {
      if (failCast) throw new Error(`组 g1 无在线成员,无法播放`);
      played.push(item.songId);
      return { mediaUri: "u" };
    }),
    stop: vi.fn(async () => {}),
    pause: vi.fn(async () => {}),
    resume: vi.fn(async () => {}),
    seek: vi.fn(async () => {}),
    setVolume: vi.fn(async () => {}),
    pollState: vi.fn(async () => ({ playerId: PID, playbackState: PlaybackState.IDLE, position: 0, duration: 0, updatedAt: Date.now() })),
    getProtocol: () => ({ isAvailable: () => true }),
  };
  const ctrl = {
    beginOptimistic: vi.fn(),
    armOptimisticTimeout: vi.fn(),
    endOptimistic: vi.fn(),
    reportState: vi.fn(),
    resetTracker: vi.fn(),
    setExpectedDuration: vi.fn(),
  };
  any.players.set(DEV, player);
  any.ctrls.set(DEV, ctrl);
  any.queues.set(DEV, {
    items: [
      { songId: "s1", title: "t1", mime: "audio/mpeg", duration: 200 },
      { songId: "s2", title: "t2", mime: "audio/mpeg", duration: 200 },
    ],
    currentIndex: 0,
    playMode: "order",
    isActive: true,
    ended: false,
  });
  // 绕开判源 / 落库 / 预探测(与本文件要验证的护栏无关)。
  any.isMemberOfActiveGroup = () => false;
  any.judgePlayable = async () => "play";
  any.resolveItem = async (i: any) => i;
  any.persist = () => {};
  any.schedulePreProbe = () => {};
  return {
    qc, any, player, ctrl, played,
    setReplies: (r: Reply[]) => { replies.length = 0; replies.push(...r); last = { playable: true }; },
    setFailCast: (v: boolean) => { failCast = v; },
  };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

describe("QueueController 不可播目标护栏(没播放器在线就不开始播放)", () => {
  let h: Harness;

  beforeEach(() => {
    h = makeQC();
    h.setReplies([{ playable: false, reason: "组内没有在线成员" }]);
  });

  it("不可播:连 cast 都不发(不起播)", async () => {
    await h.any.playCurrent(DEV, "http://base");

    expect(h.player.playMedia).not.toHaveBeenCalled();
    expect(h.ctrl.beginOptimistic).not.toHaveBeenCalled();
    expect(h.played).toEqual([]);
  });

  it("不可播:cast 期间掉线(判据先放行后不可播)⇒ 不计数、不切歌", async () => {
    h.setReplies([
      { playable: true },                                  // 起播前:放行
      { playable: false, reason: "组内没有在线成员" },      // cast 失败后:已不可播
    ]);
    h.setFailCast(true);
    const handleDecision = vi.fn();
    h.any.handleDecision = handleDecision;

    await h.any.playCurrent(DEV, "http://base");
    await flush();

    // 只投了一次(没有自我续 loop),失败链被清空,且没有放行切歌。
    expect(h.player.playMedia).toHaveBeenCalledTimes(1);
    expect(h.any.castFailStreak.get(DEV)).toBeUndefined();
    expect(handleDecision).not.toHaveBeenCalled();
    // 乐观窗口必须被关掉(否则会留下 5s 兜底计时器)。
    expect(h.ctrl.endOptimistic).toHaveBeenCalledWith(PID);
  });

  it("不可播:重复调用也不会累积失败链(队列不空转)", async () => {
    h.setFailCast(true);
    for (let i = 0; i < 5; i++) await h.any.playCurrent(DEV, "http://base");
    await flush();

    expect(h.player.playMedia).not.toHaveBeenCalled();
    expect(h.any.castFailStreak.get(DEV)).toBeUndefined();
  });

  it("可播:照常起播(护栏不得误伤)", async () => {
    h.setReplies([{ playable: true }]);

    await h.any.playCurrent(DEV, "http://base");

    expect(h.player.playMedia).toHaveBeenCalledTimes(1);
    expect(h.played).toEqual(["s1"]);
    expect(h.ctrl.beginOptimistic).toHaveBeenCalledWith(PID, "pending");
  });

  it("可播 + cast 失败:仍走既有 castFailStreak + stalled 通道(负向对照)", async () => {
    h.setReplies([{ playable: true }]);
    h.setFailCast(true);
    const handleDecision = vi.fn();
    h.any.handleDecision = handleDecision;

    await h.any.playCurrent(DEV, "http://base");
    await flush();

    expect(h.any.castFailStreak.get(DEV)).toBe(1);
    // 失败分支传的是 player.playerId(带前缀),不是 QueueController 的裸 id。
    expect(handleDecision).toHaveBeenCalledWith("stalled", PID);
  });
});
