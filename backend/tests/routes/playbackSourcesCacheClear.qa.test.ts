// ==================== QA 独立复验:P2-1 保存优先级后清空换源/可播缓存 ====================
//
// 端到端(真实 HTTP PUT)验证修复 1:
//   ① 先让某歌产生缓存(负结果 unplayable / 正结果 playable),经 PUT 合法优先级 → 断言
//      getCachedPlayability 回到 "unknown"(缓存确被清,且是应用层清而非 TTL 巧合——TTL 秒级)。
//   ② 反向:PUT 非数组被 400 拒绝 → 缓存必须**原样保留**(防止误清)。
//   ③ 连续两次合法 PUT 稳定、无异常。
// MUST be the first import: redirects DATA_DIR to an isolated temp dir.
import "../plugins/_env.js";

import { describe, it, expect, beforeAll, afterEach, vi } from "vitest";
import { Hono } from "hono";
import md5 from "md5";
import { db, initDatabase, sqlite, encryptPassword } from "../../src/db/index.js";
import { users, songs } from "../../src/db/schema.js";
import { eq } from "drizzle-orm";
import { authMiddleware } from "../../src/middleware/auth.js";
import { apiRoutes } from "../../src/routes/api/index.js";
import { registerPlugin, unregisterPlugin } from "../../src/plugins/registry.js";
import { _resetSettingsCacheForTest } from "../../src/services/settings.js";
import { STREAM_SOURCE_PRIORITY_KEY, getStreamSourcePriority } from "../../src/services/source/online/streamSourcePriority.js";
import {
  clearStreamFallbackCache,
  findFallbackStream,
  getCachedPlayability,
} from "../../src/services/source/online/streamFallback.js";

const app = new Hono();
app.use("/rest/api/*", authMiddleware);
app.route("/rest/api", apiRoutes);

const ADMIN_PASS = "hunter2";
const CLIENT_SALT = "clientsalt123";
const adminQS = `u=alice&t=${md5(ADMIN_PASS + CLIENT_SALT)}&s=${CLIENT_SALT}`;

async function put(body: any) {
  const res = await app.request(`/rest/api/v1/playback-sources/settings?${adminQS}`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

const NOW = new Date().toISOString();
const cleanups: Array<() => void> = [];

function persistEnabled(id: string, manifest: any) {
  sqlite
    .prepare(
      "INSERT INTO plugins (id, name, version, description, manifest, enabled, config, created_at, updated_at) VALUES (?,?,?,?,?,1,'{}',?,?) ON CONFLICT(id) DO UPDATE SET enabled = 1, manifest = excluded.manifest",
    )
    .run(id, id, manifest.version || "1.0.0", "", JSON.stringify(manifest), NOW, NOW);
}

function reg(id: string, caps: string[], impl: any, extra: Record<string, any> = {}): void {
  const manifest = { id, name: extra.name || id, version: "1.0.0", type: "source", capabilities: caps, platforms: [], configSchema: [], permissions: ["net"], ...extra };
  registerPlugin(manifest as any, impl);
  persistEnabled(id, manifest);
  cleanups.push(() => {
    try { unregisterPlugin(id); } catch { /* gone */ }
    try { sqlite.prepare("DELETE FROM plugins WHERE id = ?").run(id); } catch { /* noop */ }
  });
}

function insertSong(id: string, pluginEntry = "qa-owner") {
  db.insert(songs)
    .values({ id, title: "碎碎念", artist: "队长", album: "", duration: 240, path: `/tmp/${id}.mp3`, type: "web", pluginEntry, sourceData: JSON.stringify({ source: "kuwo", remoteId: "1" }) })
    .run();
  cleanups.push(() => { try { sqlite.prepare("DELETE FROM songs WHERE id = ?").run(id); } catch { /* noop */ } });
}

function cand(source: string, url: string) {
  return { id: source, source, name: "碎碎念", artist: "队长", album: "", duration: 240, cover: "", url };
}

function clearPrioritySetting() {
  sqlite.prepare("DELETE FROM settings WHERE key = ?").run(STREAM_SOURCE_PRIORITY_KEY);
  _resetSettingsCacheForTest();
}

/** 注册本尊 search+stream,候选探测结果由 fetch stub 决定。 */
function regOwner() {
  const impl = {
    search: async () => ({ songs: [cand("netease", "http://owner/n.mp3")] }),
    streamUrl: (_c: any, s: any) => String(s.url || ""),
  };
  reg("qa-owner", ["search", "stream"], impl, { name: "OWNER" });
}

/** 通过真实换源链路把缓存种进去,返回 findFallbackStream 结果。 */
async function seedCache(songId: string, probeStatus: number) {
  insertSong(songId);
  vi.stubGlobal("fetch", vi.fn(async () => new Response(new ArrayBuffer(8), { status: probeStatus, headers: { "content-type": probeStatus === 206 ? "audio/mpeg" : "text/html" } })));
  return findFallbackStream(songId, "碎碎念", "队长", "", 240, "qa-owner", "qq");
}

beforeAll(() => {
  if (!process.env.APP_VERSION) process.env.APP_VERSION = "1.0.0";
  initDatabase();
  if (!db.select().from(users).where(eq(users.username, "alice")).get()) {
    db.insert(users).values({ id: "u1", username: "alice", password: "", salt: "salt", subsonicSalt: "subsalt", passEnc: encryptPassword(ADMIN_PASS), isAdmin: 1, isActive: 1, email: "a@b.c" }).run();
  }
});

afterEach(() => {
  vi.unstubAllGlobals();
  while (cleanups.length) cleanups.pop()!();
  sqlite.prepare("UPDATE plugins SET enabled = 0").run(); // 停用内置源插件,保证确定性
  clearStreamFallbackCache();
  clearPrioritySetting();
});

describe("QA 复验:PUT 保存优先级与换源缓存失效", () => {
  it("A1 已有负缓存(unplayable)→ PUT 合法优先级后缓存被清 → unknown", async () => {
    sqlite.prepare("UPDATE plugins SET enabled = 0").run();
    regOwner();
    const fb = await seedCache("qa-clr-neg", 404);
    expect(fb).toBeNull();
    expect(getCachedPlayability("qa-clr-neg")).toBe("unplayable"); // 种入成功

    const r = await put({ priority: ["qa-owner"] });
    expect(r.status).toBe(200);

    expect(getCachedPlayability("qa-clr-neg")).toBe("unknown"); // 修复 1:缓存确被清
  });

  it("A2 已有正缓存(playable)→ PUT 合法优先级后缓存被清 → unknown", async () => {
    sqlite.prepare("UPDATE plugins SET enabled = 0").run();
    regOwner();
    const fb = await seedCache("qa-clr-pos", 206);
    expect(fb).toEqual({ url: "http://owner/n.mp3", source: "netease" });
    expect(getCachedPlayability("qa-clr-pos")).toBe("playable");

    const r = await put({ priority: [] });
    expect(r.status).toBe(200);

    expect(getCachedPlayability("qa-clr-pos")).toBe("unknown");
  });

  it("B 反向:PUT 非数组被 400 拒绝 → 缓存必须原样保留(不误清)", async () => {
    sqlite.prepare("UPDATE plugins SET enabled = 0").run();
    regOwner();
    const fb = await seedCache("qa-keep-neg", 404);
    expect(fb).toBeNull();
    expect(getCachedPlayability("qa-keep-neg")).toBe("unplayable");

    const r = await put({ priority: "not-an-array" });
    expect(r.status).toBe(400);

    // 校验失败分支不得清缓存
    expect(getCachedPlayability("qa-keep-neg")).toBe("unplayable");
  });

  it("C 连续两次合法 PUT 稳定、无异常、回读一致", async () => {
    sqlite.prepare("UPDATE plugins SET enabled = 0").run();
    regOwner();
    // 用两个不同插件 id 验「去重保序」(历史 :platform 条目已收敛为同一插件,故改用两个 id)。
    const r1 = await put({ priority: ["qa-owner", "qa-owner-2", "qa-owner"] });
    const r2 = await put({ priority: ["qa-owner-2", "qa-owner"] });
    expect(r1.status).toBe(200);
    expect(r2.status).toBe(200);
    expect(r1.body.priority).toEqual(["qa-owner", "qa-owner-2"]); // 去重保序
    expect(r2.body.priority).toEqual(["qa-owner-2", "qa-owner"]);
    expect(getStreamSourcePriority()).toEqual(["qa-owner-2", "qa-owner"]);
  });
});
