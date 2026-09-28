// ==================== PeerManager:投屏队列快照委派 + 本机队列的边角 ====================
//
// 既有 tests/services/peerManager.test.ts 与 peerCleanup.test.ts 把**本机(local:)链路**
// 照得比较全(注册/心跳/状态上报/队列 CRUD/回收),但 `getQueueSnapshot` 的
// **投屏分支**一直是靠路由层契约测试里的假体替过去的 —— 真身「把带前缀的 peerId 剥成
// 裸 id 再问 QueueController」这段从来没被测过。三端切歌器、HA 卡片读的就是这个快照,
// 剥错前缀 = 读到另一台设备的队列。
//
// 本文件补三段:
//   ① getQueueSnapshot 对 dlna / group / airplay / sendspin 四种 kind 的委派与剥前缀;
//   ② 本机起播的「起始位置只随当次广播带出一次」(pendingStartPosition 的一次性语义);
//   ③ 本机队列 CRUD 的几条边角(reshuffleLocal 无行、localSetPlayMode 无行、删到空)。
//
// 真身保留:sqlite(队列是服务端权威数据,必须落真库)、PeerManager 自身的状态机。
// 换成假体的只有发现源与投屏队列管理器(真货要发 SSDP/mDNS、要建播放链路)。
// MUST be the first import:把 DATA_DIR 指到本文件专属的隔离目录。
import "../plugins/_env.js";

import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";

type Any = any;

const H = vi.hoisted(() => ({
  /** QueueController 替身:key → 快照。key 是**裸 id**(剥前缀后的结果)。 */
  castSnapshots: new Map<string, Any>(),
  /** 被问过的 key 序列(用来验证剥前缀的结果)。 */
  asked: [] as string[],
  events: [] as Array<{ name: string; args: Any[] }>,
}));

// 投屏/群组队列由 QueueController 持有;这里只记录"被问了哪个裸 id"。
vi.mock("../../src/services/dlna/queue.js", () => ({
  getQueueManager: () => ({
    snapshot: (id: string) => {
      H.asked.push(id);
      return H.castSnapshots.get(id) ?? { items: [], currentIndex: -1, playMode: "order", isActive: false, ended: false };
    },
    clear: () => {},
  }),
}));

vi.mock("../../src/services/dlna/control.js", () => ({ getCachedDevices: () => [] }));

vi.mock("../../src/services/dlna/eventing.js", () => ({
  getEventManager: () => ({ on: () => {}, emit: () => {} }),
}));

vi.mock("../../src/services/group/index.js", () => ({
  getGroupManager: () => ({ list: () => [], resolveMemberStates: () => [], get: () => undefined, groupsOfDevice: () => [] }),
}));

vi.mock("../../src/services/airplay/discovery.js", () => ({
  getAirPlayDevices: () => [],
  onAirPlayEvent: () => () => {},
}));

vi.mock("../../src/services/player/preProbeScheduler.js", () => ({
  getPreProbeScheduler: () => ({
    addOnChange: () => {},
    schedule: () => {},
    clear: () => {},
    status: () => ({ ready: 0, scanned: 0, misses: 0, exhausted: false, cooldownUntil: null, at: 0 }),
  }),
}));

import { PeerManager, parsePeerId } from "../../src/services/peer.js";
import { initDatabase, sqlite } from "../../src/db/index.js";

const UID = "u1";

function newPm() {
  const pm = new PeerManager();
  const any = pm as Any;
  any.on("peer_queue_changed", (id: string, snap: Any) => H.events.push({ name: "peer_queue_changed", args: [id, snap] }));
  any.on("peer_volume_changed", (...rest: Any[]) => H.events.push({ name: "peer_volume_changed", args: rest }));
  return pm;
}

beforeAll(() => {
  initDatabase();
  sqlite.prepare("INSERT OR IGNORE INTO users (id, username, password, salt, subsonic_salt, is_admin, is_active, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?)")
    .run(UID, "u1", "", "s", "s", 0, 1, new Date().toISOString(), new Date().toISOString());
});

beforeEach(() => {
  H.asked = [];
  H.events = [];
  H.castSnapshots = new Map();
  sqlite.prepare("DELETE FROM local_queues").run();
});

// ==================== 投屏/群组队列快照的委派 ====================

describe("getQueueSnapshot —— 四种投屏 kind 一律按裸 id 问 QueueController", () => {
  const kinds: Array<[string, string, string]> = [
    ["dlna", "dev-1", "dlna:dev-1"],
    ["group", "grp-1", "group:grp-1"],
    ["airplay", "ap-1", "airplay:ap-1"],
    ["sendspin", "sp-1", "sendspin:sp-1"],
  ];

  for (const [kind, bare, peerId] of kinds) {
    it(`${kind}:剥掉前缀后用裸 id 取快照(投屏队列的 key 就是裸 id)`, () => {
      const snap = { items: [{ songId: "x" }], currentIndex: 2, playMode: "all", isActive: true, ended: false };
      H.castSnapshots.set(bare, snap);
      const pm = newPm();
      expect(pm.getQueueSnapshot(peerId)).toEqual(snap);
      // 剥错前缀会读到另一台设备的队列(或空快照),这里钉死"问的是谁"。
      expect(H.asked).toEqual([bare]);
    });
  }

  it("带前缀的是设备型 peer,不落本机队列(local_queues 不被写)", () => {
    const pm = newPm();
    pm.getQueueSnapshot("dlna:dev-1");
    expect(sqlite.prepare("SELECT COUNT(*) AS n FROM local_queues").get()).toEqual({ n: 0 });
  });

  it("无法解析的 peerId → undefined(不是空快照,调用方据此跳过)", () => {
    const pm = newPm();
    expect(pm.getQueueSnapshot("bogus:dev-1")).toBeUndefined();
    expect(parsePeerId("bogus:dev-1")).toBeNull();
  });
});

// ==================== 本机起播的一次性起始位置 ====================

describe("localPlayFrom —— 起始位置只随当次广播带出一次", () => {
  it("带 startPosition 起播:广播的快照里带 startPosition,之后轮询不再带", () => {
    const pm = newPm();
    const peerId = `local:${UID}:c1`;
    const items = [
      { songId: "s1", title: "t1", mime: "audio/mpeg", duration: 100 },
      { songId: "s2", title: "t2", mime: "audio/mpeg", duration: 100 },
    ];
    pm.localPlayFrom(peerId, UID, items, 0, 42);

    // 契约:起点是"这一刻刚流转过来的位置",不是队列属性。若它留在快照里,
    // 客户端每次轮询都会被拉回同一个位置(表现为"拖动后又被弹回去")。
    const broadcast = H.events.filter((e) => e.name === "peer_queue_changed");
    expect(broadcast).toHaveLength(1);
    expect(broadcast[0].args[1].startPosition).toBe(42);
    expect(pm.getQueueSnapshot(peerId)!.startPosition).toBeUndefined();
  });

  it("startPosition 为 0 / 负数 / 非数字 → 不带起始位置(客户端从头播)", () => {
    const pm = newPm();
    const items = [{ songId: "s1", title: "t1", mime: "audio/mpeg", duration: 100 }];
    for (const bad of [0, -5, Number.NaN]) {
      H.events = [];
      pm.localPlayFrom(`local:${UID}:c2`, UID, items, 0, bad);
      expect(H.events[0].args[1].startPosition).toBeUndefined();
    }
  });
});

// ==================== 本机队列 CRUD 的边角 ====================

describe("reshuffleLocal —— 只服务已存在的队列", () => {
  it("无队列行 → undefined 且不广播(凭空造一条空队列没有意义)", () => {
    const pm = newPm();
    expect(pm.reshuffleLocal(`local:${UID}:ghost`)).toBeUndefined();
    expect(H.events.filter((e) => e.name === "peer_queue_changed")).toHaveLength(0);
  });

  it("有队列行 → 重洗并广播新序列(客户端在序列尾回绕时靠它换版)", () => {
    const pm = newPm();
    const peerId = `local:${UID}:c3`;
    pm.localPlayFrom(peerId, UID, [
      { songId: "a", title: "t", mime: "audio/mpeg" },
      { songId: "b", title: "t", mime: "audio/mpeg" },
      { songId: "c", title: "t", mime: "audio/mpeg" },
    ], 0);
    pm.localSetPlayMode(peerId, "shuffle");
    const before = pm.getQueueSnapshot(peerId)!;
    H.events = [];

    const after = pm.reshuffleLocal(peerId);
    expect(after).toBeDefined();
    expect(after!.shuffleOrder).toBeDefined();
    // epoch 每次重洗 +1,客户端据此重新定位当前曲在新序列中的位置。
    expect(after!.shuffleEpoch).toBe((before.shuffleEpoch ?? 0) + 1);
    expect(H.events.filter((e) => e.name === "peer_queue_changed")).toHaveLength(1);
  });
});

describe("localSetPlayMode —— 行不存在时不建行", () => {
  it("无队列行 → no-op(播放模式不能凭空建出一条空队列)", () => {
    const pm = newPm();
    const peerId = `local:${UID}:ghost2`;
    pm.localSetPlayMode(peerId, "shuffle");
    expect(sqlite.prepare("SELECT COUNT(*) AS n FROM local_queues").get()).toEqual({ n: 0 });
  });

  it("切到非 shuffle → 丢掉服务端洗牌序列(本机随机的权威回到客户端)", () => {
    const pm = newPm();
    const peerId = `local:${UID}:c4`;
    pm.localPlayFrom(peerId, UID, [
      { songId: "a", title: "t", mime: "audio/mpeg" },
      { songId: "b", title: "t", mime: "audio/mpeg" },
    ], 0);
    pm.localSetPlayMode(peerId, "shuffle");
    expect(pm.getQueueSnapshot(peerId)!.shuffleOrder).toBeDefined();

    pm.localSetPlayMode(peerId, "order");
    // 序列是服务端的内存账本,模式一变必须作废 —— 否则 order 模式下发的快照
    // 还带着随机序列,客户端会照着它跳歌。
    expect(pm.getQueueSnapshot(peerId)!.shuffleOrder).toBeUndefined();
  });
});

describe("localRemoveAt —— 删到边界的游标收口", () => {
  const items = () => [
    { songId: "a", title: "t", mime: "audio/mpeg" },
    { songId: "b", title: "t", mime: "audio/mpeg" },
    { songId: "c", title: "t", mime: "audio/mpeg" },
  ];

  it("删的是最后一项且它是当前曲 → 游标回落到新的末位(不越界)", () => {
    const pm = newPm();
    const peerId = `local:${UID}:c5`;
    pm.localPlayFrom(peerId, UID, items(), 2);
    pm.localRemoveAt(peerId, 2);
    const snap = pm.getQueueSnapshot(peerId)!;
    expect(snap.items).toHaveLength(2);
    expect(snap.currentIndex).toBe(1);
    expect(snap.items[snap.currentIndex].songId).toBe("b");
  });

  it("删空 → 游标 -1 且队列不再激活", () => {
    const pm = newPm();
    const peerId = `local:${UID}:c6`;
    pm.localPlayFrom(peerId, UID, [{ songId: "a", title: "t", mime: "audio/mpeg" }], 0);
    pm.localRemoveAt(peerId, 0);
    const snap = pm.getQueueSnapshot(peerId)!;
    expect(snap.items).toHaveLength(0);
    expect(snap.currentIndex).toBe(-1);
    expect(snap.isActive).toBe(false);
  });

  it("越界下标 → 整段 no-op(不改动队列)", () => {
    const pm = newPm();
    const peerId = `local:${UID}:c7`;
    pm.localPlayFrom(peerId, UID, items(), 1);
    pm.localRemoveAt(peerId, 99);
    pm.localRemoveAt(peerId, -1);
    const snap = pm.getQueueSnapshot(peerId)!;
    expect(snap.items).toHaveLength(3);
    expect(snap.currentIndex).toBe(1);
  });
});

describe("notifyPeerVolume —— 空 peerId 直接忽略", () => {
  it("不发事件(避免 WS 层把变化广播给无权连接)", () => {
    const pm = newPm();
    pm.notifyPeerVolume("", 50, false);
    expect(H.events.filter((e) => e.name === "peer_volume_changed")).toHaveLength(0);
    pm.notifyPeerVolume("sendspin:sp-1", 50, true);
    expect(H.events.filter((e) => e.name === "peer_volume_changed")).toHaveLength(1);
  });
});
