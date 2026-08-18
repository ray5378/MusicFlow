// 内存观测 + 请求 metrics 测试。
import { describe, it, expect, beforeEach, beforeAll } from "vitest";
import { Hono } from "hono";
import { sqlite } from "../../src/db/index.js";
import { registerBuiltinPlugins } from "../../src/plugins/builtins.js";
import {
  reclaimNow, getMemorySnapshot, getReclaimStatus,
  _resetReclaimForTest,
} from "../../src/services/memory/reclaim.js";
import { metricsMiddleware, getRequestMetrics } from "../../src/middleware/metrics.js";

beforeAll(() => {
  if (!process.env.APP_VERSION) process.env.APP_VERSION = "1.0.0";
  registerBuiltinPlugins();
});
beforeEach(() => {
  _resetReclaimForTest();
  sqlite.prepare("DELETE FROM settings").run();
});

describe("reclaim 观测", () => {
  it("getMemorySnapshot 返回四个标准字段(数值)", () => {
    const s = getMemorySnapshot();
    expect(typeof s.rssMB).toBe("number");
    expect(typeof s.heapUsedMB).toBe("number");
    expect(typeof s.externalMB).toBe("number");
    expect(typeof s.arrayBuffersMB).toBe("number");
    expect(s.rssMB).toBeGreaterThan(0);
  });

  it("reclaimNow('manual') 报告含 reason + 回收前后内存,并写入 getReclaimStatus", () => {
    const r = reclaimNow("manual");
    expect(r.reason).toBe("manual");
    expect(r.memBefore).toBeTruthy();
    expect(r.memAfter).toBeTruthy();
    expect(Array.isArray(r.caches)).toBe(true);
    expect(typeof r.gc).toBe("boolean");

    const rs = getReclaimStatus();
    expect(rs.lastReclaimAt).toBeGreaterThan(0);
    expect(rs.lastReclaim?.reason).toBe("manual");
  });

  it("空闲触发的回收 reason 为 idle", () => {
    const r = reclaimNow("idle");
    expect(r.reason).toBe("idle");
  });
});

describe("请求 metrics 中间件", () => {
  it("计数端点调用,key 用路由模板(动态路径不产生独立 key)", async () => {
    const app = new Hono();
    app.use("*", metricsMiddleware);
    app.get("/api/v1/users/:id", (c) => c.json({ id: c.req.param("id") }));
    app.get("/api/v1/ping", (c) => c.json({ ok: true }));

    await app.request("/api/v1/users/abc");
    await app.request("/api/v1/users/def");
    await app.request("/api/v1/ping");

    const m = getRequestMetrics();
    expect(m.total).toBe(3);
    // 路由模板聚合:两条动态路径计为一个 key
    expect(m.byEndpoint["GET /api/v1/users/:id"]).toBe(2);
    expect(m.byEndpoint["GET /api/v1/ping"]).toBe(1);
  });
});
