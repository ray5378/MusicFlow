// ==================== PeerManager 的清扫与发现面 ====================
//
// peerManager.test.ts 覆盖的是「注册 / 查询 / 本机队列 CRUD / 状态上报」;
// 本文件补 peer.ts 剩下的三块,它们此前**一行都没被跑到**:
//
//   ① `startCleanup()` —— 启动接线:60s 周期扫描 + 5s 首次填充 + **20s 重启清扫**
//      + 两条发现桥(device_list_changed → 重算 DLNA peer;AirPlay alive/byebye →
//      重算 / 立即标离线)。桥接断了不会报错,只会让可用性永远停在旧值。
//   ② `reconcile*` 的「已有 peer」分支 —— 上线/下线事件只在**状态真的翻转**时发,
//      重复轮询不得反复广播(否则 HA 卡片/Web 切换器会刷屏)。
//   ③ `runCleanup` + `sweepStaleQueues` —— 队列回收的**双条件**:队列 6h 未变动
//      **且**播放端离线 6h 才清;还连着的端无论多安静都保留(单曲循环/长时间暂停
//      不能被误清)。这是唯一会真的 `DELETE` 队列行的路径,必须钉死。
//
// 发现源(mDNS / SSDP / 组管理 / 预探测调度器)一律 mock —— 只验证 PeerManager
// 自身对输入的解读,不触网、不起真定时器。
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from "vitest";

type Any = any;

const H = vi.hoisted(() => ({
  cachedDevices: [] as Any[],
  apDevices: [] as Any[],
  apEventCb: null as null | ((e: Any) => void),
  eventHandlers: new Map<string, (e: Any) => void>(),
  groups: [] as Any[],
  memberStates: [] as Any[],
  probeClears: [] as string[],
  probeSchedules: [] as string[],
  queueClears: [] as string[],
}));

vi.mock("../../src/services/dlna/control.js", () => ({
  getCachedDevices: () => H.cachedDevices,
}));

vi.mock("../../src/services/dlna/eventing.js", () => ({
  getEventManager: () => ({
    on: (ev: string, cb: (e: Any) => void) => { H.eventHandlers.set(ev, cb); },
  }),
}));

vi.mock("../../src/services/airplay/discovery.js", () => ({
  getAirPlayDevices: () => H.apDevices,
  onAirPlayEvent: (cb: (e: Any) => void) => { H.apEventCb = cb; },
}));

vi.mock("../../src/services/group/index.js", () => ({
  getGroupManager: () => ({
    list: () => H.groups,
    resolveMemberStates: () => H.memberStates,
  }),
}));

vi.mock("../../src/services/player/preProbeScheduler.js", () => ({
  getPreProbeScheduler: () => ({
    addOnChange: () => undefined,
    clear: (peerId: string) => { H.probeClears.push(peerId); },
    schedule: (peerId: string) => { H.probeSchedules.push(peerId); },
    status: () => ({ ready: 0, scanned: 0, misses: 0, exhausted: false, cooldownUntil: null, at: 0 }),
  }),
}));

vi.mock("../../src/services/dlna/queue.js", () => ({
  getQueueManager: () => ({
    clear: (id: string) => { H.queueClears.push(id); },
    snapshot: () => undefined,
  }),
}));

import { PeerManager } from "../../src/services/peer.js";
import { sqlite } from "../../src/db/index.js";

const HOUR = 60 * 60 * 1000;

function iso(msAgo: number): string {
  return new Date(Date.now() - msAgo).toISOString();
}

function localQueueRow(peerId: string, opts: { itemsJson?: string; updatedAgoMs?: number; activeAgoMs?: number } = {}) {
  sqlite.prepare(
    "INSERT OR REPLACE INTO local_queues (peer_id, user_id, items_json, current_index, play_mode, is_active, last_active_at, updated_at) VALUES (?,?,?,?,?,?,?,?)",
  ).run(
    peerId, "pu1", opts.itemsJson ?? JSON.stringify([{ songId: "s1" }]), 0, "order", 1,
    iso(opts.activeAgoMs ?? 8 * HOUR), iso(opts.updatedAgoMs ?? 8 * HOUR),
  );
}

function deviceQueueRow(deviceId: string, opts: { itemsJson?: string; updatedAgoMs?: number } = {}) {
  sqlite.prepare(
    "INSERT OR REPLACE INTO device_queues (device_id, items_json, current_index, play_mode, is_active, updated_at) VALUES (?,?,?,?,?,?)",
  ).run(deviceId, opts.itemsJson ?? JSON.stringify([{ songId: "s1" }]), 0, "order", 1, iso(opts.updatedAgoMs ?? 8 * HOUR));
}

function groupQueueRow(groupId: string, opts: { itemsJson?: string; updatedAgoMs?: number } = {}) {
  sqlite.prepare(
    "INSERT OR REPLACE INTO group_queues (group_id, items_json, current_index, play_mode, is_active, updated_at) VALUES (?,?,?,?,?,?)",
  ).run(groupId, opts.itemsJson ?? JSON.stringify([{ songId: "s1" }]), 0, "order", 1, iso(opts.updatedAgoMs ?? 8 * HOUR));
}

let seq = 0;
function uniq(prefix: string): string {
  seq++;
  return `${prefix}-${process.pid}-${seq}`;
}

beforeAll(() => {
  if (!process.env.APP_VERSION) process.env.APP_VERSION = "1.0.0";
  // local_queues.user_id 有外键约束 → 先落一个属主用户。
  sqlite.prepare("INSERT OR IGNORE INTO users (id, username, password, salt, subsonic_salt) VALUES (?,?,?,?,?)")
    .run("pu1", "peeruser", "", "s", "ss");
});

beforeEach(() => {
  H.cachedDevices = [];
  H.apDevices = [];
  H.apEventCb = null;
  H.eventHandlers = new Map();
  H.groups = [];
  H.memberStates = [];
  H.probeClears = [];
  H.probeSchedules = [];
  H.queueClears = [];
  // 队列行是共享 SQLite 里的全局数据:每个用例自带干净起点,否则前一条留下的
  // 陈旧行会在本条的 sweep 里被回收,污染「谁被回收」的断言。
  sqlite.prepare("DELETE FROM local_queues").run();
  sqlite.prepare("DELETE FROM device_queues").run();
  sqlite.prepare("DELETE FROM group_queues").run();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("startCleanup:周期扫描与发现桥", () => {
  it("60s 周期跑一轮「三个重算 + 清扫」;重复调用不叠加定时器", async () => {
    vi.useFakeTimers();
    const pm = new PeerManager();
    const dlna = vi.spyOn(pm, "reconcileDlnaPeers");
    const grp = vi.spyOn(pm, "reconcileGroupPeers");
    const ap = vi.spyOn(pm, "reconcileAirPlayPeers");
    const sweep = vi.spyOn(pm as Any, "runCleanup");

    pm.startCleanup();
    pm.startCleanup();                 // 幂等:不再起第二个 interval
    expect((pm as Any).cleanupTimer).toBeTruthy();

    await vi.advanceTimersByTimeAsync(60_000);
    // 60s 那一拍必须把四个动作都跑一遍(5s/20s 的启动钩子也会各自跑过一遍)
    expect(dlna).toHaveBeenCalled();
    expect(grp).toHaveBeenCalled();
    expect(ap).toHaveBeenCalled();
    expect(sweep).toHaveBeenCalled();

    clearInterval((pm as Any).cleanupTimer);
    (pm as Any).cleanupTimer = null;
  });

  it("启动后 5s 先填充一次 peer 列表(不等 60s 首拍)", async () => {
    vi.useFakeTimers();
    const pm = new PeerManager();
    const dlna = vi.spyOn(pm, "reconcileDlnaPeers");
    const grp = vi.spyOn(pm, "reconcileGroupPeers");
    const ap = vi.spyOn(pm, "reconcileAirPlayPeers");
    pm.startCleanup();
    await vi.advanceTimersByTimeAsync(5_000);
    expect([dlna.mock.calls.length, grp.mock.calls.length, ap.mock.calls.length]).toEqual([1, 1, 1]);
    clearInterval((pm as Any).cleanupTimer);
    (pm as Any).cleanupTimer = null;
  });

  it("启动后 20s 跑重启清扫(清掉容器重启留下的陈旧队列行)", async () => {
    vi.useFakeTimers();
    const pm = new PeerManager();
    const sweep = vi.spyOn(pm as Any, "runCleanup");
    pm.startCleanup();
    await vi.advanceTimersByTimeAsync(20_000);
    expect(sweep).toHaveBeenCalledTimes(1);
    clearInterval((pm as Any).cleanupTimer);
    (pm as Any).cleanupTimer = null;
  });

  it("重启清扫里任一步抛错 → 记 error 而不是让定时器回调炸掉", async () => {
    vi.useFakeTimers();
    const pm = new PeerManager();
    // 5s 引导钩子先跑一次(那一条**没有** try/catch);20s 这一条有,必须吞住。
    let calls = 0;
    vi.spyOn(pm, "reconcileDlnaPeers").mockImplementation(() => {
      calls++;
      if (calls > 1) throw new Error("发现未就绪");
    });
    pm.startCleanup();
    // 抛错被那条 try/catch 吞住 → 这里不会 reject(否则 await 会直接把用例打挂)
    await vi.advanceTimersByTimeAsync(20_000);
    expect(calls).toBe(2);
    clearInterval((pm as Any).cleanupTimer);
    (pm as Any).cleanupTimer = null;
  });

  it("现状记录(缺陷台账 D16):5s 引导钩子与 60s 周期钩子都没有 try/catch,发现源抛错会成为未捕获异常", async () => {
    // 只有 20s「重启清扫」那一条包了 try/catch;5s 填充与 60s 周期两条直接裸调。
    // 发现源(mDNS / SSDP 缓存)一旦抛错,这里就是**未捕获异常** —— Node 默认行为是
    // 终止进程,而它每 60s 就会再来一次。修法(给三条钩子统一包一层)会改变产品行为,
    // 故按台账挂起;修复后本断言应改为 resolves。
    vi.useFakeTimers();
    const pm = new PeerManager();
    vi.spyOn(pm, "reconcileDlnaPeers").mockImplementation(() => { throw new Error("发现源不可用"); });
    pm.startCleanup();
    await expect(vi.advanceTimersByTimeAsync(5_000)).rejects.toThrow("发现源不可用");
    clearInterval((pm as Any).cleanupTimer);
    (pm as Any).cleanupTimer = null;
  });

  it("DLNA 发现变化 → 立即重算 peer 集合,不等下一拍", () => {
    vi.useFakeTimers();
    const pm = new PeerManager();
    const dlna = vi.spyOn(pm, "reconcileDlnaPeers");
    pm.startCleanup();
    const cb = H.eventHandlers.get("device_list_changed");
    expect(cb).toBeTruthy();
    cb!({});
    expect(dlna).toHaveBeenCalledTimes(1);
  });

  it("AirPlay alive → 重算;byebye → 立即把该 peer 标离线", () => {
    vi.useFakeTimers();
    const pm = new PeerManager();
    const ap = vi.spyOn(pm, "reconcileAirPlayPeers");
    pm.startCleanup();
    const id = uniq("ap");
    H.apDevices = [{ id, name: "HomePod", alias: "", available: true, disabled: false }];
    H.apEventCb!({ type: "alive", id });
    expect(ap).toHaveBeenCalledTimes(1);
    expect(pm.get(`airplay:${id}`)!.available).toBe(true);

    const events: string[] = [];
    pm.on("peer_unavailable", (p) => events.push(p.peerId));
    H.apEventCb!({ type: "byebye", id });
    expect(pm.get(`airplay:${id}`)!.available).toBe(false);
    expect(events).toEqual([`airplay:${id}`]);
    pm.removeAirPlayPeers();
  });
});

describe("发现重算:状态翻转才发事件", () => {
  it("DLNA:重复发现不重复广播;真正掉线才发 peer_unavailable", () => {
    const pm = new PeerManager();
    const id = uniq("dlna");
    const events: string[] = [];
    pm.on("peer_unavailable", (p) => events.push(p.peerId));
    pm.on("peer_available", (p) => events.push(p.peerId));

    pm.registerDlna(id, "音箱", true);        // 首次注册(只发 peer_registered)
    pm.registerDlna(id, "音箱改名", true);     // 仍在线 → 不发任何翻转事件
    expect(events).toEqual([]);
    pm.registerDlna(id, "音箱", false);        // 掉线 → unavailable
    expect(events).toEqual([`dlna:${id}`]);
    pm.registerDlna(id, "音箱", false);        // 仍然掉线 → 不重复
    expect(events).toEqual([`dlna:${id}`]);
    pm.registerDlna(id, "音箱", true);         // 回归 → available
    expect(events).toEqual([`dlna:${id}`, `dlna:${id}`]);
    pm.removeDlnaPeer(id);
  });

  it("AirPlay:同名设备重复注册只更新名与活跃度", () => {
    const pm = new PeerManager();
    const id = uniq("ap");
    const events: string[] = [];
    pm.on("peer_available", (p) => events.push(p.peerId));
    pm.on("peer_unavailable", (p) => events.push(p.peerId));

    pm.registerAirPlay(id, "旧名", true);
    pm.registerAirPlay(id, "新名", true);      // 仍在线 → 无翻转事件
    expect(pm.get(`airplay:${id}`)!.name).toBe("新名");
    expect(events).toEqual([]);
    pm.registerAirPlay(id, "新名", false);
    pm.registerAirPlay(id, "新名", true);
    expect(events).toEqual([`airplay:${id}`, `airplay:${id}`]);
    pm.removeAirPlayPeers();
  });

  it("Sendspin:重连时只有 available 真的翻转才广播", () => {
    const pm = new PeerManager();
    const id = uniq("sp");
    const events: string[] = [];
    pm.on("peer_available", (p) => events.push(p.peerId));
    pm.on("peer_unavailable", (p) => events.push(p.peerId));

    pm.registerSendspin(id, "客户端", true);
    pm.registerSendspin(id, "客户端", true, true);   // 明文标记变化不算可用性翻转
    expect(events).toEqual([]);
    pm.registerSendspin(id, "客户端", false);
    pm.registerSendspin(id, "客户端", true);
    expect(events).toEqual([`sendspin:${id}`, `sendspin:${id}`]);
    pm.removeSendspinPeers();
  });

  it("reconcileDlnaPeers:禁用设备直接移除;从缓存消失的标离线(保留行)", () => {
    const pm = new PeerManager();
    const keep = uniq("dlna");
    const gone = uniq("dlna");
    const banned = uniq("dlna");
    H.cachedDevices = [
      { id: keep, name: "A", alias: "客厅", available: true, disabled: false },
      { id: gone, name: "B", available: true, disabled: false },
      { id: banned, name: "C", available: true, disabled: true },
    ];
    pm.reconcileDlnaPeers();
    expect(pm.get(`dlna:${keep}`)!.name).toBe("客厅");   // alias 优先
    expect(pm.get(`dlna:${banned}`)).toBeUndefined();     // 禁用 → 不进列表

    // 发现掉了一个(设备离线 / SSDP 没回)→ 标不可用但保留(UI 显示「最后在线」)
    const events: string[] = [];
    pm.on("peer_unavailable", (p) => events.push(p.peerId));
    H.cachedDevices = [{ id: keep, name: "A", alias: "客厅", available: true, disabled: false }];
    pm.reconcileDlnaPeers();
    expect(pm.get(`dlna:${gone}`)!.available).toBe(false);
    expect(events).toEqual([`dlna:${gone}`]);
    // 再跑一次:已经是不可用 → 不重复广播
    pm.reconcileDlnaPeers();
    expect(events).toEqual([`dlna:${gone}`]);
    pm.removeDlnaPeer(keep);
    pm.removeDlnaPeer(gone);
  });

  it("reconcileAirPlayPeers:别名优先、禁用即摘除、掉出 mDNS 标离线", () => {
    const pm = new PeerManager();
    const ok = uniq("ap");
    const banned = uniq("ap");
    H.apDevices = [
      { id: ok, name: "HomePod", alias: "  主卧  ", available: true, disabled: false },
      { id: banned, name: "旧设备", alias: "", available: true, disabled: true },
    ];
    pm.reconcileAirPlayPeers();
    expect(pm.get(`airplay:${ok}`)!.name).toBe("主卧");     // alias 去空格
    expect(pm.get(`airplay:${banned}`)).toBeUndefined();     // 禁用 → 从列表移除

    const events: string[] = [];
    pm.on("peer_unavailable", (p) => events.push(p.peerId));
    H.apDevices = [];
    pm.reconcileAirPlayPeers();
    expect(pm.get(`airplay:${ok}`)!.available).toBe(false);
    expect(events).toEqual([`airplay:${ok}`]);
    pm.removeAirPlayPeers();
  });
});

describe("getQueueSnapshot / 预探测源的容错", () => {
  it("本机队列行 JSON 损坏 → 回落空快照(不抛)", () => {
    const pm = new PeerManager();
    const peerId = `local:pu1:${uniq("badjson")}`;
    sqlite.prepare(
      "INSERT OR REPLACE INTO local_queues (peer_id, user_id, items_json, current_index, play_mode, is_active, last_active_at, updated_at) VALUES (?,?,?,?,?,?,?,?)",
    ).run(peerId, "pu1", "{ 这不是 JSON", 0, "order", 1, iso(0), iso(0));
    const snap = pm.getQueueSnapshot(peerId);
    expect(snap).toBeTruthy();
    expect(snap!.items).toEqual([]);
    expect(snap!.currentIndex).toBe(-1);
  });

  it("预探测源:坏 JSON → undefined(不扫);shuffle 模式带上服务端序列", () => {
    const pm = new PeerManager();
    const bad = `local:pu1:${uniq("badpeek")}`;
    sqlite.prepare(
      "INSERT OR REPLACE INTO local_queues (peer_id, user_id, items_json, current_index, play_mode, is_active, last_active_at, updated_at) VALUES (?,?,?,?,?,?,?,?)",
    ).run(bad, "pu1", "[ 坏", 0, "order", 1, iso(0), iso(0));
    expect((pm as Any).localPeekSource(bad)).toBeUndefined();

    const ok = `local:pu1:${uniq("goodpeek")}`;
    sqlite.prepare(
      "INSERT OR REPLACE INTO local_queues (peer_id, user_id, items_json, current_index, play_mode, is_active, last_active_at, updated_at) VALUES (?,?,?,?,?,?,?,?)",
    ).run(ok, "pu1", JSON.stringify([{ songId: "a" }, { songId: "b" }, { songId: "c" }]), 1, "shuffle", 1, iso(0), iso(0));
    const src = (pm as Any).localPeekSource(ok);
    expect(src.items).toHaveLength(3);
    expect(src.playMode).toBe("shuffle");
    expect(src.shuffleOrder).toHaveLength(3);
    expect(src.shufflePos).toBe(0);
  });

  it("localSetIndex:shuffle 下把序列位置同步到新的当前曲", () => {
    const pm = new PeerManager();
    const peerId = `local:pu1:${uniq("idx")}`;
    pm.localPlayFrom(peerId, "pu1", [
      { songId: "a" } as Any, { songId: "b" } as Any, { songId: "c" } as Any,
    ], 0);
    pm.localSetPlayMode(peerId, "shuffle" as Any);
    pm.getQueueSnapshot(peerId);                       // 物化洗牌序列
    const entry = (pm as Any).localShuffle.get(peerId);
    expect(entry).toBeTruthy();

    pm.localSetIndex(peerId, 2);
    expect(entry.pos).toBe(entry.order.indexOf(2));    // 序列位置跟着游标走
    pm.localClear(peerId);
  });
});

describe("runCleanup:心跳空闲下线 + 队列双条件回收", () => {
  it("本机端超时未心跳 → 只标离线并清预探测,不动队列", () => {
    const pm = new PeerManager();
    const uid = uniq("pu");
    const clientId = uniq("c");
    const p = pm.registerLocal(uid, "网页", clientId);
    p.lastActiveAt = Date.now() - 3 * 60 * 1000;        // 3 分钟 > 缺省 2 分钟
    const events: string[] = [];
    pm.on("peer_unavailable", (x) => events.push(x.peerId));

    (pm as Any).runCleanup();

    expect(pm.get(p.peerId)!.available).toBe(false);
    expect(events).toEqual([p.peerId]);
    expect(H.probeClears).toContain(p.peerId);          // 没人听了 → 停掉预探测空转
  });

  it("本机队列:6h 未变动 + 播放端离线 6h → 清空并广播 peer_queue_cleared", () => {
    const pm = new PeerManager();
    const peerId = `local:pu1:${uniq("stale")}`;
    localQueueRow(peerId);
    const cleared: string[] = [];
    pm.on("peer_queue_cleared", (id: string) => cleared.push(id));

    (pm as Any).runCleanup();

    expect(cleared).toEqual([peerId]);
    const row = sqlite.prepare("SELECT items_json, is_active FROM local_queues WHERE peer_id = ?").get(peerId) as Any;
    expect(JSON.parse(row.items_json)).toEqual([]);
    expect(row.is_active).toBe(0);
  });

  it("本机队列:队列虽安静,但端还连着 → 绝不回收(单曲循环不被误清)", () => {
    const pm = new PeerManager();
    const uid = "pu1";
    const clientId = uniq("c");
    const peerId = `local:${uid}:${clientId}`;
    pm.registerLocal(uid, "常驻网页", clientId);         // available=true & 刚活跃
    localQueueRow(peerId, { itemsJson: JSON.stringify([{ songId: "s1" }]) });
    const cleared: string[] = [];
    pm.on("peer_queue_cleared", (id: string) => cleared.push(id));

    (pm as Any).runCleanup();

    expect(cleared).toEqual([]);
    expect(JSON.parse((sqlite.prepare("SELECT items_json FROM local_queues WHERE peer_id = ?").get(peerId) as Any).items_json))
      .toHaveLength(1);
  });

  it("本机队列:空行 / 空数组不参与回收", () => {
    const pm = new PeerManager();
    const a = `local:pu1:${uniq("empty")}`;
    const b = `local:pu1:${uniq("nulls")}`;
    localQueueRow(a, { itemsJson: "[]" });
    localQueueRow(b, { itemsJson: "" });
    const cleared: string[] = [];
    pm.on("peer_queue_cleared", (id: string) => cleared.push(id));
    (pm as Any).runCleanup();
    expect(cleared).toEqual([]);
  });

  it("投屏队列:设备 peer 已不在 → 视为离线,清队列 + 补删持久化行", () => {
    const pm = new PeerManager();
    const dev = uniq("dev");
    deviceQueueRow(dev);
    const cleared: string[] = [];
    pm.on("peer_queue_cleared", (id: string) => cleared.push(id));

    (pm as Any).runCleanup();

    expect(H.queueClears).toContain(dev);                        // 内存队列 + 停播
    expect(sqlite.prepare("SELECT * FROM device_queues WHERE device_id = ?").get(dev)).toBeUndefined();
    expect(cleared).toEqual([]);                                 // 没有 peer 行 → 无 peerId 可广播
  });

  it("投屏队列:设备 peer 存在但已离线 6h → 清队列并广播 peer_queue_cleared", () => {
    const pm = new PeerManager();
    const dev = uniq("dev");
    deviceQueueRow(dev);
    const p = pm.registerDlna(dev, "音箱", false);                // 离线
    p.lastActiveAt = Date.now() - 7 * HOUR;
    const cleared: string[] = [];
    pm.on("peer_queue_cleared", (id: string) => cleared.push(id));

    (pm as Any).runCleanup();

    expect(H.queueClears).toContain(dev);
    expect(cleared).toEqual([`dlna:${dev}`]);
    pm.removeDlnaPeer(dev);
  });

  it("投屏队列:设备仍在线 → 保留(队列安静不等于作废)", () => {
    const pm = new PeerManager();
    const dev = uniq("dev");
    deviceQueueRow(dev);
    pm.registerDlna(dev, "音箱", true);                          // 刚被发现在线
    const cleared: string[] = [];
    pm.on("peer_queue_cleared", (id: string) => cleared.push(id));

    (pm as Any).runCleanup();

    expect(cleared).toEqual([]);
    expect(H.queueClears).not.toContain(dev);
    expect(sqlite.prepare("SELECT * FROM device_queues WHERE device_id = ?").get(dev)).toBeTruthy();
    pm.removeDlnaPeer(dev);
  });

  it("组队列:按 groupId 反查到 group peer → 清队列 + 广播 + 删行", () => {
    const pm = new PeerManager();
    const g = uniq("g");
    groupQueueRow(g);
    const p = pm.registerGroup(g, "我家组", true, [], 0);
    p.lastActiveAt = Date.now() - 8 * HOUR;                       // 组行恒在线,但久未刷新
    const cleared: string[] = [];
    pm.on("peer_queue_cleared", (id: string) => cleared.push(id));

    (pm as Any).runCleanup();

    expect(H.queueClears).toContain(g);
    expect(cleared).toEqual([`group:${g}`]);
    expect(sqlite.prepare("SELECT * FROM group_queues WHERE group_id = ?").get(g)).toBeUndefined();
    pm.removeGroup(g);
  });

  it("队列 6h 未变动但端刚活跃 → 两个条件不同时满足,保留", () => {
    const pm = new PeerManager();
    const dev = uniq("dev");
    deviceQueueRow(dev, { updatedAgoMs: 3 * HOUR });              // 只安静了 3h
    pm.registerDlna(dev, "音箱", false);
    (pm as Any).runCleanup();
    expect(sqlite.prepare("SELECT * FROM device_queues WHERE device_id = ?").get(dev)).toBeTruthy();
    pm.removeDlnaPeer(dev);
  });
});

describe("内部工具函数", () => {
  it("findPeerIdForBareId:dlna 优先,其次 airplay/sendspin,再退回 group;都无 → null", () => {
    const pm = new PeerManager();
    const id = uniq("mix");
    pm.registerAirPlay(id, "AP", true);
    expect((pm as Any).findPeerIdForBareId(id)).toBe(`airplay:${id}`);
    pm.registerDlna(id, "DLNA", true);               // 同名裸 id 同时是 DLNA 与 AirPlay
    expect((pm as Any).findPeerIdForBareId(id)).toBe(`dlna:${id}`);
    expect((pm as Any).findPeerIdForBareId(uniq("nobody"))).toBeNull();
    pm.removeDlnaPeer(id);
    pm.removeAirPlayPeers();
  });

  it("findPeerIdForBareId:组 id 命中 groupId 分支", () => {
    const pm = new PeerManager();
    const g = uniq("g");
    pm.registerGroup(g, "组", true, [], 0);
    expect((pm as Any).findPeerIdForBareId(g)).toBe(`group:${g}`);
    pm.removeGroup(g);
  });

  it("peerActiveWithin:不存在 / 不可用 / 活跃时间过老 一律算「不活跃」", () => {
    const pm = new PeerManager();
    const dev = uniq("dev");
    expect((pm as Any).peerActiveWithin(`dlna:${dev}`, HOUR)).toBe(false);
    const p = pm.registerDlna(dev, "音箱", true);
    expect((pm as Any).peerActiveWithin(`dlna:${dev}`, HOUR)).toBe(true);
    p.lastActiveAt = Date.now() - 2 * HOUR;
    expect((pm as Any).peerActiveWithin(`dlna:${dev}`, HOUR)).toBe(false);   // 太老
    p.available = false;
    p.lastActiveAt = Date.now();
    expect((pm as Any).peerActiveWithin(`dlna:${dev}`, HOUR)).toBe(false);   // 不可用
    pm.removeDlnaPeer(dev);
  });

  it("sweepStaleQueues 的时间比较:无效时间戳按 0 处理 → 视为陈旧", () => {
    const pm = new PeerManager();
    const dev = uniq("dev");
    sqlite.prepare(
      "INSERT OR REPLACE INTO device_queues (device_id, items_json, current_index, play_mode, is_active, updated_at) VALUES (?,?,?,?,?,?)",
    ).run(dev, JSON.stringify([{ songId: "s1" }]), 0, "order", 1, "not-a-date");
    (pm as Any).runCleanup();
    // updated_at 解析失败 → touched=0 → 早已过期;设备无 peer 行 ⇒ 直接回收
    expect(sqlite.prepare("SELECT * FROM device_queues WHERE device_id = ?").get(dev)).toBeUndefined();
  });

  it("deletePersistedQueue 容错:删行失败被吞,不影响整轮清扫", () => {
    const pm = new PeerManager();
    const dev = uniq("dev");
    deviceQueueRow(dev);                          // 无 peer 行 → 走「补删持久化行」这一步
    const origPrepare = sqlite.prepare.bind(sqlite);
    const spy = vi.spyOn(sqlite, "prepare").mockImplementation(((sql: string) => {
      if (/delete/i.test(sql)) throw new Error("database is locked");
      return origPrepare(sql);
    }) as Any);
    expect(() => (pm as Any).runCleanup()).not.toThrow();
    spy.mockRestore();
  });
});
