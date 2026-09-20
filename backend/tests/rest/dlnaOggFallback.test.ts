// MUST be the first import: redirects DATA_DIR to an isolated temp dir before
// the backend opens its SQLite DB at module-load time.
import "../plugins/_env.js";

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Hono } from "hono";
import { getRequestListener } from "@hono/node-server";
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
import { createCastSession, setRuntimePort } from "../../src/services/dlna/control.js";
import { resolveFfmpeg } from "../../src/services/transcode.js";

// P2-2 契约:/rest/dlna/stream/:token 全通道走服务端实时管道,不再有直传旁路。
// 输出编码只由 resolveDlnaOutput 定(suffix mp3 → mp3 320;suffix flac → FLAC),
// 与上游实际格式无关(ffmpeg 解码器自适应,旧嗅探/探测逻辑已删)。
// 音箱兼容头:contentFeatures.dlna.org + 12h 假 Content-Length 恒带;
// ICY 仅设备请求 Icy-MetaData:1 时给(icy-metaint + 空元数据装帧)。
const app = new Hono();
app.route("/rest", restRoutes);

const fixtureDir = path.join(os.tmpdir(), `mf-dlna-pipe-${process.pid}`);
let oggBytes: Buffer;
let m4aBytes: Buffer;
let mp3Bytes: Buffer;
let flacPath: string;

// 12h 假总量:mp3 320k → 320*1000/8*43200;flac 按 1411k 估算。
const FAKE_LEN_MP3 = String(Math.ceil(320 * 1000 / 8 * 12 * 3600));
const FAKE_LEN_FLAC = String(Math.ceil(1411 * 1000 / 8 * 12 * 3600));

// 真实 HTTP 上游:按 path 返回不同格式。
let server: http.Server;
let appServer: http.Server;
let baseUrl = "";

beforeAll(async () => {
  if (!process.env.APP_VERSION) process.env.APP_VERSION = "1.0.0";
  fs.mkdirSync(fixtureDir, { recursive: true });
  const gen = (args: string[], out: string) => {
    const r = spawnSync(resolveFfmpeg(), ["-hide_banner", "-loglevel", "error", "-y", ...args, out], { encoding: "utf8" });
    if (r.status !== 0) throw new Error(`fixture 生成失败 ${out}: ${r.stderr?.slice(0, 500)}`);
    return fs.readFileSync(out);
  };
  // 真实 Ogg Vorbis(2s sine)——上游实际格式与 DB suffix(mp3)不一致的场景。
  oggBytes = gen(["-f", "lavfi", "-i", "sine=frequency=440:duration=2:sample_rate=44100", "-ac", "2", "-c:a", "libvorbis", "-f", "ogg"], path.join(fixtureDir, "fixture.ogg"));
  // 真实 M4A(AAC mp4 容器)。
  m4aBytes = gen(["-f", "lavfi", "-i", "sine=frequency=440:duration=2:sample_rate=44100", "-ac", "2", "-c:a", "aac", "-f", "mp4"], path.join(fixtureDir, "fixture.m4a"));
  // 真实 mp3。
  mp3Bytes = gen(["-f", "lavfi", "-i", "sine=frequency=440:duration=2:sample_rate=44100", "-c:a", "libmp3lame", "-f", "mp3"], path.join(fixtureDir, "fixture.mp3"));
  // 真实 FLAC(本地行 device-path 覆盖用)。
  flacPath = path.join(fixtureDir, "fixture.flac");
  gen(["-f", "lavfi", "-i", "sine=frequency=440:duration=2:sample_rate=44100", "-ac", "2", "-c:a", "flac"], flacPath);

  server = http.createServer((req, res) => {
    const u = new URL(req.url || "/", baseUrl || "http://x");
    const range = req.headers.range;
    const serve = (ct: string, body: Buffer) => {
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
    if (u.pathname === "/mpeg.mp3") { serve("audio/mpeg", mp3Bytes); return; }
    // 模拟 go-music-dl soda 源:Content-Type 标错为 octet-stream,body 是真实 M4A。
    if (u.pathname === "/soda.m4a") { serve("application/octet-stream", m4aBytes); return; }
    // 模拟 octet-stream + 真实 mp3:管道重编码,不再透传。
    if (u.pathname === "/soda_mp3.bin") { serve("application/octet-stream", mp3Bytes); return; }
    res.writeHead(404, { "content-type": "text/plain" });
    res.end("not found");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  // 转码输入现走本进程回环 token URL(SPEC §1.8):app 必须有真实回环 socket,
  // runtimePort 指向 app(不是上游 mock)。
  appServer = http.createServer(getRequestListener(app.fetch));
  await new Promise<void>((resolve) => appServer.listen(0, "127.0.0.1", resolve));
  setRuntimePort((appServer.address() as AddressInfo).port);

  initDatabase();
  registerBuiltinPlugins();
  db.insert(users).values({ id: "u1", username: "alice", password: "", salt: "salt", subsonicSalt: "subsalt", passEnc: encryptPassword("hunter2"), isAdmin: 1, isActive: 1, email: "a@b.c" }).run();
  db.insert(artists).values({ id: "ar1", name: "Test Artist" }).run();
  db.insert(albums).values({ id: "al1", name: "Test Album", artistId: "ar1", artist: "Test Artist", year: 2020, genre: "Test" }).run();
  db.insert(songs).values([
    // DB suffix 记 mp3,上游实际 Ogg → 管道按 suffix 出 mp3 320(ffmpeg 自适应解码 ogg)。
    { id: "wo", title: "Ogg", artist: "Test Artist", artistId: "ar1", album: "Test Album", albumId: "al1", duration: 2, path: "web:go-music-dl:qq", suffix: "mp3", bitRate: 320, genre: "Test", type: "web", groupId: "g-ogg", groupKey: "k-ogg", url: `${baseUrl}/ogg.ogg` },
    // 上游实际 mp3 → 同样走管道重编码(不再透传,无上游 Content-Length)。
    { id: "wm", title: "Mpeg", artist: "Test Artist", artistId: "ar1", album: "Test Album", albumId: "al1", duration: 2, path: "web:go-music-dl:qq", suffix: "mp3", bitRate: 320, genre: "Test", type: "web", groupId: "g-mpeg", groupKey: "k-mpeg", url: `${baseUrl}/mpeg.mp3` },
    // 幂等用例专用行。
    { id: "wc", title: "Cached", artist: "Test Artist", artistId: "ar1", album: "Test Album", albumId: "al1", duration: 2, path: "web:go-music-dl:qq", suffix: "mp3", bitRate: 320, genre: "Test", type: "web", groupId: "g-cache", groupKey: "k-cache", url: `${baseUrl}/ogg.ogg` },
    // Content-Type octet-stream + M4A body → 管道照常出 mp3(不依赖上游 MIME)。
    { id: "so", title: "SodaM4a", artist: "Test Artist", artistId: "ar1", album: "Test Album", albumId: "al1", duration: 2, path: "web:go-music-dl:soda", suffix: "mp3", bitRate: 320, genre: "Test", type: "web", groupId: "g-soda", groupKey: "k-soda", url: `${baseUrl}/soda.m4a` },
    // octet-stream + 真实 mp3 → 管道重编码(字节与上游不再一致)。
    { id: "sm", title: "SodaMp3", artist: "Test Artist", artistId: "ar1", album: "Test Album", albumId: "al1", duration: 2, path: "web:go-music-dl:soda", suffix: "mp3", bitRate: 320, genre: "Test", type: "web", groupId: "g-sodamp3", groupKey: "k-sodamp3", url: `${baseUrl}/soda_mp3.bin` },
    // 本地 FLAC 行:device-path(本地文件)同样走管道出 FLAC。
    { id: "lf", title: "LocalFlac", artist: "Test Artist", artistId: "ar1", album: "Test Album", albumId: "al1", duration: 2, path: `l:test:${flacPath}`, suffix: "flac", bitRate: 1411, genre: "Test", type: "local" },
  ]).run();
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await new Promise<void>((resolve) => appServer.close(() => resolve()));
  fs.rmSync(fixtureDir, { recursive: true, force: true });
});

const hasMp3Magic = (buf: Buffer) => {
  const hasId3 = buf[0] === 0x49 && buf[1] === 0x44 && buf[2] === 0x33;
  const hasMp3Sync = buf[0] === 0xff && (buf[1] & 0xe0) === 0xe0;
  return hasId3 || hasMp3Sync;
};

const expectDlnaHeaders = (res: Response, mime: string, fakeLen: string) => {
  expect(res.headers.get("content-type")).toBe(mime);
  expect(res.headers.get("x-musicflow-transcoded")).toBe("1");
  expect(res.headers.get("contentfeatures.dlna.org")).toContain("DLNA.ORG_OP=01");
  expect(res.headers.get("content-length")).toBe(fakeLen);
  // 默认不给 ICY(设备没请求)。
  expect(res.headers.get("icy-metaint")).toBeNull();
};

describe("/rest/dlna/stream/:token 全通道管道出流(P2-2)", () => {
  it("上游实际 ogg + DB suffix mp3 → 管道出 mp3(ffmpeg 自适应解码)", async () => {
    const { token } = createCastSession("wo", "dev1", "http://localhost:1");
    const res = await app.request(`/rest/dlna/stream/${token}`);
    expect(res.status).toBe(200);
    expectDlnaHeaders(res, "audio/mpeg", FAKE_LEN_MP3);
    const buf = Buffer.from(await res.arrayBuffer());
    expect(buf.length).toBeGreaterThan(1024);
    expect(hasMp3Magic(buf)).toBe(true);
  });

  it("上游实际 mp3 → 同样走管道重编码(不再透传上游字节)", async () => {
    const { token } = createCastSession("wm", "dev1", "http://localhost:1");
    const res = await app.request(`/rest/dlna/stream/${token}`);
    expect(res.status).toBe(200);
    expectDlnaHeaders(res, "audio/mpeg", FAKE_LEN_MP3);
    const buf = Buffer.from(await res.arrayBuffer());
    expect(hasMp3Magic(buf)).toBe(true);
    expect(buf.equals(mp3Bytes)).toBe(false); // 管道重编码,字节与上游不一致
  });

  it("上游 octet-stream + M4A → 管道照常出 mp3(不依赖上游 MIME)", async () => {
    const { token } = createCastSession("so", "dev1", "http://localhost:1");
    const res = await app.request(`/rest/dlna/stream/${token}`);
    expect(res.status).toBe(200);
    expectDlnaHeaders(res, "audio/mpeg", FAKE_LEN_MP3);
    const buf = Buffer.from(await res.arrayBuffer());
    expect(buf.length).toBeGreaterThan(1024);
    expect(hasMp3Magic(buf)).toBe(true);
  });

  it("上游 octet-stream + 真实 mp3 → 管道重编码(不再透传修正 MIME)", async () => {
    const { token } = createCastSession("sm", "dev1", "http://localhost:1");
    const res = await app.request(`/rest/dlna/stream/${token}`);
    expect(res.status).toBe(200);
    expectDlnaHeaders(res, "audio/mpeg", FAKE_LEN_MP3);
    const buf = Buffer.from(await res.arrayBuffer());
    expect(hasMp3Magic(buf)).toBe(true);
    expect(buf.equals(mp3Bytes)).toBe(false);
  });

  it("本地 FLAC 行 → 管道出 FLAC(fLaC 魔数)", async () => {
    const { token } = createCastSession("lf", "dev1", "http://localhost:1");
    const res = await app.request(`/rest/dlna/stream/${token}`);
    expect(res.status).toBe(200);
    expectDlnaHeaders(res, "audio/flac", FAKE_LEN_FLAC);
    const buf = Buffer.from(await res.arrayBuffer());
    expect(buf.length).toBeGreaterThan(1024);
    expect(buf.subarray(0, 4).toString("ascii")).toBe("fLaC");
  });

  it("设备请求 Icy-MetaData:1 → icy-metaint + 空元数据装帧", async () => {
    const { token } = createCastSession("wm", "dev1", "http://localhost:1");
    const res = await app.request(`/rest/dlna/stream/${token}`, { headers: { "Icy-MetaData": "1" } });
    expect(res.status).toBe(200);
    expect(res.headers.get("icy-metaint")).toBe("16384");
    const buf = Buffer.from(await res.arrayBuffer());
    expect(hasMp3Magic(buf)).toBe(true);
    // 装帧:每 16384 音频字节后 1 字节 0x00,零块位置固定步长 16385。
    expect(buf.length).toBeGreaterThan(16385);
    for (let pos = 16384; pos < buf.length; pos += 16385) {
      expect(buf[pos]).toBe(0);
    }
  });

  it("同一行二次拉流均 200(管道无状态,无探测缓存)", async () => {
    const { token: t1 } = createCastSession("wc", "dev1", "http://localhost:1");
    const r1 = await app.request(`/rest/dlna/stream/${t1}`);
    expect(r1.status).toBe(200);
    await r1.arrayBuffer();
    const { token: t2 } = createCastSession("wc", "dev1", "http://localhost:1");
    const r2 = await app.request(`/rest/dlna/stream/${t2}`);
    expect(r2.status).toBe(200);
    expectDlnaHeaders(r2, "audio/mpeg", FAKE_LEN_MP3);
  });
});
