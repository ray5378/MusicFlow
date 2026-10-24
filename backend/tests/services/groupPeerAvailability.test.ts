// 群组 peer 的「可用性」契约测试。
//
// 语义演进(2026-09-23 定稿,用户拍板):
//   **组是「容器」不是设备 —— 组行恒 available=true**,不随成员上下线波动。
//   空组、成员全离线的组也显示在线;成员各自的在线状态由
//   `GroupManager.resolveMemberStates()`(命名空间分派的唯一真相源)推导,
//   汇总为 `onlineCount` 供前端展示「x/y 在线」,但不影响组行可用性。
//
// 历史(两次都把「容器在线」误当成「内容物在线」):
//   ① `reconcileGroupPeers()` 只查 DLNA 设备缓存 ⇒ sendspin 成员永远 miss
//      ⇒ 非 DLNA 群组恒离线,被前端「流转播放」按 available 剪掉整行。
//   ② 改为「至少一个成员在线」⇒ 空组/成员全离线时组又显示「离线」,
//      用户指出:群组里有播放器不在线就显示离线不合理,组空了也要在线。
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
      volume INTEGER NOT NULL DEFAULT 20,
      created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      updated_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      owner_user_id TEXT NOT NULL DEFAULT ''
    );
  `);
});

describe("群组 peer 可用性(组是容器,恒在线)", () => {
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

  it("组行恒 available:纯 sendspin 成员的组(曾经的 bug 点)", () => {
    const g = gm.createGroup("sendspin群组", ["sendspin:sp1"]);
    getPeerManager().reconcileGroupPeers();

    const peer = getPeerManager().get(`group:${g.id}`);
    expect(peer).toBeDefined();
    expect(peer!.kind).toBe("group");
    expect(peer!.available).toBe(true);
    expect(peer!.onlineCount).toBe(1);
  });

  it("组行恒 available:成员全离线也不得显示离线(本次定稿)", () => {
    const g = gm.createGroup("全离线组", ["sendspin:sp2", "dlna:d2"]);
    getPeerManager().reconcileGroupPeers();
    const peer = getPeerManager().get(`group:${g.id}`)!;
    expect(peer.available).toBe(true);
    expect(peer.onlineCount).toBe(0);
  });

  it("组行恒 available:空组(没有成员)也在线", () => {
    const g = gm.createGroup("空组", []);
    getPeerManager().reconcileGroupPeers();
    const peer = getPeerManager().get(`group:${g.id}`)!;
    expect(peer.available).toBe(true);
    expect(peer.memberCount).toBe(0);
    expect(peer.onlineCount).toBe(0);
  });

  it("组行恒 available:DLNA 组不得回归", () => {
    const on = gm.createGroup("在线DLNA组", ["dlna:d1"]);
    const off = gm.createGroup("离线DLNA组", ["dlna:d2"]);
    getPeerManager().reconcileGroupPeers();
    expect(getPeerManager().get(`group:${on.id}`)!.available).toBe(true);
    expect(getPeerManager().get(`group:${off.id}`)!.available).toBe(true);
    expect(getPeerManager().get(`group:${off.id}`)!.onlineCount).toBe(0);
  });

  it("组行恒 available:混合成员组", () => {
    const g = gm.createGroup("混合组", ["sendspin:sp2", "sendspin:sp1"]);
    getPeerManager().reconcileGroupPeers();
    expect(getPeerManager().get(`group:${g.id}`)!.available).toBe(true);
  });

  it("成员在线状态翻转不影响组行 available,但 onlineCount 必须实时汇总", () => {
    const g = gm.createGroup("翻转组", ["sendspin:sp1"]);
    getPeerManager().reconcileGroupPeers();
    expect(getPeerManager().get(`group:${g.id}`)!.available).toBe(true);
    expect(getPeerManager().get(`group:${g.id}`)!.onlineCount).toBe(1);

    // sp1 掉线 → 组仍在线(容器语义),但在线数归零。
    sendspinClients.set("sp1", { name: "esp32-player2", ready: false });
    getPeerManager().reconcileGroupPeers();
    expect(getPeerManager().get(`group:${g.id}`)!.available).toBe(true);
    expect(getPeerManager().get(`group:${g.id}`)!.onlineCount).toBe(0);

    // 恢复在线 ⇒ 在线数跟着恢复。
    sendspinClients.set("sp1", { name: "esp32-player2", ready: true });
    getPeerManager().reconcileGroupPeers();
    expect(getPeerManager().get(`group:${g.id}`)!.onlineCount).toBe(1);
  });
});
