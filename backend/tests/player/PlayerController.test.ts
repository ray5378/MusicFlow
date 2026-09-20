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
  afterEach(() => { ctrl?.stopOverrunTicker(); vi.useRealTimers(); });

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

  // ── PLAYING 期本地节拍(对照 MA _poll_players 0.5s 推送) ──
  // 设备采样是 5s 一次,若结束判定只挂在采样上,「位置到时长 + 8s 宽限」会被
  // 采样粒度拖成 ~10s。下面三条都刻意**不再喂任何设备上报**。
  it("本地节拍推进结束判定: 不再有设备上报也能在宽限后派发 advance", () => {
    ctrl.startOverrunTicker();
    ctrl.setExpectedDuration("dlna:d1", 100);
    ctrl.reportState(st(PlaybackState.PLAYING, "u1", 100)); // 设备不报结束,位置恒等于时长
    vi.advanceTimersByTime(1000); // 让这次上报自己的去抖窗口落地(它只能给出 none)
    expect(onDecision).not.toHaveBeenCalled();
    vi.advanceTimersByTime(8000);
    expect(onDecision).toHaveBeenCalledWith("advance", "dlna:d1");
  });

  it("本地节拍派发的决策不被随后到场的设备采样覆盖,也不重复", () => {
    ctrl.startOverrunTicker();
    ctrl.setExpectedDuration("dlna:d1", 100);
    ctrl.reportState(st(PlaybackState.PLAYING, "u1", 100));
    vi.advanceTimersByTime(8500);
    expect(onDecision).toHaveBeenCalledTimes(1);
    ctrl.reportState(st(PlaybackState.PLAYING, "u1", 100)); // 设备仍报"到顶"
    vi.advanceTimersByTime(1000);
    expect(onDecision).toHaveBeenCalledTimes(1);
  });

  it("暂停中本地节拍不误判结束", () => {
    ctrl.startOverrunTicker();
    ctrl.setExpectedDuration("dlna:d1", 100);
    ctrl.reportState(st(PlaybackState.PLAYING, "u1", 100));
    vi.advanceTimersByTime(1000);
    ctrl.reportState(st(PlaybackState.PAUSED, "u1", 100));
    vi.advanceTimersByTime(30000);
    expect(onDecision).not.toHaveBeenCalled();
  });
});
