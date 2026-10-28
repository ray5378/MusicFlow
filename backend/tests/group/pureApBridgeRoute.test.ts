// v4.9.3 方向 A 定向单测:纯 AirPlay 组强制走 Sendspin 桥。
// 覆盖:
//   ① spin=0 且 ap>0 → prepareBridgeRoute 照走(不再要求组内有 sendspin 成员),
//     且组落库音量随 bridgePrepare 下发(initialVolume);
//   ② 纯 AP 桥组仍起组泵(spin job 带 bridge 规格下发)且桥成员不 solo cast;
//   ③ prepare 全失败 → 逐设备回落 solo cast(MAJ-07 不变);
//   ④ 暖复用:同集合同协议二连播沿用 token、不拆桥;
//   ⑤ 传输 op(暂停/停)落到组泵(spinOp 对纯 AP 桥组不再早退);
//   ⑥ pollState / getGroupStatus:leader=桥占用 airplay 的纯 AP 组从组泵派生;
//   ⑦ isGroupBridgeSessionAttached:组存在且设备仍是成员才豁免互斥。
// 全部依赖 mock,不碰真实网络/子进程(同 GroupProtocolPlayerRoutes.test.ts 姿势)。
import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => {
  const calls: Record<string, string[]> = {};
  const rec = (id: string, s: string): void => { (calls[id] ??= []).push(s); };

  const groups = new Map<string, { id: string; name: string; memberIds: string[] }>();
  const gmVolumeWrite: Array<[string, number]> = [];
  const gm = {
    get: (id: string) => groups.get(id),
    list: () => Array.from(groups.values()),
    getVolume: () => 37,
    setVolume: (id: string, v: number) => { gmVolumeWrite.push([id, v]); return v; },
    resolveMemberStates: () => [],
    groupsOfDevice: () => [],
  };

  const apStatus: Record<string, any> = {};
  const bridgeOwned = new Set<string>();
  const devices: Record<string, { available: boolean }> = {};
  const devStatus: Record<string, any> = {};

  const prepareCalls: Array<{ deviceId: string; token: string; protocol: string; groupId?: string; opts?: any }> = [];
  const prepareFail = new Set<string>();
  const bridgeStopCalls: Array<{ token: string; deviceId?: string }> = [];
  const spinPlayCalls: any[] = [];
  const transportCalls: Array<{ gname: string; op: string; arg?: any }> = [];
  const state = { groupPoll: { playing: true, paused: false, positionMs: 12_000, durationMs: 100_000 } };

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
        return { playerId: pid, playbackState: "PLAYING", position: 9, duration: 100, updatedAt: 1 };
      },
    };
  }

  function spinPlayer(gid: string) {
    const key = `spin:${gid}`;
    return {
      playerId: key,
      async playMedia(item: any, baseUrl: string, startMs: number, extra?: any) {
        spinPlayCalls.push({ gid, songId: item.songId, startMs, extra });
        return { mediaUri: `spin-${gid}` };
      },
      async stop() { rec(key, "stop"); },
      async pause() { rec(key, "pause"); },
      async resume() { rec(key, "resume"); },
      async seek(s: number) { rec(key, `seek:${s}`); },
      async setVolume(v: number) { rec(key, `vol:${v}`); },
      async pollState() {
        rec(key, "poll");
        return { playerId: key, playbackState: "PLAYING", position: 12, duration: 100, mediaUri: "spin", updatedAt: 2 };
      },
    };
  }

  function reset(): void {
    for (const k of Object.keys(calls)) delete calls[k];
    groups.clear();
    gmVolumeWrite.length = 0;
    for (const k of Object.keys(apStatus)) delete apStatus[k];
    bridgeOwned.clear();
    for (const k of Object.keys(devices)) delete devices[k];
    for (const k of Object.keys(devStatus)) delete devStatus[k];
    prepareCalls.length = 0;
    prepareFail.clear();
    bridgeStopCalls.length = 0;
    spinPlayCalls.length = 0;
    transportCalls.length = 0;
  }

  return { calls, rec, groups, gm, gmVolumeWrite, apStatus, bridgeOwned, devices, devStatus,
    prepareCalls, prepareFail, bridgeStopCalls, spinPlayCalls, transportCalls, state,
    protoPlayer, spinPlayer, reset };
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
    h.apStatus[id] ?? { available: false, name: id, playbackState: "IDLE", position: 0, duration: 0, volume: 0, muted: false },
  isAirPlayDeviceDisabled: () => false,
  isAirplayBridgeEnabled: () => true,
  isBridgeOwned: (id: string) => h.bridgeOwned.has(id),
  selectAirPlayBridgeProtocol: () => "raop" as const,
  bridgePrepareDevice: async (deviceId: string, token: string, protocol: string, groupId?: string, opts?: any) => {
    h.prepareCalls.push({ deviceId, token, protocol, groupId, opts });
    if (h.prepareFail.has(deviceId)) throw new Error("prepare failed");
    return { listening: true as const, socketPath: `/tmp/b_${deviceId}_${token}.sock` };
  },
  bridgeStopDevice: async (token: string, deviceId?: string) => {
    h.bridgeStopCalls.push({ token, deviceId });
  },
}));

vi.mock("../../src/services/airplay/bridgeChannel.js", () => ({
  bridgeSocketPath: (deviceId: string, token: string) => `/tmp/b_${deviceId}_${token}.sock`,
}));

vi.mock("../../src/services/sendspin/index.js", () => ({
  getSendspinFront: () => null,
  sendspinGroupBridgeSync: async (_g: string, specs: Array<{ deviceId: string }>) =>
    ({ synced: specs.length, backfilled: 0, confirmed: true }),
  sendspinGroupPoll: async () => h.state.groupPoll,
  sendspinBridgeStatus: async () => [],
  sendspinBridgeDetach: async () => true,
  sendspinGroupJoin: async () => true,
  sendspinGroupTransport: async (gname: string, op: string, arg?: any) => {
    h.transportCalls.push({ gname, op, arg });
    return true;
  },
}));

vi.mock("../../src/services/sendspin/playerCore.js", () => ({
  sendspinGroupName: (gid: string) => `ug:${gid}`,
}));

vi.mock("../../src/services/sendspin/protocolPlayer.js", () => ({
  createSendspinGroupPlayer: (gid: string) => h.spinPlayer(gid),
}));

vi.mock("../../src/services/airplay/supervisor.js", () => ({
  airplaySupervisor: { isRunning: () => false, rpc: async () => null },
}));

vi.mock("../../src/services/player/index.js", () => ({
  getQueueController: () => ({ stopPlayback: () => {}, snapshot: () => null }),
  getPlayerController: () => ({ reportState: () => {} }),
}));

import {
  createGroupProtocolPlayer,
  getGroupStatus,
  isGroupBridgeSessionAttached,
  setBridgeRoutesForTest,
} from "../../src/services/group/protocolPlayer.js";

function makeItem(songId = "s1"): any { return { songId, title: "t", mime: "audio/mpeg", duration: 100 }; }
function setGroup(memberIds: string[], id = "g1"): void { h.groups.set(id, { id, name: "组", memberIds }); }
function apOn(id: string): void {
  h.apStatus[id] = { available: true, name: id, playbackState: "PLAYING", position: 5, duration: 100, volume: 50, muted: false };
}

beforeEach(() => {
  h.reset();
  // activeBridgeRoutes 是模块级事实源:不清会让上一用例的残留路由把本用例的首播
  // 判成 warm 复用(settleDlna=false),冷建语义断言失真。
  setBridgeRoutesForTest(new Map());
});

describe("v4.9.3 方向 A:纯 AirPlay 组强制走桥", () => {
  it("spin=0 且 ap>0:prepareBridgeRoute 照走,组泵带桥规格起推,桥成员不 solo cast,组落库音量随 prepare 下发", async () => {
    setGroup(["airplay:ap1"]);
    apOn("ap1");
    const r = await createGroupProtocolPlayer("g1").playMedia(makeItem(), "http://b");
    expect(h.prepareCalls).toHaveLength(1);
    expect(h.prepareCalls[0].deviceId).toBe("ap1");
    expect(h.prepareCalls[0].groupId).toBe("g1");
    // 组落库音量(getVolume=37)作为 initialVolume 随 prepare 下发(§音量语义)
    expect(h.prepareCalls[0].opts?.initialVolume).toBe(37);
    // 冷建(新 token)⇒ settleDlna=true(v4.9.4:桥 prepare 先 settle 同 host DLNA)
    expect(h.prepareCalls[0].opts?.settleDlna).toBe(true);
    // 组泵起推且桥规格透传
    expect(h.spinPlayCalls).toHaveLength(1);
    expect(h.spinPlayCalls[0].songId).toBe("s1");
    expect(h.spinPlayCalls[0].extra?.sockets).toHaveLength(1);
    expect(h.spinPlayCalls[0].extra.sockets[0].deviceId).toBe("ap1");
    // 桥成员不 solo cast(桥消费组泵 PCM)
    expect(h.calls["ap1"]).toBeUndefined();
    expect(r.mediaUri).toBe("spin-g1");
  });

  it("prepare 全失败 → 桥路由为 null,纯 AP 成员逐设备回落 solo cast(MAJ-07 不变)", async () => {
    setGroup(["airplay:ap1"]);
    apOn("ap1");
    h.prepareFail.add("ap1");
    const r = await createGroupProtocolPlayer("g1").playMedia(makeItem(), "http://b");
    expect(h.spinPlayCalls).toHaveLength(0); // 无桥规格不起泵
    expect(h.calls["ap1"]).toContain("play");
    expect(r.mediaUri).toBe("airplay-ap1");
  });

  it("暖复用:同集合同协议二连播沿用 token、不拆桥(routeReusable 判据改 ap 集合)", async () => {
    setGroup(["airplay:ap1"]);
    apOn("ap1");
    const p = createGroupProtocolPlayer("g1");
    await p.playMedia(makeItem(), "http://b");
    await p.playMedia(makeItem("s2"), "http://b");
    expect(h.prepareCalls).toHaveLength(2);
    expect(h.prepareCalls[1].token).toBe(h.prepareCalls[0].token);
    expect(h.bridgeStopCalls).toHaveLength(0);
    // 冷建 settle、暖复用不 settle(v4.9.4)
    expect(h.prepareCalls[0].opts?.settleDlna).toBe(true);
    expect(h.prepareCalls[1].opts?.settleDlna).toBe(false);
  });

  it("纯 AP 桥组传输 op 落泵:pause/stop 经 spinOp 下发组泵(spinOp 不再对 sp=0 早退)", async () => {
    setGroup(["airplay:ap1"]);
    apOn("ap1");
    const p = createGroupProtocolPlayer("g1");
    await p.playMedia(makeItem(), "http://b");
    await p.pause();
    await p.stop();
    expect(h.calls["spin:g1"]).toContain("pause");
    expect(h.calls["spin:g1"]).toContain("stop");
    // stop 后桥路由回收
    expect(h.bridgeStopCalls).toHaveLength(1);
  });

  it("pollState:leader=桥占用 airplay 的纯 AP 组从共享组泵派生(不落 solo 恒 STOPPED)", async () => {
    setGroup(["airplay:ap1"]);
    apOn("ap1");
    h.bridgeOwned.add("ap1");
    const s = await createGroupProtocolPlayer("g1").pollState();
    expect(s.playbackState).toBe("PLAYING");
    expect(s.position).toBe(12);
    expect(h.calls["spin:g1"]).toContain("poll");
    expect(h.calls["ap1"]).toBeUndefined();
  });

  it("getGroupStatus:纯 AP 桥组回组泵状态 + player_groups 落库音量", async () => {
    setGroup(["airplay:ap1"]);
    apOn("ap1");
    h.bridgeOwned.add("ap1");
    const st = await getGroupStatus("g1");
    expect(st.state).toBe("PLAYING");
    expect(st.volume).toBe(37);
  });

  it("isGroupBridgeSessionAttached:组存在且设备仍是成员才豁免;组解散/设备移出/非成员均 false", () => {
    setGroup(["airplay:ap1", "dlna:d1"]);
    expect(isGroupBridgeSessionAttached("g1", "ap1")).toBe(true);
    expect(isGroupBridgeSessionAttached("g1", "ap2")).toBe(false);
    expect(isGroupBridgeSessionAttached("nope", "ap1")).toBe(false);
    setGroup(["dlna:d1"]);
    expect(isGroupBridgeSessionAttached("g1", "ap1")).toBe(false);
  });
});
