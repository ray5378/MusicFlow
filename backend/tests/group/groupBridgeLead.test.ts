// ==================== 组状态「桥成员 lead 扣除」回归测试(2026-11-14 00def316) ====================
//
// 事故:桥成员「写入未出声」~2.05s(tick 的 commandedLeadUs),组状态直接回组泵
//   positionMs ⇒ 进度恒领先声音。修复:getGroupStatus 的两条 sendspin 分支都要
//   扣掉 bridgeLeadContentSec(取路由内最大 lead,输出流秒 × 倍速 = 内容秒,
//   倍速越高同样 2s 的 lead 覆盖的内容越多),并钳 0 绝不为负。
//
// 这里用真实 playMedia(纯 AP 桥组)登记 activeBridgeRoutes,再从 mock 侧注入
// lead 值,断言:
//   ① lead>0 → 组状态 position 扣掉 lead×speed;
//   ② lead=0 / 无桥路由 → 原值不动;
//   ③ 倍速 2x → 按 speed 折算内容秒;
//   ④ 扣完为负 → 钳 0。
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
  // 设备 → 当前「写入未出声」毫秒(mock 侧注入,替代真实 tick 链路)
  const leads: Record<string, number> = {};

  const prepareCalls: Array<{ deviceId: string; token: string; protocol: string; groupId?: string; opts?: any }> = [];
  const spinPlayCalls: any[] = [];
  const state = { groupPoll: { playing: true, paused: false, positionMs: 12_000, durationMs: 100_000 } };

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
    for (const k of Object.keys(leads)) delete leads[k];
    prepareCalls.length = 0;
    spinPlayCalls.length = 0;
    // 用例 ⑤ 会改 groupPoll.positionMs,必须恢复,否则污染后续用例
    state.groupPoll = { playing: true, paused: false, positionMs: 12_000, durationMs: 100_000 };
  }

  return { calls, rec, groups, gm, apStatus, bridgeOwned, devices, devStatus, leads,
    prepareCalls, spinPlayCalls, state, spinPlayer, reset };
});

vi.mock("../../src/services/group/index.js", async (importOriginal) => {
  const actual = await importOriginal<any>();
  return { getGroupManager: () => h.gm, splitMemberId: actual.splitMemberId };
});

vi.mock("../../src/services/dlna/control.js", () => ({
  createDlnaProtocolPlayer: (id: string) => ({
    playerId: `dlna:${id}`,
    async playMedia() { return { mediaUri: `dlna-${id}` }; },
    async stop() {}, async pause() {}, async resume() {}, async seek() {}, async setVolume() {},
    async pollState() { return { playerId: `dlna:${id}`, playbackState: "PLAYING", position: 9, duration: 100, updatedAt: 1 }; },
  }),
  getDevice: (id: string) => (h.devices[id] ? { id } : undefined),
  isDeviceAvailable: (id: string) => !!h.devices[id]?.available,
  getDeviceStatus: async (id: string) =>
    h.devStatus[id] ?? { state: "STOPPED", position: 0, duration: 0, volume: 0 },
}));

vi.mock("../../src/services/airplay/protocolPlayer.js", () => ({
  createAirPlayPlayerForDevice: (id: string) => ({
    playerId: `airplay:${id}`,
    async playMedia() { return { mediaUri: `ap-${id}` }; },
    async stop() {}, async pause() {}, async resume() {}, async seek() {}, async setVolume() {},
    async pollState() { return { playerId: `airplay:${id}`, playbackState: "PLAYING", position: 9, duration: 100, updatedAt: 1 }; },
  }),
  createAirPlayProtocolPlayer: (id: string) => ({
    playerId: `airplay:${id}`,
    async playMedia() { return { mediaUri: `ap-${id}` }; },
    async stop() {}, async pause() {}, async resume() {}, async seek() {}, async setVolume() {},
    async pollState() { return { playerId: `airplay:${id}`, playbackState: "PLAYING", position: 9, duration: 100, updatedAt: 1 }; },
  }),
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
  getBridgeLeadMs: (deviceId: string) => h.leads[deviceId] ?? 0,
}));

vi.mock("../../src/services/sendspin/index.js", () => ({
  getSendspinFront: () => null,
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

import {
  createGroupProtocolPlayer,
  getGroupStatus,
  setBridgeRoutesForTest,
} from "../../src/services/group/protocolPlayer.js";
import { setPlaybackSpeed } from "../../src/services/player/playbackSpeed.js";

function makeItem(songId = "s1"): any { return { songId, title: "t", mime: "audio/mpeg", duration: 100 }; }
function setGroup(memberIds: string[], id = "g1"): void { h.groups.set(id, { id, name: "组", memberIds }); }
function apOn(id: string): void {
  h.apStatus[id] = { available: true, name: id, playbackState: "PLAYING", position: 5, duration: 100, volume: 50, muted: false };
}

/** 起一次纯 AP 桥组播放,让 activeBridgeRoutes 登记 ap1 的桥路由。 */
async function startBridgePlayback(): Promise<void> {
  setGroup(["airplay:ap1"]);
  apOn("ap1");
  await createGroupProtocolPlayer("g1").playMedia(makeItem(), "http://b");
  expect(h.spinPlayCalls).toHaveLength(1); // 泵已带桥规格起推
  expect(h.prepareCalls).toHaveLength(1);
}

beforeEach(async () => {
  h.reset();
  // activeBridgeRoutes 是模块级事实源:不清会让上一用例的残留路由漏进本用例。
  setBridgeRoutesForTest(new Map());
  setPlaybackSpeed("g1", 1);
});

describe("getGroupStatus:组进度扣除桥成员 lead(00def316)", () => {
  it("① 无桥路由时不扣 lead:position 原值返回", async () => {
    setGroup(["airplay:ap1"]);
    apOn("ap1");
    h.leads["ap1"] = 2050; // 有 lead 记录但组没登记桥路由 ⇒ bridgeLeadContentSec=0
    const st = await getGroupStatus("g1");
    expect(st.state).toBe("PLAYING");
    expect(st.position).toBe(12); // floor(12000/1000),不扣
  });

  it("② 桥路由在 + lead=2050ms → position 扣掉 2.05s 内容秒", async () => {
    await startBridgePlayback();
    h.leads["ap1"] = 2050;
    const st = await getGroupStatus("g1");
    expect(st.position).toBe(9); // floor(12 - 2.05)
  });

  it("③ 倍速 2x:lead 按速度折算内容秒(输出流秒 × speed)", async () => {
    await startBridgePlayback();
    setPlaybackSpeed("g1", 2);
    h.leads["ap1"] = 2050;
    const st = await getGroupStatus("g1");
    expect(st.position).toBe(7); // floor(12 - 2.05*2) = floor(7.9)
  });

  it("④ 组内多桥成员取最大 lead(宁少不多扣)", async () => {
    setGroup(["airplay:ap1", "airplay:ap2"]);
    apOn("ap1");
    apOn("ap2");
    await createGroupProtocolPlayer("g1").playMedia(makeItem(), "http://b");
    expect(h.prepareCalls).toHaveLength(2);
    h.leads["ap1"] = 1000;
    h.leads["ap2"] = 3050;
    const st = await getGroupStatus("g1");
    expect(st.position).toBe(8); // max(3050)/1000 → floor(12 - 3.05)
  });

  it("⑤ 扣完为负 → 钳 0,绝不为负", async () => {
    await startBridgePlayback();
    setPlaybackSpeed("g1", 2);
    h.leads["ap1"] = 2050;
    h.state.groupPoll = { playing: true, paused: false, positionMs: 1_000, durationMs: 100_000 };
    const st = await getGroupStatus("g1");
    expect(st.position).toBe(0); // max(0, floor(1 - 4.1))
  });

  it("⑥ 无 tick 记录(lead=0)→ position 原值(扣除路径不引入误差)", async () => {
    await startBridgePlayback();
    const st = await getGroupStatus("g1");
    expect(st.position).toBe(12);
  });
});
