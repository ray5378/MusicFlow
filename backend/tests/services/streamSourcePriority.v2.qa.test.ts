// ==================== QA 第2轮独立复验:播放来源优先级「仅插件级」返工版 ====================
//
// 验收标准(team-lead 第2轮):
//   - 条目=纯插件 id;历史 `plugin:platform` 一律收敛为 `plugin`(冒号前);`:xxx` 丢弃;
//   - 列表非空 → 严格按列表序、本尊不特权;**列表非空但全败 → 判无源,绝不回退本尊**;
//   - 列表空 → 本尊优先(旧行为);
//   - 插件级条目**不得**透传 `sources`;
//   - available 每插件一条、无 kind、无 ':'。
// 自带 harness,不复用工程师用例;先 UPDATE plugins SET enabled=0 再自注册 mock 保证确定性。
// MUST be the first import.
import "../plugins/_env.js";

import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from "vitest";
import { Hono } from "hono";
import md5 from "md5";
import { initDatabase, db, sqlite, encryptPassword } from "../../src/db/index.js";
import { songs, users } from "../../src/db/schema.js";
import { eq } from "drizzle-orm";
import { registerPlugin, unregisterPlugin } from "../../src/plugins/registry.js";
import { _resetSettingsCacheForTest, setSetting } from "../../src/services/settings.js";
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
import { authMiddleware } from "../../src/middleware/auth.js";
import { apiRoutes } from "../../src/routes/api/index.js";

initDatabase();
const NOW = new Date().toISOString();
const cleanups: Array<() => void> = [];

// ---- route app ----
const app = new Hono();
app.use("/rest/api/*", authMiddleware);
app.route("/rest/api", apiRoutes);
const ADMIN_PASS = "hunter2";
const SALT = "qa2-salt";
const qs = `u=alice&t=${md5(ADMIN_PASS + SALT)}&s=${SALT}`;

function reg(id: string, caps: string[], impl: any) {
  const manifest = { id, name: id, version: "1.0.0", type: "source", capabilities: caps, platforms: [], configSchema: [], permissions: ["net"] };
  registerPlugin(manifest as any, impl);
  sqlite.prepare(`INSERT INTO plugins (id, name, version, description, manifest, enabled, config, created_at, updated_at)
    VALUES (?,?, '1.0.0','', ?, 1, '{}', ?, ?) ON CONFLICT(id) DO UPDATE SET manifest=excluded.manifest, enabled=1`)
    .run(id, id, JSON.stringify(manifest), NOW, NOW);
  cleanups.push(() => {
    try { unregisterPlugin(id); } catch { /* gone */ }
    try { sqlite.prepare("DELETE FROM plugins WHERE id = ?").run(id); } catch { /* noop */ }
  });
}

function insertSong(id: string, pluginEntry: string) {
  db.insert(songs).values({ id, title: "碎碎念", artist: "队长", album: "", duration: 240, path: `/tmp/${id}.mp3`, type: "web", pluginEntry, sourceData: JSON.stringify({ source: "kuwo", remoteId: "1" }) }).run();
  cleanups.push(() => { try { sqlite.prepare("DELETE FROM songs WHERE id = ?").run(id); } catch { /* noop */ } });
}

/** 可记录 search 入参的 mock search+stream 插件。 */
function mkProvider(songs: any[], calls?: any[]) {
  return {
    search: async (_c: any, params: any) => { calls?.push(params); return { songs }; },
    streamUrl: (_c: any, s: any) => String(s.url || ""),
  };
}
function cand(source: string, url: string) {
  return { id: source, source, name: "碎碎念", artist: "队长", album: "", duration: 240, cover: "", url };
}
const ok = () => new Response(new ArrayBuffer(8), { status: 206, headers: { "content-type": "audio/mpeg" } });
const gone = () => new Response(new ArrayBuffer(8), { status: 404, headers: { "content-type": "text/html" } });

function clearPriority() {
  sqlite.prepare("DELETE FROM settings WHERE key = ?").run(STREAM_SOURCE_PRIORITY_KEY);
  _resetSettingsCacheForTest();
}

beforeAll(() => {
  if (!process.env.APP_VERSION) process.env.APP_VERSION = "1.0.0";
  if (!db.select().from(users).where(eq(users.username, "alice")).get()) {
    db.insert(users).values({ id: "u-qa2", username: "alice", password: "", salt: "salt", subsonicSalt: "subsalt", passEnc: encryptPassword(ADMIN_PASS), isAdmin: 1, isActive: 1, email: "a@b.c" }).run();
  }
});

beforeEach(() => {
  clearStreamFallbackCache();
  clearPriority();
  sqlite.prepare("UPDATE plugins SET enabled = 0").run();
});
afterEach(() => {
  vi.unstubAllGlobals();
  while (cleanups.length) cleanups.pop()!();
  sqlite.prepare("UPDATE plugins SET enabled = 0").run();
  clearStreamFallbackCache();
  clearPriority();
});

// ==================== A. 收敛语义 ====================

describe("QA:插件级收敛(normalize/get)", () => {
  it("A1 ['a:b','a','c:',':d','e'] → ['a','c','e'](收敛+去重+丢弃空插件名)", () => {
    setSetting(STREAM_SOURCE_PRIORITY_KEY, JSON.stringify(["a:b", "a", "c:", ":d", "e"]));
    _resetSettingsCacheForTest();
    expect(getStreamSourcePriority()).toEqual(["a", "c", "e"]);
  });

  it("A2 非字符串/空/纯空白丢弃;去重保序", () => {
    expect(normalizeStreamSourcePriority([1, null, "", "  ", "x", "x ", "y"])).toEqual(["x", "y"]);
    expect(normalizeStreamSourcePriority("nope")).toEqual([]);
  });

  it("A3 >50 截断到 50", () => {
    const many = Array.from({ length: 60 }, (_, i) => `p${i}`);
    expect(normalizeStreamSourcePriority(many).length).toBe(50);
  });

  it("A4 落库即收敛:set 带 platform → 库里/回读都是插件级", () => {
    const ret = setStreamSourcePriority(["go-music-dl:netease", "go-music-dl", "lx-source:x"]);
    expect(ret).toEqual(["go-music-dl", "lx-source"]);
    expect(getStreamSourcePriority()).toEqual(["go-music-dl", "lx-source"]);
  });
});

// ==================== B. 取源顺序真判 ====================

describe("QA:插件级取源顺序", () => {
  it("B1 列表[B,A] 本尊=A → 先试 B;B 命中则不试 A(本尊不特权)", async () => {
    const aCalls: any[] = [], bCalls: any[] = [];
    reg("qa2-a", ["search", "stream"], mkProvider([cand("netease", "http://a/live.mp3")], aCalls));
    reg("qa2-b", ["search", "stream"], mkProvider([cand("kuwo", "http://b/live.mp3")], bCalls));
    insertSong("qa2-b1", "qa2-a");
    setStreamSourcePriority(["qa2-b", "qa2-a"]);
    vi.stubGlobal("fetch", vi.fn(async () => ok()));

    const r = await findFallbackStream("qa2-b1", "碎碎念", "队长", "", 240, "qa2-a", "qq");
    expect(r).toEqual({ url: "http://b/live.mp3", source: "kuwo" });
    expect(bCalls.length).toBe(1);
    expect(aCalls).toEqual([]); // B 命中即止,本尊从未被调
  });

  it("B2 【关键】列表[B] 且 B 全败、本尊 A 有活链 → 必须判无源(绝不回退本尊)", async () => {
    const aCalls: any[] = [], bCalls: any[] = [];
    reg("qa2-a", ["search", "stream"], mkProvider([cand("netease", "http://a/live.mp3")], aCalls));
    reg("qa2-b", ["search", "stream"], mkProvider([cand("kuwo", "http://b/dead.mp3")], bCalls));
    insertSong("qa2-b2", "qa2-a");
    setStreamSourcePriority(["qa2-b"]);
    // B 的链 404;A 的链本可 206,但 A 不该被调用
    vi.stubGlobal("fetch", vi.fn(async (u: any) => (String(u).includes("/b/") ? gone() : ok())));

    const r = await findFallbackStream("qa2-b2", "碎碎念", "队长", "", 240, "qa2-a", "qq");
    expect(r).toBeNull();
    expect(bCalls.length).toBe(1);
    expect(aCalls).toEqual([]); // 列表非空 → 不回退本尊
    expect(getCachedPlayability("qa2-b2")).toBe("unplayable");
  });

  it("B3 列表[] → 本尊 A 优先(旧行为)", async () => {
    const aCalls: any[] = [];
    reg("qa2-a", ["search", "stream"], mkProvider([cand("netease", "http://a/live.mp3")], aCalls));
    reg("qa2-b", ["search", "stream"], mkProvider([cand("kuwo", "http://b/live.mp3")]));
    insertSong("qa2-b3", "qa2-a");
    setStreamSourcePriority([]);
    vi.stubGlobal("fetch", vi.fn(async () => ok()));

    const r = await findFallbackStream("qa2-b3", "碎碎念", "队长", "", 240, "qa2-a", "qq");
    expect(r).toEqual({ url: "http://a/live.mp3", source: "netease" });
    expect(aCalls.length).toBe(1);
  });

  it("B4 插件级条目透传的 search params 只有 query,**无 sources**", async () => {
    const calls: any[] = [];
    reg("qa2-a", ["search", "stream"], mkProvider([cand("netease", "http://a/live.mp3")], calls));
    insertSong("qa2-b4", "qa2-a");
    setStreamSourcePriority(["qa2-a"]);
    vi.stubGlobal("fetch", vi.fn(async () => ok()));

    await findFallbackStream("qa2-b4", "碎碎念", "队长", "", 240, "qa2-a", "qq");
    expect(calls[0]).toEqual({ query: "碎碎念 队长" });
    expect("sources" in calls[0]).toBe(false); // 平台透传已删干净
  });

  it("B5 列表里的历史 'a:b' 条目被收敛后仍按 a 取源", async () => {
    const calls: any[] = [];
    reg("qa2-a", ["search", "stream"], mkProvider([cand("netease", "http://a/live.mp3")], calls));
    insertSong("qa2-b5", "qa2-a");
    setSetting(STREAM_SOURCE_PRIORITY_KEY, JSON.stringify(["qa2-a:netease", ":xxx"]));
    _resetSettingsCacheForTest();
    vi.stubGlobal("fetch", vi.fn(async () => ok()));

    const r = await findFallbackStream("qa2-b5", "碎碎念", "队长", "", 240, "qa2-other", "qq");
    expect(r).toEqual({ url: "http://a/live.mp3", source: "netease" }); // 'qa2-a:netease'→'qa2-a'; ':xxx' 丢弃
    expect(calls.length).toBe(1);
  });
});

// ==================== C. 路由合同 ====================

async function put(body: any) {
  const res = await app.request(`/rest/api/v1/playback-sources/settings?${qs}`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  return { status: res.status, body: await res.json().catch(() => null) };
}
async function get() {
  const res = await app.request(`/rest/api/v1/playback-sources/settings?${qs}`);
  return { status: res.status, body: await res.json().catch(() => null) };
}

describe("QA:playback-sources 路由(插件级)", () => {
  it("C1 PUT 非数组 → 400 + error code", async () => {
    const r = await put({ priority: "x" });
    expect(r.status).toBe(400);
    expect(r.body.code).toBe("INVALID_PARAM");
  });

  it("C2 PUT [] → 落库 '[]' 且 GET 回读 []", async () => {
    const r = await put({ priority: [] });
    expect(r.status).toBe(200);
    expect(sqlite.prepare("SELECT value FROM settings WHERE key=?").get(STREAM_SOURCE_PRIORITY_KEY)).toMatchObject({ value: "[]" });
    expect((await get()).body.priority).toEqual([]);
  });

  it("C3 PUT 带冒号历史条目 → 收敛落库", async () => {
    await put({ priority: ["go-music-dl:netease", "lx-source"] });
    expect((await get()).body.priority).toEqual(["go-music-dl", "lx-source"]);
  });

  it("C4 GET available 每插件一条、无 kind、无 ':'", async () => {
    reg("qa2-src1", ["search", "stream"], {});
    reg("qa2-src2", ["stream"], {});
    reg("qa2-src3", ["search"], {});
    reg("qa2-album", ["playlistSongs"], {}); // 无 stream/search → 不出现
    const { body } = await get();
    const vals = body.available.map((s: any) => s.value);
    expect(vals).toEqual(expect.arrayContaining(["qa2-src1", "qa2-src2", "qa2-src3"]));
    expect(vals).not.toContain("qa2-album");
    for (const s of body.available) {
      expect("kind" in s).toBe(false);
      expect(String(s.value)).not.toContain(":");
    }
    // 每插件恰好一条
    expect(vals.filter((v: string) => v === "qa2-src1").length).toBe(1);
  });

  it("C5 PUT 新顺序后缓存失效:不重启进程再取同曲 → 按新顺序重新取源", async () => {
    const aCalls: any[] = [], bCalls: any[] = [];
    reg("qa2-a", ["search", "stream"], mkProvider([cand("netease", "http://a/live.mp3")], aCalls));
    reg("qa2-b", ["search", "stream"], mkProvider([cand("kuwo", "http://b/live.mp3")], bCalls));
    insertSong("qa2-c5", "qa2-a");
    vi.stubGlobal("fetch", vi.fn(async () => ok()));

    // 旧顺序 [a] → 命中 a 并写入换源缓存
    await put({ priority: ["qa2-a"] });
    const r1 = await findFallbackStream("qa2-c5", "碎碎念", "队长", "", 240, "qa2-a", "qq");
    expect(r1).toEqual({ url: "http://a/live.mp3", source: "netease" });
    expect(getCachedPlayability("qa2-c5")).toBe("playable");

    // 改顺序 [b] → 路由应清缓存
    const pr = await put({ priority: ["qa2-b"] });
    expect(pr.status).toBe(200);

    // 同一进程同一曲再取 → 必须走 b(而非命中旧的 a 缓存)
    const r2 = await findFallbackStream("qa2-c5", "碎碎念", "队长", "", 240, "qa2-a", "qq");
    expect(r2).toEqual({ url: "http://b/live.mp3", source: "kuwo" });
    expect(bCalls.length).toBe(1);
  });
});

// ==================== D. 错误/异常路径 ====================

describe("QA:错误路径", () => {
  it("D1 列表含未安装/未启用插件 → 跳过不报错,继续下一个", async () => {
    const calls: any[] = [];
    reg("qa2-a", ["search", "stream"], mkProvider([cand("netease", "http://a/live.mp3")], calls));
    insertSong("qa2-d1", "qa2-a");
    setStreamSourcePriority(["qa2-ghost", "qa2-a"]);
    vi.stubGlobal("fetch", vi.fn(async () => ok()));

    const r = await findFallbackStream("qa2-d1", "碎碎念", "队长", "", 240, "qa2-a", "qq");
    expect(r).toEqual({ url: "http://a/live.mp3", source: "netease" });
  });

  it("D2 search 抛错 → 不判死(transient 退避),且继续下一条", async () => {
    const good: any[] = [];
    reg("qa2-boom", ["search", "stream"], { search: async () => { throw new Error("502"); }, streamUrl: () => "" });
    reg("qa2-a", ["search", "stream"], mkProvider([cand("kuwo", "http://a/live.mp3")], good));
    insertSong("qa2-d2", "qa2-owner");
    setStreamSourcePriority(["qa2-boom", "qa2-a"]);
    vi.stubGlobal("fetch", vi.fn(async () => ok()));
    const r = await findFallbackStream("qa2-d2", "碎碎念", "队长", "", 240, "qa2-owner", "qq");
    expect(r).toEqual({ url: "http://a/live.mp3", source: "kuwo" });

    // 另造:全部抛错 → transient(不判死)
    reg("qa2-boom2", ["search", "stream"], { search: async () => { throw new Error("502"); }, streamUrl: () => "" });
    insertSong("qa2-d2b", "qa2-owner");
    setStreamSourcePriority(["qa2-boom2"]);
    const r2 = await findFallbackStream("qa2-d2b", "碎碎念", "队长", "", 240, "qa2-owner", "qq");
    expect(r2).toBeNull();
    expect(getCachedPlayability("qa2-d2b")).toBe("transient");
  });

  it("D3 全部条目明确失败(404)→ 负缓存 unplayable", async () => {
    reg("qa2-a", ["search", "stream"], mkProvider([cand("kuwo", "http://a/dead.mp3")]));
    insertSong("qa2-d3", "qa2-owner");
    setStreamSourcePriority(["qa2-a"]);
    vi.stubGlobal("fetch", vi.fn(async () => gone()));
    const r = await findFallbackStream("qa2-d3", "碎碎念", "队长", "", 240, "qa2-owner", "qq");
    expect(r).toBeNull();
    expect(getCachedPlayability("qa2-d3")).toBe("unplayable");
  });

  it("D4 available 只列已启用插件", () => {
    reg("qa2-on", ["stream"], {});
    // 一个"注册但不落库启用"的插件:仅 registry,不 enabled
    const manifest = { id: "qa2-off", name: "qa2-off", version: "1.0.0", type: "source", capabilities: ["stream"], platforms: [], configSchema: [], permissions: ["net"] };
    registerPlugin(manifest as any, {});
    cleanups.push(() => { try { unregisterPlugin("qa2-off"); } catch { /* noop */ } });
    const vals = listAvailableStreamSources().map((s) => s.value);
    expect(vals).toContain("qa2-on");
    expect(vals).not.toContain("qa2-off");
  });
});
