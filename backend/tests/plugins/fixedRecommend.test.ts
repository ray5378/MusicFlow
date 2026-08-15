// MUST be the first import: redirects DATA_DIR to an isolated temp dir before
// the backend opens its SQLite DB at module-load time.
import "../plugins/_env.js";

import { describe, it, expect, beforeAll, afterEach } from "vitest";
import { Hono } from "hono";
import md5 from "md5";
import { db, initDatabase, encryptPassword, sqlite } from "../../src/db/index.js";
import { users, plugins, playlists, playlistSongs } from "../../src/db/schema.js";
import { eq } from "drizzle-orm";
import { authMiddleware } from "../../src/middleware/auth.js";
import { apiRoutes } from "../../src/routes/api/index.js";
import { registerPlugin, unregisterPlugin } from "../../src/plugins/registry.js";
import { isFixedRecommendPlaylist, ensureHomePlaylist } from "../../src/services/plugin/fixedRecommend.js";
import { FIXED_TODAY_ID } from "../../src/services/plugin/dailyRecommend.js";
import { LOCAL_FIXED_PLAYLIST_ID } from "../../src/services/plugin/localRecommend.js";
import { ROAM_PLAYLIST_ID } from "../../src/services/plugin/dailyRoam.js";

// 固定推荐歌单契约:pl-daily-today/local/roam 永远固定,供音流稳定引用——
// 识别(内置兜底 + manifest 动态)、自愈(缺失触发生成)、删除保护(管理端 400)。
const app = new Hono();
app.use("/rest/api/*", authMiddleware);
app.route("/rest/api", apiRoutes);

const PLAIN = "hunter2";
const CLIENT_SALT = "clientsalt123";
const authQS = () => `u=alice&t=${md5(PLAIN + CLIENT_SALT)}&s=${CLIENT_SALT}`;

beforeAll(() => {
  if (!process.env.APP_VERSION) process.env.APP_VERSION = "1.0.0";
  initDatabase();
  if (!db.select().from(users).where(eq(users.username, "alice")).get()) {
    db.insert(users).values({ id: "u1", username: "alice", password: "", salt: "salt", subsonicSalt: "subsalt", passEnc: encryptPassword(PLAIN), isAdmin: 1, isActive: 1, email: "a@b.c" }).run();
  }
});

afterEach(() => {
  for (const id of ["f-fixed", "f-today", "f-local", "f-roam"]) {
    db.delete(plugins).where(eq(plugins.name, id)).run();
    unregisterPlugin(id);
  }
});

function fakeRecommender(id: string, cap: string, playlistId: string, runDailyJob?: () => Promise<any>) {
  return {
    manifest: {
      id, name: `插件 ${id}`, version: "1.0.0", type: "recommender",
      capabilities: [cap],
      homePlaylistId: playlistId,
      configSchema: [],
    },
    impl: { runDailyJob: runDailyJob || (async () => "ok"), manifest: null },
  };
}

function seedPlaylistWithContent(id: string, name: string) {
  const owner = sqlite.prepare("SELECT id FROM users WHERE is_admin = 1 LIMIT 1").get() as any;
  const now = new Date().toISOString();
  if (!sqlite.prepare("SELECT id FROM playlists WHERE id = ?").get(id)) {
    sqlite.prepare("INSERT INTO playlists (id, name, owner_id, is_public, comment, created_at, updated_at) VALUES (?,?,?,1,'',?,?)")
      .run(id, name, owner.id, now, now);
  }
  // 可播条目:playable=1 + song_id 非空(hasPlayableContent 同款标准)。id 自增。
  // song_id 有外键指向 songs,先插最小 songs 行。
  if (!sqlite.prepare("SELECT id FROM songs WHERE id = 's-fixed-1'").get()) {
    sqlite.prepare("INSERT INTO songs (id, title, path) VALUES ('s-fixed-1', '测试歌曲', '/tmp/fixed.mp3')").run();
  }
  if (!sqlite.prepare("SELECT id FROM playlist_songs WHERE playlist_id = ? AND song_id = 's-fixed-1'").get(id)) {
    sqlite.prepare("INSERT INTO playlist_songs (playlist_id, song_id, playable, position) VALUES (?,?,1,0)")
      .run(id, "s-fixed-1");
  }
}

describe("fixedRecommend 固定推荐歌单契约", () => {
  it("内置三个固定 id 恒被识别(不依赖插件注册/启用)", () => {
    expect(isFixedRecommendPlaylist(FIXED_TODAY_ID)).toBe(true);
    expect(isFixedRecommendPlaylist(LOCAL_FIXED_PLAYLIST_ID)).toBe(true);
    expect(isFixedRecommendPlaylist(ROAM_PLAYLIST_ID)).toBe(true);
  });

  it("动态识别:任意启用插件 manifest.homePlaylistId 也算固定", () => {
    const p = fakeRecommender("f-fixed", "dailyPlaylist", "pl-custom-home");
    registerPlugin(p.manifest as any, p.impl as any);
    db.insert(plugins).values({ id: "f-fixed", name: "f-fixed", enabled: 1, config: "{}" }).run();
    expect(isFixedRecommendPlaylist("pl-custom-home")).toBe(true);
  });

  it("普通/空 id 不是固定推荐歌单", () => {
    expect(isFixedRecommendPlaylist("pl-user-1")).toBe(false);
    expect(isFixedRecommendPlaylist("")).toBe(false);
    expect(isFixedRecommendPlaylist("pl-daily-custom")).toBe(false);
  });

  it("ensureHomePlaylist:非固定歌单不做自动生成", async () => {
    const r = await ensureHomePlaylist("pl-user-1");
    expect(r.ok).toBe(false);
    expect(r.reason).toContain("非固定");
  });

  it("ensureHomePlaylist:歌单已有可播内容直接 ok,不触发生成", async () => {
    seedPlaylistWithContent("pl-daily-today", "每日推荐");
    const called: string[] = [];
    const p = fakeRecommender("f-today", "dailyPlaylist", "pl-daily-today", async () => { called.push("run"); return "ok"; });
    registerPlugin(p.manifest as any, p.impl as any);
    db.insert(plugins).values({ id: "f-today", name: "f-today", enabled: 1, config: "{}" }).run();
    const r = await ensureHomePlaylist("pl-daily-today", { timeoutMs: 500 });
    expect(r.ok).toBe(true);
    expect(called.length).toBe(0); // 未触发任何任务
  });

  it("ensureHomePlaylist:固定歌单缺失 → 触发插件生成,轮询超时返回原因", async () => {
    // 清理内置推荐插件(apiRoutes import 会注册),确保 findHomePlugin 命中假插件,
    // 避免真实 daily-recommend runDailyJob 联网生成。
    for (const id of ["daily-recommend", "local-recommend", "daily-roam"]) {
      db.delete(plugins).where(eq(plugins.name, id)).run();
      unregisterPlugin(id);
    }
    // 确保该 id 无内容(临时删条目)。
    sqlite.prepare("DELETE FROM playlist_songs WHERE playlist_id = ?").run("pl-daily-today");
    const called: string[] = [];
    const p = fakeRecommender("f-today", "dailyPlaylist", "pl-daily-today", async () => { called.push("run"); return "ok"; });
    registerPlugin(p.manifest as any, p.impl as any);
    db.insert(plugins).values({ id: "f-today", name: "f-today", enabled: 1, config: "{}" }).run();
    const r = await ensureHomePlaylist("pl-daily-today", { timeoutMs: 400 });
    expect(called.length).toBe(1); // 目标插件被触发
    expect(r.ok).toBe(false);
    expect(r.triggered).toBe(true);
    expect(r.reason).toContain("超时");
  });

  it("删除保护:管理端 DELETE 固定推荐歌单 → 400", async () => {
    const owner = sqlite.prepare("SELECT id FROM users WHERE is_admin = 1 LIMIT 1").get() as any;
    sqlite.prepare("INSERT OR IGNORE INTO playlists (id, name, owner_id, is_public, comment, created_at, updated_at) VALUES ('pl-daily-roam','今日漫游',?,1,'',?,?)")
      .run(owner.id, new Date().toISOString(), new Date().toISOString());
    const res = await app.request(`/rest/api/playlist/pl-daily-roam?${authQS()}`, { method: "DELETE" });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain("固定推荐歌单");
    // 行仍在。
    expect(sqlite.prepare("SELECT id FROM playlists WHERE id = 'pl-daily-roam'").get()).toBeTruthy();
  });

  it("删除保护:普通歌单仍可删除(不受影响)", async () => {
    seedPlaylistWithContent("pl-normal-del", "普通歌单");
    const res = await app.request(`/rest/api/playlist/pl-normal-del?${authQS()}`, { method: "DELETE" });
    expect(res.status).toBe(200);
    expect(sqlite.prepare("SELECT id FROM playlists WHERE id = 'pl-normal-del'").get()).toBeFalsy();
  });
});
