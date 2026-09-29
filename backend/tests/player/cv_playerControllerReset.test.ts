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
    // 第一次上报落地(tracker 记住 PLAYING);第二次同 player 换 uri →
    // 去抖窗口内已形成 track_changed 决策(pending),定时器在路上。
    ctrl.reportState(st(PlaybackState.PLAYING, "u1"));
    vi.advanceTimersByTime(800); // 第一条落地(decision = none)
    ctrl.reportState(st(PlaybackState.PLAYING, "u2", 1)); // pending = track_changed
    expect(ctrl.getLatest("dlna:d1")).toBeDefined();

    ctrl.reset("dlna:d1");

    // 2) latest.delete
    expect(ctrl.getLatest("dlna:d1")).toBeUndefined();
    // 3) clearPending:决策与两层去抖定时器一并清 → 时间走完也不派发
    //    (若未清,track_changed 会在窗口到点后派发)
    vi.advanceTimersByTime(800);
    expect(onDecision).not.toHaveBeenCalled();
    // 1) tracker.reset:旧 lastPlaying/prev 已清 → 再来一条 IDLE 不判成结束
    //    (若未重置,IDLE 会带着旧 PLAYING 判出结束类决策并被派发)
    ctrl.reportState(st(PlaybackState.IDLE, "u2"));
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
