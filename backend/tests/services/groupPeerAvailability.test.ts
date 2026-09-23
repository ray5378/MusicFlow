// 群组 peer 的「可用性」契约测试。
//
// 背景(2026-09-23 真机事故):
//   `PeerManager.reconcileGroupPeers()` 曾经自己拿成员 id 去 DLNA 设备缓存里查:
//     const available = g.memberIds.some(d => getCachedDevices().find(x => x.id === d)?.available);
//   但成员 id 是**带命名空间**的(`sendspin:<clientId>` / `dlna:<deviceId>` / 裸 id≡DLNA),
//   sendspin 成员**不在** DLNA 设备缓存里 ⇒ 永远 miss ⇒ 该群组恒被判为离线。
//   后果:群组本身已落库(管理页正常显示「2 台设备 · 2 台在线」),但在「流转播放」
//   选择器里被前端按 available 剪掉整行 —— 群组根本没法接入播放。
//
// 本文件锁定唯一真相源:群组可用性必须由 `GroupManager.resolveMemberStates()` 推导
// (它按成员 id 的命名空间分派到各自的设备源)。
import "../plugins/_env.js";
import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import { sqlite } from "../../src/db/index.js";

// DLNA 设备源:只认裸 deviceId(与真实实现一致 —— sendspin 成员不会出现在这里)。
vi.mock("../../src/services/dlna/control.js", () => ({
  getCachedDevices: () => [
    { id: "d1", name: "客厅音响", available: true },
    { id: "d2", name: "卧室音响", available: false },
  ],
}));

// sendspin 客户端源:模拟「服务在跑、clientId=sp1 在线、sp2 离线」。
const sendspinClients = new Map<string, any>([
  ["sp1", { name: "esp32-player2", ready: true }],
  ["sp2", { name: "esp32-meet", ready: false }],
]);
vi.mock("../../src/services/sendspin/runtime.js", () => ({
  getServer: () => ({ clients: sendspinClients }),
  getClientCount: () => sendspinClients.size,
}));

// sendspin 音量回显(与在线判定无关,给个稳定值避免真去读库)。
vi.mock("../../src/services/sendspin/peerVolume.js", () => ({
  getSendspinDeviceVolume: () => ({ volume: 50, muted: false }),
}));

// supervisor 视为未运行(fork 模式不参与本用例)。
vi.mock("../../src/services/sendspin/supervisor.js", () => ({
  sendspinSupervisor: { isRunning: () => false, mirror: { clients: new Map() } },
}));

import { GroupManager, getGroupManager } from "../../src/services/group/index.js";
import { getPeerManager } from "../../src/services/peer.js";

beforeAll(() => {
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS player_groups (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      member_ids TEXT NOT NULL DEFAULT '[]',
      created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      updated_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      owner_user_id TEXT NOT NULL DEFAULT ''
    );
  `);
});

describe("群组 peer 可用性(命名空间成员)", () => {
  let gm: GroupManager;

  beforeEach(() => {
    sqlite.exec("DELETE FROM player_groups");
    // 直接驱动**进程单例** —— peer 层取的就是它,不 mock 模块,避免两套实例。
    gm = getGroupManager();
    gm.loadFromDb();
  });

  it("resolveMemberStates:sendspin 成员走 sendspin 源、dlna 成员走 DLNA 源", () => {
    const states = gm.resolveMemberStates([
      "sendspin:sp1", // 在线
      "sendspin:sp2", // 离线
      "dlna:d1", // 在线
      "d2", // 裸 id ≡ DLNA,离线
      "unknown-bare-id", // 哪都没有 ⇒ 离线
    ]);
    expect(states.map((s) => s.available)).toEqual([true, false, true, false, false]);
    expect(states[0].name).toBe("esp32-player2");
  });

  it("纯 sendspin 成员的组:成员在线 ⇒ 组 peer 必须是 available(曾经的 bug 点)", () => {
    const g = gm.createGroup("sendspin群组", ["sendspin:sp1"]);
    getPeerManager().reconcileGroupPeers();

    const peer = getPeerManager().get(`group:${g.id}`);
    expect(peer).toBeDefined();
    expect(peer!.kind).toBe("group");
    // 关键断言:旧实现只查 DLNA 缓存 ⇒ sendspin 成员永远 miss ⇒ 这里会是 false,
    // 群组随即被前端「流转播放」选择器剪掉。
    expect(peer!.available).toBe(true);
  });

  it("组内成员全离线 ⇒ 组 peer 标离线(不得因解析不到而恒真)", () => {
    const g = gm.createGroup("全离线组", ["sendspin:sp2"]);
    getPeerManager().reconcileGroupPeers();
    expect(getPeerManager().get(`group:${g.id}`)!.available).toBe(false);
  });

  it("DLNA 成员的组:可用性照旧由 DLNA 源决定(不得回归)", () => {
    const on = gm.createGroup("在线DLNA组", ["dlna:d1"]);
    const off = gm.createGroup("离线DLNA组", ["dlna:d2"]);
    getPeerManager().reconcileGroupPeers();
    expect(getPeerManager().get(`group:${on.id}`)!.available).toBe(true);
    expect(getPeerManager().get(`group:${off.id}`)!.available).toBe(false);
  });

  it("混合成员的组:任一成员在线即可用", () => {
    const g = gm.createGroup("混合组", ["sendspin:sp2", "sendspin:sp1"]);
    getPeerManager().reconcileGroupPeers();
    expect(getPeerManager().get(`group:${g.id}`)!.available).toBe(true);
  });

  it("成员在线状态翻转后 reconcile 必须跟着翻(不缓存旧判定)", () => {
    const g = gm.createGroup("翻转组", ["sendspin:sp1"]);
    getPeerManager().reconcileGroupPeers();
    expect(getPeerManager().get(`group:${g.id}`)!.available).toBe(true);

    // sp1 掉线 → 再 reconcile ⇒ 组跟着离线。
    sendspinClients.set("sp1", { name: "esp32-player2", ready: false });
    getPeerManager().reconcileGroupPeers();
    expect(getPeerManager().get(`group:${g.id}`)!.available).toBe(false);

    // 恢复在线 ⇒ 组也恢复。
    sendspinClients.set("sp1", { name: "esp32-player2", ready: true });
    getPeerManager().reconcileGroupPeers();
    expect(getPeerManager().get(`group:${g.id}`)!.available).toBe(true);
  });
});
