// 本机播放端(Web 页面 / 客户端)的「上下线生命周期」契约测试。
//
// 背景:Web 页面在服务端**不是一个进程** —— 前端是 vite 构建产物,由 Hono 静态托管;
// 服务端感知「还有没有人开着页面」只有两条路:
//   ① WS 连接 —— 正常关标签页时,由该端最后一条 connection close 秒级感知
//      (见 services/ws/index.ts 的引用计数 → markLocalOfflineByClient);
//   ② HTTP 心跳 —— 兜住崩溃 / 断网 / 休眠这类「没打招呼就消失」的情况(WS 半开时
//      TCP 不会立刻报 FIN),空闲超过门槛才标离线。
//
// 本文件锁定两件事:
//   1. 心跳空闲门槛**可配**(设置项 peer_idle_minutes),缺省 2 分钟;非法值回退缺省。
//   2. 下线只清「有人在听才有用」的内存态(预探测),**队列一律不动** ——
//      local_queues 是服务端权威数据,它的生命周期与页面开不开无关:关掉页面只是
//      「没人听了」,不等于这个端的播放列表作废(重开标签页靠稳定 clientId 认领回来)。
import "../plugins/_env.js";
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from "vitest";
import { v4 as uuidv4 } from "uuid";
import { db, initDatabase, encryptPassword } from "../../src/db/index.js";
import { users, localQueues, settings } from "../../src/db/schema.js";
import { eq } from "drizzle-orm";
import { getPeerManager, peerIdleTimeoutMs } from "../../src/services/peer.js";
import { getPreProbeScheduler } from "../../src/services/player/preProbeScheduler.js";
import { setSetting, _resetSettingsCacheForTest } from "../../src/services/settings.js";

const MIN = 60_000;

beforeAll(() => {
  initDatabase();
});

let uid = "";
let clientId = "";

beforeEach(() => {
  // 设置项带 5s 内存缓存,且 settings 表会在用例间残留 —— 两者都清,避免顺序耦合。
  _resetSettingsCacheForTest();
  db.delete(settings).run();
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
  _resetSettingsCacheForTest();
});

/** 直接插一条 local_queues 行(避开 localPlayFrom 的 QueueItem 类型细节)。 */
function seedQueue(peerId: string, n: number): void {
  const items = Array.from({ length: n }, (_, i) => ({ songId: `s${i + 1}`, title: `T${i + 1}` }));
  const now = new Date().toISOString();
  db.insert(localQueues)
    .values({
      peerId,
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

function queueRow(peerId: string) {
  return db.select().from(localQueues).where(eq(localQueues.peerId, peerId)).get();
}

describe("心跳空闲门槛", () => {
  it("缺省 2 分钟", () => {
    expect(peerIdleTimeoutMs()).toBe(2 * MIN);
  });

  it("设置项 peer_idle_minutes 生效", () => {
    setSetting("peer_idle_minutes", "7");
    expect(peerIdleTimeoutMs()).toBe(7 * MIN);
  });

  it("非法值一律回退缺省(0 / 负数 / 非数字 / 空串)", () => {
    for (const bad of ["0", "-3", "abc", ""]) {
      setSetting("peer_idle_minutes", bad);
      expect(peerIdleTimeoutMs()).toBe(2 * MIN);
    }
  });
});

describe("下线:只清内存态,队列不动", () => {
  it("标离线 + 清预探测,local_queues 原样保留", () => {
    const pm = getPeerManager();
    const peerId = pm.registerLocal(uid, "tester", clientId).peerId;
    seedQueue(peerId, 2);

    const pp = getPreProbeScheduler();
    const clearSpy = vi.spyOn(pp, "clear");

    expect(pm.get(peerId)?.available).toBe(true);

    pm.markLocalOfflineByClient(uid, clientId);

    // 1) 标记为不在线
    expect(pm.get(peerId)?.available).toBe(false);
    // 2) 预探测被清 —— 没人听了还继续探测下一首纯属空转
    expect(clearSpy).toHaveBeenCalledWith(peerId);
    // 3) 队列原样在 —— 关掉页面不等于这个端的播放列表作废
    const row = queueRow(peerId);
    expect(row).toBeTruthy();
    expect(JSON.parse(row!.itemsJson)).toHaveLength(2);
  });

  it("已离线的端再下线一次是幂等的(多标签页逐条断开时不重复广播)", () => {
    const pm = getPeerManager();
    const peerId = pm.registerLocal(uid, "tester", clientId).peerId;

    pm.markLocalOfflineByClient(uid, clientId);
    expect(pm.get(peerId)?.available).toBe(false);

    let events = 0;
    pm.on("peer_unavailable", () => { events++; });
    pm.markLocalOfflineByClient(uid, clientId);
    expect(events).toBe(0);
  });

  it("非本机端 / 未知端调用不抛错", () => {
    const pm = getPeerManager();
    expect(() => pm.markLocalOfflineByClient("", "")).not.toThrow();
    expect(() => pm.markLocalOfflineByClient(uid, "no-such-client")).not.toThrow();
  });
});
