import { describe, it, expect } from "vitest";
import { nowUs, buildServerTime } from "./clock.js";

describe("clock", () => {
  it("单调微秒", async () => {
    const a = nowUs();
    await new Promise((r) => setTimeout(r, 5));
    const b = nowUs();
    expect(b).toBeGreaterThan(a);
  });
  it("server/time 回显 client_transmitted", () => {
    const m = buildServerTime(123456n);
    expect(m.payload.client_transmitted).toBe(123456n);
    expect(typeof m.payload.server_received).toBe("bigint");
    expect(typeof m.payload.server_transmitted).toBe("bigint");
  });
});