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
import { listHomeCardPlugins, homePositionConflictForSave } from "../../src/services/pluginAccess.js";
import { FIXED_TODAY_ID } from "../../src/services/plugin/dailyRecommend.js";
import { LOCAL_FIXED_PLAYLIST_ID } from "../../src/services/plugin/localRecommend.js";
import { ROAM_PLAYLIST_ID } from "../../src/services/plugin/dailyRoam.js";
import { installInProcessBatchRunner } from "../batch/fakeRunner.js";

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
  // ensureHomePlaylist 经 runPluginJob 触发生成;默认会 fork 子进程,假插件仅在
  // 本进程注册,子进程看不到 → 改用进程内直调。
  installInProcessBatchRunner();
  initDatabase();
  if (!db.select().from(users).where(eq(users.username, "alice")).get()) {
    db.insert(users).values({ id: "u1", username: "alice", password: "", salt: "salt", subsonicSalt: "subsalt", passEnc: encryptPassword(PLAIN), isAdmin: 1, isActive: 1, email: "a@b.c" }).run();
  }
});

afterEach(() => {
  for (const id of ["f-fixed", "f-today", "f-local", "f-roam", "f-multi", "f-other"]) {
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


describe("fixedRecommend 多首页卡(homePlaylistIds)", () => {
  const MC_CARDS = [
    { id: "pl-mc-netease", name: "网易云历史日推", showOnHomeKey: "neteaseShowOnHome", positionKey: "neteaseHomePosition" },
    { id: "pl-mc-qq", name: "QQ历史日推", showOnHomeKey: "qqShowOnHome", positionKey: "qqHomePosition" },
    { id: "pl-mc-kugou", name: "酷狗历史日推", showOnHomeKey: "kugouShowOnHome", positionKey: "kugouHomePosition" },
  ];
  const MC_SCHEMA = [
    { key: "neteaseShowOnHome", type: "switch", default: true },
    { key: "neteaseHomePosition", type: "number", default: 1 },
    { key: "qqShowOnHome", type: "switch", default: true },
    { key: "qqHomePosition", type: "number", default: 2 },
    { key: "kugouShowOnHome", type: "switch", default: true },
    { key: "kugouHomePosition", type: "number", default: 3 },
  ];

  function registerMulti(impl?: any) {
    const manifest = {
      id: "f-multi", name: "多卡插件", version: "1.0.0", type: "recommender",
      capabilities: ["recommendPlaylist"],
      homePlaylistIds: MC_CARDS,
      configSchema: MC_SCHEMA,
    };
    registerPlugin(manifest as any, impl || { runDailyJob: async () => "ok", manifest: null });
    db.insert(plugins).values({ id: "f-multi", name: "f-multi", enabled: 1, config: "{}" }).run();
  }

  it("三张卡均按固定推荐歌单识别,未声明 id 不算", () => {
    registerMulti();
    expect(isFixedRecommendPlaylist("pl-mc-netease")).toBe(true);
    expect(isFixedRecommendPlaylist("pl-mc-qq")).toBe(true);
    expect(isFixedRecommendPlaylist("pl-mc-kugou")).toBe(true);
    expect(isFixedRecommendPlaylist("pl-mc-none")).toBe(false);
  });

  it("listHomeCardPlugins 按卡展开,各卡独立读取自己的 showOnHome/position 键", () => {
    registerMulti();
    const cards = listHomeCardPlugins().filter((c) => c.pluginId === "f-multi");
    expect(cards.length).toBe(3);
    expect(cards.find((c) => c.playlistId === "pl-mc-netease")).toMatchObject({ name: "网易云历史日推", showOnHome: true, position: 1 });
    expect(cards.find((c) => c.playlistId === "pl-mc-qq")).toMatchObject({ name: "QQ历史日推", showOnHome: true, position: 2 });
    expect(cards.find((c) => c.playlistId === "pl-mc-kugou")).toMatchObject({ name: "酷狗历史日推", showOnHome: true, position: 3 });
  });

  it("单数 homePlaylistId 回落:单卡、键 showOnHome/homePosition、名称用插件名(行为不变)", () => {
    const p = fakeRecommender("f-other", "recommendPlaylist", "pl-single-home");
    registerPlugin(p.manifest as any, p.impl as any);
    db.insert(plugins).values({ id: "f-other", name: "f-other", enabled: 1, config: "{}" }).run();
    const cards = listHomeCardPlugins().filter((c) => c.pluginId === "f-other");
    expect(cards.length).toBe(1);
    expect(cards[0]).toMatchObject({ playlistId: "pl-single-home", name: "插件 f-other", showOnHome: false, position: 0 });
    expect(isFixedRecommendPlaylist("pl-single-home")).toBe(true);
  });

  it("位次冲突:同插件两张卡占同一位次 → 拒绝(自身卡间)", () => {
    registerMulti();
    const r = homePositionConflictForSave("f-multi", { neteaseHomePosition: 21, qqHomePosition: 21, kugouHomePosition: 23 });
    expect(r).toContain("首页位次 21");
    expect(r).toContain("占用");
  });

  it("位次冲突:与其它启用插件的卡同位次 → 拒绝,文案带对方卡名", () => {
    registerMulti();
    const p = fakeRecommender("f-other", "recommendPlaylist", "pl-single-home");
    registerPlugin(p.manifest as any, p.impl as any);
    db.insert(plugins).values({ id: "f-other", name: "f-other", enabled: 1, config: JSON.stringify({ showOnHome: true, homePosition: 21 }) }).run();
    const r = homePositionConflictForSave("f-multi", { neteaseHomePosition: 21, qqHomePosition: 22, kugouHomePosition: 23 });
    expect(r).toContain("首页位次 21");
    expect(r).toContain("插件 f-other");
  });

  it("位次不冲突 → null;未显示的卡不参与冲突", () => {
    registerMulti();
    expect(homePositionConflictForSave("f-multi", { neteaseHomePosition: 31, qqHomePosition: 32, kugouHomePosition: 33 })).toBeNull();
    expect(homePositionConflictForSave("f-multi", { qqShowOnHome: false, neteaseHomePosition: 34, kugouHomePosition: 35 })).toBeNull();
  });
});
