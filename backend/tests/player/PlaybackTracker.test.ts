import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { PlaybackTracker } from "../../src/services/player/PlaybackTracker.js";
import { PlaybackState, toCompareState, type PlayerState } from "../../src/services/player/types.js";

function st(state: PlaybackState, uri = "u1", pos = 0, dur = 100): PlayerState {
  return { playerId: "dlna:d1", playbackState: state, position: pos, duration: dur, mediaUri: uri, updatedAt: Date.now() };
}

describe("PlaybackTracker", () => {
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date("2026-01-01T00:00:00Z")); });
  afterEach(() => { vi.useRealTimers(); });

  it("PLAYING→IDLE 有下一首: 返回 advance", () => {
    const t = new PlaybackTracker();
    t.update(toCompareState(st(PlaybackState.PLAYING)));
    const r = t.update(toCompareState(st(PlaybackState.IDLE)));
    expect(r).toBe("advance");
  });

  it("PLAYING→IDLE 无下一首: 返回 ended", () => {
    const t = new PlaybackTracker();
    t.update(toCompareState(st(PlaybackState.PLAYING)));
    const r = t.update(toCompareState(st(PlaybackState.IDLE)), false);
    expect(r).toBe("ended");
  });

  it("PLAYING(旧uri)→PLAYING(新uri): 返回 track_changed(native gapless)", () => {
    const t = new PlaybackTracker();
    t.update(toCompareState(st(PlaybackState.PLAYING, "u1")));
    const r = t.update(toCompareState(st(PlaybackState.PLAYING, "u2")));
    expect(r).toBe("track_changed");
  });

  it("IDLE 持续超过 60s: 返回 stalled(卡死兜底)", () => {
    const t = new PlaybackTracker();
    t.update(toCompareState(st(PlaybackState.IDLE)));
    vi.advanceTimersByTime(61_000);
    const r = t.update(toCompareState(st(PlaybackState.IDLE)));
    expect(r).toBe("stalled");
  });

  it("IDLE 未超 60s: 返回 none(等待设备恢复)", () => {
    const t = new PlaybackTracker();
    t.update(toCompareState(st(PlaybackState.IDLE)));
    vi.advanceTimersByTime(10_000);
    const r = t.update(toCompareState(st(PlaybackState.IDLE)));
    expect(r).toBe("none");
  });

  it("首次 update: 返回 none(仅 seed 状态)", () => {
    const t = new PlaybackTracker();
    const r = t.update(toCompareState(st(PlaybackState.PLAYING)));
    expect(r).toBe("none");
  });

  it("同状态同 uri: 返回 none(无变化)", () => {
    const t = new PlaybackTracker();
    t.update(toCompareState(st(PlaybackState.PLAYING)));
    const r = t.update(toCompareState(st(PlaybackState.PLAYING)));
    expect(r).toBe("none");
  });
});
