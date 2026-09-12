import { describe, it, expect } from "vitest";
import {
  defaultSendInterval,
  DEFAULT_SEND_INTERVAL_NS,
  frameDeadlineBehind,
  isLate,
  latencyFuncToMs,
  serverFrameTimestampUs,
} from "./stream.js";

describe("stream timeline helpers", () => {
  it("latency_func slow_x3(s)→毫秒", () => {
    expect(latencyFuncToMs(0.01)).toBeCloseTo(30, 5);
  });

  it("isLate: 负时间=晚到", () => {
    expect(isLate(-1)).toBe(true);
    expect(isLate(1)).toBe(false);
  });

  it("默认发送间隔 ~21.33fps", () => {
    expect(defaultSendInterval()).toBe(DEFAULT_SEND_INTERVAL_NS);
  });

  it("帧时间戳 = 组起点 + 已播放帧", () => {
    const t = serverFrameTimestampUs({ monotonicUs: () => 0n }, 1_000_000n, 48000, 48000);
    expect(t).toBe(2_000_000n);
  });

  it("frameDeadlineBehind 判断过期", () => {
    // 现在比块晚 3s > sendAhead(0.5s)+余量(1.5s)
    expect(frameDeadlineBehind(5_000_000n, 2_000_000n, 500)).toBe(true);
    expect(frameDeadlineBehind(2_100_000n, 2_000_000n, 500)).toBe(false);
  });
});