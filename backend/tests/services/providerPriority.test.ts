// 歌词/封面来源优先级(lyrics.providerPriority / cover.providerPriority):
//   - getProviderPriority:新键优先;为空兼容旧 providerId(单源首项);都空 → [];
//   - filterProvidersByPreference:列表非空严格按列表序(未列出不参与、缺失跳过);
//     旧单源未命中 → 回退全部(旧行为不丢);
//   - searchLyrics / searchCover:首源返空 → 自动下一个命中;未列出插件不被调用;
//     空列表 → 全部启用(注册序);
//   - 路由 GET/PUT 兼容:PUT 后 providerId = providerPriority[0];GET 空列表回退 [providerId];
//     cover.* 前缀正确(见 settings.ts L164-165 坑注释)。
// MUST be the first import: redirects DATA_DIR to an isolated temp dir.
import "../plugins/_env.js";

import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { Hono } from "hono";
import md5 from "md5";
import { eq } from "drizzle-orm";
import { initDatabase, db, sqlite, encryptPassword } from "../../src/db/index.js";
import { users } from "../../src/db/schema.js";
import { registerPlugin } from "../../src/plugins/registry.js";
import { _resetSettingsCacheForTest, setSetting, getSetting } from "../../src/services/settings.js";
import { filterProvidersByPreference, getProviderPriority, searchLyrics, searchCover } from "../../src/plugins/providers.js";
import { authMiddleware } from "../../src/middleware/auth.js";
import { apiRoutes } from "../../src/routes/api/index.js";
import { runWithLocale, parseLocale } from "../../src/i18n.js";

initDatabase();

const NOW = new Date().toISOString();

// ---- 路由级 app 引导(real auth + apiRoutes) ----
const app = new Hono();
app.use("*", async (c, next) =>
  runWithLocale(parseLocale(c.req.header("x-mf-lang") ?? c.req.header("accept-language")), () => next()),
);
app.use("/rest/api/*", authMiddleware);
app.route("/rest/api", apiRoutes);

const ADMIN_PASS = "hunter2";
const SALT = "cs123";
const qs = `u=alice&t=${md5(ADMIN_PASS + SALT)}&s=${SALT}`;

beforeAll(() => {
  if (!process.env.APP_VERSION) process.env.APP_VERSION = "1.0.0";
  if (!db.select().from(users).where(eq(users.username, "alice")).get()) {
    db.insert(users).values({
      id: "u-admin", username: "alice", password: "", salt: "salt", subsonicSalt: "subsalt",
      passEnc: encryptPassword(ADMIN_PASS), isAdmin: 1, isActive: 1, email: "a@b.c",
    }).run();
  }
});

const manifestOf = (id: string, caps: string[]) => ({
  id, name: id, version: "1.0.0", type: "lyrics",
  capabilities: caps, configSchema: [], permissions: ["net"],
});

function enablePlugin(id: string, caps: string[], impl: any = {}) {
  registerPlugin(manifestOf(id, caps) as any, impl);
  sqlite.prepare(`
    INSERT INTO plugins (id, name, version, description, manifest, enabled, config, created_at, updated_at)
    VALUES (?, ?, '1.0.0', '', ?, 1, '{}', ?, ?)
    ON CONFLICT(id) DO UPDATE SET manifest = excluded.manifest, enabled = 1, updated_at = excluded.updated_at
  `).run(id, id, JSON.stringify(manifestOf(id, caps)), NOW, NOW);
}

/** 禁用所有声明某能力的插件(测试隔离:每例只用自己注册的 provider)。 */
function disableAllByCap(cap: string) {
  sqlite.prepare(`UPDATE plugins SET enabled = 0 WHERE manifest LIKE '%"${cap}"%'`).run();
}

beforeEach(() => {
  _resetSettingsCacheForTest();
  setSetting("lyrics.providerPriority", "");
  setSetting("lyrics.providerId", "");
  setSetting("cover.providerPriority", "");
  setSetting("cover.providerId", "");
  disableAllByCap("lyricProvider");
  disableAllByCap("coverProvider");
});

// ==================== getProviderPriority 兼容 ====================

describe("getProviderPriority", () => {
  it("priority 优先;为空回退旧 providerId;都空 → []", () => {
    setSetting("lyrics.providerPriority", "");
    setSetting("lyrics.providerId", "p1");
    expect(getProviderPriority("lyrics")).toEqual(["p1"]);

    setSetting("lyrics.providerPriority", JSON.stringify(["p2", "p3"]));
    expect(getProviderPriority("lyrics")).toEqual(["p2", "p3"]);

    setSetting("lyrics.providerPriority", "");
    setSetting("lyrics.providerId", "");
    expect(getProviderPriority("lyrics")).toEqual([]);
  });

  it("库里存非法 JSON → 回退 providerId", () => {
    setSetting("lyrics.providerPriority", "{not json");
    setSetting("lyrics.providerId", "pX");
    expect(getProviderPriority("lyrics")).toEqual(["pX"]);
  });
});

// ==================== filterProvidersByPreference ====================

describe("filterProvidersByPreference", () => {
  const list = [{ manifest: { id: "a" } }, { manifest: { id: "b" } }, { manifest: { id: "c" } }] as any;

  it("列表非空 → 严格按列表顺序,未列出的不参与", () => {
    setSetting("cover.providerPriority", JSON.stringify(["c", "a"]));
    setSetting("cover.providerId", "c");
    expect(filterProvidersByPreference(list, "cover").map((p) => p.manifest.id)).toEqual(["c", "a"]);
  });

  it("列表全空 → 全部(注册序)", () => {
    setSetting("cover.providerPriority", "");
    setSetting("cover.providerId", "");
    expect(filterProvidersByPreference(list, "cover").map((p) => p.manifest.id)).toEqual(["a", "b", "c"]);
  });
});

// ==================== searchLyrics / searchCover ====================

describe("searchLyrics/searchCover 按优先级取源", () => {
  it("searchLyrics:优先级顺序;首个命中即止;未列出插件不被调用", async () => {
    const calls: string[] = [];
    enablePlugin("ly-a", ["lyricProvider"], { searchLyrics: async () => { calls.push("a"); return { lrc: "[00:00.00]A" }; } });
    enablePlugin("ly-b", ["lyricProvider"], { searchLyrics: async () => { calls.push("b"); return { lrc: "[00:00.00]B" }; } });
    enablePlugin("ly-c", ["lyricProvider"], { searchLyrics: async () => { calls.push("c"); return { lrc: "[00:00.00]C" }; } });
    setSetting("lyrics.providerPriority", JSON.stringify(["ly-b", "ly-c"]));
    setSetting("lyrics.providerId", "ly-b");

    const r = await searchLyrics({ title: "x", artist: "y" });
    expect(r).toContain("B");
    expect(calls).toEqual(["b"]); // ly-b 命中即止;ly-a 未列出 → 从不参与
  });

  it("searchLyrics:首个返空 → 自动换下一个命中", async () => {
    const calls: string[] = [];
    enablePlugin("ly-a", ["lyricProvider"], { searchLyrics: async () => { calls.push("a"); return { lrc: "" }; } }); // 空
    enablePlugin("ly-b", ["lyricProvider"], { searchLyrics: async () => { calls.push("b"); return { lrc: "[00:00.00]B" }; } });
    setSetting("lyrics.providerPriority", JSON.stringify(["ly-a", "ly-b"]));

    const r = await searchLyrics({ title: "x", artist: "y" });
    expect(r).toContain("B");
    expect(calls).toEqual(["a", "b"]); // 首源空 → 继续下一项
  });

  it("searchLyrics:列表为空 → 全部启用,注册序 first-match-wins", async () => {
    const seq: string[] = [];
    enablePlugin("ly-a", ["lyricProvider"], { searchLyrics: async () => { seq.push("a"); return { lrc: "" }; } }); // 空 → 继续
    enablePlugin("ly-b", ["lyricProvider"], { searchLyrics: async () => { seq.push("b"); return { lrc: "[00:00.00]B" }; } });
    setSetting("lyrics.providerPriority", "");
    setSetting("lyrics.providerId", "");

    const r = await searchLyrics({ title: "x", artist: "y" });
    expect(r).toContain("B");
    expect(seq).toEqual(["a", "b"]);
  });

  it("searchLyrics:兼容旧单源 providerId(无 priority)→ 只查它", async () => {
    const calls: string[] = [];
    enablePlugin("ly-a", ["lyricProvider"], { searchLyrics: async () => { calls.push("a"); return { lrc: "[00:00.00]A" }; } });
    enablePlugin("ly-b", ["lyricProvider"], { searchLyrics: async () => { calls.push("b"); return { lrc: "[00:00.00]B" }; } });
    setSetting("lyrics.providerPriority", "");
    setSetting("lyrics.providerId", "ly-b");

    const r = await searchLyrics({ title: "x", artist: "y" });
    expect(r).toContain("B");
    expect(calls).toEqual(["b"]); // 旧行为:只用选中的
  });

  it("searchCover:首个返空 → 下一个命中;未列出不参与", async () => {
    const calls: string[] = [];
    enablePlugin("cv-a", ["coverProvider"], { searchCover: async () => { calls.push("a"); return null; } });
    enablePlugin("cv-b", ["coverProvider"], { searchCover: async () => { calls.push("b"); return { url: "http://x/b.jpg" }; } });
    enablePlugin("cv-c", ["coverProvider"], { searchCover: async () => { calls.push("c"); return { url: "http://x/c.jpg" }; } });
    setSetting("cover.providerPriority", JSON.stringify(["cv-a", "cv-b"]));
    setSetting("cover.providerId", "cv-a");

    const r = await searchCover({ title: "x", artist: "y" });
    expect(r).toBe("http://x/b.jpg");
    expect(calls).toEqual(["a", "b"]); // cv-c 未列出
  });
});

// ==================== 路由 GET/PUT 兼容 ====================

describe("路由 /v1/{lyrics,covers}/settings providerPriority", () => {
  it("PUT providerPriority → 规范化落库,providerId 同步为列表首项;GET 回读", async () => {
    const put = await app.request(`/rest/api/v1/lyrics/settings?${qs}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ providerPriority: ["pp-a", "pp-b", "pp-a", 7, ""], onDemand: true, persist: true }),
    });
    expect(put.status).toBe(200);

    expect(getSetting("lyrics.providerPriority", "")).toBe(JSON.stringify(["pp-a", "pp-b"]));
    expect(getSetting("lyrics.providerId", "")).toBe("pp-a"); // 首项同步

    const get = await app.request(`/rest/api/v1/lyrics/settings?${qs}`);
    const body = (await get.json()) as any;
    expect(body.providerPriority).toEqual(["pp-a", "pp-b"]);
    expect(body.providerId).toBe("pp-a");
  });

  it("GET 兼容:priority 空 + 旧 providerId → providerPriority=[providerId]", async () => {
    setSetting("lyrics.providerPriority", "");
    setSetting("lyrics.providerId", "legacy-p");
    const get = await app.request(`/rest/api/v1/lyrics/settings?${qs}`);
    const body = (await get.json()) as any;
    expect(body.providerPriority).toEqual(["legacy-p"]);
    expect(body.providerId).toBe("legacy-p");
  });

  it("covers 路径:PUT providerPriority → providerId=首项(cover.* 前缀)", async () => {
    const put = await app.request(`/rest/api/v1/covers/settings?${qs}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ providerPriority: ["cv-a", "cv-b"] }),
    });
    expect(put.status).toBe(200);
    expect(getSetting("cover.providerPriority", "")).toBe(JSON.stringify(["cv-a", "cv-b"]));
    expect(getSetting("cover.providerId", "")).toBe("cv-a");
    const get = await app.request(`/rest/api/v1/covers/settings?${qs}`);
    const body = (await get.json()) as any;
    expect(body.providerPriority).toEqual(["cv-a", "cv-b"]);
  });

  it("清空列表(PUT providerPriority=[])→ providerId 置空(= 自动)", async () => {
    setSetting("lyrics.providerPriority", JSON.stringify(["old"]));
    setSetting("lyrics.providerId", "old");
    await app.request(`/rest/api/v1/lyrics/settings?${qs}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ providerPriority: [] }),
    });
    expect(getSetting("lyrics.providerId", "")).toBe("");
    expect(getSetting("lyrics.providerPriority", "")).toBe("[]");
  });

  it("旧协议(PUT 不带 providerPriority,只带 providerId)→ 原行为", async () => {
    await app.request(`/rest/api/v1/lyrics/settings?${qs}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ providerId: "legacy-only" }),
    });
    expect(getSetting("lyrics.providerId", "")).toBe("legacy-only");
    // 旧协议不动 providerPriority
    expect(getSetting("lyrics.providerPriority", "")).toBe("");
  });
});
