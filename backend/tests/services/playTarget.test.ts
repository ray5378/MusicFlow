// 播放目标「可播」判据(playTarget.checkPlayTarget)的契约测试。
//
// 锁死 2026-09-25 定稿的硬限制:**目标没有在线播放器,就不开始播放**。
// 判据是**单一真相源** —— 播放层(QueueController 起播前 + cast 失败后)与音流等待阶段
// 消费的是同一个函数,所以它的语义在这里一次性钉死,免得日后两处各自演化:
//   - 群组:组行 `available` 恒 true(2026-09-23 定稿「组恒在线」),**不能**拿来判
//     可播性(那正是 groupPeerAvailability.test.ts 守着的语义);真判据是组内有没有
//     在线成员(hasOnlineMember,跨 kind)。
//   - AirPlay:设备档案**持久化**,离线也仍留在列表里,真判据是 discovery 的 available。
//   - dlna / sendspin / 未知:乐观放行(各自已有语义,不在本模块收口)。
import "../plugins/_env.js";
import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import { sqlite } from "../../src/db/index.js";

// DLNA 侧:本文件不涉及 DLNA 判据,给足 protocolPlayer 会 import 的名字即可。
vi.mock("../../src/services/dlna/control.js", () => ({
  getCachedDevices: () => [],
  isDeviceAvailable: () => true,
  getDevice: () => undefined,
  getDeviceStatus: async () => ({}),
  createDlnaProtocolPlayer: () => ({ playerId: "dlna:x", playMedia: async () => ({ mediaUri: "" }) }),
}));

// sendspin 侧:模拟「服务在跑,clients 里有什么就算什么在线」。
const sendspinClients = new Map<string, any>();
vi.mock("../../src/services/sendspin/index.js", () => ({
  getSendspinFront: () => ({ clients: sendspinClients }),
}));
vi.mock("../../src/services/sendspin/playerCore.js", () => ({
  sendspinGroupName: (id: string) => `ug:${id}`,
}));

// AirPlay 侧:ap-on 在线、ap-off 离线(离线也仍在列表里 —— 这正是要区分的点)。
const airplayDevices = new Map<string, any>([
  ["ap-on", { id: "ap-on", name: "AirPlay 客厅", alias: "", available: true }],
  ["ap-off", { id: "ap-off", name: "AirPlay 卧室", alias: "", available: false }],
]);
vi.mock("../../src/services/airplay/discovery.js", () => ({
  getAirPlayDevice: (id: string) => airplayDevices.get(id),
}));

import { getGroupManager } from "../../src/services/group/index.js";
import { checkPlayTarget } from "../../src/services/playTarget.js";

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

describe("playTarget.checkPlayTarget — 没有在线播放器就不算可播", () => {
  beforeEach(() => {
    sqlite.exec("DELETE FROM player_groups");
    sendspinClients.clear();
    getGroupManager().loadFromDb();
  });

  it("群组:成员全离线 ⇒ 不可播(组行 available 恒 true 也不放行)", () => {
    const g = getGroupManager().createGroup("全离线组", ["sendspin:sp2"]);
    sendspinClients.set("sp2", { name: "esp32-meet", ready: false });

    const r = checkPlayTarget(`group:${g.id}`);
    expect(r.playable).toBe(false);
    expect(r.reason).toBe("组内没有在线成员");
  });

  it("群组:有任一成员在线 ⇒ 可播(不必等全部成员)", () => {
    const g = getGroupManager().createGroup("半在线组", ["sendspin:sp1", "sendspin:sp2"]);
    sendspinClients.set("sp1", { name: "esp32-player2", ready: true });
    sendspinClients.set("sp2", { name: "esp32-meet", ready: false });

    expect(checkPlayTarget(`group:${g.id}`).playable).toBe(true);
  });

  it("群组:空组 ⇒ 不可播", () => {
    const g = getGroupManager().createGroup("空组", []);
    const r = checkPlayTarget(`group:${g.id}`);
    expect(r.playable).toBe(false);
  });

  it("裸 id 与带前缀等价(QueueController 全程用裸 id 作 key)", () => {
    const g = getGroupManager().createGroup("裸id组", ["sendspin:sp2"]);
    sendspinClients.set("sp2", { name: "esp32-meet", ready: false });

    const bare = checkPlayTarget(g.id);
    const prefixed = checkPlayTarget(`group:${g.id}`);
    expect(bare.playable).toBe(false);
    expect(bare.playable).toBe(prefixed.playable);
    expect(bare.reason).toBe(prefixed.reason);
  });

  it("AirPlay:设备在列表里但不在线 ⇒ 不可播", () => {
    const r = checkPlayTarget("airplay:ap-off");
    expect(r.playable).toBe(false);
    expect(r.reason).toContain("不在线");
  });

  it("AirPlay:在线 ⇒ 可播", () => {
    expect(checkPlayTarget("airplay:ap-on").playable).toBe(true);
  });

  it("未知 id(dlna/sendspin/local 等)⇒ 乐观放行,不在本模块收口", () => {
    expect(checkPlayTarget("dlna:some-device").playable).toBe(true);
    expect(checkPlayTarget("sendspin:who-knows").playable).toBe(true);
    expect(checkPlayTarget("local:u1").playable).toBe(true);
  });
});
