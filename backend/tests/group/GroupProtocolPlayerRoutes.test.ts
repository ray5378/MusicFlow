// group/protocolPlayer.ts 定向单测:在线判定 / 桥路由生命周期 / 扇出 / 状态派生 / 对账。
//
// 为什么补这份:该文件是全仓「组播放」的事实源(572 行,基线 67.89% 行 / 44.79% 分支),
// 未覆盖的正是事故高发区:
//   ① 按 kind 的在线判定(拿 sendspin 成员去 DLNA 缓存查 ⇒ 恒判离线,整行被剪掉);
//   ② 桥路由生命周期(播中加入/摘除/子进程重启重建/离线摘除)与 §5.5 owner token;
//   ③ 对账宽限(孤儿句柄连摘两轮才动手,摘早了会打断正在重锚的桥);
//   ④ pollState 在「leader=桥占用 airplay」时必须从共享组泵派生(否则恒报 STOPPED
//      → tracker 判曲目结束 → 每 ~5s 无限重启,2026-10-26 A/B 实测)。
// 全部依赖 mock:桥 prepare/stop、sendspin 组泵、设备状态都不碰真实网络与子进程。
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const h = vi.hoisted(() => {
  const calls: Record<string, string[]> = {};
  const rec = (id: string, s: string): void => { (calls[id] ??= []).push(s); };

  const devices: Record<string, { available: boolean; alias?: string; name?: string }> = {};
  const apStatus: Record<string, any> = {};
  const apDisabled = new Set<string>();
  const bridgeOwned = new Set<string>();
  const devStatus: Record<string, any> = {};

  const groups = new Map<string, { id: string; name: string; memberIds: string[] }>();
  const gm = {
    get: (id: string) => groups.get(id),
    list: () => Array.from(groups.values()),
    getVolume: () => 20,
    setVolume: (_id: string, v: number) => { gmVolumeWrite.push([_id, v]); return v; },
    resolveMemberStates: () => [],
    groupsOfDevice: () => [],
  };
  const gmVolumeWrite: Array<[string, number]> = [];

  const prepareCalls: any[] = [];
  const prepareFail = new Set<string>();
  const bridgeStopCalls: Array<{ token: string; deviceId?: string }> = [];
  const syncCalls: Array<{ gname: string; devices: string[] }> = [];
  const detachCalls: Array<[string, string]> = [];
  const spinPlayCalls: any[] = [];
  const state = {
    bridgeEnabled: true,
    syncConfirmed: true,
    syncThrows: false,
    spinPlayFail: false,
    supervisorRunning: false,
    bridgeStatus: [] as Array<{ group: string; deviceId: string }>,
    airStatus: [] as Array<{ deviceId: string; token: string }>,
    groupPoll: { playing: true, paused: false, positionMs: 33_500, durationMs: 120_000 },
    front: null as any,
  };

  function protoPlayer(kind: "dlna" | "airplay", id: string) {
    const pid = `${kind}:${id}`;
    return {
      playerId: pid,
      async playMedia() { rec(id, "play"); return { mediaUri: `${kind}-${id}` }; },
      async stop() { rec(id, "stop"); },
      async pause() { rec(id, "pause"); },
      async resume() { rec(id, "resume"); },
      async seek(s: number) { rec(id, `seek:${s}`); },
      async setVolume(v: number) { rec(id, `vol:${v}`); },
      async pollState() {
        rec(id, "poll");
        return {
          playerId: pid,
          playbackState: "PLAYING",
          position: kind === "dlna" ? 11 : 12,
          duration: 100,
          mediaUri: `${kind}-${id}`,
          updatedAt: kind === "dlna" ? 1000 : 2000,
        };
      },
    };
  }

  function spinPlayer(gid: string) {
    const key = `spin:${gid}`;
    return {
      playerId: key,
      async playMedia(item: any, baseUrl: string, startMs: number, extra?: any) {
        spinPlayCalls.push({ gid, songId: item.songId, baseUrl, startMs, extra });
        if (state.spinPlayFail) throw new Error("spin cast 失败");
        return { mediaUri: `spin-${gid}` };
      },
      async stop() { rec(key, "stop"); },
      async pause() { rec(key, "pause"); },
      async resume() { rec(key, "resume"); },
      async seek(s: number) { rec(key, `seek:${s}`); },
      async setVolume(v: number) { rec(key, `vol:${v}`); },
      async pollState() {
        rec(key, "poll");
        return { playerId: key, playbackState: "PLAYING", position: 33, duration: 120, mediaUri: "spin-uri", updatedAt: 3000 };
      },
    };
  }

  return {
    calls, rec, devices, apStatus, apDisabled, bridgeOwned, devStatus,
    groups, gm, gmVolumeWrite,
    prepareCalls, prepareFail, bridgeStopCalls, syncCalls, detachCalls, spinPlayCalls,
    state, protoPlayer, spinPlayer,
  };
});

vi.mock("../../src/services/group/index.js", async (importOriginal) => {
  // 部分 mock:只替 getGroupManager,splitMemberId 走真实实现(命名空间语义随源码演进)。
  const actual = await importOriginal<any>();
  return { getGroupManager: () => h.gm, splitMemberId: actual.splitMemberId };
});

vi.mock("../../src/services/dlna/control.js", () => ({
  createDlnaProtocolPlayer: (id: string) => h.protoPlayer("dlna", id),
  getDevice: (id: string) => (h.devices[id] ? { id } : undefined),
  isDeviceAvailable: (id: string) => !!h.devices[id]?.available,
  getDeviceStatus: async (id: string) =>
    h.devStatus[id] ?? { state: "STOPPED", position: 0, duration: 0, volume: 0 },
}));

vi.mock("../../src/services/airplay/protocolPlayer.js", () => ({
  createAirPlayProtocolPlayer: (id: string) => h.protoPlayer("airplay", id),
}));

vi.mock("../../src/services/airplay/control.js", () => ({
  getAirPlayStatus: (id: string) =>
    h.apStatus[id] ?? {
      available: false, name: id, playbackState: "IDLE", position: 0, duration: 0, volume: 0, muted: false,
    },
  isAirPlayDeviceDisabled: (id: string) => h.apDisabled.has(id),
  isAirplayBridgeEnabled: () => h.state.bridgeEnabled,
  isBridgeOwned: (id: string) => h.bridgeOwned.has(id),
  // Phase 6b:桥协议逐成员选。本文件默认全部按 AP1(raop)走 —— 与改动前逐字节同行为;
  // AP2 分流矩阵在 tests/group/groupAp2Route.test.ts 覆盖。
  selectAirPlayBridgeProtocol: () => "raop" as const,
  bridgePrepareDevice: async (deviceId: string, token: string, protocol: string, groupId?: string) => {
    h.prepareCalls.push({ deviceId, token, protocol, groupId });
    if (h.prepareFail.has(deviceId)) throw new Error("prepare failed");
    return { listening: true, socketPath: `/tmp/b_${deviceId}_${token}.sock` };
  },
  bridgeStopDevice: async (token: string, deviceId?: string) => {
    h.bridgeStopCalls.push({ token, deviceId });
  },
}));

vi.mock("../../src/services/airplay/bridgeChannel.js", () => ({
  bridgeSocketPath: (deviceId: string, token: string) => `/tmp/b_${deviceId}_${token}.sock`,
}));

vi.mock("../../src/services/sendspin/index.js", () => ({
  getSendspinFront: () => h.state.front,
  sendspinGroupBridgeSync: async (gname: string, specs: Array<{ deviceId: string }>) => {
    h.syncCalls.push({ gname, devices: specs.map((s) => s.deviceId) });
    if (h.state.syncThrows) throw new Error("sync boom");
    return { synced: specs.length, backfilled: 0, confirmed: h.state.syncConfirmed };
  },
  sendspinGroupPoll: async () => {
    if (h.state.spinPlayFail) throw new Error("poll boom");
    return h.state.groupPoll;
  },
  sendspinBridgeStatus: async () => h.state.bridgeStatus,
  sendspinBridgeDetach: async (group: string, deviceId: string) => {
    h.detachCalls.push([group, deviceId]);
    return true;
  },
  sendspinGroupJoin: async () => true,
  sendspinGroupTransport: async () => true,
}));

vi.mock("../../src/services/sendspin/playerCore.js", () => ({
  sendspinGroupName: (gid: string) => `ug:${gid}`,
}));

vi.mock("../../src/services/sendspin/protocolPlayer.js", () => ({
  createSendspinGroupPlayer: (gid: string) => h.spinPlayer(gid),
}));

vi.mock("../../src/services/airplay/supervisor.js", () => ({
  airplaySupervisor: {
    isRunning: () => h.state.supervisorRunning,
    rpc: async (method: string) => (method === "bridgeStatus" ? h.state.airStatus : null),
  },
}));

import {
  bridgeJoinMember,
  bridgeLeaveMember,
  createGroupProtocolPlayer,
  getGroupLeader,
  getGroupLeaderDeviceId,
  getGroupStatus,
  getOnlineAirplayIds,
  getOnlineMemberIds,
  getOnlineSendspinIds,
  hasOnlineMember,
  isBridgeRouteActive,
  notifyAirplayDeviceOffline,
  rebuildBridgeRoutes,
  reconcileBridgeRoutesOnce,
  resetBridgeRouteReconcilerForTest,
  setBridgeRoutesForTest,
  splitGroupMembers,
  startBridgeRouteReconciler,
  stopBridgeRouteReconciler,
} from "../../src/services/group/protocolPlayer.js";

function makeItem(songId = "s1"): any {
  return { songId, title: "t", mime: "audio/mpeg", duration: 100 };
}

function setGroup(memberIds: string[], id = "g1"): void {
  h.groups.set(id, { id, name: "组", memberIds });
}

function apOn(id: string, over: Record<string, unknown> = {}): void {
  h.apStatus[id] = {
    available: true, name: id, playbackState: "PLAYING", position: 5, duration: 100, volume: 50, muted: false, ...over,
  };
}

beforeEach(() => {
  for (const k of Object.keys(h.calls)) delete h.calls[k];
  for (const k of Object.keys(h.devices)) delete h.devices[k];
  for (const k of Object.keys(h.apStatus)) delete h.apStatus[k];
  for (const k of Object.keys(h.devStatus)) delete h.devStatus[k];
  h.apDisabled.clear();
  h.bridgeOwned.clear();
  h.groups.clear();
  h.gmVolumeWrite.length = 0;
  h.prepareCalls.length = 0;
  h.prepareFail.clear();
  h.bridgeStopCalls.length = 0;
  h.syncCalls.length = 0;
  h.detachCalls.length = 0;
  h.spinPlayCalls.length = 0;
  h.state.bridgeEnabled = true;
  h.state.syncConfirmed = true;
  h.state.syncThrows = false;
  h.state.spinPlayFail = false;
  h.state.supervisorRunning = false;
  h.state.bridgeStatus = [];
  h.state.airStatus = [];
  h.state.groupPoll = { playing: true, paused: false, positionMs: 33_500, durationMs: 120_000 };
  h.state.front = null;
  resetBridgeRouteReconcilerForTest();
  vi.clearAllMocks();
});

afterEach(() => {
  resetBridgeRouteReconcilerForTest();
  vi.useRealTimers();
});

// ---------------------------------------------------------------------------
describe("成员分桶与在线判定(按 kind 分派,不许拿单一缓存查全部)", () => {
  it("splitGroupMembers:未知组 → 三个空桶", () => {
    expect(splitGroupMembers("nope")).toEqual({ dlna: [], airplay: [], spin: [] });
  });

  it("splitGroupMembers:按 kind 分桶,并跳过不可解析成员(group:/local: 不能入组)", () => {
    setGroup(["d1", "airplay:a1", "sendspin:sp1", "group:x", "local:me"]);
    expect(splitGroupMembers("g1")).toEqual({ dlna: ["d1"], airplay: ["a1"], spin: ["sp1"] });
  });

  it("getOnlineSendspinIds:组内无 sendspin 成员 → 空(不做无谓判定)", () => {
    setGroup(["d1"]);
    expect(getOnlineSendspinIds("g1")).toEqual([]);
  });

  it("getOnlineSendspinIds:sendspin front 未启动 → 空(服务没跑就是没在线)", () => {
    setGroup(["sendspin:sp1"]);
    h.state.front = null;
    expect(getOnlineSendspinIds("g1")).toEqual([]);
  });

  it("getOnlineSendspinIds:只保留 ready !== false 的 client(缺 ready 视为在线)", () => {
    setGroup(["sendspin:sp1", "sendspin:sp2", "sendspin:sp3"]);
    h.state.front = {
      clients: new Map<string, any>([
        ["sp1", { ready: true }],
        ["sp2", { ready: false }],
        ["sp3", {}],
      ]),
      groups: new Map(),
    };
    expect(getOnlineSendspinIds("g1")).toEqual(["sp1", "sp3"]);
  });

  it("getOnlineAirplayIds:已禁用或不可达的 airplay 成员被过滤", () => {
    setGroup(["airplay:a1", "airplay:a2", "airplay:a3"]);
    apOn("a1");
    apOn("a2", { available: false });
    apOn("a3");
    h.apDisabled.add("a3");
    expect(getOnlineAirplayIds("g1")).toEqual(["a1"]);
  });

  it("getOnlineMemberIds / getGroupLeaderDeviceId:只看 DLNA 成员且按成员顺序", () => {
    setGroup(["d2", "d1", "airplay:a1", "sendspin:sp1"]);
    h.devices.d2 = { available: true };
    h.devices.d1 = { available: true };
    expect(getOnlineMemberIds("g1")).toEqual(["d2", "d1"]);
    expect(getGroupLeaderDeviceId("g1")).toBe("d2");
    // 未知组
    expect(getOnlineMemberIds("nope")).toEqual([]);
    expect(getGroupLeaderDeviceId("nope")).toBeUndefined();
  });

  it("getGroupLeader:固定顺序首个在线成员,能跨 kind;未知组/全离线 → undefined", () => {
    expect(getGroupLeader("nope")).toBeUndefined();
    setGroup(["sendspin:sp1", "airplay:a1", "d1"]);
    h.devices.d1 = { available: true };
    apOn("a1");
    h.state.front = { clients: new Map([["sp1", { ready: true }]]), groups: new Map() };
    expect(getGroupLeader("g1")).toEqual({ kind: "sendspin", id: "sp1" });

    // sendspin 离线 → leader 递补到 airplay
    h.state.front.clients.get("sp1").ready = false;
    expect(getGroupLeader("g1")).toEqual({ kind: "airplay", id: "a1" });

    // airplay 离线 → 递补到 dlna
    h.apStatus.a1.available = false;
    expect(getGroupLeader("g1")).toEqual({ kind: "dlna", id: "d1" });

    // 全离线 → undefined(调用方据此报 BUFFERING 而不是 IDLE)
    h.devices.d1.available = false;
    expect(getGroupLeader("g1")).toBeUndefined();
  });

  it("hasOnlineMember:任一 kind 在线即为 true,全离线才 false", () => {
    setGroup(["d1", "airplay:a1", "sendspin:sp1"]);
    expect(hasOnlineMember("g1")).toBe(false);
    h.devices.d1 = { available: true };
    expect(hasOnlineMember("g1")).toBe(true);
    h.devices.d1.available = false;
    apOn("a1");
    expect(hasOnlineMember("g1")).toBe(true);
    delete h.apStatus.a1;
    h.state.front = { clients: new Map([["sp1", { ready: true }]]), groups: new Map() };
    expect(hasOnlineMember("g1")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
describe("桥路由生命周期(§5.1 路由快照 / §5.2 流内成员变化 / §5.5 owner token)", () => {
  const route = (deviceId: string, token = "tk0") => ({ deviceId, socketPath: `/tmp/b_${deviceId}_${token}.sock`, token, protocol: "raop" as const });

  it("isBridgeRouteActive:无登记 false;登记后 true;复位后 false", () => {
    expect(isBridgeRouteActive("g1")).toBe(false);
    setBridgeRoutesForTest(new Map([["g1", [route("ap1")]]]));
    expect(isBridgeRouteActive("g1")).toBe(true);
    expect(isBridgeRouteActive("g2")).toBe(false);
    resetBridgeRouteReconcilerForTest();
    expect(isBridgeRouteActive("g1")).toBe(false);
  });

  it("bridgeJoinMember:该组无桥路由 → false(调用方回落 legacy join)", async () => {
    await expect(bridgeJoinMember("g1", "ap1")).resolves.toBe(false);
    expect(h.prepareCalls).toHaveLength(0);
  });

  it("bridgeJoinMember:桥总开关关闭 → false(纯 sendspin 组逐字节同旧行为)", async () => {
    setBridgeRoutesForTest(new Map([["g1", [route("ap1")]]]));
    h.state.bridgeEnabled = false;
    await expect(bridgeJoinMember("g1", "ap2")).resolves.toBe(false);
    expect(h.prepareCalls).toHaveLength(0);
  });

  it("bridgeJoinMember:设备已在路由内 → 幂等 true,不重复 prepare", async () => {
    setBridgeRoutesForTest(new Map([["g1", [route("ap1")]]]));
    await expect(bridgeJoinMember("g1", "ap1")).resolves.toBe(true);
    expect(h.prepareCalls).toHaveLength(0);
    expect(h.syncCalls).toHaveLength(0);
  });

  it("bridgeJoinMember:新设备 → bridgePrepare(带 groupId) + 推路由 + 泵侧 sync", async () => {
    setBridgeRoutesForTest(new Map([["g1", [route("ap1", "tkA")]]]));
    await expect(bridgeJoinMember("g1", "ap2")).resolves.toBe(true);
    expect(h.prepareCalls).toHaveLength(1);
    expect(h.prepareCalls[0]).toMatchObject({ deviceId: "ap2", protocol: "raop", groupId: "g1" });
    expect(h.prepareCalls[0].token).toMatch(/^[0-9a-f]{24}$/); // 12B hex owner token
    expect(h.syncCalls.at(-1)).toEqual({ gname: "ug:g1", devices: ["ap1", "ap2"] });
    expect(isBridgeRouteActive("g1")).toBe(true);
  });

  it("bridgeJoinMember:prepare 失败 → 抛错(调用方按 MAJ-07 降级 solo cast)", async () => {
    setBridgeRoutesForTest(new Map([["g1", [route("ap1", "tkA")]]]));
    h.prepareFail.add("ap2");
    await expect(bridgeJoinMember("g1", "ap2")).rejects.toThrow("prepare failed");
  });

  it("bridgeLeaveMember:无路由 / 设备不在路由内 → false(幂等)", async () => {
    await expect(bridgeLeaveMember("g1", "ap1")).resolves.toBe(false);
    setBridgeRoutesForTest(new Map([["g1", [route("ap1")]]]));
    await expect(bridgeLeaveMember("g1", "apX")).resolves.toBe(false);
    expect(h.bridgeStopCalls).toHaveLength(0);
  });

  it("bridgeLeaveMember:泵侧确认摘句柄后才 bridgeStop(设备回到可 cast 状态)", async () => {
    setBridgeRoutesForTest(new Map([["g1", [route("ap1", "tkA"), route("ap2", "tkB")]]]));
    h.state.syncConfirmed = true;
    await expect(bridgeLeaveMember("g1", "ap1")).resolves.toBe(true);
    expect(h.syncCalls.at(-1)).toEqual({ gname: "ug:g1", devices: ["ap2"] });
    expect(h.bridgeStopCalls).toEqual([{ token: "tkA", deviceId: "ap1" }]);
  });

  it("bridgeLeaveMember:泵侧未确认(confirmed=false)→ 推迟 bridgeStop 交对账兜底", async () => {
    setBridgeRoutesForTest(new Map([["g1", [route("ap1", "tkA")]]]));
    h.state.syncConfirmed = false;
    await expect(bridgeLeaveMember("g1", "ap1")).resolves.toBe(true);
    expect(h.bridgeStopCalls).toHaveLength(0); // 不 unlink 活路径 ⇒ 不产生单侧孤儿
  });

  it("bridgeLeaveMember:sync 抛错同样推迟(吞错但不摘会话)", async () => {
    setBridgeRoutesForTest(new Map([["g1", [route("ap1", "tkA")]]]));
    h.state.syncThrows = true;
    await expect(bridgeLeaveMember("g1", "ap1")).resolves.toBe(true);
    expect(h.bridgeStopCalls).toHaveLength(0);
  });

  it("rebuildBridgeRoutes:原 token 重发 prepare;onlyGroupId 只重建该组;失败不计入", async () => {
    setBridgeRoutesForTest(new Map([
      ["g1", [route("ap1", "tkA"), route("ap2", "tkB")]],
      ["g2", [route("ap3", "tkC")]],
    ]));
    await expect(rebuildBridgeRoutes()).resolves.toBe(3);
    expect(h.prepareCalls.map((c) => c.deviceId)).toEqual(["ap1", "ap2", "ap3"]);
    expect(h.prepareCalls[0]).toMatchObject({ token: "tkA", protocol: "raop", groupId: "g1" });

    h.prepareCalls.length = 0;
    h.prepareFail.add("ap2");
    await expect(rebuildBridgeRoutes("g1")).resolves.toBe(1);
    expect(h.prepareCalls.map((c) => c.deviceId)).toEqual(["ap1", "ap2"]);
  });

  it("notifyAirplayDeviceOffline:命中组的设备被摘除并计数,未命中不动作", async () => {
    setBridgeRoutesForTest(new Map([
      ["g1", [route("ap1", "tkA"), route("ap2", "tkB")]],
      ["g2", [route("ap3", "tkC")]],
    ]));
    await expect(notifyAirplayDeviceOffline("ap9")).resolves.toBe(0);
    await expect(notifyAirplayDeviceOffline("ap1")).resolves.toBe(1);
    expect(h.bridgeStopCalls).toEqual([{ token: "tkA", deviceId: "ap1" }]);
  });
});

// ---------------------------------------------------------------------------
describe("桥路由对账(60s 周期,宽限两轮)", () => {
  it("start/stop 幂等:重复 start 只挂一个定时器", () => {
    startBridgeRouteReconciler(1000);
    startBridgeRouteReconciler(1000);
    stopBridgeRouteReconciler();
    stopBridgeRouteReconciler(); // 再停不抛
  });

  it("孤儿句柄:首轮只登记,过宽限后才摘除(避免打断正在重锚的桥)", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    setBridgeRoutesForTest(new Map());
    h.state.bridgeStatus = [{ group: "ug:g1", deviceId: "ap9" }];

    await reconcileBridgeRoutesOnce();
    expect(h.detachCalls).toEqual([]); // 首见只登记

    vi.setSystemTime(new Date("2026-01-01T00:00:30Z")); // 未过宽限
    await reconcileBridgeRoutesOnce();
    expect(h.detachCalls).toEqual([]);

    vi.setSystemTime(new Date("2026-01-01T00:01:30Z")); // 过宽限
    await reconcileBridgeRoutesOnce();
    expect(h.detachCalls).toEqual([["ug:g1", "ap9"]]);
  });

  it("登记内设备不摘;supervisor 未运行则跳过 airplay 侧", async () => {
    setBridgeRoutesForTest(new Map([["g1", [{ deviceId: "ap1", socketPath: "/tmp/b", token: "tkA", protocol: "raop" }]]]));
    h.state.bridgeStatus = [{ group: "ug:g1", deviceId: "ap1" }];
    h.state.airStatus = [{ deviceId: "ap1", token: "tkA" }];
    h.state.supervisorRunning = false;
    await reconcileBridgeRoutesOnce();
    await reconcileBridgeRoutesOnce();
    expect(h.detachCalls).toEqual([]);
    expect(h.bridgeStopCalls).toEqual([]);
  });

  it("airplay 侧孤儿会话(同设备换 token):过宽限后 bridgeStop 摘除", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    setBridgeRoutesForTest(new Map([["g1", [{ deviceId: "ap1", socketPath: "/tmp/b", token: "tkNew", protocol: "raop" }]]]));
    h.state.supervisorRunning = true;
    h.state.airStatus = [{ deviceId: "ap1", token: "tkOld" }];
    h.state.bridgeStatus = [];

    await reconcileBridgeRoutesOnce();
    vi.setSystemTime(new Date("2026-01-01T00:01:30Z"));
    await reconcileBridgeRoutesOnce();
    expect(h.bridgeStopCalls).toEqual([{ token: "tkOld", deviceId: "ap1" }]);
  });
});

// ---------------------------------------------------------------------------
describe("playMedia 扇出与桥接降级", () => {
  it("无在线成员 → 抛错(路由层据此回 409,不产生空 cast)", async () => {
    setGroup(["d1", "airplay:a1"]);
    const p = createGroupProtocolPlayer("g1");
    await expect(p.playMedia(makeItem(), "http://base")).rejects.toThrow("无在线成员");
  });

  it("sendspin + airplay 混编且桥可用:桥规格透传给组泵,airplay 不 solo cast", async () => {
    setGroup(["sendspin:sp1", "airplay:a1"]);
    h.state.front = { clients: new Map([["sp1", { ready: true }]]), groups: new Map() };
    apOn("a1");
    const p = createGroupProtocolPlayer("g1");
    const r = await p.playMedia(makeItem(), "http://base");

    expect(h.prepareCalls).toHaveLength(1);
    expect(h.prepareCalls[0]).toMatchObject({ deviceId: "a1", groupId: "g1" });
    expect(h.spinPlayCalls).toHaveLength(1);
    expect(h.spinPlayCalls[0].extra.sockets.map((s: any) => s.deviceId)).toEqual(["a1"]);
    expect(h.calls.a1 ?? []).toEqual([]); // 桥成员不 solo cast
    expect(r.mediaUri).toBe("spin-g1"); // mediaUri 取首个成功
  });

  it("单设备 prepare 失败 → 该设备回落 solo cast,其余走桥(绝不出现「在组里但无声」)", async () => {
    setGroup(["sendspin:sp1", "airplay:a1", "airplay:a2"]);
    h.state.front = { clients: new Map([["sp1", { ready: true }]]), groups: new Map() };
    apOn("a1");
    apOn("a2");
    h.prepareFail.add("a1");
    const p = createGroupProtocolPlayer("g1");
    await p.playMedia(makeItem(), "http://base");

    expect(h.calls.a1).toContain("play"); // 回落 solo
    expect(h.calls.a2 ?? []).toEqual([]); // 走桥
    expect(h.spinPlayCalls[0].extra.sockets.map((s: any) => s.deviceId)).toEqual(["a2"]);
  });

  it("全部成员 cast 失败 → 抛错(不返回伪成功)", async () => {
    setGroup(["sendspin:sp1"]);
    h.state.front = { clients: new Map([["sp1", { ready: true }]]), groups: new Map() };
    h.state.spinPlayFail = true;
    const p = createGroupProtocolPlayer("g1");
    await expect(p.playMedia(makeItem(), "http://base")).rejects.toThrow("全部成员 cast 失败");
  });

  it("桥总开关关闭:airplay 逐成员 solo cast(与旧行为一致)", async () => {
    setGroup(["sendspin:sp1", "airplay:a1"]);
    h.state.front = { clients: new Map([["sp1", { ready: true }]]), groups: new Map() };
    apOn("a1");
    h.state.bridgeEnabled = false;
    const p = createGroupProtocolPlayer("g1");
    await p.playMedia(makeItem(), "http://base");
    expect(h.prepareCalls).toHaveLength(0);
    expect(h.calls.a1).toContain("play");
  });

  it("B 方案暖复用:上一条路由与在线成员同集合同协议 ⇒ 不拆会话、沿用 token(子进程据此暖复用)", async () => {
    setGroup(["sendspin:sp1", "airplay:a1"]);
    h.state.front = { clients: new Map([["sp1", { ready: true }]]), groups: new Map() };
    apOn("a1");
    setBridgeRoutesForTest(new Map([["g1", [{ deviceId: "a1", socketPath: "/tmp/b_a1_old.sock", token: "oldtok", protocol: "raop" }]]]));
    h.prepareCalls.length = 0;
    h.bridgeStopCalls.length = 0;
    const p = createGroupProtocolPlayer("g1");
    await p.playMedia(makeItem(), "http://base");

    expect(h.bridgeStopCalls).toHaveLength(0); // 不拆会话 = RAOP 握手/设备缓冲零重来
    expect(h.prepareCalls).toHaveLength(1); // 仍 prepare(子进程做健康判定与暖复用)
    expect(h.prepareCalls[0]!.token).toBe("oldtok"); // 沿用旧 token
    expect(h.spinPlayCalls[0]!.extra.sockets[0]!.token).toBe("oldtok");
  });

  it("B 方案冷启:成员变化(新增 a2)⇒ 拆旧建新,token 全新", async () => {
    setGroup(["sendspin:sp1", "airplay:a1", "airplay:a2"]);
    h.state.front = { clients: new Map([["sp1", { ready: true }]]), groups: new Map() };
    apOn("a1");
    apOn("a2");
    setBridgeRoutesForTest(new Map([["g1", [{ deviceId: "a1", socketPath: "/tmp/x", token: "oldtok", protocol: "raop" }]]]));
    h.prepareCalls.length = 0;
    h.bridgeStopCalls.length = 0;
    const p = createGroupProtocolPlayer("g1");
    await p.playMedia(makeItem(), "http://base");

    expect(h.bridgeStopCalls.map((c: any) => c.token)).toEqual(["oldtok"]); // 旧路由拆除
    expect(h.prepareCalls.map((c: any) => c.token)).not.toContain("oldtok");
  });
});

describe("传输类扇出(桥占用成员跳过,setVolume 例外)", () => {
  it("stop:扇出在线成员 + 组停 + 拆桥路由(bridgeStop 逐 device)", async () => {
    setGroup(["d1", "sendspin:sp1"]);
    h.devices.d1 = { available: true };
    h.state.front = { clients: new Map([["sp1", { ready: true }]]), groups: new Map() };
    setBridgeRoutesForTest(new Map([["g1", [{ deviceId: "a1", socketPath: "/tmp/b", token: "tkA", protocol: "raop" }]]]));

    const p = createGroupProtocolPlayer("g1");
    await p.stop();
    expect(h.calls.d1).toEqual(["stop"]);
    expect(h.calls["spin:g1"]).toEqual(["stop"]);
    expect(h.bridgeStopCalls).toEqual([{ token: "tkA", deviceId: "a1" }]);
    expect(isBridgeRouteActive("g1")).toBe(false);
  });

  it("pause/resume/seek 同时扇出 DLNA 与 sendspin 组单发", async () => {
    setGroup(["d1", "sendspin:sp1"]);
    h.devices.d1 = { available: true };
    h.state.front = { clients: new Map([["sp1", { ready: true }]]), groups: new Map() };
    const p = createGroupProtocolPlayer("g1");
    await p.pause();
    await p.resume();
    await p.seek(42.5);
    expect(h.calls.d1).toEqual(["pause", "resume", "seek:42.5"]);
    expect(h.calls["spin:g1"]).toEqual(["pause", "resume", "seek:42.5"]);
  });

  it("桥占用成员:传输类 op 跳过(与桥会话互踩),但 setVolume 仍要扇出(HiVi 音量死案例)", async () => {
    setGroup(["airplay:a1", "airplay:a2"]);
    apOn("a1");
    apOn("a2");
    h.bridgeOwned.add("a1");
    const p = createGroupProtocolPlayer("g1");

    await p.stop();
    expect(h.calls.a1 ?? []).toEqual([]); // 传输由组泵承担
    expect(h.calls.a2).toEqual(["stop"]);

    await p.setVolume(30);
    expect(h.gmVolumeWrite).toEqual([["g1", 30]]); // 先落库(空组也持久)
    expect(h.calls.a1).toEqual(["vol:30"]); // 音量例外:桥占用也扇出
    expect(h.calls.a2).toEqual(["stop", "vol:30"]);
  });

  it("组音量扇出:组内无 sendspin 成员时不触碰组泵", async () => {
    setGroup(["d1"]);
    h.devices.d1 = { available: true };
    const p = createGroupProtocolPlayer("g1");
    await p.setVolume(44);
    expect(h.calls["spin:g1"] ?? []).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
describe("状态派生(pollState / getGroupStatus)", () => {
  it("pollState:无在线 leader → BUFFERING(报 IDLE 会被 tracker 当成曲目结束)", async () => {
    setGroup(["d1"]);
    const p = createGroupProtocolPlayer("g1");
    const s = await p.pollState();
    expect(s).toMatchObject({ playerId: "group:g1", playbackState: "BUFFERING", position: 0, duration: 0 });
  });

  it("pollState:sendspin leader → 从共享组泵派生(playerId 换成 group:)", async () => {
    setGroup(["sendspin:sp1"]);
    h.state.front = { clients: new Map([["sp1", { ready: true }]]), groups: new Map() };
    const s = await createGroupProtocolPlayer("g1").pollState();
    expect(s.playerId).toBe("group:g1");
    expect(s.position).toBe(33);
    expect(s.mediaUri).toBe("spin-uri");
  });

  it("pollState:airplay leader 被桥占用且组内有 sendspin → 必须从组泵派生(否则恒 STOPPED)", async () => {
    setGroup(["airplay:a1", "sendspin:sp1"]);
    apOn("a1");
    h.bridgeOwned.add("a1");
    h.state.front = { clients: new Map([["sp1", { ready: true }]]), groups: new Map() };
    const s = await createGroupProtocolPlayer("g1").pollState();
    expect(s.playerId).toBe("group:g1");
    expect(s.position).toBe(33); // 组泵口径,不是 airplay 会话(桥下恒空)
  });

  it("pollState:airplay leader 独立 solo cast → 从设备会话派生", async () => {
    setGroup(["airplay:a1"]);
    apOn("a1");
    const s = await createGroupProtocolPlayer("g1").pollState();
    expect(s.playerId).toBe("group:g1");
    expect(s.position).toBe(12);
    expect(s.mediaUri).toBe("airplay-a1");
  });

  it("pollState:dlna leader → 从设备状态派生", async () => {
    setGroup(["d1"]);
    h.devices.d1 = { available: true };
    const s = await createGroupProtocolPlayer("g1").pollState();
    expect(s.position).toBe(11);
    expect(s.mediaUri).toBe("dlna-d1");
  });

  it("getGroupStatus:无在线成员 → STOPPED + 持久组音量(空组也回显上次音量)", async () => {
    setGroup(["d1"]);
    const st = await getGroupStatus("g1");
    expect(st).toMatchObject({ state: "STOPPED", position: 0, duration: 0, volume: 20, muted: false });
  });

  it("getGroupStatus:sendspin leader → 组泵时间线 + 实时组音量/静音", async () => {
    setGroup(["sendspin:sp1"]);
    h.state.front = {
      clients: new Map([["sp1", { ready: true }]]),
      groups: new Map([["ug:g1", { volume: 42, muted: true, current: { title: "x" } }]]),
    };
    h.state.groupPoll = { playing: true, paused: false, positionMs: 33_500, durationMs: 120_000 };
    let st = await getGroupStatus("g1");
    expect(st).toMatchObject({ state: "PLAYING", position: 33, duration: 120, volume: 42, muted: true });
    expect(st.media).toEqual({ title: "x" });

    h.state.groupPoll = { playing: false, paused: true, positionMs: 1000, durationMs: 120_000 };
    st = await getGroupStatus("g1");
    expect(st.state).toBe("PAUSED");

    h.state.groupPoll = { playing: false, paused: false, positionMs: 0, durationMs: 0 };
    st = await getGroupStatus("g1");
    expect(st.state).toBe("STOPPED");
  });

  it("getGroupStatus:【v4.8.1】可听前 buffering → BUFFERING(sendspin leader)", async () => {
    setGroup(["sendspin:sp1"]);
    h.state.front = { clients: new Map([["sp1", { ready: true }]]), groups: new Map([["ug:g1", {}]]) };
    h.state.groupPoll = { playing: true, paused: false, positionMs: 0, durationMs: 120_000, buffering: true };
    expect((await getGroupStatus("g1")).state).toBe("BUFFERING");
  });

  it("getGroupStatus:【v4.8.1】桥占用 airplay leader + buffering → BUFFERING;缺省退化 PLAYING", async () => {
    setGroup(["airplay:a1", "sendspin:sp1"]);
    apOn("a1");
    h.bridgeOwned.add("a1");
    h.state.front = { clients: new Map([["sp1", { ready: true }]]), groups: new Map([["ug:g1", {}]]) };
    h.state.groupPoll = { playing: true, paused: false, positionMs: 0, durationMs: 120_000, buffering: true };
    expect((await getGroupStatus("g1")).state).toBe("BUFFERING");
    h.state.groupPoll = { playing: true, paused: false, positionMs: 1_000, durationMs: 120_000 };
    expect((await getGroupStatus("g1")).state).toBe("PLAYING");
  });

  it("getGroupStatus:桥占用 airplay leader → 从组泵派生(否则 status 全程 STOPPED)", async () => {
    setGroup(["airplay:a1", "sendspin:sp1"]);
    apOn("a1");
    h.bridgeOwned.add("a1");
    h.state.front = { clients: new Map([["sp1", { ready: true }]]), groups: new Map() };
    const st = await getGroupStatus("g1");
    expect(st.state).toBe("PLAYING");
    expect(st.position).toBe(33);
    expect(st.volume).toBe(20); // 持久音量(泵侧实时未就绪)
  });

  it("getGroupStatus:airplay solo leader → 会话态映射 PLAYING/PAUSED/STOPPED 与静音回显", async () => {
    setGroup(["airplay:a1"]);
    apOn("a1", { muted: true });
    let st = await getGroupStatus("g1");
    expect(st).toMatchObject({ state: "PLAYING", position: 5, duration: 100, muted: true, volume: 20 });

    apOn("a1", { playbackState: "PAUSED", position: 7 });
    st = await getGroupStatus("g1");
    expect(st.state).toBe("PAUSED");
    expect(st.position).toBe(7);

    apOn("a1", { playbackState: "IDLE", position: 0, duration: 0 });
    st = await getGroupStatus("g1");
    expect(st.state).toBe("STOPPED");
  });

  it("getGroupStatus:dlna leader → 设备状态 + 组音量以持久值为准(设备音量是单机标度)", async () => {
    setGroup(["d1"]);
    h.devices.d1 = { available: true };
    h.devStatus.d1 = { state: "PLAYING", position: 61, duration: 200, volume: 88, muted: false };
    const st = await getGroupStatus("g1");
    expect(st).toMatchObject({ state: "PLAYING", position: 61, duration: 200, volume: 20 });
  });
});
