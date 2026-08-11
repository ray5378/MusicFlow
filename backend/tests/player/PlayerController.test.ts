import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { PlayerController } from "../../src/services/player/PlayerController.js";
import { PlaybackState, type PlayerState } from "../../src/services/player/types.js";

function st(state: PlaybackState, uri = "u1", pos = 0): PlayerState {
  return { playerId: "dlna:d1", playbackState: state, position: pos, duration: 100, mediaUri: uri, updatedAt: Date.now() };
}

describe("PlayerController", () => {
  let onDecision: ReturnType<typeof vi.fn>;
  let ctrl: PlayerController;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    onDecision = vi.fn();
    ctrl = new PlayerController();
    ctrl.onDecision = onDecision;
  });
  afterEach(() => { vi.useRealTimers(); });

  it("reportState 后 0.25s 去抖,再 0.5s 转发决策", () => {
    ctrl.reportState(st(PlaybackState.PLAYING));
    ctrl.reportState(st(PlaybackState.IDLE)); // 自然结束
    expect(onDecision).not.toHaveBeenCalled();
    vi.advanceTimersByTime(250); // 第一层去抖
    expect(onDecision).not.toHaveBeenCalled();
    vi.advanceTimersByTime(500); // 第二层去抖
    expect(onDecision).toHaveBeenCalledTimes(1);
    expect(onDecision.mock.calls[0][0]).toBe("advance");
  });

  it("乐观窗口期间忽略 IDLE 上报(屏蔽瞬态)", () => {
    ctrl.reportState(st(PlaybackState.PLAYING, "u1"));
    vi.advanceTimersByTime(800); // 让第一次上报落地
    ctrl.beginOptimistic("dlna:d1", "u2"); // 开始切歌
    // 设备短暂报 IDLE(瞬态)
    ctrl.reportState(st(PlaybackState.IDLE, "u2"));
    vi.advanceTimersByTime(800);
    expect(onDecision).not.toHaveBeenCalled(); // 乐观窗口屏蔽
    // 设备报 PLAYING(新 uri)
    ctrl.reportState(st(PlaybackState.PLAYING, "u2", 1));
    vi.advanceTimersByTime(800);
    expect(onDecision).toHaveBeenCalledWith("track_changed", "dlna:d1");
  });

  it("5s play 超时:乐观窗口超时后若仍 IDLE,触发 stalled", () => {
    ctrl.reportState(st(PlaybackState.PLAYING, "u1"));
    vi.advanceTimersByTime(800);
    ctrl.beginOptimistic("dlna:d1", "u2");
    ctrl.reportState(st(PlaybackState.IDLE, "u2"));
    vi.advanceTimersByTime(800); // 乐观窗口内,忽略
    expect(onDecision).not.toHaveBeenCalled();
    vi.advanceTimersByTime(5000); // 超出 5s play 超时
    expect(onDecision).toHaveBeenCalledWith("stalled", "dlna:d1");
  });
});
