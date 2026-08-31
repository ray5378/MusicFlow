// MUST be the first import: redirects DATA_DIR to an isolated temp dir before
// the backend opens its SQLite DB at module-load time.
import "../plugins/_env.js";

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Hono } from "hono";
import md5 from "md5";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { db, initDatabase, encryptPassword } from "../../src/db/index.js";
import { users, artists, albums, songs, mediaSources } from "../../src/db/schema.js";
import { authMiddleware } from "../../src/middleware/auth.js";
import { restRoutes } from "../../src/routes/rest/index.js";
import { resolveFfmpeg } from "../../src/services/transcode.js";

// 真实链路:authMiddleware + restRoutes + 真实磁盘音频文件 + 真实 ffmpeg 转码进程。
// 与 opensubsonic.test.ts 的唯一区别:本文件用系统 ffmpeg 生成一个 4s WAV fixture,
// 端到端验证 /rest/stream 的「原样直连 / format 转码 / maxBitRate 压码率 / timeOffset seek」。
// 服务器 CI(ci.yml)与客户端 CI(transcode-chain.yml)同时跑这套契约,防止链路漂移。
const app = new Hono();
app.use("/rest/*", authMiddleware);
app.route("/rest", restRoutes);

const PLAIN = "hunter2";
const CLIENT_SALT = "clientsalt123";
const authQS = () => `u=alice&t=${md5(PLAIN + CLIENT_SALT)}&s=${CLIENT_SALT}`;

const fixtureDir = path.join(os.tmpdir(), `mf-transcode-fixture-${process.pid}`);
const wavPath = path.join(fixtureDir, "sine.wav");
let wavSize = 0;

beforeAll(() => {
  if (!process.env.APP_VERSION) process.env.APP_VERSION = "1.0.0";

  // 生成 4s 44.1kHz 双声道正弦波 WAV 作为真实转码输入。
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
  db.insert(users).values({ id: "u1", username: "alice", password: "", salt: "salt", subsonicSalt: "subsalt", passEnc: encryptPassword(PLAIN), isAdmin: 1, isActive: 1, email: "a@b.c" }).run();
  db.insert(artists).values({ id: "ar1", name: "Test Artist" }).run();
  db.insert(albums).values({ id: "al1", name: "Test Album", artistId: "ar1", artist: "Test Artist", year: 2020, genre: "Test" }).run();
  db.insert(mediaSources).values({ id: "src", name: "Local", type: "local", enabled: 1, config: "{}" }).run();
  db.insert(songs).values([
    // 44.1kHz/16bit 立体声 WAV 理论码率 1411 kbps。
    { id: "sw", title: "Sine", artist: "Test Artist", artistId: "ar1", album: "Test Album", albumId: "al1", duration: 4, path: `l:src:${wavPath}`, suffix: "wav", bitRate: 1411, genre: "Test", type: "local" },
  ]).run();
});

afterAll(() => {
  try { fs.rmSync(fixtureDir, { recursive: true, force: true }); } catch { /* 忽略清理失败 */ }
});

async function stream(extraParams: string) {
  const q = extraParams ? `${extraParams}&` : "";
  const res = await app.request(`/rest/stream?id=sw&${q}${authQS()}`);
  const buf = Buffer.from(await res.arrayBuffer());
  return { res, buf };
}

// mp3 输出可能以 ID3v2 标签开头（0x49 'I'），帧同步 0xFF Ex 在标签之后。
// 在前 4KB 内扫描是否存在 MPEG-1/2 Layer III 帧同步头即可证明是合法 mp3。
function hasMpegFrameSync(buf: Buffer): boolean {
  for (let i = 0; i + 1 < buf.length && i < 4096; i++) {
    if (buf[i] === 0xff && (buf[i + 1] & 0xe0) === 0xe0) return true;
  }
  return false;
}

describe("OpenSubsonic /rest/stream 转码端到端（真实 ffmpeg）", () => {
  it("无参数 → 原样返回 WAV（Content-Type/Content-Length/字节一致）", async () => {
    const { res, buf } = await stream("");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("audio/wav");
    expect(res.headers.get("content-length")).toBe(String(wavSize));
    expect(buf.length).toBe(wavSize);
    expect(buf.equals(fs.readFileSync(wavPath))).toBe(true);
  }, 30000);

  it("format=mp3 → 实时转码 mp3（audio/mpeg、无 Content-Length、MPEG 帧同步头）", async () => {
    const { res, buf } = await stream("format=mp3");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("audio/mpeg");
    // 转码流不可按字节 Range 断点续传 → 不返回 Content-Length。
    expect(res.headers.get("content-length")).toBeNull();
    expect(buf.length).toBeGreaterThan(1000);
    expect(hasMpegFrameSync(buf)).toBe(true);
  }, 30000);

  it("format=aac → 实时转码 ADTS AAC（audio/aac）", async () => {
    const { res, buf } = await stream("format=aac");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("audio/aac");
    expect(buf.length).toBeGreaterThan(1000);
    expect(buf[0]).toBe(0xff);
    expect(buf[1] & 0xf0).toBe(0xf0); // ADTS syncword 0xFFF
  }, 30000);

  it("format=mp3&maxBitRate=64 → 低码率 mp3 显著小于默认 320", async () => {
    const full = await stream("format=mp3");            // 默认 320k CBR
    const low = await stream("format=mp3&maxBitRate=64"); // 64k CBR
    expect(low.res.headers.get("content-type")).toBe("audio/mpeg");
    expect(low.buf.length).toBeGreaterThan(500);
    expect(low.buf.length).toBeLessThan(full.buf.length * 0.5);
  }, 30000);

  it("format=mp3&timeOffset=2 → 从 2s 起转码,流更短但仍为合法 mp3", async () => {
    const full = await stream("format=mp3");              // 全长 4s
    const seeked = await stream("format=mp3&timeOffset=2"); // 从 2s 起 ~2s
    expect(seeked.res.headers.get("content-type")).toBe("audio/mpeg");
    expect(seeked.buf.length).toBeGreaterThan(500);
    expect(seeked.buf.length).toBeLessThan(full.buf.length * 0.8);
  }, 30000);

  it("仅 maxBitRate=64（无 format）→ 压码率默认转 mp3", async () => {
    const { res, buf } = await stream("maxBitRate=64");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("audio/mpeg");
    expect(res.headers.get("content-length")).toBeNull();
    expect(buf.length).toBeGreaterThan(500);
    expect(hasMpegFrameSync(buf)).toBe(true);
  }, 30000);
});
