// Unit tests for plugin health tracking: consecutive-failure → status mapping,
// success reset, the optional self-check ping hook, and the active ping aggregate.
import { describe, it, expect, beforeAll } from "vitest";
import { initDatabase } from "../../src/db/index.js";
import {
  recordSuccess,
  recordFailure,
  getHealth,
  allHealth,
  pingPlugin,
  pingAllHealth,
} from "../../src/plugins/health.js";
import { registerPlugin, unregisterPlugin } from "../../src/plugins/registry.js";

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

  it("normalizes plugin status: ok→green / degraded→yellow / down→down", async () => {
    expect(await pingPlugin({ health: async () => ({ status: "ok", message: "fine" }) }))
      .toEqual({ status: "green", message: "fine" });
    expect(await pingPlugin({ health: async () => ({ status: "degraded", message: "slow" }) }))
      .toEqual({ status: "yellow", message: "slow" });
    expect(await pingPlugin({ health: async () => ({ status: "down", message: "unreachable" }) }))
      .toEqual({ status: "down", message: "unreachable" });
  });

  it("maps a thrown health() to down", async () => {
    const r = await pingPlugin({ health: async () => { throw new Error("nope"); } });
    expect(r?.status).toBe("down");
  });
});

describe("pingAllHealth", () => {
  // 用随机后缀避免与其它用例/内置插件冲突;pingAllHealth 遍历全部已注册插件,
  // 断言只关心自己注册的 id。
  const U = Math.random().toString(36).slice(2, 8);
  const fake = (pid: string, impl: any) => {
    registerPlugin({ id: pid, name: pid, version: "1.0.0", type: "source", capabilities: ["search"] } as any, impl);
  };

  it("无 health() 且无观测记录 → none(未监控)", async () => {
    const pid = `ph-none-${U}`;
    fake(pid, {});
    const items = await pingAllHealth();
    expect(items.find((i) => i.pluginId === pid)).toMatchObject({ status: "none", source: "none" });
    unregisterPlugin(pid);
  });

  it("实现了 health() → 主动 ping 结果(ok→green),带 message", async () => {
    const pid = `ph-ok-${U}`;
    fake(pid, { health: async () => ({ status: "ok", message: "API 可达" }) });
    const items = await pingAllHealth();
    expect(items.find((i) => i.pluginId === pid)).toMatchObject({ status: "green", source: "ping", message: "API 可达" });
    unregisterPlugin(pid);
  });

  it("health() 抛错 → down", async () => {
    const pid = `ph-down-${U}`;
    fake(pid, { health: async () => { throw new Error("boom"); } });
    const items = await pingAllHealth();
    expect(items.find((i) => i.pluginId === pid)).toMatchObject({ status: "down", source: "ping" });
    unregisterPlugin(pid);
  });

  it("ping 结果缓存:同 id 二次调用不再执行 health()", async () => {
    const pid = `ph-cache-${U}`;
    let calls = 0;
    fake(pid, { health: async () => { calls++; return { status: "ok" }; } });
    await pingAllHealth();
    await pingAllHealth();
    expect(calls).toBe(1); // 第二次命中 60s 缓存
    unregisterPlugin(pid);
  });
});
