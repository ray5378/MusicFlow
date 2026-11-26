// ==================== 组状态位置口径:与设备侧真相同源(2026-11-20 修订) ====================
//
// 历史:00def316(2026-11-14) 认为组状态直接回 positionMs 会让进度领先声音 ~2.05s,
//   于是在 getGroupStatus 里再扣一次 bridgeLeadContentSec(取路由内最大 lead)。
//   但 streamEngine.audiblePositionMs 已经把「已推送位置 − 缓冲深度」算好,
//   positionMs 本身就是「设备此刻正在响」的位置 ⇒ 二次扣减变成恒定落后 ~2.05s:
//   歌没播完 UI 就到不了终点(看着像提前切歌),seek 落点也少 2s。
//
// 为什么现在判定为落后(判据):
//   sendspinPlayer.pollState() 用的是**同一个** positionMs 且不减 lead,
//   240 实测自然播完时 pos == dur 精确相等(近 60 分钟 15/15 次) ——
//   设备侧真相就是 positionMs。两侧必须同源,lead 只由 audiblePositionMs 一处扣。
//
// 下面是防回归锁:
//   ① 有/无桥路由:position 都等于 floor(positionMs/1000);
//   ② 倍速、多成员、lead 值都不再影响结果;
//   ③ 播完(positionMs == durationMs)时 position 必须等于 duration;
//   ④ 源码里不得再对 positionMs 做 lead 二次扣减。
import fs from "node:fs";
import path from "node:path";
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

describe("getGroupStatus:位置与设备侧真相同源(不二次扣 lead)", () => {
  it("① 无桥路由:position = floor(positionMs/1000)", async () => {
    setGroup(["airplay:ap1"]);
    apOn("ap1");
    h.leads["ap1"] = 2050;
    const st = await getGroupStatus("g1");
    expect(st.state).toBe("PLAYING");
    expect(st.position).toBe(12);
  });

  it("② 桥路由在、lead=2050ms:仍不扣(必须与 pollState 同源)", async () => {
    await startBridgePlayback();
    h.leads["ap1"] = 2050;
    const st = await getGroupStatus("g1");
    expect(st.position).toBe(12); // 旧行为 9 ⇒ UI 恒定落后 2.05s
  });

  it("③ 倍速 2x 不再折算内容秒", async () => {
    await startBridgePlayback();
    setPlaybackSpeed("g1", 2);
    h.leads["ap1"] = 2050;
    const st = await getGroupStatus("g1");
    expect(st.position).toBe(12);
  });

  it("④ 多桥成员的大 lead 不再影响结果", async () => {
    setGroup(["airplay:ap1", "airplay:ap2"]);
    apOn("ap1");
    apOn("ap2");
    await createGroupProtocolPlayer("g1").playMedia(makeItem(), "http://b");
    expect(h.prepareCalls).toHaveLength(2);
    h.leads["ap1"] = 1000;
    h.leads["ap2"] = 3050;
    const st = await getGroupStatus("g1");
    expect(st.position).toBe(12);
  });

  it("⑤ 播完(positionMs == durationMs):position 必须等于 duration", async () => {
    await startBridgePlayback();
    h.leads["ap1"] = 2050;
    h.state.groupPoll = { playing: true, paused: false, positionMs: 195_000, durationMs: 195_000 };
    const st = await getGroupStatus("g1");
    expect(st.duration).toBe(195);
    // 旧行为 192 ⇒ 进度条差 3 秒到终点,表现为「没播完就切歌」
    expect(st.position).toBe(195);
  });

  it("⑥ 极小位置按 0.1s 精度上报,绝不为负", async () => {
    await startBridgePlayback();
    h.leads["ap1"] = 2050;
    h.state.groupPoll = { playing: true, paused: false, positionMs: 800, durationMs: 100_000 };
    const st = await getGroupStatus("g1");
    // [D3 2026-11-26] 800ms 在新口径下是 0.8s(原 floor 整秒报 0);钳 0 只兜负数。
    expect(st.position).toBe(0.8);
  });

  it("⑦ 源码不得再对 positionMs 做 lead 二次扣减", () => {
    const src = fs.readFileSync(
      path.resolve(process.cwd(), "src/services/group/protocolPlayer.ts"),
      "utf8",
    );
    expect(src).toContain("displayPositionMs ?? st.positionMs");
    expect(src).not.toContain("st.positionMs / 1000 - ");
    expect(src).not.toContain("gst.positionMs / 1000 - ");
  });
});
