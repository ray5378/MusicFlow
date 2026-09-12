import { describe, it, expect } from "vitest";
import { StaticCodeGate, attemptStaticCode, generateSessionPsk } from "./pairing.js";

describe("static code gate", () => {
  it("正确码即刻通过并清零失败", () => {
    const g = new StaticCodeGate();
    g.reset(0);
    const r = attemptStaticCode(g, "123456", "123456", 0);
    expect(r.ok).toBe(true);
    expect(g.failures).toBe(0);
  });

  it("5 次失败后锁定", () => {
    const g = new StaticCodeGate();
    g.reset(0);
    for (let i = 1; i <= 5; i++) {
      const r = attemptStaticCode(g, "123456", "000000", i);
      if (i < 5) expect(r.ok).toBe(false);
      else expect(r.locked).toBe(true);
    }
  });

  it("生成 64 hex 会话 PSK", () => {
    expect(generateSessionPsk()).toMatch(/^[0-9a-f]{64}$/);
  });
});