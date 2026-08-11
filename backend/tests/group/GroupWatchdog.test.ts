// 阶段 3 边界测试:成员加入播放中组对齐(rejoinMembers)+ 全员离线悬挂/成员回归恢复(watchdog)。
//
// mock 说明:
//   - dlna/control.js 全量 mock(createDlnaProtocolPlayer 返回可记录调用的 fake;
//     getDeviceStatus 由 h.status 按设备定制,供 leader 状态/位置/暂停态控制)
//   - group/index.js 的 getGroupManager 用可控 stub
//   - player/index.js 的 getQueueController 指向测试创建的 QueueController 实例
//     (watchdog 走单例,rejoinMembers 也可直接调用该实例),getPlayerController 返回测试 env
import { describe, it, expect, vi, beforeEach, afterEach, beforeAll } from "vitest";
import { QueueController } from "../../src/services/player/QueueController.js";
import { PlayerController } from "../../src/services/player/PlayerController.js";
import { UniversalPlayer } from "../../src/services/player/UniversalPlayer.js";
import { runGroupWatchdogTick, resetGroupWatchdogForTest } from "../../src/services/group/watchdog.js";
import { createGroupProtocolPlayer } from "../../src/services/group/protocolPlayer.js";
import type { QueueItem } from "../../src/services/player/types.js";
import { sqlite } from "../../src/db/index.js";

const h = vi.hoisted(() => {
  const devices: Record<string, { available: boolean }> = {};
  const status: Record<string, any> = {};
  const groupStore = new Map<string, { id: string; name: string; memberIds: string[] }>();
  const groupOfDevice = new Map<string, string[]>();
  const memberCalls: Record<string, string[]> = {};
  const qcRef: { current: QueueController | null } = { current: null };
  const pcRef: { current: PlayerController | null } = { current: null };

  function fakeDlnaProtocol(deviceId: string): any {
    const calls: string[] = (memberCalls[deviceId] ??= []);
    return {
      playerId: `dlna:${deviceId}`,
      async playMedia(item: QueueItem) { calls.push(`playMedia:${item.songId}`); return { mediaUri: `uri-${deviceId}` }; },
      async stop() { calls.push("stop"); },
      async pause() { calls.push("pause"); },
      async resume() { calls.push("resume"); },
      async seek(s: number) { calls.push(`seek:${s}`); },
      async setVolume(v: number) { calls.push(`volume:${v}`); },
      async pollState() { return { playerId: `dlna:${deviceId}`, playbackState: "PLAYING", position: 10, duration: 100, updatedAt: Date.now() }; },
    };
  }

  return { devices, status, groupStore, groupOfDevice, memberCalls, qcRef, pcRef, fakeDlnaProtocol };
});

vi.mock("../../src/services/dlna/control.js", () => ({
  createDlnaProtocolPlayer: (deviceId: string) => h.fakeDlnaProtocol(deviceId),
  getEffectiveBaseUrl: () => "http://base",
  clearCurrentMedia: () => {},
  getDevice: (id: string) => (h.devices[id] ? { id, available: h.devices[id].available } : undefined),
  isDeviceAvailable: (id: string) => !!h.devices[id]?.available,
  getCachedDevices: () => Object.entries(h.devices).map(([id, d]) => ({ id, name: id, available: d.available })),
  getDeviceStatus: async (id: string) =>
    h.status[id] || { state: "STOPPED", position: 0, duration: 0, volume: 0 },
  alignDeviceToPosition: async (deviceId: string, targetSec: number) => {
    (h.memberCalls[deviceId] ??= []).push(`seek:${targetSec}`);
    return targetSec;
  },
}));

vi.mock("../../src/services/group/index.js", () => ({
  getGroupManager: () => ({
    get: (id: string) => h.groupStore.get(id),
    groupOfDevice: (deviceId: string) => h.groupOfDevice.get(deviceId),
    groupsOfDevice: (deviceId: string) => h.groupOfDevice.get(deviceId) || [],
    list: () => Array.from(h.groupStore.values()),
  }),
}));

vi.mock("../../src/services/player/index.js", () => ({
  getQueueController: () => h.qcRef.current,
  getPlayerController: () => h.pcRef.current,
}));

function makeItems(n: number): QueueItem[] {
  return Array.from({ length: n }, (_, i) => ({
    songId: `s${i + 1}`,
    title: `track${i + 1}`,
    mime: "audio/mpeg",
    duration: 100,
  }));
}

beforeAll(() => {
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS device_queues (
      device_id TEXT PRIMARY KEY,
      items_json TEXT NOT NULL DEFAULT '[]',
      current_index INTEGER NOT NULL DEFAULT -1,
      play_mode TEXT NOT NULL DEFAULT 'order',
      is_active INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    );
    CREATE TABLE IF NOT EXISTS group_queues (
      group_id TEXT PRIMARY KEY,
      items_json TEXT NOT NULL DEFAULT '[]',
      current_index INTEGER NOT NULL DEFAULT -1,
      play_mode TEXT NOT NULL DEFAULT 'order',
      is_active INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    );
    CREATE TABLE IF NOT EXISTS player_groups (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      member_ids_json TEXT NOT NULL DEFAULT '[]',
      created_at TEXT,
      updated_at TEXT
    );
  `);
});

function setup(): { qc: QueueController; pc: PlayerController } {
  const pc = new PlayerController();
  const qc = new QueueController();
  pc.onDecision = (d, pid) => { qc.handleDecision(d, pid).catch(() => {}); };
  h.qcRef.current = qc;
  h.pcRef.current = pc;
  // 真实 GroupProtocolPlayer:扇出路径复用(createDlnaProtocolPlayer 已 mock)。
  const up = new UniversalPlayer("group:g1", "组");
  up.attachProtocol(createGroupProtocolPlayer("g1"));
  qc.registerPlayer("g1", up, pc);
  // 队列默认 playMode="shuffle",playFrom 在 shuffle 下会忽略 startIndex 随机挑
  // 首曲(QueueController.playFrom),会让"首曲必须是 s1"的断言随机失败。本文件
  // 测的是组悬挂/恢复/对齐,与随机无关 → 钉成 order 保证确定性。
  qc.setQueue("g1", [], -1, "http://base");
  qc.setPlayMode("g1", "order");
  return { qc, pc };
}

beforeEach(() => {
  resetGroupWatchdogForTest();
  h.devices["d1"] = { available: true };
  h.devices["d2"] = { available: true };
  h.groupStore.clear();
  h.groupOfDevice.clear();
  h.status = {};
  for (const k of Object.keys(h.memberCalls)) h.memberCalls[k].length = 0;
});
afterEach(() => {
  h.qcRef.current = null;
  h.pcRef.current = null;
});

describe("rejoinMembers(成员加入播放中组对齐)", () => {
  it("组播放中:新成员 cast 当前曲 + seek 到 leader 进度;老成员不重复 cast", async () => {
    const { qc } = setup();
    h.groupStore.set("g1", { id: "g1", name: "组", memberIds: ["d1"] });
    h.groupOfDevice.set("d1", ["g1"]);
    await qc.playFrom("g1", makeItems(2), 0, "http://base");
    expect(h.memberCalls["d1"]).toContain("playMedia:s1");
    const before = h.memberCalls["d1"].length;

    h.status["d1"] = { state: "PLAYING", position: 30, duration: 100, volume: 0 };
    await qc.rejoinMembers("g1", ["d2"]);

    expect(h.memberCalls["d2"]).toEqual(["playMedia:s1", "seek:30"]);
    expect(h.memberCalls["d1"].length).toBe(before); // 老成员不被重投
  });

  it("组队列未激活 → 不动作", async () => {
    const { qc } = setup();
    h.groupStore.set("g1", { id: "g1", name: "组", memberIds: ["d1"] });
    await qc.playFrom("g1", makeItems(1), 0, "http://base");
    qc.deactivate("g1");
    await qc.rejoinMembers("g1", ["d2"]);
    expect(h.memberCalls["d2"] ?? []).toEqual([]);
  });

  it("新成员离线 → 跳过", async () => {
    const { qc } = setup();
    h.groupStore.set("g1", { id: "g1", name: "组", memberIds: ["d1"] });
    await qc.playFrom("g1", makeItems(1), 0, "http://base");
    h.devices["d2"] = { available: false };
    h.status["d1"] = { state: "PLAYING", position: 30, duration: 100, volume: 0 };
    await qc.rejoinMembers("g1", ["d2"]);
    expect(h.memberCalls["d2"] ?? []).toEqual([]);
  });

  it("组暂停 → 新成员对齐后同步暂停", async () => {
    const { qc } = setup();
    h.groupStore.set("g1", { id: "g1", name: "组", memberIds: ["d1"] });
    await qc.playFrom("g1", makeItems(1), 0, "http://base");
    h.status["d1"] = { state: "PAUSED_PLAYBACK", position: 10, duration: 100, volume: 0 };
    await qc.rejoinMembers("g1", ["d2"]);
    expect(h.memberCalls["d2"]).toEqual(["playMedia:s1", "seek:10", "pause"]);
  });

  it("新成员有个人激活队列 → 对齐后其个人队列标记不激活(保留 items)", async () => {
    const { qc } = setup();
    h.groupStore.set("g1", { id: "g1", name: "组", memberIds: ["d1"] });
    await qc.playFrom("g1", makeItems(1), 0, "http://base");
    h.status["d1"] = { state: "PLAYING", position: 5, duration: 100, volume: 0 };
    // d2 自己有一段个人队列(模拟其正单独播放)
    qc.setQueue("d2", makeItems(2), 0, "http://base");
    expect(qc.snapshot("d2").isActive).toBe(true);

    await qc.rejoinMembers("g1", ["d2"]);
    expect(qc.snapshot("d2").isActive).toBe(false); // 已被组接管
    expect(qc.snapshot("d2").items.length).toBe(2); // 队列保留
    expect(h.memberCalls["d2"]).toEqual(["playMedia:s1", "seek:5"]);
  });
});

describe("离线 watchdog(悬挂与恢复)", () => {
  it("全员离线 → 悬挂;成员回归 → 从当前曲+记录位置自动恢复", async () => {
    const { qc } = setup();
    h.groupStore.set("g1", { id: "g1", name: "组", memberIds: ["d1"] });
    h.groupOfDevice.set("d1", ["g1"]);
    await qc.playFrom("g1", makeItems(2), 0, "http://base");
    expect(h.memberCalls["d1"]).toContain("playMedia:s1");

    // tick,在线:记录 leader 进度 30
    h.status["d1"] = { state: "PLAYING", position: 30, duration: 100, volume: 0 };
    await runGroupWatchdogTick();

    // 全员离线 → 悬挂
    h.devices["d1"] = { available: false };
    await runGroupWatchdogTick();
    expect(qc.snapshot("g1").isActive).toBe(true); // 队列保留

    // 成员回归(state STOPPED → 走恢复)→ 重新 cast 当前曲 + seek 30
    h.devices["d1"] = { available: true };
    h.status["d1"] = { state: "STOPPED", position: 0, duration: 100, volume: 0 };
    await runGroupWatchdogTick();

    const calls = h.memberCalls["d1"];
    expect(calls.slice(-2)).toEqual(["playMedia:s1", "seek:30"]);
    expect(qc.snapshot("g1").isActive).toBe(true);
  });

  it("成员回归但设备已在播 → 跳过自动恢复(不重复 cast)", async () => {
    const { qc } = setup();
    h.groupStore.set("g1", { id: "g1", name: "组", memberIds: ["d1"] });
    await qc.playFrom("g1", makeItems(1), 0, "http://base");
    h.status["d1"] = { state: "PLAYING", position: 30, duration: 100, volume: 0 };
    await runGroupWatchdogTick();

    h.devices["d1"] = { available: false };
    await runGroupWatchdogTick(); // 悬挂

    h.devices["d1"] = { available: true };
    h.status["d1"] = { state: "PLAYING", position: 30, duration: 100, volume: 0 };
    const before = h.memberCalls["d1"].length;
    await runGroupWatchdogTick();
    expect(h.memberCalls["d1"].length).toBe(before); // 不重复触发续播
  });

  it("队列未激活 → 不悬挂也不恢复", async () => {
    const { qc } = setup();
    h.groupStore.set("g1", { id: "g1", name: "组", memberIds: ["d1"] });
    await qc.playFrom("g1", makeItems(1), 0, "http://base");
    qc.deactivate("g1"); // 已停止
    h.status["d1"] = { state: "STOPPED", position: 0, duration: 100, volume: 0 };

    await runGroupWatchdogTick();
    h.devices["d1"] = { available: false };
    await runGroupWatchdogTick();
    h.devices["d1"] = { available: true };
    const before = h.memberCalls["d1"].length;
    await runGroupWatchdogTick();
    expect(h.memberCalls["d1"].length).toBe(before);
  });

  it("组被删除后残余状态不影响其它动作(不崩溃、不误恢复)", async () => {
    const { qc } = setup();
    h.groupStore.set("g1", { id: "g1", name: "组", memberIds: ["d1"] });
    await qc.playFrom("g1", makeItems(1), 0, "http://base");
    h.status["d1"] = { state: "PLAYING", position: 30, duration: 100, volume: 0 };
    await runGroupWatchdogTick();
    h.devices["d1"] = { available: false };
    await runGroupWatchdogTick(); // 悬挂

    h.groupStore.delete("g1"); // 组被删
    h.devices["d1"] = { available: true };
    const before = h.memberCalls["d1"].length;
    await runGroupWatchdogTick(); // 不崩溃
    expect(h.memberCalls["d1"].length).toBe(before); // 已删组不误恢复
    // 再次让 d1 回归也不会有残留状态触发
  });
});