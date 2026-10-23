// 阶段 3 边界测试:成员加入播放中组对齐(rejoinMembers)+ 全员离线悬挂/成员回归恢复(watchdog)。
//
// ★ 2026-10-23 契约变更(统一 pump 时间线):组成员只有 sendspin / airplay,DLNA 禁止入组。
//   因此"新成员加入"不再逐设备 cast + 逐设备 seek 校准(那是 DLNA 自拉流模型的姿势),
//   改为:
//     - sendspin 新成员 → 直播沿入组(alignGroupMembers 处理,不在本文件);
//     - airplay 新成员 → **重建整组时间线**(桥接设备列表写在 HELLO 帧里,运行中新增
//       设备收不到 PCM,必须重建;见 QueueController.rejoinMembers)。
//   断言随之从「每个成员各收到 playMedia+seek」变成「组 pump 重建一次,并按 leader
//   位置起播」。
//
// mock 说明:
//   - dlna/control.js:getEffectiveBaseUrl / clearCurrentMedia + 单设备 player 工厂
//     (d1 的个人播放器用它,验证组激活期间成员不可独立播放)
//   - airplay/discovery.js:设备表与 available(充当组的 airplay 成员在线判定)
//   - sendspin/{protocolPlayer,index,playerCore}:pump 侧替身,记录组 pump 的起播/停止
//   - group/index.js 的 getGroupManager 用可控 stub
//   - player/index.js 的 getQueueController 指向测试创建的 QueueController 实例
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
  const groupStore = new Map<string, any>();
  const groupOfDevice = new Map<string, string[]>();
  /** pump(组时间线)调用流水。 */
  const pumpCalls: Array<{ fn: string; args: any[] }> = [];
  /** 桥接编排调用流水。 */
  const bridgeCalls: Array<{ fn: string; args: any[] }> = [];
  const qcRef: { current: QueueController | null } = { current: null };
  const pcRef: { current: PlayerController | null } = { current: null };
  const spinFrontRef = { value: null as any };
  const groupPoll = { playing: true, paused: false, positionMs: 30000, durationMs: 100000 } as any;

  function fakeMemberProtocol(deviceId: string): any {
    return {
      playerId: `dlna:${deviceId}`,
      async playMedia() { return { mediaUri: `uri-${deviceId}` }; },
      async stop() {},
      async pause() {},
      async resume() {},
      async seek() {},
      async setVolume() {},
      async pollState() { return { playerId: `dlna:${deviceId}`, playbackState: "PLAYING", position: 10, duration: 100, updatedAt: Date.now() }; },
    };
  }

  return { devices, groupStore, groupOfDevice, pumpCalls, bridgeCalls, qcRef, pcRef, spinFrontRef, groupPoll, fakeMemberProtocol };
});

vi.mock("../../src/services/dlna/control.js", () => ({
  createDlnaProtocolPlayer: (deviceId: string) => h.fakeMemberProtocol(deviceId),
  getEffectiveBaseUrl: () => "http://base",
  clearCurrentMedia: () => {},
  getDevice: (id: string) => (h.devices[id] ? { id, available: h.devices[id].available } : undefined),
  isDeviceAvailable: (id: string) => !!h.devices[id]?.available,
  getCachedDevices: () => Object.entries(h.devices).map(([id, d]) => ({ id, name: id, available: d.available })),
  getDeviceStatus: async () => ({ state: "STOPPED", position: 0, duration: 0, volume: 0 }),
  alignDeviceToPosition: async () => 0,
}));

vi.mock("../../src/services/airplay/discovery.js", () => ({
  getAirPlayDevice: (id: string) => {
    if (!h.devices[id]) return undefined;
    return { id, name: `ap-${id}`, alias: "", host: "10.0.0.9", port: 7000, pk: "pk", et: "0,1", available: h.devices[id].available };
  },
}));

vi.mock("../../src/services/group/airplayBridge.js", () => ({
  startGroupAirPlayBridge: async (groupId: string) => {
    const g = h.groupStore.get(groupId);
    const ap = (g?.memberIds ?? [])
      .filter((m: string) => m.startsWith("airplay:"))
      .map((m: string) => m.slice("airplay:".length))
      .filter((id: string) => !!h.devices[id]?.available);
    if (!ap.length) return null;
    h.bridgeCalls.push({ fn: "start", args: [groupId] });
    return { devices: ap, host: "127.0.0.1", port: 43823 };
  },
  stopGroupAirPlayBridge: async (groupId: string, reason?: string) => {
    h.bridgeCalls.push({ fn: "stop", args: [groupId, reason] });
  },
  stopAirPlayMemberBridge: async (deviceId: string, reason?: string) => {
    h.bridgeCalls.push({ fn: "stopMember", args: [deviceId, reason] });
  },
  seekGroupAirPlayBridge: async (groupId: string, seconds: number) => {
    h.bridgeCalls.push({ fn: "seek", args: [groupId, seconds] });
  },
  setGroupAirPlayVolume: async (groupId: string, volume: number) => {
    h.bridgeCalls.push({ fn: "volume", args: [groupId, volume] });
  },
}));

vi.mock("../../src/services/sendspin/protocolPlayer.js", () => ({
  createSendspinGroupPlayer: (gid: string) => ({
    playerId: `sendspin:${gid}`,
    async playMedia(item: any, baseUrl: string, startMs?: number, bridge?: any) {
      h.pumpCalls.push({ fn: "playMedia", args: [item, baseUrl, startMs, bridge] });
      return { mediaUri: `uri-pump-${gid}` };
    },
    async stop() { h.pumpCalls.push({ fn: "stop", args: [] }); },
    async pause() { h.pumpCalls.push({ fn: "pause", args: [] }); },
    async resume() { h.pumpCalls.push({ fn: "resume", args: [] }); },
    async seek(s: number) { h.pumpCalls.push({ fn: "seek", args: [s] }); },
    async setVolume(v: number) { h.pumpCalls.push({ fn: "setVolume", args: [v] }); },
    async pollState() { return { playerId: `sendspin:${gid}`, playbackState: "PLAYING", position: 30, duration: 100, updatedAt: Date.now() }; },
  }),
  createSendspinProtocolPlayer: (id: string) => h.fakeMemberProtocol(id),
}));

vi.mock("../../src/services/sendspin/index.js", async (importOriginal) => {
  const actual = await importOriginal<any>();
  return {
    ...actual,
    getSendspinFront: () => h.spinFrontRef.value,
    sendspinGroupPoll: async () => h.groupPoll,
    sendspinGroupJoin: async () => {},
    sendspinGroupLeave: async () => {},
    sendspinGroupTransport: async () => {},
  };
});

vi.mock("../../src/services/sendspin/playerCore.js", () => ({
  sendspinGroupName: (gid: string) => `ug:${gid}`,
}));

vi.mock("../../src/services/group/index.js", async (importOriginal) => {
  // 部分 mock:只替 getGroupManager,splitMemberId 等纯函数走真实实现(随源码演进)。
  const actual = await importOriginal<any>();
  return {
    ...actual,
    getGroupManager: () => ({
      get: (id: string) => h.groupStore.get(id),
      groupsOfDevice: (deviceId: string) => h.groupOfDevice.get(deviceId) || [],
      list: () => Array.from(h.groupStore.values()),
      getVolume: () => 20,
      setVolume: (_id: string, v: number) => v,
    }),
  };
});

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
    CREATE TABLE IF NOT EXISTS songs (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      artist TEXT DEFAULT '',
      artist_id TEXT,
      album TEXT DEFAULT '',
      album_id TEXT,
      duration INTEGER DEFAULT 0,
      bit_rate INTEGER DEFAULT 0,
      content_type TEXT DEFAULT 'audio/mpeg',
      suffix TEXT DEFAULT 'mp3',
      path TEXT NOT NULL,
      cover_art TEXT,
      play_count INTEGER DEFAULT 0,
      disc_number INTEGER DEFAULT 1,
      track INTEGER DEFAULT 0,
      genre TEXT DEFAULT '',
      size INTEGER DEFAULT 0,
      fingerprint TEXT,
      created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      updated_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      type TEXT DEFAULT 'local',
      url TEXT,
      stream_headers TEXT,
      source_data TEXT,
      plugin_entry TEXT,
      cache_path TEXT
    );

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
      owner_user_id TEXT NOT NULL DEFAULT '',
      name TEXT NOT NULL,
      member_ids TEXT NOT NULL DEFAULT '[]',
      volume INTEGER NOT NULL DEFAULT 20,
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
  // 真实 GroupProtocolPlayer:pump 与桥接都由上面的替身承接。
  const up = new UniversalPlayer("group:g1", "组");
  up.attachProtocol(createGroupProtocolPlayer("g1"));
  qc.registerPlayer("g1", up, pc);
  // 队列默认 shuffle 会随机挑首曲 → 钉成 order 保证确定性。
  qc.setQueue("g1", [], -1, "http://base");
  qc.setPlayMode("g1", "order");
  return { qc, pc };
}

const playCount = () => h.pumpCalls.filter((c) => c.fn === "playMedia").length;

beforeEach(() => {
  resetGroupWatchdogForTest();
  h.devices["d1"] = { available: true };
  h.devices["d2"] = { available: true };
  h.groupStore.clear();
  h.groupOfDevice.clear();
  h.pumpCalls.length = 0;
  h.bridgeCalls.length = 0;
  h.spinFrontRef.value = null;
  h.groupPoll.playing = true;
  h.groupPoll.paused = false;
  h.groupPoll.positionMs = 30000;
});
afterEach(() => {
  h.qcRef.current = null;
  h.pcRef.current = null;
});

describe("rejoinMembers(airplay 成员加入播放中组)", () => {
  it("组播放中:重建整组时间线(组 pump 再起一次),并按 leader 位置起播", async () => {
    const { qc } = setup();
    h.groupStore.set("g1", { id: "g1", name: "组", memberIds: ["airplay:d1"] });
    h.groupOfDevice.set("d1", ["g1"]);
    await qc.playFrom("g1", makeItems(2), 0, "http://base");
    expect(playCount()).toBe(1);

    h.devices["d2"] = { available: true };
    // leader 位置由 getGroupStatus → sendspinGroupPoll 给出(30s)
    await qc.rejoinMembers("g1", ["d2"]);

    expect(playCount()).toBe(2);
    const last = h.pumpCalls.filter((c) => c.fn === "playMedia").at(-1)!;
    expect(last.args[2]).toBe(30000); // startPositionMs = leader 位置
    // 桥接也重建了一次(新设备要进 HELLO 的设备列表)
    expect(h.bridgeCalls.filter((c) => c.fn === "start")).toHaveLength(2);
  });

  it("组队列未激活 → 不动作", async () => {
    const { qc } = setup();
    h.groupStore.set("g1", { id: "g1", name: "组", memberIds: ["airplay:d1"] });
    await qc.playFrom("g1", makeItems(1), 0, "http://base");
    qc.deactivate("g1");
    const before = playCount();
    await qc.rejoinMembers("g1", ["d2"]);
    expect(playCount()).toBe(before);
  });

  it("新成员离线 → 跳过(不重建)", async () => {
    const { qc } = setup();
    h.groupStore.set("g1", { id: "g1", name: "组", memberIds: ["airplay:d1"] });
    await qc.playFrom("g1", makeItems(1), 0, "http://base");
    h.devices["d2"] = { available: false };
    const before = playCount();
    await qc.rejoinMembers("g1", ["d2"]);
    expect(playCount()).toBe(before);
  });

  it("新成员有个人激活队列 → 重建后其个人队列标记不激活(保留 items)", async () => {
    const { qc } = setup();
    h.groupStore.set("g1", { id: "g1", name: "组", memberIds: ["airplay:d1"] });
    await qc.playFrom("g1", makeItems(1), 0, "http://base");
    qc.setQueue("d2", makeItems(2), 0, "http://base");
    expect(qc.snapshot("d2").isActive).toBe(true);

    await qc.rejoinMembers("g1", ["d2"]);
    expect(qc.snapshot("d2").isActive).toBe(false); // 已被组接管
    expect(qc.snapshot("d2").items.length).toBe(2); // 队列保留
  });

  it("非 airplay 成员(如误传裸 id)→ 不重建(sendspin 走直播沿加入)", async () => {
    const { qc } = setup();
    h.groupStore.set("g1", { id: "g1", name: "组", memberIds: ["airplay:d1", "sendspin:c1"] });
    await qc.playFrom("g1", makeItems(1), 0, "http://base");
    const before = playCount();
    await qc.rejoinMembers("g1", ["c1"]); // 裸 sendspin clientId,不是 airplay 设备
    expect(playCount()).toBe(before);
  });
});

describe("离线 watchdog(悬挂与恢复)", () => {
  it("全员离线 → 悬挂;成员回归 → 重建 pump 从记录位置自动恢复", async () => {
    const { qc } = setup();
    h.groupStore.set("g1", { id: "g1", name: "组", memberIds: ["airplay:d1"] });
    h.groupOfDevice.set("d1", ["g1"]);
    await qc.playFrom("g1", makeItems(2), 0, "http://base");
    expect(playCount()).toBe(1);

    // tick,在线:记录 leader 进度 30
    h.groupPoll.positionMs = 30000;
    await runGroupWatchdogTick();

    // 全员离线 → 悬挂(队列保留)
    h.devices["d1"] = { available: false };
    await runGroupWatchdogTick();
    expect(qc.snapshot("g1").isActive).toBe(true);
    expect(playCount()).toBe(1); // 悬挂不重建

    // 成员回归(state STOPPED → 走恢复)→ 重建 pump,位置 30s
    h.devices["d1"] = { available: true };
    h.groupPoll.playing = false;
    h.groupPoll.positionMs = 0;
    await runGroupWatchdogTick();

    expect(playCount()).toBe(2);
    const last = h.pumpCalls.filter((c) => c.fn === "playMedia").at(-1)!;
    expect(last.args[2]).toBe(30000);
    expect(qc.snapshot("g1").isActive).toBe(true);
  });

  it("成员回归但组已在播 → 跳过自动恢复(不重复起 pump)", async () => {
    const { qc } = setup();
    h.groupStore.set("g1", { id: "g1", name: "组", memberIds: ["airplay:d1"] });
    await qc.playFrom("g1", makeItems(1), 0, "http://base");
    await runGroupWatchdogTick();

    h.devices["d1"] = { available: false };
    await runGroupWatchdogTick(); // 悬挂

    h.devices["d1"] = { available: true };
    h.groupPoll.playing = true; // 组已在播
    const before = playCount();
    await runGroupWatchdogTick();
    expect(playCount()).toBe(before);
  });

  it("队列未激活 → 不悬挂也不恢复", async () => {
    const { qc } = setup();
    h.groupStore.set("g1", { id: "g1", name: "组", memberIds: ["airplay:d1"] });
    await qc.playFrom("g1", makeItems(1), 0, "http://base");
    qc.deactivate("g1"); // 已停止
    h.groupPoll.playing = false;

    await runGroupWatchdogTick();
    h.devices["d1"] = { available: false };
    await runGroupWatchdogTick();
    h.devices["d1"] = { available: true };
    const before = playCount();
    await runGroupWatchdogTick();
    expect(playCount()).toBe(before);
  });

  it("组被删除后残余状态不影响其它动作(不崩溃、不误恢复)", async () => {
    const { qc } = setup();
    h.groupStore.set("g1", { id: "g1", name: "组", memberIds: ["airplay:d1"] });
    await qc.playFrom("g1", makeItems(1), 0, "http://base");
    await runGroupWatchdogTick();
    h.devices["d1"] = { available: false };
    await runGroupWatchdogTick(); // 悬挂

    h.groupStore.delete("g1"); // 组被删
    h.devices["d1"] = { available: true };
    const before = playCount();
    await expect(runGroupWatchdogTick()).resolves.toBeUndefined();
    expect(playCount()).toBe(before);
  });
});
