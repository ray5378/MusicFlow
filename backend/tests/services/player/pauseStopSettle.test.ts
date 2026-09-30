import { describe, it, expect, vi } from "vitest";
import {
  pauseStopSettleKey,
  markPauseStopIssued,
  withinPauseStopSettle,
  clearPauseStop,
} from "../../../src/services/player/pauseStopSettle.js";

// 背景(2026-09-30 真机,两轮实测):暂停满 30s 看门狗转 stop → 设备排空 ~26s 缓冲后才
// 上报 IDLE → QueueController idle_early 复查放行切歌。v1 用 15s 限时冷静期,复查到达时
// 窗口已过期,照样切歌。v2:**打标持久化,不过期**,直到新播放会话
// (transport play/stop、playCurrent 起播漏斗)清除 —— 对齐 MA 语义:
// 看门狗转的 stop 只停传输,队列留在当前曲,推进只由曲目真结束驱动。

describe("pauseStopSettle", () => {
  it("key 归一化:ug:<gid> ≡ group:<gid> ≡ 裸 id;sendspin: 前缀同样剥掉", () => {
    const gid = "ab7fca6f-82fe-49f5-9652-32440f83a4f1";
    expect(pauseStopSettleKey(`ug:${gid}`)).toBe(gid);
    expect(pauseStopSettleKey(`group:${gid}`)).toBe(gid);
    expect(pauseStopSettleKey(gid)).toBe(gid);
    expect(pauseStopSettleKey("sendspin:dev1")).toBe("dev1");
  });

  it("打标后复查命中,且**不随时间过期**(v1 的 15s 窗口赌不赢缓冲排空)", () => {
    vi.useFakeTimers();
    try {
      const id = "dev-sticky";
      markPauseStopIssued(id);
      expect(withinPauseStopSettle(id)).toBe(true);
      vi.advanceTimersByTime(26_000); // 实测缓冲排空时长
      expect(withinPauseStopSettle(id)).toBe(true);
      vi.advanceTimersByTime(3_600_000); // 1 小时后依然命中 —— 直到新播放会话清除
      expect(withinPauseStopSettle(id)).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("clearPauseStop 清除后复查不再命中;未打标时 clear 是静默 no-op", () => {
    const id = "dev-clear";
    markPauseStopIssued(id);
    expect(withinPauseStopSettle(id)).toBe(true);
    clearPauseStop(id);
    expect(withinPauseStopSettle(id)).toBe(false);
    expect(() => clearPauseStop(id)).not.toThrow();
  });

  it("组与设备互相隔离:清组不清设备,反之亦然", () => {
    const gid = "g-iso";
    const dev = "d-iso";
    markPauseStopIssued(`group:${gid}`);
    markPauseStopIssued(`sendspin:${dev}`);
    clearPauseStop(gid); // 裸 id 与 group: 前缀归到同一 key
    expect(withinPauseStopSettle(`ug:${gid}`)).toBe(false);
    expect(withinPauseStopSettle(dev)).toBe(true); // 设备标记不受影响
    clearPauseStop(`sendspin:${dev}`);
    expect(withinPauseStopSettle(`group:${dev}`)).toBe(false);
  });
});
