// 队列流转契约测试(GET/POST /v1/peers/:peerId/queue/transfer-from)。
//
// 锁定「音乐可以在不同播放端之间随时流转」这一能力的服务端侧契约:
//   1. 请求体**不收 items** —— 队列实体由服务端持有(device_queues / local_queues 的
//      items_json),服务端内部从源端取、再走与 /queue/play 完全一致的分派写到目标端。
//      客户端因此零上传:几千首的队列也是一次请求,不存在公网入口对大队列 JSON 的
//      体积闸门问题。**这条是设计红线,回归即失败**(若哪天有人改成"客户端传 items",
//      大歌单流转会在公网上必然失败)。
//   2. 队列整体搬移:items 逐项一致,游标与播放模式一并跟随。
//   3. 参数边界:from 缺失 / 空串 / 指向自己 / 源端不存在 → 400;
//      源端队列为空 → success 且 transferred:0(不算错误)。
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

const item = (id: string, title: string) => ({ songId: id, title, mime: "audio/mpeg", duration: 100 });

/// 注册一个本机实例,返回它的完整对外 peerId(形如 local:<uid>:<实例键>)。
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
  uid: string,
  peerId: string,
  items: ReturnType<typeof item>[],
  startIndex: number,
  clientId: string,
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

async function transfer(uid: string, toPeerId: string, body: unknown, clientId: string) {
  return app.request(`/rest/api/v1/peers/${encodeURIComponent(toPeerId)}/queue/transfer-from`, {
    method: "POST",
    headers: authHeaders(uid, clientId),
    body: JSON.stringify(body),
  });
}

async function getQueue(uid: string, peerId: string, clientId: string) {
  const res = await app.request(`/rest/api/v1/peers/${encodeURIComponent(peerId)}/queue`, {
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

describe("队列流转:local → local", () => {
  it("整体搬移 items + 游标 + 播放模式", async () => {
    const uid = seedUser();
    const A = await register(uid, "web-aaaaaa");
    const B = await register(uid, "win-bbbbbb");

    const items = [item("s1", "第一首"), item("s2", "第二首"), item("s3", "第三首")];
    await putQueue(uid, A, items, 2, "web-aaaaaa");
    await setMode(uid, A, "shuffle", "web-aaaaaa");

    const res = await transfer(uid, B, { from: A }, "win-bbbbbb");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.transferred).toBe(3);
    expect(body.startIndex).toBe(2);

    // 目标端拿到完整队列(逐项一致),游标与模式跟随。
    const qb = await getQueue(uid, B, "win-bbbbbb");
    expect((qb.items || []).map((i: any) => i.songId)).toEqual(["s1", "s2", "s3"]);
    expect((qb.items || []).map((i: any) => i.title)).toEqual(["第一首", "第二首", "第三首"]);
    expect(qb.currentIndex).toBe(2);
    expect(qb.playMode).toBe("shuffle");
  });

  it("请求体不接受也不依赖 items(队列由服务端自取)", async () => {
    const uid = seedUser();
    const A = await register(uid, "web-cccccc");
    const B = await register(uid, "win-dddddd");
    await putQueue(uid, A, [item("x1", "X1")], 0, "web-cccccc");

    // 即便客户端硬塞一份"错误的 items",也必须以**服务端持有的源队列**为准 ——
    // 这正是「零上传」设计的语义:队列实体不在客户端手里。
    const res = await transfer(
      uid,
      B,
      { from: A, items: [item("bogus", "伪造")] },
      "win-dddddd",
    );
    expect(res.status).toBe(200);
    const qb = await getQueue(uid, B, "win-dddddd");
    expect((qb.items || []).map((i: any) => i.songId)).toEqual(["x1"]);
  });

  it("源端队列为空 → success 且 transferred:0(不算错误)", async () => {
    const uid = seedUser();
    const A = await register(uid, "web-eeeeee");
    const B = await register(uid, "win-ffffff");

    const res = await transfer(uid, B, { from: A }, "win-ffffff");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.transferred).toBe(0);
  });
});

describe("队列流转:参数边界", () => {
  it("from 缺失 / 空串 → 400", async () => {
    const uid = seedUser();
    const B = await register(uid, "win-gggggg");
    for (const bad of [{}, { from: "" }, { from: "   " }, { from: 123 }]) {
      const res = await transfer(uid, B, bad, "win-gggggg");
      expect(res.status).toBe(400);
    }
  });

  it("from 指向自己 → 400(没有意义,且会自我覆盖)", async () => {
    const uid = seedUser();
    const B = await register(uid, "win-hhhhhh");
    const res = await transfer(uid, B, { from: B }, "win-hhhhhh");
    expect(res.status).toBe(400);
  });

  it("源端不存在 → 400", async () => {
    const uid = seedUser();
    const B = await register(uid, "win-iiiiii");
    const res = await transfer(uid, B, { from: "local:00000000-0000-0000-0000-000000000000:deadbeef1234" }, "win-iiiiii");
    expect(res.status).toBe(400);
  });
});
