// 首页聚合缓存「冷启动预热」判定分支的契约测试(2026-10-20)。
//
// 背景:进程刚启动时内存与 DB 都没有聚合缓存,首页首开必然走请求路径冷拉——而这正是
// 最慢的一次(平台精选聚合要串起 go-music-dl 与各榜单插件的沙箱外呼,实测单插件冷启动
// 1.6~16.6s)。现改为启动后首轮就把这轮外呼挪到「无人等待窗口」里跑:首页首开通常直接
// 命中缓存,不再吃 pending + 8s×18 轮询。
//
// 但**插件未注册时绝不预热**:apiRoutes 早于插件注册挂载,首轮 tick 可能跑在插件就绪前,
// 此时 fetchRecommendChannels 会因无插件返回空频道且无 primaryError,被当成稳态结果写进
// 缓存并保留整个 TTL(5min)——首页会空 5 分钟。故未就绪时必须只返回 false、不落缓存
// (由预热器的短周期冷档重试兜住)。
//
// 契约(覆盖 warmRecommendCacheOnce 的五条分支):
//   1) 无缓存 + 插件未注册 → 不预热、不落缓存,返回 false;
//   2) 无缓存 + 推荐类插件已就绪且聚合出频道 → 发起一轮后台聚合并把**真实频道**写入缓存;
//   3) 无缓存 + 已就绪但聚合结果为空(无 primaryError) → **不落库**(冷启动空结果不得锁住
//      整个 TTL 让首页空 5 分钟;由预热冷档/前端轮询重试兜住);
//   4) 有缓存且新鲜         → 不重复外呼,返回 true;
//   5) 有缓存但已过期       → 后台单飞刷新,返回 true。
import "../plugins/_env.js";

import { beforeEach, describe, expect, it, vi } from "vitest";

// 受控的「插件发现」入口(详见 recommendWarmerBackoff.test.ts 的同款说明)。
const f = vi.hoisted(() => ({
  firstEnabledByCapability: vi.fn(() => undefined as any),
  getEnabledByCapability: vi.fn(() => [] as any[]),
}));

vi.mock("../../src/routes/api/shared.js", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const { overrides } = await import("../routes/_sharedFakes.js");
  return { ...actual, ...overrides, ...f };
});

import {
  warmRecommendCacheOnce,
  __awaitRecommendWarmerForTest,
  __resetRecommendRefreshStateForTest,
} from "../../src/routes/api/recommend.js";
import {
  RECOMMEND_CACHE_TTL_MS,
  recommendCache,
  sqlite,
} from "../../src/routes/api/shared.js";

type Any = any;

/** 主推荐插件假体(impl.recommend 是受控 spy,默认返回空频道)。 */
function providerSpy(channels: Any[] = []) {
  const fn = vi.fn(async () => ({ channels }));
  const plugin = {
    manifest: { id: "go-music-dl", capabilities: ["recommend"] },
    impl: { recommend: fn },
  } as Any;
  return { plugin, fn };
}

/** 一个最简频道(仅供断言「缓存里真的有内容」)。 */
const ONE_CHANNEL = [{ source: "qq", name: "QQ音乐", count: 1, playlists: [] }];

// 插件已就绪时 cacheKey = "<主推荐插件 id>|<推荐歌单插件签名>" = "go-music-dl|"。
const READY_KEY = "go-music-dl|";

beforeEach(() => {
  f.firstEnabledByCapability.mockReset().mockReturnValue(undefined);
  f.getEnabledByCapability.mockReset().mockReturnValue([]);
  // 清内存与 DB 两侧的聚合缓存,避免用例互改(DB 侧 writeAggCache 会 write-through,
  // 若不清,后一个用例可能读到前一个用例写下的「新鲜缓存」而跳过外呼)。
  recommendCache.clear();
  sqlite.prepare("DELETE FROM settings WHERE key LIKE ?").run("recommend.aggCache.%");
  // 清失败退避表与在途刷新表:二者是模块级单例,若不复位,前一个用例(如「冷启动聚合为空」
  // 会记 3s 退避)会让后一个用例的预热被直接跳过 —— 用例顺序敏感、随机种子下偶发红。
  __resetRecommendRefreshStateForTest();
});

describe("warmRecommendCacheOnce 冷启动判定分支", () => {
  it("无缓存 + 插件未注册 → 不预热、不落缓存,返回 false", () => {
    expect(warmRecommendCacheOnce()).toBe(false);
    expect(recommendCache.has("|")).toBe(false);
  });

  it("无缓存 + 主推荐插件已就绪 → 发起一轮后台聚合并写入缓存,返回 true", async () => {
    const { plugin, fn } = providerSpy(ONE_CHANNEL);
    f.firstEnabledByCapability.mockReturnValue(plugin);

    expect(warmRecommendCacheOnce()).toBe(true);
    await __awaitRecommendWarmerForTest();
    expect(fn).toHaveBeenCalledTimes(1);
    // 后台聚合把**真实频道**写进了缓存(稳态,后续首页请求直接命中,不再冷拉)。
    expect(recommendCache.get(READY_KEY)?.channels).toHaveLength(1);
  });

  it("无缓存 + 已就绪但聚合结果为空 → 不落库(冷启动空结果不得锁住 TTL 让首页空 5 分钟)", async () => {
    const { plugin, fn } = providerSpy(); // channels: [] 且不抛错(无 primaryError)
    f.firstEnabledByCapability.mockReturnValue(plugin);

    expect(warmRecommendCacheOnce()).toBe(true);
    await __awaitRecommendWarmerForTest();
    expect(fn).toHaveBeenCalledTimes(1);
    // 关键:空结果绝不能当成稳态缓存落库(否则保留整个 TTL,首页空 5 分钟)。
    expect(recommendCache.has(READY_KEY)).toBe(false);
  });

  it("无主推荐插件但推荐歌单插件已就绪 → 同样视为就绪并预热", async () => {
    f.getEnabledByCapability.mockImplementation(((cap: string) =>
      cap === "recommendPlaylist"
        ? [{ manifest: { id: "qq-charts", capabilities: ["recommendPlaylist"] }, impl: {} }]
        : []) as Any);

    expect(warmRecommendCacheOnce()).toBe(true);
    await __awaitRecommendWarmerForTest();
  });

  it("有缓存且新鲜 → 不重复外呼,返回 true", async () => {
    const { plugin, fn } = providerSpy();
    f.firstEnabledByCapability.mockReturnValue(plugin);
    recommendCache.set(READY_KEY, { ts: Date.now(), channels: [] });

    expect(warmRecommendCacheOnce()).toBe(true);
    await __awaitRecommendWarmerForTest();
    expect(fn).toHaveBeenCalledTimes(0);
  });

  it("有缓存但已过期 → 后台单飞刷新,返回 true", async () => {
    const { plugin, fn } = providerSpy(ONE_CHANNEL);
    f.firstEnabledByCapability.mockReturnValue(plugin);
    recommendCache.set(READY_KEY, {
      ts: Date.now() - RECOMMEND_CACHE_TTL_MS - 1,
      channels: ONE_CHANNEL,
    });

    expect(warmRecommendCacheOnce()).toBe(true);
    await __awaitRecommendWarmerForTest();
    expect(fn).toHaveBeenCalledTimes(1);
  });
});
