// ==================== 「PLAYING 但位置冻结」看门狗 ====================
//
// 对应 PlaybackTracker.FREEZE_TIMEOUT_MS(2026-09-21 新增)。
//
// 真机病灶(sendspin):peer 报 `PLAYING pos=173.6 dur=280` 整整 3 分钟一动不动的
// 同时推流 pump 零日志 —— 链路活着、状态还报 PLAYING,音频却不再前进。
// 当时已有的两套兜底都够不着:
//   · STALL_TIMEOUT_MS 只看 IDLE(设备报 PLAYING,进不去);
//   · END_GRACE_MS 只看到时长的外推(位置离结束还远,进不去)。
// 于是永不恢复,用户观感 = "进度条卡住不动"。
//
// 本文件锁死这条判据的边界,尤其是**不能误报**的几类:
//   PAUSED 不算冻结、position 恒 0(未实现的渲染器)不算冻结、时长未知时不动手、
//   位置到时长(自然结束)优先走结束判定。
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { PlaybackTracker } from "../../src/services/player/PlaybackTracker.js";
import { PlaybackState, type CompareState } from "../../src/services/player/types.js";

const T0 = new Date("2026-09-21T00:00:00Z").getTime();

function st(over: Partial<CompareState> = {}): CompareState {
  return {
    playbackState: PlaybackState.PLAYING,
    mediaUri: "http://x/stream/token",
    position: 100,
    duration: 200,
    updatedAt: Date.now(),
    ...over,
  };
}

/** 推进到 t 秒(相对 T0)并喂一次上报。 */
function reportAt(tracker: PlaybackTracker, sec: number, over: Partial<CompareState> = {}) {
  vi.setSystemTime(T0 + sec * 1000);
  return tracker.update(st({ updatedAt: Date.now(), ...over }));
}

function tickAt(tracker: PlaybackTracker, sec: number) {
  return tracker.tick(T0 + sec * 1000);
}

describe("PlaybackTracker 位置冻结看门狗", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(T0);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("位置持续推进 → 永不判 frozen(即使跑很久)", () => {
    const tr = new PlaybackTracker();
    tr.setExpectedDuration(280);
    // 5s 采样一次,位置跟着涨(模拟健康 sendspin 轮询);停在 250s,不碰结束时长的边界
    for (let t = 0; t <= 150; t += 5) {
      reportAt(tr, t, { position: 100 + t });
      expect(tickAt(tr, t)).toBe("none");
    }
  });

  it("位置冻结满 30s → 报一次 frozen,同段不重复", () => {
    const tr = new PlaybackTracker();
    tr.setExpectedDuration(280);
    reportAt(tr, 0, { position: 173.6 }); // 建立基线(位置有值)
    // 冻住:位置读数一直不变
    for (let t = 5; t <= 25; t += 5) {
      reportAt(tr, t, { position: 173.6 });
      expect(tickAt(tr, t)).toBe("none"); // 未到阈值 → 不动手
    }
    reportAt(tr, 30, { position: 173.6 });
    expect(tickAt(tr, 30)).toBe("frozen"); // 恰好 30s → 触发
    // 同一段冻结只报一次(否则 500ms 节拍会每拍重投一次)
    reportAt(tr, 35, { position: 173.6 });
    expect(tickAt(tr, 35)).toBe("none");
    expect(tickAt(tr, 60)).toBe("none");
  });

  it("位置恢复推进 → 释放信号,再次冻结仍能报出来", () => {
    const tr = new PlaybackTracker();
    tr.setExpectedDuration(280);
    reportAt(tr, 0, { position: 100 });
    reportAt(tr, 5, { position: 100 });
    reportAt(tr, 30, { position: 100 });
    expect(tickAt(tr, 30)).toBe("frozen");
    // 位置又动了(设备自愈 / 用户 seek)→ 信号释放
    reportAt(tr, 35, { position: 130 });
    expect(tickAt(tr, 35)).toBe("none");
    // 再冻结 30s → 必须还能报(否则一次偶发之后永远失去保护)
    reportAt(tr, 40, { position: 130 });
    reportAt(tr, 70, { position: 130 });
    expect(tickAt(tr, 70)).toBe("frozen");
  });

  it("PAUSED 位置不动 → 不判 frozen(暂停 ≠ 冻结)", () => {
    const tr = new PlaybackTracker();
    tr.setExpectedDuration(280);
    reportAt(tr, 0, { position: 100 });
    for (let t = 5; t <= 120; t += 5) {
      reportAt(tr, t, { playbackState: PlaybackState.PAUSED, position: 100 });
      expect(tickAt(tr, t)).toBe("none");
    }
  });

  it("position 恒 0(渲染器不实现位置查询)→ 不判 frozen", () => {
    const tr = new PlaybackTracker();
    tr.setExpectedDuration(280);
    for (let t = 0; t <= 120; t += 5) {
      reportAt(tr, t, { position: 0 });
      expect(tickAt(tr, t)).toBe("none");
    }
  });

  it("时长未知(flow 连续流 / 曲库无时长)→ 不判 frozen", () => {
    const tr = new PlaybackTracker();
    // 不调 setExpectedDuration → 时长 0 = 未知,退化成旧的纯状态迁移判定
    for (let t = 0; t <= 120; t += 5) {
      reportAt(tr, t, { position: 50 });
      expect(tickAt(tr, t)).toBe("none");
    }
  });

  it("位置到时长 → 冻结判据不抢结束判定", () => {
    const tr = new PlaybackTracker();
    tr.setExpectedDuration(200);
    reportAt(tr, 0, { position: 200 }); // 到顶,开始计宽限(END_GRACE_MS)
    // 宽限期内 tick 绝不报 frozen —— 位置"不动"是因为已经播到头了,不是僵死
    expect(tickAt(tr, 5)).toBe("none");
    // 宽限(8s)过后由结束判定接手:advance
    expect(reportAt(tr, 30, { position: 200 })).toBe("advance");
  });

  it("reset() 后冻结信号释放(重投/切歌后新的一轮还能再报)", () => {
    const tr = new PlaybackTracker();
    tr.setExpectedDuration(280);
    reportAt(tr, 0, { position: 100 });
    reportAt(tr, 30, { position: 100 });
    expect(tickAt(tr, 30)).toBe("frozen");
    tr.reset();
    expect(tickAt(tr, 31)).toBe("none"); // prev 已清
    reportAt(tr, 35, { position: 100 });
    reportAt(tr, 65, { position: 100 });
    expect(tickAt(tr, 65)).toBe("frozen");
  });
});
