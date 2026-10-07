// recommend 域路由层契约测试 —— src/routes/api/recommend.ts(8 条路由)。
//
// 这一域的核心契约是「能力驱动、不写死插件名」:核心只按 capabilities 遍历插件、
// 合并频道、按 sortOrder 排序,并做缓存。测试锁定的是这些聚合与兜底规则,
// 以及手动刷新入口的六道前置校验(404/400/503/500/502/202)。
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
  // 首页固定卡要查歌单行;换成可控的假 sqlite,两个分支(有行/无行)都能精确构造。
  sqlite: { prepare: vi.fn(() => ({ get: () => undefined as any })) },
}));

vi.mock("../../src/routes/api/shared.js", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const { overrides } = await import("./_sharedFakes.js");
  return { ...actual, ...overrides, ...f };
});

import { recommendCache, clearProviderRecommendCache } from "../../src/routes/api/shared.js";
import { registerRecommend } from "../../src/routes/api/recommend.js";

type Any = any;

const app = new Hono();
app.use("*", async (c: Any, next: Any) => {
  c.set("user", { id: "u1", username: "ray", isAdmin: true });
  await next();
});
registerRecommend(app as Any);

const get = (p: string) => app.request("http://x" + p);
const post = (p: string, body?: Any) =>
  app.request("http://x" + p, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
const json = async (r: Response) => (await r.json()) as Any;

/** 造一个「能力插件」形状。 */
const cap = (id: string, impl?: Any, capabilities: string[] = []) => ({
  manifest: { id, capabilities }, impl,
});

beforeEach(() => {
  recommendCache.clear();
  clearProviderRecommendCache();
  f.firstEnabledByCapability.mockReset().mockReturnValue(undefined);
  f.getEnabledByCapability.mockReset().mockReturnValue([]);
  f.getPlugin.mockReset().mockReturnValue(undefined);
  f.getPluginConfig.mockReset().mockReturnValue({});
  f.listHomeCardPlugins.mockReset().mockReturnValue([]);
  f.dailyRecommendHomeCount.mockReset().mockReturnValue(8);
  f.findLocalRemotePlaylist.mockReset().mockReturnValue(undefined);
  f.dailyApi.mockReset().mockReturnValue({});
  f.localApi.mockReset().mockReturnValue({ generateLocalDailyPlaylist: () => undefined });
  f.comboApi.mockReset().mockReturnValue({ generateComboPlaylist: () => undefined });
  f.runPluginJob.mockReset().mockReturnValue({ started: true, alreadyRunning: false });
  f.startAsyncTask.mockReset().mockReturnValue({ started: true, taskId: "task-1" });
  f.sqlite.prepare.mockReset().mockReturnValue({ get: () => undefined });
});

// ==================== GET /v1/recommend ====================

describe("GET /v1/recommend", () => {
  it("无任何推荐插件 → 200 空频道,providerId 为空串", async () => {
    const b = await json(await get("/v1/recommend"));
    expect(b).toEqual({ success: true, channels: [], providerId: "" });
  });

  it("主插件频道映射:字段兜底、sortOrder 缺省 99、imported 由已入库歌单决定", async () => {
    f.firstEnabledByCapability.mockReturnValue(cap("gmdl", {
      recommend: async () => ({ channels: [{ source: "qq", playlists: [{ id: "p1" }, { id: "p2", name: "榜单" }] }] }),
    }));
    // p1 已入库(带曲目数),p2 未入库
    f.findLocalRemotePlaylist.mockImplementation((id: string) =>
      id === "p1" ? { songCount: 42 } : undefined);

    const b = await json(await get("/v1/recommend"));
    const ch = b.channels[0];
    expect(ch.source).toBe("qq");
    expect(ch.name).toBe("qq"); // name 缺省回落到 source
    expect(ch.count).toBe(0);
    expect(ch.sortOrder).toBe(99);
    expect(ch._pluginId).toBe("gmdl");
    expect(ch.playlists[0]).toMatchObject({ id: "p1", trackCount: "42", imported: true, source: "qq" });
    expect(ch.playlists[1]).toMatchObject({ id: "p2", name: "榜单", trackCount: "", imported: false });
  });

  it("相对封面按插件 baseUrl 拼绝对地址;尾斜杠被去掉,以 / 开头不重复加斜杠", async () => {
    f.firstEnabledByCapability.mockReturnValue(cap("gmdl", {
      recommend: async () => ({
        channels: [{
          source: "qq",
          playlists: [{ id: "a", cover: "img/a.jpg" }, { id: "b", cover: "/img/b.jpg" }, { id: "c", cover: "https://cdn/c.jpg" }],
        }],
      }),
    }));
    f.getPluginConfig.mockReturnValue({ baseUrl: "http://127.0.0.1:8080/" });

    const b = await json(await get("/v1/recommend"));
    const pls = b.channels[0].playlists;
    expect(pls[0].cover).toBe("http://127.0.0.1:8080/img/a.jpg");
    expect(pls[1].cover).toBe("http://127.0.0.1:8080/img/b.jpg");
    // 已是绝对 http(s) 的不动
    expect(pls[2].cover).toBe("https://cdn/c.jpg");
  });

  it("主插件抛错:不阻断其它插件,错误原因回传到响应 error 字段", async () => {
    f.firstEnabledByCapability.mockReturnValue(cap("gmdl", {
      recommend: async () => { throw new Error("上游 502"); },
    }));
    f.getEnabledByCapability.mockReturnValue([
      cap("bili", { recommend: async () => ({ channels: [{ source: "bili", playlists: [] }] }) }),
    ]);
    const b = await json(await get("/v1/recommend"));
    expect(b.error).toBe("上游 502");
    expect(b.channels.map((c: Any) => c.source)).toEqual(["bili"]);
  });

  it("无 recommend 实现的主插件被跳过(不调用、不留错误)", async () => {
    f.firstEnabledByCapability.mockReturnValue(cap("gmdl", {}));
    const b = await json(await get("/v1/recommend"));
    expect(b.channels).toEqual([]);
    expect(b.error).toBeUndefined();
  });

  it("recommendPlaylist 插件并行聚合:排除与主插件同 id 的那个;单个失败只吞自己", async () => {
    f.firstEnabledByCapability.mockReturnValue(cap("gmdl", { recommend: async () => ({ channels: [] }) }));
    f.getEnabledByCapability.mockReturnValue([
      cap("gmdl", { recommend: async () => ({ channels: [{ source: "self", playlists: [] }] }) }),
      cap("qq", { recommend: async () => ({ channels: [{ source: "qq-rank", playlists: [{ id: "x" }] }] }) }),
      cap("kugou", { recommend: async () => { throw new Error("酷狗挂了"); } }),
    ]);
    const b = await json(await get("/v1/recommend"));
    expect(b.channels.map((c: Any) => c.source)).toEqual(["qq-rank"]);
    expect(b.channels[0]._pluginId).toBe("qq");
  });

  it("非 recommend 实现的能力插件被过滤掉", async () => {
    f.getEnabledByCapability.mockReturnValue([cap("noimpl", {})]);
    const b = await json(await get("/v1/recommend"));
    expect(b.channels).toEqual([]);
  });

  it("合并后按 sortOrder 升序(缺省视为 99 排后)", async () => {
    f.firstEnabledByCapability.mockReturnValue(cap("gmdl", {
      recommend: async () => ({ channels: [{ source: "late", sortOrder: 50, playlists: [] }] }),
    }));
    f.getEnabledByCapability.mockReturnValue([
      cap("a", { recommend: async () => ({ channels: [{ source: "first", sortOrder: 1, playlists: [] }] }) }),
      cap("b", { recommend: async () => ({ channels: [{ source: "default", playlists: [] }] }) }),
    ]);
    const b = await json(await get("/v1/recommend"));
    expect(b.channels.map((c: Any) => c.source)).toEqual(["first", "late", "default"]);
  });

  it("首次聚合写缓存,第二次直接命中(不再调用插件)", async () => {
    const recommend = vi.fn(async () => ({ channels: [{ source: "cached", playlists: [] }] }));
    f.firstEnabledByCapability.mockReturnValue(cap("gmdl", { recommend }));

    const b1 = await json(await get("/v1/recommend"));
    expect(b1.channels[0].source).toBe("cached");
    expect(recommend).toHaveBeenCalledTimes(1);

    const b2 = await json(await get("/v1/recommend"));
    expect(b2.channels[0].source).toBe("cached");
    expect(recommend).toHaveBeenCalledTimes(1);
  });

  it("缓存 key 含 recommendPlaylist 插件签名:插件集合变化即不复用旧缓存", async () => {
    const recommend = vi.fn(async () => ({ channels: [{ source: "x", playlists: [] }] }));
    f.firstEnabledByCapability.mockReturnValue(cap("gmdl", { recommend }));

    f.getEnabledByCapability.mockReturnValue([]);
    await get("/v1/recommend");
    // 新增一个 recommendPlaylist 插件 → 签名变化 → 应重新聚合
    f.getEnabledByCapability.mockReturnValue([cap("qq", { recommend: async () => ({ channels: [] }) })]);
    await get("/v1/recommend");
    expect(recommend).toHaveBeenCalledTimes(2);
  });

  it("缓存已过期:立即返回 stale,后台重新聚合后更新缓存(SWR)", async () => {
    const recommend = vi.fn(async () => ({ channels: [{ source: "x", playlists: [] }] }));
    f.firstEnabledByCapability.mockReturnValue(cap("gmdl", { recommend }));
    recommendCache.set("gmdl|", { ts: 0, channels: [{ stale: true }] });
    const b = await json(await get("/v1/recommend"));
    // 过期缓存立即返回(不等外网插件),后台刷新已在途(single-flight)
    expect(b.channels[0].stale).toBe(true);
    expect(recommend).toHaveBeenCalledTimes(1);
    // 后台刷新完成后缓存被更新为聚合结果
    await vi.waitFor(() => {
      expect(recommendCache.get("gmdl|")!.ts).toBeGreaterThan(0);
    }, { timeout: 2000, interval: 20 });
    expect(recommendCache.get("gmdl|")!.channels[0].source).toBe("x");
  });

  it("channels / playlists 非数组时兜底为空数组", async () => {
    f.firstEnabledByCapability.mockReturnValue(cap("gmdl", {
      recommend: async () => ({ channels: [{ source: "s", playlists: "nope" }] }),
    }));
    const b = await json(await get("/v1/recommend"));
    expect(b.channels[0].playlists).toEqual([]);
  });
});

// ==================== GET /v1/local-recommend ====================

describe("GET /v1/local-recommend", () => {
  it("无提供方 → 空频道", async () => {
    expect(await json(await get("/v1/local-recommend"))).toEqual({ success: true, channels: [] });
  });

  it("无 recommendLocal 实现的提供方被跳过", async () => {
    f.getEnabledByCapability.mockReturnValue([cap("x", {})]);
    expect((await json(await get("/v1/local-recommend"))).channels).toEqual([]);
  });

  it("本地歌单字段透传:coverArt/songCount 缺省兜底,imported 恒 true", async () => {
    f.getEnabledByCapability.mockReturnValue([cap("local-random", {
      recommendLocal: async () => ({
        channels: [{
          source: "qq", subtag: "每日更新", tagline: "从你的歌单随机",
          playlists: [{ id: "pl-a", name: "早间", coverArt: "pl-pl-a", songCount: 12 }, {}],
        }],
      }),
    })]);
    const ch = (await json(await get("/v1/local-recommend"))).channels[0];
    expect(ch.name).toBe("qq");
    expect(ch.sortOrder).toBe(99);
    expect(ch.subtag).toBe("每日更新");
    expect(ch.tagline).toBe("从你的歌单随机");
    expect(ch.playlists[0]).toEqual({ id: "pl-a", name: "早间", coverArt: "pl-pl-a", songCount: 12, imported: true });
    expect(ch.playlists[1]).toEqual({ id: "", name: "", coverArt: null, songCount: 0, imported: true });
  });

  it("subtag/tagline 非字符串视为未提供(不原样透传)", async () => {
    f.getEnabledByCapability.mockReturnValue([cap("x", {
      recommendLocal: async () => ({ channels: [{ source: "s", subtag: 123, tagline: null, playlists: [] }] }),
    })]);
    const ch = (await json(await get("/v1/local-recommend"))).channels[0];
    expect(ch.subtag).toBeUndefined();
    expect(ch.tagline).toBeUndefined();
  });

  it("单个提供方抛错只吞自己,不 500;多提供方结果合并后排序", async () => {
    f.getEnabledByCapability.mockReturnValue([
      cap("bad", { recommendLocal: async () => { throw new Error("boom"); } }),
      cap("b", { recommendLocal: async () => ({ channels: [{ source: "second", sortOrder: 2, playlists: [] }] }) }),
      cap("a", { recommendLocal: async () => ({ channels: [{ source: "first", sortOrder: 1, playlists: [] }] }) }),
    ]);
    const b = await json(await get("/v1/local-recommend"));
    expect(b.channels.map((c: Any) => c.source)).toEqual(["first", "second"]);
  });

  it("P1-1:manifest 声明 recommendCacheTtlSeconds 的 provider 结果 TTL 内复用;未声明者每次重算", async () => {
    const cached = vi.fn(async () => ({ channels: [{ source: "chart", sortOrder: 1, playlists: [] }] }));
    const plain = vi.fn(async () => ({ channels: [{ source: "local", sortOrder: 2, playlists: [] }] }));
    f.getEnabledByCapability.mockReturnValue([
      { manifest: { id: "chart-x", capabilities: ["localPlatformRecommend"], recommendCacheTtlSeconds: 120 }, impl: { recommendLocal: cached } },
      { manifest: { id: "local-x", capabilities: ["localPlatformRecommend"] }, impl: { recommendLocal: plain } },
    ]);
    await get("/v1/local-recommend");
    await get("/v1/local-recommend");
    expect(cached).toHaveBeenCalledTimes(1); // 命中结果缓存
    expect(plain).toHaveBeenCalledTimes(2);  // 未声明 → 每次重算
  });
});

// ==================== GET /v1/home/playlist-count ====================

describe("GET /v1/home/playlist-count", () => {
  it("透传每日推荐插件的 homeCount(核心不写死插件名)", async () => {
    f.dailyRecommendHomeCount.mockReturnValue(12);
    expect(await json(await get("/v1/home/playlist-count"))).toEqual({ success: true, count: 12 });
  });
});

// ==================== GET /v1/recommend/home-cards ====================

describe("GET /v1/recommend/home-cards", () => {
  const card = (pluginId: string, over: Any = {}) => ({
    pluginId, name: `卡-${pluginId}`, playlistId: `pl-${pluginId}`,
    position: 0, capabilities: ["recommendPlaylist"], showOnHome: false, ...over,
  });

  it("默认只返回 showOnHome 的卡;?all=1 返回全部", async () => {
    f.listHomeCardPlugins.mockReturnValue([
      card("a", { showOnHome: true }),
      card("b", { showOnHome: false }),
    ]);
    expect((await json(await get("/v1/recommend/home-cards"))).cards.map((c: Any) => c.pluginId)).toEqual(["a"]);
    expect((await json(await get("/v1/recommend/home-cards?all=1"))).cards.map((c: Any) => c.pluginId)).toEqual(["a", "b"]);
  });

  it("排序:位次升序,未固定(position 0)排最后,同位次按 pluginId 字典序", async () => {
    f.listHomeCardPlugins.mockReturnValue([
      card("z", { position: 0, showOnHome: true }),
      card("c", { position: 2, showOnHome: true }),
      card("b", { position: 1, showOnHome: true }),
      card("a", { position: 1, showOnHome: true }),
    ]);
    const b = await json(await get("/v1/recommend/home-cards"));
    expect(b.cards.map((c: Any) => c.pluginId)).toEqual(["a", "b", "c", "z"]);
  });

  it("歌单行存在 → 回填名称/曲目数,封面用标准逻辑 ref pl-<playlistId>", async () => {
    f.listHomeCardPlugins.mockReturnValue([card("a", { showOnHome: true, capabilities: ["recommendPlaylist", "comboPlaylist"] })]);
    f.sqlite.prepare.mockReturnValue({ get: () => ({ id: "pl-a", name: "每日推荐", song_count: 31, cover_art: "pl-pl-a.jpg" }) });
    const c = (await json(await get("/v1/recommend/home-cards"))).cards[0];
    expect(c.playlistName).toBe("每日推荐");
    expect(c.songCount).toBe(31);
    expect(c.isCombo).toBe(true);
    // 必须是标准 ref,而不是 DB 里的原始 cover_art(否则 getCoverArt 查表失败 → 无封面)
    expect(c.coverArt).toBe("pl-pl-a");
  });

  it("歌单行不存在 → 名称空、曲目 0、封面 null(卡片照常给出)", async () => {
    f.listHomeCardPlugins.mockReturnValue([card("ghost", { showOnHome: true })]);
    f.sqlite.prepare.mockReturnValue({ get: () => undefined });
    const c = (await json(await get("/v1/recommend/home-cards"))).cards[0];
    expect(c.playlistName).toBe("");
    expect(c.songCount).toBe(0);
    expect(c.coverArt).toBeNull();
    expect(c.isCombo).toBe(false);
  });
});

// ==================== POST /v1/recommend/refresh ====================

describe("POST /v1/recommend/refresh", () => {
  it("未指定 pluginId:三个目标的同步前置校验,任一能力缺失即 503", async () => {
    f.dailyApi.mockReturnValue(null);
    expect((await post("/v1/recommend/refresh", {})).status).toBe(503);
    f.dailyApi.mockReturnValue({});

    f.localApi.mockReturnValue(null);
    expect((await post("/v1/recommend/refresh", {})).status).toBe(503);
    f.localApi.mockReturnValue({ generateLocalDailyPlaylist: () => undefined });

    f.comboApi.mockReturnValue({});
    expect((await post("/v1/recommend/refresh", {})).status).toBe(503);
  });

  it("只校验被点名的 target(只刷 daily 时 local/roam 能力缺失不影响)", async () => {
    f.localApi.mockReturnValue(null);
    f.comboApi.mockReturnValue(null);
    const r = await post("/v1/recommend/refresh", { targets: ["daily"] });
    expect(r.status).toBe(202);
    expect(f.startAsyncTask).toHaveBeenCalledWith("recommend-refresh", "targets:daily", expect.anything());
  });

  it("全部能力就绪 → 202 + taskId + seedSalt,并标记活动", async () => {
    const r = await post("/v1/recommend/refresh", {});
    expect(r.status).toBe(202);
    const b = await json(r);
    expect(b.started).toBe(true);
    expect(b.taskId).toBe("task-1");
    expect(typeof b.seedSalt).toBe("number");
    expect(f.touch).toHaveBeenCalled();
    expect(f.startAsyncTask).toHaveBeenCalledWith("recommend-refresh", "targets:daily,local,roam", expect.anything());
  });

  it("任务已在跑 → 仍 202,但 started:false + alreadyRunning:true(带上已有 taskId)", async () => {
    f.startAsyncTask.mockReturnValue({ started: false, taskId: "task-running" });
    const r = await post("/v1/recommend/refresh", {});
    expect(r.status).toBe(202);
    expect(await json(r)).toMatchObject({ success: true, started: false, alreadyRunning: true, taskId: "task-running" });
  });

  it("单插件刷新:未知插件 → 404", async () => {
    f.getPlugin.mockReturnValue(undefined);
    const r = await post("/v1/recommend/refresh", { pluginId: "nope" });
    expect(r.status).toBe(404);
    expect((await json(r)).code).toBe("NOT_FOUND");
  });

  it("单插件刷新:能力不含任何可刷新类 → 400", async () => {
    f.getPlugin.mockReturnValue(cap("p1", {}, ["scrobble"]));
    const r = await post("/v1/recommend/refresh", { pluginId: "p1" });
    expect(r.status).toBe(400);
    expect((await json(r)).code).toBe("INVALID_PARAM");
  });

  it.each(["dailyPlaylist", "localPlaylist", "comboPlaylist", "recommendPlaylist", "localPlatformRecommend", "playlistCleanup"])(
    "单插件刷新:能力 %s 属于可刷新类",
    async (capability) => {
      f.getPlugin.mockReturnValue(cap("p1", { runDailyJob: () => undefined }, [capability]));
      expect((await post("/v1/recommend/refresh", { pluginId: "p1" })).status).toBe(202);
    },
  );

  it("单插件刷新:未启用(config 为 null) → 503", async () => {
    f.getPlugin.mockReturnValue(cap("p1", { runDailyJob: () => undefined }, ["dailyPlaylist"]));
    f.getPluginConfig.mockReturnValue(null);
    const r = await post("/v1/recommend/refresh", { pluginId: "p1" });
    expect(r.status).toBe(503);
    expect((await json(r)).code).toBe("UNAVAILABLE");
  });

  it("单插件刷新:插件没有 runDailyJob → 500", async () => {
    f.getPlugin.mockReturnValue(cap("p1", {}, ["dailyPlaylist"]));
    const r = await post("/v1/recommend/refresh", { pluginId: "p1" });
    expect(r.status).toBe(500);
    expect((await json(r)).code).toBe("INTERNAL");
  });

  it("单插件刷新:已在跑 → 200 alreadyRunning(不重复起任务)", async () => {
    f.getPlugin.mockReturnValue(cap("p1", { runDailyJob: () => undefined }, ["dailyPlaylist"]));
    f.runPluginJob.mockReturnValue({ started: false, alreadyRunning: true });
    const r = await post("/v1/recommend/refresh", { pluginId: "p1" });
    expect(r.status).toBe(200);
    expect(await json(r)).toMatchObject({ success: true, alreadyRunning: true, pluginId: "p1" });
  });

  it("单插件刷新:起任务失败(既未 started 也非 alreadyRunning)→ 502", async () => {
    f.getPlugin.mockReturnValue(cap("p1", { runDailyJob: () => undefined }, ["dailyPlaylist"]));
    f.runPluginJob.mockReturnValue({ started: false, alreadyRunning: false });
    const r = await post("/v1/recommend/refresh", { pluginId: "p1" });
    expect(r.status).toBe(502);
    expect((await json(r)).code).toBe("UPSTREAM_ERROR");
  });

  it("单插件刷新:成功 → 202 并透传 force / keywordOnly", async () => {
    f.getPlugin.mockReturnValue(cap("p1", { runDailyJob: () => undefined }, ["dailyPlaylist"]));
    const r = await post("/v1/recommend/refresh", { pluginId: "p1", keywordOnly: true });
    expect(r.status).toBe(202);
    expect(f.runPluginJob).toHaveBeenCalledWith("p1", "runDailyJob", { force: true, keywordOnly: true });
    expect(await json(r)).toMatchObject({ success: true, pluginId: "p1", started: true });
  });

  it("body 非法 JSON → 按空对象处理(等价全量刷新)", async () => {
    const r = await app.request("http://x/v1/recommend/refresh", {
      method: "POST", headers: { "content-type": "application/json" }, body: "{{{",
    });
    expect(r.status).toBe(202);
  });

  it("targets 非数组 → 回落默认三目标", async () => {
    await post("/v1/recommend/refresh", { targets: "daily" });
    expect(f.startAsyncTask).toHaveBeenCalledWith("recommend-refresh", "targets:daily,local,roam", expect.anything());
  });
});
