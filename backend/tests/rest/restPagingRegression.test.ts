// MUST be the first import: redirects DATA_DIR to an isolated temp dir before
// the backend opens its SQLite DB at module-load time.
import "../plugins/_env.js";

import { describe, it, expect, beforeAll } from "vitest";
import { Hono } from "hono";
import md5 from "md5";
import { db, initDatabase, encryptPassword } from "../../src/db/index.js";
import { users, albums, playlists, userFavoriteAlbums } from "../../src/db/schema.js";
import { eq } from "drizzle-orm";
import { authMiddleware } from "../../src/middleware/auth.js";
import { restRoutes } from "../../src/routes/rest/index.js";

// 回归:getAlbumList2 SQL 下推后的排序/过滤/分页语义,与 getPlaylists 的
// size/offset/recency 排序分页契约。
const app = new Hono();
app.use("/rest/*", authMiddleware);
app.route("/rest", restRoutes);

const PLAIN = "hunter2";
const CLIENT_SALT = "clientsalt123";
const authQS = () => `u=alice&t=${md5(PLAIN + CLIENT_SALT)}&s=${CLIENT_SALT}`;
const url = (p: string) => `${p}${p.includes("?") ? "&" : "?"}${authQS()}`;

async function getJson(path: string) {
  const res = await app.request(url(path));
  expect(res.status).toBe(200);
  return await res.json();
}
const albumList = (j: any) => j?.["subsonic-response"]?.albumList2?.album ?? [];
const playlistPage = (j: any) => j?.["subsonic-response"]?.playlists ?? null;

beforeAll(() => {
  if (!process.env.APP_VERSION) process.env.APP_VERSION = "1.0.0";
  initDatabase();
  if (!db.select().from(users).where(eq(users.username, "alice")).get()) {
    db.insert(users).values({ id: "u1", username: "alice", password: "", salt: "salt", subsonicSalt: "subsalt", passEnc: encryptPassword(PLAIN), isAdmin: 1, isActive: 1, email: "a@b.c" }).run();
  }
  // 40 张专辑:created_at 递减、year 递增、play_count 递增、genre 两类交替。
  db.delete(albums).run();
  const rows = Array.from({ length: 40 }, (_, i) => ({
    id: `al-r${String(i).padStart(2, "0")}`,
    name: `回归专辑 ${i}`,
    artist: "回归艺人",
    year: 1990 + i,
    genre: i % 2 === 0 ? "Rock" : "Pop",
    songCount: 2,
    duration: 200,
    playCount: i * 10,
    createdAt: new Date(Date.UTC(2025, 0, 1 + i)).toISOString(),
    updatedAt: new Date(Date.UTC(2025, 0, 1 + i)).toISOString(),
  }));
  db.insert(albums).values(rows).run();
  // 两张收藏专辑,供 type=starred 断言。
  db.delete(userFavoriteAlbums).where(eq(userFavoriteAlbums.userId, "u1")).run();
  db.insert(userFavoriteAlbums).values([
    { userId: "u1", albumId: "al-r03" },
    { userId: "u1", albumId: "al-r07" },
  ]).run();

  // 12 张歌单:updated_at 递减;第一张带每日推荐标签(应置顶)。
  db.delete(playlists).where(eq(playlists.ownerId, "u1")).run();
  const plRows = Array.from({ length: 12 }, (_, i) => ({
    id: `pl-r${String(i).padStart(2, "0")}`,
    name: i === 0 ? "今日推荐" : `回归歌单 ${i}`,
    ownerId: "u1",
    isPublic: 1,
    comment: i === 0 ? "每日推荐" : "",
    songCount: i,
    duration: i * 60,
    createdAt: new Date(Date.UTC(2024, 0, 1 + i)).toISOString(),
    updatedAt: new Date(Date.UTC(2025, 5, 1 + (11 - i))).toISOString(), // pl-r00 最新 → pl-r11 最旧
  }));
  db.insert(playlists).values(plRows).run();
});

describe("getAlbumList2 SQL 下推回归", () => {
  it("newest 按 created_at 倒序 + offset/size 分页", async () => {
    const page1 = albumList(await getJson("/rest/getAlbumList2?type=newest&size=10&offset=0"));
    expect(page1).toHaveLength(10);
    expect(page1[0].id).toBe("al-r39"); // created_at 最新
    const page2 = albumList(await getJson("/rest/getAlbumList2?type=newest&size=10&offset=10"));
    expect(page2[0].id).toBe("al-r29");
    const all = [...page1, ...page2].map((a: any) => a.created);
    expect(all).toEqual([...all].sort().reverse()); // 全程倒序
  });

  it("byYear / byGenre 过滤语义不变", async () => {
    const y = albumList(await getJson("/rest/getAlbumList2?type=byYear&fromYear=1995&toYear=2000&size=500"));
    expect(y).toHaveLength(6);
    expect(y.every((a: any) => a.year >= 1995 && a.year <= 2000)).toBe(true);
    const g = albumList(await getJson("/rest/getAlbumList2?type=byGenre&genre=Rock&size=500"));
    expect(g).toHaveLength(20);
    expect(g.every((a: any) => a.genre === "Rock")).toBe(true);
  });

  it("frequent 按 play_count 倒序;starred 只含收藏", async () => {
    const f = albumList(await getJson("/rest/getAlbumList2?type=frequent&size=10"));
    expect(f[0].id).toBe("al-r39");
    const s = albumList(await getJson("/rest/getAlbumList2?type=starred&size=500"));
    expect(s.map((a: any) => a.id).sort()).toEqual(["al-r03", "al-r07"]);
  });

  it("random 返回条数正确且无重复", async () => {
    const r = albumList(await getJson("/rest/getAlbumList2?type=random&size=15"));
    expect(r).toHaveLength(15);
    expect(new Set(r.map((a: any) => a.id)).size).toBe(15);
  });
});

describe("getPlaylists size/offset/排序回归", () => {
  it("每日推荐置顶,其余按 updated_at 倒序;全量返回带 total", async () => {
    const j = playlistPage(await getJson("/rest/getPlaylists"));
    expect(j.total).toBe(12);
    expect(j.playlist).toHaveLength(12);
    expect(j.playlist[0].id).toBe("pl-r00"); // 今日推荐置顶
    const rest = j.playlist.slice(1);
    const changed = rest.map((p: any) => p.changed);
    expect(changed).toEqual([...changed].sort().reverse()); // recency 倒序
  });

  it("size/offset 分页不重不漏", async () => {
    const p1 = playlistPage(await getJson("/rest/getPlaylists?size=5&offset=0"));
    expect(p1.total).toBe(12);
    expect(p1.playlist).toHaveLength(5);
    expect(p1.playlist[0].id).toBe("pl-r00");
    const p2 = playlistPage(await getJson("/rest/getPlaylists?size=5&offset=5"));
    const p3 = playlistPage(await getJson("/rest/getPlaylists?size=5&offset=10"));
    expect(p3.playlist).toHaveLength(2);
    const ids = [...p1.playlist, ...p2.playlist, ...p3.playlist].map((p: any) => p.id);
    expect(new Set(ids).size).toBe(12); // 不重
    // 分页顺序与全量顺序一致
    const full = playlistPage(await getJson("/rest/getPlaylists"));
    expect(ids).toEqual(full.playlist.map((p: any) => p.id));
  });
});
