// MUST be the first import: redirects DATA_DIR to an isolated temp dir before
// the backend opens its SQLite DB at module-load time.
import "../plugins/_env.js";

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Hono } from "hono";
import { getRequestListener } from "@hono/node-server";
import md5 from "md5";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { fileURLToPath } from "node:url";
import type { AddressInfo } from "node:net";
import { spawnSync } from "node:child_process";
import { db, initDatabase, encryptPassword } from "../../src/db/index.js";
import { users, artists, albums, songs } from "../../src/db/schema.js";
import { authMiddleware } from "../../src/middleware/auth.js";
import { registerBuiltinPlugins } from "../../src/plugins/builtins.js";
import { restRoutes, resolveRequestAf } from "../../src/routes/rest/index.js";
import { createCastSession, setRuntimePort } from "../../src/services/dlna/control.js";
import { resolveFfmpeg } from "../../src/services/transcode.js";
import { setSetting } from "../../src/services/settings.js";

// ==================== P2-6 / P2-7 契约锁（D9 的可执行版本） ====================
// 「不留直传旁路」这条决定（D9）在本文件里被钉成三条，其余出流细节
// （MIME 随格式、响应头四项、DLNA 拒 FLAC 回退）由 transcodeStream.test.ts /
// dlnaOggFallback.test.ts / services/pipeline.test.ts 覆盖，本文件不重复。
//
//   ① 开关开/关：关掉 `pipeline.http` **只等于滤镜链为空**，不回到绕过管道（D9）；
//   ② 换源行后增益变化：测量键是 **row.id** —— 同一首歌换到另一行 = 换增益来源，
//      没有测量的行必须回实时 loudnorm，不会复用上一行的增益；
//   ③ 结构锁：三个出流路由（/stream、/dlna/stream/:token、/stream-remote）的源码里
//      不允许再出现「原样直出」手段（`createReadStream` / `Accept-Ranges` /
//      `getParam(c,"raw")` / `c.body(` / `serveDlnaWebStream` / `serveWebSongStream`）。
//      P2-7 补的是第三处（搜索即播的未入库远程歌），它曾是唯一还在整段代理上游字节的路。
//   ④ P3-1/P3-5 之后多了一个出流点：`serveFlowQueue`（队列连续流 + 交叉淡入）。
//      它**也是一个管道出口**（六段里的 ①②③④⑤⑥ 全在同一会话内完成），
//      所以 X 头从"只定义一次"改成"只在两个管道出口各定义一次"，并且
//      flow 只能由开关把关、只作为回退链的一环出现 —— 不许出现"第三条"出流。
//
// ⚠️ DLNA 路由里**保留**的回环 `raw` 分支（`resolveRawStreamToken`）是喂给 ffmpeg 的
// 取源通道（SPEC §1.8 第三个坑的落库注册表），**不是**面向用户的直透 —— 结构锁因此
// 只从 **cast token 分支之后**开始断言干净，不整段扫。
const SRC_DIR = fileURLToPath(new URL("../../src", import.meta.url));
const readSrc = (rel: string) => fs.readFileSync(path.join(SRC_DIR, rel), "utf8");

/** 按文本标记切出单个路由 handler 的源码段（比行号稳，行号会漂）。 */
function sliceBetween(src: string, startMarker: string, endMarker: string): string {
  const i = src.indexOf(startMarker);
  expect(i, `找不到起始标记:${startMarker}`).toBeGreaterThanOrEqual(0);
  const j = src.indexOf(endMarker, i + startMarker.length);
  expect(j, `找不到结束标记:${endMarker}`).toBeGreaterThan(i);
  return src.slice(i, j);
}

describe("P2-6 结构锁:两个路由都不再有原样直出路径（D9 回归锁）", () => {
  const restSrc = readSrc("routes/rest/index.ts");

  it("/rest/stream handler 段内无任何原样直出手段", () => {
    const seg = sliceBetween(restSrc, 'restRoutes.get("/stream",', 'restRoutes.get("/stream-remote"');
    expect(seg).toContain("servePipelinedSong(");
    expect(seg).not.toContain("createReadStream");
    expect(seg).not.toContain("Accept-Ranges");
    expect(seg).not.toMatch(/getParam\(c,\s*"raw"\)/);
    // P3-1(HTTP 侧):flow 只作为**显式 opt-in** 存在(`flow=1` + `peerId=`),
    // 且必须过开关;两条出口都落在管道里(单曲 / 连续流),没有第三条。
    expect(seg).toMatch(/getParam\(c,\s*"flow"\)/);
    expect(seg).toContain("serveFlowQueue(");
    expect(seg).toContain("resolveFlowSettings(");
  });

  it("/rest/dlna/stream handler 段的 cast 分支后无原样直出手段", () => {
    const seg = sliceBetween(restSrc, 'restRoutes.get("/dlna/stream/:token"', 'restRoutes.get("/download"');
    expect(seg).toContain("servePipelinedSong(");
    // 回环取源分支必须挂在本进程注册表上（发给 ffmpeg 用），不能被换成别的签发来源
    expect(seg).toContain("resolveRawStreamToken(token)");
    // cast token（用户可见路径）之后一律走管道
    const afterCast = seg.slice(seg.indexOf("resolveCastSession(token)"));
    expect(afterCast.length).toBeGreaterThan(0);
    expect(afterCast).not.toContain("createReadStream");
    expect(afterCast).not.toContain("Accept-Ranges");
    expect(afterCast).toContain("servePipelinedSong(");
    // P3-5:DLNA 侧默认由服务端接管队列 → flow 出口必须**开关把关**（缺省关）
    // 且会话内部仍是六段管道（serveFlowQueue 就是管道出口，不是旁路）。
    expect(afterCast).toContain("resolveFlowSettings(");
    expect(afterCast).toContain("serveFlowQueue(");
    // 设备在流内 seek（timeOffset>0）时连续流没有稳定语义 → 必须落回单曲管道
    expect(afterCast).toMatch(/timeOffset === 0/);
  });

  it("X-MusicFlow-Transcoded 头只在两个管道出口定义（单曲管道 / flow 连续流，没有第三条）", () => {
    const single = sliceBetween(restSrc, "async function serveFfmpegPipe(", "function icyFrameStream(");
    const flowExit = sliceBetween(restSrc, "async function serveFlowQueue(", "async function resolveTranscodeInput(");
    const count = (s: string) => (s.match(/"X-MusicFlow-Transcoded":/g) || []).length;
    expect(count(single)).toBe(1);
    expect(count(flowExit)).toBe(1);
    // 文件总计 = 2 ⇒ 两个出口之外不可能再有别的出流点
    expect(count(restSrc)).toBe(2);
    // flow 出口额外自报家门（便于线上分辨设备拉到的是连续流还是单曲流）
    expect(flowExit).toContain('"X-MusicFlow-Flow": "1"');
  });

  it("被删掉的直出实现不许复活", () => {
    expect(restSrc).not.toContain("serveDlnaWebStream");
    const controlSrc = readSrc("services/dlna/control.ts");
    expect(controlSrc).not.toContain("serveDlnaWebStream");
    // P2-7：搜索即播的原样代理实现整段删除，连函数名都不许再出现（注释里的
    // 历史引用不算，所以锁调用/定义形态而不是裸名字）。
    expect(restSrc).not.toContain("serveWebSongStream(");
  });

  // P2-7：搜索即播（未入库远程歌）是第三处直出 —— 它曾整段代理上游字节
  // （`c.body(upstream.body)` + 上游 Content-Length + Accept-Ranges），
  // Web 搜索结果与 HA 卡片都走它，因此这条锁是「五条链路全覆盖」的最后一块。
  it("/rest/stream-remote handler 段内走管道且无原样直出手段", () => {
    const seg = sliceBetween(restSrc, 'restRoutes.get("/stream-remote"', 'restRoutes.get("/dlna/stream/:token"');
    expect(seg).toContain("servePipelinedSong(");
    // 换源在交给 ffmpeg 之前做完（子进程报错就再没机会换源）
    expect(seg).toContain("resolveRemoteStreamUrl(");
    expect(seg).not.toContain("createReadStream");
    expect(seg).not.toContain("Accept-Ranges");
    expect(seg).not.toContain("upstream");
    expect(seg).not.toMatch(/c\.body\(/);
    // seek：管道流无字节 Range，必须按 timeOffset 重拉（小数精度：parseTimeOffset
    // 接受 0.1s 粒度，旧整秒 floor 是 Web/客户端「定位恒偏小 <1s」的来源之一）。
    expect(seg).toContain("parseTimeOffset(c)");
  });

  // 前端联动锁（P2-7）：输出格式固定 mp3 ⇒ 前端必须固定按 mp3 建 Howl，
  // 且**不能再探测** —— 那条 `Range: bytes=0-0` 的 GET 会拉起一个常驻
  // ffmpeg 转码槽而 body 被丢着不读。
  it("前端远程歌不再探测格式、固定按 mp3 建 Howl", () => {
    const playerSrc = fs.readFileSync(
      fileURLToPath(new URL("../../../frontend/src/stores/player.ts", import.meta.url)), "utf8",
    );
    expect(playerSrc).toContain('isRemoteSong(song) ? "mp3"');
    expect(playerSrc).not.toContain("probeRemoteFormat");
    expect(playerSrc).not.toContain('Range: "bytes=0-0"');
  });
});

// ---------------- 真实链路 harness ----------------

const authedApp = new Hono();
authedApp.use("/rest/*", authMiddleware);
authedApp.route("/rest", restRoutes);

// DLNA 路由按设计不带鉴权（音箱发不出 auth 头），单开一个 app 与真实一致。
const dlnaApp = new Hono();
dlnaApp.route("/rest", restRoutes);

const PLAIN = "hunter2";
const CLIENT_SALT = "clientsalt123";
const authQS = () => `u=alice&t=${md5(PLAIN + CLIENT_SALT)}&s=${CLIENT_SALT}`;

const fixtureDir = path.join(os.tmpdir(), `mf-pipeline-contract-${process.pid}`);
let flacPath = "";

// 12h 假总量(与 dlnaOggFallback.test.ts 同一口径):flac 按 1411k 估算。
const FAKE_LEN_FLAC = String(Math.ceil(1411 * 1000 / 8 * 12 * 3600));

let appServer: http.Server;

beforeAll(async () => {
  if (!process.env.APP_VERSION) process.env.APP_VERSION = "1.0.0";
  fs.mkdirSync(fixtureDir, { recursive: true });
  const gen = (args: string[], out: string) => {
    const r = spawnSync(resolveFfmpeg(), ["-hide_banner", "-loglevel", "error", "-y", ...args, out], { encoding: "utf8" });
    if (r.status !== 0) throw new Error(`fixture 生成失败 ${out}: ${r.stderr?.slice(0, 500)}`);
    return out;
  };
  // 2s 正弦 WAV(无损源 → 管道按源族出 FLAC)与 FLAC(DLNA 本地行)。
  const wavPath = gen(["-f", "lavfi", "-i", "sine=frequency=440:duration=2:sample_rate=44100", "-ac", "2", "-c:a", "pcm_s16le"], path.join(fixtureDir, "sine.wav"));
  flacPath = gen(["-f", "lavfi", "-i", "sine=frequency=440:duration=2:sample_rate=44100", "-ac", "2", "-c:a", "flac"], path.join(fixtureDir, "sine.flac"));

  // 真实回环 socket:运行时端口必须回填成实际监听端口(SPEC §1.8)。
  appServer = http.createServer(getRequestListener(dlnaApp.fetch));
  await new Promise<void>((resolve) => appServer.listen(0, "127.0.0.1", resolve));
  setRuntimePort((appServer.address() as AddressInfo).port);

  initDatabase();
  registerBuiltinPlugins();
  db.insert(users).values({ id: "u1", username: "alice", password: "", salt: "salt", subsonicSalt: "subsalt", passEnc: encryptPassword(PLAIN), isAdmin: 1, isActive: 1, email: "a@b.c" }).run();
  db.insert(artists).values({ id: "ar1", name: "Test Artist" }).run();
  db.insert(albums).values({ id: "al1", name: "Test Album", artistId: "ar1", artist: "Test Artist", year: 2020, genre: "Test" }).run();
  db.insert(songs).values([
    // 同一首歌的两个「行」：pw 走 /rest/stream，pl 走 DLNA —— 换行 = 换增益来源。
    { id: "pw", title: "Sine", artist: "Test Artist", artistId: "ar1", album: "Test Album", albumId: "al1", duration: 2, path: `l:src:${wavPath}`, suffix: "wav", bitRate: 1411, genre: "Test", type: "local" },
    { id: "pl", title: "SineFlac", artist: "Test Artist", artistId: "ar1", album: "Test Album", albumId: "al1", duration: 2, path: `l:src:${flacPath}`, suffix: "flac", bitRate: 1411, genre: "Test", type: "local" },
    // 无测量行:验证换到它时回到实时 loudnorm(而不是复用上一行的增益)。
    { id: "p3", title: "NoMeasure", artist: "Test Artist", artistId: "ar1", album: "Test Album", albumId: "al1", duration: 2, path: `l:src:${flacPath}`, suffix: "flac", bitRate: 1411, genre: "Test", type: "local" },
  ]).run();
});

afterAll(async () => {
  await new Promise<void>((resolve) => appServer.close(() => resolve()));
  fs.rmSync(fixtureDir, { recursive: true, force: true });
});

describe("P2-6 开关:pipeline.http 关掉也只等于「滤镜链为空」（D9）", () => {
  it("关闭 → af 链为空;开启 → 实时 loudnorm + 限制器", async () => {
    try {
      setSetting("pipeline.http", "0");
      expect(await resolveRequestAf(null)).toEqual([]);
      setSetting("pipeline.http", "1");
      const af = await resolveRequestAf(null);
      expect(af[0]).toContain("loudnorm=I=-14");
      expect(af[af.length - 1]).toContain("alimiter=limit=-1dB");
    } finally {
      setSetting("pipeline.http", "1");
    }
  });

  // P5-1：全局总开关与每通道开关是**相乘**的判定，且只影响判定、不改"仍走管道"这件事。
  it("P5-1：单通道关只影响自己；全局关则所有通道空链（重开即恢复）", async () => {
    try {
      setSetting("pipeline.dlna", "0");
      expect(await resolveRequestAf(null, undefined, "dlna")).toEqual([]);
      // HTTP 通道不受 DLNA 通道开关影响
      expect((await resolveRequestAf(null))[0]).toContain("loudnorm=I=-14");
      setSetting("pipeline.dlna", "1");
      expect((await resolveRequestAf(null, undefined, "dlna")).length).toBeGreaterThan(0);

      setSetting("pipeline.enabled", "0");
      expect(await resolveRequestAf(null)).toEqual([]);
      expect(await resolveRequestAf(null, undefined, "dlna")).toEqual([]);
      setSetting("pipeline.enabled", "1");
      expect((await resolveRequestAf(null)).length).toBeGreaterThan(0);
    } finally {
      setSetting("pipeline.enabled", "1");
      setSetting("pipeline.dlna", "1");
      setSetting("pipeline.http", "1");
    }
  });

  it("P5-2：channel=null 表示调用方已判定本次不带滤镜链（DLNA 单设备回退）", async () => {
    expect(await resolveRequestAf(null, undefined, null)).toEqual([]);
  });

  it("关闭时 /rest/stream 仍走管道出 FLAC（X 头在、无 Content-Length）", async () => {
    setSetting("pipeline.http", "0");
    try {
      const res = await authedApp.request(`/rest/stream?id=pw&${authQS()}`);
      expect(res.status).toBe(200);
      expect(res.headers.get("x-musicflow-transcoded")).toBe("1");
      expect(res.headers.get("content-type")).toBe("audio/flac");
      // 实时流无字节总量 → 不可能存在原样直出时的 Content-Length。
      expect(res.headers.get("content-length")).toBeNull();
      const buf = Buffer.from(await res.arrayBuffer());
      expect(buf.subarray(0, 4).toString("ascii")).toBe("fLaC");
    } finally {
      setSetting("pipeline.http", "1");
    }
  }, 30000);

  it("关闭时 /rest/dlna/stream/:token 仍走管道（音箱兼容头齐备）", async () => {
    setSetting("pipeline.http", "0");
    try {
      const { token } = createCastSession("pl", "dev1", "http://localhost:1");
      const res = await dlnaApp.request(`/rest/dlna/stream/${token}`);
      expect(res.status).toBe(200);
      expect(res.headers.get("x-musicflow-transcoded")).toBe("1");
      expect(res.headers.get("content-type")).toBe("audio/flac");
      expect(res.headers.get("contentfeatures.dlna.org")).toContain("DLNA.ORG_OP=01");
      expect(res.headers.get("content-length")).toBe(FAKE_LEN_FLAC);
      // 设备没请求 Icy-MetaData → 不给 ICY。
      expect(res.headers.get("icy-metaint")).toBeNull();
      const buf = Buffer.from(await res.arrayBuffer());
      expect(buf.subarray(0, 4).toString("ascii")).toBe("fLaC");
    } finally {
      setSetting("pipeline.http", "1");
    }
  }, 30000);

  it("timeOffset 接受小数(0.1s 粒度)与非法值归零", async () => {
    // 小数 -ss:ffmpeg 前置定位支持小数,2s 源从 0.5s 起仍有 ~1.5s 可播。
    const frac = await authedApp.request(`/rest/stream?id=pw&timeOffset=0.5&${authQS()}`);
    expect(frac.status).toBe(200);
    expect(frac.headers.get("x-musicflow-transcoded")).toBe("1");
    const fbuf = Buffer.from(await frac.arrayBuffer());
    expect(fbuf.subarray(0, 4).toString("ascii")).toBe("fLaC");
    expect(fbuf.length).toBeGreaterThan(1024);
    // 非法值归 0:不断流(旧 parseInt||0 同语义,小数版延续)。
    const bad = await authedApp.request(`/rest/stream?id=pw&timeOffset=abc&${authQS()}`);
    expect(bad.status).toBe(200);
    const bbuf = Buffer.from(await bad.arrayBuffer());
    expect(bbuf.subarray(0, 4).toString("ascii")).toBe("fLaC");
  }, 30000);
});

describe("P2-6 换源行后增益变化（测量键是 row.id）", () => {
  it("换行 = 换增益来源;无测量的行回实时 loudnorm,不复用上一行增益", async () => {
    const { resolveLoudnessAf } = await import("../../src/services/audio/pipeline.js");
    const { saveAnalysis, loadAnalysis, deleteAnalysis } = await import("../../src/services/audio/analysisStore.js");
    try {
      saveAnalysis("pw", "local", { loudnessIntegrated: -20 });
      saveAnalysis("pl", "local", { loudnessIntegrated: -8 });
      // 目标 -14:增益 = 目标 − 实测
      expect(resolveLoudnessAf({ rowId: "pw" })[0]).toBe("volume=6dB");
      expect(resolveLoudnessAf({ rowId: "pl" })[0]).toBe("volume=-6dB");
      // 同一首歌换到没测量的行 → 回实时,不会把上一行测出的增益套上去
      expect(resolveLoudnessAf({ rowId: "p3" })[0]).toContain("loudnorm");
      expect(loadAnalysis("p3")).toBeNull();
    } finally {
      deleteAnalysis("pw");
      deleteAnalysis("pl");
    }
  });
});
