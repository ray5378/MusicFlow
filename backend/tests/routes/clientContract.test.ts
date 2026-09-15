// 播放端临时 ID 契约测试(client 视角,对应 MusicFlow-client 的 HTTP 行为)。
//
// 锁定的契约(两端联动特性,改任何一侧必须同步另一侧):
//   1. POST /v1/peers/register  body/头携带 clientId → 响应 peer.peerId 为
//      `local:<userId>:<instanceKey>`(临时端 ID 只在服务端存在,对外一律用
//      不可逆派生实例键;响应 JSON 绝不出现 clientId 明文),并带 self:true。
//   2. GET /v1/peers  带 x-mf-client-id 头 → 含**同账号的全部本机实例**
//      (「播放器」页要按「客户端」/「Web 播放器」两个模块各列一行),并对
//      调用方自己那行打 `self: true`;整个响应 JSON 不出现任何 clientId 明文。
//   3. 队列/传输操作对 local peer 用打码实例键 id 即可命中对应实例(可指向同账号
//      的任意实例);不带实例键的旧形式 `local:<userId>` 仍按本次请求的 clientId
//      落到自己那行,老客户端契约不破坏。A/B 两实例的队列互相隔离。
//   4. 不带 clientId 的老客户端(<=v4.3.45)仍走旧格式 local:<userId>,契约不破坏。
//   5. 非法 clientId(超长/空白/中文)不 crash,回落安全路径。
//   6. 「自己那条」http 对外恒为规范形式 local:<userId>(不是实例键形式),同账号
//      其它实例才是 local:<userId>:<instanceKey> —— 前端内部就是这么归一化的,
//      改名 / 隐藏偏好两边因此天然同键。服务端**必须先打码再套偏好**
//      (见 services/access.ts 的 decoratePeersForClient),顺序反了会静默失效。
import "../plugins/_env.js";
import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { Hono } from "hono";
import md5 from "md5";
import { v4 as uuidv4 } from "uuid";
import { db, initDatabase, encryptPassword } from "../../src/db/index.js";
import { users, localQueues, songs, playerPrefs, playerNameOverrides } from "../../src/db/schema.js";
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
  // 偏好表(隐藏 / 改名)有指向 users 的外键,必须先清,否则删 users 会撞外键约束。
  db.delete(playerNameOverrides).run();
  db.delete(playerPrefs).run();
  db.delete(localQueues).run();
  db.delete(songs).run();
  db.delete(users).run();
});

describe("register 契约:临时 ID 打码成不可逆实例键", () => {
  it("body 携带 clientId → peerId 为 local:<uid>:<实例键>,self=true,不回显临时 ID", async () => {
    const uid = seedUser();
    const res = await app.request("/rest/api/v1/peers/register", {
      method: "POST",
      headers: authHeaders(uid),
      body: JSON.stringify({ clientId: "web-7f3a91" }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.peer.kind).toBe("local");
    expect(body.peer.peerId).toMatch(new RegExp(`^local:${uid}:[0-9a-f]{12}$`));
    expect(body.peer.self).toBe(true);
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
    expect(body.peer.peerId).toMatch(new RegExp(`^local:${uid}:[0-9a-f]{12}$`));
    expect(body.peer.self).toBe(true);
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

describe("peers 列表契约:同账号实例互相可见 + self 标记", () => {
  it("A/B 两实例同账号注册 → 双方列表都含两条,自己那条 self=true,JSON 无临时 ID 明文", async () => {
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
    const localsA = listA.filter((p) => p.peerId.startsWith("local:"));
    // 同账号的两个实例都可见(「播放器」页要按「客户端」/「Web 播放器」各列一行)。
    expect(localsA).toHaveLength(2);
    // 只有「自己那条」被打上 self。
    const selfA = localsA.filter((p) => p.self);
    expect(selfA).toHaveLength(1);
    // 「自己那条」对外恒为**规范形式** `local:<uid>`(与前端 player store 的内部
    // localPeerId 一致,改名/隐藏偏好的键因此两边天然对齐);
    // 同账号的其它实例才是 `local:<uid>:<实例键>`。
    expect(selfA[0].peerId).toBe(`local:${uid}`);
    expect(localsA.find((p) => !p.self)!.peerId).toMatch(new RegExp(`^local:${uid}:[0-9a-f]{12}$`));
    // 任何 clientId 明文都不出现在响应里。
    expect(JSON.stringify(listA)).not.toContain("web-bbbbbb");
    expect(JSON.stringify(listA)).not.toContain("web-aaaaaa");

    // B 视角:同样两条,self 换到 B 那条;两边自己那条都是规范形式,差异落在
    // 「看到对方的实例键」上 —— A 看到的非 self 行 ≠ B 看到的非 self 行。
    const resB = await app.request("/rest/api/v1/peers", { headers: authHeaders(uid, "web-bbbbbb") });
    const listB = (await resB.json()).peers as any[];
    const localsB = listB.filter((p) => p.peerId.startsWith("local:"));
    expect(localsB).toHaveLength(2);
    expect(localsB.filter((p) => p.self)).toHaveLength(1);
    expect(localsB.find((p) => p.self)!.peerId).toBe(`local:${uid}`);
    expect(localsB.find((p) => !p.self)!.peerId).toMatch(new RegExp(`^local:${uid}:[0-9a-f]{12}$`));
    expect(localsB.find((p) => !p.self)!.peerId).not.toBe(localsA.find((p) => !p.self)!.peerId);
  });

  // 「播放器」页要给客户端 / Web 播放器模块提供与 DLNA 同款的改名 + 隐藏。
  // 偏好(hidden / names)以**对外 id** 为键,故服务端必须「先打码、后套偏好」——
  // 早期实现是反的,导致针对本机实例的改名/隐藏静默失效(键对不上)。此用例锁死顺序。
  it("按用户级改名 / 隐藏对本机实例同样生效(偏好键 = 对外 id)", async () => {
    const uid = seedUser();
    for (const cid of ["web-aaaaaa", "web-bbbbbb"]) {
      await app.request("/rest/api/v1/peers/register", {
        method: "POST",
        headers: authHeaders(uid),
        body: JSON.stringify({ clientId: cid, platform: "web", model: "Chrome · Windows" }),
      });
    }
    const other = await app.request("/rest/api/v1/peers", { headers: authHeaders(uid, "web-aaaaaa") });
    const otherPeerId = ((await other.json()).peers as any[]).find((p) => !p.self).peerId as string;

    // 1) 给「自己那条」改名:键就是规范形式 local:<uid>,服务端存与列表出口必须一致。
    await app.request("/rest/api/v1/player-prefs/names", {
      method: "PUT",
      headers: authHeaders(uid, "web-aaaaaa"),
      body: JSON.stringify({ peerId: `local:${uid}`, name: "我的笔记本" }),
    });
    // 2) 隐藏「对方那个实例」:用它的对外实例键 id。
    await app.request("/rest/api/v1/player-prefs/hidden", {
      method: "PUT",
      headers: authHeaders(uid, "web-aaaaaa"),
      body: JSON.stringify({ peerId: otherPeerId, hidden: true }),
    });

    const after = await app.request("/rest/api/v1/peers", { headers: authHeaders(uid, "web-aaaaaa") });
    const list = (await after.json()).peers as any[];
    const locals = list.filter((p) => p.peerId.startsWith("local:"));
    // 改名生效:自己那条 name 被覆盖。
    expect(locals.find((p) => p.self)!.name).toBe("我的笔记本");
    // 隐藏生效:对方实例已从列表消失(仅剩自己那条)。
    expect(locals).toHaveLength(1);
    expect(locals[0].peerId).toBe(`local:${uid}`);
    // 设备名片随本机实例一起下发 —— 「播放器」页据此把实例分进客户端 / Web 播放器模块。
    expect(locals[0].platform).toBe("web");
    expect(locals[0].model).toBe("Chrome · Windows");
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

  it("用「打码实例键 id」(不带 clientId 头)也能命中同账号的对应实例", async () => {
    const uid = seedUser();
    const pid = `local:${uid}`;
    for (const cid of ["web-aaaaaa", "web-bbbbbb"]) {
      await app.request("/rest/api/v1/peers/register", {
        method: "POST",
        headers: authHeaders(uid),
        body: JSON.stringify({ clientId: cid }),
      });
    }
    const list = (await (await app.request("/rest/api/v1/peers", { headers: authHeaders(uid, "web-aaaaaa") })).json()).peers as any[];
    const locals = list.filter((p) => p.peerId.startsWith("local:"));
    const other = locals.find((p) => !p.self)!.peerId; // A 视角下 non-self 即 B
    // 调用方是 A,但目标写成 B 的实例键 —— 入口应按实例键反查落到 B 那一行。
    const r = await app.request(`/rest/api/v1/peers/${encodeURIComponent(other)}/queue/play`, {
      method: "POST",
      headers: authHeaders(uid, "web-aaaaaa"),
      body: JSON.stringify({ items: [queueItem("z1")], startIndex: 0 }),
    });
    expect(r.status).toBe(200);
    const rows = db.select().from(localQueues).where(eq(localQueues.userId, uid)).all() as any[];
    const hit = rows.find((x) => (x.itemsJson || "").includes("z1"));
    expect(hit).toBeTruthy();
    expect(hit.peerId).toBe(`${pid}:web-bbbbbb`); // 落库到 B,而不是调用方 A
  });
});
