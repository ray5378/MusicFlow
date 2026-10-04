// QA 独立验证 · P1-1 provider 结果缓存边界(路由层,不依赖工程师测试)
//
// 契约:仅当插件 manifest 显式声明 recommendCacheTtlSeconds>0 才缓存其结果;
//       未声明(含内置 local-random-recommend)/ 声明 0 → 每次都调(「每次刷新不同」关键)。
//       缓存 TTL 过期后必须重算;核心不得写死任何插件名。
import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";

const f = vi.hoisted(() => ({
  firstEnabledByCapability: vi.fn(),
  getEnabledByCapability: vi.fn(() => [] as any[]),
  getPlugin: vi.fn(),
  getPluginConfig: vi.fn(() => ({}) as any),
  listHomeCardPlugins: vi.fn(() => [] as any[]),
  dailyRecommendHomeCount: vi.fn(() => 8),
  findLocalRemotePlaylist: vi.fn(() => undefined as any),
  dailyApi: vi.fn(() => ({} as any)),
  localApi: vi.fn(() => ({ generateLocalDailyPlaylist: () => undefined } as any)),
  comboApi: vi.fn(() => ({ generateComboPlaylist: () => undefined } as any)),
  runPluginJob: vi.fn(() => ({ started: true, alreadyRunning: false }) as any),
  startAsyncTask: vi.fn(() => ({ started: true, taskId: "task-1" }) as any),
  touch: vi.fn(),
  sqlite: { prepare: vi.fn(() => ({ get: () => undefined as any })) },
}));

vi.mock("../../src/routes/api/shared.js", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const { overrides } = await import("../routes/_sharedFakes.js");
  return { ...actual, ...overrides, ...f };
});

import { clearProviderRecommendCache } from "../../src/routes/api/shared.js";
import { registerRecommend } from "../../src/routes/api/recommend.js";

type Any = any;
const app = new Hono();
app.use("*", async (c: Any, next: Any) => {
  c.set("user", { id: "u1", username: "ray", isAdmin: true });
  await next();
});
registerRecommend(app as Any);
const get = (p: string) => app.request("http://x" + p);
const json = async (r: Response) => (await r.json()) as Any;

const prov = (id: string, ttl: unknown, fn: Any) => ({
  manifest: { id, capabilities: ["localPlatformRecommend"], ...(ttl === undefined ? {} : { recommendCacheTtlSeconds: ttl }) },
  impl: { recommendLocal: fn },
});

beforeEach(() => {
  clearProviderRecommendCache();
  f.getEnabledByCapability.mockReset().mockReturnValue([]);
  f.getPluginConfig.mockReset().mockReturnValue({});
});

describe("P1-1 provider 结果缓存边界(核心 manifest 驱动)", () => {
  it("声明 TTL=120 的 provider:2 次请求 recommendLocal 只被调用 1 次", async () => {
    const fn = vi.fn(async () => ({ channels: [{ source: "chart", sortOrder: 1, playlists: [] }] }));
    f.getEnabledByCapability.mockReturnValue([prov("chart-x", 120, fn)]);
    await json(await get("/v1/local-recommend"));
    await json(await get("/v1/local-recommend"));
    // eslint-disable-next-line no-console
    console.log(`[P1-1] ttl=120 → 调用次数 = ${fn.mock.calls.length}`);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("未声明 recommendCacheTtlSeconds 的 provider:每次都调(不被误缓存)", async () => {
    const fn = vi.fn(async () => ({ channels: [{ source: "local", sortOrder: 2, playlists: [] }] }));
    f.getEnabledByCapability.mockReturnValue([prov("local-x", undefined, fn)]);
    for (let i = 0; i < 5; i++) await json(await get("/v1/local-recommend"));
    // eslint-disable-next-line no-console
    console.log(`[P1-1] 未声明 → 5 次请求调用次数 = ${fn.mock.calls.length}`);
    expect(fn).toHaveBeenCalledTimes(5);
  });

  it("声明 TTL=0 的 provider:每次都调(0 视为不缓存)", async () => {
    const fn = vi.fn(async () => ({ channels: [{ source: "zero", sortOrder: 3, playlists: [] }] }));
    f.getEnabledByCapability.mockReturnValue([prov("zero-x", 0, fn)]);
    await json(await get("/v1/local-recommend"));
    await json(await get("/v1/local-recommend"));
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("内置 local-random-recommend(未声明)永不被缓存", async () => {
    const fn = vi.fn(async () => ({ channels: [{ source: "netease", sortOrder: 20, playlists: [] }] }));
    f.getEnabledByCapability.mockReturnValue([prov("local-random-recommend", undefined, fn)]);
    for (let i = 0; i < 3; i++) await json(await get("/v1/local-recommend"));
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it("TTL 过期后重算(注入假时刻越过 120s)", async () => {
    const fn = vi.fn(async () => ({ channels: [{ source: "chart", sortOrder: 1, playlists: [] }] }));
    f.getEnabledByCapability.mockReturnValue([prov("chart-y", 120, fn)]);
    let fake = Date.now();
    const spy = vi.spyOn(Date, "now").mockImplementation(() => fake);
    try {
      await json(await get("/v1/local-recommend"));
      await json(await get("/v1/local-recommend")); // 命中
      expect(fn).toHaveBeenCalledTimes(1);
      fake += 121_000;
      await json(await get("/v1/local-recommend")); // 过期 → 重算
      // eslint-disable-next-line no-console
      console.log(`[P1-1] TTL 过期后调用次数 = ${fn.mock.calls.length}`);
      expect(fn).toHaveBeenCalledTimes(2);
    } finally {
      spy.mockRestore();
    }
  });

  it("缓存命中时返回的是同一份结果内容(channels 一致)", async () => {
    let seq = 0;
    const fn = vi.fn(async () => ({ channels: [{ source: "chart", sortOrder: 1, playlists: [{ id: `p${++seq}`, name: "x" }] }] }));
    f.getEnabledByCapability.mockReturnValue([prov("chart-z", 300, fn)]);
    const b1 = await json(await get("/v1/local-recommend"));
    const b2 = await json(await get("/v1/local-recommend"));
    expect(b1.channels[0].playlists[0].id).toBe("p1");
    expect(b2.channels[0].playlists[0].id).toBe("p1"); // 命中缓存 → 同一结果
    expect(fn).toHaveBeenCalledTimes(1);
  });
});
