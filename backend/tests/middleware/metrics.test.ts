// 请求级 metrics 中间件(src/middleware/metrics.ts)的**未覆盖分支**。
//
// tests/memory/observe.test.ts 已覆盖「计数 + 路由模板聚合」这条主干;这里补的是:
//   ① 慢请求分支(ms >= SLOW_MS=1000 → slowCount++ + 打 warn)。SLOW_MS 写死 1s,
//      不可能真等 1 秒,所以用 Date.now 的替身把中间件的两次取时拉开差距 ——
//      断言的是**分支被走到**,不是真实耗时;
//   ② `c.req.routePath` 为空时的兜底(未命中任何路由 → 404 时 routePath 是空串),
//      必须回落到 `new URL(c.req.url).pathname`,否则这些请求会共用一个空 key。
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { Hono } from "hono";
import { metricsMiddleware, getRequestMetrics } from "../../src/middleware/metrics.js";

beforeEach(() => {
  vi.restoreAllMocks();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("metricsMiddleware", () => {
  it("慢请求(>=1000ms)计入 slowCount,并仍计入 total 与端点计数", async () => {
    let t = 1_700_000_000_000;
    vi.spyOn(Date, "now").mockImplementation(() => t);

    const app = new Hono();
    app.use("*", metricsMiddleware);
    app.get("/v1/slow", (c) => {
      t += 1500; // 让中间件的 ms = 1500
      return c.json({ ok: true });
    });

    const before = getRequestMetrics();
    await app.request("/v1/slow", { method: "GET" });
    const after = getRequestMetrics();

    expect(after.slowCount - before.slowCount).toBe(1);
    expect(after.total - before.total).toBe(1);
    expect(after.byEndpoint["GET /v1/slow"]).toBe((before.byEndpoint["GET /v1/slow"] || 0) + 1);
  });

  it("刚好 1000ms 也算慢(判据是 >=,不是 >)", async () => {
    let t = 1_700_000_000_000;
    vi.spyOn(Date, "now").mockImplementation(() => t);

    const app = new Hono();
    app.use("*", metricsMiddleware);
    app.get("/v1/exactly", (c) => {
      t += 1000;
      return c.json({ ok: true });
    });

    const before = getRequestMetrics().slowCount;
    await app.request("/v1/exactly");
    expect(getRequestMetrics().slowCount - before).toBe(1);
  });

  it("999ms 不算慢(边界另一侧),但照样计数", async () => {
    let t = 1_700_000_000_000;
    vi.spyOn(Date, "now").mockImplementation(() => t);

    const app = new Hono();
    app.use("*", metricsMiddleware);
    app.get("/v1/fast", (c) => {
      t += 999;
      return c.json({ ok: true });
    });

    const before = getRequestMetrics();
    await app.request("/v1/fast");
    const after = getRequestMetrics();
    expect(after.slowCount - before.slowCount).toBe(0);
    expect(after.byEndpoint["GET /v1/fast"]).toBe((before.byEndpoint["GET /v1/fast"] || 0) + 1);
  });

  // 现状记录:中间件挂载方式为 `app.use("*", metricsMiddleware)`,因此**未命中任何业务
  // 路由时** `c.req.routePath` 拿到的是中间件自身的模式 `/*`(不是空串),于是所有 404
  // 请求(扫描器随便打的路径)都聚成同一个 key —— 正好符合「key 必须有界」的设计红线
  // (动态 URL 不会让 Map 无限增长)。也因此 `routePath || pathname` 的右半边在当前挂载
  // 方式下走不到,属防御性分支。
  it("未命中路由(404)时 key 用中间件的 '/*':任意不存在的路径全部聚合,不按真实 URL 分裂", async () => {
    const app = new Hono();
    app.use("*", metricsMiddleware);
    app.get("/v1/known", (c) => c.json({ ok: true }));

    const before = getRequestMetrics();
    expect((await app.request("/v1/not-registered")).status).toBe(404);
    expect((await app.request("/wp-admin.php")).status).toBe(404);
    const after = getRequestMetrics();

    expect(after.byEndpoint["GET /*"]).toBe((before.byEndpoint["GET /*"] || 0) + 2);
    // 真实 URL 不该各自成为一个 key
    expect(after.byEndpoint["GET /v1/not-registered"]).toBeUndefined();
    expect(after.byEndpoint["GET /wp-admin.php"]).toBeUndefined();
    // 也不该出现空 key
    expect(after.byEndpoint["GET "] ?? 0).toBe(before.byEndpoint["GET "] ?? 0);
  });

  it("getRequestMetrics() 返回的是快照:改动返回对象不会回写内部计数器", () => {
    const snap = getRequestMetrics();
    const key = Object.keys(snap.byEndpoint)[0];
    if (key) snap.byEndpoint[key] = -12345;
    const again = getRequestMetrics();
    if (key) expect(again.byEndpoint[key]).not.toBe(-12345);
    expect(typeof again.total).toBe("number");
    expect(typeof again.slowCount).toBe("number");
  });
});
