// v4.9.3 方向 A 定向单测:sendspin 组泵合法空成员化(纯 AirPlay 桥组)。
//   ① 无直连 sendspin 成员 + 带 bridge 规格 → playMedia 放行:
//     先灌组落库音量,再 sendspinGroupPlay(members=[], bridge 原样透传);
//   ② 无成员且无 bridge → 仍抛「无在线 sendspin 成员」(原守卫不放松)。
// 全依赖 mock,不碰真实网络/子进程。
import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => {
  const groups = new Map<string, { id: string; name: string; memberIds: string[] }>();
  const gm = {
    get: (id: string) => groups.get(id),
    getVolume: () => 42,
    setVolume: () => 42,
  };
  const playCalls: Array<{ gname: string; members: string[]; bridge?: any }> = [];
  const transportCalls: Array<{ gname: string; op: string; arg?: any }> = [];
  return { groups, gm, playCalls, transportCalls };
});

vi.mock("../../src/services/dlna/control.js", () => ({
  createCastSession: (songId: string, _playerId: string, _baseUrl: string) => ({ streamUrl: `u/${songId}` }),
  getEffectiveBaseUrl: () => "http://b",
}));

vi.mock("../../src/services/group/index.js", async (importOriginal) => {
  const actual = await importOriginal<any>();
  return { getGroupManager: () => h.gm, splitMemberId: actual.splitMemberId };
});

vi.mock("../../src/services/sendspin/index.js", () => ({
  getSendspinFront: () => null,
  sendspinGroupPlay: async (gname: string, members: string[], _item: any, _startMs?: number, bridge?: any) => {
    h.playCalls.push({ gname, members, bridge });
  },
  sendspinGroupTransport: async (gname: string, op: string, arg?: any) => {
    h.transportCalls.push({ gname, op, arg });
    return true;
  },
  sendspinGroupStop: async () => {},
  sendspinGroupJoin: async () => ({ joined: true, live: false }),
  sendspinGroupLeave: async () => true,
  sendspinGroupPumpActive: async () => true,
  sendspinGroupPoll: async () => ({ playing: false, paused: false, positionMs: 0, durationMs: 0, buffering: false }),
  sendspinGroupBridgeSync: async () => ({ synced: 0, backfilled: 0, confirmed: true }),
}));

vi.mock("../../src/services/sendspin/playerCore.js", () => ({
  playCore: async () => {},
  stopCore: () => {},
  pauseCore: () => {},
  resumePumpCore: () => {},
  seekCore: () => {},
  setVolumeCore: () => {},
  pollCore: async () => ({ playbackState: "IDLE" }),
  pumpActiveCore: () => false,
  sendspinGroupName: (gid: string) => `ug:${gid}`,
  ephemeralGroup: () => "eph",
}));

vi.mock("../../src/services/sendspin/runtime.js", () => ({ getServer: () => null, setServer: () => {} }));
vi.mock("../../src/services/sendspin/mode.js", () => ({ isForkMode: () => false }));
vi.mock("../../src/services/sendspin/supervisor.js", () => ({
  sendspinSupervisor: { isRunning: () => false, rpc: async () => null },
}));
vi.mock("../../src/services/player/index.js", () => ({
  getQueueController: () => ({ stopPlayback: () => {}, snapshot: () => null }),
  getPlayerController: () => ({ reportState: () => {} }),
}));

import { createSendspinGroupPlayer } from "../../src/services/sendspin/protocolPlayer.js";

function makeItem(songId = "s1"): any { return { songId, title: "t", mime: "audio/mpeg", duration: 100 }; }

beforeEach(() => {
  h.groups.clear();
  h.playCalls.length = 0;
  h.transportCalls.length = 0;
});

describe("v4.9.3 方向 A:sendspin 组泵合法空成员化", () => {
  it("无直连成员 + bridge 规格 → 放行:先灌组落库音量,再 members=[] + bridge 透传", async () => {
    h.groups.set("g1", { id: "g1", name: "组", memberIds: ["airplay:ap1"] });
    const bridge = { sockets: [{ deviceId: "ap1", socketPath: "/tmp/x.sock", token: "t", protocol: "raop" as const }] };
    const r = await createSendspinGroupPlayer("g1").playMedia(makeItem(), "http://b", 0, bridge);
    expect(r.mediaUri).toBe("u/s1");
    // 起播前先灌 GroupManager 持久值(既有语义,纯 AP 组同样生效)
    expect(h.transportCalls[0]).toEqual({ gname: "ug:g1", op: "volume", arg: 42 });
    expect(h.playCalls).toHaveLength(1);
    expect(h.playCalls[0].gname).toBe("ug:g1");
    expect(h.playCalls[0].members).toEqual([]);
    expect(h.playCalls[0].bridge).toEqual(bridge);
  });

  it("无成员且无 bridge → 仍抛「无在线 sendspin 成员」(原守卫不放松)", async () => {
    h.groups.set("g1", { id: "g1", name: "组", memberIds: ["airplay:ap1"] });
    await expect(createSendspinGroupPlayer("g1").playMedia(makeItem(), "http://b"))
      .rejects.toThrow("无在线 sendspin 成员");
    expect(h.playCalls).toHaveLength(0);
  });
});
