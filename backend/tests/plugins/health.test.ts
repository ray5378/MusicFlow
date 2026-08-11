// Unit tests for plugin health tracking: consecutive-failure → status mapping,
// success reset, and the optional self-check ping hook.
import { describe, it, expect, beforeAll } from "vitest";
import { initDatabase } from "../../src/db/index.js";
import {
  recordSuccess,
  recordFailure,
  getHealth,
  allHealth,
  pingPlugin,
} from "../../src/plugins/health.js";

beforeAll(() => initDatabase());

// The default test DB persists across runs, and health is order-sensitive
// (consecutive-failure counter). Tag every id with a per-run suffix so a
// leftover row from a previous run can never poison these assertions.
const U = Math.random().toString(36).slice(2, 8);
const id = (s: string) => `hp-${s}-${U}`;

describe("health transitions", () => {
  it("starts unknown before any record", () => {
    expect(getHealth(id("never-seen")).status).toBe("unknown");
  });

  it("is green with zero consecutive failures (success path)", () => {
    recordSuccess(id("green"));
    expect(getHealth(id("green")).status).toBe("green");
    expect(getHealth(id("green")).consecutiveFailures).toBe(0);
  });

  it("escalates yellow → red with consecutive failures", () => {
    recordFailure(id("escalate"), "err1");
    expect(getHealth(id("escalate")).status).toBe("yellow");
    recordFailure(id("escalate"), "err2");
    expect(getHealth(id("escalate")).status).toBe("yellow");
    recordFailure(id("escalate"), "err3");
    expect(getHealth(id("escalate")).status).toBe("red");
    recordFailure(id("escalate"), "err4");
    expect(getHealth(id("escalate")).status).toBe("red");
  });

  it("resets to green after a success", () => {
    recordFailure(id("reset"), "err1");
    recordFailure(id("reset"), "err2");
    expect(getHealth(id("reset")).status).toBe("yellow");
    recordSuccess(id("reset"));
    expect(getHealth(id("reset")).status).toBe("green");
    expect(getHealth(id("reset")).consecutiveFailures).toBe(0);
  });

  it("records the last error message", () => {
    recordFailure(id("err"), "something broke");
    expect(getHealth(id("err")).lastError).toBe("something broke");
  });

  it("surfaces tracked plugins in allHealth()", () => {
    recordSuccess(id("listed"));
    const rows = allHealth();
    expect(rows.find((r) => r.pluginId === id("listed"))?.status).toBe("green");
  });
});

describe("pingPlugin", () => {
  it("returns null when the impl has no health() hook", async () => {
    expect(await pingPlugin({})).toBeNull();
    expect(await pingPlugin(null)).toBeNull();
  });

  it("reports the impl's status", async () => {
    const r = await pingPlugin({ health: async () => ({ status: "degraded", message: "slow" }) });
    expect(r).toEqual({ status: "degraded", message: "slow" });
  });

  it("maps a thrown health() to down", async () => {
    const r = await pingPlugin({ health: async () => { throw new Error("nope"); } });
    expect(r?.status).toBe("down");
  });
});
