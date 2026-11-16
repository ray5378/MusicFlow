// ==================== 组倍速重投「保留起点」回归测试(2026-11-14 e9895a3f) ====================
//
// 事故:组 playMedia 的形参 _startMs 从未被使用 ⇒ 变速/流转把组终点重投时恒从 0 起
//   播(用户实测:19s → 倍速 → 从头播)。修复后 startMs 必须透传给**三条扇出路径**:
//     ① sendspin 组泵 createSendspinGroupPlayer(groupId).playMedia(item, baseUrl, startMs, …)
//     ② DLNA 成员逐台扇出 createDlnaProtocolPlayer(d).playMedia(item, baseUrl, startMs, …)
//     ③ solo AirPlay(桥禁用回滚路径)createAirPlayPlayerForDevice(d).playMedia(item, baseUrl, startMs)
//   任何一条被改回硬编码 0,表现为「组内部分成员从头播、部分成员位置连续」,
//   不报错、不崩,只能真机发现 ⇒ 静态守卫 check-playback-regression.mjs 同步钉字面量,
//   这里钉**运行时透传**(fake 收到的实参)。
// 全部依赖 mock,不碰真实网络/子进程(与 pureApBridgeRoute.test.ts 同款姿势)。
import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => {
  const calls: Record<string, string[]> = {};
  const rec = (id: string, s: string): void => { (calls[id] ??= []).push(s); };

  const groups = new Map<string, { id: string; name: string; memberIds: string[] }>();
  const gm = {
    get: (id: string) => groups.get(id),
    list: () => Array.from(groups.values()),
    getVolume: () => 37,
    setVolume: (id: string, v: number) => v,
    resolveMemberStates: () => [],
    groupsOfDevice: () => [],
  };

  const apStatus: Record<string, any> = {};
  const bridgeOwned = new Set<string>();
  const devices: Record<string, { available: boolean }> = {};
  const devStatus: Record<string, any> = {};
  let bridgeEnabled = false;
  // sendspin front:clients Map 决定 getOnlineSendspinIds 的在线判定
  const spinClients = new Map<string, { ready: boolean }>();

  const prepareCalls: Array<{ deviceId: string; token: string; protocol: string; groupId?: string; opts?: any }> = [];
  const spinPlayCalls: any[] = [];
  const dlnaPlayCalls: any[] = [];
  const apSoloPlayCalls: any[] = [];
  const state = { groupPoll: { playing: true, paused: false, positionMs: 12_000, durationMs: 100_000 } };

  function dlnaPlayer(id: string) {
    const pid = `dlna:${id}`;
    return {
      playerId: pid,
      async playMedia(item: any, baseUrl: string, startMs: number, _bridge?: any, opts?: any) {
        dlnaPlayCalls.push({ deviceId: id, songId: item.songId, baseUrl, startMs, extra: opts });
        rec(id, "play");
        return { mediaUri: `dlna-${id}` };
      },
      async stop() { rec(id, "stop"); },
      async pause() { rec(id, "pause"); },
      async resume() { rec(id, "resume"); },
      async seek(s: number) { rec(id, `seek:${s}`); },
      async setVolume(v: number) { rec(id, `vol:${v}`); },
      async pollState() {
        return { playerId: pid, playbackState: "PLAYING", position: 9, duration: 100, updatedAt: 1 };
      },
    };
  }

  function apPlayer(id: string) {
    const pid = `airplay:${id}`;
    return {
      playerId: pid,
      async playMedia(item: any, baseUrl: string, startMs?: number) {
        apSoloPlayCalls.push({ deviceId: id, songId: item.songId, baseUrl, startMs });
        rec(id, "play");
        return { mediaUri: `ap-${id}` };
      },
      async stop() { rec(id, "stop"); },
      async pause() { rec(id, "pause"); },
      async resume() { rec(id, "resume"); },
      async seek(s: number) { rec(id, `seek:${s}`); },
      async setVolume(v: number) { rec(id, `vol:${v}`); },
      async pollState() {
        return { playerId: pid, playbackState: "PLAYING", position: 9, duration: 100, updatedAt: 1 };
      },
    };
  }

  function spinPlayer(gid: string) {
    const key = `spin:${gid}`;
    return {
      playerId: key,
      async playMedia(item: any, baseUrl: string, startMs: number, extra?: any) {
        spinPlayCalls.push({ gid, songId: item.songId, baseUrl, startMs, extra });
        return { mediaUri: `spin-${gid}` };
      },
      async stop() { rec(key, "stop"); },
      async pause() { rec(key, "pause"); },
      async resume() { rec(key, "resume"); },
      async seek(s: number) { rec(key, `seek:${s}`); },
      async setVolume(v: number) { rec(key, `vol:${v}`); },
      async pollState() {
        return { playerId: key, playbackState: "PLAYING", position: 12, duration: 100, mediaUri: "spin", updatedAt: 2 };
      },
    };
  }

  function reset(): void {
    for (const k of Object.keys(calls)) delete calls[k];
    groups.clear();
    for (const k of Object.keys(apStatus)) delete apStatus[k];
    bridgeOwned.clear();
    for (const k of Object.keys(devices)) delete devices[k];
    for (const k of Object.keys(devStatus)) delete devStatus[k];
    spinClients.clear();
    prepareCalls.length = 0;
    spinPlayCalls.length = 0;
    dlnaPlayCalls.length = 0;
    apSoloPlayCalls.length = 0;
    bridgeEnabled = false;
  }

  return { calls, rec, groups, gm, apStatus, bridgeOwned, devices, devStatus, spinClients,
    prepareCalls, spinPlayCalls, dlnaPlayCalls, apSoloPlayCalls, state,
    dlnaPlayer, apPlayer, spinPlayer, reset,
    getBridgeEnabled: () => bridgeEnabled, setBridgeEnabled: (v: boolean) => { bridgeEnabled = v; } };
});

vi.mock("../../src/services/group/index.js", async (importOriginal) => {
  const actual = await importOriginal<any>();
  return { getGroupManager: () => h.gm, splitMemberId: actual.splitMemberId };
});

vi.mock("../../src/services/dlna/control.js", () => ({
  createDlnaProtocolPlayer: (id: string) => h.dlnaPlayer(id),
  getDevice: (id: string) => (h.devices[id] ? { id } : undefined),
  isDeviceAvailable: (id: string) => !!h.devices[id]?.available,
  getDeviceStatus: async (id: string) =>
    h.devStatus[id] ?? { state: "STOPPED", position: 0, duration: 0, volume: 0 },
}));

vi.mock("../../src/services/airplay/protocolPlayer.js", () => ({
  createAirPlayPlayerForDevice: (id: string) => h.apPlayer(id),
  createAirPlayProtocolPlayer: (id: string) => h.apPlayer(id),
}));

vi.mock("../../src/services/airplay/control.js", () => ({
  getAirPlayStatus: (id: string) =>
    h.apStatus[id] ?? { available: false, name: id, playbackState: "IDLE", position: 0, duration: 0, volume: 0, muted: false },
  isAirPlayDeviceDisabled: () => false,
  // 倍速重投透传测试专测 legacy 扇出 ⇒ 默认桥禁用(可用例内开关)
  isAirplayBridgeEnabled: () => h.getBridgeEnabled(),
  isBridgeOwned: (id: string) => h.bridgeOwned.has(id),
  selectAirPlayBridgeProtocol: () => "raop" as const,
  bridgePrepareDevice: async (deviceId: string, token: string, protocol: string, groupId?: string, opts?: any) => {
    h.prepareCalls.push({ deviceId, token, protocol, groupId, opts });
    return { listening: true as const, socketPath: `/tmp/b_${deviceId}_${token}.sock` };
  },
  bridgeStopDevice: async (token: string, deviceId?: string) => {},
  bridgeManualDevice: async (token: string, deviceId?: string) => {},
  hasActiveSession: () => false,
}));

vi.mock("../../src/services/airplay/bridgeChannel.js", () => ({
  bridgeSocketPath: (deviceId: string, token: string) => `/tmp/b_${deviceId}_${token}.sock`,
}));

vi.mock("../../src/services/airplay/bridgeSession.js", () => ({
  getBridgeLeadMs: () => 0,
}));

vi.mock("../../src/services/sendspin/index.js", () => ({
  getSendspinFront: () => (h.spinClients.size > 0 ? { clients: h.spinClients } : null),
  sendspinGroupBridgeSync: async (_g: string, specs: Array<{ deviceId: string }>) =>
    ({ synced: specs.length, backfilled: 0, confirmed: true }),
  sendspinGroupPoll: async () => h.state.groupPoll,
  sendspinBridgeStatus: async () => [],
  sendspinBridgeDetach: async () => true,
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
  airplaySupervisor: { isRunning: () => false, rpc: async () => null },
}));

vi.mock("../../src/services/player/index.js", () => ({
  getQueueController: () => ({ stopPlayback: () => {}, snapshot: () => null }),
  getPlayerController: () => ({ reportState: () => {} }),
}));

import { createGroupProtocolPlayer } from "../../src/services/group/protocolPlayer.js";

function makeItem(songId = "s1"): any { return { songId, title: "t", mime: "audio/mpeg", duration: 100 }; }
function setGroup(memberIds: string[], id = "g1"): void { h.groups.set(id, { id, name: "组", memberIds }); }
function dlnaOn(id: string): void { h.devices[id] = { available: true }; }
function apOn(id: string): void {
  h.apStatus[id] = { available: true, name: id, playbackState: "PLAYING", position: 5, duration: 100, volume: 50, muted: false };
}
function spinOn(id: string): void { h.spinClients.set(id, { ready: true }); }

beforeEach(() => {
  h.reset();
});

describe("组 playMedia:startMs 透传(组倍速重投保留起点,e9895a3f)", () => {
  it("① sendspin 组泵收到原样 startMs(组重投位置连续的根基)", async () => {
    setGroup(["sendspin:dev1"]);
    spinOn("dev1");
    await createGroupProtocolPlayer("g1").playMedia(makeItem(), "http://b", 190_000);
    expect(h.spinPlayCalls).toHaveLength(1);
    expect(h.spinPlayCalls[0].startMs).toBe(190_000);
    // 桥规格与 opts 仍按原样带(None ⇒ undefined)
    expect(h.spinPlayCalls[0].extra).toBeUndefined();
  });

  it("② DLNA 成员逐台收到原样 startMs + 组倍速", async () => {
    setGroup(["dlna:d1", "dlna:d2"]);
    dlnaOn("d1");
    dlnaOn("d2");
    await createGroupProtocolPlayer("g1").playMedia(makeItem(), "http://b", 41_000);
    expect(h.dlnaPlayCalls).toHaveLength(2);
    for (const call of h.dlnaPlayCalls) {
      expect(call.startMs).toBe(41_000); // 绝不允许回到硬编码 0
      expect(call.extra?.speed).toBe(1); // 组倍速显式下发(默认 1x)
    }
  });

  it("③ 桥禁用回滚路径:solo AirPlay 成员收到原样 startMs", async () => {
    setGroup(["dlna:d1", "airplay:ap1"]);
    dlnaOn("d1");
    apOn("ap1");
    h.setBridgeEnabled(false); // MUSICFLOW_AIRPLAY_BRIDGE=0 语义
    await createGroupProtocolPlayer("g1").playMedia(makeItem(), "http://b", 52_000);
    expect(h.apSoloPlayCalls).toHaveLength(1);
    expect(h.apSoloPlayCalls[0].deviceId).toBe("ap1");
    expect(h.apSoloPlayCalls[0].startMs).toBe(52_000);
    expect(h.prepareCalls).toHaveLength(0); // 桥禁用不起桥
    expect(h.spinPlayCalls).toHaveLength(0); // 无 spin 成员不起泵
  });

  it("startMs = 0(正常整曲起播)同样走透传路径,不触发任何特殊分支", async () => {
    setGroup(["dlna:d1"]);
    dlnaOn("d1");
    await createGroupProtocolPlayer("g1").playMedia(makeItem(), "http://b", 0);
    expect(h.dlnaPlayCalls).toHaveLength(1);
    expect(h.dlnaPlayCalls[0].startMs).toBe(0);
  });
});
