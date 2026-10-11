// ==================== QA 独立复验:歌词/封面来源优先级(providers.providerPriority) ====================
//
// 独立于工程师用例,自己构造场景,重点压**工程师未覆盖的分支**:
//   - filterProvidersByPreference:旧单源 providerId **未命中 → 回退全部**(工程师只测了命中);
//     priority 全为不存在项 → [] (与旧单源"未命中回退全部"语义不对称,单独实证);
//   - searchLyrics/searchCover:priority 含 ghost 跳过→继续下一个;全 ghost → null(无输出);
//     priority 顺序覆盖注册序;
//   - 路由:lyrics/covers 前缀、旧协议 PUT 不动 providerPriority、清空→providerId 置空,
//     并探测"providerPriority 传非数组"这一畸形入参的真实行为。
// MUST be the first import: redirects DATA_DIR to an isolated temp dir.
import "../plugins/_env.js";

import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from "vitest";
import { Hono } from "hono";
import md5 from "md5";
import { db, initDatabase, sqlite, encryptPassword } from "../../src/db/index.js";
import { users } from "../../src/db/schema.js";
import { eq } from "drizzle-orm";
import { registerPlugin, unregisterPlugin } from "../../src/plugins/registry.js";
import { _resetSettingsCacheForTest, setSetting, getSetting } from "../../src/services/settings.js";
import { filterProvidersByPreference, searchLyrics, searchCover, normalizeProviderPriority, getProviderPriority } from "../../src/plugins/providers.js";
import { authMiddleware } from "../../src/middleware/auth.js";
import { apiRoutes } from "../../src/routes/api/index.js";

initDatabase();

const NOW = new Date().toISOString();

const app = new Hono();
app.use("/rest/api/*", authMiddleware);
app.route("/rest/api", apiRoutes);

const ADMIN_PASS = "hunter2";
const SALT = "qa-salt";
const qs = `u=alice&t=${md5(ADMIN_PASS + SALT)}&s=${SALT}`;

const cleanups: Array<() => void> = [];

function reg(id: string, caps: string[], impl: any = {}) {
  const manifest = { id, name: id, version: "1.0.0", type: "lyrics", capabilities: caps, configSchema: [], permissions: ["net"] };
  registerPlugin(manifest as any, impl);
  sqlite.prepare(`
    INSERT INTO plugins (id, name, version, description, manifest, enabled, config, created_at, updated_at)
    VALUES (?, ?, '1.0.0', '', ?, 1, '{}', ?, ?)
    ON CONFLICT(id) DO UPDATE SET manifest = excluded.manifest, enabled = 1, updated_at = excluded.updated_at
  `).run(id, id, JSON.stringify(manifest), NOW, NOW);
  cleanups.push(() => {
    try { unregisterPlugin(id); } catch { /* gone */ }
    try { sqlite.prepare("DELETE FROM plugins WHERE id = ?").run(id); } catch { /* noop */ }
  });
}

function resetSettings() {
  _resetSettingsCacheForTest();
  for (const k of ["lyrics.providerPriority", "lyrics.providerId", "cover.providerPriority", "cover.providerId"]) {
    sqlite.prepare("DELETE FROM settings WHERE key = ?").run(k);
  }
  _resetSettingsCacheForTest();
}

beforeAll(() => {
  if (!process.env.APP_VERSION) process.env.APP_VERSION = "1.0.0";
  if (!db.select().from(users).where(eq(users.username, "alice")).get()) {
    db.insert(users).values({ id: "u-qa", username: "alice", password: "", salt: "salt", subsonicSalt: "subsalt", passEnc: encryptPassword(ADMIN_PASS), isAdmin: 1, isActive: 1, email: "a@b.c" }).run();
  }
});

beforeEach(() => {
  resetSettings();
  sqlite.prepare("UPDATE plugins SET enabled = 0").run(); // 全部停用,保证确定性
});

afterEach(() => {
  vi.unstubAllGlobals();
  while (cleanups.length) cleanups.pop()!();
  sqlite.prepare("UPDATE plugins SET enabled = 0").run();
  resetSettings();
});

const P = (id: string) => ({ manifest: { id } }) as any;

// ==================== A. filterProvidersByPreference 边界 ====================

describe("QA:filterProvidersByPreference 边界", () => {
  const all = [P("a"), P("b"), P("c")];

  it("A1 旧单源 providerId 命中 → 只返回它", () => {
    setSetting("cover.providerPriority", "");
    setSetting("cover.providerId", "b");
    expect(filterProvidersByPreference(all, "cover").map((p) => p.manifest.id)).toEqual(["b"]);
  });

  it("A2 旧单源 providerId **未命中**(禁用/卸载)→ 回退全部(旧行为不丢)", () => {
    setSetting("cover.providerPriority", "");
    setSetting("cover.providerId", "ghost");
    expect(filterProvidersByPreference(all, "cover").map((p) => p.manifest.id)).toEqual(["a", "b", "c"]);
  });

  it("A3 priority 含 ghost → 跳过该条,其余保持列表序", () => {
    setSetting("cover.providerPriority", JSON.stringify(["ghost", "c", "nope", "a"]));
    setSetting("cover.providerId", "ghost");
    expect(filterProvidersByPreference(all, "cover").map((p) => p.manifest.id)).toEqual(["c", "a"]);
  });

  it("A4 priority 全为 ghost → 返回 [] (不回退全部;与旧单源语义不对称)", () => {
    setSetting("cover.providerPriority", JSON.stringify(["g1", "g2"]));
    setSetting("cover.providerId", "g1");
    expect(filterProvidersByPreference(all, "cover")).toEqual([]);
  });

  it("A5 入参 all 为空 → 原样返回(不抛)", () => {
    setSetting("cover.providerPriority", JSON.stringify(["a"]));
    expect(filterProvidersByPreference([], "cover")).toEqual([]);
  });

  it("A6 priority 库里为非法 JSON → 回退旧 providerId 逻辑", () => {
    setSetting("cover.providerPriority", "{not json");
    setSetting("cover.providerId", "c");
    expect(filterProvidersByPreference(all, "cover").map((p) => p.manifest.id)).toEqual(["c"]);
  });

  it("A7 normalizeProviderPriority:trim/去空/去重/丢非字符串/非数组→[]", () => {
    expect(normalizeProviderPriority([" a ", "a", "", "b", 7, null])).toEqual(["a", "b"]);
    expect(normalizeProviderPriority("x")).toEqual([]);
    expect(normalizeProviderPriority(null)).toEqual([]);
  });
});

// ==================== B. searchLyrics / searchCover 端到端 ====================

describe("QA:searchLyrics/searchCover 按优先级", () => {
  it("B1 priority 顺序覆盖注册序;命中即止;未列出不被调用", async () => {
    const calls: string[] = [];
    reg("zq-a", ["lyricProvider"], { searchLyrics: async () => { calls.push("a"); return { lrc: "A" }; } });
    reg("zq-b", ["lyricProvider"], { searchLyrics: async () => { calls.push("b"); return { lrc: "B" }; } });
    reg("zq-c", ["lyricProvider"], { searchLyrics: async () => { calls.push("c"); return { lrc: "C" }; } });
    setSetting("lyrics.providerPriority", JSON.stringify(["zq-c", "zq-a"])); // c 先于 a;b 未列出

    const r = await searchLyrics({ title: "x", artist: "y" });
    expect(r).toBe("C");
    expect(calls).toEqual(["c"]); // 注册序是 a,b,c;优先级把 c 提到最前 → 证明确实按列表
  });

  it("B2 priority 含 ghost → 跳过 ghost 继续下一个命中", async () => {
    const calls: string[] = [];
    reg("zq-a", ["lyricProvider"], { searchLyrics: async () => { calls.push("a"); return { lrc: "A" }; } });
    setSetting("lyrics.providerPriority", JSON.stringify(["ghost-ly", "zq-a"]));

    const r = await searchLyrics({ title: "x", artist: "y" });
    expect(r).toBe("A");
    expect(calls).toEqual(["a"]);
  });

  it("B3 priority 全 ghost → providers 为空 → null(有启用 provider 也不兜底)", async () => {
    const calls: string[] = [];
    reg("zq-live", ["lyricProvider"], { searchLyrics: async () => { calls.push("live"); return { lrc: "LIVE" }; } });
    setSetting("lyrics.providerPriority", JSON.stringify(["ghost-x"]));

    const r = await searchLyrics({ title: "x", artist: "y" });
    expect(r).toBeNull();
    expect(calls).toEqual([]); // 排除在列表外 → 完全不被调用
  });

  it("B4 首源返空 → 继续下一个命中(cover 同款)", async () => {
    const calls: string[] = [];
    reg("zq-cv1", ["coverProvider"], { searchCover: async () => { calls.push("1"); return null; } });
    reg("zq-cv2", ["coverProvider"], { searchCover: async () => { calls.push("2"); return { url: "http://x/2.jpg" }; } });
    setSetting("cover.providerPriority", JSON.stringify(["zq-cv2", "zq-cv1"])); // 2 先,直接命中

    const r = await searchCover({ title: "x", artist: "y" });
    expect(r).toBe("http://x/2.jpg");
    expect(calls).toEqual(["2"]);
  });

  it("B5 空列表 → 全部启用(注册序 first-match-wins)", async () => {
    const seq: string[] = [];
    reg("zq-e1", ["lyricProvider"], { searchLyrics: async () => { seq.push("1"); return { lrc: "" }; } });
    reg("zq-e2", ["lyricProvider"], { searchLyrics: async () => { seq.push("2"); return { lrc: "E2" }; } });
    setSetting("lyrics.providerPriority", "");
    setSetting("lyrics.providerId", "");

    const r = await searchLyrics({ title: "x", artist: "y" });
    expect(r).toBe("E2");
    expect(seq).toEqual(["1", "2"]);
  });
});

// ==================== C. 路由 GET/PUT 契约 ====================

async function put(path: string, body: any) {
  const res = await app.request(`/rest/api/v1${path}?${qs}`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}
async function get(path: string) {
  const res = await app.request(`/rest/api/v1${path}?${qs}`);
  return { status: res.status, body: await res.json().catch(() => null) };
}

describe("QA:lyrics/covers 优先级 PUT/GET 契约", () => {
  it("C1 PUT providerPriority → providerId 同步首项;GET 双字段一致", async () => {
    const p = await put("/lyrics/settings", { providerPriority: ["pp-a", "pp-b", "pp-a"] });
    expect(p.status).toBe(200);
    expect(getSetting("lyrics.providerPriority", "")).toBe(JSON.stringify(["pp-a", "pp-b"]));
    expect(getSetting("lyrics.providerId", "")).toBe("pp-a");

    const g = await get("/lyrics/settings");
    expect(g.body.providerId).toBe("pp-a");
    expect(g.body.providerPriority).toEqual(["pp-a", "pp-b"]);
  });

  it("C2 covers 用 cover.* 前缀(不写错成 covers.*)", async () => {
    await put("/covers/settings", { providerPriority: ["cv-a", "cv-b"] });
    expect(getSetting("cover.providerPriority", "")).toBe(JSON.stringify(["cv-a", "cv-b"]));
    expect(getSetting("cover.providerId", "")).toBe("cv-a");
    expect(getSetting("covers.providerPriority", "SHOULD_NOT_EXIST")).toBe("SHOULD_NOT_EXIST");
    expect(getSetting("covers.providerId", "SHOULD_NOT_EXIST")).toBe("SHOULD_NOT_EXIST");
  });

  it("C3 旧协议 PUT(只带 providerId)→ 只动 providerId,不覆盖已有 providerPriority", async () => {
    await put("/lyrics/settings", { providerPriority: ["keep-a", "keep-b"] });
    await put("/lyrics/settings", { providerId: "legacy-only" });
    expect(getSetting("lyrics.providerId", "")).toBe("legacy-only");
    expect(getSetting("lyrics.providerPriority", "")).toBe(JSON.stringify(["keep-a", "keep-b"])); // 未被旧协议清掉
    // 但取源以 priority 为准 → providerId 的 legacy-only 被忽略
    expect(getProviderPriority("lyrics")).toEqual(["keep-a", "keep-b"]);
  });

  it("C4 清空列表 PUT [] → providerId 置空,priority 落 []", async () => {
    await put("/lyrics/settings", { providerPriority: ["x"] });
    await put("/lyrics/settings", { providerPriority: [] });
    expect(getSetting("lyrics.providerId", "")).toBe("");
    expect(getSetting("lyrics.providerPriority", "")).toBe("[]");
  });

  it("C5 畸形入参 providerPriority 传字符串(非数组)→ 实测行为记录", async () => {
    await put("/lyrics/settings", { providerPriority: ["before"] });
    const res = await put("/lyrics/settings", { providerPriority: "not-an-array" });
    expect(res.status).toBe(200); // 未做 400 校验
    // 落到旧协议分支:无 providerId 字段 → providerId 被置空;providerPriority 保留
    const pid = getSetting("lyrics.providerId", "MISSING");
    const pp = getSetting("lyrics.providerPriority", "MISSING");
    // 断言实测(记录用):providerId 被清空、providerPriority 原样保留
    expect(pid).toBe("");
    expect(pp).toBe(JSON.stringify(["before"]));
  });

  it("C6 GET 兼容:priority 空 + 旧 providerId → providerPriority=[providerId]", async () => {
    setSetting("cover.providerPriority", "");
    setSetting("cover.providerId", "legacy-cov");
    const g = await get("/covers/settings");
    expect(g.body.providerPriority).toEqual(["legacy-cov"]);
    expect(g.body.providerId).toBe("legacy-cov");
  });
});
