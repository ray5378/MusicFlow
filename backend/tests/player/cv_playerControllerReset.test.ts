// PlayerController.reset(切播端销毁/搬走的四步收口)覆盖(cv_ 前缀)。
//
// 目标行:src/services/player/PlayerController.ts 177-182
//   reset(playerId) 必须同时做四件事:
//     1) trackerOf(playerId).reset()   —— 清 prev/lastPlaying(旧迁移状态)
//     2) latest.delete(playerId)       —— 清最新快照
//     3) clearPending(playerId)        —— 清未派发决策 + 两层去抖定时器
//     4) clearOptimistic(playerId)     —— 关乐观窗口
//   手法照抄 PlayerController.test.ts:fake timers + 受控 PlayerState 上报,
//   每一步都用「若无此步、可观测行为会如何不同」的判据断言。
//
// F3(v4.10.0)语义注记:advance/track_changed/ended 三个决策走快路径【同步派发】,
// reset 拦不住也不需要拦(它们不存在「窗口到点后迟到派发」);仍可能被 reset 拦下的
// 只有慢路径决策(idle_early 等)。clearPending 用慢路径决策验证。
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { PlayerController } from "../../src/services/player/PlayerController.js";
import { PlaybackState, type PlayerState } from "../../src/services/player/types.js";

function st(state: PlaybackState, uri = "u1", pos = 0): PlayerState {
  return { playerId: "dlna:d1", playbackState: state, position: pos, duration: 100, mediaUri: uri, updatedAt: Date.now() };
}

describe("PlayerController.reset(四步收口)", () => {
  let onDecision: ReturnType<typeof vi.fn>;
  let ctrl: PlayerController;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    onDecision = vi.fn();
    ctrl = new PlayerController();
    ctrl.onDecision = onDecision;
  });
  afterEach(() => {
    ctrl?.stopOverrunTicker();
    vi.useRealTimers();
  });

  it("reset 清 latest + pending/去抖定时器 + tracker 旧迁移状态", () => {
    // 第一条落地(tracker 记住 PLAYING;decision = none)
    ctrl.reportState(st(PlaybackState.PLAYING, "u1"));
    vi.advanceTimersByTime(800);
    // 构造【慢路径】挂起决策:注入 knownDuration 让 IDLE 时位置远未到时长 → idle_early,
    // 落在两层去抖窗口内、尚未派发(F3 后 track_changed 等快路径会同步派发,不能用来测)。
    ctrl.setExpectedDuration("dlna:d1", 100);
    ctrl.reportState(st(PlaybackState.PLAYING, "u1", 10));
    ctrl.reportState(st(PlaybackState.IDLE, "u1", 5)); // pos=max(5,10)=10 < 100-10 ⇒ idle_early
    expect(onDecision).not.toHaveBeenCalled();
    expect(ctrl.getLatest("dlna:d1")).toBeDefined();

    ctrl.reset("dlna:d1");

    // 2) latest.delete
    expect(ctrl.getLatest("dlna:d1")).toBeUndefined();
    // 3) clearPending:决策与两层去抖定时器一并清 → 时间走完也不派发
    //    (若未清,idle_early 会在窗口到点后派发)
    vi.advanceTimersByTime(800);
    expect(onDecision).not.toHaveBeenCalled();
    // 1) tracker.reset:重建 PLAYING 前态再收口一次,随后 IDLE 不得判成结束类决策
    //    (若未重置,IDLE 会带着旧 PLAYING 迁移状态判出决策并被派发)
    ctrl.reportState(st(PlaybackState.PLAYING, "u1", 1));
    vi.advanceTimersByTime(800); // 落地(tracker prev = PLAYING)
    ctrl.reset("dlna:d1");
    ctrl.reportState(st(PlaybackState.IDLE, "u1", 1));
    vi.advanceTimersByTime(800);
    expect(onDecision).not.toHaveBeenCalled();
  });

  it("reset 关闭乐观窗口:armOptimisticTimeout 变 no-op,5s 后不判 stalled", () => {
    ctrl.reportState(st(PlaybackState.PLAYING, "u1"));
    vi.advanceTimersByTime(800);
    ctrl.beginOptimistic("dlna:d1", "u2"); // 窗口开
    ctrl.reset("dlna:d1"); // 第 4 步:clearOptimistic
    // 窗口已被 reset 关掉 → arm 不得再起计时(若窗口还在,5s 后必派发 stalled)
    ctrl.armOptimisticTimeout("dlna:d1");
    vi.advanceTimersByTime(6000);
    expect(onDecision).not.toHaveBeenCalled();
  });
});
