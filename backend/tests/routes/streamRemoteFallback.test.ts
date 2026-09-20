// Route tests for /rest/stream-remote（搜索即播 · 未入库远程歌）。
//
// 两类行为一起锁：
//   ① 多源换源（原平台 404/VIP → 严格「歌名-歌手」换到其它平台候选；无一致候选则
//      维持失败，不误绑同名异曲；Live 等后缀要严格对齐）。
//   ② P2-7：出流改走**服务端实时管道**（D9，无直出旁路）—— 换源因此从「代理那次
//      fetch」前移成出流前的一次轻量裁决（`resolveRemoteStreamUrl`），否则 URL 交给
//      ffmpeg 子进程后主进程再无换源机会。
//
// ⚠️ 上游必须是**真 HTTP 服务**，不能再用 `vi.stubGlobal("fetch")`：P2-7 之后上游
// 字节是交给 ffmpeg 子进程去取的，stub 只拦得住本进程的 fetch（ffmpeg 看不到）。
// MUST be the first import: redirects DATA_DIR to an isolated temp dir.
import "../plugins/_env.js";

import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import { Hono } from "hono";
import { getRequestListener } from "@hono/node-server";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { spawnSync } from "node:child_process";
import { initDatabase, db, sqlite } from "../../src/db/index.js";
import { users } from "../../src/db/schema.js";
import { eq } from "drizzle-orm";
import { registerPlugin, unregisterPlugin } from "../../src/plugins/registry.js";
import { restRoutes } from "../../src/routes/rest/index.js";
import { authMiddleware } from "../../src/middleware/auth.js";
import { generateToken } from "../../src/utils/auth.js";
import { setRuntimePort } from "../../src/services/dlna/control.js";
import { clearStreamFallbackCache } from "../../src/services/source/online/streamFallback.js";
import { resolveFfmpeg } from "../../src/services/transcode.js";

// 带鉴权的 app 用于客户端请求；回环 token 是 ffmpeg 匿名来取的，另起一个不带鉴权的
// app 做真实监听（与生产里 DLNA 路由不带鉴权一致）。
const app = new Hono();
app.use("/rest/*", authMiddleware);
app.route("/rest", restRoutes);

const anonApp = new Hono();
anonApp.route("/rest", restRoutes);

const PROVIDER = "remote-fb-routes";

const manifestOf = {
  id: PROVIDER,
  name: PROVIDER,
  version: "1.0.0",
  type: "source",
  capabilities: ["search", "stream"],
  platforms: ["qq", "kuwo", "netease"],
  configSchema: [],
  permissions: ["net"],
  sourcePreference: ["kuwo", "netease", "qq"],
} as const;

// 上游服务：原平台 id(dead*) 一律 404（版权失效 / 拿不到地址），候选恒返回真实
// mp3 字节（管道要真解码，假字节会让 ffmpeg 直接失败）。
const upstreamHits: string[] = [];
let upstreamServer: http.Server;
let upstreamPort = 0;
let mp3Body: Buffer;

const streamUrl = (_config: any, s: any) =>
  `http://127.0.0.1:${upstreamPort}/download?id=${s.id}&source=${s.source}&name=${encodeURIComponent(s.name)}`;

function enableProvider(cands: any[]) {
  const provider = {
    id: PROVIDER,
    manifest: manifestOf,
    streamUrl,
    search: async (_config: any, params: any) => ({ songs: cands }),
  };
  registerPlugin(manifestOf as any, provider);
  sqlite.prepare(`
    INSERT INTO plugins (id, name, version, description, manifest, enabled, config, created_at, updated_at)
    VALUES (?, ?, '1.0.0', '', ?, 1, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET enabled = 1, config = excluded.config, manifest = excluded.manifest
  `).run(PROVIDER, PROVIDER, JSON.stringify(manifestOf), JSON.stringify({}), new Date().toISOString(), new Date().toISOString());
}

function remoteUrl(rid: string, title: string, artist: string) {
  return `/rest/stream-remote?provider=${PROVIDER}&source=qq&id=${rid}&title=${encodeURIComponent(title)}&artist=${encodeURIComponent(artist)}`;
}

const fixtureDir = path.join(os.tmpdir(), `mf-remote-stream-${process.pid}`);
let appServer: http.Server;
let authHeaders: Record<string, string> = {};

beforeAll(async () => {
  initDatabase();
  if (!process.env.APP_VERSION) process.env.APP_VERSION = "1.0.0";
  if (!db.select().from(users).where(eq(users.username, "stream-fb-user")).get()) {
    db.insert(users).values({
      id: "stream-fb-user",
      username: "stream-fb-user",
      password: "",
      salt: "salt",
      subsonicSalt: "subsalt",
      isAdmin: 0,
      isActive: 1,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }).run();
  }
  authHeaders = { Authorization: `Bearer ${generateToken("stream-fb-user", "stream-fb-user", false)}` };

  // 真 mp3 fixture（管道按 mp3 320 出流 → 断言响应头与字节都拿得到解码产物）。
  fs.mkdirSync(fixtureDir, { recursive: true });
  const mp3Path = path.join(fixtureDir, "sine.mp3");
  const r = spawnSync(resolveFfmpeg(), [
    "-hide_banner", "-loglevel", "error", "-y",
    "-f", "lavfi", "-i", "sine=frequency=440:duration=2:sample_rate=44100",
    "-ac", "2", "-c:a", "libmp3lame", "-b:a", "192k", mp3Path,
  ], { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`fixture 生成失败: ${r.stderr?.slice(0, 400)}`);
  mp3Body = fs.readFileSync(mp3Path);

  upstreamServer = http.createServer((req, res) => {
    const url = req.url || "";
    upstreamHits.push(url);
    if (url.includes("id=dead")) {
      res.writeHead(404, { "content-type": "text/plain" });
      res.end("Failed to get URL");
      return;
    }
    res.writeHead(200, { "content-type": "audio/mpeg", "content-length": String(mp3Body.length) });
    res.end(mp3Body);
  });
  await new Promise<void>((resolve) => upstreamServer.listen(0, "127.0.0.1", () => resolve()));
  upstreamPort = (upstreamServer.address() as AddressInfo).port;

  // 回环 socket：ffmpeg 按 runtimePort 回拉 raw token（SPEC §1.8）。
  appServer = http.createServer(getRequestListener(anonApp.fetch));
  await new Promise<void>((resolve) => appServer.listen(0, "127.0.0.1", () => resolve()));
  setRuntimePort((appServer.address() as AddressInfo).port);
});

afterEach(() => {
  clearStreamFallbackCache();
  upstreamHits.length = 0;
  sqlite.prepare("DELETE FROM plugins WHERE id = ?").run(PROVIDER);
  unregisterPlugin(PROVIDER);
});

afterAll(async () => {
  await new Promise<void>((resolve) => appServer.close(() => resolve()));
  await new Promise<void>((resolve) => upstreamServer.close(() => resolve()));
  fs.rmSync(fixtureDir, { recursive: true, force: true });
});

describe("/rest/stream-remote 多源换源 + 管道出流（P2-7）", () => {
  it("原链可播 → 直接走管道（X 头在、无 Content-Length、不再原样代理字节）", async () => {
    enableProvider([]);
    const res = await app.request(remoteUrl("ok1", "听妈妈的话", "周杰伦"), { method: "GET", headers: authHeaders });

    expect(res.status).toBe(200);
    expect(res.headers.get("x-musicflow-transcoded")).toBe("1");
    expect(res.headers.get("content-type")?.split(";")[0]).toBe("audio/mpeg");
    // 实时管道流没有字节总量：直出时代上游 Content-Length 一定在。
    expect(res.headers.get("content-length")).toBeNull();
    expect(res.headers.get("accept-ranges")).toBeNull();
    const buf = Buffer.from(await res.arrayBuffer());
    expect(buf.length).toBeGreaterThan(0);
  }, 30000);

  it("原平台 404 → 严格「歌名-歌手」换源到 kuwo 候选并仍走管道", async () => {
    enableProvider([
      { id: "alt1", source: "kuwo", name: "听妈妈的话", artist: "周杰伦", album: "", duration: 0, cover: "" },
      { id: "alt2", source: "netease", name: "听妈妈的话", artist: "别人", album: "", duration: 0, cover: "" },
    ]);
    const res = await app.request(remoteUrl("dead123", "听妈妈的话", "周杰伦"), { method: "GET", headers: authHeaders });

    expect(res.status).toBe(200);
    expect(res.headers.get("x-musicflow-transcoded")).toBe("1");
    expect(res.headers.get("content-type")?.split(";")[0]).toBe("audio/mpeg");
    // 换源候选确被拉取(alt1,而非歌名撞车的 alt2)
    expect(upstreamHits.some((u) => u.includes("id=alt1"))).toBe(true);
    expect(upstreamHits.some((u) => u.includes("id=alt2"))).toBe(false);
    const buf = Buffer.from(await res.arrayBuffer());
    expect(buf.length).toBeGreaterThan(0);
  }, 30000);

  it("无歌手一致的候选 → 维持 404（不加多源搜索误绑同名异曲）", async () => {
    enableProvider([
      { id: "alt2", source: "netease", name: "听妈妈的话", artist: "别人", album: "", duration: 0, cover: "" },
    ]);
    const res = await app.request(remoteUrl("dead456", "听妈妈的话", "周杰伦"), { method: "GET", headers: authHeaders });

    expect(res.status).toBe(404);
    // 未触发对歌名撞车候选的流式拉取
    expect(upstreamHits.some((u) => u.includes("id=alt2"))).toBe(false);
  }, 30000);

  it("期望无后缀 + 只搜到带(Live)后缀候选 → 维持 404（有后缀只能配带相同后缀）", async () => {
    enableProvider([
      { id: "alt3", source: "kuwo", name: "听妈妈的话(Live)", artist: "周杰伦", album: "", duration: 0, cover: "" },
    ]);
    const res = await app.request(remoteUrl("dead789", "听妈妈的话", "周杰伦"), { method: "GET", headers: authHeaders });

    expect(res.status).toBe(404);
    expect(upstreamHits.some((u) => u.includes("id=alt3"))).toBe(false);
  }, 30000);

  it("期望带(Live) + 候选带相同后缀(大小写/空格差异) → 换源成功", async () => {
    enableProvider([
      { id: "alt4", source: "kuwo", name: "听妈妈的话 (LIVE)", artist: "周杰伦", album: "", duration: 0, cover: "" },
    ]);
    const res = await app.request(remoteUrl("dead1011", "听妈妈的话(Live)", "周杰伦"), { method: "GET", headers: authHeaders });

    expect(res.status).toBe(200);
    expect(upstreamHits.some((u) => u.includes("id=alt4"))).toBe(true);
  }, 30000);
});
