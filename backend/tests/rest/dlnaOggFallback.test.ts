// MUST be the first import: redirects DATA_DIR to an isolated temp dir before
// the backend opens its SQLite DB at module-load time.
import "../plugins/_env.js";

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Hono } from "hono";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { spawnSync } from "node:child_process";
import { db, initDatabase, encryptPassword } from "../../src/db/index.js";
import { users, artists, albums, songs } from "../../src/db/schema.js";
import { registerBuiltinPlugins } from "../../src/plugins/builtins.js";
import { restRoutes } from "../../src/routes/rest/index.js";
import { createCastSession } from "../../src/services/dlna/control.js";
import { resolveFfmpeg } from "../../src/services/transcode.js";

// DLNA 音箱格式兜底契约:web 源(在线插件)上游实际返回 Ogg/Opus/WebM 等音箱
// 不支持的格式时(DB suffix 可能记错,如 go-music-dl 固定 ogg 但入库记 mp3),
// /rest/dlna/stream/:token 应服务端实时转 192kbps mp3 再出流;格式正常则原样
// 透传;探测结果缓存 5 分钟避免每次拉流重复探测。/rest/stream 不受影响。
const app = new Hono();
app.route("/rest", restRoutes);

const fixtureDir = path.join(os.tmpdir(), `mf-dlna-ogg-${process.pid}`);
let oggBytes: Buffer;
let mpegBytes: Buffer;
let m4aBytes: Buffer;
let mp3Bytes: Buffer;

// 真实 HTTP 上游:按 path 返回不同格式,统计 Range 探测请求次数。
let probeCount = 0;
let server: http.Server;
let baseUrl = "";

beforeAll(async () => {
  if (!process.env.APP_VERSION) process.env.APP_VERSION = "1.0.0";
  fs.mkdirSync(fixtureDir, { recursive: true });

  // 真实 Ogg Vorbis(2s sine)——模拟 go-music-dl 上游固定返回的格式。
  const oggPath = path.join(fixtureDir, "fixture.ogg");
  const r = spawnSync(resolveFfmpeg(), [
    "-hide_banner", "-loglevel", "error", "-y",
    "-f", "lavfi", "-i", "sine=frequency=440:duration=2:sample_rate=44100",
    "-ac", "2", "-c:a", "libvorbis", "-f", "ogg", oggPath,
  ], { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`ogg fixture 生成失败: ${r.stderr?.slice(0, 500)}`);
  oggBytes = fs.readFileSync(oggPath);

  // 假 mp3(任意字节,仅验证透传不转码)。
  mpegBytes = Buffer.alloc(1000, 0x5a);

  // 真实 M4A(AAC mp4 容器)——模拟 go-music-dl soda 源返回的格式。
  const m4aPath = path.join(fixtureDir, "fixture.m4a");
  const r2 = spawnSync(resolveFfmpeg(), [
    "-hide_banner", "-loglevel", "error", "-y",
    "-f", "lavfi", "-i", "sine=frequency=440:duration=2:sample_rate=44100",
    "-ac", "2", "-c:a", "aac", "-f", "mp4", m4aPath,
  ], { encoding: "utf8" });
  if (r2.status !== 0) throw new Error(`m4a fixture 生成失败: ${r2.stderr?.slice(0, 500)}`);
  m4aBytes = fs.readFileSync(m4aPath);

  // 真实 mp3——验证 octet-stream + mp3 magic 应透传(仅修正 MIME)。
  const mp3Path = path.join(fixtureDir, "fixture.mp3");
  const r3 = spawnSync(resolveFfmpeg(), [
    "-hide_banner", "-loglevel", "error", "-y",
    "-f", "lavfi", "-i", "sine=frequency=440:duration=2:sample_rate=44100",
    "-c:a", "libmp3lame", "-f", "mp3", mp3Path,
  ], { encoding: "utf8" });
  if (r3.status !== 0) throw new Error(`mp3 fixture 生成失败: ${r3.stderr?.slice(0, 500)}`);
  mp3Bytes = fs.readFileSync(mp3Path);

  server = http.createServer((req, res) => {
    const u = new URL(req.url || "/", baseUrl || "http://x");
    const range = req.headers.range;
    // 正确的 Range 服务:ffmpeg 转码 ogg 会 seek 重连,必须返回从 start 起的块。
    const serve = (ct: string, body: Buffer) => {
      probeCount += range ? 1 : 0;
      if (range) {
        const m = /bytes=(\d+)-(\d*)/.exec(range);
        const start = m ? parseInt(m[1]) : 0;
        if (start >= body.length) {
          res.writeHead(416, { "content-type": ct });
          res.end();
          return;
        }
        const end = m && m[2] ? Math.min(parseInt(m[2]), body.length - 1) : Math.min(start + 64 * 1024 - 1, body.length - 1);
        res.writeHead(206, { "content-type": ct, "content-length": String(end - start + 1), "content-range": `bytes ${start}-${end}/${body.length}`, "accept-ranges": "bytes" });
        res.end(body.subarray(start, end + 1));
        return;
      }
      res.writeHead(200, { "content-type": ct, "content-length": String(body.length), "accept-ranges": "bytes" });
      res.end(body);
    };
    if (u.pathname === "/ogg.ogg") { serve("audio/ogg", oggBytes); return; }
    if (u.pathname === "/mpeg.mp3") { serve("audio/mpeg", mpegBytes); return; }
    // 模拟 go-music-dl soda 源:Content-Type 标错为 octet-stream,body 是真实 M4A。
    if (u.pathname === "/soda.m4a") { serve("application/octet-stream", m4aBytes); return; }
    // 模拟 octet-stream + 真实 mp3:应透传且修正 MIME。
    if (u.pathname === "/soda_mp3.bin") { serve("application/octet-stream", mp3Bytes); return; }
    res.writeHead(404, { "content-type": "text/plain" });
    res.end("not found");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  initDatabase();
  registerBuiltinPlugins();
  db.insert(users).values({ id: "u1", username: "alice", password: "", salt: "salt", subsonicSalt: "subsalt", passEnc: encryptPassword("hunter2"), isAdmin: 1, isActive: 1, email: "a@b.c" }).run();
  db.insert(artists).values({ id: "ar1", name: "Test Artist" }).run();
  db.insert(albums).values({ id: "al1", name: "Test Album", artistId: "ar1", artist: "Test Artist", year: 2020, genre: "Test" }).run();
  // 三条 web 行,组内均无 local 候选 → 优选不介入,直接考验兜底逻辑。
  db.insert(songs).values([
    // 模拟泪海场景:DB suffix 记 mp3,上游实际 Ogg。
    { id: "wo", title: "Ogg", artist: "Test Artist", artistId: "ar1", album: "Test Album", albumId: "al1", duration: 2, path: "web:go-music-dl:qq", suffix: "mp3", bitRate: 320, genre: "Test", type: "web", groupId: "g-ogg", groupKey: "k-ogg", url: `${baseUrl}/ogg.ogg` },
    // 上游实际 mpeg,应原样透传。
    { id: "wm", title: "Mpeg", artist: "Test Artist", artistId: "ar1", album: "Test Album", albumId: "al1", duration: 2, path: "web:go-music-dl:qq", suffix: "mp3", bitRate: 320, genre: "Test", type: "web", groupId: "g-mpeg", groupKey: "k-mpeg", url: `${baseUrl}/mpeg.mp3` },
    // 缓存用例专用行(探测只应发生一次)。
    { id: "wc", title: "Cached", artist: "Test Artist", artistId: "ar1", album: "Test Album", albumId: "al1", duration: 2, path: "web:go-music-dl:qq", suffix: "mp3", bitRate: 320, genre: "Test", type: "web", groupId: "g-cache", groupKey: "k-cache", url: `${baseUrl}/ogg.ogg` },
    // 模拟 soda 源:Content-Type octet-stream + M4A body → 应兜底转码。
    { id: "so", title: "SodaM4a", artist: "Test Artist", artistId: "ar1", album: "Test Album", albumId: "al1", duration: 2, path: "web:go-music-dl:soda", suffix: "mp3", bitRate: 320, genre: "Test", type: "web", groupId: "g-soda", groupKey: "k-soda", url: `${baseUrl}/soda.m4a` },
    // 模拟 octet-stream + 真实 mp3 → 应透传且修正 Content-Type。
    { id: "sm", title: "SodaMp3", artist: "Test Artist", artistId: "ar1", album: "Test Album", albumId: "al1", duration: 2, path: "web:go-music-dl:soda", suffix: "mp3", bitRate: 320, genre: "Test", type: "web", groupId: "g-sodamp3", groupKey: "k-sodamp3", url: `${baseUrl}/soda_mp3.bin` },
  ]).run();
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  fs.rmSync(fixtureDir, { recursive: true, force: true });
});

describe("/rest/dlna/stream/:token 音箱格式兜底转码", () => {
  it("上游返回 audio/ogg → 服务端转 192k mp3 出流(端到端 ffmpeg)", async () => {
    const { token } = createCastSession("wo", "dev1", "http://localhost:1");
    const res = await app.request(`/rest/dlna/stream/${token}`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("audio/mpeg");
    const buf = Buffer.from(await res.arrayBuffer());
    expect(buf.length).toBeGreaterThan(1024); // 有实际转码音频数据
    // ID3v2 头("ID3")或 mp3 sync 帧头(0xFF Ex)
    const hasId3 = buf[0] === 0x49 && buf[1] === 0x44 && buf[2] === 0x33;
    const hasMp3Sync = buf[0] === 0xff && (buf[1] & 0xe0) === 0xe0;
    expect(hasId3 || hasMp3Sync).toBe(true);
  });

  it("上游返回 audio/mpeg → 原样透传,不转码(Content-Length 保持上游全量)", async () => {
    const { token } = createCastSession("wm", "dev1", "http://localhost:1");
    const res = await app.request(`/rest/dlna/stream/${token}`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("audio/mpeg");
    expect(Number(res.headers.get("content-length"))).toBe(mpegBytes.length);
    const buf = Buffer.from(await res.arrayBuffer());
    expect(buf.equals(mpegBytes)).toBe(true);
  });

  it("上游 octet-stream + M4A(go-music-dl soda 源) → 兜底转 192k mp3", async () => {
    const { token } = createCastSession("so", "dev1", "http://localhost:1");
    const res = await app.request(`/rest/dlna/stream/${token}`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("audio/mpeg");
    const buf = Buffer.from(await res.arrayBuffer());
    expect(buf.length).toBeGreaterThan(1024); // 有实际转码音频数据
    const hasId3 = buf[0] === 0x49 && buf[1] === 0x44 && buf[2] === 0x33;
    const hasMp3Sync = buf[0] === 0xff && (buf[1] & 0xe0) === 0xe0;
    expect(hasId3 || hasMp3Sync).toBe(true);
  });

  it("上游 octet-stream + 真实 mp3 → 透传并把 Content-Type 修正为 audio/mpeg", async () => {
    const { token } = createCastSession("sm", "dev1", "http://localhost:1");
    const res = await app.request(`/rest/dlna/stream/${token}`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("audio/mpeg");
    const buf = Buffer.from(await res.arrayBuffer());
    expect(buf.equals(mp3Bytes)).toBe(true); // 未转码,原样透传
  });

  it("探测结果缓存:同一行二次拉流只探测一次上游", async () => {
    const before = probeCount;
    const { token: t1 } = createCastSession("wc", "dev1", "http://localhost:1");
    const r1 = await app.request(`/rest/dlna/stream/${t1}`);
    expect(r1.status).toBe(200);
    const { token: t2 } = createCastSession("wc", "dev1", "http://localhost:1");
    const r2 = await app.request(`/rest/dlna/stream/${t2}`);
    expect(r2.status).toBe(200);
    // 两次拉流 + 仅一次 Range 0-0 探测(第二次命中缓存直接转码)
    expect(probeCount - before).toBe(1);
  });
});
