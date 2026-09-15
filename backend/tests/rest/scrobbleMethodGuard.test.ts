// 播放记录上报(/rest/scrobble)的方法契约守卫。
//
// 锁定的契约:该端点必须**同时接受 GET 与 POST**。
//
// 背景(2026-09-15 实测):Subsonic / OpenSubsonic 规范的 `/rest/scrobble` 是 GET,
// 服务端原先也只注册了 GET;而 MusicFlow-client(≤v5.0.1)用的是 POST —— 于是
// 客户端每次上报都拿到 404,表现为「日志里 Failed to scrobble (404)、播放历史里
// 查不到任何记录」。服务端已改为双方法注册(兼容已安装的旧版客户端),
// 客户端 v5.0.2 起改用 GET。
//
// 任一侧单独回退都不会让对面立刻报错(HTTP 404 被 catch 吞掉),属静默失效,钉在这里。
import "../plugins/_env.js";
import { describe, it, expect, beforeAll } from "vitest";
import { Hono } from "hono";
import md5 from "md5";
import { db, initDatabase, encryptPassword } from "../../src/db/index.js";
import { users, artists, albums, songs } from "../../src/db/schema.js";
import { authMiddleware } from "../../src/middleware/auth.js";
import { restRoutes } from "../../src/routes/rest/index.js";

// 真实链路:authMiddleware(/rest/* 的 OpenSubsonic u/t/s 认证) + restRoutes。
const app = new Hono();
app.use("/rest/*", authMiddleware);
app.route("/rest", restRoutes);

const PLAIN = "hunter2";
const CLIENT_SALT = "clientsalt123";
const authQS = () => `u=scrobbler&t=${md5(PLAIN + CLIENT_SALT)}&s=${CLIENT_SALT}`;
const url = (path: string) => `${path}${path.includes("?") ? "&" : "?"}${authQS()}`;

beforeAll(() => {
  if (!process.env.APP_VERSION) process.env.APP_VERSION = "1.0.0";
  initDatabase();
  db.insert(users)
    .values({
      id: "u-scrobble",
      username: "scrobbler",
      password: "",
      salt: "salt",
      subsonicSalt: "subsalt",
      passEnc: encryptPassword(PLAIN),
      isAdmin: 1,
      isActive: 1,
      email: "scrobbler@b.c",
    })
    .run();
  db.insert(artists).values({ id: "ar-sc", name: "Scrobble Artist" }).run();
  db.insert(albums)
    .values({ id: "al-sc", name: "Scrobble Album", artistId: "ar-sc", artist: "Scrobble Artist" })
    .run();
  db.insert(songs)
    .values([
      { id: "sc1", title: "Scrobble One", artist: "Scrobble Artist", artistId: "ar-sc", album: "Scrobble Album", albumId: "al-sc", duration: 180, path: "l:src:/tmp/sc1.mp3", suffix: "mp3", type: "local" },
      { id: "sc2", title: "Scrobble Two", artist: "Scrobble Artist", artistId: "ar-sc", album: "Scrobble Album", albumId: "al-sc", duration: 200, path: "l:src:/tmp/sc2.mp3", suffix: "mp3", type: "local" },
    ])
    .run();
});

describe("/rest/scrobble 方法契约", () => {
  it("GET(Subsonic / OpenSubsonic 规范)必须可用", async () => {
    const res = await app.request(url("/rest/scrobble?id=sc1"));
    expect(res.status).toBe(200);
  });

  it("POST 也必须可用(客户端 ≤v5.0.1 用 POST;回退成只听 GET 会静默丢播放记录)", async () => {
    const res = await app.request(url("/rest/scrobble?id=sc2"), { method: "POST" });
    expect(res.status).not.toBe(404);
    expect(res.status).toBe(200);
  });
});
