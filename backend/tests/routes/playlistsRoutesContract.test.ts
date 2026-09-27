// routes/api/playlists.ts 路由层契约测试(14 条路由)。
//
// 这个文件几乎全是真实 DB 逻辑(分页/过滤/排序/收藏多对多),所以**用真库测**:
// 只把「插件同步提供方 syncApi」「异步任务 startAsyncTask」「曲库索引缓存清理」等
// 外部副作用换成假体。这样既覆盖路由分支,又顺带验证 SQL 过滤与排序真的成立。
import "../plugins/_env.js";

import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import { Hono } from "hono";
import { v4 as uuidv4 } from "uuid";
import { eq } from "drizzle-orm";

vi.mock("../../src/routes/api/shared.js", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const { overrides } = await import("./_sharedFakes.js");
  return { ...actual, ...overrides };
});

import { db, initDatabase } from "../../src/db/index.js";
import { albums, playlistFavorites, playlistSongs, playlists, songs, users } from "../../src/db/schema.js";
import { registerPlaylists } from "../../src/routes/api/playlists.js";
import { fns, resetFakes } from "./_sharedFakes.js";

type Any = any;

let currentUser: Any = { id: "u-owner", isAdmin: false };

const app = new Hono();
app.use("*", async (c, next) => {
  if (currentUser) c.set("user", currentUser);
  await next();
});
registerPlaylists(app);

const OWNER = "u-owner";
const OTHER = "u-other";

const post = (p: string, body?: unknown) =>
  app.request(p, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body ?? {}) });
const put = (p: string, body?: unknown) =>
  app.request(p, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(body ?? {}) });
const del = (p: string) => app.request(p, { method: "DELETE" });
const get = (p: string) => app.request(p);

/** 造一个受控的插件同步提供方并交给 syncApi()。 */
function makeSyncApi(over: Any = {}) {
  const api = {
    checkImportCooldown: vi.fn(() => false),
    rebuildPlaylistEntries: vi.fn(async () => ({ total: 3, matched: 2, unmatched: 1, wishAdded: 0 })),
    exportPlaylistEntries: vi.fn(() => ({ name: "PL", tracks: [{ title: "t" }] })),
    ...over,
  };
  fns.syncApi.mockReturnValue(api);
  return api;
}

function seedPlaylist(over: Any = {}) {
  const id = over.id ?? `pl-${uuidv4().slice(0, 8)}`;
  db.insert(playlists).values({
    id, name: "PL", ownerId: OWNER,
    createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
    ...over,
  }).run();
  return id;
}

function seedSong(over: Any = {}) {
  const id = over.id ?? `s-${uuidv4().slice(0, 8)}`;
  db.insert(songs).values({ id, title: "曲", path: `l:t:/x/${id}.mp3`, ...over }).run();
  return id;
}

/** playlist_songs.id 是 INTEGER PRIMARY KEY(=rowid 别名),不传即自增。 */
function seedEntry(over: Any = {}) {
  db.insert(playlistSongs).values({ playlistId: "pl-x", position: 0, playable: 1, ...over }).run();
}

function rowOf(id: string) {
  return db.select().from(playlists).where(eq(playlists.id, id)).get();
}

/** playlists.owner_id / playlist_favorites.user_id 有外键指向 users,必须先建用户。 */
function seedUser(id: string, isAdmin = 0) {
  if (db.select().from(users).where(eq(users.id, id)).get()) return;
  db.insert(users).values({
    id, username: `u-${id}`, password: "", salt: "s", subsonicSalt: "ss",
    passEnc: "x", isAdmin, isActive: 1, email: "",
  }).run();
}

beforeAll(() => {
  if (!process.env.APP_VERSION) process.env.APP_VERSION = "1.0.0";
  initDatabase();
  seedUser(OWNER);
  seedUser(OTHER);
  seedUser("u-admin", 1);
});

beforeEach(() => {
  resetFakes();
  currentUser = { id: OWNER, isAdmin: false };
  // 真库跨用例累计:每次清空本文件用到的表(先子后父,避免外键报错)。
  db.delete(playlistFavorites).run();
  db.delete(playlistSongs).run();
  db.delete(playlists).run();
  db.delete(songs).run();
  db.delete(albums).run();
});

// ==================== POST /v1/playlists/import ====================

describe("POST /v1/playlists/import", () => {
  it("既无 url 也无 native → 400", async () => {
    const r = await post("/v1/playlists/import", {});
    expect(r.status).toBe(400);
    expect((await r.json() as Any).code).toBe("INVALID_PARAM");
  });

  it("native 分支:同步提供方不可用 → 503", async () => {
    fns.syncApi.mockReturnValue(null);
    fns.parsePlaylistFile.mockReturnValue([{ name: "A", platform: "local", tracks: [] }]);
    const r = await post("/v1/playlists/import", { native: { app: "MusicFlow" } });
    expect(r.status).toBe(503);
    expect((await r.json() as Any).code).toBe("UNAVAILABLE");
  });

  it("native 分支:成功时聚合各歌单的 total/matched/unmatched/wishAdded", async () => {
    const api = makeSyncApi({
      rebuildPlaylistEntries: vi.fn(async () => ({ total: 4, matched: 3, unmatched: 1, wishAdded: 2 })),
    });
    fns.parsePlaylistFile.mockReturnValue([
      { name: "  早间  ", platform: "local", tracks: [] },
      { name: "", platform: "local", tracks: [] },
    ]);
    const r = await post("/v1/playlists/import", { native: { app: "MusicFlow" } });
    expect(r.status).toBe(200);
    const b = await r.json() as Any;
    expect(b.success).toBe(true);
    expect(b.platform).toBe("local");
    expect(b.created).toBe(2);
    expect(b.trackCount).toBe(8);
    expect(b.matched).toBe(6);
    expect(b.unmatched).toBe(2);
    expect(b.wishAdded).toBe(4);
    expect(b.name).toBe("早间"); // 前后空白被 trim
    expect(api.rebuildPlaylistEntries).toHaveBeenCalledTimes(2);
    // 名称留空的那条:入库名与备注都回落「导入歌单」
    expect(api.rebuildPlaylistEntries.mock.calls[1][2].notes).toContain("导入歌单");
    const names = db.select().from(playlists).where(eq(playlists.ownerId, OWNER)).all().map((r) => r.name).sort();
    expect(names).toEqual(["导入歌单", "早间"]);
    // 归属人 = 当前用户;平台歌单同步开关默认关闭
    const created = rowOf(b.playlistId);
    expect(created?.ownerId).toBe(OWNER);
    expect(created?.syncEnabled).toBe(0);
    expect(created?.sourceUrl).toBeNull();
    // 收尾:回收曲库索引缓存 + 标记活动
    expect(fns.clearLibraryIndex).toHaveBeenCalledTimes(1);
    expect(fns.touch).toHaveBeenCalledTimes(1);
  });

  it("native 分支:空歌单列表 → created 0、name 回落、totals 全 0", async () => {
    makeSyncApi();
    fns.parsePlaylistFile.mockReturnValue([]);
    const b = await (await post("/v1/playlists/import", { native: { app: "MusicFlow" } })).json() as Any;
    expect(b.created).toBe(0);
    expect(b.playlistId).toBeUndefined();
    expect(b.name).toBe("导入歌单");
    expect(b.trackCount).toBe(0);
    expect(await (await get("/v1/playlists")).json()).toBeTruthy();
  });

  it("URL 分支:命中导入冷却 → 409,且不起任务", async () => {
    makeSyncApi({ checkImportCooldown: vi.fn(() => true) });
    const r = await post("/v1/playlists/import", { url: "http://x/pl" });
    expect(r.status).toBe(409);
    expect(fns.startAsyncTask).not.toHaveBeenCalled();
  });

  it("URL 分支:同步提供方不可用 → 503(且不写库)", async () => {
    fns.syncApi.mockReturnValue(null);
    const before = db.select().from(playlists).all().length;
    const r = await post("/v1/playlists/import", { url: "http://x/pl" });
    expect(r.status).toBe(503);
    expect(db.select().from(playlists).all().length).toBe(before);
  });

  it("URL 分支:正常 → 返回 taskId;已在跑 → alreadyRunning", async () => {
    makeSyncApi();
    fns.startAsyncTask.mockReturnValue({ started: true, taskId: "t-1" });
    expect(await (await post("/v1/playlists/import", { url: "http://x/pl" })).json()).toEqual({ success: true, taskId: "t-1" });

    fns.startAsyncTask.mockReturnValue({ started: false, taskId: "t-2" });
    expect(await (await post("/v1/playlists/import", { url: "http://x/pl" })).json()).toEqual({ success: false, alreadyRunning: true, taskId: "t-2" });
  });

  it("URL 分支:参数透传(name 仅接受字符串,autoSync 转布尔)", async () => {
    makeSyncApi();
    await post("/v1/playlists/import", { url: " http://x/pl ", name: "N", autoSync: 1 });
    const [, key, opts] = fns.startAsyncTask.mock.calls.at(-1) as Any[];
    expect(key).toBe(`url:http://x/pl:${OWNER}`); // url 已 trim
    expect(opts.args).toEqual({ url: "http://x/pl", userId: OWNER, name: "N", autoSync: true });

    await post("/v1/playlists/import", { url: "http://x/pl", name: 123 });
    expect((fns.startAsyncTask.mock.calls.at(-1) as Any[])[2].args.name).toBeUndefined();
  });
});

// ==================== 导出 ====================

describe("GET /v1/playlists/:id/export 与 /export-all", () => {
  it("歌单不存在 → 404", async () => {
    expect((await get("/v1/playlists/nope/export")).status).toBe(404);
  });

  it("非属主且非管理员 → 403", async () => {
    const id = seedPlaylist({ ownerId: OTHER });
    expect((await get(`/v1/playlists/${id}/export`)).status).toBe(403);
  });

  it("同步提供方不可用 → 503", async () => {
    fns.syncApi.mockReturnValue(null);
    const id = seedPlaylist();
    expect((await get(`/v1/playlists/${id}/export`)).status).toBe(503);
  });

  it("成功 → 原生 JSON 载荷 + Content-Disposition(非法文件名字符被替换)", async () => {
    makeSyncApi({ exportPlaylistEntries: vi.fn(() => ({ name: 'a/b:c*d?e"f<g>h|i', tracks: [{ title: "t" }] })) });
    const id = seedPlaylist();
    const r = await get(`/v1/playlists/${id}/export`);
    expect(r.status).toBe(200);
    const b = await r.json() as Any;
    expect(b.app).toBe("MusicFlow");
    expect(b.version).toBe(1);
    expect(b.name).toBe('a/b:c*d?e"f<g>h|i');
    expect(b.tracks).toEqual([{ title: "t" }]);
    expect(typeof b.exportedAt).toBe("string");
    const cd = r.headers.get("content-disposition")!;
    expect(cd).toContain("attachment;");
    expect(decodeURIComponent(cd)).toContain("a_b_c_d_e_f_g_h_i.json");
  });

  it("导出全部:逐条取导出内容;提供方返回空时给空名与空曲目", async () => {
    makeSyncApi({
      exportPlaylistEntries: vi.fn((pid: string) => (pid === "pl-a" ? { name: "A", tracks: [1] } : undefined)),
    });
    seedPlaylist({ id: "pl-a", ownerId: OWNER });
    seedPlaylist({ id: "pl-b", ownerId: OWNER });
    seedPlaylist({ id: "pl-c", ownerId: OTHER }); // 他人歌单不进导出
    const r = await get("/v1/playlists/export-all");
    expect(r.status).toBe(200);
    const b = await r.json() as Any;
    expect(b.exportAll).toBe(true);
    expect(b.playlists).toHaveLength(2);
    expect(b.playlists.map((p: Any) => p.name)).toEqual(["A", ""]);
    expect(b.playlists[1].tracks).toEqual([]);
    expect(r.headers.get("content-disposition")).toContain("attachment;");
  });

  it("导出全部:syncApi 缺失时仍返回结构(空内容),不炸", async () => {
    fns.syncApi.mockReturnValue(null);
    seedPlaylist({ id: "pl-z", ownerId: OWNER });
    const b = await (await get("/v1/playlists/export-all")).json() as Any;
    expect(b.playlists).toHaveLength(1);
    expect(b.playlists[0]).toEqual({ name: "", tracks: [] });
  });
});

// ==================== 同步 / 修改 / 转本地 ====================

describe("POST /v1/playlists/:id/sync", () => {
  it("不存在 404 / 非属主 403 / 提供方缺失 503", async () => {
    expect((await post("/v1/playlists/nope/sync")).status).toBe(404);
    const foreign = seedPlaylist({ ownerId: OTHER });
    expect((await post(`/v1/playlists/${foreign}/sync`)).status).toBe(403);
    fns.syncApi.mockReturnValue(null);
    const mine = seedPlaylist();
    expect((await post(`/v1/playlists/${mine}/sync`)).status).toBe(503);
  });

  it("正常 → taskId;已在跑 → alreadyRunning", async () => {
    makeSyncApi();
    const id = seedPlaylist();
    fns.startAsyncTask.mockReturnValue({ started: true, taskId: "s-1" });
    expect(await (await post(`/v1/playlists/${id}/sync`)).json()).toEqual({ success: true, taskId: "s-1" });

    fns.startAsyncTask.mockReturnValue({ started: false, taskId: "s-2" });
    expect(await (await post(`/v1/playlists/${id}/sync`)).json()).toEqual({ success: false, alreadyRunning: true, taskId: "s-2" });
  });

  it("管理员可同步他人歌单", async () => {
    makeSyncApi();
    currentUser = { id: "u-admin", isAdmin: true };
    const foreign = seedPlaylist({ ownerId: OTHER });
    expect((await post(`/v1/playlists/${foreign}/sync`)).status).toBe(200);
  });
});

describe("PUT /v1/playlists/:id(改名/公开/同步开关)", () => {
  it("不存在 404 / 非属主 403", async () => {
    expect((await put("/v1/playlists/nope", { name: "x" })).status).toBe(404);
    const foreign = seedPlaylist({ ownerId: OTHER });
    expect((await put(`/v1/playlists/${foreign}`, { name: "x" })).status).toBe(403);
  });

  it("名称 trim 后落库;空名保留原名(不会把歌单改成空标题)", async () => {
    const id = seedPlaylist({ name: "原名" });
    await put(`/v1/playlists/${id}`, { name: "  新名  " });
    expect(rowOf(id)?.name).toBe("新名");
    await put(`/v1/playlists/${id}`, { name: "   " });
    expect(rowOf(id)?.name).toBe("新名");
  });

  it("isPublic / syncEnabled 转 0/1;updatedAt 被刷新", async () => {
    const id = seedPlaylist({ updatedAt: "2020-01-01T00:00:00.000Z" });
    await put(`/v1/playlists/${id}`, { isPublic: true, syncEnabled: true });
    let row = rowOf(id)!;
    expect(row.isPublic).toBe(1);
    expect(row.syncEnabled).toBe(1);
    expect(row.updatedAt).not.toBe("2020-01-01T00:00:00.000Z");

    await put(`/v1/playlists/${id}`, { isPublic: false, syncEnabled: 0 });
    row = rowOf(id)!;
    expect(row.isPublic).toBe(0);
    expect(row.syncEnabled).toBe(0);
  });

  it("body 非法 JSON → 按空对象处理(只刷新 updatedAt)", async () => {
    const id = seedPlaylist({ name: "keep" });
    const r = await app.request(`/v1/playlists/${id}`, { method: "PUT", body: "{{{" });
    expect(r.status).toBe(200);
    expect(rowOf(id)?.name).toBe("keep");
  });
});

describe("POST /v1/playlists/:id/convert-to-local", () => {
  it("不存在 404 / 非属主 403 / 已是本地 409", async () => {
    expect((await post("/v1/playlists/nope/convert-to-local")).status).toBe(404);
    const foreign = seedPlaylist({ ownerId: OTHER, sourceUrl: "http://x" });
    expect((await post(`/v1/playlists/${foreign}/convert-to-local`)).status).toBe(403);
    const local = seedPlaylist({ sourceUrl: null });
    const r = await post(`/v1/playlists/${local}/convert-to-local`);
    expect(r.status).toBe(409);
    expect((await r.json() as Any).code).toBe("CONFLICT");
  });

  it("平台歌单转本地:清掉来源/同步开关与「每日推荐歌单·」注释", async () => {
    const id = seedPlaylist({ sourceUrl: "http://x/pl", externalId: "e1", sourcePlatform: "go-music-dl", syncEnabled: 1, comment: "每日推荐歌单·go-music-dl" });
    const r = await post(`/v1/playlists/${id}/convert-to-local`);
    expect(r.status).toBe(200);
    const row = rowOf(id)!;
    expect(row.sourceUrl).toBeNull();
    expect(row.externalId).toBeNull();
    expect(row.sourcePlatform).toBe("");
    expect(row.syncEnabled).toBe(0);
    expect(row.comment).toBe("");
  });

  it("非每日推荐注释保持不动(转换不该抹掉用户备注)", async () => {
    const id = seedPlaylist({ sourceUrl: "http://x/pl", comment: "我的备注" });
    await post(`/v1/playlists/${id}/convert-to-local`);
    expect(rowOf(id)?.comment).toBe("我的备注");
  });
});

// ==================== 收藏(多对多) ====================

describe("POST /v1/playlists/:id/favorite", () => {
  it("不存在 → 404", async () => {
    expect((await post("/v1/playlists/nope/favorite", { favorite: true })).status).toBe(404);
  });

  it("收藏本地歌单:写多对多关系 + 置全局标记,保持原 syncEnabled", async () => {
    const id = seedPlaylist({ sourceUrl: null, syncEnabled: 0 });
    const r = await post(`/v1/playlists/${id}/favorite`, { favorite: true });
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ success: true, favorite: true });
    expect(db.select().from(playlistFavorites).where(eq(playlistFavorites.playlistId, id)).all()).toHaveLength(1);
    expect(rowOf(id)?.favorite).toBe(1);
    expect(rowOf(id)?.syncEnabled).toBe(0);
  });

  it("收藏平台歌单 → 自动打开每天同步", async () => {
    const id = seedPlaylist({ sourceUrl: "http://x/pl", syncEnabled: 0 });
    await post(`/v1/playlists/${id}/favorite`, { favorite: true });
    expect(rowOf(id)?.syncEnabled).toBe(1);
  });

  it("重复收藏幂等(唯一键冲突被吞,不 500)", async () => {
    const id = seedPlaylist();
    await post(`/v1/playlists/${id}/favorite`, { favorite: true });
    const r = await post(`/v1/playlists/${id}/favorite`, { favorite: true });
    expect(r.status).toBe(200);
    expect(db.select().from(playlistFavorites).where(eq(playlistFavorites.playlistId, id)).all()).toHaveLength(1);
  });

  it("收藏是按用户隔离的:另一用户收藏不影响我的收藏态", async () => {
    // 用公开歌单:收藏不改变可见性,两人都能看到它,才能比较各自 favorite 状态。
    const id = seedPlaylist({ isPublic: 1 });
    currentUser = { id: OTHER, isAdmin: false };
    await post(`/v1/playlists/${id}/favorite`, { favorite: true });

    const asOther = await (await get("/v1/playlists?favorite=1&pageSize=500")).json() as Any;
    expect(asOther.items.map((i: Any) => i.id)).toContain(id);
    expect(asOther.items.find((i: Any) => i.id === id).favorite).toBe(true);

    currentUser = { id: OWNER, isAdmin: false };
    const asOwner = await (await get("/v1/playlists?favorite=1&pageSize=500")).json() as Any;
    expect(asOwner.items).toHaveLength(0); // 属主没收藏

    const ownerView = await (await get("/v1/playlists?pageSize=500")).json() as Any;
    expect(ownerView.items.find((i: Any) => i.id === id).favorite).toBe(false);
  });

  it("取消收藏:仅删自己的记录;无人收藏时清掉全局标记", async () => {
    const id = seedPlaylist();
    await post(`/v1/playlists/${id}/favorite`, { favorite: true });
    const r = await post(`/v1/playlists/${id}/favorite`, { favorite: false });
    expect(await r.json()).toEqual({ success: true, favorite: false });
    expect(db.select().from(playlistFavorites).where(eq(playlistFavorites.playlistId, id)).all()).toHaveLength(0);
    expect(rowOf(id)?.favorite).toBe(0);
  });

  it("取消收藏:仍有别人收藏 → 全局标记保留", async () => {
    const id = seedPlaylist();
    currentUser = { id: OTHER, isAdmin: false };
    await post(`/v1/playlists/${id}/favorite`, { favorite: true });
    currentUser = { id: OWNER, isAdmin: false };
    await post(`/v1/playlists/${id}/favorite`, { favorite: true });
    await post(`/v1/playlists/${id}/favorite`, { favorite: false });
    expect(rowOf(id)?.favorite).toBe(1);
  });

  it("favorite 非 true 一律按取消处理(false 才是取消,别的值也不该当收藏)", async () => {
    const id = seedPlaylist();
    await post(`/v1/playlists/${id}/favorite`, { favorite: true });
    await post(`/v1/playlists/${id}/favorite`, { favorite: "yes" });
    expect(rowOf(id)?.favorite).toBe(0);
  });
});

// ==================== GET /v1/playlists(分页/过滤/排序) ====================

describe("GET /v1/playlists", () => {
  it("分页:page 最小 1,pageSize 上限 500、最小 1,非法值回落默认", async () => {
    seedPlaylist();
    const a = await (await get("/v1/playlists?page=0&pageSize=9999")).json() as Any;
    expect(a.page).toBe(1);
    expect(a.pageSize).toBe(500);

    const b = await (await get("/v1/playlists?page=-5&pageSize=0")).json() as Any;
    expect(b.page).toBe(1);
    expect(b.pageSize).toBe(20);

    const c = await (await get("/v1/playlists?page=abc&pageSize=xyz")).json() as Any;
    expect(c.page).toBe(1);
    expect(c.pageSize).toBe(20);
  });

  it("普通用户只看「自己 + 公开 + 导入(sourceUrl 非空)」", async () => {
    seedPlaylist({ id: "pl-mine", ownerId: OWNER });
    seedPlaylist({ id: "pl-pub", ownerId: OTHER, isPublic: 1 });
    seedPlaylist({ id: "pl-imported", ownerId: OTHER, sourceUrl: "http://x" });
    seedPlaylist({ id: "pl-hidden", ownerId: OTHER, isPublic: 0, sourceUrl: null });
    const b = await (await get("/v1/playlists?pageSize=500")).json() as Any;
    const ids = b.items.map((i: Any) => i.id).sort();
    expect(ids).toEqual(["pl-imported", "pl-mine", "pl-pub"]);
  });

  it("管理员看全部", async () => {
    currentUser = { id: "u-admin", isAdmin: true };
    seedPlaylist({ id: "pl-hidden2", ownerId: OTHER, isPublic: 0, sourceUrl: null });
    const b = await (await get("/v1/playlists?pageSize=500")).json() as Any;
    expect(b.items.map((i: Any) => i.id)).toContain("pl-hidden2");
  });

  it("query 按名称模糊匹配;platform / local 过滤生效", async () => {
    seedPlaylist({ id: "pl-q1", name: "夜跑歌单" });
    seedPlaylist({ id: "pl-q2", name: "专注" });
    expect((await (await get("/v1/playlists?query=夜跑&pageSize=500")).json() as Any).items.map((i: Any) => i.id)).toEqual(["pl-q1"]);

    seedPlaylist({ id: "pl-p1", sourcePlatform: "go-music-dl", sourceUrl: "http://x" });
    expect((await (await get("/v1/playlists?platform=go-music-dl&pageSize=500")).json() as Any).items.map((i: Any) => i.id)).toEqual(["pl-p1"]);
    expect((await (await get("/v1/playlists?local=1&pageSize=500")).json() as Any).items.map((i: Any) => i.id)).not.toContain("pl-p1");
  });

  it("排序:四种显式排序生效,未知值回落默认", async () => {
    const t = (s: string) => `2026-02-${s}T00:00:00.000Z`;
    seedPlaylist({ id: "pl-s1", name: "B", createdAt: t("01"), updatedAt: t("03") });
    seedPlaylist({ id: "pl-s2", name: "A", createdAt: t("02"), updatedAt: t("02") });
    const names = async (q: string) => {
      const b = await (await get(`/v1/playlists?pageSize=500&${q}`)).json() as Any;
      return b.items.filter((i: Any) => i.id.startsWith("pl-s")).map((i: Any) => i.id);
    };
    expect(await names("sort=created_asc")).toEqual(["pl-s1", "pl-s2"]);
    expect(await names("sort=created_desc")).toEqual(["pl-s2", "pl-s1"]);
    expect(await names("sort=name_asc")).toEqual(["pl-s2", "pl-s1"]);
    expect(await names("sort=name_desc")).toEqual(["pl-s1", "pl-s2"]);
    // 默认:按 COALESCE(updatedAt, createdAt) 倒序
    expect(await names("sort=whatever")).toEqual(["pl-s1", "pl-s2"]);
  });

  it("响应项形状:coverArt 前缀、songCount/duration 兜底 0、来源分类", async () => {
    seedPlaylist({ id: "pl-shape", name: "S", sourcePlatform: "go-music-dl", sourceUrl: "http://x", syncEnabled: 1, songCount: 7, duration: 120, isPublic: 1 });
    const b = await (await get("/v1/playlists?query=S&pageSize=500")).json() as Any;
    const it0 = b.items.find((i: Any) => i.id === "pl-shape");
    expect(it0.coverArt).toBe("pl-pl-shape");
    expect(it0.songCount).toBe(7);
    expect(it0.duration).toBe(120);
    expect(it0.public).toBe(true);
    expect(it0.sourcePlatform).toBe("go-music-dl");
    // 分类依据是「有没有导入插件认领这个 sourceUrl」。本用例没注册任何插件,
    // 所以这个 URL 无人认领 ⇒ 归为「插件同步歌单」而非「导入歌单」。
    expect(it0.isImported).toBe(false);
    expect(it0.pluginSynced).toBe(true);
    expect(it0.syncEnabled).toBe(true);
    expect(it0.favorite).toBe(false);
    expect(it0.owner).toBe(OWNER);
    expect(it0.isDaily).toBe(false);
  });

  it("响应项形状:无 sourceUrl 时既非导入也非插件同步", async () => {
    seedPlaylist({ id: "pl-plain", name: "PLAINONLY" });
    const b = await (await get("/v1/playlists?query=PLAINONLY&pageSize=500")).json() as Any;
    const it0 = b.items[0];
    expect(it0.isImported).toBe(false);
    expect(it0.pluginSynced).toBe(false);
    expect(it0.sourcePlatform).toBe("");
    expect(it0.syncEnabled).toBe(false);
  });

  it("total 反映过滤后的总数(不只当前页)", async () => {
    for (let i = 0; i < 5; i++) seedPlaylist({ name: `countme-${i}` });
    const b = await (await get("/v1/playlists?query=countme&page=1&pageSize=2")).json() as Any;
    expect(b.items).toHaveLength(2);
    expect(b.total).toBe(5);
  });
});

// ==================== Navidrome 兼容端点 ====================

describe("Navidrome 兼容端点", () => {
  it("GET /playlist:按可见性过滤,并按「每日推荐优先 + 变更时间倒序」排序", async () => {
    seedPlaylist({ id: "pl-n1", ownerId: OWNER, name: "X", createdAt: "2026-03-01T00:00:00.000Z", updatedAt: "2026-03-01T00:00:00.000Z" });
    seedPlaylist({ id: "pl-n2", ownerId: OWNER, name: "Y", createdAt: "2026-03-05T00:00:00.000Z", updatedAt: "2026-03-05T00:00:00.000Z" });
    seedPlaylist({ id: "pl-n3", ownerId: OTHER, name: "Z", isPublic: 1 });
    seedPlaylist({ id: "pl-n4", ownerId: OTHER, name: "HIDDEN", isPublic: 0, sourceUrl: null });
    const arr = await (await get("/playlist")).json() as Any[];
    const ids = arr.map((p: Any) => p.id);
    expect(ids).not.toContain("pl-n4");
    expect(ids).toContain("pl-n1");
    expect(ids).toContain("pl-n3");
    // 变更时间新的在前
    expect(ids.indexOf("pl-n2")).toBeLessThan(ids.indexOf("pl-n1"));
  });

  it("GET /playlist/:id/tracks:只回可播放且已匹配到歌曲的条目", async () => {
    const id = seedPlaylist();
    const sA = seedSong();
    const sB = seedSong();
    seedEntry({ playlistId: id, songId: sA, playable: 1 });
    seedEntry({ playlistId: id, songId: null, playable: 1 });
    seedEntry({ playlistId: id, songId: sB, playable: 0 });
    const arr = await (await get(`/playlist/${id}/tracks`)).json() as Any[];
    expect(arr).toHaveLength(1);
    expect(arr[0].songId).toBe(sA);
  });

  it("DELETE /playlist/:id:固定推荐歌单不可删(400)", async () => {
    const r = await del("/playlist/pl-daily-today");
    expect(r.status).toBe(400);
    expect((await r.json() as Any).code).toBe("INVALID_PARAM");
  });

  it("DELETE /playlist/:id:不存在 404 / 非属主 403 / 成功清条目并删歌单", async () => {
    expect((await del("/playlist/nope")).status).toBe(404);
    const foreign = seedPlaylist({ ownerId: OTHER });
    expect((await del(`/playlist/${foreign}`)).status).toBe(403);

    const id = seedPlaylist();
    seedEntry({ playlistId: id, songId: seedSong() });
    const r = await del(`/playlist/${id}`);
    expect(r.status).toBe(200);
    expect(rowOf(id)).toBeUndefined();
    expect(db.select().from(playlistSongs).where(eq(playlistSongs.playlistId, id)).all()).toHaveLength(0);
  });
});

// ==================== GET /v1/playlists/:id/tracks ====================

describe("GET /v1/playlists/:id/tracks", () => {
  it("歌单不存在 → 404", async () => {
    expect((await get("/v1/playlists/nope/tracks")).status).toBe(404);
  });

  it("匹配/未匹配混排:matched 计数只算可播放且 songId 非空,未匹配行带不可用原因", async () => {
    const id = seedPlaylist({ name: "混排" });
    const songId = seedSong({ title: "已匹配" });
    seedEntry({ playlistId: id, songId, playable: 1, position: 0 });
    seedEntry({ playlistId: id, songId: null, playable: 0, position: 1, externalSongId: "ext1", externalTitle: "漂着的", externalDuration: 65_000, unavailableReason: null });
    const b = await (await get(`/v1/playlists/${id}/tracks`)).json() as Any;
    expect(b.total).toBe(2);
    expect(b.matched).toBe(1);
    expect(b.items[0].playable).toBe(true);
    expect(b.items[0].isMatched).toBe(true);
    expect(b.items[1].playable).toBe(false);
    expect(b.items[1].isMatched).toBe(false);
    expect(b.items[1].id).toBe("ext1");
    expect(b.items[1].title).toBe("漂着的");
    expect(b.items[1].duration).toBe(65); // 毫秒 → 秒
    expect(b.items[1].unavailableReason).toBe("曲库中未找到"); // 空值回落
    expect(b.playlist.id).toBe(id);
    expect(b.playlist.coverArt).toBe(`pl-${id}`);
  });

  it("封面回退:自带有封面给 so-<songId>;否则回退专辑 al-<albumId>", async () => {
    const id = seedPlaylist();
    db.insert(albums).values({ id: "al-1", name: "专辑" }).run();
    const withCover = seedSong({ coverArt: "http://img", albumId: "al-1" });
    const noCover = seedSong({ coverArt: null, albumId: "al-1" });
    seedEntry({ playlistId: id, songId: withCover, playable: 1, position: 0 });
    seedEntry({ playlistId: id, songId: noCover, playable: 1, position: 1 });
    const b = await (await get(`/v1/playlists/${id}/tracks`)).json() as Any;
    expect(b.items[0].coverArt).toBe(`so-${withCover}`);
    expect(b.items[1].coverArt).toBe("al-al-1");
  });

  it("无封面且无专辑 → coverArt 为 undefined(留给前端占位)", async () => {
    const id = seedPlaylist();
    const s = seedSong({ coverArt: null, albumId: null });
    seedEntry({ playlistId: id, songId: s, playable: 1 });
    const b = await (await get(`/v1/playlists/${id}/tracks`)).json() as Any;
    expect(b.items[0].coverArt).toBeUndefined();
  });

  it("随机歌曲固定歌单 → 读取曲目时惰性刷新", async () => {
    const id = seedPlaylist({ id: "pl-random-songs", name: "随机歌曲" });
    await get(`/v1/playlists/${id}/tracks`);
    expect(fns.maybeRefreshRandomSongs).toHaveBeenCalledTimes(1);
  });

  it("普通歌单不触发随机歌曲刷新", async () => {
    const id = seedPlaylist();
    await get(`/v1/playlists/${id}/tracks`);
    expect(fns.maybeRefreshRandomSongs).not.toHaveBeenCalled();
  });

  it("页内有组内多源成员时附加 sources", async () => {
    const id = seedPlaylist();
    const s = seedSong({ groupId: "g-1" });
    seedEntry({ playlistId: id, songId: s, playable: 1 });
    await get(`/v1/playlists/${id}/tracks`);
    expect(fns.attachGroupSources).toHaveBeenCalledTimes(1);
    const [, memberRows] = fns.attachGroupSources.mock.calls[0] as Any[];
    expect(memberRows).toHaveLength(1);
  });

  it("组内多源查询/附加抛错被吞(曲目列表照常返回)", async () => {
    const id = seedPlaylist();
    const s = seedSong({ groupId: "g-2" });
    seedEntry({ playlistId: id, songId: s, playable: 1 });
    fns.attachGroupSources.mockImplementation(() => { throw new Error("组查询炸了"); });
    const r = await get(`/v1/playlists/${id}/tracks`);
    expect(r.status).toBe(200);
    expect((await r.json() as Any).items).toHaveLength(1);
  });

  it("分页:pageSize 上限 200,offset 生效", async () => {
    const id = seedPlaylist();
    for (let i = 0; i < 3; i++) seedEntry({ playlistId: id, songId: null, playable: 0, position: i });
    const b1 = await (await get(`/v1/playlists/${id}/tracks?page=1&pageSize=2`)).json() as Any;
    expect(b1.pageSize).toBe(2);
    expect(b1.items).toHaveLength(2);
    const b2 = await (await get(`/v1/playlists/${id}/tracks?page=2&pageSize=2`)).json() as Any;
    expect(b2.items).toHaveLength(1);
    const capped = await (await get(`/v1/playlists/${id}/tracks?pageSize=9999`)).json() as Any;
    expect(capped.pageSize).toBe(200);
  });

  it("非法/越界分页参数被钳制:page 下限 1、pageSize 夹在 [1,200]", async () => {
    const id = seedPlaylist();
    for (let i = 0; i < 3; i++) seedEntry({ playlistId: id, songId: null, playable: 0, position: i });

    // page:0 / page 非数字 / page 负数 → 一律回落到 1(而不是 offset 负数或 0)
    for (const q of ["page=0", "page=abc", "page=-5", "page="]) {
      const b = await (await get(`/v1/playlists/${id}/tracks?${q}&pageSize=200`)).json() as Any;
      expect(b.page).toBe(1);
      expect(b.items).toHaveLength(3);
    }
    // pageSize:0 / 非数字 → 走 `|| 50` 回落;负数是有数值的,被 Math.max(1,..) 夹到 1
    expect((await (await get(`/v1/playlists/${id}/tracks?pageSize=0`)).json() as Any).pageSize).toBe(50);
    expect((await (await get(`/v1/playlists/${id}/tracks?pageSize=oops`)).json() as Any).pageSize).toBe(50);
    expect((await (await get(`/v1/playlists/${id}/tracks?pageSize=-1`)).json() as Any).pageSize).toBe(1);
    expect((await (await get(`/v1/playlists/${id}/tracks?pageSize=99999`)).json() as Any).pageSize).toBe(200);
    // 顺带固化 parseInt 的既有语义(非缺陷:仍落回合法值):"1e9" 在 e 处截断成 1
    expect((await (await get(`/v1/playlists/${id}/tracks?pageSize=1e9`)).json() as Any).pageSize).toBe(1);
    // 空歌单:越界 page 也不报错,只返回空页
    const empty = seedPlaylist();
    const eb = await (await get(`/v1/playlists/${empty}/tracks?page=999&pageSize=50`)).json() as Any;
    expect(eb.total).toBe(0);
    expect(eb.matched).toBe(0);
    expect(eb.items).toEqual([]);
  });
});

// ==================== POST /v1/playlist/:id/auto-match ====================

describe("POST /v1/playlist/:id/auto-match", () => {
  it("不存在 404 / 非属主 403", async () => {
    expect((await post("/v1/playlist/nope/auto-match")).status).toBe(404);
    const foreign = seedPlaylist({ ownerId: OTHER });
    expect((await post(`/v1/playlist/${foreign}/auto-match`)).status).toBe(403);
  });

  it("fire-and-forget:立即返回 started,不等待匹配结果", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    fns.runPlaylistAutoMatch.mockImplementation(async () => {
      await gate;
      return { total: 2, matched: 2, appended: 1, skipped: 0, lockTimeout: true };
    });
    const id = seedPlaylist();
    const r = await post(`/v1/playlist/${id}/auto-match`);
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ success: true, started: true, playlistId: id });
    expect(fns.runPlaylistAutoMatch).toHaveBeenCalledWith(id);
    release();
    await new Promise((res) => setTimeout(res, 0));
  });

  it("管理员可对他人歌单触发", async () => {
    currentUser = { id: "u-admin", isAdmin: true };
    const foreign = seedPlaylist({ ownerId: OTHER });
    expect((await post(`/v1/playlist/${foreign}/auto-match`)).status).toBe(200);
  });
});
