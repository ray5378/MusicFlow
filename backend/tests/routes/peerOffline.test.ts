// 页面「主动告别」契约测试(POST /v1/peers/:peerId/offline)。
//
// 背景:Web 页面在服务端**不是一个进程**(前端是 vite 静态产物,由 Hono 托管),
// 所以「没打开时自动清理」只能靠给它装上线的**上下线语义**:
//   ① WS close 引用计数归零 → 秒级标离线(正常关标签页);
//   ② 本端点 pagehide 告别 → 抢在连接拆除前发到(来不及发 FIN 的场景);
//   ③ 心跳空闲超时 → 兜住崩溃 / 断网这类「没打招呼就消失」的情况。
//
// 本文件锁定的契约:
//   1. 本机实例告别 → 立即标离线,且**队列一律不动**(local_queues 是服务端权威数据,
//      关页面只是「没人听了」,重开靠稳定 clientId 认领回同一条队列);
//   2. 重复告别幂等,不重复广播 peer_unavailable;
//   3. 旧格式 local:<userId>(无 clientId,没有实例维度可判)与**非本机** peer → 400,
//      绝不误伤投屏设备 / 群组。
import "../plugins/_env.js";
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from "vitest";
import { Hono } from "hono";
import { v4 as uuidv4 } from "uuid";
import { db, initDatabase, encryptPassword } from "../../src/db/index.js";
import { users, localQueues } from "../../src/db/schema.js";
import { eq } from "drizzle-orm";
import { authMiddleware } from "../../src/middleware/auth.js";
import { apiRoutes } from "../../src/routes/api/index.js";
import { generateToken } from "../../src/utils/auth.js";
import { getPeerManager } from "../../src/services/peer.js";
import { getPreProbeScheduler } from "../../src/services/player/preProbeScheduler.js";

const app = new Hono();
app.use("/rest/api/*", authMiddleware);
app.route("/rest/api", apiRoutes);

let uid = "";
let clientId = "";

beforeAll(() => {
  initDatabase();
});

beforeEach(() => {
  db.delete(localQueues).run();
  uid = uuidv4();
  clientId = `web-${Math.random().toString(36).slice(2, 10)}`;
  db.insert(users)
    .values({
      id: uid,
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
});

afterEach(() => {
  vi.restoreAllMocks();
  getPreProbeScheduler().resetForTest();
});

function authHeaders(cid?: string) {
  const h: Record<string, string> = {
    Authorization: `Bearer ${generateToken(uid, "tester", true)}`,
    "content-type": "application/json",
  };
  if (cid) h["x-mf-client-id"] = cid;
  return h;
}

/** 注册一个本机实例,返回「调用方视角」的 peerId(带不透明实例键)。 */
async function register(cid: string): Promise<string> {
  const res = await app.request("/rest/api/v1/peers/register", {
    method: "POST",
    headers: authHeaders(cid),
    body: JSON.stringify({ clientId: cid }),
  });
  const body = (await res.json()) as any;
  return body.peer.peerId as string;
}

function seedQueue(internalPeerId: string, n: number): void {
  const items = Array.from({ length: n }, (_, i) => ({ songId: `s${i + 1}`, title: `T${i + 1}` }));
  const now = new Date().toISOString();
  db.insert(localQueues)
    .values({
      peerId: internalPeerId,
      userId: uid,
      itemsJson: JSON.stringify(items),
      currentIndex: 0,
      playMode: "order",
      isActive: 1,
      lastActiveAt: now,
      updatedAt: now,
    })
    .run();
}

function queueRow(internalPeerId: string) {
  return db.select().from(localQueues).where(eq(localQueues.peerId, internalPeerId)).get();
}

function offline(peerId: string, cid: string) {
  return app.request(`/rest/api/v1/peers/${encodeURIComponent(peerId)}/offline`, {
    method: "POST",
    headers: authHeaders(cid),
    body: "{}",
  });
}

describe("POST /v1/peers/:peerId/offline", () => {
  it("告别成功:立即标离线 + 清预探测,队列原样保留", async () => {
    const pm = getPeerManager();
    const masked = await register(clientId);
    const internal = `local:${uid}:${clientId}`;
    seedQueue(internal, 2);

    const clearSpy = vi.spyOn(getPreProbeScheduler(), "clear");
    expect(pm.get(internal)?.available).toBe(true);

    const res = await offline(masked, clientId);
    const body = (await res.json()) as any;
    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.offline).toBe(true);

    expect(pm.get(internal)?.available).toBe(false);
    expect(clearSpy).toHaveBeenCalledWith(internal);
    // 队列不动 —— 这是「打开时自动恢复」的前提
    const row = queueRow(internal);
    expect(row).toBeTruthy();
    expect(JSON.parse(row!.itemsJson)).toHaveLength(2);
  });

  it("重复告别幂等:不重复广播 peer_unavailable(多标签页逐条断开)", async () => {
    const pm = getPeerManager();
    const masked = await register(clientId);
    const internal = `local:${uid}:${clientId}`;

    await offline(masked, clientId);
    expect(pm.get(internal)?.available).toBe(false);

    let events = 0;
    pm.on("peer_unavailable", () => { events++; });
    const res = await offline(masked, clientId);
    expect(res.status).toBe(200);
    expect(events).toBe(0);
  });

  it("旧格式 local:<userId> 由解析层升级成调用方自己的实例,照样生效", async () => {
    // 老客户端只见过 local:<userId>。resolveLocalPeerId 会把它**升级**成本次请求
    // 上报的 clientId 对应的实例(见 utils/peerId.ts),所以「我走了」照样落到自己头上,
    // 不该被当成非法 peerId 拒掉。
    const pm = getPeerManager();
    const internal = `local:${uid}:${clientId}`;
    pm.registerLocal(uid, "tester", clientId);

    const res = await offline(`local:${uid}`, clientId);
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.offline).toBe(true);
    expect(pm.get(internal)?.available).toBe(false);
  });

  it("非本机 peer(投屏设备 / 群组)直接 400,绝不误伤", async () => {
    for (const pid of ["dlna:some-device", "group:some-group", "airplay:some-device"]) {
      const res = await offline(pid, clientId);
      expect(res.status).toBe(400);
      const body = (await res.json()) as any;
      expect(body.offline).toBe(false);
    }
  });
});
