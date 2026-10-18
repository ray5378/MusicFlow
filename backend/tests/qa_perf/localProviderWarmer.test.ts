// 首页冷启动后台预热(优化 #4)的契约测试。
//
// 背景:进程刚启动(或内存缓存被 reclaim 清空)时 providerRecommendCache 为空,首页首个
// /v1/local-recommend 会对每个声明 TTL 的榜单插件走 raceDeadline,硬等
// LOCAL_PROVIDER_DEADLINE_MS(2500ms)—— 生产日志实测慢请求 ms=2582/2484/1756/1521/1208。
// 现改为后台定时预热(warmLocalProvidersOnce):把「每进程首启一次」的沙箱冷启动成本挪到
// 无人等待的时间窗口。
//
// 契约:
//   1) 只预热声明 recommendCacheTtlSeconds>0 的插件(内置「本地随机」每次重洗,预热无意义);
//   2) 预热与请求路径共用同一在途单飞表(同一 provider 任意时刻至多一次沙箱调用);
//   3) 预热写入 providerRecommendCache 后请求路径直接命中、不再触发沙箱;
//   4) 缓存仍新鲜时不重复拉;过期后预热会重拉。
import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";

const f = vi.hoisted(() => ({
  getEnabledByCapability: vi.fn(() => [] as any[]),
  getPluginConfig: vi.fn(() => ({}) as any),
}));

// 以真实模块为底,只把「插件发现/配置」入口换成受控假体(与 qa_perf/providerCache.test.ts 同款)。
vi.mock("../../src/routes/api/shared.js", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const { overrides } = await import("../routes/_sharedFakes.js");
  return { ...actual, ...overrides, ...f };
});

import { clearProviderRecommendCache } from "../../src/routes/api/shared.js";
import {
  registerRecommend,
  __warmLocalProvidersOnceForTest,
  __resetRecommendRefreshStateForTest,
} from "../../src/routes/api/recommend.js";

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
  manifest: {
    id,
    capabilities: ["localPlatformRecommend"],
    ...(ttl === undefined ? {} : { recommendCacheTtlSeconds: ttl }),
  },
  impl: { recommendLocal: fn },
});

const channels = (source = "chart") => ({ channels: [{ source, sortOrder: 1, playlists: [] }] });

beforeEach(() => {
  clearProviderRecommendCache();
  __resetRecommendRefreshStateForTest();
  f.getEnabledByCapability.mockReset().mockReturnValue([]);
  f.getPluginConfig.mockReset().mockReturnValue({});
});

describe("local-recommend 冷启动后台预热", () => {
  it("预热声明 TTL 的 provider 一次;随后请求命中预热缓存不再外呼", async () => {
    const fn = vi.fn(async () => channels());
    f.getEnabledByCapability.mockReturnValue([prov("chart-w", 120, fn)]);

    await __warmLocalProvidersOnceForTest();
    expect(fn).toHaveBeenCalledTimes(1);

    const b = await json(await get("/v1/local-recommend"));
    expect(b.channels.length).toBe(1);
    expect(b.pending).toBeUndefined();
    expect(fn).toHaveBeenCalledTimes(1); // 命中预热写入的缓存
  });

  it("未声明 recommendCacheTtlSeconds 的 provider 不预热(内置本地随机每次重洗)", async () => {
    const fn = vi.fn(async () => channels("local"));
    f.getEnabledByCapability.mockReturnValue([prov("local-random-recommend", undefined, fn)]);

    await __warmLocalProvidersOnceForTest();
    expect(fn).toHaveBeenCalledTimes(0);
  });

  it("缓存仍新鲜时不重复预热", async () => {
    const fn = vi.fn(async () => channels());
    f.getEnabledByCapability.mockReturnValue([prov("chart-x", 300, fn)]);

    await json(await get("/v1/local-recommend")); // 首次请求写入缓存
    expect(fn).toHaveBeenCalledTimes(1);

    await __warmLocalProvidersOnceForTest(); // 仍新鲜 → 跳过
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("TTL 过期后预热会重拉(注入假时刻越过 TTL)", async () => {
    const fn = vi.fn(async () => channels());
    f.getEnabledByCapability.mockReturnValue([prov("chart-y", 300, fn)]);
    let fake = Date.now();
    const spy = vi.spyOn(Date, "now").mockImplementation(() => fake);
    try {
      await json(await get("/v1/local-recommend"));
      expect(fn).toHaveBeenCalledTimes(1);

      fake += 301_000; // 越过 300s TTL
      await __warmLocalProvidersOnceForTest();
      expect(fn).toHaveBeenCalledTimes(2);
    } finally {
      spy.mockRestore();
    }
  });

  it("并发两轮预热共享在途单飞:同一 provider 只外呼一次", async () => {
    const fn = vi.fn(async () => channels());
    f.getEnabledByCapability.mockReturnValue([prov("chart-s", 120, fn)]);

    // 两轮同时起跑:第二轮应复用第一轮的在途调用(在途表 key = 插件 id)。
    await Promise.all([__warmLocalProvidersOnceForTest(), __warmLocalProvidersOnceForTest()]);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("预热与请求路径共用单飞表:请求路径不再额外外呼", async () => {
    vi.useFakeTimers();
    try {
      const fn = vi.fn(
        () =>
          new Promise((res) => setTimeout(() => res(channels()), 100)),
      );
      f.getEnabledByCapability.mockReturnValue([prov("chart-p", 120, fn)]);

      const warmP = __warmLocalProvidersOnceForTest();
      await vi.advanceTimersByTimeAsync(50); // 预热发起的调用在途
      const reqP = get("/v1/local-recommend").then((r) => r.json());
      await vi.advanceTimersByTimeAsync(100); // 在途调用 settle(远早于 2500ms 软截止)

      const [, b] = await Promise.all([warmP, reqP]);
      expect(fn).toHaveBeenCalledTimes(1); // 请求路径复用了预热的在途调用
      expect((b as Any).channels.length).toBe(1);
      expect((b as Any).pending).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });
});
