// v4.9.3 互斥豁免 + 桥初始音量 定向单测(fork 模式 + mock supervisor/discovery,
// 不碰真实子进程与设备):
//   ① 活跃组桥会话(组存在且设备仍是成员)→ stopAirPlaySessionsForHost 豁免
//     (不 bridgeStop、不计入 stopped、不冻结队列);
//   ② 孤儿桥会话(设备已移出/组已解散)→ bridgeStop 回收并计入 stopped,owner 清空;
//   ③ 无 owner 的 solo 会话 → 原路径:冻结队列 + stopSession(fork RPC);
//   ④ bridgePrepareDevice 透传 initialVolume 并带组归属登记 owner。
import { describe, it, expect, vi, beforeAll, beforeEach } from "vitest";

const h = vi.hoisted(() => {
  const rpcCalls: Array<{ op: string; payload: any }> = [];
  const mirrorSessions = new Set<string>();
  const groups = new Map<string, { id: string; name: string; memberIds: string[] }>();
  const frozen: string[] = [];
  const devices = [
    { id: "ap-x", name: "ap-x", host: "192.168.10.55", port: 7000, available: true },
  ];
  return { rpcCalls, mirrorSessions, groups, frozen, devices };
});

vi.mock("../../src/services/airplay/mode.js", () => ({ isAirPlayForkMode: () => true }));

vi.mock("../../src/services/airplay/supervisor.js", () => ({
  airplaySupervisor: {
    isRunning: () => true,
    mirror: { sessions: h.mirrorSessions },
    rpc: async (op: string, payload?: any) => { h.rpcCalls.push({ op, payload }); return null; },
  },
}));

vi.mock("../../src/services/airplay/discovery.js", () => ({
  getAirPlayDevices: () => h.devices,
  getAirPlayDevice: (id: string) => h.devices.find((d) => d.id === id),
  onAirPlayEvent: () => {},
  startAirPlayDiscovery: () => {},
  stopAirPlayDiscovery: () => {},
  setAirPlayPersist: () => {},
  removeAirPlayDevice: () => {},
}));

vi.mock("../../src/services/group/protocolPlayer.js", () => ({
  // control.ts 经动态 import 取用;这里按真实语义模拟:组存在且设备仍是成员才豁免。
  isGroupBridgeSessionAttached: (gid: string, dev: string) => {
    const g = h.groups.get(gid);
    return !!g && g.memberIds.includes(`airplay:${dev}`);
  },
}));

vi.mock("../../src/services/player/index.js", () => ({
  getQueueController: () => ({
    stopPlayback: (id: string) => { h.frozen.push(id); },
    snapshot: () => null,
  }),
  getPlayerController: () => ({ reportState: () => {} }),
}));

import { sqlite } from "../../src/db/index.js";
import { registerBuiltinPlugins } from "../../src/plugins/builtins.js";
import {
  stopAirPlaySessionsForHost,
  registerBridgeOwner,
  clearBridgeOwner,
  bridgeOwnerGroupOf,
  bridgePrepareDevice,
} from "../../src/services/airplay/control.js";

beforeAll(() => {
  if (!process.env.APP_VERSION) process.env.APP_VERSION = "1.0.0";
  registerBuiltinPlugins();
  sqlite.prepare("DELETE FROM settings").run();
});

beforeEach(() => {
  h.rpcCalls.length = 0;
  h.mirrorSessions.clear();
  h.groups.clear();
  h.frozen.length = 0;
  clearBridgeOwner("ap-x");
});

describe("v4.9.3 同 host DLNA 互斥:组桥会话豁免 / 孤儿回收", () => {
  it("活跃组桥会话 → 豁免:不 bridgeStop、不计入 stopped、不冻结队列", async () => {
    registerBridgeOwner("ap-x", "tok-1", "g1");
    h.groups.set("g1", { id: "g1", name: "组", memberIds: ["airplay:ap-x"] });
    h.mirrorSessions.add("ap-x");
    const stopped = await stopAirPlaySessionsForHost("192.168.10.55");
    expect(stopped).toEqual([]);
    expect(h.rpcCalls.find((r) => r.op === "bridgeStop")).toBeUndefined();
    expect(h.frozen).toEqual([]);
  });

  it("孤儿桥会话(设备已移出组)→ bridgeStop 回收并计入 stopped,owner 清空", async () => {
    registerBridgeOwner("ap-x", "tok-1", "g1");
    h.groups.set("g1", { id: "g1", name: "组", memberIds: [] });
    h.mirrorSessions.add("ap-x");
    const stopped = await stopAirPlaySessionsForHost("192.168.10.55");
    expect(stopped).toEqual(["ap-x"]);
    const stop = h.rpcCalls.find((r) => r.op === "bridgeStop");
    expect(stop?.payload?.token).toBe("tok-1");
    expect(bridgeOwnerGroupOf("ap-x")).toBeNull();
  });

  it("孤儿桥会话(组已解散)→ 同样回收", async () => {
    registerBridgeOwner("ap-x", "tok-2", "gone");
    h.mirrorSessions.add("ap-x");
    const stopped = await stopAirPlaySessionsForHost("192.168.10.55");
    expect(stopped).toEqual(["ap-x"]);
    expect(h.rpcCalls.find((r) => r.op === "bridgeStop")?.payload?.token).toBe("tok-2");
  });

  it("无 owner 的 solo 会话 → 原路径:先冻结队列再 stopSession(MAJ-06 语义不变)", async () => {
    h.mirrorSessions.add("ap-x");
    const stopped = await stopAirPlaySessionsForHost("192.168.10.55");
    expect(stopped).toEqual(["ap-x"]);
    expect(h.frozen).toEqual(["airplay:ap-x"]);
    expect(h.rpcCalls.find((r) => r.op === "stopSession")?.payload?.deviceId).toBe("ap-x");
  });
});

describe("v4.9.3 桥会话初始音量:bridgePrepare 透传组落库值", () => {
  it("initialVolume 随 bridgePrepare RPC 下发;owner 登记带组归属", async () => {
    await bridgePrepareDevice("ap-x", "tok-9", "raop", "g1", { initialVolume: 66 });
    const prep = h.rpcCalls.find((r) => r.op === "bridgePrepare");
    expect(prep).toBeDefined();
    expect(prep!.payload.initialVolume).toBe(66);
    expect(prep!.payload.anchorShiftUs).toBe(0); // 守卫钉定语义不变
    expect(bridgeOwnerGroupOf("ap-x")).toBe("g1");
  });

  it("无 opts 时 initialVolume 为 undefined(桥侧回落设备落库值,旧行为)", async () => {
    await bridgePrepareDevice("ap-x", "tok-a", "raop", null);
    const prep = h.rpcCalls.find((r) => r.op === "bridgePrepare");
    expect(prep!.payload.initialVolume).toBeUndefined();
    expect(bridgeOwnerGroupOf("ap-x")).toBeNull();
  });
});
