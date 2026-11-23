import { describe, expect, it } from "vitest";
import { isStaleFrame, LATE_FRAME_GRACE_US } from "../../src/services/airplay/lateFrameGuard.js";

describe("isStaleFrame — 过期帧判据", () => {
  const now = 10_000_000n;
  it("可听时刻在 grace 之内的帧：不算过期（正常投递）", () => {
    expect(isStaleFrame(now - 1_000_000n, now)).toBe(false); // 过去 1s，仍在 1.5s 宽限内
    expect(isStaleFrame(now + 5_000_000n, now)).toBe(false); // 未来帧
  });

  it("超过 grace 的过去帧：判过期（绝不投给设备）", () => {
    expect(isStaleFrame(now - LATE_FRAME_GRACE_US - 1n, now)).toBe(true);
    expect(isStaleFrame(now - 7_000_000n, now)).toBe(true); // 真机 iEAST 那种「落后 7s」
  });

  it("自定义宽限：收紧后同一帧变过期", () => {
    const ts = now - 800_000n;
    expect(isStaleFrame(ts, now)).toBe(false);
    expect(isStaleFrame(ts, now, 500_000n)).toBe(true);
  });
});
