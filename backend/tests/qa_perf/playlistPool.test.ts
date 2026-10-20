// 首页全量歌单池索引(2026-10-20)的契约测试。
//
// 背景:首页「并排随机」此前调 /v1/playlists?pageSize=200 拉「全量」,而生产库有 873 个
// 歌单、服务端单页上限 500 —— 随机池实际只覆盖最新约 200 个,其余永不出现。现改为服务端
// 常驻一份最瘦索引(id+name+songCount)并一次返回全量池。
//
// 契约:
//   1) 响应项**只有** {id,name,songCount} 三个字段(owner/pub 是内部可见性判定列,绝不外泄);
//   2) 可见性口径与 /v1/playlists 一致:管理员全见;普通用户仅见「自己 + 公开 + 导入」;
//   3) TTL 内复用缓存、超过 TTL 重建(新插入的歌单最迟 TTL 内出现在池里);
//   4) 索引为空/无歌单时安全返回空池(不得抛错)。
import { beforeEach, describe, expect, it, vi } from "vitest";
import { db, playlists, sqlite } from "../../src/routes/api/shared.js";
import {
  PLAYLIST_POOL_TTL_MS,
  buildPlaylistsPage,
  buildPlaylistPool,
  warmPlaylistPoolOnce,
  __resetPlaylistPoolForTest,
} from "../../src/routes/api/playlists.js";

type Any = any;

/** 建一个用户行:playlists.owner_id 有外键指向 users.id,不先建用户插入歌单会被 FK 拒。 */
function makeUser(id: string) {
  sqlite
    .prepare(
      "INSERT OR IGNORE INTO users(id, username, password, salt, subsonic_salt) VALUES(?,?,?,?,?)",
    )
    .run(id, `user-${id}`, "x", "x", "x");
}

/** 建一个歌单行(只填建表必需的 owner_id + 可选字段)。 */
function makePlaylist(
  id: string,
  owner: string,
  opts: { isPublic?: number; sourceUrl?: string | null; songCount?: number } = {},
) {
  db.insert(playlists)
    .values({
      id,
      name: `歌单 ${id}`,
      ownerId: owner,
      isPublic: opts.isPublic ?? 0,
      sourceUrl: opts.sourceUrl ?? null,
      songCount: opts.songCount ?? 0,
    } as Any)
    .run();
}

const ids = (r: { items: Any[] }) => r.items.map((i) => i.id).sort();

beforeEach(() => {
  // 清空索引缓存与定时器,避免用例间残留(模块加载期已起过一个预热定时器)。
  __resetPlaylistPoolForTest();
  // 清掉本文件库里的歌单行,保证用例互不影响(独立 DATA_DIR,但仍需同文件内隔离)。
  db.delete(playlists).run();
  for (const u of ["u1", "u2", "u3"]) makeUser(u);
});

describe("首页全量歌单池索引", () => {
  it("只返回 {id,name,songCount} 三个字段,绝不外泄 owner/pub", () => {
    makePlaylist("p1", "u1", { isPublic: 1, songCount: 40 });
    const r = buildPlaylistPool({ id: "u1", isAdmin: true });
    expect(r.total).toBe(1);
    expect(Object.keys(r.items[0]).sort()).toEqual(["id", "name", "songCount"]);
    expect(r.items[0].songCount).toBe(40);
  });

  it("管理员全见", () => {
    makePlaylist("p1", "u1");
    makePlaylist("p2", "u2");
    makePlaylist("p3", "u3", { isPublic: 1 });
    expect(ids(buildPlaylistPool({ id: "u1", isAdmin: true }))).toEqual(["p1", "p2", "p3"]);
  });

  it("普通用户仅见「自己 + 公开 + 导入」,他人私密歌单不可见", () => {
    makePlaylist("mine", "u1");
    makePlaylist("public", "u2", { isPublic: 1 });
    makePlaylist("imported", "u2", { sourceUrl: "qq://x" });
    makePlaylist("private-of-other", "u2");
    expect(ids(buildPlaylistPool({ id: "u1", isAdmin: false }))).toEqual([
      "imported",
      "mine",
      "public",
    ]);
  });

  it("TTL 内复用缓存:新插入的歌单不会立刻出现", () => {
    makePlaylist("p1", "u1", { isPublic: 1 });
    expect(ids(buildPlaylistPool({ id: "u1", isAdmin: true }))).toEqual(["p1"]); // 触发首次重建

    makePlaylist("p2", "u1", { isPublic: 1 });
    // 仍在 TTL 内 → 命中旧缓存,看不到 p2。
    expect(ids(buildPlaylistPool({ id: "u1", isAdmin: true }))).toEqual(["p1"]);
  });

  it("超过 TTL 会重建:新歌单最迟 TTL 内出现在池里", () => {
    makePlaylist("p1", "u1", { isPublic: 1 });
    buildPlaylistPool({ id: "u1", isAdmin: true });
    makePlaylist("p2", "u1", { isPublic: 1 });

    let fake = Date.now() + PLAYLIST_POOL_TTL_MS + 1;
    const spy = vi.spyOn(Date, "now").mockImplementation(() => fake);
    try {
      expect(ids(buildPlaylistPool({ id: "u1", isAdmin: true }))).toEqual(["p1", "p2"]);
    } finally {
      spy.mockRestore();
      // 让后续用例从真实时刻重新开始。
      __resetPlaylistPoolForTest();
    }
  });

  it("空库安全返回空池", () => {
    expect(buildPlaylistPool({ id: "u1", isAdmin: true })).toEqual({ total: 0, items: [] });
  });

  it("可见性口径与 /v1/playlists(buildPlaylistsPage) 逐用户对拍,防两套口径漂移", () => {
    makePlaylist("mine", "u1");
    makePlaylist("public", "u2", { isPublic: 1 });
    makePlaylist("imported", "u2", { sourceUrl: "qq://x" });
    makePlaylist("private-of-other", "u2");
    // isPublic 出现非 0/1 脏值时,两套口径都必须把它当「不公开」(pool 用 ===1, SQL 用 eq(...,1))。
    makePlaylist("dirty-public", "u2", { isPublic: 2 });
    const users: Any[] = [
      { id: "u1", isAdmin: false },
      { id: "u2", isAdmin: false },
      { id: "u1", isAdmin: true },
      undefined, // 未登录/无用户上下文
    ];
    for (const u of users) {
      const pool = ids(buildPlaylistPool(u));
      const page = ids(buildPlaylistsPage({ pageSize: "500" }, u));
      expect(pool, `用户 ${JSON.stringify(u)} 的两套可见性口径必须一致`).toEqual(page);
    }
  });

  it("force=true 跳过 TTL 缓存:显式刷新时新歌单立刻进池(供「重新生成漫游」)", () => {
    makePlaylist("p1", "u1", { isPublic: 1 });
    expect(ids(buildPlaylistPool({ id: "u1", isAdmin: true }))).toEqual(["p1"]); // 首次重建
    makePlaylist("p2", "u1", { isPublic: 1 });
    // 不 force:仍在 TTL 内 → 命中旧缓存,看不到 p2(这正是「重新生成漫游」会踩到的陈旧)。
    expect(ids(buildPlaylistPool({ id: "u1", isAdmin: true }))).toEqual(["p1"]);
    // force:强制重建 → 立刻可见。
    expect(ids(buildPlaylistPool({ id: "u1", isAdmin: true }, { force: true }))).toEqual([
      "p1",
      "p2",
    ]);
  });

  it("warmPlaylistPoolOnce 会把索引预热好(预热后首个请求直接命中)", () => {
    makePlaylist("p1", "u1", { isPublic: 1 });
    warmPlaylistPoolOnce();
    expect(ids(buildPlaylistPool({ id: "u1", isAdmin: true }))).toEqual(["p1"]);
  });
});
