// 收藏 id 轻量接口(GET /rest/api/v1/favorites/ids)的契约测试(2026-11-09)。
//
// 背景:首页与歌曲行的收藏状态只需要「哪些 id 已收藏」。标准 getStarred2 会返回完整
// 歌曲/专辑/艺人对象(生产 800+ 收藏实测 ~187KB、~280ms),前端 favorites store 改为
// 走本接口;标准 getStarred2 保持不变(第三方 Subsonic 客户端与收藏页仍走原接口)。
//
// 契约:
//   1) 需要登录(未认证 401),权限与收藏接口一致(FAVORITES_MANAGE);
//   2) 只返回三类 id 数组,不夹带完整对象(响应体保持轻量);
//   3) 无进程内缓存:收藏/取消后重新请求立即看到最新 id。
import "../plugins/_env.js";

import { describe, it, expect, beforeAll } from "vitest";
import { Hono } from "hono";
import md5 from "md5";
import { db, initDatabase, encryptPassword } from "../../src/db/index.js";
import { users, songs } from "../../src/db/schema.js";
import { authMiddleware } from "../../src/middleware/auth.js";
import { restRoutes } from "../../src/routes/rest/index.js";

// 真实链路:authMiddleware(/rest/* 的 u/t/s 认证) + restRoutes(不拉起整台服务器)。
const app = new Hono();
app.use("/rest/*", authMiddleware);
app.route("/rest", restRoutes);

const PLAIN = "hunter2";
const CLIENT_SALT = "clientsalt123";
const authQS = () => `u=alice&t=${md5(PLAIN + CLIENT_SALT)}&s=${CLIENT_SALT}`;
async function get(path: string) {
  const res = await app.request(`${path}${path.includes("?") ? "&" : "?"}${authQS()}`);
  return { res, body: await res.json().catch(() => null) };
}
const sr = (r: any) => r?.body?.["subsonic-response"] ?? null;

beforeAll(() => {
  if (!process.env.APP_VERSION) process.env.APP_VERSION = "1.0.0";
  initDatabase();
  db.insert(users).values({
    id: "u1", username: "alice", password: "", salt: "salt", subsonicSalt: "subsalt",
    passEnc: encryptPassword(PLAIN), isAdmin: 1, isActive: 1, email: "a@b.c",
  }).run();
  db.insert(songs).values({
    id: "s1", title: "Song One", artist: "Test Artist", album: "Test Album",
    duration: 180, path: "l:src:/tmp/one.mp3", suffix: "mp3", type: "local",
  }).run();
});

describe("GET /rest/api/v1/favorites/ids 收藏 id 轻量接口", () => {
  it("未认证返回 401", async () => {
    const res = await app.request("/rest/api/v1/favorites/ids");
    expect(res.status).toBe(401);
  });

  it("只返回三类 id 数组,不夹带完整歌曲对象", async () => {
    await get("/rest/star?id=s1");
    const r = await get("/rest/api/v1/favorites/ids");
    expect(r.res.status).toBe(200);
    expect(sr(r)?.status).toBe("ok");
    expect(sr(r)?.favoriteIds.song).toContain("s1");
    // 键集合固定为 song/album/artist,不额外夹带完整对象字段。
    expect(Object.keys(sr(r)?.favoriteIds ?? {}).sort()).toEqual(["album", "artist", "song"]);
  });

  it("取消收藏后重新请求不再返回该 id(无进程内缓存)", async () => {
    await get("/rest/unstar?id=s1");
    const r = await get("/rest/api/v1/favorites/ids");
    expect(sr(r)?.favoriteIds.song).not.toContain("s1");
  });
});
