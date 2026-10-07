// MUST be the first import: redirects DATA_DIR to an isolated temp dir before
// the backend opens its SQLite DB at module-load time.
import "../plugins/_env.js";

import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from "vitest";
import { Hono } from "hono";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import md5 from "md5";
import { spawnSync } from "node:child_process";
import { serve } from "@hono/node-server";
import { db, initDatabase, encryptPassword } from "../../src/db/index.js";
import { users, songs, mediaSources } from "../../src/db/schema.js";
import { authMiddleware } from "../../src/middleware/auth.js";
import { restRoutes } from "../../src/routes/rest/index.js";
import { resolveFfmpeg } from "../../src/services/transcode.js";
import { setRuntimePort } from "../../src/services/dlna/control.js";
import {
  fetchWholeSongBuffered,
  fetchSongWithRetryWindow,
  registerMemStream,
  resolveMemStream,
  resetMemStreamsForTest,
  resetRetryLoopsForTest,
  bufferedInFlightBytes,
} from "../../src/services/source/bufferedFetch.js";

// ==================== batch44:整曲内存缓冲 + 僵尸流显式失败 ====================
//
// 覆盖两条网络源路径(WEBDAV 行 / web 插件行)+ 统一取流层单元语义。
// **必须起真实 HTTP 服务**(serve + setRuntimePort):缓冲成功后 ffmpeg 经
// `/rest/membuf/:token` 回环取字节,app.request(内存态)没有真实监听端口,回环打不通;
// 且真实 socket 才能验证「下游收到连接错误」(socket 被拆 ⇒ fetch reject)。
//
// 僵尸流契约:上游出错/停摆 ⇒ 下游必须看到「错误或明确失败」,绝不挂一个不产字节的 200。

const app = new Hono();
app.use("/rest/*", async (c, next) => {
  // 与生产 src/index.ts 同规则:回环 token 路由免鉴权(token 即凭证)。
  const p = c.req.path;
  if (p.includes("/dlna/stream/") || p.includes("/membuf/")) return next();
  return authMiddleware(c, next);
});
app.route("/rest", restRoutes);

const PLAIN = "hunter2";
const CLIENT_SALT = "clientsalt123";
const authQS = () => `u=alice&t=${md5(PLAIN + CLIENT_SALT)}&s=${CLIENT_SALT}`;

const fixtureDir = path.join(os.tmpdir(), `mf-bufstream-${process.pid}`);
const wavPath = path.join(fixtureDir, "sine.wav");
let wav: Buffer = Buffer.alloc(0);
let appPort = 0;

// ---------------- 假上游 ----------------

type Mode = "ok" | "flaky" | "dead" | "hang-headers" | "hang-mid" | "garbage-binary" | "big" | "two-chunks" | "json-error";
interface Behavior { mode: Mode; hits: number }
const behaviors = new Map<string, Behavior>();
function behavior(p: string, mode: Mode): Behavior {
  const b = { mode, hits: 0 };
  behaviors.set(p, b);
  return b;
}

// two-chunks 用「每用例新闸门」,避免跨用例的闸门状态串扰。
let twoChunkGate: Promise<void> = Promise.resolve();
let releaseTwoChunks: () => void = () => {};

let upServer: http.Server;
let upPort = 0;
let appServer: any;

beforeAll(async () => {
  if (!process.env.APP_VERSION) process.env.APP_VERSION = "1.0.0";

  fs.mkdirSync(fixtureDir, { recursive: true });
  const r = spawnSync(resolveFfmpeg(), [
    "-hide_banner", "-loglevel", "error", "-y",
    "-f", "lavfi", "-i", "sine=frequency=440:duration=2:sample_rate=44100",
    "-ac", "2", "-c:a", "pcm_s16le", wavPath,
  ], { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`ffmpeg fixture 生成失败: ${r.stderr?.slice(0, 500)}`);
  wav = fs.readFileSync(wavPath);

  upServer = http.createServer((req, res) => {
    const key = req.url?.split("?")[0] || "/";
    const b = behaviors.get(key);
    if (!b) { res.writeHead(404); res.end(); return; }
    b.hits++;
    switch (b.mode) {
      case "ok":
        res.writeHead(200, { "Content-Type": "audio/wav", "Content-Length": String(wav.length) });
        res.end(wav);
        break;
      case "flaky":
        if (b.hits === 1) { res.writeHead(500); res.end("boom"); }
        else { res.writeHead(200, { "Content-Type": "audio/wav", "Content-Length": String(wav.length) }); res.end(wav); }
        break;
      case "dead":
        res.writeHead(404); res.end();
        break;
      case "hang-headers":
        // 永不响应(连接保持)—— 模拟上游建连后 TTFB 挂死。
        break;
      case "hang-mid":
        // 发一小段后永久停发 —— 模拟「上游断/错但连接没断」的停摆形态。
        res.writeHead(200, { "Content-Type": "audio/wav", "Content-Length": String(wav.length) });
        res.write(wav.subarray(0, 1000));
        break;
      case "garbage-binary":
        res.writeHead(200, { "Content-Type": "audio/wav" });
        res.end(Buffer.from("NOT AUDIO just junk bytes!!"));
        break;
      case "big": {
        const big = Buffer.concat([wav, Buffer.alloc(3 * 1024 * 1024, 0)]);
        res.writeHead(200, { "Content-Type": "audio/wav", "Content-Length": String(big.length) });
        res.end(big);
        break;
      }
      case "three-chunks":
        // 150B ×3:前两段每段间隔 50ms,末段等测试闸门 —— 供预算限流用例精确控制
        // 「在途字节数已达预算、请求仍未完成」的时刻。
        res.writeHead(200, { "Content-Type": "audio/wav", "Content-Length": "450" });
        res.write(Buffer.alloc(150, 1));
        setTimeout(() => res.write(Buffer.alloc(150, 2)), 50);
        void twoChunkGate.then(() => res.end(Buffer.alloc(150, 3)));
        break;
      case "json-error":
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end('{"code":"200002"}');
        break;
    }
  });
  await new Promise<void>((resolve) => upServer.listen(0, "127.0.0.1", resolve));
  upPort = (upServer.address() as any).port;

  initDatabase();
  db.insert(users).values({ id: "u1", username: "alice", password: "", salt: "salt", subsonicSalt: "subsalt", passEnc: encryptPassword(PLAIN), isAdmin: 1, isActive: 1, email: "a@b.c" }).run();
  db.insert(mediaSources).values({
    id: "wsrc", name: "WD", type: "webdav", enabled: 1,
    config: JSON.stringify({ url: `http://127.0.0.1:${upPort}/`, username: "u", password: "p" }),
  }).run();
  const base = { title: "T", artist: "A", album: "AL", duration: 2, suffix: "wav", bitRate: 1411, path: "" };
  db.insert(songs).values([
    // WEBDAV 路径:正常 / 死链 / 停摆 / 响应头挂死 / 超大
    { id: "swd", ...base, type: "webdav", path: "w:wsrc:/wd-sine.wav" },
    { id: "swd404", ...base, type: "webdav", path: "w:wsrc:/wd-missing.wav" },
    { id: "swdhang", ...base, type: "webdav", path: "w:wsrc:/wd-hangmid.wav" },
    { id: "swdopen", ...base, type: "webdav", path: "w:wsrc:/wd-openhang.wav" },
    { id: "swdbig", ...base, type: "webdav", path: "w:wsrc:/wd-big.wav" },
    { id: "swd2", ...base, type: "webdav", path: "w:wsrc:/wd-sine2.wav" },
    // web 插件行路径:正常 / 瞬时错误 / 垃圾字节(ffmpeg 异常退出)
    { id: "sweb", ...base, type: "web", url: `http://127.0.0.1:${upPort}/web-sine.wav` },
    { id: "swebflaky", ...base, type: "web", url: `http://127.0.0.1:${upPort}/web-flaky.wav` },
    { id: "swebgarbage", ...base, type: "web", url: `http://127.0.0.1:${upPort}/web-garbage.wav` },
    { id: "sweb2", ...base, type: "web", url: `http://127.0.0.1:${upPort}/web-sine2.wav` },
  ]).run();

  behavior("/wd-sine.wav", "ok");
  behavior("/wd-missing.wav", "dead");
  behavior("/wd-hangmid.wav", "hang-mid");
  behavior("/wd-openhang.wav", "hang-headers");
  behavior("/wd-big.wav", "big");
  behavior("/web-sine.wav", "ok");
  behavior("/web-flaky.wav", "flaky");
  behavior("/web-garbage.wav", "garbage-binary");
  behavior("/wd-sine2.wav", "ok");
  behavior("/web-sine2.wav", "ok");

  // 真实 HTTP 服务 + 回环端口回填(membuf 回环流必须可达)。
  appServer = serve({ fetch: app.fetch, port: 0 });
  appPort = (appServer.address() as any).port;
  setRuntimePort(appPort);
});

afterAll(() => {
  try { appServer?.closeAllConnections?.(); } catch { /* ignore */ }
  try { appServer?.close(); } catch { /* ignore */ }
  try { upServer?.closeAllConnections?.(); } catch { /* ignore */ }
  try { upServer?.close(); } catch { /* ignore */ }
  try { fs.rmSync(fixtureDir, { recursive: true, force: true }); } catch { /* ignore */ }
});

// 测试把超时/重试旋钮调小,跑完即清,避免影响同文件其它用例。
const ENV_KEYS = [
  "STREAM_BUFFER_STALL_MS", "STREAM_BUFFER_TIMEOUT_MS", "STREAM_BUFFER_RETRIES",
  "STREAM_BUFFER_BACKOFF_MS", "STREAM_BUFFER_MAX_MB", "STREAM_BUFFER_BUDGET_MB",
  "STREAM_RETRY_FAST_MS", "STREAM_RETRY_SLOW_MS", "STREAM_RETRY_FAST_COUNT", "STREAM_RETRY_WINDOW_MS",
  "RAW_STALL_TIMEOUT_MS", "RAW_UPSTREAM_OPEN_TIMEOUT_MS",
];
let savedEnv: Record<string, string | undefined> = {};

afterEach(() => {
  for (const k of ENV_KEYS) {
    const v = savedEnv[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  savedEnv = {};
  resetMemStreamsForTest();
  resetRetryLoopsForTest();
});

function setEnv(k: string, v: string) {
  if (!(k in savedEnv)) savedEnv[k] = process.env[k];
  process.env[k] = v;
}

async function stream(id: string) {
  return fetch(`http://127.0.0.1:${appPort}/rest/stream?id=${id}&${authQS()}`);
}

function hasFlacMagic(buf: Buffer): boolean {
  return buf.length > 4 && buf.subarray(0, 4).toString("ascii") === "fLaC";
}

// ---------------- 路由级:WEBDAV 路径 ----------------

describe("整曲内存缓冲(/rest/stream 端到端,假上游 + 真 ffmpeg)", () => {
  it("WEBDAV 行:整曲缓冲后经内存回环供流,上游只被打一次", async () => {
    const b = behaviors.get("/wd-sine.wav")!;
    const res = await stream("swd");
    expect(res.status).toBe(200);
    const buf = Buffer.from(await res.arrayBuffer());
    expect(buf.length).toBeGreaterThan(1000);
    expect(hasFlacMagic(buf)).toBe(true);
    expect(b.hits).toBe(1); // 整曲一次取完,无逐 chunk / Range 回源
  }, 30000);

  it("web/插件行:整曲缓冲后经内存回环供流,上游只被打一次", async () => {
    const b = behaviors.get("/web-sine.wav")!;
    const res = await stream("sweb");
    expect(res.status).toBe(200);
    const buf = Buffer.from(await res.arrayBuffer());
    expect(hasFlacMagic(buf)).toBe(true);
    expect(b.hits).toBe(1);
  }, 30000);

  it("瞬时错误(500):有限重试后成功,上游被打两次", async () => {
    setEnv("STREAM_BUFFER_BACKOFF_MS", "50");
    const b = behaviors.get("/web-flaky.wav")!;
    const res = await stream("swebflaky");
    expect(res.status).toBe(200);
    const buf = Buffer.from(await res.arrayBuffer());
    expect(hasFlacMagic(buf)).toBe(true);
    expect(b.hits).toBe(2);
  }, 30000);

  it("上游明确死亡(404)→ 显式失败(No playable stream),404 不重试", async () => {
    const b = behaviors.get("/wd-missing.wav")!;
    const res = await stream("swd404");
    const text = await res.text();
    expect(text).toContain("No playable stream");
    expect(b.hits).toBe(1);
  }, 30000);

  it("上游停摆(发一段后停发)→ 缓冲失败 → 显式失败,请求按期结束(不挂僵尸响应)", async () => {
    setEnv("STREAM_BUFFER_STALL_MS", "500");
    setEnv("STREAM_BUFFER_TIMEOUT_MS", "5000");
    setEnv("STREAM_BUFFER_RETRIES", "1");
    setEnv("STREAM_BUFFER_BACKOFF_MS", "50");
    setEnv("STREAM_RETRY_WINDOW_MS", "1"); // D 长窗口在本用例压缩到即时耗尽(显式失败语义不变)
    const b = behaviors.get("/wd-hangmid.wav")!;
    const t0 = Date.now();
    const res = await stream("swdhang");
    const text = await res.text();
    const ms = Date.now() - t0;
    expect(text).toContain("No playable stream");
    expect(ms).toBeLessThan(12000);
    expect(b.hits).toBeGreaterThanOrEqual(1);
  }, 20000);

  it("上游响应头挂死 → 缓冲超时回退直通 → ffmpeg 拿不到数据退出 → 显式 failed(请求按期结束,不挂僵尸响应)", async () => {
    setEnv("STREAM_BUFFER_TIMEOUT_MS", "2000");
    setEnv("STREAM_BUFFER_RETRIES", "1");
    setEnv("STREAM_BUFFER_BACKOFF_MS", "50");
    setEnv("RAW_UPSTREAM_OPEN_TIMEOUT_MS", "500");
    setEnv("FFMPEG_FIRST_BYTE_TIMEOUT_MS", "3000");
    const res = await stream("swdopen");
    // 修复前:这条请求要么挂死要么给 0 字节干净 200。修复后:显式 Subsonic failed。
    const text = await res.text();
    expect(JSON.parse(text)["subsonic-response"].status).toBe("failed");
  }, 30000);

  it("超过单文件上限 → 回退直通仍可播(RAW_STREAM_CACHE 直通路径)", async () => {
    setEnv("STREAM_BUFFER_MAX_MB", "1");
    const b = behaviors.get("/wd-big.wav")!;
    const res = await stream("swdbig");
    expect(res.status).toBe(200);
    const buf = Buffer.from(await res.arrayBuffer());
    expect(hasFlacMagic(buf)).toBe(true);
    expect(b.hits).toBeGreaterThanOrEqual(1);
  }, 30000);

  it("ffmpeg 吃到垃圾字节零输出失败 → 显式 failed(不再发 0 字节干净 200)", async () => {
    const res = await stream("swebgarbage");
    const text = await res.text();
    expect(JSON.parse(text)["subsonic-response"].status).toBe("failed");
  }, 30000);
});

// ---------------- 单元:统一取流层语义 ----------------

describe("fetchWholeSongBuffered 单元语义", () => {
  it("并发预算限流:在途占用达预算时新请求立即回退(budget),不等待", async () => {
    behavior("/unit-two-chunks", "three-chunks");
    twoChunkGate = new Promise<void>((r) => { releaseTwoChunks = r; });
    const cfg = { budgetBytes: 300, maxFileBytes: 1000, stallMs: 5000, deadlineMs: 8000 };
    const url = `http://127.0.0.1:${upPort}/unit-two-chunks`;
    const slow = fetchWholeSongBuffered(url, {}, cfg);
    let slowOutcome: any = "pending";
    slow.then((r) => { slowOutcome = r; }, (e) => { slowOutcome = { thrown: String(e) }; });
    // 等在途字节入账达预算(150×2=300B;末段等闸门,请求保持未完成)
    let waited = 0;
    while (bufferedInFlightBytes() < 300 && waited < 3000 && slowOutcome === "pending") {
      await new Promise((r) => setTimeout(r, 20));
      waited += 20;
    }
    if (bufferedInFlightBytes() < 300) {
      releaseTwoChunks();
      throw new Error(`诊断: slowOutcome=${JSON.stringify(slowOutcome)} inFlight=${bufferedInFlightBytes()} waited=${waited}`);
    }
    const second = await fetchWholeSongBuffered(url + "-x", {}, cfg);
    expect(second.ok).toBe(false);
    if (!second.ok) {
      expect(second.kind).toBe("budget");
      expect(second.attempts).toBe(0); // 入口即拒绝,未打上游
    }
    releaseTwoChunks();
    const first = await slow;
    expect(first.ok).toBe(true);
    if (first.ok) expect(first.bytes).toBe(450);
    expect(bufferedInFlightBytes()).toBe(0);
  }, 20000);

  it("停摆看门狗:发一段后停发 → kind=stalled", async () => {
    behavior("/unit-hangmid", "hang-mid");
    const r = await fetchWholeSongBuffered(`http://127.0.0.1:${upPort}/unit-hangmid`, {}, { stallMs: 400, deadlineMs: 6000, retries: 0 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.kind).toBe("stalled");
  }, 15000);

  it("Content-Length 预检:超单文件上限 → kind=too-big,不读 body", async () => {
    behavior("/unit-big-cl", "big");
    const r = await fetchWholeSongBuffered(`http://127.0.0.1:${upPort}/unit-big-cl`, {}, { maxFileBytes: 1000 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.kind).toBe("too-big");
  }, 15000);

  it("非音频 content-type(JSON 错误体)→ kind=dead", async () => {
    behavior("/unit-json", "json-error");
    const r = await fetchWholeSongBuffered(`http://127.0.0.1:${upPort}/unit-json`, {}, {});
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.kind).toBe("dead");
  }, 15000);

  it("404 → kind=dead 且不重试", async () => {
    behavior("/unit-dead", "dead");
    const b = behaviors.get("/unit-dead")!;
    const r = await fetchWholeSongBuffered(`http://127.0.0.1:${upPort}/unit-dead`, {}, { retries: 2 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.kind).toBe("dead");
    expect(b.hits).toBe(1);
  }, 15000);
});

describe("membuf 注册表", () => {
  it("register → resolve 命中并续期;未知 token 返回 null", () => {
    const token = registerMemStream(Buffer.from("hello"), "text/plain");
    const hit = resolveMemStream(token);
    expect(hit?.buf.toString("utf8")).toBe("hello");
    expect(hit?.mime).toBe("text/plain");
    expect(resolveMemStream("no-such-token")).toBeNull();
  });
});

// ---------------- rawStreamCache 停摆看门狗 ----------------

describe("rawStreamCache 停摆看门狗(直通路径的显式终止)", () => {
  it("上游发一段后停发 → 响应体以错误收场(而非挂死/干净 EOF)", async () => {
    setEnv("RAW_STALL_TIMEOUT_MS", "500");
    behavior("/raw-hangmid", "hang-mid");
    const { proxyRawRange } = await import("../../src/services/dlna/rawStreamCache.js");
    const resp = await proxyRawRange({ url: `http://127.0.0.1:${upPort}/raw-hangmid`, headers: {}, rangeHeader: "bytes=0-" });
    expect(resp.status).toBe(200);
    const reader = (resp.body as any).getReader();
    const first = await reader.read(); // 先收到已发出的字节
    expect(first.done).toBe(false);
    await expect(reader.read()).rejects.toThrow(); // 停摆 ⇒ 错误,不是挂死/EOF
  }, 15000);
});

// ---------------- D:长窗口重试节奏(unit · fake timers,不打真上游) ----------------
// batch44(D · 用户最终拍板):新流取流失败 ⇒ 挂起请求自动重试(10s×6 → 60s → 30min)。

const RETRY_UNIT_OPTS = { retries: 0, stallMs: 600_000, deadlineMs: 600_000 } as const;

describe("D:取流失败长窗口重试(unit · fake timers)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
    resetRetryLoopsForTest();
  });

  it("节奏:前 6 次每 10s → 之后每 60s → 30 分钟窗口耗尽显式失败", async () => {
    vi.useFakeTimers();
    const times: number[] = [];
    vi.stubGlobal("fetch", vi.fn(() => { times.push(Date.now()); return Promise.reject(new TypeError("fetch failed")); }));
    const p = fetchSongWithRetryWindow("u-rhythm", "http://up/fail", {}, { ...RETRY_UNIT_OPTS, windowMs: 30 * 60_000 });
    await vi.advanceTimersByTimeAsync(31 * 60_000);
    const r = await p;
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(["error", "stalled"]).toContain(r.kind);
      expect(r.err || "").toContain("retry window exhausted");
    }
    // 36 次完整取流尝试:初始 1 + 快节奏 6(t=10..60s) + 慢节奏 29(t=120..1800s)
    expect(times.length).toBe(36);
    expect(times[1] - times[0]).toBe(10_000);
    expect(times[6] - times[5]).toBe(10_000);
    expect(times[7] - times[6]).toBe(60_000);
    expect(times[35] - times[34]).toBe(60_000);
  });

  it("窗口内恢复:第 5 次取流成功 → 立即整曲缓冲返回 ok(用户只感觉起播晚几秒)", async () => {
    vi.useFakeTimers();
    let calls = 0;
    vi.stubGlobal("fetch", vi.fn(() => {
      calls++;
      if (calls <= 4) return Promise.reject(new TypeError("fetch failed"));
      return Promise.resolve(new Response(Buffer.from("hello-mem"), {
        status: 200, headers: { "Content-Type": "audio/wav", "Content-Length": "9" },
      }));
    }));
    const p = fetchSongWithRetryWindow("u-recover", "http://up/recover", {}, { ...RETRY_UNIT_OPTS, windowMs: 120_000 });
    await vi.advanceTimersByTimeAsync(50_000);
    const r = await p;
    expect(r.ok).toBe(true);
    if (r.ok) expect(Buffer.from(r.buf).toString("utf8")).toBe("hello-mem");
    expect(calls).toBe(5);
  });

  it("single-flight:同 key 并发挂起请求共享同一重试循环(尝试次数不叠加)", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn(() => Promise.reject(new TypeError("fetch failed")));
    vi.stubGlobal("fetch", fetchMock);
    const p1 = fetchSongWithRetryWindow("u-sf", "http://up/sf", {}, { ...RETRY_UNIT_OPTS, windowMs: 60_000 });
    await vi.advanceTimersByTimeAsync(10_000); // p1 已完成第 1 次尝试并进入等待
    const p2 = fetchSongWithRetryWindow("u-sf", "http://up/sf", {}, { ...RETRY_UNIT_OPTS, windowMs: 60_000 });
    expect(fetchMock).toHaveBeenCalledTimes(2); // p2 加入瞬间未触发新尝试
    await vi.advanceTimersByTimeAsync(70_000);
    const [r1, r2] = await Promise.all([p1, p2]);
    expect(r1.ok).toBe(false);
    expect(r2.ok).toBe(false);
    // 60s 窗口 ⇒ 尝试 t=0,10,...,60 共 7 次;若各自为政会是 14 次
    expect(fetchMock).toHaveBeenCalledTimes(7);
    expect((r1 as any).err).toBe((r2 as any).err);
  });

  it("dead 不进窗口:404 立即显式失败(明确死链不给用户白等)", async () => {
    const fetchMock = vi.fn(() => Promise.resolve(new Response(null, { status: 404 })));
    vi.stubGlobal("fetch", fetchMock);
    const r = await fetchSongWithRetryWindow("u-dead", "http://up/dead", {}, { retries: 2 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.kind).toBe("dead");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("too-big 不进窗口:立即返回回退直通类结果", async () => {
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(new Response(Buffer.alloc(100), {
      status: 200, headers: { "Content-Type": "audio/wav", "Content-Length": "100000" },
    }))));
    const r = await fetchSongWithRetryWindow("u-big", "http://up/big", {}, { maxFileBytes: 1000 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.kind).toBe("too-big");
  });
});

// ---------------- C1/C2/C4:缓冲完成后上游死亡 ----------------
// 用「stub 全局 fetch」模拟上游存活/死亡,不真关 upServer —— vitest 全局配了
// sequence.shuffle,文件内用例顺序随机,真关 server 会连累其它用例。顺序无关。

describe("C1/C2/C4:缓冲完成后上游死亡 → 内存供流完整;下一首新请求走重试窗口", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    resetRetryLoopsForTest();
  });

  it("C1+C4:上游死后,WEBDAV 内存直供与转码(format=mp3)内存供流均完整结束,响应不终止", async () => {
    const realFetch = globalThis.fetch;
    const serveWav = () => new Response(wav, {
      status: 200, headers: { "Content-Type": "audio/wav", "Content-Length": String(wav.length) },
    });
    let hits = 0;
    let dead = false;
    // 只拦「上游」请求;打到本测试 app 回环(appPort)的请求放行给真实 fetch。
    vi.stubGlobal("fetch", vi.fn((input: any, init?: any) => {
      const url = typeof input === "string" ? input : String(input?.url || "");
      if (!url.includes(`127.0.0.1:${upPort}`)) return realFetch(input as any, init);
      if (dead) return Promise.reject(new TypeError("fetch failed"));
      hits++;
      return Promise.resolve(serveWav());
    }));
    const plain = await stream("swd"); // 缓冲(1 hit)→ membuf → ffmpeg → 200
    expect(plain.status).toBe(200);
    const trans = await fetch(`http://127.0.0.1:${appPort}/rest/stream?id=sweb&format=mp3&${authQS()}`); // 转码路径同样先整曲缓冲
    expect(trans.status).toBe(200);
    const hitsAtBuffered = hits;
    expect(hitsAtBuffered).toBe(2); // 每首歌整曲恰好取一次
    dead = true; // 上游死亡(断网等价注入)
    const wavBuf = Buffer.from(await plain.arrayBuffer());
    expect(hasFlacMagic(wavBuf)).toBe(true); // C1:从内存无缝播完整首,响应不终止
    const mp3 = Buffer.from(await trans.arrayBuffer());
    expect(mp3.length).toBeGreaterThan(1000); // C4:转码从内存供流,完整结束
    expect(hasFlacMagic(mp3)).toBe(false);
    expect(hits).toBe(hitsAtBuffered); // 上游死亡后零次再触
  }, 30000);

  it("C2(WEBDAV 行):下一首新流请求 → 长窗口挂起重试 → 窗口耗尽 → 显式失败", async () => {
    setEnv("STREAM_RETRY_WINDOW_MS", "600");
    setEnv("STREAM_RETRY_FAST_MS", "50");
    setEnv("STREAM_BUFFER_RETRIES", "0");
    setEnv("STREAM_BUFFER_BACKOFF_MS", "10");
    const realFetch = globalThis.fetch;
    // 只拦「上游」请求(模拟断网);对 app 回环的请求放行给真实 fetch。
    const fetchMock = vi.fn((input: any, init?: any) => {
      const url = typeof input === "string" ? input : String(input?.url || "");
      if (!url.includes(`127.0.0.1:${upPort}`)) return realFetch(input as any, init);
      return Promise.reject(new TypeError("fetch failed"));
    });
    vi.stubGlobal("fetch", fetchMock);
    const t0 = Date.now();
    const res = await stream("swd2");
    const text = await res.text();
    const ms = Date.now() - t0;
    expect(text).toContain("No playable stream"); // 显式失败,绝不发僵尸 200
    expect(ms).toBeGreaterThanOrEqual(500); // 确实经历了窗口内挂起重试
    expect(fetchMock.mock.calls.length).toBeGreaterThanOrEqual(4); // 窗口内多次完整取流尝试
  }, 30000);

  it("C2(web 插件行):窗口耗尽 → 显式失败(两源路径同语义)", async () => {
    setEnv("STREAM_RETRY_WINDOW_MS", "600");
    setEnv("STREAM_RETRY_FAST_MS", "50");
    setEnv("STREAM_BUFFER_RETRIES", "0");
    setEnv("STREAM_BUFFER_BACKOFF_MS", "10");
    const realFetch = globalThis.fetch;
    const fetchMock = vi.fn((input: any, init?: any) => {
      const url = typeof input === "string" ? input : String(input?.url || "");
      if (!url.includes(`127.0.0.1:${upPort}`)) return realFetch(input as any, init);
      return Promise.reject(new TypeError("fetch failed"));
    });
    vi.stubGlobal("fetch", fetchMock);
    const res = await stream("sweb2");
    const text = await res.text();
    expect(text).toContain("No playable stream");
    expect(fetchMock.mock.calls.length).toBeGreaterThanOrEqual(4);
  }, 30000);
});
