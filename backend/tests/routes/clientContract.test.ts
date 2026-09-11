// 播放端临时 ID 契约测试(client 视角,对应 MusicFlow-client 的 HTTP 行为)。
//
// 锁定的契约(两端联动特性,改任何一侧必须同步另一侧):
//   1. POST /v1/peers/register  body/头携带 clientId → 响应 peer.peerId 恒为
//      `local:<userId>`(临时端 ID 只在服务端存在,响应必须打码)。
//   2. GET /v1/peers  带 x-mf-client-id 头 → 只含「自己实例」的本机 peer,
//      同账号其它实例不可见,且整个响应 JSON 不出现临时 ID 明文。
//   3. 队列操作(queue/play、queue/enqueue、GET queue)对 local peer 走
//      打码 id `local:<userId>` + clientId 头,服务端内部落到真实实例行;
//      A/B 两实例的队列互相隔离。
//   4. 不带 clientId 的老客户端(<=v4.3.45)仍走旧格式 local:<userId>,契约不破坏。
//   5. 非法 clientId(超长/空白/中文)不 crash,回落安全路径。
import "../plugins/_env.js";
import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { Hono } from "hono";
import md5 from "md5";
import { v4 as uuidv4 } from "uuid";
import { db, initDatabase, encryptPassword } from "../../src/db/index.js";
import { users, localQueues, songs } from "../../src/db/schema.js";
import { eq } from "drizzle-orm";
import { authMiddleware } from "../../src/middleware/auth.js";
import { apiRoutes } from "../../src/routes/api/index.js";
import { generateToken } from "../../src/utils/auth.js";
import { getPeerManager } from "../../src/services/peer.js";

const app = new Hono();
app.use("/rest/api/*", authMiddleware);
app.route("/rest/api", apiRoutes);

function seedUser() {
  const id = uuidv4();
  db.insert(users)
    .values({
      id,
      username: `u-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      password: "",
      salt: "salt",
      subsonicSalt: "subsalt",
      passEnc: encryptPassword("pw"),
      // 用 admin 免开 renderer 授权;local 隔离对管理员同样生效(filterPeersByAccess
      // 对 local 一律只放行调用方自己的实例),测试口径反而更严。
      isAdmin: 1,
      isActive: 1,
      email: "",
    })
    .run();
  return id;
}

function authHeaders(uid: string, clientId?: string) {
  const h: Record<string, string> = {
    Authorization: `Bearer ${generateToken(uid, "tester", true)}`,
    "content-type": "application/json",
  };
  if (clientId) h["x-mf-client-id"] = clientId;
  return h;
}

function queueItem(id: string) {
  // 客户端 songToQueueItem 的服务端契约:QueueItem 只有 mime,没有 suffix。
  return { songId: id, title: `t-${id}`, mime: "audio/mpeg", duration: 100 };
}

beforeAll(() => {
  if (!process.env.APP_VERSION) process.env.APP_VERSION = "1.0.0";
  initDatabase();
});
beforeEach(() => {
  db.delete(localQueues).run();
  db.delete(songs).run();
  db.delete(users).run();
});

describe("register 契约:临时 ID 打码", () => {
  it("body 携带 clientId → peer.peerId 恒为 local:<uid>,响应不回显临时 ID", async () => {
    const uid = seedUser();
    const res = await app.request("/rest/api/v1/peers/register", {
      method: "POST",
      headers: authHeaders(uid),
      body: JSON.stringify({ clientId: "web-7f3a91" }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.peer.kind).toBe("local");
    expect(body.peer.peerId).toBe(`local:${uid}`);
    expect(JSON.stringify(body)).not.toContain("web-7f3a91");
  });

  it("x-mf-client-id 头等价于 body clientId", async () => {
    const uid = seedUser();
    const res = await app.request("/rest/api/v1/peers/register", {
      method: "POST",
      headers: authHeaders(uid, "win-2c8e40"),
      body: JSON.stringify({}),
    });
    const body = await res.json();
    expect(body.peer.peerId).toBe(`local:${uid}`);
    expect(JSON.stringify(body)).not.toContain("win-2c8e40");
  });

  it("非法 clientId 不 crash,回落安全路径", async () => {
    const uid = seedUser();
    for (const bad of ["", "   ", "含中文", "x".repeat(33)]) {
      const res = await app.request("/rest/api/v1/peers/register", {
        method: "POST",
        headers: authHeaders(uid),
        body: JSON.stringify({ clientId: bad }),
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.peer.peerId).toBe(`local:${uid}`);
    }
  });

  it("老客户端(无 clientId)仍注册为旧格式 local:<uid>", async () => {
    const uid = seedUser();
    const res = await app.request("/rest/api/v1/peers/register", {
      method: "POST",
      headers: authHeaders(uid),
      body: JSON.stringify({ name: "老端" }),
    });
    const body = await res.json();
    expect(body.peer.peerId).toBe(`local:${uid}`);
  });
});

describe("peers 列表契约:各端只见自己", () => {
  it("A/B 两实例同账号注册 → 各自列表只含自己那条,JSON 无临时 ID 明文", async () => {
    const uid = seedUser();
    for (const cid of ["web-aaaaaa", "web-bbbbbb"]) {
      await app.request("/rest/api/v1/peers/register", {
        method: "POST",
        headers: authHeaders(uid),
        body: JSON.stringify({ clientId: cid }),
      });
    }
    const resA = await app.request("/rest/api/v1/peers", { headers: authHeaders(uid, "web-aaaaaa") });
    const listA = (await resA.json()).peers as any[];
    const locals = listA.filter((p) => p.peerId.startsWith("local:"));
    expect(locals).toHaveLength(1);
    expect(locals[0].peerId).toBe(`local:${uid}`);
    expect(JSON.stringify(listA)).not.toContain("web-bbbbbb");
    expect(JSON.stringify(listA)).not.toContain("web-aaaaaa");

    const resB = await app.request("/rest/api/v1/peers", { headers: authHeaders(uid, "web-bbbbbb") });
    const listB = (await resB.json()).peers as any[];
    expect(listB.filter((p) => p.peerId.startsWith("local:"))).toHaveLength(1);
  });

  it("老客户端无 clientId → 注册旧格式后仍能看到 local:<uid>", async () => {
    const uid = seedUser();
    await app.request("/rest/api/v1/peers/register", {
      method: "POST",
      headers: authHeaders(uid),
      body: JSON.stringify({ name: "老端" }),
    });
    const res = await app.request("/rest/api/v1/peers", { headers: authHeaders(uid) });
    const list = (await res.json()).peers as any[];
    expect(list.some((p) => p.peerId === `local:${uid}`)).toBe(true);
  });
});

describe("队列操作契约:打码 id + 头 ⇒ 实例隔离", () => {
  it("A/B 各自 queue/play+enqueue,GET queue 互不可见", async () => {
    const uid = seedUser();
    const pid = `local:${uid}`;
    for (const cid of ["web-aaaaaa", "web-bbbbbb"]) {
      await app.request("/rest/api/v1/peers/register", {
        method: "POST",
        headers: authHeaders(uid),
        body: JSON.stringify({ clientId: cid }),
      });
    }
    // A:queue/play 播 2 首;B:enqueue 1 首
    const rPlay = await app.request(`/rest/api/v1/peers/${encodeURIComponent(pid)}/queue/play`, {
      method: "POST",
      headers: authHeaders(uid, "web-aaaaaa"),
      body: JSON.stringify({ items: [queueItem("a1"), queueItem("a2")], startIndex: 0 }),
    });
    expect(rPlay.status).toBe(200);
    const rEnq = await app.request(`/rest/api/v1/peers/${encodeURIComponent(pid)}/queue/enqueue`, {
      method: "POST",
      headers: authHeaders(uid, "web-bbbbbb"),
      body: JSON.stringify({ items: [queueItem("b1")] }),
    });
    expect(rEnq.status).toBe(200);

    const resA = await app.request(`/rest/api/v1/peers/${encodeURIComponent(pid)}/queue`, {
      headers: authHeaders(uid, "web-aaaaaa"),
    });
    const qA = await resA.json();
    expect(qA.items.map((x: any) => x.songId)).toEqual(["a1", "a2"]);

    const resB = await app.request(`/rest/api/v1/peers/${encodeURIComponent(pid)}/queue`, {
      headers: authHeaders(uid, "web-bbbbbb"),
    });
    const qB = await resB.json();
    expect(qB.items.map((x: any) => x.songId)).toEqual(["b1"]);

    // DB 行按真实实例 id 落库(打码只发生在出口)
    const rows = db.select().from(localQueues).where(eq(localQueues.userId, uid)).all() as any[];
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.peerId).sort()).toEqual([`${pid}:web-aaaaaa`, `${pid}:web-bbbbbb`].sort());
  });

  it("heartbeat 用打码 id + clientId 头 → 命中真实实例", async () => {
    const uid = seedUser();
    const pid = `local:${uid}`;
    await app.request("/rest/api/v1/peers/register", {
      method: "POST",
      headers: authHeaders(uid),
      body: JSON.stringify({ clientId: "web-aaaaaa" }),
    });
    const res = await app.request(`/rest/api/v1/peers/${encodeURIComponent(pid)}/heartbeat`, {
      method: "POST",
      headers: authHeaders(uid, "web-aaaaaa"),
    });
    expect(res.status).toBe(200);
    // 心跳就地复活:即使 PeerManager 内存曾被清(重启),打码 id + 头也能续上
    expect(getPeerManager().get(`${pid}:web-aaaaaa`)?.available).toBe(true);
  });
});
