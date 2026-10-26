// ==================== 群组桥协议逐成员分流(Phase 6b · T04)====================
//
// 钉死四件事:
//   ① AP1-only 成员选 raop(改协议后 AP1 组逐字节同行为);
//   ② 已配对 AP2 成员选 ap2-realtime;
//   ③ 未配对 AP2 成员选 raop(未配对不得入组由 group/index 准入拦,这里只保证不误选 AP2);
//   ④ 混合组里**每个成员各按自己的协议**进桥(协议是逐成员的,不是组级),
//      且 `BridgeSocketSpec.protocol` 一路透传到组泵(CONFIG 用)。
// 另钉运行期降级:AP2 链路断 ⇒ 摘桥 + 清 owner + 该设备本流回落 solo cast(不留 owner=bridge)。
//
// 全部依赖 mock:桥 prepare/stop、组泵 sync、设备状态都不碰真实网络与子进程。
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const H = vi.hoisted(() => {
  const prepareCalls: Array<{ deviceId: string; token: string; protocol: string; groupId?: string }> = [];
  const bridgeStopCalls: Array<{ token: string; deviceId?: string }> = [];
  const syncCalls: Array<{ gname: string; specs: Array<{ deviceId: string; protocol: string }> }> = [];
  const soloPlay: Array<{ deviceId: string; songId: string; baseUrl: string }> = [];
  const groups = new Map<string, { id: string; name: string; memberIds: string[] }>();
  const apStatus: Record<string, any> = {};
  const apDisabled = new Set<string>();
  const bridgeOwned = new Set<string>();
  /** 设备 → 协议表(模拟 control.selectAirPlayBridgeProtocol 的选择结果)。 */
  const protocolOf: Record<string, string> = {};
  const state = {
    bridgeEnabled: true,
    supervisorRunning: false,
    bridgeStatus: [] as Array<{ deviceId: string; token: string; degraded?: boolean; linkLoss?: string | null }>,
    failPrepare: new Set<string>(),
    currentItem: null as null | { songId: string; title?: string },
  };
  const gm = {
    get: (id: string) => groups.get(id),
    list: () => Array.from(groups.values()),
    getVolume: () => 30,
    setVolume: () => 30,
    groupsOfDevice: () => [],
  };
  const qc = {
    snapshot: (_pid: string) => ({
      items: state.currentItem ? [state.currentItem] : [],
      currentIndex: state.currentItem ? 0 : -1,
    }),
  };
  const airplayPlayer = (id: string) => ({
    playerId: `airplay:${id}`,
    async playMedia(item: any, baseUrl: string) {
      soloPlay.push({ deviceId: id, songId: item.songId, baseUrl });
      return { mediaUri: `solo-${id}` };
    },
    async stop() {},
    async pause() {},
    async resume() {},
    async seek() {},
    async setVolume() {},
    async pollState() {
      return { playerId: `airplay:${id}`, playbackState: "PLAYING", position: 0, duration: 0, updatedAt: 0 };
    },
  });
  const sendspinPlayer = (gid: string) => ({
    playerId: `sendspin:${gid}`,
    async playMedia(_item: any, _baseUrl: string, _startMs = 0, opts?: any) {
      // 组泵侧桥同步:specs 由 sendspinGroupPlayer.playMedia 的 bridge 参数下发
      // (与生产路径一致 —— prepareBridgeRoute 只产出规格,sync 由泵侧做)。
      H.syncCalls.push({
        gname: `ug:${gid}`,
        specs: (opts?.sockets ?? []).map((s: any) => ({ deviceId: s.deviceId, protocol: s.protocol })),
      });
      return { mediaUri: `spin-${gid}` };
    },
    async stop() {},
    async pause() {},
    async resume() {},
    async seek() {},
    async setVolume() {},
    async pollState() {
      return { playerId: `sendspin:${gid}`, playbackState: "PLAYING", position: 0, duration: 0, updatedAt: 0 };
    },
  });
  return {
    prepareCalls, bridgeStopCalls, syncCalls, soloPlay, groups, apStatus, apDisabled,
    bridgeOwned, protocolOf, state, gm, qc, airplayPlayer, sendspinPlayer,
  };
});

vi.mock("../../src/services/group/index.js", async (importOriginal) => {
  const actual = await importOriginal<any>();
  return { getGroupManager: () => H.gm, splitMemberId: actual.splitMemberId };
});

vi.mock("../../src/services/airplay/control.js", () => ({
  getAirPlayStatus: (id: string) =>
    H.apStatus[id] ?? { available: true, name: id, playbackState: "IDLE", position: 0, duration: 0, volume: 0, muted: false },
  isAirPlayDeviceDisabled: (id: string) => H.apDisabled.has(id),
  isAirplayBridgeEnabled: () => H.state.bridgeEnabled,
  isBridgeOwned: (id: string) => H.bridgeOwned.has(id),
  // 真实选择器在 tests/airplay/ap2ProtocolSelect.test.ts 覆盖;这里用查表模拟其结果。
  selectAirPlayBridgeProtocol: (id: string) => H.protocolOf[id] ?? "raop",
  bridgePrepareDevice: async (deviceId: string, token: string, protocol: string, groupId?: string) => {
    H.prepareCalls.push({ deviceId, token, protocol, groupId });
    if (H.state.failPrepare.has(deviceId)) throw new Error("prepare failed");
    return { listening: true, socketPath: `/tmp/b_${deviceId}_${token}.sock` };
  },
  bridgeStopDevice: async (token: string, deviceId?: string) => {
    H.bridgeStopCalls.push({ token, deviceId });
    if (deviceId) H.bridgeOwned.delete(deviceId); // 清 owner=bridge(真实实现同语义)
  },
}));

vi.mock("../../src/services/airplay/bridgeChannel.js", () => ({
  bridgeSocketPath: (deviceId: string, token: string) => `/tmp/b_${deviceId}_${token}.sock`,
}));

vi.mock("../../src/services/airplay/protocolPlayer.js", () => ({
  createAirPlayProtocolPlayer: (id: string) => H.airplayPlayer(id),
}));

vi.mock("../../src/services/airplay/supervisor.js", () => ({
  airplaySupervisor: {
    isRunning: () => H.state.supervisorRunning,
    rpc: async () => H.state.bridgeStatus,
  },
}));

vi.mock("../../src/services/dlna/control.js", () => ({
  createDlnaProtocolPlayer: () => ({
    playerId: "dlna:x",
    async playMedia() { return { mediaUri: "dlna-x" }; },
    async stop() {}, async pause() {}, async resume() {}, async seek() {}, async setVolume() {},
    async pollState() { return { playerId: "dlna:x", playbackState: "PLAYING", position: 0, duration: 0, updatedAt: 0 }; },
  }),
  getDevice: (id: string) => ({ id }),
  isDeviceAvailable: () => true,
  getDeviceStatus: async () => ({ state: "STOPPED", position: 0, duration: 0, volume: 0 }),
  // 降级回落 solo cast 时用来取 LAN 可达 baseUrl。
  getEffectiveBaseUrl: () => "http://127.0.0.1:8686",
}));

vi.mock("../../src/services/player/index.js", () => ({
  getQueueController: () => H.qc,
}));

vi.mock("../../src/services/sendspin/index.js", () => ({
  getSendspinFront: () => ({ clients: new Map([["sp1", { ready: true }]]) }),
  sendspinGroupBridgeSync: async (gname: string, specs: Array<{ deviceId: string; protocol: string }>) => {
    H.syncCalls.push({ gname, specs: specs.map((s) => ({ deviceId: s.deviceId, protocol: s.protocol })) });
    return { synced: specs.length, backfilled: 0, confirmed: true };
  },
  sendspinGroupPoll: async () => ({ playing: true, paused: false, positionMs: 1000, durationMs: 2000 }),
  sendspinBridgeStatus: async () => [],
  sendspinBridgeDetach: async () => true,
  sendspinGroupJoin: async () => true,
  sendspinGroupTransport: async () => true,
}));

vi.mock("../../src/services/sendspin/playerCore.js", () => ({
  sendspinGroupName: (gid: string) => `ug:${gid}`,
}));

vi.mock("../../src/services/sendspin/protocolPlayer.js", () => ({
  createSendspinGroupPlayer: (gid: string) => H.sendspinPlayer(gid),
}));

import {
  createGroupProtocolPlayer,
  bridgeJoinMember,
  checkBridgeDegradedOnce,
  degradeBridgeMember,
  isBridgeRouteActive,
  resetBridgeRouteReconcilerForTest,
  setBridgeRoutesForTest,
} from "../../src/services/group/protocolPlayer.js";
import type { BridgeSocketSpec } from "../../src/services/sendspin/bridgeAttach.js";

const ITEM = { songId: "song-1", title: "t", uri: "x" } as any;
const BASE = "http://127.0.0.1:8686";

beforeEach(() => {
  H.prepareCalls.length = 0;
  H.bridgeStopCalls.length = 0;
  H.syncCalls.length = 0;
  H.soloPlay.length = 0;
  H.groups.clear();
  for (const k of Object.keys(H.apStatus)) delete H.apStatus[k];
  for (const k of Object.keys(H.protocolOf)) delete H.protocolOf[k];
  H.apDisabled.clear();
  H.bridgeOwned.clear();
  H.state.bridgeEnabled = true;
  H.state.supervisorRunning = false;
  H.state.bridgeStatus = [];
  H.state.failPrepare.clear();
  H.state.currentItem = null;
  resetBridgeRouteReconcilerForTest();
});

afterEach(() => {
  resetBridgeRouteReconcilerForTest();
});

/** 组:成员固定含一台 sendspin(桥路由只在 spin>0 时建立 —— 桥的 PCM 来自组泵)。 */
function mkGroup(id: string, airplayIds: string[]): void {
  H.groups.set(id, {
    id,
    name: id,
    memberIds: ["sendspin:sp1", ...airplayIds.map((d) => `airplay:${d}`)],
  });
}

describe("prepareBridgeRoute · 逐成员选协议", () => {
  it("① AP1-only 成员 ⇒ raop,且 spec.protocol=raop 透传到组泵", async () => {
    mkGroup("g1", ["ap1"]);
    H.protocolOf.ap1 = "raop";
    await createGroupProtocolPlayer("g1").playMedia(ITEM, BASE);
    expect(H.prepareCalls).toHaveLength(1);
    expect(H.prepareCalls[0]!.protocol).toBe("raop");
    expect(H.syncCalls).toHaveLength(1);
    expect(H.syncCalls[0]!.specs).toEqual([{ deviceId: "ap1", protocol: "raop" }]);
    expect(H.soloPlay).toHaveLength(0); // 桥成功 ⇒ 不 solo cast
  });

  it("② 已配对 AP2 成员 ⇒ ap2-realtime", async () => {
    mkGroup("g2", ["ap2"]);
    H.protocolOf.ap2 = "ap2-realtime";
    await createGroupProtocolPlayer("g2").playMedia(ITEM, BASE);
    expect(H.prepareCalls.map((c) => c.protocol)).toEqual(["ap2-realtime"]);
    expect(H.syncCalls[0]!.specs).toEqual([{ deviceId: "ap2", protocol: "ap2-realtime" }]);
  });

  it("③ 未配对 AP2 成员 ⇒ raop(不误选 AP2)", async () => {
    mkGroup("g3", ["ap2-unpaired"]);
    H.protocolOf["ap2-unpaired"] = "raop";
    await createGroupProtocolPlayer("g3").playMedia(ITEM, BASE);
    expect(H.prepareCalls.map((c) => c.protocol)).toEqual(["raop"]);
  });

  it("④ 混合组:AP1 与 AP2 成员各按自己的协议进桥(协议不是组级)", async () => {
    mkGroup("g4", ["ap1", "ap2"]);
    H.protocolOf.ap1 = "raop";
    H.protocolOf.ap2 = "ap2-realtime";
    await createGroupProtocolPlayer("g4").playMedia(ITEM, BASE);
    const byDevice = Object.fromEntries(H.prepareCalls.map((c) => [c.deviceId, c.protocol]));
    expect(byDevice).toEqual({ ap1: "raop", ap2: "ap2-realtime" });
    const specs = H.syncCalls[0]!.specs;
    expect(specs).toEqual([
      { deviceId: "ap1", protocol: "raop" },
      { deviceId: "ap2", protocol: "ap2-realtime" },
    ]);
    expect(isBridgeRouteActive("g4")).toBe(true);
  });

  it("prepare 失败 ⇒ 该设备进 soloFallback(仍是原语句形态),其它成员协议不受影响", async () => {
    mkGroup("g5", ["ap1", "ap2"]);
    H.protocolOf.ap1 = "raop";
    H.protocolOf.ap2 = "ap2-realtime";
    H.state.failPrepare.add("ap2");
    await createGroupProtocolPlayer("g5").playMedia(ITEM, BASE);
    const byDevice = Object.fromEntries(H.prepareCalls.map((c) => [c.deviceId, c.protocol]));
    expect(byDevice).toEqual({ ap1: "raop", ap2: "ap2-realtime" });
    expect(H.soloPlay.map((s) => s.deviceId)).toEqual(["ap2"]); // 失败者回落 solo cast
  });

  it("播中加入(bridgeJoinMember)同样逐成员选协议", async () => {
    mkGroup("g6", ["ap1"]);
    H.protocolOf.ap1 = "raop";
    await createGroupProtocolPlayer("g6").playMedia(ITEM, BASE);
    H.prepareCalls.length = 0;
    H.protocolOf["ap2b"] = "ap2-realtime";
    H.apStatus["ap2b"] = { available: true, playbackState: "IDLE" };
    const ok = await bridgeJoinMember("g6", "ap2b");
    expect(ok).toBe(true);
    expect(H.prepareCalls).toHaveLength(1);
    expect(H.prepareCalls[0]!.protocol).toBe("ap2-realtime");
  });
});

describe("运行期降级(AP2 链路断)", () => {
  function routeOf(deviceId: string, token: string, protocol: string): BridgeSocketSpec {
    return { deviceId, token, socketPath: `/tmp/b_${deviceId}_${token}.sock`, protocol: protocol as any };
  }

  it("★ degradeBridgeMember:摘桥 + 清 owner=bridge + 本流回落 solo cast", async () => {
    mkGroup("gd", ["ap2"]);
    setBridgeRoutesForTest(new Map([["gd", [routeOf("ap2", "tok-1", "ap2-realtime")]]]));
    H.bridgeOwned.add("ap2");
    H.state.currentItem = { songId: "song-42" };

    const ok = await degradeBridgeMember("ap2", "tok-1", "udp-unreachable");
    expect(ok).toBe(true);
    // owner=bridge 已清(否则设备被桥永久占用:音量失效、native cast 被互斥拒)
    expect(H.bridgeStopCalls.some((c) => c.token === "tok-1" && c.deviceId === "ap2")).toBe(true);
    expect(H.bridgeOwned.has("ap2")).toBe(false);
    // 本流回落 solo cast(不是「静音等下一首」)
    expect(H.soloPlay).toEqual([{ deviceId: "ap2", songId: "song-42", baseUrl: "http://127.0.0.1:8686" }]);
    // 幂等:第二次上报不残留
    expect(await degradeBridgeMember("ap2", "tok-1", "udp-unreachable")).toBe(false);
  });

  it("未知 token(已摘/非桥成员)⇒ false,无任何副作用", async () => {
    mkGroup("gd2", ["ap2"]);
    setBridgeRoutesForTest(new Map([["gd2", [routeOf("ap2", "tok-2", "ap2-realtime")]]]));
    expect(await degradeBridgeMember("ap2", "tok-other", "x")).toBe(false);
    expect(H.bridgeStopCalls).toHaveLength(0);
    expect(H.soloPlay).toHaveLength(0);
  });

  it("队列无当前项 ⇒ 只摘桥(下一首自然走 solo),不抛错", async () => {
    mkGroup("gd3", ["ap2"]);
    setBridgeRoutesForTest(new Map([["gd3", [routeOf("ap2", "tok-3", "ap2-realtime")]]]));
    H.state.currentItem = null;
    expect(await degradeBridgeMember("ap2", "tok-3", "link-loss")).toBe(true);
    expect(H.soloPlay).toHaveLength(0);
    expect(isBridgeRouteActive("gd3")).toBe(false);
  });

  it("★ checkBridgeDegradedOnce:读 bridgeStatus,只降级 degraded=true 的会话", async () => {
    mkGroup("gw", ["ap2", "ap2ok"]);
    setBridgeRoutesForTest(new Map([[
      "gw",
      [routeOf("ap2", "tok-bad", "ap2-realtime"), routeOf("ap2ok", "tok-good", "ap2-realtime")],
    ]]));
    H.state.supervisorRunning = true;
    H.state.currentItem = { songId: "s1" };
    H.state.bridgeStatus = [
      { deviceId: "ap2", token: "tok-bad", degraded: true, linkLoss: "udp-unreachable" },
      { deviceId: "ap2ok", token: "tok-good", degraded: false, linkLoss: null },
    ];
    const n = await checkBridgeDegradedOnce();
    expect(n).toBe(1);
    expect(H.bridgeStopCalls.map((c) => c.token)).toEqual(["tok-bad"]);
    // 健康成员仍在路由里(没被连带摘掉)
    expect(isBridgeRouteActive("gw")).toBe(true);
  });

  it("子进程未运行 / 无路由 ⇒ 零动作(不抛)", async () => {
    H.state.supervisorRunning = false;
    expect(await checkBridgeDegradedOnce()).toBe(0);
    H.state.supervisorRunning = true;
    expect(await checkBridgeDegradedOnce()).toBe(0); // 无路由直接返回
    expect(H.bridgeStopCalls).toHaveLength(0);
  });
});
