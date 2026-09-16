// 播放端彻底重置契约测试(POST /v1/peers/:peerId/reset)。
//
// 对应能力:流转播放「把 A 拖到 B」与回收站「销毁 A」之后,源端 A 必须**干干净净**。
//
// 为什么需要这条独立端点,而不是客户端自己 stop + DELETE /queue:
// 那两步都只清**队列实体**,运行态各留各的 —— 队列虽空,GET /status 仍把该端报成
// 「在播某一首」(local 端尤其明显:状态上报采用字段级合并,客户端停止时不发 songId,
// 上一首就永远挂在账本里)。本端点一次做完「停止 + 清空 + 清运行态」。
//
// 锁定的契约:
//   1. 清空队列实体:items 空、游标归 -1、isActive 归 0;
//   2. 清运行态:本机 /local-status 上报被丢弃(GET /status 不再叠加 state / songId);
//   3. **保留** playMode:用户设定,不该被一次搬移或销毁带走;
//   4. **保留** peer 注册:销毁只重置播放状态,播放端仍在列表里;
//   5. 非法 peerId → 400。
import "../plugins/_env.js";
import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { Hono } from "hono";
import { v4 as uuidv4 } from "uuid";
import { db, initDatabase, encryptPassword } from "../../src/db/index.js";
import { users, localQueues, playerPrefs, playerNameOverrides } from "../../src/db/schema.js";
import { authMiddleware } from "../../src/middleware/auth.js";
import { apiRoutes } from "../../src/routes/api/index.js";
import { generateToken } from "../../src/utils/auth.js";

const app = new Hono();
app.use("/rest/api/*", authMiddleware);
app.route("/rest/api", apiRoutes);

function authHeaders(uid: string, clientId?: string) {
  const h: Record<string, string> = {
    Authorization: `Bearer ${generateToken(uid, "tester", true)}`,
    "content-type": "application/json",
  };
  if (clientId) h["x-mf-client-id"] = clientId;
  return h;
}

function seedUser(): string {
  const id = uuidv4();
  db.insert(users)
    .values({
      id,
      username: `u-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      password: "",
      salt: "salt",
      subsonicSalt: "subsalt",
      passEnc: encryptPassword("pw"),
      isAdmin: 1,
      isActive: 1,
      email: "",
    })
    .run();
  return id;
}

const item = (id: string, title: string) => ({
  songId: id, title, mime: "audio/mpeg", duration: 100,
});

async function register(uid: string, clientId: string): Promise<string> {
  const res = await app.request("/rest/api/v1/peers/register", {
    method: "POST",
    headers: authHeaders(uid, clientId),
    body: JSON.stringify({ clientId }),
  });
  const body = await res.json();
  return body.peer.peerId as string;
}

async function putQueue(
  uid: string, peerId: string, items: ReturnType<typeof item>[],
  startIndex: number, clientId: string,
) {
  return app.request(`/rest/api/v1/peers/${encodeURIComponent(peerId)}/queue/play`, {
    method: "POST",
    headers: authHeaders(uid, clientId),
    body: JSON.stringify({ items, startIndex }),
  });
}

async function setMode(uid: string, peerId: string, mode: string, clientId: string) {
  return app.request(`/rest/api/v1/peers/${encodeURIComponent(peerId)}/play-mode`, {
    method: "POST",
    headers: authHeaders(uid, clientId),
    body: JSON.stringify({ mode }),
  });
}

async function postLocalStatus(uid: string, peerId: string, body: unknown, clientId: string) {
  return app.request(`/rest/api/v1/peers/${encodeURIComponent(peerId)}/local-status`, {
    method: "POST",
    headers: authHeaders(uid, clientId),
    body: JSON.stringify(body),
  });
}

async function reset(uid: string, peerId: string, clientId: string) {
  return app.request(`/rest/api/v1/peers/${encodeURIComponent(peerId)}/reset`, {
    method: "POST",
    headers: authHeaders(uid, clientId),
  });
}

async function getQueue(uid: string, peerId: string, clientId: string) {
  const res = await app.request(`/rest/api/v1/peers/${encodeURIComponent(peerId)}/queue`, {
    headers: authHeaders(uid, clientId),
  });
  return res.json();
}

async function getStatus(uid: string, peerId: string, clientId: string) {
  const res = await app.request(`/rest/api/v1/peers/${encodeURIComponent(peerId)}/status`, {
    headers: authHeaders(uid, clientId),
  });
  return res.json();
}

beforeAll(() => {
  if (!process.env.APP_VERSION) process.env.APP_VERSION = "1.0.0";
  initDatabase();
});
beforeEach(() => {
  db.delete(playerNameOverrides).run();
  db.delete(playerPrefs).run();
  db.delete(localQueues).run();
  db.delete(users).run();
});

describe("POST /v1/peers/:peerId/reset:清空队列实体", () => {
  it("items 清空、游标归 -1、isActive 归 0", async () => {
    const uid = seedUser();
    const A = await register(uid, "web-rst-01");
    await putQueue(uid, A, [item("s1", "一"), item("s2", "二")], 1, "web-rst-01");

    // 重置前确认队列确实在。
    const before = await getQueue(uid, A, "web-rst-01");
    expect((before.items || []).length).toBe(2);
    expect(before.currentIndex).toBe(1);

    const res = await reset(uid, A, "web-rst-01");
    expect(res.status).toBe(200);
    expect((await res.json()).success).toBe(true);

    const after = await getQueue(uid, A, "web-rst-01");
    expect(after.items || []).toEqual([]);
    expect(after.currentIndex).toBe(-1);
    expect(after.isActive).toBe(false);
  });
});

describe("POST /v1/peers/:peerId/reset:清运行态(本机状态上报)", () => {
  it("重置后 /status 不再叠加 state / songId —— 该端不再被报成「在播」", async () => {
    const uid = seedUser();
    const A = await register(uid, "web-rst-02");
    await putQueue(uid, A, [item("s1", "一")], 0, "web-rst-02");
    await postLocalStatus(
      uid, A,
      { state: "PLAYING", position: 33, duration: 200, volume: 50, songId: "s1" },
      "web-rst-02",
    );

    // 重置前:status 带着上报(对端据此镜像进度条与封面)。
    const before = await getStatus(uid, A, "web-rst-02");
    expect(before.state).toBe("PLAYING");
    expect(before.media?.songId).toBe("s1");

    await reset(uid, A, "web-rst-02");

    // 重置后:只剩队列快照,没有 state / media —— 这是本次修复的核心回归点。
    const after = await getStatus(uid, A, "web-rst-02");
    expect(after.state).toBeUndefined();
    expect(after.media).toBeUndefined();
    expect(after.items || []).toEqual([]);
  });

  it("重置后再上报 STOPPED,不会把已清空的 songId 又带回来", async () => {
    const uid = seedUser();
    const A = await register(uid, "web-rst-03");
    await postLocalStatus(
      uid, A, { state: "PLAYING", position: 5, duration: 100, songId: "s-old" }, "web-rst-03",
    );
    await reset(uid, A, "web-rst-03");
    // 客户端 4s 周期照常上报,此时是 STOPPED 且不带 songId 字段。
    await postLocalStatus(uid, A, { state: "STOPPED", position: 0 }, "web-rst-03");
    const after = await getStatus(uid, A, "web-rst-03");
    expect(after.state).toBe("STOPPED");
    expect(after.media).toBeUndefined();
  });
});

describe("POST /v1/peers/:peerId/reset:刻意保留的东西", () => {
  it("保留 playMode(用户设定,不该被搬移/销毁带走)", async () => {
    const uid = seedUser();
    const A = await register(uid, "web-rst-04");
    await putQueue(uid, A, [item("s1", "一")], 0, "web-rst-04");
    await setMode(uid, A, "shuffle", "web-rst-04");
    expect((await getQueue(uid, A, "web-rst-04")).playMode).toBe("shuffle");

    await reset(uid, A, "web-rst-04");
    expect((await getQueue(uid, A, "web-rst-04")).playMode).toBe("shuffle");
  });

  it("保留 peer 注册(销毁只重置播放状态,播放端不会被注销)", async () => {
    const uid = seedUser();
    const A = await register(uid, "web-rst-05");
    await putQueue(uid, A, [item("s1", "一")], 0, "web-rst-05");

    await reset(uid, A, "web-rst-05");

    // 按 peerId 直接取:仍能取到 = 注册还在。
    // (不用 /v1/peers 列表判 —— 列表里的 peerId 是对外打码后的 local:<uid>,
    //  与 register 返回的实例 id 不同形,拿它做包含断言会假失败。)
    const res = await app.request(
      `/rest/api/v1/peers/${encodeURIComponent(A)}`,
      { headers: authHeaders(uid, "web-rst-05") },
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    // 只校验仍归同一用户且仍是本机实例 —— 不比对完整 peerId:
    // register 返回的是随机实例键,按 X-MF-Client-Id 解析回来是 `<uid>:<clientId>`,
    // 同一个 peer 的两种写法,字面相等会假失败。
    expect(body.peer?.peerId).toMatch(new RegExp(`^local:${uid}:`));
  });
});

describe("POST /v1/peers/:peerId/reset:参数边界", () => {
  it("非法 peerId → 400", async () => {
    const uid = seedUser();
    const res = await reset(uid, "not-a-valid-peer-id", "web-rst-06");
    expect(res.status).toBe(400);
  });

  it("重复重置幂等(多次调用不报错、结果一致)", async () => {
    const uid = seedUser();
    const A = await register(uid, "web-rst-07");
    await putQueue(uid, A, [item("s1", "一")], 0, "web-rst-07");

    expect((await reset(uid, A, "web-rst-07")).status).toBe(200);
    expect((await reset(uid, A, "web-rst-07")).status).toBe(200);
    const after = await getQueue(uid, A, "web-rst-07");
    expect(after.items || []).toEqual([]);
  });
});
