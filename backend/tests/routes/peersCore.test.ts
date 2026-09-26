// MUST be the first import: redirects DATA_DIR to an isolated temp dir before
// the backend opens its SQLite DB at module-load time.
import "../plugins/_env.js";

import { describe, it, expect, beforeAll, vi } from "vitest";

// 拉列表会顺带触发一次 DLNA 后台补扫 —— 测试环境必须关掉,否则打真实 SSDP。
vi.mock("../../src/services/dlna/control.js", async (importOriginal) => {
  const actual: any = await importOriginal();
  return { ...actual, shouldRefreshDevices: () => false, refreshDevices: async () => [] };
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
const B_PLAIN = "bobpass";
const B_SALT = "bobsalt456";
const bobQS = () => "u=bob&t=" + md5(B_PLAIN + B_SALT) + "&s=" + B_SALT;

function ensureUser(id: string, username: string, isAdmin: number, passEnc: string) {
  if (!db.select().from(users).where(eq(users.username, username)).get()) {
    db.insert(users)
      .values({
        id,
        username,
        password: "",
        salt: "salt",
        subsonicSalt: "subsalt",
        passEnc,
        isAdmin,
        isActive: 1,
        email: username + "@b.c",
      })
      .run();
  }
}

beforeAll(async () => {
  if (!process.env.APP_VERSION) process.env.APP_VERSION = "1.0.0";
  initDatabase();
  ensureUser("u1", "alice", 1, encryptPassword(A_PLAIN));
  ensureUser("u2", "bob", 0, encryptPassword(B_PLAIN));
  // 预注册两个本机实例,后续详情/队列用例直接用它们的对外 peerId
  await call("POST", "/v1/peers/register", { body: { name: "LS", clientId: "ls1" } });
  await call("POST", "/v1/peers/register", { body: { name: "BobWeb", clientId: "c-bob" }, as: "bob" });
});

type Opts = { body?: any; headers?: Record<string, string>; as?: "alice" | "bob" };

async function call(method: string, path: string, opts: Opts = {}) {
  const qs = opts.as === "bob" ? bobQS() : aliceQS();
  // path 自带 ? 时必须用 & 接鉴权串,否则鉴权参数被当成 path 的一部分 → 401
  const url = "/rest/api" + path + (path.includes("?") ? "&" : "?") + qs;
  const res = await app.request(url, {
    method,
    headers: { "content-type": "application/json", ...(opts.headers || {}) },
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  });
  const text = await res.text();
  let parsed: any = null;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = null;
  }
  return { status: res.status, body: parsed, text };
}

// 对外 peerId 需带实例段:local:<userId>:<clientId>
const PEER = "/v1/peers/local:u1:ls1";
const GHOST = "/v1/peers/local:u1:ghost";
// local-status 是纯内存暂存:任何能解析成 local 的 peerId 都收(不要求已注册)。
// 400 只在 peerId 不是 local 形态时出现 —— 用 dlna peer 覆盖该分支。
const NOT_LOCAL = "/v1/peers/dlna:not-a-local";
const PEER_BOB = "/v1/peers/local:u2:c-bob";

// ==================== 列表 ====================
describe("播放器列表", () => {
  it("GET /v1/peers → 200 且 peers 为数组", async () => {
    const r = await call("GET", "/v1/peers");
    expect(r.status, r.text.slice(0, 200)).toBe(200);
    expect(Array.isArray(r.body?.peers)).toBe(true);
  });

  it("?includeHidden=1 不改变返回结构(管理页视角)", async () => {
    const r = await call("GET", "/v1/peers?includeHidden=1");
    expect(r.status).toBe(200);
    expect(Array.isArray(r.body?.peers)).toBe(true);
  });
});

// ==================== 注册 ====================
describe("本机播放器注册", () => {
  it("带 name 注册 → peerId 打码为 local:<userId>,self=true", async () => {
    const r = await call("POST", "/v1/peers/register", { body: { name: "Web 播放器", clientId: "c-web" } });
    expect(r.status, r.text.slice(0, 200)).toBe(200);
    const p = r.body?.peer;
    expect(p).toBeTruthy();
    expect(String(p.peerId)).toMatch(/^local:/);
    expect(p.self).toBe(true);
  });

  it("不带 name → 回落为用户名", async () => {
    const r = await call("POST", "/v1/peers/register", { body: { clientId: "c-default" } });
    expect(r.status).toBe(200);
    const name = r.body?.peer?.name ?? r.body?.peer?.label;
    expect(typeof name === "string").toBe(true);
    expect(name.length).toBeGreaterThan(0);
  });

  it("同一 clientId 重复注册 → 幂等(同一 peerId)", async () => {
    const a = await call("POST", "/v1/peers/register", { body: { name: "A", clientId: "c-idem" } });
    const b = await call("POST", "/v1/peers/register", { body: { name: "B", clientId: "c-idem" } });
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(a.body?.peer?.peerId).toBe(b.body?.peer?.peerId);
  });

  it("platform / model 超长被 sanitize 截断(32 / 64)", async () => {
    const r = await call("POST", "/v1/peers/register", {
      body: { name: "X", clientId: "c-long", platform: "P".repeat(200), model: "M".repeat(200) },
    });
    expect(r.status).toBe(200);
    const p = r.body?.peer ?? {};
    if (typeof p.platform === "string") expect(p.platform.length).toBeLessThanOrEqual(32);
    if (typeof p.model === "string") expect(p.model.length).toBeLessThanOrEqual(64);
  });
});

// ==================== 心跳 / 离线 / 状态上报 ====================
describe("心跳与本机状态", () => {
  it("heartbeat:带 clientId 的实例 → success=true", async () => {
    await call("POST", "/v1/peers/register", { body: { name: "HB", clientId: "hb1" } });
    const r = await call("POST", PEER + "/heartbeat", { headers: { "X-MF-Client-Id": "hb1" } });
    expect(r.status, r.text.slice(0, 200)).toBe(200);
    expect(r.body?.success).toBe(true);
  });

  // characterization: heartbeat 对未知 clientId 会 revive(自动重建该本机 peer 行),
  // 所以返回 success=true —— 断线重连依赖这条路径,不是 404/500。
  it("heartbeat:未知实例被 revive → success=true(固化当前行为)", async () => {
    const r = await call("POST", GHOST + "/heartbeat");
    expect(r.status, r.text.slice(0, 200)).toBe(200);
    expect(r.body?.success).toBe(true);
  });

  it("offline:旧格式 local:<userId>(无实例维度)→ 400 not-local-instance", async () => {
    const r = await call("POST", PEER + "/offline");
    expect(r.status, r.text.slice(0, 200)).toBe(400);
    expect(r.body?.reason).toBe("not-local-instance");
  });

  it("local-status:合法 state(大小写不敏感)→ 200", async () => {
    await call("POST", "/v1/peers/register", { body: { name: "LS", clientId: "ls1" } });
    const r = await call("POST", PEER + "/local-status", {
      body: { state: "playing", position: 12.5, duration: 200, volume: 0.5, songId: "s1" },
      headers: { "X-MF-Client-Id": "ls1" },
    });
    expect(r.status, r.text.slice(0, 200)).toBe(200);
    expect(r.body?.success).toBe(true);
  });

  it("local-status:非法 state → 字段被丢弃但仍 200", async () => {
    const r = await call("POST", PEER + "/local-status", {
      body: { state: "bogus", position: "abc" },
      headers: { "X-MF-Client-Id": "ls1" },
    });
    expect(r.status).toBe(200);
    expect(r.body?.success).toBe(true);
  });

  // characterization:未注册过的 local 实例上报状态**不报错** ——
  // reportLocalStatus 只做解析 + 内存写入,不查注册表(状态权威在客户端本地播放器)。
  it("local-status:未注册的 local 实例仍被接受 → 200", async () => {
    const r = await call("POST", "/v1/peers/local:u1:never-seen/local-status", {
      body: { state: "PLAYING", position: 3, duration: 100 },
    });
    expect(r.status, r.text.slice(0, 200)).toBe(200);
    expect(r.body?.success).toBe(true);
  });

  it("local-status:非 local 形态的 peerId → 400", async () => {
    const r = await call("POST", NOT_LOCAL + "/local-status", { body: { state: "PLAYING" } });
    expect(r.status, r.text.slice(0, 200)).toBe(400);
  });
});

// ==================== 详情 / 状态 / 队列快照 ====================
describe("详情与队列快照", () => {
  it("GET /v1/peers/:peerId → 200 含 peer + queue", async () => {
    const r = await call("GET", PEER, { headers: { "X-MF-Client-Id": "ls1" } });
    expect(r.status, r.text.slice(0, 200)).toBe(200);
    expect(r.body?.peer).toBeTruthy();
  });

  it("GET /v1/peers/:peerId/status → 200", async () => {
    const r = await call("GET", PEER + "/status", { headers: { "X-MF-Client-Id": "ls1" } });
    expect(r.status, r.text.slice(0, 200)).toBe(200);
  });

  it("GET /v1/peers/:peerId/queue → 200 且含 items/total", async () => {
    const r = await call("GET", PEER + "/queue", { headers: { "X-MF-Client-Id": "ls1" } });
    expect(r.status, r.text.slice(0, 200)).toBe(200);
    expect(Array.isArray(r.body?.items)).toBe(true);
    expect(typeof r.body?.total).toBe("number");
  });

  it("未知 peer → 4xx(不得 500)", async () => {
    const r = await call("GET", "/v1/peers/definitely-not-a-peer");
    expect(r.status).toBeGreaterThanOrEqual(400);
    expect(r.status).toBeLessThan(500);
  });
});

// ==================== 播放模式 / 下标 / 睡眠定时 ====================
describe("播放模式与睡眠定时", () => {
  it("play-mode 合法值(order/one/all/shuffle)→ 200", async () => {
    for (const mode of ["order", "one", "all", "shuffle"]) {
      const r = await call("POST", PEER + "/play-mode", {
        body: { mode },
        headers: { "X-MF-Client-Id": "ls1" },
      });
      expect(r.status, mode + " " + r.text.slice(0, 120)).toBe(200);
    }
  });

  it("play-mode 非法值 → 400", async () => {
    const r = await call("POST", PEER + "/play-mode", { body: { mode: "bogus" } });
    expect(r.status).toBe(400);
  });

  it("queue/index 合法 number → 200;非 number → 400", async () => {
    const ok = await call("POST", PEER + "/queue/index", {
      body: { index: 2 },
      headers: { "X-MF-Client-Id": "ls1" },
    });
    expect(ok.status, ok.text.slice(0, 200)).toBe(200);
    const bad = await call("POST", PEER + "/queue/index", { body: { index: "x" } });
    expect(bad.status).toBe(400);
  });

  it("sleep-timer:local peer 不支持 → POST/GET 400,DELETE 恒 200", async () => {
    const post = await call("POST", PEER + "/sleep-timer", { body: { durationSeconds: 600 } });
    expect(post.status, post.text.slice(0, 200)).toBe(400);
    const get = await call("GET", PEER + "/sleep-timer");
    expect(get.status).toBe(400);
    const del = await call("DELETE", PEER + "/sleep-timer");
    expect(del.status).toBe(200);
    expect(del.body?.success).toBe(true);
  });
});

// ==================== 权限门禁 ====================
describe("跨用户访问控制", () => {
  it("普通用户读他人 peer → 403", async () => {
    const r = await call("GET", PEER, { as: "bob" });
    expect(r.status, r.text.slice(0, 200)).toBe(403);
  });

  it("普通用户注册自己的 peer → 200", async () => {
    const r = await call("POST", "/v1/peers/register", { body: { name: "BobWeb", clientId: "c-bob" }, as: "bob" });
    expect(r.status, r.text.slice(0, 200)).toBe(200);
    expect(String(r.body?.peer?.peerId)).toMatch(/^local:/);
  });

  it("普通用户读自己的 peer → 200", async () => {
    const r = await call("GET", PEER_BOB, { as: "bob", headers: { "X-MF-Client-Id": "c-bob" } });
    expect(r.status, r.text.slice(0, 200)).toBe(200);
  });

  it("管理员读他人 peer → 200(管理员恒通过)", async () => {
    const r = await call("GET", PEER_BOB, { headers: { "X-MF-Client-Id": "c-bob" } });
    expect(r.status, r.text.slice(0, 200)).toBe(200);
  });
});
