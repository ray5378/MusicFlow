// 流转 / 起播的「进度对齐」契约测试
// (POST /v1/peers/:peerId/queue/transfer-from 与 POST /v1/peers/:peerId/queue/play)。
//
// 锁定「流转后目标端出声位置与流转前对齐(秒级)」的服务端侧契约:
//   1. 本机端(local)的音频会话活在**客户端进程**里,服务端无法替它 seek ——
//      因此起点不落库、不走 WebSocket 指令,而是**随当次队列广播**带出
//      (QueueSnapshot.startPosition),客户端起播后自行落位,因果才闭合。
//   2. 该字段**必须是一次性**的:广播后即清。若残留,之后每次轮询/广播都会把客户端
//      拉回同一个位置 —— 表现为「听几秒就跳回某处」。
//   3. 非法入参(负数 / 字符串 / NaN / null / 对象)一律忽略,不得污染快照。
import "../plugins/_env.js";
import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { Hono } from "hono";
import { v4 as uuidv4 } from "uuid";
import { db, initDatabase, encryptPassword } from "../../src/db/index.js";
import { users, localQueues, playerPrefs, playerNameOverrides } from "../../src/db/schema.js";
import { authMiddleware } from "../../src/middleware/auth.js";
import { apiRoutes } from "../../src/routes/api/index.js";
import { generateToken } from "../../src/utils/auth.js";
import { getPeerManager } from "../../src/services/peer.js";

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
  extra?: Record<string, unknown>,
) {
  return app.request(`/rest/api/v1/peers/${encodeURIComponent(peerId)}/queue/play`, {
    method: "POST",
    headers: authHeaders(uid, clientId),
    body: JSON.stringify({ items, startIndex, ...(extra || {}) }),
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

/**
 * 收集某个本机实例的队列广播快照(按**代**收集:调用一次 = 一代)。
 *
 * 两个坑(调试时都踩过):
 *   - `register` 回的是**对外** peerId(clientId 经掩码),而 `peer_queue_changed` 广播
 *     带的是**内部** peerId —— 严格相等永远匹配不上,按 clientId 子串匹配。
 *   - 一次起播会带出**多条**广播(预探测 preProbe 先发一条不带 startPosition 的),
 *     所以不能断言 `seen[0]`,必须按「这一代里有没有 / 全都没有」来判。
 */
async function collectGeneration<T>(clientId: string, fn: () => Promise<T>) {
  const pm = getPeerManager();
  const seen: any[] = [];
  const onQ = (pid: string, snap: any) => {
    if (String(pid).includes(clientId)) seen.push(snap);
  };
  pm.on("peer_queue_changed", onQ);
  try {
    const out = await fn();
    return { out, seen };
  } finally {
    pm.off("peer_queue_changed", onQ);
  }
}

const withStart = (seen: any[]) => seen.filter((s) => s && s.startPosition !== undefined);

describe("流转进度对齐:local → local", () => {
  it("带 position 流转 → 当次广播带出 startPosition,回执回显,且不落库", async () => {
    const uid = seedUser();
    const A = await register(uid, "web-paaa01");
    const B = await register(uid, "win-pbbb02");
    await putQueue(uid, A, [item("s1", "第一首"), item("s2", "第二首")], 1, "web-paaa01");

    const { out: res, seen } = await collectGeneration("win-pbbb02", () =>
      transfer(uid, B, { from: A, position: 42.5 }, "win-pbbb02"),
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.position).toBe(42.5);
    expect(seen.length).toBeGreaterThan(0);
    const marked = withStart(seen);
    expect(marked.length).toBeGreaterThan(0);
    expect(marked[0].startPosition).toBe(42.5);

    // 不落库:轮询不得再带(否则每次轮询都把客户端拉回 42.5s)。
    const qb = await getQueue(uid, B, "win-pbbb02");
    expect(qb.startPosition).toBeUndefined();
  });

  it("一次性:下一次起播的广播不得残留上一次的 startPosition", async () => {
    const uid = seedUser();
    const A = await register(uid, "web-pccc03");
    const B = await register(uid, "win-pddd04");
    await putQueue(uid, A, [item("s1", "第一首")], 0, "web-pccc03");

    const g1 = await collectGeneration("win-pddd04", () => transfer(uid, B, { from: A, position: 30 }, "win-pddd04"));
    expect(withStart(g1.seen).length).toBeGreaterThan(0);
    expect(withStart(g1.seen)[0].startPosition).toBe(30);

    // 目标端自己再起播一次(不带 position)—— 这一代广播里必须一个 startPosition 都没有。
    const g2 = await collectGeneration("win-pddd04", () =>
      putQueue(uid, B, [item("z1", "另一首")], 0, "win-pddd04"),
    );
    expect(g2.seen.length).toBeGreaterThan(0);
    expect(withStart(g2.seen)).toEqual([]);
  });

  it("不带 position → 不落起点(源端无上报时不得臆造位置)", async () => {
    const uid = seedUser();
    const A = await register(uid, "web-peee05");
    const B = await register(uid, "win-pfff06");
    await putQueue(uid, A, [item("s1", "第一首")], 0, "web-peee05");

    const { out: res, seen } = await collectGeneration("win-pfff06", () => transfer(uid, B, { from: A }, "win-pfff06"));
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.position).toBe(null);
    expect(withStart(seen)).toEqual([]);
  });

  it("非法 position(负数 / 字符串 / NaN / null / 对象)一律忽略", async () => {
    const uid = seedUser();
    const A = await register(uid, "web-pggg07");
    const B = await register(uid, "win-phhh08");
    await putQueue(uid, A, [item("s1", "第一首")], 0, "web-pggg07");

    for (const bad of [-5, "42", null, Number.NaN, {}]) {
      const { out: res, seen } = await collectGeneration("win-phhh08", () =>
        transfer(uid, B, { from: A, position: bad }, "win-phhh08"),
      );
      expect(res.status).toBe(200);
      expect(withStart(seen)).toEqual([]);
    }
  });
});

describe("带进度起播:POST /v1/peers/:peerId/queue/play", () => {
  it("local 目标:position 随当次广播带出,回执回显且不落库", async () => {
    const uid = seedUser();
    const B = await register(uid, "win-piii09");

    const { out: res, seen } = await collectGeneration("win-piii09", () =>
      putQueue(uid, B, [item("s1", "第一首"), item("s2", "第二首")], 1, "win-piii09", { position: 12.25 }),
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.position).toBe(12.25);
    expect(withStart(seen)[0].startPosition).toBe(12.25);

    const qb = await getQueue(uid, B, "win-piii09");
    expect(qb.startPosition).toBeUndefined();
  });
});
