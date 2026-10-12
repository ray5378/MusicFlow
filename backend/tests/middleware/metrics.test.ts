// 请求级 metrics 中间件(src/middleware/metrics.ts)的行为锁定。
//
// 覆盖三块:
//   ① 计数主干 + 慢请求分支(ms >= 预算 → slowCount++ + 打 warn)。预算写死时不可能
//      真等 1 秒,所以用 Date.now 的替身把中间件的两次取时拉开差距 —— 断言的是
//      **分支被走到 / 预算被判对**,不是真实耗时;
//   ② `c.req.routePath` 为空时的兜底(未命中任何路由 → 404 时 routePath 是空串),
//      必须回落到 `new URL(c.req.url).pathname`,否则这些请求会共用一个空 key;
//   ③ **按路由分级预算**(2026-10-12 起):封面走封面档、音频流走流档、其余走全局
//      默认;日志必须带上"预算"与"调用方",否则下次噪音复现时又无从下手。
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// 慢请求日志的入参断言需要观察 log.warn;vi.mock 工厂会被提升,故用 vi.hoisted 承载 spy。
const H = vi.hoisted(() => ({ warn: vi.fn() }));
vi.mock("../../src/utils/logger.js", () => ({
  createLogger: () => ({
    warn: H.warn,
    info: vi.fn(),
    debug: vi.fn(),
    error: vi.fn(),
  }),
}));

import { Hono } from "hono";
import {
  metricsMiddleware,
  getRequestMetrics,
  slowThresholdMs,
  clientTag,
  SLOW_MS,
  SLOW_MS_COVER,
  SLOW_MS_STREAM,
} from "../../src/middleware/metrics.js";

beforeEach(() => {
  H.warn.mockClear();
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

describe("慢请求阈值分级(A: 按路由豁免降噪)", () => {
  it("预算表:封面走封面档、流走流档、未列出的回落全局默认", () => {
    expect(slowThresholdMs("GET", "/rest/getCoverArt")).toBe(SLOW_MS_COVER);
    expect(slowThresholdMs("GET", "/rest/getCoverArt.view")).toBe(SLOW_MS_COVER);
    expect(slowThresholdMs("POST", "/rest/getCoverArt")).toBe(SLOW_MS_COVER);
    expect(slowThresholdMs("POST", "/rest/getCoverArt.view")).toBe(SLOW_MS_COVER);
    expect(slowThresholdMs("GET", "/rest/stream")).toBe(SLOW_MS_STREAM);
    expect(slowThresholdMs("GET", "/rest/stream.view")).toBe(SLOW_MS_STREAM);
    expect(slowThresholdMs("GET", "/rest/dlna/stream/:token")).toBe(SLOW_MS_STREAM);
    // 没进覆盖表的接口一律保持全局底线 —— 分级是豁免已知的慢,不是抬高全局底线。
    expect(slowThresholdMs("GET", "/rest/getAlbumList")).toBe(SLOW_MS);
    expect(slowThresholdMs("GET", "/api/v1/library/songs")).toBe(SLOW_MS);
  });

  it("默认值有明确顺序与下界:全局 1000 < 封面 5000 < 流 7000(流档必须盖过 6s 有界等待)", () => {
    expect(SLOW_MS).toBe(1000);
    expect(SLOW_MS_COVER).toBe(5000);
    expect(SLOW_MS_STREAM).toBe(7000);
    expect(SLOW_MS_STREAM).toBeGreaterThan(6000); // STREAM_BUFFER_HEAD_WAIT_MS 默认 6s
  });

  it("方法大小写敏感:小写 get 不命中覆盖表(防误配成漏报)", () => {
    expect(slowThresholdMs("get", "/rest/getCoverArt")).toBe(SLOW_MS);
  });

  it("封面 1500ms 不再告警 —— 旧 1s 硬阈值下的典型误报", async () => {
    let t = 1_700_000_000_000;
    vi.spyOn(Date, "now").mockImplementation(() => t);

    const app = new Hono();
    app.use("*", metricsMiddleware);
    app.get("/rest/getCoverArt", (c) => {
      t += 1500;
      return c.json({ ok: true });
    });

    const before = getRequestMetrics().slowCount;
    await app.request("/rest/getCoverArt");
    expect(getRequestMetrics().slowCount - before).toBe(0);
  });

  it("封面 5000ms 仍告警(降噪不是失明),日志带 ms/budget/route", async () => {
    let t = 1_700_000_000_000;
    vi.spyOn(Date, "now").mockImplementation(() => t);

    const app = new Hono();
    app.use("*", metricsMiddleware);
    app.get("/rest/getCoverArt", (c) => {
      t += 5000;
      return c.json({ ok: true });
    });

    const before = getRequestMetrics().slowCount;
    await app.request("/rest/getCoverArt");

    expect(getRequestMetrics().slowCount - before).toBe(1);
    expect(H.warn).toHaveBeenCalledTimes(1);
    const payload: any = H.warn.mock.calls[0][1];
    expect(payload.route).toBe("/rest/getCoverArt");
    expect(payload.ms).toBe(5000);
    expect(payload.budget).toBe(SLOW_MS_COVER);
  });

  it("流端点 3000ms 不告警、7000ms 才告警", async () => {
    let t = 1_700_000_000_000;
    vi.spyOn(Date, "now").mockImplementation(() => t);

    // 注意:handler 必须按"本次请求耗时"推进时钟。若改成请求前先 t += 4000,
    // 中间件的 start 会一起平移,ms 依旧等于单次增量 —— 那样测的是错觉。
    let dur = 3000;
    const app = new Hono();
    app.use("*", metricsMiddleware);
    app.get("/rest/stream", (c) => {
      t += dur;
      return c.json({ ok: true });
    });

    const before = getRequestMetrics().slowCount;
    await app.request("/rest/stream");
    expect(getRequestMetrics().slowCount - before).toBe(0);

    dur = 7000;
    await app.request("/rest/stream");
    expect(getRequestMetrics().slowCount - before).toBe(1);
  });

  it("未分级路由 1500ms 照旧告警(分级只豁免白名单)", async () => {
    let t = 1_700_000_000_000;
    vi.spyOn(Date, "now").mockImplementation(() => t);

    const app = new Hono();
    app.use("*", metricsMiddleware);
    app.get("/v1/unrated", (c) => {
      t += 1500;
      return c.json({ ok: true });
    });

    const before = getRequestMetrics().slowCount;
    await app.request("/v1/unrated");
    expect(getRequestMetrics().slowCount - before).toBe(1);
    expect((H.warn.mock.calls[0][1] as any).budget).toBe(SLOW_MS);
  });

  it("慢请求日志带调用方标识:x-mf-client-id 优先,缺失回落 UA 片段", async () => {
    let t = 1_700_000_000_000;
    vi.spyOn(Date, "now").mockImplementation(() => t);

    const app = new Hono();
    app.use("*", metricsMiddleware);
    const bump = (c: any) => {
      t += 1500;
      return c.json({ ok: true });
    };
    app.get("/v1/with-id", bump);
    app.get("/v1/no-id", bump);

    await app.request("/v1/with-id", {
      headers: {
        "x-mf-client-id": "app-990323468a57",
        "user-agent": "MusicFlow/5.8.1 (Windows)",
      },
    });
    expect((H.warn.mock.calls[0][1] as any).client).toBe("app-990323468a57");

    H.warn.mockClear();
    await app.request("/v1/no-id", { headers: { "user-agent": "Mozilla/5.0 (X11)" } });
    expect((H.warn.mock.calls[0][1] as any).client).toBe("ua:Mozilla/5.0 (X11)");
  });

  it("clientTag 纯函数边界:超长截断到 40、两者皆空回 '-'、客户端 ID 压过 UA", () => {
    expect(clientTag("app-1", "UA/1")).toBe("app-1");
    expect(clientTag(undefined, "UA/1")).toBe("ua:UA/1");
    expect(clientTag(undefined, undefined)).toBe("-");
    expect(clientTag("", "")).toBe("-");
    expect(clientTag("x".repeat(100), undefined)).toHaveLength(40);
    expect(clientTag(undefined, "y".repeat(100))).toBe("ua:" + "y".repeat(40));
  });
});
