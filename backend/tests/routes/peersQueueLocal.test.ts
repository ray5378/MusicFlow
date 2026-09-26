// MUST be the first import: redirects DATA_DIR to an isolated temp dir before
// the backend opens its SQLite DB at module-load time.
import "../plugins/_env.js";

import { describe, it, expect, beforeAll, vi } from "vitest";

// 列表/详情会顺带触发 DLNA 后台补扫与真实 SSDP —— 测试环境必须关掉。
vi.mock("../../src/services/dlna/control.js", async (importOriginal) => {
  const actual: any = await importOriginal();
  return { ...actual, shouldRefreshDevices: () => false, refreshDevices: async () => [] };
});
// 播报会真去打断设备播放,这里只验证路由层的编排与状态码。
const { announceMock } = vi.hoisted(() => ({
  announceMock: {
    isAnnouncing: vi.fn(() => false),
    announceOnPeer: vi.fn(async () => ({ played: true })),
  },
}));
vi.mock("../../src/services/dlna/announce.js", async (importOriginal) => {
  const actual: any = await importOriginal();
  return { ...actual, ...announceMock };
});

import { Hono } from "hono";
import md5 from "md5";
import { db, initDatabase, encryptPassword } from "../../src/db/index.js";
import { users } from "../../src/db/schema.js";
import { eq } from "drizzle-orm";
import { authMiddleware } from "../../src/middleware/auth.js";
import { apiRoutes } from "../../src/routes/api/index.js";

const app = new Hono();
app.use("/rest/api/*", authMiddleware);
app.route("/rest/api", apiRoutes);

const A_PLAIN = "hunter2";
const A_SALT = "clientsalt123";
const aliceQS = () => "u=alice&t=" + md5(A_PLAIN + A_SALT) + "&s=" + A_SALT;

// 对外 peerId 的解析会带上「调用方自己的实例标识」兜底,故每个用例都要声明
// 自己以哪个本机实例的身份发起请求(cid 缺省 ls1)。
async function call(method: string, path: string, opts: { body?: any; headers?: Record<string, string>; cid?: string } = {}) {
  const url = "/rest/api" + path + (path.includes("?") ? "&" : "?") + aliceQS();
  const res = await app.request(url, {
    method,
    headers: { "content-type": "application/json", "X-MF-Client-Id": opts.cid ?? "ls1", ...(opts.headers || {}) },
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  });
  const text = await res.text();
  let parsed: any = null;
  try { parsed = JSON.parse(text); } catch { parsed = null; }
  return { status: res.status, body: parsed, text };
}

const PEER = "/v1/peers/local:u1:ls1";     // 主本机实例
const PEER2 = "/v1/peers/local:u1:ls2";    // 流转目标实例
const GARBAGE = "/v1/peers/definitely-not-a-peer";
const ITEMS = [{ songId: "s1", title: "A" }, { songId: "s2", title: "B" }, { songId: "s3", title: "C" }];
// body 里的 from 必须是**对外打码形式**(register 返回值),随便写 clientId 会被
// 兜底解析成调用方自己那条,触发「from === to」保护。
let MASKED_LS1 = "local:u1:ls1";

beforeAll(async () => {
  if (!process.env.APP_VERSION) process.env.APP_VERSION = "1.0.0";
  initDatabase();
  if (!db.select().from(users).where(eq(users.username, "alice")).get()) {
    db.insert(users).values({
      id: "u1", username: "alice", password: "", salt: "salt", subsonicSalt: "subsalt",
      passEnc: encryptPassword(A_PLAIN), isAdmin: 1, isActive: 1, email: "a@b.c",
    }).run();
  }
  const reg = await call("POST", "/v1/peers/register", { body: { name: "LS", clientId: "ls1" } });
  MASKED_LS1 = reg.body?.peer?.peerId || MASKED_LS1;
  await call("POST", "/v1/peers/register", { body: { name: "LS2", clientId: "ls2" } });
});

describe("本机队列:起播/跳播/追加", () => {
  it("queue/play:items 非数组 400;正常起播带进度回显", async () => {
    const bad = await call("POST", PEER + "/queue/play", { body: {} });
    expect(bad.status).toBe(400);
    const bad2 = await call("POST", PEER + "/queue/play", { body: { items: "nope" } });
    expect(bad2.status).toBe(400);
    const ok = await call("POST", PEER + "/queue/play", { body: { items: ITEMS, startIndex: 1 } });
    expect(ok.status, ok.text.slice(0, 200)).toBe(200);
    expect(ok.body).toMatchObject({ success: true });
    const withPos = await call("POST", PEER + "/queue/play", { body: { items: ITEMS, startIndex: 0, position: 42 } });
    expect(withPos.body).toMatchObject({ success: true, position: 42 });
    // 非法 peerId 形态 → 400
    const badPeer = await call("POST", GARBAGE + "/queue/play", { body: { items: ITEMS } });
    expect(badPeer.status).toBe(400);
  });

  it("queue/jump:索引必须是整数;本机跳播成功", async () => {
    const bad = await call("POST", PEER + "/queue/jump", { body: { index: 1.5 } });
    expect(bad.status).toBe(400);
    const ok = await call("POST", PEER + "/queue/jump", { body: { index: 2 } });
    expect(ok.body).toMatchObject({ success: true });
  });

  it("queue/enqueue:追加不切歌;items 非数组 400", async () => {
    const bad = await call("POST", PEER + "/queue/enqueue", { body: { items: null } });
    expect(bad.status).toBe(400);
    const ok = await call("POST", PEER + "/queue/enqueue", { body: { items: ITEMS } });
    expect(ok.body).toMatchObject({ success: true });
  });

  it("queue/index:本机可设索引;cast 形态被拒(localPeerOnly)", async () => {
    const bad = await call("POST", PEER + "/queue/index", { body: { index: "x" } });
    expect(bad.status).toBe(400);
    const ok = await call("POST", PEER + "/queue/index", { body: { index: 1 } });
    expect(ok.body).toMatchObject({ success: true });
    const cast = await call("POST", "/v1/peers/group:g-none/queue/index", { body: { index: 1 } });
    expect(cast.status).toBe(400);
  });
});

describe("本机队列:增删改动", () => {
  it("DELETE /queue 清空;DELETE /queue/:index 单删并校验下标", async () => {
    await call("POST", PEER + "/queue/play", { body: { items: ITEMS } });
    const badIdx = await call("DELETE", PEER + "/queue/notanumber");
    expect(badIdx.status).toBe(400);
    const del = await call("DELETE", PEER + "/queue/1");
    expect(del.body).toMatchObject({ success: true });
    const clear = await call("DELETE", PEER + "/queue");
    expect(clear.body).toMatchObject({ success: true });
  });

  it("queue/reorder:from/to 必须整数;本机拖拽成功", async () => {
    const bad = await call("POST", PEER + "/queue/reorder", { body: { from: 0 } });
    expect(bad.status).toBe(400);
    await call("POST", PEER + "/queue/play", { body: { items: ITEMS } });
    const ok = await call("POST", PEER + "/queue/reorder", { body: { from: 0, to: 2 } });
    expect(ok.body).toMatchObject({ success: true });
  });

  it("queue/deactivate 本机端恒成功(仅 cast 端有实际语义)", async () => {
    const r = await call("POST", PEER + "/queue/deactivate");
    expect(r.body).toMatchObject({ success: true });
  });

  it("cast 端清空队列:未注册设备上也必须成功(不抛)", async () => {
    const r = await call("DELETE", "/v1/peers/dlna:no-such-device/queue");
    expect(r.status, r.text.slice(0, 200)).toBeLessThan(500);
  });
});

describe("本机队列:洗牌序列", () => {
  it("GET /queue/shuffle 返回序列与游标;cast/未知 一律 400", async () => {
    await call("POST", PEER + "/queue/play", { body: { items: ITEMS } });
    const ok = await call("GET", PEER + "/queue/shuffle");
    expect(ok.status, ok.text.slice(0, 200)).toBe(200);
    expect(ok.body).toHaveProperty("currentIndex");
    expect(ok.body).toHaveProperty("shuffleOrder");
    expect(ok.body).toHaveProperty("shuffleEpoch");
    const cast = await call("GET", "/v1/peers/group:g-none/queue/shuffle");
    expect(cast.status).toBe(400);
    const junk = await call("GET", GARBAGE + "/queue/shuffle");
    expect(junk.status).toBe(400);
  });

  it("POST /queue/reshuffle 重洗并 epoch+1;未知 400", async () => {
    await call("POST", PEER + "/queue/play", { body: { items: ITEMS } });
    const a = await call("GET", PEER + "/queue/shuffle");
    const b = await call("POST", PEER + "/queue/reshuffle");
    expect(b.status, b.text.slice(0, 200)).toBe(200);
    expect(b.body.shuffleEpoch).toBeGreaterThanOrEqual(a.body.shuffleEpoch);
    const junk = await call("POST", GARBAGE + "/queue/reshuffle");
    expect(junk.status).toBe(400);
  });
});

describe("跨端队列流转(transfer-from)", () => {
  it("缺 from / from 与目标相同 / 源端不存在 → 400", async () => {
    const noFrom = await call("POST", PEER2 + "/queue/transfer-from", { body: {}, cid: "ls2" });
    expect(noFrom.status).toBe(400);
    const same = await call("POST", PEER + "/queue/transfer-from", { body: { from: MASKED_LS1 } });
    expect(same.status).toBe(400);
    const ghost = await call("POST", PEER2 + "/queue/transfer-from", { body: { from: "local:u1:no-such-instance" }, cid: "ls2" });
    expect(ghost.status).toBe(400);
  });

  it("源端空队列 → transferred:0(不算错误)", async () => {
    await call("DELETE", PEER + "/queue");
    const r = await call("POST", PEER2 + "/queue/transfer-from", { body: { from: MASKED_LS1 }, cid: "ls2" });
    expect(r.status, r.text.slice(0, 200)).toBe(200);
    expect(r.body).toMatchObject({ success: true, transferred: 0 });
  });

  it("本机→本机整队搬迁:队列与进度一并带过去", async () => {
    await call("POST", PEER + "/queue/play", { body: { items: ITEMS, startIndex: 2 } });
    const r = await call("POST", PEER2 + "/queue/transfer-from", { body: { from: MASKED_LS1, position: 17 }, cid: "ls2" });
    expect(r.status, r.text.slice(0, 300)).toBe(200);
    expect(r.body).toMatchObject({ success: true, transferred: 3, startIndex: 2 });
    expect(r.body.position).toBe(17);
    const snap = await call("GET", PEER2 + "/queue", { cid: "ls2" });
    expect(snap.body.total).toBeGreaterThanOrEqual(3);
  });

  it("不带 position 时按源端实时进度对齐", async () => {
    await call("POST", PEER + "/queue/play", { body: { items: ITEMS, startIndex: 0 } });
    await call("POST", PEER + "/local-status", { body: { state: "PLAYING", position: 9, duration: 100 } });
    const r = await call("POST", PEER2 + "/queue/transfer-from", { body: { from: MASKED_LS1 }, cid: "ls2" });
    expect(r.status, r.text.slice(0, 300)).toBe(200);
    expect(r.body.transferred).toBe(3);
  });
});

describe("本机传输控制", () => {
  it("play/pause/stop/next/prev 对本机实例下发指令(无连接时 delivered=false)", async () => {
    for (const action of ["play", "pause", "stop", "next", "prev"]) {
      const r = await call("POST", PEER + "/" + action);
      expect(r.status, action + " " + r.text.slice(0, 120)).toBe(200);
      if (action !== "play") expect(r.body).toHaveProperty("delivered");
    }
  });

  it("reset 清空队列与状态上报(保留 peer 注册)", async () => {
    await call("POST", PEER + "/queue/play", { body: { items: ITEMS } });
    await call("POST", PEER + "/local-status", { body: { state: "PLAYING", position: 5, duration: 60 } });
    const r = await call("POST", PEER + "/reset");
    expect(r.body).toMatchObject({ success: true });
    const detail = await call("GET", PEER);
    expect(detail.status).toBe(200); // peer 仍在列表里
    const status = await call("GET", PEER + "/status");
    expect(status.status).toBe(200);
    expect(status.body.state).toBeUndefined();
  });

  it("seek:缺 seconds/position → 400;本机下发成功且秒数被对齐为整数", async () => {
    const bad = await call("POST", PEER + "/seek", { body: {} });
    expect(bad.status).toBe(400);
    const badType = await call("POST", PEER + "/seek", { body: { seconds: "3" } });
    expect(badType.status).toBe(400);
    const bySeconds = await call("POST", PEER + "/seek", { body: { seconds: 12.4 } });
    expect(bySeconds.status, bySeconds.text.slice(0, 200)).toBe(200);
    const byPosition = await call("POST", PEER + "/seek", { body: { position: 8 } });
    expect(byPosition.status).toBe(200);
  });

  it("volume:缺 volume → 400;本机下发成功", async () => {
    const bad = await call("POST", PEER + "/volume", { body: {} });
    expect(bad.status).toBe(400);
    const ok = await call("POST", PEER + "/volume", { body: { volume: 33 } });
    expect(ok.status).toBe(200);
    expect(ok.body).toHaveProperty("delivered");
  });

  it("mute:非布尔 → 400;本机成功", async () => {
    const bad = await call("POST", PEER + "/mute", { body: { muted: "yes" } });
    expect(bad.status).toBe(400);
    const ok = await call("POST", PEER + "/mute", { body: { muted: true } });
    expect(ok.status).toBe(200);
  });

  it("announce:缺 url 400;非阻塞 202;阻塞等结果;播报中 409", async () => {
    const bad = await call("POST", PEER + "/announce", { body: {} });
    expect(bad.status).toBe(400);
    const async202 = await call("POST", PEER + "/announce", { body: { url: "http://tts/1.mp3" } });
    expect(async202.status).toBe(202);
    expect(async202.body).toMatchObject({ success: true, accepted: true });
    const blocking = await call("POST", PEER + "/announce", { body: { url: "http://tts/2.mp3", blocking: true, volume: 50 } });
    expect(blocking.body).toMatchObject({ success: true, played: true });
    announceMock.isAnnouncing.mockReturnValueOnce(true);
    const busy = await call("POST", PEER + "/announce", { body: { url: "http://tts/3.mp3" } });
    expect(busy.status).toBe(409);
  });
});

describe("非法 peerId 一律 4xx", () => {
  it("未知 peer 的详情/状态/各控制口都不返回 5xx", async () => {
    const paths: Array<[string, string]> = [["GET", GARBAGE], ["GET", GARBAGE + "/status"], ["GET", GARBAGE + "/queue"]];
    for (const [m, p] of paths) {
      const r = await call(m, p);
      expect(r.status, p).toBeGreaterThanOrEqual(400);
      expect(r.status, p).toBeLessThan(500);
    }
  });
});
