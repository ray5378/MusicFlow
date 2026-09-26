// ==================== PeerManager(播放端注册表) ====================
// 覆盖:本机/DLNA/AirPlay/Sendspin/组 的注册与下线、心跳复活、排序与可见性解析、
// 本机状态上报的字段合并与 TTL、本机队列的内存态操作。
// 预探测调度器整体 mock(避免真实网络探测副作用)。
// MUST be the first import: redirects DATA_DIR to an isolated temp dir before
// the backend opens its SQLite DB at module-load time.
import "../plugins/_env.js";

import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from "vitest";
import { db, initDatabase, sqlite } from "../../src/db/index.js";
import { users } from "../../src/db/schema.js";
import { eq } from "drizzle-orm";
import { getPeerManager, parsePeerId, peerIdleTimeoutMs } from "../../src/services/peer.js";
import { _resetSettingsCacheForTest } from "../../src/services/settings.js";
import { instanceKeyOfLocalPeer } from "../../src/utils/peerId.js";

const M = vi.hoisted(() => ({
  probeClears: [] as string[],
  probeScheduled: 0,
}));

// 预探测调度器接口较宽(clear/schedule/addOnChange/...),用 Proxy 兜住所有调用,
// 只把本测试关心的两个方法记下来。
vi.mock("../../src/services/player/preProbeScheduler.js", () => ({
  getPreProbeScheduler: () =>
    new Proxy({} as Record<string, unknown>, {
      get: (_t, prop: string) => {
        if (prop === "clear") return (peerId: string) => M.probeClears.push(peerId);
        if (prop === "schedule") return () => { M.probeScheduled++; };
        return () => undefined;
      },
    }),
}));

const pm = getPeerManager();

beforeAll(() => {
  if (!process.env.APP_VERSION) process.env.APP_VERSION = "1.0.0";
  initDatabase();
  if (!db.select().from(users).where(eq(users.id, "pu1")).get()) {
    sqlite
      .prepare("INSERT INTO users (id, username, password, salt, subsonic_salt) VALUES (?, ?, ?, ?, ?)")
      .run("pu1", "peeruser", "", "s", "ss");
  }
});

/** 每个用例用独立 id,避免与生产/其它用例互相污染。 */
let seq = 0;
function uniq(prefix: string): string {
  seq++;
  return `${prefix}-${Date.now()}-${seq}`;
}

beforeEach(() => {
  M.probeClears = [];
  M.probeScheduled = 0;
});

afterEach(() => {
  pm.removeAllListeners();
});

describe("peerId 解析", () => {
  it("各 kind 前缀都能解析出 kind + 裸 id", () => {
    expect(parsePeerId("local:u1")).toEqual({ kind: "local", id: "u1" });
    expect(parsePeerId("dlna:dev-1")).toEqual({ kind: "dlna", id: "dev-1" });
    expect(parsePeerId("group:g1")).toEqual({ kind: "group", id: "g1" });
    expect(parsePeerId("airplay:ap1")).toEqual({ kind: "airplay", id: "ap1" });
    expect(parsePeerId("sendspin:sp1")).toEqual({ kind: "sendspin", id: "sp1" });
  });

  it("未知前缀 / 空串 → null", () => {
    expect(parsePeerId("weird:1")).toBeNull();
    expect(parsePeerId("")).toBeNull();
  });
});

describe("心跳空闲门槛(可配)", () => {
  function setSetting(key: string, value: string | null) {
    sqlite.prepare("DELETE FROM settings WHERE key = ?").run(key);
    if (value !== null) sqlite.prepare("INSERT INTO settings (key, value) VALUES (?, ?)").run(key, value);
    _resetSettingsCacheForTest(); // settings 有进程内缓存,不 reset 读不到新值
  }

  it("缺省 2 分钟", () => {
    setSetting("peer_idle_minutes", null);
    expect(peerIdleTimeoutMs()).toBe(2 * 60 * 1000);
  });

  it("settings 可覆盖", () => {
    setSetting("peer_idle_minutes", "7");
    expect(peerIdleTimeoutMs()).toBe(7 * 60 * 1000);
    setSetting("peer_idle_minutes", null);
  });

  it("非法值(0 / 负数 / 非数字)回退缺省", () => {
    for (const v of ["0", "-3", "abc", ""]) {
      setSetting("peer_idle_minutes", v);
      expect(peerIdleTimeoutMs(), `value=${v}`).toBe(2 * 60 * 1000);
    }
    setSetting("peer_idle_minutes", null);
  });
});

describe("本机 peer 注册与心跳", () => {
  it("首次注册 → peer_registered 事件", () => {
    const uid = uniq("pu");
    const events: string[] = [];
    pm.on("peer_registered", (p) => events.push(p.peerId));
    const p = pm.registerLocal(uid, "Alice", "c1", "android", "Pixel");
    expect(p.peerId).toBe(`local:${uid}:c1`);
    expect(p.kind).toBe("local");
    expect(p.available).toBe(true);
    expect(p.platform).toBe("android");
    expect(p.model).toBe("Pixel");
    expect(events).toEqual([p.peerId]);
    pm.removeDlnaPeer(""); // no-op
  });

  it("重复注册:改名 + 只在有值时覆盖名片 + 不重复发 registered", () => {
    const uid = uniq("pu");
    let registered = 0;
    pm.on("peer_registered", () => registered++);
    pm.registerLocal(uid, "Alice", "c1", "windows", "PC");
    pm.registerLocal(uid, "Alice2", "c1", null, null);
    pm.registerLocal(uid, "Alice3", "c1", "web", null);
    expect(registered).toBe(1);
    const p = pm.get(`local:${uid}:c1`)!;
    expect(p.name).toBe("Alice3");
    expect(p.platform).toBe("web"); // 只有非空值才覆盖
    expect(p.model).toBe("PC"); // 空值不抹掉旧名片
  });

  it("heartbeat:已注册 → true 并刷新活跃时间", () => {
    const uid = uniq("pu");
    const p = pm.registerLocal(uid, "Bob", "c1");
    p.lastActiveAt = 0;
    expect(pm.heartbeat(p.peerId)).toBe(true);
    expect(pm.get(p.peerId)!.lastActiveAt).toBeGreaterThan(0);
  });

  it("heartbeat:未注册的本机 peer(用户存在)→ 就地复活", () => {
    const peerId = `local:pu1:${uniq("revive")}`;
    expect(pm.get(peerId)).toBeUndefined();
    expect(pm.heartbeat(peerId)).toBe(true);
    expect(pm.get(peerId)!.available).toBe(true);
  });

  it("heartbeat:用户不存在 / 非本机 peerId → false", () => {
    expect(pm.heartbeat("local:no-such-user:c1")).toBe(false);
    expect(pm.heartbeat("dlna:no-such-device")).toBe(false);
  });

  it("markLocalOfflineByClient:最后一条 WS 断开即下线", () => {
    const uid = uniq("pu");
    const clientId = uniq("c");
    pm.registerLocal(uid, "Carl", clientId);
    const events: string[] = [];
    pm.on("peer_unavailable", (p) => events.push(p.peerId));
    pm.markLocalOfflineByClient(uid, clientId);
    expect(pm.get(`local:${uid}:${clientId}`)!.available).toBe(false);
    expect(events.length).toBe(1);
    // 离线时清掉预探测(没人听了不再空转)
    expect(M.probeClears).toContain(`local:${uid}:${clientId}`);
  });

  it("markLocalOfflineByClient:空参数 / 不存在的端 都安全", () => {
    expect(() => pm.markLocalOfflineByClient("", "")).not.toThrow();
    expect(() => pm.markLocalOfflineByClient("nobody", "nothing")).not.toThrow();
  });

  it("离线端再注册 → peer_available 事件", () => {
    const uid = uniq("pu");
    const clientId = uniq("c2");
    pm.registerLocal(uid, "Dora", clientId);
    pm.markLocalOfflineByClient(uid, clientId);
    const events: string[] = [];
    pm.on("peer_available", (p) => events.push(p.peerId));
    pm.registerLocal(uid, "Dora", clientId);
    expect(events.length).toBe(1);
    expect(pm.get(`local:${uid}:${clientId}`)!.available).toBe(true);
  });
});

describe("DLNA / AirPlay / Sendspin / 组 peer", () => {
  it("DLNA:注册 → 标离线 → 移除", () => {
    const id = uniq("dlna");
    const p = pm.registerDlna(id, "客厅音箱", true);
    expect(p.peerId).toBe(`dlna:${id}`);
    expect(pm.get(`dlna:${id}`)!.available).toBe(true);
    pm.markDlnaUnavailable(id);
    expect(pm.get(`dlna:${id}`)!.available).toBe(false);
    pm.removeDlnaPeer(id);
    expect(pm.get(`dlna:${id}`)).toBeUndefined();
  });

  it("AirPlay:注册 → 标离线 → 移除单个 / 全部", () => {
    const a = uniq("ap");
    const b = uniq("ap");
    pm.registerAirPlay(a, "AP-A", true);
    pm.registerAirPlay(b, "AP-B", true);
    expect(pm.get(`airplay:${a}`)).toBeTruthy();
    pm.markAirPlayUnavailable(a);
    expect(pm.get(`airplay:${a}`)!.available).toBe(false);
    pm.removeAirPlayPeer(a);
    expect(pm.get(`airplay:${a}`)).toBeUndefined();
    pm.removeAirPlayPeers();
    expect(pm.get(`airplay:${b}`)).toBeUndefined();
  });

  it("Sendspin:注册(含明文标记)→ 移除单个 / 全部", () => {
    const s1 = uniq("sp");
    const s2 = uniq("sp");
    const p = pm.registerSendspin(s1, "SP-1", true, true);
    expect(p.unencrypted).toBe(true);
    pm.registerSendspin(s2, "SP-2", true);
    pm.removeSendspinPeer(s1);
    expect(pm.get(`sendspin:${s1}`)).toBeUndefined();
    pm.removeSendspinPeers();
    expect(pm.get(`sendspin:${s2}`)).toBeUndefined();
  });

  it("组:注册带成员快照 → 移除", () => {
    const g = uniq("g");
    const p = pm.registerGroup(g, "我家组", true, ["dlna:a", "dlna:b"], 2);
    expect(p.kind).toBe("group");
    expect(p.memberIds).toEqual(["dlna:a", "dlna:b"]);
    expect(p.memberCount).toBe(2);
    expect(p.onlineCount).toBe(2);
    pm.removeGroup(g);
    expect(pm.get(`group:${g}`)).toBeUndefined();
  });

  it("notifyPeerVolume:广播 peer_volume_changed(peer 行上的快照由上游装配)", () => {
    const s = uniq("sp");
    pm.registerSendspin(s, "SP-V", true);
    const got: any[] = [];
    pm.on("peer_volume_changed", (peerId: string, volume: number, muted: boolean) =>
      got.push({ peerId, volume, muted }),
    );
    pm.notifyPeerVolume(`sendspin:${s}`, 33, true);
    expect(got).toEqual([{ peerId: `sendspin:${s}`, volume: 33, muted: true }]);
    // 空 peerId 直接返回,不发事件
    pm.notifyPeerVolume("", 1, false);
    expect(got.length).toBe(1);
    pm.removeSendspinPeer(s);
  });
});

describe("列表排序与可见性解析", () => {
  it("listWithQueues:本机 → 设备 → 组,同类按名称", () => {
    const uid = uniq("pu");
    const d = uniq("dlna");
    const g = uniq("g");
    pm.registerLocal(uid, "Z本机", "c1");
    pm.registerDlna(d, "AAA音箱", true);
    pm.registerGroup(g, "ZZZ组", true, [], 0);
    const kinds = pm.listWithQueues().map((p) => p.kind);
    const localIdx = kinds.indexOf("local");
    const dlnaIdx = kinds.indexOf("dlna");
    const groupIdx = kinds.indexOf("group");
    expect(localIdx).toBeLessThan(dlnaIdx);
    expect(dlnaIdx).toBeLessThan(groupIdx);
    pm.removeDlnaPeer(d);
    pm.removeGroup(g);
  });

  it("list() 返回全部 peer 行", () => {
    const before = pm.list().length;
    const d = uniq("dlna");
    pm.registerDlna(d, "T", true);
    expect(pm.list().length).toBe(before + 1);
    pm.removeDlnaPeer(d);
  });

  it("resolveVisiblePeerId:本机裸 id → 最近活跃的实例", () => {
    const uid = uniq("pu");
    const older = pm.registerLocal(uid, "I1", "c-old");
    older.lastActiveAt = 1000;
    const newer = pm.registerLocal(uid, "I2", "c-new");
    newer.lastActiveAt = 5000;
    expect(pm.resolveVisiblePeerId(`local:${uid}`)).toBe(newer.peerId);
    // 已精确注册过的 peerId 原样返回
    expect(pm.resolveVisiblePeerId(newer.peerId)).toBe(newer.peerId);
    expect(older.peerId).not.toBe(newer.peerId);
  });

  it("resolveVisiblePeerId:没实例 → 原样返回(等客户端连上再解析)", () => {
    expect(pm.resolveVisiblePeerId("local:no-such-user")).toBe("local:no-such-user");
    // 非 local 前缀原样返回
    expect(pm.resolveVisiblePeerId("dlna:whatever")).toBe("dlna:whatever");
  });

  it("resolveMaskedLocalPeerId:实例键逆查真实 peerId", () => {
    const uid = uniq("pu");
    const p = pm.registerLocal(uid, "M", "client-abc");
    // 对外只暴露不可逆派生的实例键,逆查必须用同一个派生值
    const key = instanceKeyOfLocalPeer(p.peerId)!;
    expect(key).toBeTruthy();
    expect(key).not.toBe("client-abc");
    expect(pm.resolveMaskedLocalPeerId(uid, key)).toBe(p.peerId);
    expect(pm.resolveMaskedLocalPeerId(uid, "wrong")).toBeNull();
    expect(pm.resolveMaskedLocalPeerId("", key)).toBeNull();
    expect(pm.resolveMaskedLocalPeerId(uid, "")).toBeNull();
  });
});

describe("本机播放状态上报", () => {
  it("字段级合并:省略的字段沿用上次", () => {
    const uid = uniq("pu");
    const p = pm.registerLocal(uid, "R", "c-r");
    const r1 = pm.reportLocalStatus(p.peerId, { state: "PLAYING", position: 10, duration: 200, songId: "s1" })!;
    expect(r1.state).toBe("PLAYING");
    const r2 = pm.reportLocalStatus(p.peerId, { position: 20 })!;
    expect(r2.state).toBe("PLAYING"); // 沿用
    expect(r2.duration).toBe(200); // 沿用
    expect(r2.songId).toBe("s1"); // 沿用
    expect(r2.position).toBe(20);
  });

  it("STOPPED 一律清空 songId(避免已停的端一直挂着上一首)", () => {
    const uid = uniq("pu");
    const p = pm.registerLocal(uid, "R2", "c-r2");
    pm.reportLocalStatus(p.peerId, { state: "PLAYING", songId: "s1" });
    const r = pm.reportLocalStatus(p.peerId, { state: "STOPPED" })!;
    expect(r.songId).toBeUndefined();
  });

  it("音量钳制到 0-100;非法位置/时长不覆盖", () => {
    const uid = uniq("pu");
    const p = pm.registerLocal(uid, "R3", "c-r3");
    const r = pm.reportLocalStatus(p.peerId, { volume: 150, position: -5, duration: -1 })!;
    expect(r.volume).toBe(100);
    expect(r.position).toBe(0);
    expect(r.duration).toBe(0);
    const r2 = pm.reportLocalStatus(p.peerId, { volume: -20 })!;
    expect(r2.volume).toBe(0);
  });

  it("非本机 peerId → undefined", () => {
    const d = uniq("dlna");
    pm.registerDlna(d, "D", true);
    expect(pm.reportLocalStatus(`dlna:${d}`, { state: "PLAYING" })).toBeUndefined();
    pm.removeDlnaPeer(d);
  });

  it("TTL:超过 30s 视为过期", () => {
    const uid = uniq("pu");
    const p = pm.registerLocal(uid, "T", "c-t");
    pm.reportLocalStatus(p.peerId, { state: "PLAYING" });
    expect(pm.getLocalStatusReport(p.peerId)).toBeTruthy();
    // 手动把上报时刻推回 31s 前
    const m = (pm as any).localReports as Map<string, any>;
    m.get(p.peerId)!.reportedAt = Date.now() - 31_000;
    expect(pm.getLocalStatusReport(p.peerId)).toBeUndefined();
  });

  it("clearLocalStatusReport 丢弃上报", () => {
    const uid = uniq("pu");
    const p = pm.registerLocal(uid, "T2", "c-t2");
    pm.reportLocalStatus(p.peerId, { state: "PLAYING" });
    pm.clearLocalStatusReport(p.peerId);
    expect(pm.getLocalStatusReport(p.peerId)).toBeUndefined();
  });
});

describe("本机队列(服务端权威)", () => {
  function mkLocal() {
    const uid = uniq("pu");
    return pm.registerLocal(uid, "Q", uniq("cq"));
  }

  it("localPlayFrom 落库并可取快照", () => {
    const p = mkLocal();
    pm.localPlayFrom(p.peerId, "pu1", [
      { songId: "s1", title: "T1", duration: 100 } as any,
      { songId: "s2", title: "T2", duration: 120 } as any,
    ], 0);
    const snap = pm.getQueueSnapshot(p.peerId);
    expect(snap).toBeTruthy();
    expect(snap!.items.length).toBe(2);
    expect(snap!.currentIndex).toBe(0);
  });

  it("localEnqueue 追加;localRemoveAt 按下标删", () => {
    const p = mkLocal();
    pm.localPlayFrom(p.peerId, "pu1", [{ songId: "a" } as any], 0);
    pm.localEnqueue(p.peerId, "pu1", [{ songId: "b" } as any, { songId: "c" } as any]);
    expect(pm.getQueueSnapshot(p.peerId)!.items.length).toBe(3);
    pm.localRemoveAt(p.peerId, 0);
    const s = pm.getQueueSnapshot(p.peerId)!;
    expect(s.items.length).toBe(2);
    expect(s.items[0].songId).toBe("b");
  });

  it("localReorder 移动位置;越界安全", () => {
    const p = mkLocal();
    pm.localPlayFrom(p.peerId, "pu1", [{ songId: "a" } as any, { songId: "b" } as any, { songId: "c" } as any], 0);
    pm.localReorder(p.peerId, 2, 0);
    expect(pm.getQueueSnapshot(p.peerId)!.items[0].songId).toBe("c");
    expect(() => pm.localReorder(p.peerId, 99, 0)).not.toThrow();
  });

  it("localSetIndex / localSetPlayMode / localTouch / localClear", () => {
    const p = mkLocal();
    pm.localPlayFrom(p.peerId, "pu1", [{ songId: "a" } as any, { songId: "b" } as any], 0);
    pm.localSetIndex(p.peerId, 1);
    expect(pm.getQueueSnapshot(p.peerId)!.currentIndex).toBe(1);
    pm.localSetPlayMode(p.peerId, "single" as any);
    expect(pm.getQueueSnapshot(p.peerId)!.playMode).toBe("single");
    expect(() => pm.localTouch(p.peerId)).not.toThrow();
    pm.localClear(p.peerId);
    expect(pm.getQueueSnapshot(p.peerId)!.items.length).toBe(0);
  });

  it("reshuffleLocal 重排洗牌序列(本机队列也由服务端持序)", () => {
    const p = mkLocal();
    pm.localPlayFrom(p.peerId, "pu1", [
      { songId: "a" } as any, { songId: "b" } as any, { songId: "c" } as any,
    ], 0);
    pm.localSetPlayMode(p.peerId, "shuffle" as any);
    const s = pm.reshuffleLocal(p.peerId);
    expect(s).toBeTruthy();
    expect(s!.items.length).toBe(3);
  });

  it("未初始化的 peer 取快照 → 空快照(不抛)", () => {
    const snap = pm.getQueueSnapshot("local:ghost:c");
    expect(snap).toBeTruthy();
    expect(snap!.items.length).toBe(0);
    expect(snap!.currentIndex).toBeLessThan(1);
  });
});
