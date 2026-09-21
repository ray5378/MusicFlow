// ==================== 链路不可用 / 位置冻结 的决策护栏 ====================
//
// 锁死 QueueController 里三条 2026-09-21 新增的行为:
//   ① `playbackState.unavailable` 的读数**不得**喂给 tracker,也不得据它切歌;
//   ② 链路丢失期间 stalled / idle_early 一律不动手(不重投、不切歌、不计数);
//   ③ 链路恢复后**续播当前首并把位置拉回**(而不是从头播 / 切下一首)。
//
// 真机病灶:fork 模式 sendspin 子进程事件循环停摆 95s,期间主进程对它的每个 RPC
// 都 25s 超时。旧实现把这批超时读成"设备报 IDLE",于是凭空造出 PLAYING→IDLE 迁移
// → advance 切歌;stalled 通道还会把它计进"连续卡死",第 2 次直接放行切歌。
// 用户看到 = 进度条归零 + 曲目乱跳。
import { describe, it, expect, beforeEach, vi } from "vitest";
import { QueueController } from "../../src/services/player/QueueController.js";
import { PlaybackState } from "../../src/services/player/types.js";
import { markSeekIssued, clearSeekSettle } from "../../src/services/player/seekSettle.js";

const DEV = "dev1";
const PID = "sendspin:dev1";

interface Harness {
  qc: QueueController;
  any: any;
  player: any;
  ctrl: any;
  played: string[];
  seeks: number[];
  /** 控制 ProtocolPlayer.isAvailable(设备是否真的在线)。 */
  setAvailable(v: boolean): void;
}

function makeQC(): Harness {
  const qc = new QueueController();
  const any = qc as any;
  const played: string[] = [];
  const seeks: number[] = [];
  let available = true;
  const player = {
    playerId: PID,
    playMedia: vi.fn(async (item: any) => { played.push(item.songId); return { mediaUri: "u" }; }),
    stop: vi.fn(async () => {}),
    pause: vi.fn(async () => {}),
    resume: vi.fn(async () => {}),
    seek: vi.fn(async (s: number) => { seeks.push(s); }),
    setVolume: vi.fn(async () => {}),
    pollState: vi.fn(async () => ({ playerId: PID, playbackState: PlaybackState.IDLE, position: 0, duration: 0, updatedAt: Date.now() })),
    getProtocol: () => ({ isAvailable: () => available }),
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
  // 绕开判源 / 落库 / 预探测(与本文件要验证的决策护栏无关)
  any.isMemberOfActiveGroup = () => false;
  any.judgePlayable = async () => "play";
  any.resolveItem = async (i: any) => i;
  any.persist = () => {};
  any.schedulePreProbe = () => {};
  return { qc, any, player, ctrl, played, seeks, setAvailable: (v: boolean) => { available = v; } };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

describe("QueueController 链路不可用护栏", () => {
  let h: Harness;
  beforeEach(() => {
    clearSeekSettle(DEV); // seek 冷静期是模块级状态,用例间必须清
    h = makeQC();
  });

  it("poll 读到 unavailable → 不喂 tracker,只登记链路丢失", async () => {
    h.player.pollState.mockResolvedValue({
      playerId: PID, playbackState: PlaybackState.IDLE, position: 0, duration: 0,
      updatedAt: Date.now(), unavailable: true,
    });
    await h.any.pollAllDevices(() => "http://x");
    expect(h.ctrl.reportState).not.toHaveBeenCalled(); // 关键:伪造的 IDLE 不得进 tracker
    expect(h.any.linkLost.has(DEV)).toBe(true);
  });

  it("poll 正常 → 正常上报并记录最后位置", async () => {
    h.player.pollState.mockResolvedValue({
      playerId: PID, playbackState: PlaybackState.PLAYING, position: 42, duration: 200,
      updatedAt: Date.now(),
    });
    await h.any.pollAllDevices(() => "http://x");
    expect(h.ctrl.reportState).toHaveBeenCalledTimes(1);
    expect(h.any.lastPos.get(DEV)).toBe(42);
  });

  it("stalled + 链路不可用 → 不重投、不切歌、不计数", async () => {
    h.any.lastPos.set(DEV, 120);
    h.player.pollState.mockResolvedValue({
      playerId: PID, playbackState: PlaybackState.IDLE, position: 0, duration: 0,
      updatedAt: Date.now(), unavailable: true,
    });
    await h.qc.handleDecision("stalled", PID);
    expect(h.played).toEqual([]);                                  // 没重投
    expect(h.any.queues.get(DEV).currentIndex).toBe(0);            // 没切歌
    expect(h.any.stallCounters.has(DEV)).toBe(false);              // 没计数
    expect(h.any.linkLost.get(DEV)?.pos).toBe(120);                // 记住了续播位置
  });

  it("idle_early + 链路不可用 → 不放行切歌", async () => {
    h.player.pollState.mockResolvedValue({
      playerId: PID, playbackState: PlaybackState.IDLE, position: 0, duration: 0,
      updatedAt: Date.now(), unavailable: true,
    });
    await h.qc.handleDecision("idle_early", PID);
    expect(h.any.queues.get(DEV).currentIndex).toBe(0);
    expect(h.played).toEqual([]);
    expect(h.any.linkLost.has(DEV)).toBe(true);
  });

  it("链路恢复 → 续播当前首并把位置拉回(不切歌、不归零)", async () => {
    h.any.lastPos.set(DEV, 120);
    h.any.linkLost.set(DEV, { pos: 120, at: Date.now(), reason: "test" });
    // 恢复后第一次成功 poll:设备已停(没 pump)→ 应触发续播
    h.player.pollState.mockResolvedValue({
      playerId: PID, playbackState: PlaybackState.IDLE, position: 0, duration: 0,
      updatedAt: Date.now(),
    });
    await h.any.pollAllDevices(() => "http://x");
    await flush();
    expect(h.played).toEqual(["s1"]);          // 重投的是**当前**这首
    expect(h.any.queues.get(DEV).currentIndex).toBe(0);
    expect(h.seeks).toEqual([119]);            // 位置拉回 120(减 1s 抵消 cast 开销)
    expect(h.any.linkLost.has(DEV)).toBe(false);
  });

  it("链路恢复但已在播 → 不打断", async () => {
    h.any.linkLost.set(DEV, { pos: 120, at: Date.now(), reason: "test" });
    h.player.pollState.mockResolvedValue({
      playerId: PID, playbackState: PlaybackState.PLAYING, position: 121, duration: 200,
      updatedAt: Date.now(),
    });
    await h.any.pollAllDevices(() => "http://x");
    await flush();
    expect(h.played).toEqual([]);
  });
});

describe("QueueController 位置冻结(frozen)处理", () => {
  let h: Harness;
  beforeEach(() => {
    clearSeekSettle(DEV); // seek 冷静期是模块级状态,用例间必须清(否则上一条的 seek 会压住下一条)
    h = makeQC();
    h.any.lastPos.set(DEV, 173.6);
    // 冻结现场:状态 PLAYING、位置纹丝不动
    h.player.pollState.mockResolvedValue({
      playerId: PID, playbackState: PlaybackState.PLAYING, position: 173.6, duration: 280,
      updatedAt: Date.now(),
    });
  });

  it("frozen → 就地重投当前首 + 拉回位置,绝不切歌", async () => {
    await h.qc.handleDecision("frozen", PID);
    expect(h.played).toEqual(["s1"]);        // 还是当前这首
    expect(h.any.queues.get(DEV).currentIndex).toBe(0);
    expect(h.seeks).toEqual([172.6]);        // 拉到冻结点(减 1s)
  });

  it("frozen 复查发现位置已推进 → 误报,撤销且不重投", async () => {
    h.player.pollState.mockResolvedValue({
      playerId: PID, playbackState: PlaybackState.PLAYING, position: 190, duration: 280,
      updatedAt: Date.now(),
    });
    await h.qc.handleDecision("frozen", PID);
    expect(h.played).toEqual([]);
    expect(h.ctrl.resetTracker).toHaveBeenCalled();
  });

  it("frozen 落在 seek 冷静期内 → 判为重定位真空,撤销", async () => {
    markSeekIssued(DEV);
    await h.qc.handleDecision("frozen", PID);
    expect(h.played).toEqual([]);
    expect(h.ctrl.resetTracker).toHaveBeenCalled();
  });

  it("frozen 但链路本身已丢 → 交给恢复路径,不叠一次重投", async () => {
    h.any.linkLost.set(DEV, { pos: 173.6, at: Date.now(), reason: "test" });
    await h.qc.handleDecision("frozen", PID);
    expect(h.played).toEqual([]);
  });

  it("frozen 重投 1 次仍不动 → 第 2 次放行切歌(与 stalled 同一套上限)", async () => {
    await h.qc.handleDecision("frozen", PID);   // 第 1 次:重投当前首
    expect(h.played).toEqual(["s1"]);
    // 真实间隔:第 2 次判定发生在 ≥30s 后,早已出了 8s seek 冷静期 → 这里显式对齐
    clearSeekSettle(DEV);
    await h.qc.handleDecision("frozen", PID);   // 第 2 次:判定这首推不动
    expect(h.played).toEqual(["s1", "s2"]);
    expect(h.any.queues.get(DEV).currentIndex).toBe(1);
  });

  it("队列已结束 / 未激活 → frozen 不做任何事", async () => {
    h.any.queues.get(DEV).ended = true;
    await h.qc.handleDecision("frozen", PID);
    expect(h.played).toEqual([]);
    expect(h.seeks).toEqual([]);
  });
});
