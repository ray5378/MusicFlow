// MUST be the first import: redirects DATA_DIR to an isolated temp dir before
// the backend opens its SQLite DB at module-load time.
import "../plugins/_env.js";

import { describe, it, expect, beforeAll } from "vitest";
import { Hono } from "hono";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { db, initDatabase, encryptPassword } from "../../src/db/index.js";
import { users, artists, albums, songs, mediaSources, plugins } from "../../src/db/schema.js";
import { eq } from "drizzle-orm";
import { registerBuiltinPlugins } from "../../src/plugins/builtins.js";
import { restRoutes } from "../../src/routes/rest/index.js";
import { createCastSession } from "../../src/services/dlna/control.js";
import { resolveFfmpeg } from "../../src/services/transcode.js";

// DLNA 拉流优选契约:cast token 绑定用户点的 web 行,但 /rest/dlna/stream/:token
// 实际出流应切组内 local/webdav 无损源(与 /rest/stream 一致);插件关闭后恢复
// 按原源。覆盖 HA 卡片投屏(链路 A)与安卓/Win 客户端直投(链路 B,同样换
// /rest/dlna/stream/:token)两条链路。
const app = new Hono();
app.route("/rest", restRoutes);

const fixtureDir = path.join(os.tmpdir(), `mf-dlna-prefer-${process.pid}`);
const wavPath = path.join(fixtureDir, "local.wav");
let wavSize = 0;

beforeAll(() => {
  if (!process.env.APP_VERSION) process.env.APP_VERSION = "1.0.0";

  // 真实 WAV 作为组内 local 源(优选成功时应直出该文件字节)。
  fs.mkdirSync(fixtureDir, { recursive: true });
  const r = spawnSync(resolveFfmpeg(), [
    "-hide_banner", "-loglevel", "error", "-y",
    "-f", "lavfi", "-i", "sine=frequency=440:duration=4:sample_rate=44100",
    "-ac", "2", "-c:a", "pcm_s16le", wavPath,
  ], { encoding: "utf8" });
  if (r.status !== 0) {
    throw new Error(`ffmpeg fixture 生成失败: ${r.stderr?.slice(0, 500)}`);
  }
  wavSize = fs.statSync(wavPath).size;

  initDatabase();
  registerBuiltinPlugins(); // 播种 core 插件(core-play-preference enabled=1)
  db.insert(users).values({ id: "u1", username: "alice", password: "", salt: "salt", subsonicSalt: "subsalt", passEnc: encryptPassword("hunter2"), isAdmin: 1, isActive: 1, email: "a@b.c" }).run();
  db.insert(artists).values({ id: "ar1", name: "Test Artist" }).run();
  db.insert(albums).values({ id: "al1", name: "Test Album", artistId: "ar1", artist: "Test Artist", year: 2020, genre: "Test" }).run();
  db.insert(mediaSources).values({ id: "src", name: "Local", type: "local", enabled: 1, config: "{}" }).run();
  db.insert(songs).values([
    // web 行(用户点的行):无 url → serveWebSongStream 会失败,绝不可能是它直出。
    { id: "sw", title: "Web", artist: "Test Artist", artistId: "ar1", album: "Test Album", albumId: "al1", duration: 4, path: "web:go-music-dl:qq", suffix: "mp3", bitRate: 320, genre: "Test", type: "web", groupId: "g1", groupKey: "k1" },
    // 同组 local 行(真实 WAV,优选成功应直出)。
    { id: "sl", title: "Local", artist: "Test Artist", artistId: "ar1", album: "Test Album", albumId: "al1", duration: 4, path: `l:src:${wavPath}`, suffix: "wav", bitRate: 1411, genre: "Test", type: "local", groupId: "g1", groupKey: "k1" },
  ]).run();
});

describe("/rest/dlna/stream/:token 播放优选", () => {
  it("web 行拉流自动切换到组内 local 源(直出 WAV 字节)", async () => {
    const { token } = createCastSession("sw", "dev1", "http://localhost:1");
    const res = await app.request(`/rest/dlna/stream/${token}`);
    expect(res.status).toBe(200);
    expect(Number(res.headers.get("content-length"))).toBe(wavSize);
    const buf = await res.arrayBuffer();
    // WAV 文件头 "RIFF"
    expect(new TextDecoder().decode(new Uint8Array(buf.slice(0, 4)))).toBe("RIFF");
  });

  it("关闭播放优选插件后按原 web 源拉流(不直出 local 文件)", async () => {
    db.update(plugins).set({ enabled: 0 }).where(eq(plugins.id, "core-play-preference")).run();
    try {
      const { token } = createCastSession("sw", "dev1", "http://localhost:1");
      const res = await app.request(`/rest/dlna/stream/${token}`);
      // web 行无 url → serveWebSongStream 返回 JSON 错误(200),绝非 WAV 字节。
      const buf = await res.arrayBuffer();
      const head = new TextDecoder().decode(new Uint8Array(buf.slice(0, 4)));
      expect(head).not.toBe("RIFF");
    } finally {
      db.update(plugins).set({ enabled: 1 }).where(eq(plugins.id, "core-play-preference")).run();
    }
  });
});
