// 播放来源优先级(Stream source priority,**仅插件级**):
//   - 模块级:规范化(历史 `plugin:platform` 收敛为插件级) / settings 读写 /
//     listAvailableStreamSources(每个源插件恰好一条);
//   - 链路级:findFallbackStream 在「列表为空 → 旧行为;列表非空 → 严格按列表顺序」下的
//     取源行为,覆盖:本尊不享有特权、插件级走插件自身 sourcePreference(不再透传 sources)、
//     纯 stream 插件走 resolveStream、search 抛错/网络异常仍按 transient 退避、
//     全部明确失败才写负结果。
// MUST be the first import: redirects DATA_DIR to an isolated temp dir.
import "../plugins/_env.js";

import { describe, it, expect, beforeEach, beforeAll, afterEach, vi } from "vitest";
import { Hono } from "hono";
import md5 from "md5";
import { eq } from "drizzle-orm";
import { initDatabase, db, sqlite, encryptPassword } from "../../src/db/index.js";
import { songs, users } from "../../src/db/schema.js";
import { registerPlugin, unregisterPlugin } from "../../src/plugins/registry.js";
import { _resetSettingsCacheForTest } from "../../src/services/settings.js";
import { authMiddleware } from "../../src/middleware/auth.js";
import { apiRoutes } from "../../src/routes/api/index.js";
import { runWithLocale, parseLocale } from "../../src/i18n.js";
import {
  STREAM_SOURCE_PRIORITY_KEY,
  getStreamSourcePriority,
  setStreamSourcePriority,
  normalizeStreamSourcePriority,
  listAvailableStreamSources,
} from "../../src/services/source/online/streamSourcePriority.js";
import {
  clearStreamFallbackCache,
  findFallbackStream,
  getCachedPlayability,
} from "../../src/services/source/online/streamFallback.js";

initDatabase();

// ---- 路由级测试的 app 引导(与 QA 路由合同测试同款:real auth + apiRoutes) ----
const app = new Hono();
app.use("*", async (c, next) =>
  runWithLocale(parseLocale(c.req.header("x-mf-lang") ?? c.req.header("accept-language")), () => next()),
);
app.use("/rest/api/*", authMiddleware);
app.route("/rest/api", apiRoutes);

const ADMIN_PASS = "hunter2";
const CLIENT_SALT = "clientsalt123";
const adminQs = `u=alice&t=${md5(ADMIN_PASS + CLIENT_SALT)}&s=${CLIENT_SALT}`;

beforeAll(() => {
  if (!process.env.APP_VERSION) process.env.APP_VERSION = "1.0.0";
  if (!db.select().from(users).where(eq(users.username, "alice")).get()) {
    db.insert(users).values({
      id: "u-admin", username: "alice", password: "", salt: "salt", subsonicSalt: "subsalt",
      passEnc: encryptPassword(ADMIN_PASS), isAdmin: 1, isActive: 1, email: "alice@b.c",
    }).run();
  }
});

const NOW = new Date().toISOString();

// ---- plugin registration helpers --------------------------------------------

const cleanups: Array<() => void> = [];

function persistEnabled(id: string, manifest: any) {
  sqlite
    .prepare(
      "INSERT INTO plugins (id, name, version, description, manifest, enabled, config, created_at, updated_at) VALUES (?,?,?,?,?,1,'{}',?,?) ON CONFLICT(id) DO UPDATE SET enabled = 1, manifest = excluded.manifest",
    )
    .run(id, id, manifest.version || "1.0.0", "", JSON.stringify(manifest), NOW, NOW);
}

/** 注册一个源插件;enabled=false 时只进 registry、不落库(用于验证「未启用被排除」)。 */
function reg(id: string, caps: string[], impl: any, extra: Record<string, any> = {}, enabled = true): void {
  const manifest = {
    id,
    name: extra.name || id,
    version: "1.0.0",
    type: "source",
    capabilities: caps,
    platforms: extra.platforms || [],
    configSchema: [],
    permissions: ["net"],
    ...extra,
  };
  registerPlugin(manifest as any, impl);
  if (enabled) persistEnabled(id, manifest);
  cleanups.push(() => {
    try { unregisterPlugin(id); } catch { /* already gone */ }
    try { sqlite.prepare("DELETE FROM plugins WHERE id = ?").run(id); } catch { /* noop */ }
  });
}

function insertSong(id: string, pluginEntry = "gmd", sourceData = JSON.stringify({ source: "kuwo", remoteId: "1" })) {
  db.insert(songs)
    .values({ id, title: "碎碎念", artist: "队长", album: "", duration: 240, path: `/tmp/${id}.mp3`, type: "web", pluginEntry, sourceData })
    .run();
  cleanups.push(() => { try { sqlite.prepare("DELETE FROM songs WHERE id = ?").run(id); } catch { /* noop */ } });
}

/** 造一个能过 importGate 的候选(name/artist/duration 与期望一致,album 空 → 期望侧空则跳过)。 */
function cand(source: string, url?: string) {
  return { id: source, source, name: "碎碎念", artist: "队长", album: "", duration: 240, cover: "", url: url || `http://x/${source}.mp3` };
}

const RESP_OK = () => new Response(new ArrayBuffer(16), { status: 206, headers: { "content-type": "audio/mpeg" } });
const RESP_GONE = () => new Response(new ArrayBuffer(4), { status: 404, headers: { "content-type": "text/html" } });

function clearPrioritySetting() {
  sqlite.prepare("DELETE FROM settings WHERE key = ?").run(STREAM_SOURCE_PRIORITY_KEY);
  _resetSettingsCacheForTest();
}

beforeEach(() => {
  clearStreamFallbackCache();
  clearPrioritySetting();
});

afterEach(() => {
  vi.unstubAllGlobals();
  while (cleanups.length) cleanups.pop()!();
  clearPrioritySetting();
});

// ==================== 1. 规范化(仅插件级) ====================

describe("streamSourcePriority:规范化收敛为插件级", () => {
  it("normalize:去空白 / 去重 / 丢非字符串 / 历史 plugin:platform 收敛为插件级", () => {
    expect(normalizeStreamSourcePriority(["a", "a", "b", 1, "", "c:netease", "c:netease"]))
      .toEqual(["a", "b", "c"]); // "c:netease" 收敛为 "c"
    expect(normalizeStreamSourcePriority(["  gmd  ", "gmd"])).toEqual(["gmd"]); // trim + 去重
    expect(normalizeStreamSourcePriority(["gmd:kuwo", "gmd:netease"])).toEqual(["gmd"]); // 同一插件收敛合并
    expect(normalizeStreamSourcePriority([":kuwo", "x:"])).toEqual(["x"]); // `:` 前为空 → 丢弃;`x:` → x
    expect(normalizeStreamSourcePriority("notarray")).toEqual([]);
    expect(normalizeStreamSourcePriority(null)).toEqual([]);
  });

  it("set/get:规范化后落库,读回一致", () => {
    setStreamSourcePriority(["lx", "lx", "gmd:netease", 42]);
    expect(getStreamSourcePriority()).toEqual(["lx", "gmd"]); // 收敛为插件级
    setStreamSourcePriority([]);
    expect(getStreamSourcePriority()).toEqual([]);
  });
});

// ==================== 2. listAvailableStreamSources ====================

describe("listAvailableStreamSources", () => {
  it("只列已启用且含 stream/search 能力的源插件;每个插件恰好一条(仅插件级,无 kind)", () => {
    reg("gmd-ish", ["search", "stream"], {}, {
      name: "GMD", sourcePreference: ["netease", "kuwo"], platformLabels: { netease: "网易云" },
    });
    reg("lx-ish", ["stream"], {}, { name: "LX" });
    reg("verify-ish", ["search"], {}, { name: "HUAWEI" });
    reg("album-ish", ["playlistSongs"], {}, { name: "ALBUM" });
    reg("disabled-ish", ["stream", "search"], {}, { name: "DISABLED" }, false);

    const out = listAvailableStreamSources();

    expect(out).toContainEqual({ value: "gmd-ish", label: "GMD" });
    expect(out).toContainEqual({ value: "lx-ish", label: "LX" });
    expect(out).toContainEqual({ value: "verify-ish", label: "HUAWEI" });

    // 每个插件恰好一条,且不含平台级 value / kind 字段
    expect(out.filter((s) => s.value === "gmd-ish").length).toBe(1);
    expect(out.find((s) => s.value.includes(":"))).toBeUndefined(); // 不再有 pluginId:platform
    expect(out.every((s) => !("kind" in s))).toBe(true); // 已无 kind 字段

    expect(out.find((s) => s.value === "album-ish")).toBeUndefined(); // 无 stream/search
    expect(out.find((s) => s.value === "disabled-ish")).toBeUndefined(); // 未启用
  });
});

// ==================== 3. findFallbackStream 优先级取源 ====================

/** 注册本尊 gmd:search+stream,sourcePreference 内置 netease 优先。 */
function regPrimary(searchFn: any): { calls: any[] } {
  const calls: any[] = [];
  reg("gmd", ["search", "stream"], {
    search: (...args: any[]) => { calls.push(args[1]); return searchFn(...args); },
    streamUrl: (_cfg: any, song: any) => String(song.url || ""),
  }, { name: "GMD", sourcePreference: ["netease", "kuwo"] });
  return { calls };
}

describe("findFallbackStream:播放来源优先级", () => {
  it("① 列表为空 → 旧行为:本尊优先(本尊命中,其它插件不被尝试)", async () => {
    const { calls } = regPrimary(async () => ({ songs: [cand("netease", "http://gmd/netease.mp3")] }));
    const otherCalls: string[] = [];
    reg("other", ["search", "stream"], {
      search: async () => { otherCalls.push("other"); return { songs: [cand("kuwo", "http://other/kuwo.mp3")] }; },
      streamUrl: (_cfg: any, song: any) => String(song.url || ""),
    });
    insertSong("p-empty");
    vi.stubGlobal("fetch", vi.fn(async () => RESP_OK()));

    const r = await findFallbackStream("p-empty", "碎碎念", "队长", "", 240, "gmd", "qq");

    expect(r).toEqual({ url: "http://gmd/netease.mp3", source: "netease" });
    expect(calls.length).toBe(1);
    expect(otherCalls).toEqual([]); // 本尊命中即止,不回退其它插件
  });

  it("② 列表非空且本尊不在列表 → 严格按列表顺序,本尊不被优先", async () => {
    const { calls: gmdCalls } = regPrimary(async () => ({ songs: [cand("netease", "http://gmd/netease.mp3")] }));
    const otherCalls: string[] = [];
    reg("other", ["search", "stream"], {
      search: async () => { otherCalls.push("other"); return { songs: [cand("kuwo", "http://other/kuwo.mp3")] }; },
      streamUrl: (_cfg: any, song: any) => String(song.url || ""),
    });
    insertSong("p-other-first");
    setStreamSourcePriority(["other"]);
    vi.stubGlobal("fetch", vi.fn(async () => RESP_OK()));

    const r = await findFallbackStream("p-other-first", "碎碎念", "队长", "", 240, "gmd", "qq");

    expect(r).toEqual({ url: "http://other/kuwo.mp3", source: "kuwo" });
    expect(otherCalls).toEqual(["other"]);
    expect(gmdCalls).toEqual([]); // 本尊 gmd 不在列表 → 完全不被尝试
  });

  it("③ 历史 pluginId:platform 条目等价于插件级(收敛为 plugin id,不再限定平台/不再透传 sources)", async () => {
    // gmd 内置 sourcePreference 把 netease 排在前。传入 "gmd:kuwo" 收敛为 "gmd" →
    // 走插件自身 sourcePreference(netease 优先),**不再**只接受 kuwo。
    const { calls } = regPrimary(async () => ({ songs: [cand("netease", "http://gmd/netease.mp3"), cand("kuwo", "http://gmd/kuwo.mp3")] }));
    insertSong("p-platform");
    setStreamSourcePriority(["gmd:kuwo"]);
    vi.stubGlobal("fetch", vi.fn(async () => RESP_OK()));

    const r = await findFallbackStream("p-platform", "碎碎念", "队长", "", 240, "gmd", "qq");

    expect(r).toEqual({ url: "http://gmd/netease.mp3", source: "netease" }); // 插件自身偏好优先
    // 不再透传 sources,只传 query
    expect(calls[0]).toEqual({ query: "碎碎念 队长" });
  });

  it("④ 纯 stream 插件条目走 resolveStream,不调用 search", async () => {
    const { calls: gmdCalls } = regPrimary(async () => ({ songs: [cand("netease", "http://gmd/netease.mp3")] }));
    const resolveCalls: any[] = [];
    reg("lx", ["stream"], {
      resolveStream: async (_cfg: any, song: any) => { resolveCalls.push(song); return "http://lx/kw.mp3"; },
    }, { name: "LX" });
    insertSong("p-pure");
    setStreamSourcePriority(["lx"]);
    vi.stubGlobal("fetch", vi.fn(async () => RESP_OK()));

    const r = await findFallbackStream("p-pure", "碎碎念", "队长", "", 240, "gmd", "qq");

    expect(r).toEqual({ url: "http://lx/kw.mp3", source: "lx" });
    expect(resolveCalls.length).toBe(1);
    expect(resolveCalls[0].id).toBe("p-pure");
    expect(gmdCalls).toEqual([]); // 本尊不在列表
  });

  it("⑤ 插件级条目沿用旧语义:跳过本尊失败平台(仅剩该平台候选 → 无源,负缓存)", async () => {
    regPrimary(async () => ({ songs: [cand("netease", "http://gmd/netease.mp3")] }));
    insertSong("p-deadplatform");
    setStreamSourcePriority(["gmd"]);
    vi.stubGlobal("fetch", vi.fn(async () => RESP_OK()));

    // failingSource=netease → 唯一 netease 候选被跳过 → 无源
    const r = await findFallbackStream("p-deadplatform", "碎碎念", "队长", "", 240, "gmd", "netease");

    expect(r).toBeNull();
    expect(getCachedPlayability("p-deadplatform")).toBe("unplayable");
  });

  it("⑥ search 抛错 → 该条跳过并继续下一条;全部失败时按 transient 退避(不判死)", async () => {
    reg("gmd-throw", ["search", "stream"], {
      search: async () => { throw new Error("upstream unreachable"); },
      streamUrl: () => "",
    }, { name: "GMD-THROW" });
    reg("lx-empty", ["stream"], { resolveStream: async () => "" }, { name: "LX-EMPTY" });
    insertSong("p-throw");
    setStreamSourcePriority(["gmd-throw", "lx-empty"]);
    vi.stubGlobal("fetch", vi.fn(async () => RESP_OK()));

    const r = await findFallbackStream("p-throw", "碎碎念", "队长", "", 240, "gmd-throw", "kuwo");

    expect(r).toBeNull();
    expect(getCachedPlayability("p-throw")).toBe("transient");
  });

  it("⑦ 列表内全部明确失败(404)→ 写负结果(不判 transient)", async () => {
    regPrimary(async () => ({ songs: [cand("kuwo", "http://gmd/dead.mp3")] }));
    insertSong("p-gone");
    setStreamSourcePriority(["gmd"]);
    vi.stubGlobal("fetch", vi.fn(async () => RESP_GONE()));

    const r = await findFallbackStream("p-gone", "碎碎念", "队长", "", 240, "gmd", "qq");

    expect(r).toBeNull();
    expect(getCachedPlayability("p-gone")).toBe("unplayable");
  });

  it("⑧ 列表含未启用插件条目 → 跳过;命中后续可用条目", async () => {
    reg("ghost", ["search", "stream"], {
      search: async () => ({ songs: [cand("netease", "http://ghost/netease.mp3")] }),
      streamUrl: (_cfg: any, song: any) => String(song.url || ""),
    }, { name: "GHOST" }, false); // 未落库启用 → getConfiguredProvider 为 null
    regPrimary(async () => ({ songs: [cand("kuwo", "http://gmd/kuwo.mp3")] }));
    insertSong("p-ghost");
    setStreamSourcePriority(["ghost", "gmd"]);
    vi.stubGlobal("fetch", vi.fn(async () => RESP_OK()));

    const r = await findFallbackStream("p-ghost", "碎碎念", "队长", "", 240, "gmd", "qq");

    expect(r).toEqual({ url: "http://gmd/kuwo.mp3", source: "kuwo" });
  });
});

// ==================== 4. 设置端点保存后使换源缓存失效(P2-1) ====================

describe("PUT /v1/playback-sources/settings 使换源缓存失效", () => {
  it("保存优先级后清空换源/可播缓存:已缓存的可播判定被逐出", async () => {
    reg("cache-src", ["search", "stream"], {
      search: async () => ({ songs: [cand("netease", "http://cache/n.mp3")] }),
      streamUrl: (_cfg: any, song: any) => String(song.url || ""),
    }, { name: "CACHE" });
    insertSong("cache-song", "cache-src");
    vi.stubGlobal("fetch", vi.fn(async () => RESP_OK()));
    setStreamSourcePriority(["cache-src"]);

    // 制造一条已缓存的换源结果
    const hit = await findFallbackStream("cache-song", "碎碎念", "队长", "", 240, "cache-src", "qq");
    expect(hit).toEqual({ url: "http://cache/n.mp3", source: "netease" });
    expect(getCachedPlayability("cache-song")).toBe("playable"); // 命中缓存

    // 经 HTTP 端点保存(会触发 clearStreamFallbackCache)
    const res = await app.request(`/rest/api/v1/playback-sources/settings?${adminQs}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ priority: ["cache-src"] }),
    });
    expect(res.status).toBe(200);
    expect((await res.json() as any).success).toBe(true);

    // 缓存已被清空:改顺序后不会命中旧结果
    expect(getCachedPlayability("cache-song")).toBe("unknown");
  });

  it("PUT 非数组(400)不清缓存", async () => {
    reg("cache-src2", ["search", "stream"], {
      search: async () => ({ songs: [cand("netease", "http://cache2/n.mp3")] }),
      streamUrl: (_cfg: any, song: any) => String(song.url || ""),
    }, { name: "CACHE2" });
    insertSong("cache-song2", "cache-src2");
    vi.stubGlobal("fetch", vi.fn(async () => RESP_OK()));
    setStreamSourcePriority(["cache-src2"]);
    await findFallbackStream("cache-song2", "碎碎念", "队长", "", 240, "cache-src2", "qq");
    expect(getCachedPlayability("cache-song2")).toBe("playable");

    const res = await app.request(`/rest/api/v1/playback-sources/settings?${adminQs}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ priority: "not-an-array" }),
    });
    expect(res.status).toBe(400);
    expect(getCachedPlayability("cache-song2")).toBe("playable"); // 校验失败不动缓存
  });
});
