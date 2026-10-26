// airplay/control.ts 桥编排段定向单测:bridgePrepareDevice 的 anchorShiftUs 取值面
// + 桥 owner 登记/清理 + 桥总开关。
//
// 为什么补这份(基线 control.ts 90.54% 行 / 77.31% 分支,未覆盖段集中在桥编排):
//   ① anchorShiftUs 必须**有 groupId 时取按组值**,无 groupId 时回落全局旧值 ——
//      取错方向的后果是整组 A/V 恒定偏移(用户调了延迟补偿却不生效 / 生效到别的组);
//   ② owner 登记是 native cast 与桥会话互斥的唯一事实源:prepare 成功才登记,
//      rpc 失败绝不能留下 owner(否则该设备之后所有 native cast 被拒);
//   ③ bridgeStopDevice 必须在 supervisor 未运行时也能清 owner(否则重启后设备被永久占用)。
// 全部 mock:不 fork 子进程、不连设备(airplaySupervisor / discovery / delayCalib 全替)。
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const h = vi.hoisted(() => {
  const devices: Record<string, any> = {};
  const rpcCalls: Array<{ method: string; payload: any }> = [];
  const state = {
    rpcResult: null as any,
    rpcError: null as Error | null,
    supervisorRunning: true,
    globalShiftUs: 7_777,
    groupShift: new Map<string, number>(),
    group2Shift: new Map<string, number>(),
  };
  return { devices, rpcCalls, state };
});

vi.mock("../../src/services/airplay/discovery.js", () => ({
  getAirPlayDevice: (id: string) => h.devices[id],
  getAirPlayDevices: () => Object.values(h.devices),
  onAirPlayEvent: () => {},
  startAirPlayDiscovery: async () => {},
  stopAirPlayDiscovery: () => {},
  setAirPlayPersist: () => {},
  removeAirPlayDevice: () => {},
}));

vi.mock("../../src/services/airplay/supervisor.js", () => ({
  airplaySupervisor: {
    isRunning: () => h.state.supervisorRunning,
    mirror: { sessions: new Map() },
    rpc: async (method: string, payload: any) => {
      h.rpcCalls.push({ method, payload });
      if (h.state.rpcError) throw h.state.rpcError;
      return h.state.rpcResult;
    },
  },
}));

vi.mock("../../src/services/airplay/bridgeCalib.js", () => ({
  getBridgeAvShiftUs: () => h.state.globalShiftUs,
  setBridgeAvShiftUs: () => {},
  DEFAULT_BRIDGE_AV_SHIFT_US: 0,
}));

vi.mock("../../src/services/group/delayCalib.js", () => ({
  airplayDelayUsOf: (groupId: string | null | undefined) =>
    (groupId && h.state.groupShift.get(groupId)) || 0,
  airplay2DelayUsOf: (groupId: string | null | undefined) =>
    (groupId && h.state.group2Shift.get(groupId)) || 0,
  getGroupDelays: () => ({ airplayMs: 0, airplay2Ms: 0, sendspinMs: 0 }),
}));

import {
  bridgePrepareDevice,
  bridgeStopDevice,
  clearBridgeOwner,
  isAirplayBridgeEnabled,
  isBridgeOwned,
  registerBridgeOwner,
} from "../../src/services/airplay/control.js";
import { bridgeSocketPath } from "../../src/services/airplay/bridgeChannel.js";

beforeEach(() => {
  for (const k of Object.keys(h.devices)) delete h.devices[k];
  h.rpcCalls.length = 0;
  h.state.rpcError = null;
  h.state.supervisorRunning = true;
  h.state.globalShiftUs = 7_777;
  h.state.groupShift = new Map([["g1", 123_000], ["g2", -45_000], ["g-zero", 0]]);
  h.state.group2Shift = new Map([["g1", 66_000], ["g2", -77_000], ["g-zero", 0]]);
  h.state.rpcResult = { listening: true, socketPath: "/tmp/mf-ab.sock" };
  h.devices.a1 = { id: "a1", name: "客厅", host: "192.168.1.20", port: 7000, pk: "PK1", et: "0,1", available: true };
  clearBridgeOwner("a1");
  vi.clearAllMocks();
});

afterEach(() => {
  clearBridgeOwner("a1");
  delete process.env.MUSICFLOW_AIRPLAY_BRIDGE;
});

describe("bridgePrepareDevice:anchorShiftUs 取值面", () => {
  it("有 groupId → 取**按组**补偿(用户逐组调的值必须生效)", async () => {
    await bridgePrepareDevice("a1", "token-1", "raop", "g1");
    const payload = h.rpcCalls[0].payload;
    expect(h.rpcCalls[0].method).toBe("bridgePrepare");
    expect(payload.anchorShiftUs).toBe(123_000);
    expect(payload.anchorShiftUs).not.toBe(h.state.globalShiftUs);
  });

  it("无 groupId → 回落全局 bridge.avShiftMs(历史行为不变)", async () => {
    await bridgePrepareDevice("a1", "token-2", "raop");
    expect(h.rpcCalls[0].payload.anchorShiftUs).toBe(7_777);
  });

  it("groupId 为 null / 空串 → 同样回落全局值(路由层可能传空)", async () => {
    await bridgePrepareDevice("a1", "token-3", "raop", null);
    await bridgePrepareDevice("a1", "token-4", "raop", "");
    expect(h.rpcCalls.map((c) => c.payload.anchorShiftUs)).toEqual([7_777, 7_777]);
  });

  it("按组值为 0 时用 0(不能被 `||` 语义吞掉回落到全局值)", async () => {
    await bridgePrepareDevice("a1", "token-5", "raop", "g-zero");
    expect(h.rpcCalls[0].payload.anchorShiftUs).toBe(0);
  });

  it("负补偿(该侧更早出声)原样下发", async () => {
    await bridgePrepareDevice("a1", "token-6", "raop", "g2");
    expect(h.rpcCalls[0].payload.anchorShiftUs).toBe(-45_000);
  });
});

describe("bridgePrepareDevice:anchorShiftUs 按成员协议分格(AP1 / AP2 互不干扰)", () => {
  it("协议 ap2-realtime → 读 airplay2 格(同一 groupId 下与 AP1 值可以完全不同)", async () => {
    await bridgePrepareDevice("a1", "token-ap2", "ap2-realtime", "g1");
    expect(h.rpcCalls[0].payload.anchorShiftUs).toBe(66_000);
    expect(h.rpcCalls[0].payload.anchorShiftUs).not.toBe(123_000);
  });

  it("协议 raop → 仍读 airplay 格(新增第三格不得改写 AP1 成员的既有取值)", async () => {
    await bridgePrepareDevice("a1", "token-ap1", "raop", "g1");
    expect(h.rpcCalls[0].payload.anchorShiftUs).toBe(123_000);
  });

  it("同一组两台成员协议不同 → 各取各的格(混合组的落点本来就不是一个数)", async () => {
    await bridgePrepareDevice("a1", "t-1", "raop", "g1");
    await bridgePrepareDevice("a1", "t-2", "ap2-realtime", "g1");
    expect(h.rpcCalls.map((c) => c.payload.anchorShiftUs)).toEqual([123_000, 66_000]);
  });

  it("负的 AP2 补偿原样下发(该侧更早出声)", async () => {
    await bridgePrepareDevice("a1", "token-ap2-neg", "ap2-realtime", "g2");
    expect(h.rpcCalls[0].payload.anchorShiftUs).toBe(-77_000);
  });

  it("AP2 成员但无组上下文 → 仍回落全局旧值(solo cast 不读按组格)", async () => {
    await bridgePrepareDevice("a1", "token-ap2-solo", "ap2-realtime");
    expect(h.rpcCalls[0].payload.anchorShiftUs).toBe(7_777);
  });
});

describe("bridgePrepareDevice:参数与 owner 登记", () => {
  it("设备档案(host/port/pk/et)与 socketPath/token/protocol 一并下发", async () => {
    await bridgePrepareDevice("a1", "token-x", "ap2-realtime", "g1");
    const payload = h.rpcCalls[0].payload;
    expect(payload).toMatchObject({
      deviceId: "a1",
      token: "token-x",
      protocol: "ap2-realtime",
      host: "192.168.1.20",
      port: 7000,
      pk: "PK1",
      et: "0,1",
      socketPath: bridgeSocketPath("a1", "token-x"),
    });
  });

  it("设备不存在 → 抛错且不动 owner / 不发 RPC", async () => {
    await expect(bridgePrepareDevice("ghost", "token-9", "raop")).rejects.toThrow("AirPlay 设备不存在");
    expect(h.rpcCalls).toHaveLength(0);
    expect(isBridgeOwned("ghost")).toBe(false);
  });

  it("prepare 成功才登记 owner(桥会话与 native cast 互斥的事实源)", async () => {
    await bridgePrepareDevice("a1", "token-ok", "raop");
    expect(isBridgeOwned("a1")).toBe(true);
  });

  it("prepare RPC 失败 → 错误上抛且**不登记** owner(否则该设备 native cast 被永久拒)", async () => {
    h.state.rpcError = new Error("bridgePrepare timeout");
    await expect(bridgePrepareDevice("a1", "token-bad", "raop")).rejects.toThrow("bridgePrepare timeout");
    expect(isBridgeOwned("a1")).toBe(false);
  });
});

describe("bridgeStopDevice 与 owner 基本语义", () => {
  it("bridgeStopDevice(token, deviceId) → 清 owner 并发 bridgeStop RPC", async () => {
    registerBridgeOwner("a1", "token-s");
    await bridgeStopDevice("token-s", "a1");
    expect(isBridgeOwned("a1")).toBe(false);
    expect(h.rpcCalls).toEqual([{ method: "bridgeStop", payload: { token: "token-s" } }]);
  });

  it("bridgeStopDevice 不带 deviceId → 仍下调 RPC(owner 由调用方管)", async () => {
    registerBridgeOwner("a1", "token-s2");
    await bridgeStopDevice("token-s2");
    expect(h.rpcCalls).toHaveLength(1);
    expect(isBridgeOwned("a1")).toBe(true); // 未传 deviceId 就不清(交给显式 clear)
  });

  it("supervisor 未运行 → 不 RPC 也不抛(重启后仍能清 owner)", async () => {
    h.state.supervisorRunning = false;
    registerBridgeOwner("a1", "token-s3");
    await expect(bridgeStopDevice("token-s3", "a1")).resolves.toBeUndefined();
    expect(h.rpcCalls).toHaveLength(0);
    expect(isBridgeOwned("a1")).toBe(false);
  });

  it("bridgeStop RPC 抛错 → 吞掉(子进程没跑=本来就没会话)", async () => {
    h.state.rpcError = new Error("rpc dead");
    registerBridgeOwner("a1", "token-s4");
    await expect(bridgeStopDevice("token-s4", "a1")).resolves.toBeUndefined();
    expect(isBridgeOwned("a1")).toBe(false);
  });

  it("registerBridgeOwner 覆盖旧 token;clearBridgeOwner 幂等", () => {
    registerBridgeOwner("a1", "t-old");
    registerBridgeOwner("a1", "t-new");
    expect(isBridgeOwned("a1")).toBe(true);
    clearBridgeOwner("a1");
    clearBridgeOwner("a1"); // 再清不抛
    expect(isBridgeOwned("a1")).toBe(false);
  });
});

describe("桥总开关(MUSICFLOW_AIRPLAY_BRIDGE)", () => {
  it("未设置 → 默认开启(生产默认走桥)", () => {
    delete process.env.MUSICFLOW_AIRPLAY_BRIDGE;
    expect(isAirplayBridgeEnabled()).toBe(true);
  });

  it("显式 0 → 关闭(整条桥路径完全不激活)", () => {
    process.env.MUSICFLOW_AIRPLAY_BRIDGE = "0";
    expect(isAirplayBridgeEnabled()).toBe(false);
  });

  it("显式 1/其它值 → 保持开启(只有 '0' 才关)", () => {
    process.env.MUSICFLOW_AIRPLAY_BRIDGE = "1";
    expect(isAirplayBridgeEnabled()).toBe(true);
    process.env.MUSICFLOW_AIRPLAY_BRIDGE = "false";
    expect(isAirplayBridgeEnabled()).toBe(true);
  });
});
