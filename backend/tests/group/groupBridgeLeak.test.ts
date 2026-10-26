// 桥路由失败回收(D1)与播中半挂回滚(D2)的回归用例。
//
// 背景(两处同一失效面):60s 对账 reconcileBridgeRoutesOnce 以「activeBridgeRoutes 登记」
// 为唯一事实源 —— 只要登记还在,对账就认为它合法,**永不兜底摘除**。于是任何「主进程
// 登记了桥、但实际没有可用出流」的中间态都会变成**永久占用**:设备被 owner=bridge 卡住,
// native cast 被互斥拒 ⇒ 无声 / 音量失效 / 只能重启服务。
//   ① D1:playMedia 全成员 cast 失败时,失败分支直接 throw,没回收刚登记的桥路由;
//   ② D2:bridgeJoinMember 在泵侧 sync 抛错时,已 prepare + 已 push 的 spec 没有回滚。
// 这两条在此文件里被钉死,且额外钉住两个「修 D1 时最容易踩的坑」:
//   · 回收动作自身抛错时,**原始错误必须原样抛出**(不许被回收异常顶替/吞掉);
//   · 正常成功路径**不得**误拆路由(不能把 teardown 挪到成功路径上治 D1)。
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const h = vi.hoisted(() => {
  const groups = new Map<string, { id: string; name: string; memberIds: string[] }>();
  const apStatus: Record<string, any> = {};
  const prepareCalls: any[] = [];
  const bridgeStopCalls: Array<{ token: string; deviceId?: string }> = [];
  const state = { spinPlayFail: true, syncThrows: true, bridgeStopThrowsSync: false };

  const gm = {
    get: (id: string) => groups.get(id),
    list: () => Array.from(groups.values()),
    getVolume: () => 20,
    setVolume: (_id: string, v: number) => v,
    resolveMemberStates: () => [],
    groupsOfDevice: () => [],
  };

  const noopPlayer = {
    playerId: "x",
    async playMedia() { return { mediaUri: "x" }; },
    async stop() {},
    async pause() {},
    async resume() {},
    async seek() {},
    async setVolume() {},
    async pollState() {
      return { playerId: "x", playbackState: "PLAYING", position: 0, duration: 0, updatedAt: 0 };
    },
  };

  return { groups, apStatus, prepareCalls, bridgeStopCalls, state, gm, noopPlayer };
});

vi.mock("../../src/services/group/index.js", async (importOriginal) => {
  const actual = await importOriginal<any>();
  return { getGroupManager: () => h.gm, splitMemberId: actual.splitMemberId };
});

vi.mock("../../src/services/dlna/control.js", () => ({
  createDlnaProtocolPlayer: () => h.noopPlayer,
  getDevice: () => undefined,
  isDeviceAvailable: () => false,
  getDeviceStatus: async () => ({ state: "STOPPED", position: 0, duration: 0, volume: 0 }),
}));

vi.mock("../../src/services/airplay/protocolPlayer.js", () => ({
  createAirPlayProtocolPlayer: () => h.noopPlayer,
}));

vi.mock("../../src/services/airplay/control.js", () => ({
  getAirPlayStatus: (id: string) =>
    h.apStatus[id] ?? { available: true, name: id, playbackState: "IDLE", position: 0, duration: 0, volume: 0, muted: false },
  isAirPlayDeviceDisabled: () => false,
  isAirplayBridgeEnabled: () => true,
  isBridgeOwned: () => false,
  // Phase 6b:桥协议逐成员选(本文件只关心桥生命周期,协议固定 raop = AP1 旧行为)。
  selectAirPlayBridgeProtocol: () => "raop",
  bridgePrepareDevice: async (deviceId: string, token: string, protocol: string, groupId?: string) => {
    h.prepareCalls.push({ deviceId, token, protocol, groupId });
    return { listening: true, socketPath: `/tmp/b_${deviceId}_${token}.sock` };
  },
  // 刻意**不是** async:用来模拟 teardownBridgeRoute 内部语句级同步抛错
  // (Promise.allSettled 会吞掉 promise rejection,只有同步抛才能让 teardown 整体抛出)。
  bridgeStopDevice: (token: string, deviceId?: string): Promise<void> => {
    if (h.state.bridgeStopThrowsSync) throw new Error("bridgeStop boom");
    h.bridgeStopCalls.push({ token, deviceId });
    return Promise.resolve();
  },
}));

vi.mock("../../src/services/airplay/bridgeChannel.js", () => ({
  bridgeSocketPath: (deviceId: string, token: string) => `/tmp/b_${deviceId}_${token}.sock`,
}));

vi.mock("../../src/services/sendspin/index.js", () => ({
  getSendspinFront: () => ({ clients: new Map([["sp1", { ready: true }]]), groups: new Map() }),
  sendspinGroupBridgeSync: async () => {
    if (h.state.syncThrows) throw new Error("pump sync boom");
    return { synced: 1, backfilled: 0, confirmed: true };
  },
  sendspinGroupPoll: async () => ({ playing: false, paused: false, positionMs: 0, durationMs: 0 }),
  sendspinBridgeStatus: async () => [],
  sendspinBridgeDetach: async () => true,
  sendspinGroupJoin: async () => true,
  sendspinGroupTransport: async () => true,
}));

vi.mock("../../src/services/sendspin/playerCore.js", () => ({
  sendspinGroupName: (gid: string) => `ug:${gid}`,
}));

vi.mock("../../src/services/sendspin/protocolPlayer.js", () => ({
  createSendspinGroupPlayer: () => ({
    playerId: "sendspin:group",
    async playMedia() {
      if (h.state.spinPlayFail) throw new Error("spin cast 失败");
      return { mediaUri: "spin" };
    },
    async stop() {}, async pause() {}, async resume() {}, async seek() {}, async setVolume() {},
    async pollState() {
      return { playerId: "sendspin:group", playbackState: "PLAYING", position: 0, duration: 0, updatedAt: 0 };
    },
  }),
}));

vi.mock("../../src/services/airplay/supervisor.js", () => ({
  airplaySupervisor: { isRunning: () => false, rpc: async () => null },
}));

import {
  bridgeJoinMember,
  createGroupProtocolPlayer,
  isBridgeRouteActive,
  resetBridgeRouteReconcilerForTest,
  setBridgeRoutesForTest,
} from "../../src/services/group/protocolPlayer.js";

const ITEM: any = { songId: "s1", title: "t", mime: "audio/mpeg", duration: 100 };

beforeEach(() => {
  h.groups.clear();
  for (const k of Object.keys(h.apStatus)) delete h.apStatus[k];
  h.prepareCalls.length = 0;
  h.bridgeStopCalls.length = 0;
  h.state.spinPlayFail = true;
  h.state.syncThrows = true;
  h.state.bridgeStopThrowsSync = false;
  h.apStatus.a1 = {
    available: true, name: "a1", playbackState: "IDLE", position: 0, duration: 0, volume: 0, muted: false,
  };
  resetBridgeRouteReconcilerForTest();
});

afterEach(() => {
  resetBridgeRouteReconcilerForTest();
});

describe("D1:playMedia 全失败后必须回收桥路由(否则设备被 owner=bridge 永久占用)", () => {
  it("组 cast 全失败时,拆掉本组桥路由(bridgeStopDevice 被调用)+ 登记清空", async () => {
    h.groups.set("g1", { id: "g1", name: "组", memberIds: ["sendspin:sp1", "airplay:a1"] });
    const p = createGroupProtocolPlayer("g1");

    // 桥 prepare 成功(spin>0 && airplay>0)后才失败
    await expect(p.playMedia(ITEM, "http://base")).rejects.toThrow("全部成员 cast 失败");
    expect(h.prepareCalls).toHaveLength(1);

    // 失败即回收(与 stop() 同路径)
    expect(h.bridgeStopCalls.length).toBeGreaterThan(0);
    expect(h.bridgeStopCalls[0].deviceId).toBe("a1");
    expect(isBridgeRouteActive("g1")).toBe(false);
  });

  it("回收动作自身抛错时,原始错误仍是「全部成员 cast 失败」(不许被回收异常顶替/吞掉)", async () => {
    h.groups.set("g1", { id: "g1", name: "组", memberIds: ["sendspin:sp1", "airplay:a1"] });
    h.state.bridgeStopThrowsSync = true; // teardown 内部同步抛
    const p = createGroupProtocolPlayer("g1");

    await expect(p.playMedia(ITEM, "http://base")).rejects.toThrow("全部成员 cast 失败");
    // 回收异常只 warn:不抛 "bridgeStop boom",也不留下登记
    expect(isBridgeRouteActive("g1")).toBe(false);
  });

  it("成功路径不得误拆路由(桥仍登记为活跃,且没有任何 bridgeStop)", async () => {
    h.groups.set("g1", { id: "g1", name: "组", memberIds: ["sendspin:sp1", "airplay:a1"] });
    h.state.spinPlayFail = false; // 组泵 cast 成功
    const p = createGroupProtocolPlayer("g1");

    const r = await p.playMedia(ITEM, "http://base");
    expect(r.mediaUri).toBe("spin");
    expect(h.prepareCalls).toHaveLength(1);
    expect(isBridgeRouteActive("g1")).toBe(true); // 桥照常存活
    expect(h.bridgeStopCalls).toEqual([]);        // 没有误拆
  });
});

describe("D2:bridgeJoinMember 在泵侧 sync 失败时必须回滚半挂路由", () => {
  it("sync 抛错时回滚刚加入的设备(移出路由 + bridgeStop)并把原始错误抛给调用方", async () => {
    setBridgeRoutesForTest(new Map([
      ["g1", [{ deviceId: "a0", socketPath: "/tmp/b_a0_tk0.sock", token: "tk0", protocol: "raop" }]],
    ]));

    await expect(bridgeJoinMember("g1", "a1")).rejects.toThrow("pump sync boom");
    expect(h.prepareCalls.map((c) => c.deviceId)).toEqual(["a1"]);

    // 回滚动作:摘会话 + 从路由移除(路由仍存在,但只剩原有的 a0)
    expect(h.bridgeStopCalls).toEqual([{ token: expect.any(String), deviceId: "a1" }]);

    // 再次加入应能成功 ⇒ 证明上次确实已从路由移除(没有留下「半挂」占位)
    h.state.syncThrows = false;
    await expect(bridgeJoinMember("g1", "a1")).resolves.toBe(true);
  });
});
