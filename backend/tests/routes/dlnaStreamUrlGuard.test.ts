// 播放链路守卫（用户拍板 2026-09-09）: /v1/dlna/stream-url 投前预检 ——
//   签发无鉴权 token 前必须确认该歌当前真的有可用音源（全类型覆盖）:
//     - local 行: 磁盘存在性检查(毫秒级) —— 文件缺失 → 409
//     - local 行缺文件但组内有 web 备选 → 放行(流播时 resolvePreferredSong 自动切换)
//     - web 行: 无 pluginEntry 时按 url 判定; pluginEntry 行走 ensurePlayableStream
//   客户端收到 409 即跳下一首,设备不再吃死链干等。防回归:删掉预检/改判定都会挂。
import "../plugins/_env.js";
import { describe, it, expect, beforeAll } from "vitest";
import { Hono } from "hono";
import { v4 as uuidv4 } from "uuid";
import fs from "fs";
import os from "os";
import path from "path";
import { db, initDatabase } from "../../src/db/index.js";
import { users, songs } from "../../src/db/schema.js";
import { authMiddleware } from "../../src/middleware/auth.js";
import { apiRoutes } from "../../src/routes/api/index.js";
import { generateToken } from "../../src/utils/auth.js";

const app = new Hono();
app.use("/rest/api/*", authMiddleware);
app.route("/rest/api", apiRoutes);

let headers: Record<string, string>;

beforeAll(async () => {
  if (!process.env.APP_VERSION) process.env.APP_VERSION = "1.0.0";
  initDatabase();
  const uid = uuidv4();
  db.insert(users)
    .values({
      id: uid,
      username: `guard-${Date.now()}`,
      password: "",
      salt: "salt",
      subsonicSalt: "subsalt",
      passEnc: "x",
      isAdmin: 1,
      isActive: 1,
      email: "",
    })
    .run();
  const token = generateToken(uid, "guard", true);
  headers = { Authorization: `Bearer ${token}`, "content-type": "application/json" };
});

function seedSong(over: Record<string, unknown>) {
  const id = uuidv4();
  db.insert(songs)
    .values({
      id,
      title: `guard-${id.slice(0, 6)}`,
      path: "l:t:/nonexistent/x.mp3",
      type: "local",
      suffix: "mp3",
      ...over,
    })
    .run();
  return id;
}

async function postStreamUrl(songId: string) {
  const res = await app.request("/rest/api/v1/dlna/stream-url", {
    method: "POST",
    headers,
    body: JSON.stringify({ songId }),
  });
  return res;
}

describe("/v1/dlna/stream-url 投前预检（播放链路守卫）", () => {
  it("local 文件存在 → 200 并签发 token 流地址", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mf-guard-"));
    const file = path.join(dir, "ok.mp3");
    fs.writeFileSync(file, "x");
    const songId = seedSong({ path: `l:t:${file}` });
    const res = await postStreamUrl(songId);
    expect(res.status).toBe(200);
    const body: any = await res.json();
    expect(body.streamUrl).toContain("/rest/dlna/stream/");
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("local 文件缺失、无组内备选 → 409 无可用音源", async () => {
    const songId = seedSong({ path: `l:t:/nonexistent/${uuidv4()}.mp3` });
    const res = await postStreamUrl(songId);
    expect(res.status).toBe(409);
  });

  it("local 文件缺失但组内有 web 备选 → 放行(流播时自动切换)", async () => {
    const groupId = uuidv4();
    const localId = seedSong({
      groupId,
      groupKey: `k-${groupId}`,
      path: `l:t:/nonexistent/${uuidv4()}.mp3`,
    });
    seedSong({
      groupId,
      groupKey: `k-${groupId}`,
      type: "web",
      url: "http://upstream/ok.mp3",
    });
    const res = await postStreamUrl(localId);
    expect(res.status).toBe(200);
  });

  it("web 行无 pluginEntry 且 url 为空 → 409", async () => {
    const songId = seedSong({ type: "web", url: null });
    const res = await postStreamUrl(songId);
    expect(res.status).toBe(409);
  });

  it("web 行有 url(无 pluginEntry) → 200", async () => {
    const songId = seedSong({ type: "web", url: "http://upstream/ok.mp3" });
    const res = await postStreamUrl(songId);
    expect(res.status).toBe(200);
  });
});
