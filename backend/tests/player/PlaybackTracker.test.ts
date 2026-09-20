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

  it("PLAYING→BUFFERING→IDLE 有下一首: 返回 advance(设备自然结束带 TRANSITIONING 瞬态)", () => {
    const t = new PlaybackTracker();
    t.update(toCompareState(st(PlaybackState.PLAYING)));
    t.update(toCompareState(st(PlaybackState.BUFFERING)));
    const r = t.update(toCompareState(st(PlaybackState.IDLE)));
    expect(r).toBe("advance");
  });

  it("PLAYING→BUFFERING→IDLE 无下一首: 返回 ended", () => {
    const t = new PlaybackTracker();
    t.update(toCompareState(st(PlaybackState.PLAYING)));
    t.update(toCompareState(st(PlaybackState.BUFFERING)));
    const r = t.update(toCompareState(st(PlaybackState.IDLE)), false);
    expect(r).toBe("ended");
  });

  it("PLAYING→BUFFERING: 返回 none(瞬态屏蔽,lastPlaying 保留)", () => {
    const t = new PlaybackTracker();
    t.update(toCompareState(st(PlaybackState.PLAYING)));
    const r = t.update(toCompareState(st(PlaybackState.BUFFERING)));
    expect(r).toBe("none");
    expect(t.getLastPlaying()?.playbackState).toBe(PlaybackState.PLAYING);
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

  // ── 卡死兜底(2026-09-21 二次订正:60s「上报间隔」死判据 → 15s 墙钟累积) ──
  // 旧判据 `neww.updatedAt - prev.updatedAt > 60_000` 要求「连续两次 IDLE 上报间隔超 60s」,
  // 而生产采样固定 5s、每帧都把 updatedAt 刷成当前时刻 → 差值恒为 5s,**永远触发不了**。
  // 下面刻意按**生产形态**喂(每帧间隔 5s),这才是真守住兜底的用例;旧的两条手工隔 61s,
  // 测的是一个生产不存在的输入。
  describe("卡死兜底(墙钟累积,生产 5s 采样形态)", () => {
    it("IDLE 持续 15s: tick 返回 stalled(兜底真能触发)", () => {
      const t = new PlaybackTracker();
      const t0 = Date.now();
      t.update(toCompareState(st(PlaybackState.IDLE)));
      // 生产形态:每 5s 一帧上报,updatedAt 每帧都刷新
      for (let n = 0; n < 2; n++) {
        vi.advanceTimersByTime(5_000);
        expect(t.update(toCompareState(st(PlaybackState.IDLE)))).toBe("none");
      }
      expect(t.tick(t0 + 10_000)).toBe("none");    // 未到 15s
      expect(t.tick(t0 + 15_000)).toBe("stalled"); // 到点
    });

    it("同一次卡死只报一次: 后续 tick 不重复派发", () => {
      const t = new PlaybackTracker();
      const t0 = Date.now();
      t.update(toCompareState(st(PlaybackState.IDLE)));
      expect(t.tick(t0 + 15_000)).toBe("stalled");
      expect(t.tick(t0 + 16_000)).toBe("none");
      expect(t.tick(t0 + 60_000)).toBe("none");
    });

    it("离开 IDLE 即清零: 恢复播放后再停需重新计满 15s", () => {
      const t = new PlaybackTracker();
      const t0 = Date.now();
      t.update(toCompareState(st(PlaybackState.IDLE)));
      expect(t.tick(t0 + 14_000)).toBe("none");
      // 设备恢复播放(哪怕只是一帧 PLAYING)→ 计时清零
      vi.advanceTimersByTime(14_000);
      t.update(toCompareState(st(PlaybackState.PLAYING)));
      t.update(toCompareState(st(PlaybackState.IDLE)));
      expect(t.tick(t0 + 20_000)).toBe("none");    // 新的 IDLE 才 6s
      expect(t.tick(t0 + 29_500)).toBe("stalled"); // 新的 IDLE 已 15.5s
    });

    it("PAUSED 不算卡死: 暂停的墙钟不进计时", () => {
      const t = new PlaybackTracker();
      const t0 = Date.now();
      t.update(toCompareState(st(PlaybackState.IDLE)));
      vi.advanceTimersByTime(1_000);
      t.update(toCompareState(st(PlaybackState.PAUSED)));
      expect(t.tick(t0 + 60_000)).toBe("none");
    });

    it("reset() 清空卡死计时: 重投同一首不会立刻被判卡死", () => {
      const t = new PlaybackTracker();
      const t0 = Date.now();
      t.update(toCompareState(st(PlaybackState.IDLE)));
      t.reset();
      expect(t.tick(t0 + 60_000)).toBe("none");
    });
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

  // ==================== 以已知时长为准的结束判定(2026-09-21) ====================
  // 背景:只靠 PLAYING→IDLE 判结束,IDLE 一误报就提前切歌、IDLE 不来就卡死在
  // 结尾。以下用例锁住"注入时长后"的新判据;未注入时行为与旧版完全一致
  // (见上方用例 —— 它们不注入,仍期望 advance)。

  it("已知 300s 只播到 100s 就 IDLE: 返回 idle_early(判误报,不切歌)", () => {
    const t = new PlaybackTracker();
    t.setExpectedDuration(300);
    t.update(toCompareState(st(PlaybackState.PLAYING, "u1", 100, 300)));
    // 设备报 IDLE 时 position 常回 0 —— 判据必须取末次 PLAYING 的读数
    const r = t.update(toCompareState(st(PlaybackState.IDLE, "u1", 0, 300)));
    expect(r).toBe("idle_early");
  });

  it("已知 300s 播到 295s 才 IDLE: 返回 advance(确实播完了)", () => {
    const t = new PlaybackTracker();
    t.setExpectedDuration(300);
    t.update(toCompareState(st(PlaybackState.PLAYING, "u1", 295, 300)));
    const r = t.update(toCompareState(st(PlaybackState.IDLE, "u1", 0, 300)));
    expect(r).toBe("advance");
  });

  it("设备不报结束(恒 PLAYING)且位置已到时长: 宽限 8s 后返回 advance(治卡死)", () => {
    const t = new PlaybackTracker();
    t.setExpectedDuration(100);
    // 外推封顶后读数恒等于时长,读数是"到顶"而非"超过",故只能靠持续时长判定
    expect(t.update(toCompareState(st(PlaybackState.PLAYING, "u1", 100, 100)))).toBe("none");
    vi.advanceTimersByTime(3_000);
    expect(t.update(toCompareState(st(PlaybackState.PLAYING, "u1", 100, 100)))).toBe("none");
    vi.advanceTimersByTime(6_000);
    expect(t.update(toCompareState(st(PlaybackState.PLAYING, "u1", 100, 100)))).toBe("advance");
  });

  it("误报撤销后歌曲继续播到时长: 仍能 advance(不被 idle_early 永久卡住)", () => {
    const t = new PlaybackTracker();
    t.setExpectedDuration(100);
    t.update(toCompareState(st(PlaybackState.PLAYING, "u1", 10, 100)));
    expect(t.update(toCompareState(st(PlaybackState.IDLE, "u1", 0, 100)))).toBe("idle_early");
    // 设备其实还在播(QueueController 的复查会撤销这次误报),重新进入 PLAYING 并播到结尾
    t.update(toCompareState(st(PlaybackState.PLAYING, "u1", 100, 100)));
    vi.advanceTimersByTime(9_000);
    expect(t.update(toCompareState(st(PlaybackState.PLAYING, "u1", 100, 100)))).toBe("advance");
  });

  it("播到时长才 IDLE 且无下一首: 返回 ended", () => {
    const t = new PlaybackTracker();
    t.setExpectedDuration(100);
    t.update(toCompareState(st(PlaybackState.PLAYING, "u1", 100, 100)));
    const r = t.update(toCompareState(st(PlaybackState.IDLE, "u1", 0, 100)), false);
    expect(r).toBe("ended");
  });

  it("已判结束后不再重复 advance(时长判据用后即清)", () => {
    const t = new PlaybackTracker();
    t.setExpectedDuration(100);
    t.update(toCompareState(st(PlaybackState.PLAYING, "u1", 100, 100)));
    vi.advanceTimersByTime(9_000);
    expect(t.update(toCompareState(st(PlaybackState.PLAYING, "u1", 100, 100)))).toBe("advance");
    // 未注入新曲时长前,同样的"到顶"读数不该再触发一次
    vi.advanceTimersByTime(20_000);
    expect(t.update(toCompareState(st(PlaybackState.PLAYING, "u1", 100, 100)))).toBe("none");
  });

  it("注入 0(未知时长,如 flow 连续流会话): 回退旧行为,直接 advance", () => {
    const t = new PlaybackTracker();
    t.setExpectedDuration(0);
    t.update(toCompareState(st(PlaybackState.PLAYING, "u1", 5, 300)));
    const r = t.update(toCompareState(st(PlaybackState.IDLE, "u1", 0, 300)));
    expect(r).toBe("advance");
  });

  // ── 本地节拍(对照 MA _poll_players 0.5s 推送) ──
  // 设备采样(本仓 5s)只负责纠偏;结束判定不该被采样粒度拖慢,否则
  // 「位置到时长 + 8s 宽限」要等下一次采样才发现,实际 ~10s 才切歌。
  describe("tick(本地节拍推进,不触设备)", () => {
    it("恒 PLAYING 且位置已到时长: 宽限到期即 advance(期间无任何设备上报)", () => {
      const t = new PlaybackTracker();
      t.setExpectedDuration(100);
      t.update(toCompareState(st(PlaybackState.PLAYING, "u1", 100, 100)));
      const t0 = Date.now();
      expect(t.tick(t0 + 500)).toBe("none");
      expect(t.tick(t0 + 7_500)).toBe("none");
      expect(t.tick(t0 + 8_500)).toBe("advance");
    });

    it("位置未到时长: 按墙上时钟外推,到点后才起算宽限", () => {
      const t = new PlaybackTracker();
      t.setExpectedDuration(100);
      t.update(toCompareState(st(PlaybackState.PLAYING, "u1", 90, 100)));
      const t0 = Date.now();
      expect(t.tick(t0 + 5_000)).toBe("none");   // 外推 95s
      expect(t.tick(t0 + 9_500)).toBe("none");   // 外推 99.5s
      expect(t.tick(t0 + 11_000)).toBe("none");  // 到点 1s,宽限刚开始
      expect(t.tick(t0 + 19_000)).toBe("advance"); // 到点后已过 8s
    });

    it("暂停中(PAUSED)不推进: 暂停期间的墙钟不算进宽限", () => {
      const t = new PlaybackTracker();
      t.setExpectedDuration(100);
      t.update(toCompareState(st(PlaybackState.PLAYING, "u1", 100, 100)));
      const t0 = Date.now();
      t.update(toCompareState(st(PlaybackState.PAUSED, "u1", 100, 100)));
      expect(t.tick(t0 + 60_000)).toBe("none");
    });

    it("时长未知(flow 连续流会话注入 0): 不介入", () => {
      const t = new PlaybackTracker();
      t.setExpectedDuration(0);
      t.update(toCompareState(st(PlaybackState.PLAYING, "u1", 5, 300)));
      expect(t.tick(Date.now() + 600_000)).toBe("none");
    });

    it("判结束后不再重复 advance(时长判据用后即清)", () => {
      const t = new PlaybackTracker();
      t.setExpectedDuration(100);
      t.update(toCompareState(st(PlaybackState.PLAYING, "u1", 100, 100)));
      const t0 = Date.now();
      expect(t.tick(t0 + 9_000)).toBe("advance");
      expect(t.tick(t0 + 60_000)).toBe("none");
    });

    it("不改状态迁移快照: 之后 PLAYING→IDLE 仍正常判 advance", () => {
      const t = new PlaybackTracker();
      t.setExpectedDuration(100);
      t.update(toCompareState(st(PlaybackState.PLAYING, "u1", 100, 100)));
      t.tick(Date.now() + 1_000);
      expect(t.getPrev()?.playbackState).toBe(PlaybackState.PLAYING);
      expect(t.update(toCompareState(st(PlaybackState.IDLE, "u1", 0, 100)))).toBe("advance");
    });
  });
});
