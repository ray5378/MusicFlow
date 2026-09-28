// MUST be the first import:隔离 DATA_DIR 后再加载后端模块。
import "../plugins/_env.js";

// recommend 域「插件返回值兜底」契约测试 —— src/routes/api/recommend.ts。
//
// 与 tests/routes/recommendRoutesContract.test.ts 的分工:那份锁定**聚合与排序的
// 主干规则**(多插件合并、缓存、refresh 六道前置校验);这一份锁定**插件返回脏数据
// 时的兜底**,也就是路由里那几十个 `x || ""` / `Array.isArray(...) ? ... : []` 的
// 缺省分支 —— 它们此前一个都没被执行过(行覆盖 100% 但分支覆盖 82%)。
//
// 为什么这些分支必须钉住:推荐链路的输入**全部来自第三方插件**(go-music-dl / 各榜单
// 插件),它们返回的 channels / playlists / source / name 缺字段、类型写错是常态。
// 核心一旦在这里 `ch.name.trim()` 或 `for (const pl of ch.playlists)` 就会把
// **整个首页推荐整单 500**(不是少一个频道),因为 GET /v1/recommend 只 catch 插件
// 调用本身、不 catch 字段映射。前端表现是「首页一片空白」,后端只有一行 TypeError。
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
  // 首页固定卡要查歌单行;换成可控的假 sqlite(本文件不测 home-cards)。
  sqlite: { prepare: vi.fn(() => ({ get: () => undefined as any })) },
}));

vi.mock("../../src/routes/api/shared.js", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const { overrides } = await import("./_sharedFakes.js");
  return { ...actual, ...overrides, ...f };
});

import { recommendCache } from "../../src/routes/api/shared.js";
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
  manifest: { id, capabilities },
  impl,
});

beforeEach(() => {
  recommendCache.clear();
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
  f.touch.mockReset();
  f.sqlite.prepare.mockReset().mockReturnValue({ get: () => undefined });
});

// ==================== GET /v1/recommend:主推荐插件的返回值兜底 ====================

describe("GET /v1/recommend —— 主插件返回值兜底", () => {
  it("主插件没有配置行(getPluginConfig → null)→ 按空配置聚合,不 500", async () => {
    // 契约:插件刚装上还没保存过配置时 config 为 null。核心必须当成 {} —— 否则
    // `config.baseUrl` 直接 TypeError,首页推荐整单 500。
    f.getPluginConfig.mockReturnValue(null);
    f.firstEnabledByCapability.mockReturnValue(cap("gmdl", {
      recommend: async () => ({ channels: [{ source: "qq", playlists: [] }] }),
    }));

    const r = await get("/v1/recommend");
    expect(r.status).toBe(200);
    const b = await json(r);
    expect(b.channels).toEqual([{ source: "qq", name: "qq", count: 0, sortOrder: 99, _pluginId: "gmdl", playlists: [] }]);
    // 无 baseUrl 时相对封面退化成站点相对路径(而不是 "undefined/img/a.jpg")
    recommendCache.clear(); // 换插件返回值前必须清缓存,否则命中的是上一次的聚合结果
    f.firstEnabledByCapability.mockReturnValue(cap("gmdl", {
      recommend: async () => ({ channels: [{ source: "qq", playlists: [{ id: "p", cover: "img/a.jpg" }] }] }),
    }));
    expect((await json(await get("/v1/recommend"))).channels[0].playlists[0].cover).toBe("/img/a.jpg");
  });

  it("主插件返回 null / channels 非数组 → 空频道(不抛、不 500)", async () => {
    // 契约:插件实现写错(返回 undefined / 把 channels 写成对象)不该拖垮首页。
    for (const bad of [null, undefined, {}, { channels: "nope" }, { channels: { a: 1 } }]) {
      recommendCache.clear();
      f.firstEnabledByCapability.mockReturnValue(cap("gmdl", { recommend: async () => bad }));
      const r = await get("/v1/recommend");
      expect(r.status).toBe(200);
      expect((await json(r)).channels).toEqual([]);
    }
  });

  it("频道缺 source / name → 兜底空串;name 优先于 source,两者都缺才是空串", async () => {
    // 契约:前端拿 name 直接渲染分区标题,undefined 会渲染出 "undefined" 字样。
    f.firstEnabledByCapability.mockReturnValue(cap("gmdl", {
      recommend: async () => ({
        channels: [
          { name: "有名字", playlists: [] },              // 缺 source → source "" ,name 保留
          { source: "kugou", playlists: [] },             // 缺 name → name 回落 source
          { playlists: [] },                              // 两者都缺 → 都是 ""
        ],
      }),
    }));

    const chs = (await json(await get("/v1/recommend"))).channels;
    expect(chs[0]).toMatchObject({ source: "", name: "有名字" });
    expect(chs[1]).toMatchObject({ source: "kugou", name: "kugou" });
    expect(chs[2]).toMatchObject({ source: "", name: "" });
  });

  it("歌单缺 source → 回落到频道 source;两者都缺 → 空串(匹配键不得是 undefined)", async () => {
    f.firstEnabledByCapability.mockReturnValue(cap("gmdl", {
      recommend: async () => ({
        channels: [{ source: "qq", playlists: [{ id: "a" }, { id: "b" }] }],
      }),
    }));
    f.findLocalRemotePlaylist.mockReset();
    const seen: Any[] = [];
    f.findLocalRemotePlaylist.mockImplementation((id: string, source: string, name: string) => {
      seen.push([id, source, name]);
      return undefined;
    });

    const pls = (await json(await get("/v1/recommend"))).channels[0].playlists;
    expect(pls[0].source).toBe("qq");                 // 缺 pl.source → 用频道 source
    expect(seen[0]).toEqual(["a", "qq", ""]);         // 传给本地匹配的是**真实字符串**而非 undefined
    expect(pls[0].name).toBe("");
    expect(pls[0].creator).toBe("");
    expect(pls[0].link).toBe("");

    // 频道也没有 source 时,歌单 source 才是空串
    recommendCache.clear();
    f.firstEnabledByCapability.mockReturnValue(cap("gmdl", {
      recommend: async () => ({ channels: [{ playlists: [{ id: "c" }] }] }),
    }));
    expect((await json(await get("/v1/recommend"))).channels[0].playlists[0].source).toBe("");
  });

  it("已入库歌单缺 songCount → trackCount 空串(不能输出 undefined / \"undefined\")", async () => {
    // 契约:trackCount 直接进前端歌单元信息,读到空值必须给空串让前端隐藏,
    // 而不是渲染 "undefined" 或 "null"。
    f.firstEnabledByCapability.mockReturnValue(cap("gmdl", {
      recommend: async () => ({ channels: [{ source: "qq", playlists: [{ id: "p1" }] }] }),
    }));
    f.findLocalRemotePlaylist.mockReturnValue({ id: "local-1", name: "已入库" }); // 没有 songCount 字段

    const pl = (await json(await get("/v1/recommend"))).channels[0].playlists[0];
    expect(pl.trackCount).toBe("");
    expect(pl.imported).toBe(true);
  });

  it("主插件抛的**不是 Error**(字符串 / 纯对象)→ 错误原因照样回传,且不 500", async () => {
    // 契约:插件里 `throw "上游 502"` 这种裸抛出很常见。`e?.message || e` 就是为它准备的。
    for (const thrown of ["上游 502", { code: 502 }, 42]) {
      recommendCache.clear();
      f.firstEnabledByCapability.mockReturnValue(cap("gmdl", {
        recommend: async () => { throw thrown; },
      }));
      const r = await get("/v1/recommend");
      expect(r.status).toBe(200);
      const b = await json(r);
      expect(b.success).toBe(true);
      expect(typeof b.error).toBe("string");
      expect(b.error.length).toBeGreaterThan(0);
      expect(b.channels).toEqual([]);
    }
  });
});

// ==================== GET /v1/recommend:recommendPlaylist 插件的返回值兜底 ====================

describe("GET /v1/recommend —— 榜单插件返回值兜底", () => {
  it("榜单插件没有配置行 → 按空配置调用,不 500", async () => {
    f.getPluginConfig.mockReturnValue(null);
    f.getEnabledByCapability.mockReturnValue([
      cap("qq", { recommend: async () => ({ channels: [{ source: "qq-rank", playlists: [] }] }) }),
    ]);

    const r = await get("/v1/recommend");
    expect(r.status).toBe(200);
    expect((await json(r)).channels).toEqual([
      { source: "qq-rank", name: "qq-rank", count: 0, sortOrder: 99, _pluginId: "qq", playlists: [] },
    ]);
  });

  it("channels / playlists 非数组 → 该插件不产出频道,其它插件不受影响", async () => {
    f.getEnabledByCapability.mockReturnValue([
      cap("bad1", { recommend: async () => null }),
      cap("bad2", { recommend: async () => ({ channels: {} }) }),
      cap("bad3", { recommend: async () => ({ channels: [{ source: "s3", playlists: "nope" }] }) }),
      cap("good", { recommend: async () => ({ channels: [{ source: "ok", playlists: [{ id: "g1" }] }] }) }),
    ]);

    const b = await json(await get("/v1/recommend"));
    // 前三个插件各自产出 0 个频道;bad3 的频道会被产出,但 playlists 兜底成空数组
    const bySource = Object.fromEntries(b.channels.map((c: Any) => [c.source, c]));
    expect(Object.keys(bySource)).toEqual(["s3", "ok"]);
    expect(bySource.s3.playlists).toEqual([]);
    expect(bySource.ok.playlists).toHaveLength(1);
  });

  it("频道与歌单缺字段 → 兜底空串(榜单插件的映射与主插件同源)", async () => {
    f.getEnabledByCapability.mockReturnValue([
      cap("qq", {
        recommend: async () => ({
          channels: [
            { playlists: [{ id: "x" }] },                    // 频道缺 source/name,歌单缺 source/name
            { source: "kg", playlists: [{ id: "y", name: "热歌" }] },
          ],
        }),
      }),
    ]);

    const chs = (await json(await get("/v1/recommend"))).channels;
    expect(chs[0]).toMatchObject({ source: "", name: "" });
    expect(chs[0].playlists[0]).toMatchObject({ id: "x", source: "", name: "", creator: "", link: "", imported: false, trackCount: "" });
    expect(chs[1].playlists[0]).toMatchObject({ id: "y", source: "kg", name: "热歌" });
  });

  it("榜单插件抛非 Error → 只吞自己,不 500,也不污染主插件的 error 字段", async () => {
    f.firstEnabledByCapability.mockReturnValue(cap("gmdl", {
      recommend: async () => ({ channels: [{ source: "main", playlists: [] }] }),
    }));
    f.getEnabledByCapability.mockReturnValue([
      cap("kugou", { recommend: async () => { throw "酷狗挂了"; } }),
      cap("qq", { recommend: async () => ({ channels: [{ source: "qq", playlists: [] }] }) }),
    ]);

    const r = await get("/v1/recommend");
    expect(r.status).toBe(200);
    const b = await json(r);
    // 只有**主**插件失败才回传 error;榜单插件失败静默跳过(避免前端弹一堆无关报错)
    expect(b.error).toBeUndefined();
    expect(b.channels.map((c: Any) => c.source)).toEqual(["main", "qq"]);
  });

  it("sortOrder 是非数字(字符串 / 布尔 / null)→ 一律视为 99 排最后", async () => {
    // 契约:插件把 sortOrder 写成 "1" 很常见。若直接参与减法会得到 NaN,
    // Array.sort 的比较函数返回 NaN 时顺序**未定义** —— 首页每次刷新顺序都可能变。
    f.firstEnabledByCapability.mockReturnValue(cap("gmdl", {
      recommend: async () => ({ channels: [{ source: "pinned", sortOrder: 1, playlists: [] }] }),
    }));
    f.getEnabledByCapability.mockReturnValue([
      cap("a", { recommend: async () => ({ channels: [{ source: "str-order", sortOrder: "2", playlists: [] }] }) }),
      cap("b", { recommend: async () => ({ channels: [{ source: "bool-order", sortOrder: true, playlists: [] }] }) }),
      cap("c", { recommend: async () => ({ channels: [{ source: "null-order", sortOrder: null, playlists: [] }] }) }),
    ]);

    const srcs = (await json(await get("/v1/recommend"))).channels.map((c: Any) => c.source);
    expect(srcs[0]).toBe("pinned");                                  // 唯一有数字 sortOrder 的排最前
    expect(srcs.slice(1).sort()).toEqual(["bool-order", "null-order", "str-order"]); // 其余都是 99
  });
});

// ==================== GET /v1/local-recommend ====================

describe("GET /v1/local-recommend —— 提供方返回值兜底", () => {
  it("提供方没有配置行 → 按空配置调用,不 500", async () => {
    f.getPluginConfig.mockReturnValue(null);
    f.getEnabledByCapability.mockReturnValue([
      cap("local-random", {
        recommendLocal: async () => ({ channels: [{ source: "local", playlists: [] }] }),
      }),
    ]);

    const r = await get("/v1/local-recommend");
    expect(r.status).toBe(200);
    expect((await json(r)).channels[0]).toMatchObject({ source: "local", name: "local", sortOrder: 99 });
  });

  it("channels / playlists 非数组 → 该提供方不产出频道", async () => {
    f.getEnabledByCapability.mockReturnValue([
      cap("a", { recommendLocal: async () => null }),
      cap("b", { recommendLocal: async () => ({ channels: "nope" }) }),
      cap("c", { recommendLocal: async () => ({ channels: [{ source: "s", playlists: 42 }] }) }),
    ]);

    const b = await json(await get("/v1/local-recommend"));
    // c 的频道会被产出,但 playlists 兜底成空数组
    expect(b.channels).toHaveLength(1);
    expect(b.channels[0].playlists).toEqual([]);
  });

  it("频道缺 source / name → 兜底空串;歌单缺字段 → 空串 / null / 0,imported 恒 true", async () => {
    f.getEnabledByCapability.mockReturnValue([
      cap("x", { recommendLocal: async () => ({ channels: [{ playlists: [{}] }] }) }),
    ]);

    const ch = (await json(await get("/v1/local-recommend"))).channels[0];
    expect(ch.source).toBe("");
    expect(ch.name).toBe("");
    expect(ch.count).toBe(0);
    expect(ch.subtag).toBeUndefined();
    expect(ch.tagline).toBeUndefined();
    // 本地歌单:一律 imported=true(它本来就在本地库里)
    expect(ch.playlists[0]).toEqual({ id: "", name: "", coverArt: null, songCount: 0, imported: true });
  });

  it("提供方抛非 Error → 只吞自己,其它提供方照常出频道", async () => {
    f.getEnabledByCapability.mockReturnValue([
      cap("bad", { recommendLocal: async () => { throw { msg: "炸了" }; } }),
      cap("good", { recommendLocal: async () => ({ channels: [{ source: "ok", playlists: [] }] }) }),
    ]);

    const r = await get("/v1/local-recommend");
    expect(r.status).toBe(200);
    expect((await json(r)).channels.map((c: Any) => c.source)).toEqual(["ok"]);
  });

  it("sortOrder 非数字 → 视为 99(本地分区顺序不得因插件写错而抖动)", async () => {
    f.getEnabledByCapability.mockReturnValue([
      cap("a", { recommendLocal: async () => ({ channels: [{ source: "fixed", sortOrder: 0, playlists: [] }] }) }),
      cap("b", { recommendLocal: async () => ({ channels: [{ source: "str", sortOrder: "5", playlists: [] }] }) }),
    ]);

    expect((await json(await get("/v1/local-recommend"))).channels.map((c: Any) => c.source)).toEqual(["fixed", "str"]);
  });
});

// ==================== POST /v1/recommend/refresh ====================

describe("POST /v1/recommend/refresh —— manifest 形状兜底", () => {
  it("manifest 完全没有 capabilities 字段 → 视为不可刷新 → 400(不 500、不 500 地崩在 includes 上)", async () => {
    // 契约:老插件 / 手写的 manifest 可能不声明 capabilities。`|| []` 必须兜住,
    // 否则 `caps.includes` 抛 TypeError,刷新按钮变成 500 白屏。
    f.getPlugin.mockReturnValue({ manifest: { id: "legacy" }, impl: { runDailyJob: () => undefined } });

    const r = await post("/v1/recommend/refresh", { pluginId: "legacy" });
    expect(r.status).toBe(400);
    expect((await json(r)).code).toBe("INVALID_PARAM");
    expect(f.runPluginJob).not.toHaveBeenCalled();
  });
});
