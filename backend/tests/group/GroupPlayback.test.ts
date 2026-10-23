// 组播放链路测试:GroupProtocolPlayer(统一 pump 时间线)+ QueueController 组集成。
//
// ★ 2026-10-23 契约变更(用户拍板):群组成员只允许 sendspin / airplay,**DLNA 禁止入组**
//   (DLNA 是各设备自拉流的扇出模型,没有共享时间线,只能 roughly 同时起播)。
//   组的音频不再"逐成员 cast",而是**一条 pump**(ug:<groupId>)统一产出:
//     - sendspin 成员吃 pump 下发的时间戳;
//     - airplay 成员是 pump 的旁路 sink(经 airplayBridge 建立 RAOP 桥接会话)。
//   因此本文件不再断言"每个成员各收到一次 playMedia",而是断言
//   「pump 起一次 + 桥接建一次」,以及 QueueController 侧的组队列行为不变。
import { describe, it, expect, vi, beforeEach, afterEach, beforeAll } from "vitest";
import { QueueController } from "../../src/services/player/QueueController.js";
import { PlayerController } from "../../src/services/player/PlayerController.js";
import { UniversalPlayer } from "../../src/services/player/UniversalPlayer.js";
import { createGroupProtocolPlayer, getGroupStatus } from "../../src/services/group/protocolPlayer.js";
import { PlaybackState, type PlayerState, type ProtocolPlayer, type QueueItem } from "../../src/services/player/types.js";
import { sqlite } from "../../src/db/index.js";

const h = vi.hoisted(() => {
  /** 设备可用性表(同时充当 airplay discovery 的答案,key = 裸 deviceId)。 */
  const devices: Record<string, { available: boolean }> = {};
  const groupStore = new Map<string, any>();
  const groupOfDevice = new Map<string, string[]>();
  /** pump 侧调用流水(sendspin 组 player)。 */
  const spinCalls: Array<{ fn: string; args: any[] }> = [];
  /** 桥接编排调用流水。 */
  const bridgeCalls: Array<{ fn: string; args: any[] }> = [];
  const failOnPlay = { on: false };
  const groupPoll = { playing: true, paused: false, positionMs: 10000, durationMs: 100000 } as any;
  /** sendspin 在线客户端快照(getSendspinFront 的替身)。 */
  const spinFrontRef = { value: null as any };

  function fakeDlnaProtocol(deviceId: string): ProtocolPlayer {
    return {
      playerId: `dlna:${deviceId}`,
      async playMedia() { return { mediaUri: `uri-${deviceId}` }; },
      async stop() {},
      async pause() {},
      async resume() {},
      async seek() {},
      async setVolume() {},
      async pollState(): Promise<PlayerState> {
        return { playerId: `dlna:${deviceId}`, playbackState: PlaybackState.PLAYING, position: 10, duration: 100, updatedAt: Date.now() };
      },
    };
  }

  return { devices, groupStore, groupOfDevice, spinCalls, bridgeCalls, failOnPlay, groupPoll, spinFrontRef, fakeDlnaProtocol };
});

vi.mock("../../src/services/dlna/control.js", () => ({
  createDlnaProtocolPlayer: (deviceId: string) => h.fakeDlnaProtocol(deviceId),
  getEffectiveBaseUrl: () => "http://base",
  clearCurrentMedia: () => {},
  alignDeviceToPosition: async () => {},
  getDevice: (id: string) => (h.devices[id] ? { id, available: h.devices[id].available } : undefined),
  isDeviceAvailable: (id: string) => !!h.devices[id]?.available,
  getCachedDevices: () =>
    Object.entries(h.devices).map(([id, d]) => ({ id, name: id, available: d.available })),
  getDeviceStatus: async () => ({ state: "STOPPED", position: 0, duration: 0, volume: 0 }),
}));

vi.mock("../../src/services/airplay/discovery.js", () => ({
  getAirPlayDevice: (id: string) => {
    if (!h.devices[id]) return undefined;
    return { id, name: `ap-${id}`, alias: "", host: "10.0.0.9", port: 7000, pk: "pk", et: "0,1", available: h.devices[id].available };
  },
}));

vi.mock("../../src/services/group/airplayBridge.js", () => ({
  startGroupAirPlayBridge: async (groupId: string) => {
    // 真实实现:组内没有 airplay 成员时**直接返回 null、不产生任何 RPC**(见
    // group/airplayBridge.ts 首行 devices.length === 0)。替身必须同形,否则
    // 「纯 sendspin 组不该碰桥接」这条断言无从验证。
    const g0 = h.groupStore.get(groupId);
    const hasAp = (g0?.memberIds ?? []).some((m: string) => m.startsWith("airplay:"));
    if (!hasAp) return null;
    h.bridgeCalls.push({ fn: "start", args: [groupId] });
    // 只有组内真有 airplay 成员且可用时才返回桥接信息
    const g = h.groupStore.get(groupId);
    const ap = (g?.memberIds ?? [])
      .filter((m: string) => m.startsWith("airplay:"))
      .map((m: string) => m.slice("airplay:".length))
      .filter((id: string) => !!h.devices[id]?.available);
    return ap.length ? { devices: ap, host: "127.0.0.1", port: 43823, minSendAheadUs: 1200000 } : null;
  },
  stopGroupAirPlayBridge: async (groupId: string, reason?: string) => {
    h.bridgeCalls.push({ fn: "stop", args: [groupId, reason] });
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
      h.spinCalls.push({ fn: "playMedia", args: [item, baseUrl, startMs, bridge] });
      if (h.failOnPlay.on) throw new Error("pump 起不来");
      return { mediaUri: `uri-pump-${gid}` };
    },
    async stop() { h.spinCalls.push({ fn: "stop", args: [] }); },
    async pause() { h.spinCalls.push({ fn: "pause", args: [] }); },
    async resume() { h.spinCalls.push({ fn: "resume", args: [] }); },
    async seek(s: number) { h.spinCalls.push({ fn: "seek", args: [s] }); },
    async setVolume(v: number) { h.spinCalls.push({ fn: "setVolume", args: [v] }); },
    async pollState() { return { playerId: `sendspin:${gid}`, playbackState: PlaybackState.PLAYING, position: 10, duration: 100, updatedAt: Date.now() }; },
  }),
  // QueueController 还直接 import 了单设备版工厂(本文件不测单设备 sendspin)
  createSendspinProtocolPlayer: (id: string) => h.fakeDlnaProtocol(id),
}));

vi.mock("../../src/services/sendspin/index.js", async (importOriginal) => {
  const actual = await importOriginal<any>();
  return {
    ...actual,
    getSendspinFront: () => h.spinFrontRef.value,
    sendspinGroupPoll: async () => h.groupPoll,
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

// getSendspinFront 的可变引用(hoisted 里不能直接放循环引用,单开一个坑位)
function makeItems(n: number): QueueItem[] {
  return Array.from({ length: n }, (_, i) => ({
    songId: `s${i + 1}`,
    title: `track${i + 1}`,
    mime: "audio/mpeg",
    duration: 100,
  }));
}

/** 组内 sendspin 成员全部在线(组 pump 需要至少一个在线成员才会起播)。 */
function spinAllReady() {
  h.spinFrontRef.value = {
    clients: new Map([["c1", { ready: true }], ["c2", { ready: true }]]),
    groups: new Map([["ug:g1", { volume: 20, muted: false }]]),
  };
}

beforeAll(() => {
  // persist 需要 group_queues / player_groups / device_queues 表(测试不跑 initDatabase)
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
  `);
});

describe("GroupProtocolPlayer:统一 pump(不再逐成员 cast)", () => {
  beforeEach(() => {
    h.devices["d1"] = { available: true };
    h.devices["d2"] = { available: false };
    h.devices["d3"] = { available: true };
    h.groupStore.clear();
    h.groupOfDevice.clear();
    h.spinCalls.length = 0;
    h.bridgeCalls.length = 0;
    h.failOnPlay.on = false;
    h.spinFrontRef.value = null;
  });

  it("playMedia:桥接建一次 + pump 起一次,桥接信息透传给 pump", async () => {
    h.groupStore.set("g1", { id: "g1", name: "组", memberIds: ["airplay:d1", "airplay:d2"] });
    const p = createGroupProtocolPlayer("g1");
    const { mediaUri } = await p.playMedia(makeItems(1)[0], "http://base");
    expect(mediaUri).toBe("uri-pump-g1");
    // 离线成员 d2 不进桥接目标
    expect(h.bridgeCalls.map((c) => c.fn)).toEqual(["start"]);
    const pm = h.spinCalls.filter((c) => c.fn === "playMedia");
    expect(pm).toHaveLength(1);
    expect(pm[0].args[3]).toEqual({ devices: ["d1"], host: "127.0.0.1", port: 43823, minSendAheadUs: 1200000 });
  });

  it("纯 sendspin 组:不起桥接,pump 收到 undefined", async () => {
    spinAllReady();
    h.groupStore.set("g1", { id: "g1", name: "组", memberIds: ["sendspin:c1", "sendspin:c2"] });
    await createGroupProtocolPlayer("g1").playMedia(makeItems(1)[0], "http://base");
    expect(h.bridgeCalls).toEqual([]);
    expect(h.spinCalls.find((c) => c.fn === "playMedia")!.args[3]).toBeUndefined();
  });

  it("stop 顺序 = 先停 pump 再拆桥接", async () => {
    h.groupStore.set("g1", { id: "g1", name: "组", memberIds: ["airplay:d1"] });
    const p = createGroupProtocolPlayer("g1");
    await p.playMedia(makeItems(1)[0], "http://base");
    h.spinCalls.length = 0;
    h.bridgeCalls.length = 0;
    await p.stop();
    expect(h.spinCalls.map((c) => c.fn)).toEqual(["stop"]);
    expect(h.bridgeCalls.map((c) => c.fn)).toEqual(["stop"]);
  });

  it("seek / setVolume:pump 与桥接两路都下发", async () => {
    h.groupStore.set("g1", { id: "g1", name: "组", memberIds: ["airplay:d1", "sendspin:c1"] });
    const p = createGroupProtocolPlayer("g1");
    await p.seek(30);
    await p.setVolume(50);
    expect(h.spinCalls.find((c) => c.fn === "seek")!.args).toEqual([30]);
    expect(h.bridgeCalls.find((c) => c.fn === "seek")!.args).toEqual(["g1", 30]);
    expect(h.spinCalls.find((c) => c.fn === "setVolume")!.args).toEqual([50]);
    expect(h.bridgeCalls.find((c) => c.fn === "volume")!.args).toEqual(["g1", 50]);
  });

  it("无在线成员:playMedia 抛错且不建桥接;pollState 返回 BUFFERING", async () => {
    h.devices["d1"] = { available: false };
    h.groupStore.set("g1", { id: "g1", name: "组", memberIds: ["airplay:d1", "airplay:d2"] });
    const p = createGroupProtocolPlayer("g1");
    await expect(p.playMedia(makeItems(1)[0], "http://base")).rejects.toThrow("无在线成员");
    expect(h.bridgeCalls).toEqual([]);
    const state = await p.pollState();
    expect(state.playbackState).toBe(PlaybackState.BUFFERING);
    expect(state.playerId).toBe("group:g1");
  });

  it("pump 起播失败 → 立刻拆桥接(不留静音会话)", async () => {
    h.groupStore.set("g1", { id: "g1", name: "组", memberIds: ["airplay:d1"] });
    h.failOnPlay.on = true;
    await expect(createGroupProtocolPlayer("g1").playMedia(makeItems(1)[0], "http://base")).rejects.toThrow("pump 起不来");
    expect(h.bridgeCalls.map((c) => c.fn)).toEqual(["start", "stop"]);
  });

  it("pollState:airplay 成员在线时也从 pump 派生", async () => {
    h.groupStore.set("g1", { id: "g1", name: "组", memberIds: ["airplay:d3"] });
    const p = createGroupProtocolPlayer("g1");
    const state = await p.pollState();
    expect(state.playerId).toBe("group:g1");
    expect(state.playbackState).toBe(PlaybackState.PLAYING);
    expect(state.position).toBe(10);
  });

  it("getGroupStatus:无 leader → STOPPED;有在线成员 → 从 pump 派生", async () => {
    h.groupStore.set("g1", { id: "g1", name: "组", memberIds: ["airplay:d2"] }); // d2 离线 → 无 leader
    const idle = await getGroupStatus("g1");
    expect(idle.state).toBe("STOPPED");
    h.groupStore.set("g1", { id: "g1", name: "组", memberIds: ["airplay:d1"] });
    const s = await getGroupStatus("g1");
    expect(s.state).toBe("PLAYING");
    expect(s.position).toBe(10);
  });
});

describe("QueueController 组集成", () => {
  beforeEach(() => {
    h.devices["d1"] = { available: true };
    h.devices["d2"] = { available: false };
    h.groupStore.clear();
    h.groupOfDevice.clear();
    h.spinCalls.length = 0;
    h.bridgeCalls.length = 0;
    h.failOnPlay.on = false;
    h.spinFrontRef.value = null;
    vi.useFakeTimers();
  });
  afterEach(() => { vi.useRealTimers(); });

  it("组队列 playFrom 起 pump;组播放期间成员个人决策被压制;组 advance 正常切歌并持久化", async () => {
    h.groupStore.set("g1", { id: "g1", name: "组", memberIds: ["airplay:d1", "airplay:d2"] });
    h.groupOfDevice.set("d1", ["g1"]);
    const pc = new PlayerController();
    const qc = new QueueController();
    pc.onDecision = (d, pid) => { qc.handleDecision(d, pid).catch(() => {}); };

    // 组 player:UniversalPlayer 绑定真实 GroupProtocolPlayer(内部走替身 pump/桥接)
    const gup = new UniversalPlayer("group:g1", "组");
    gup.attachProtocol(createGroupProtocolPlayer("g1"));
    qc.registerPlayer("g1", gup, pc);
    // d1 单独注册(模拟其个人播放能力,验证组播放期间的压制)
    const d1up = new UniversalPlayer("dlna:d1", "d1");
    d1up.attachProtocol(h.fakeDlnaProtocol("d1") as unknown as ProtocolPlayer);
    qc.registerPlayer("d1", d1up, pc);

    // 队列默认 shuffle 会随机挑首曲 → 钉成 order(本用例测扇出/压制/持久化)
    qc.setQueue("g1", [], -1, "http://base");
    qc.setPlayMode("g1", "order");

    // 组播放 → 起一次 pump(在线成员 d1 进桥接目标)
    await qc.playFrom("g1", makeItems(2), 0, "http://base");
    expect(h.spinCalls.filter((c) => c.fn === "playMedia")).toHaveLength(1);
    expect(h.bridgeCalls.filter((c) => c.fn === "start")).toHaveLength(1);
    expect(qc.snapshot("g1").isActive).toBe(true);

    // d1 个人队列(异常场景):组播放期间的成员决策必须被压制
    qc.setQueue("d1", makeItems(2), 0, "http://base");
    const before = h.spinCalls.length;
    await qc.handleDecision("advance", "dlna:d1");
    expect(h.spinCalls.length).toBe(before);
    await qc.handleDecision("ended", "dlna:d1");
    expect(qc.snapshot("d1").ended).toBe(false);

    // 组 advance:切到 s2 并再次起 pump
    await qc.handleDecision("advance", "group:g1");
    const pms = h.spinCalls.filter((c) => c.fn === "playMedia");
    expect(pms).toHaveLength(2);
    expect((pms[1].args[0] as any).songId).toBe("s2");
    expect(qc.snapshot("g1").currentIndex).toBe(1);

    // 组队列持久化到 group_queues 表
    const row = sqlite.prepare("SELECT * FROM group_queues WHERE group_id = 'g1'").get() as any;
    expect(row).toBeTruthy();
    expect(row.current_index).toBe(1);
    expect(row.is_active).toBe(1);
  });

  it("组未在播时,成员个人决策不受压制", async () => {
    h.groupStore.set("g1", { id: "g1", name: "组", memberIds: ["airplay:d1"] });
    h.groupOfDevice.set("d1", ["g1"]);
    const pc = new PlayerController();
    const qc = new QueueController();
    pc.onDecision = (d, pid) => { qc.handleDecision(d, pid).catch(() => {}); };
    const d1up = new UniversalPlayer("dlna:d1", "d1");
    d1up.attachProtocol(h.fakeDlnaProtocol("d1") as unknown as ProtocolPlayer);
    qc.registerPlayer("d1", d1up, pc);

    // d1 有自己的播放队列,组队列未激活 → 正常切歌(走它自己的 player,不动 pump)
    qc.setQueue("d1", makeItems(2), 0, "http://base");
    await qc.handleDecision("advance", "dlna:d1");
    expect(qc.snapshot("d1").currentIndex).toBe(1);
    expect(h.spinCalls).toEqual([]);
  });

  it("clear:清组队列 → 停 pump + 拆桥接;组播放期间清成员个人队列不打断组", async () => {
    h.groupStore.set("g1", { id: "g1", name: "组", memberIds: ["airplay:d1", "airplay:d2"] });
    h.groupOfDevice.set("d1", ["g1"]);
    const pc = new PlayerController();
    const qc = new QueueController();
    pc.onDecision = (d, pid) => { qc.handleDecision(d, pid).catch(() => {}); };

    const gup = new UniversalPlayer("group:g1", "组");
    gup.attachProtocol(createGroupProtocolPlayer("g1"));
    qc.registerPlayer("g1", gup, pc);
    const d1up = new UniversalPlayer("dlna:d1", "d1");
    d1up.attachProtocol(h.fakeDlnaProtocol("d1") as unknown as ProtocolPlayer);
    qc.registerPlayer("d1", d1up, pc);

    // 组激活(setQueue 设 isActive=true)
    qc.setQueue("g1", makeItems(2), 0, "http://base");
    expect(qc.snapshot("g1").isActive).toBe(true);

    // 组播放期间清成员 d1 的个人队列 → 不停组泵
    const stopsBefore = h.spinCalls.filter((c) => c.fn === "stop").length;
    qc.setQueue("d1", makeItems(1), 0, "http://base");
    qc.clear("d1");
    expect(h.spinCalls.filter((c) => c.fn === "stop").length).toBe(stopsBefore);

    // 清组自身队列 → 停 pump + 拆桥接
    qc.clear("g1");
    // clear() 内部的 stop 是 fire-and-forget,而 GroupProtocolPlayer.stop 里有
    // `await import(...)` 链 ⇒ 必须让出一拍 microtask 才能观测到副作用。
    await vi.advanceTimersByTimeAsync(10);
    expect(qc.snapshot("g1").items).toHaveLength(0);
    expect(qc.snapshot("g1").isActive).toBe(false);
    expect(h.spinCalls.filter((c) => c.fn === "stop").length).toBe(1);
    expect(h.bridgeCalls.filter((c) => c.fn === "stop")).toHaveLength(1);
  });
});
