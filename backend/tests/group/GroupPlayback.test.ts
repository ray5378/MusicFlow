// 组播放链路测试:GroupProtocolPlayer 扇出 + QueueController 组集成。
//
// mock 说明:
//   - dlna/control.js 全量 mock(createDlnaProtocolPlayer 返回可记录调用的 fake)
//   - group/index.js 的 getGroupManager 用可控 stub(避免真实 GroupManager 的 DB 写入
//     与其他测试文件并行时的数据竞争;GroupManager 本身有独立测试覆盖)
import { describe, it, expect, vi, beforeEach, afterEach, beforeAll } from "vitest";
import { QueueController } from "../../src/services/player/QueueController.js";
import { PlayerController } from "../../src/services/player/PlayerController.js";
import { UniversalPlayer } from "../../src/services/player/UniversalPlayer.js";
import { createGroupProtocolPlayer, getGroupStatus } from "../../src/services/group/protocolPlayer.js";
import { PlaybackState, type PlayerState, type ProtocolPlayer, type QueueItem } from "../../src/services/player/types.js";
import { sqlite } from "../../src/db/index.js";

const h = vi.hoisted(() => {
  const devices: Record<string, { available: boolean }> = {};
  const groupStore = new Map<string, { id: string; name: string; memberIds: string[] }>();
  const groupOfDevice = new Map<string, string[]>();
  const memberCalls: Record<string, string[]> = {};
  const failOnPlay = new Set<string>();

  function fakeDlnaProtocol(deviceId: string): ProtocolPlayer {
    const calls: string[] = (memberCalls[deviceId] ??= []);
    return {
      playerId: `dlna:${deviceId}`,
      async playMedia(item: QueueItem) {
        calls.push(`playMedia:${item.songId}`);
        if (failOnPlay.has(deviceId)) throw new Error("cast 失败");
        return { mediaUri: `uri-${deviceId}` };
      },
      async stop() { calls.push("stop"); },
      async pause() { calls.push("pause"); },
      async resume() { calls.push("resume"); },
      async seek(s: number) { calls.push(`seek:${s}`); },
      async setVolume(v: number) { calls.push(`volume:${v}`); },
      async pollState(): Promise<PlayerState> {
        return {
          playerId: `dlna:${deviceId}`,
          playbackState: PlaybackState.PLAYING,
          position: 10,
          duration: 100,
          mediaUri: `uri-${deviceId}`,
          updatedAt: Date.now(),
        };
      },
    };
  }

  return { devices, groupStore, groupOfDevice, memberCalls, failOnPlay, fakeDlnaProtocol };
});

vi.mock("../../src/services/dlna/control.js", () => ({
  createDlnaProtocolPlayer: (deviceId: string) => h.fakeDlnaProtocol(deviceId),
  getEffectiveBaseUrl: () => "http://base",
  clearCurrentMedia: () => {},
  getDevice: (id: string) => (h.devices[id] ? { id, available: h.devices[id].available } : undefined),
  isDeviceAvailable: (id: string) => !!h.devices[id]?.available,
  getCachedDevices: () =>
    Object.entries(h.devices).map(([id, d]) => ({ id, name: id, available: d.available })),
  getDeviceStatus: async () => ({ state: "STOPPED", position: 0, duration: 0, volume: 0 }),
}));

vi.mock("../../src/services/group/index.js", () => ({
  getGroupManager: () => ({
    get: (id: string) => h.groupStore.get(id),
    groupOfDevice: (deviceId: string) => h.groupOfDevice.get(deviceId),
    groupsOfDevice: (deviceId: string) => h.groupOfDevice.get(deviceId) || [],
    list: () => Array.from(h.groupStore.values()),
  }),
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
  // persist 需要 group_queues / player_groups / device_queues 表(测试不跑 initDatabase)
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
  `);
});

describe("GroupProtocolPlayer 扇出", () => {
  beforeEach(() => {
    h.devices["d1"] = { available: true };
    h.devices["d2"] = { available: false };
    h.devices["d3"] = { available: true };
    h.groupStore.clear();
    h.groupOfDevice.clear();
    h.failOnPlay.clear();
    for (const k of Object.keys(h.memberCalls)) h.memberCalls[k].length = 0;
  });

  it("playMedia 扇出到在线成员,离线成员跳过;返回 leader 的 mediaUri", async () => {
    h.groupStore.set("g1", { id: "g1", name: "组", memberIds: ["d1", "d2"] });
    const p = createGroupProtocolPlayer("g1");
    const { mediaUri } = await p.playMedia(makeItems(1)[0], "http://base");
    expect(mediaUri).toBe("uri-d1");
    expect(h.memberCalls["d1"]).toEqual(["playMedia:s1"]);
    expect(h.memberCalls["d2"] ?? []).toEqual([]); // 离线成员不 cast
  });

  it("stop/pause/resume/seek/setVolume 扇出到在线成员", async () => {
    h.groupStore.set("g1", { id: "g1", name: "组", memberIds: ["d1", "d2", "d3"] });
    const p = createGroupProtocolPlayer("g1");
    await p.stop();
    await p.pause();
    await p.resume();
    await p.seek(30);
    await p.setVolume(50);
    expect(h.memberCalls["d1"]).toEqual(["stop", "pause", "resume", "seek:30", "volume:50"]);
    expect(h.memberCalls["d3"]).toEqual(["stop", "pause", "resume", "seek:30", "volume:50"]);
    expect(h.memberCalls["d2"] ?? []).toEqual([]);
  });

  it("pollState 从 leader(第一个在线成员)派生,playerId 为组 id", async () => {
    h.groupStore.set("g1", { id: "g1", name: "组", memberIds: ["d2", "d3"] });
    const p = createGroupProtocolPlayer("g1");
    const state = await p.pollState();
    expect(state.playerId).toBe("group:g1");
    expect(state.playbackState).toBe(PlaybackState.PLAYING);
    expect(state.position).toBe(10);
    expect(state.mediaUri).toBe("uri-d3"); // leader = d3(d2 离线)
  });

  it("无在线成员:playMedia 抛错,pollState 返回 BUFFERING(不误报 IDLE,避免被当作曲目结束)", async () => {
    h.devices["d1"] = { available: false }; // 全离线
    h.groupStore.set("g1", { id: "g1", name: "组", memberIds: ["d1", "d2"] });
    const p = createGroupProtocolPlayer("g1");
    await expect(p.playMedia(makeItems(1)[0], "http://base")).rejects.toThrow("无在线成员");
    const state = await p.pollState();
    expect(state.playbackState).toBe(PlaybackState.BUFFERING);
    expect(state.playerId).toBe("group:g1");
  });

  it("部分成员 cast 失败不影响其余成员", async () => {
    h.groupStore.set("g1", { id: "g1", name: "组", memberIds: ["d1", "d3"] });
    h.failOnPlay.add("d1");
    const p = createGroupProtocolPlayer("g1");
    const { mediaUri } = await p.playMedia(makeItems(1)[0], "http://base");
    expect(mediaUri).toBe("uri-d3"); // d1 失败,d3 成功
    expect(h.memberCalls["d1"]).toContain("playMedia:s1");
  });

  it("全部成员 cast 失败 → 抛错", async () => {
    h.groupStore.set("g1", { id: "g1", name: "组", memberIds: ["d1", "d3"] });
    h.failOnPlay.add("d1");
    h.failOnPlay.add("d3");
    const p = createGroupProtocolPlayer("g1");
    await expect(p.playMedia(makeItems(1)[0], "http://base")).rejects.toThrow("全部成员 cast 失败");
  });

  it("getGroupStatus:无 leader 返回 STOPPED,有 leader 返回其设备状态", async () => {
    h.groupStore.set("g1", { id: "g1", name: "组", memberIds: ["d2"] }); // d2 离线 → 无 leader
    const idle = await getGroupStatus("g1");
    expect(idle.state).toBe("STOPPED");
    h.groupStore.set("g1", { id: "g1", name: "组", memberIds: ["d1"] });
    const s = await getGroupStatus("g1");
    expect(s.state).toBe("STOPPED"); // mock 的 getDeviceStatus 默认 STOPPED
    expect(s.position).toBe(0);
  });
});

describe("QueueController 组集成", () => {
  beforeEach(() => {
    h.devices["d1"] = { available: true };
    h.devices["d2"] = { available: false };
    h.groupStore.clear();
    h.groupOfDevice.clear();
    h.failOnPlay.clear();
    for (const k of Object.keys(h.memberCalls)) h.memberCalls[k].length = 0;
    vi.useFakeTimers();
  });
  afterEach(() => { vi.useRealTimers(); });

  it("组队列 playFrom 扇出;组播放期间成员个人队列决策被压制;组 advance 正常切歌;组队列持久化到 group_queues", async () => {
    h.groupStore.set("g1", { id: "g1", name: "组", memberIds: ["d1", "d2"] });
    h.groupOfDevice.set("d1", ["g1"]);
    const pc = new PlayerController();
    const qc = new QueueController();
    pc.onDecision = (d, pid) => { qc.handleDecision(d, pid).catch(() => {}); };

    // 组 player:UniversalPlayer 绑定真实 GroupProtocolPlayer
    const gup = new UniversalPlayer("group:g1", "组");
    gup.attachProtocol(createGroupProtocolPlayer("g1"));
    qc.registerPlayer("g1", gup, pc);
    // d1 单独注册(模拟其个人播放能力)
    const d1up = new UniversalPlayer("dlna:d1", "d1");
    d1up.attachProtocol(h.fakeDlnaProtocol("d1") as unknown as ProtocolPlayer);
    qc.registerPlayer("d1", d1up, pc);

    // 组播放 → 扇出到在线成员 d1
    await qc.playFrom("g1", makeItems(2), 0, "http://base");
    expect(h.memberCalls["d1"]).toContain("playMedia:s1");
    expect(h.memberCalls["d2"] ?? []).toEqual([]);
    expect(qc.snapshot("g1").isActive).toBe(true);

    // d1 个人队列(异常场景,但验证组播放期间其决策被压制)
    qc.setQueue("d1", makeItems(2), 0, "http://base");
    const before = h.memberCalls["d1"].length;
    await qc.handleDecision("advance", "dlna:d1");
    expect(h.memberCalls["d1"].length).toBe(before); // 被压制,不 cast
    await qc.handleDecision("ended", "dlna:d1");
    expect(qc.snapshot("d1").ended).toBe(false); // 不被标记结束

    // 组 advance:切到 s2 并再次扇出
    await qc.handleDecision("advance", "group:g1");
    expect(h.memberCalls["d1"]).toContain("playMedia:s2");
    expect(qc.snapshot("g1").currentIndex).toBe(1);

    // 组队列持久化到 group_queues 表
    const row = sqlite.prepare("SELECT * FROM group_queues WHERE group_id = 'g1'").get() as any;
    expect(row).toBeTruthy();
    expect(row.current_index).toBe(1);
    expect(row.is_active).toBe(1);
  });

  it("组未在播时,成员个人决策不受压制", async () => {
    h.groupStore.set("g1", { id: "g1", name: "组", memberIds: ["d1"] });
    h.groupOfDevice.set("d1", ["g1"]);
    const pc = new PlayerController();
    const qc = new QueueController();
    pc.onDecision = (d, pid) => { qc.handleDecision(d, pid).catch(() => {}); };
    const d1up = new UniversalPlayer("dlna:d1", "d1");
    d1up.attachProtocol(h.fakeDlnaProtocol("d1") as unknown as ProtocolPlayer);
    qc.registerPlayer("d1", d1up, pc);

    // d1 有自己的播放队列,组队列未激活
    qc.setQueue("d1", makeItems(2), 0, "http://base");
    await qc.handleDecision("advance", "dlna:d1");
    expect(h.memberCalls["d1"]).toContain("playMedia:s2"); // 正常切歌
  });
});
