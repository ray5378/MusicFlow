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
  const dlnaDevices: Array<{ id: string; location: string; renderingControlUrl?: string }> = [];
  const rpcCalls: Array<{ method: string; payload: any }> = [];
  const state = {
    rpcResult: null as any,
    rpcError: null as Error | null,
    supervisorRunning: true,
    globalShiftUs: 7_777,
    groupShift: new Map<string, number>(),
    group2Shift: new Map<string, number>(),
  };
  return { devices, dlnaDevices, rpcCalls, state };
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

// exp4:control.ts 的 dlnaPeerOfAirPlay 走 dlna/control.getCachedDevices ——
// 默认空表(等价于现状),用例按需填同 host renderer 验证 payload 透传。
vi.mock("../../src/services/dlna/control.js", () => ({
  getCachedDevices: () => h.dlnaDevices,
  getEffectiveBaseUrl: () => "",
  setDeviceVolume: async () => {},
  setDeviceMute: async () => {},
  stopDevicePlayback: async () => {},
  loopbackBase: () => "",
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

describe("bridgePrepareDevice:anchorShiftUs 必须恒 0(补偿唯一落点=投递时戳)", () => {
  // 双加教训(2026-10-27):投递时戳(ts' = ts − ahead + shift)已携带全部补偿;
  // 锚点若再平移,桥内 anchorUs = 投递时戳 + 平移 = 双份 ⇒ 对齐器把多出的那份
  // 判「内容超前」整段裁掉(切歌吞 2 秒、净补偿归零)。此用例钉死恒 0。
  it("任何 groupId/协议/正负值组合 ⇒ payload.anchorShiftUs 恒 0", async () => {
    await bridgePrepareDevice("a1", "t1", "raop", "g1");
    await bridgePrepareDevice("a1", "t2", "ap2-realtime", "g1");
    await bridgePrepareDevice("a1", "t3", "raop"); // 无组上下文
    await bridgePrepareDevice("a1", "t4", "raop", "g2"); // 负值格
    for (const c of h.rpcCalls) expect(c.payload.anchorShiftUs).toBe(0);
  });
});

describe("bridgePrepareDevice:exp4 同 host DLNA renderer 载荷透传", () => {
  it("同 host 有 DLNA renderer ⇒ payload.sameHostDlnaPeer = 该 renderer id(优先带 RenderingControl)", async () => {
    h.dlnaDevices.push(
      { id: "no-rc", location: "http://192.168.1.20:49152/desc.xml" },
      { id: "with-rc", location: "http://192.168.1.20:49153/desc.xml", renderingControlUrl: "http://192.168.1.20:49153/rc" },
      { id: "other-host", location: "http://192.168.1.99:49152/desc.xml", renderingControlUrl: "http://192.168.1.99:49152/rc" },
    );
    try {
      await bridgePrepareDevice("a1", "t-peer", "raop", "g1", { settleDlna: false });
      expect(h.rpcCalls[0].payload.sameHostDlnaPeer).toBe("with-rc");
    } finally {
      h.dlnaDevices.length = 0;
    }
  });

  it("无同 host DLNA ⇒ payload.sameHostDlnaPeer = undefined(桥侧豁免不生效,照发 SET_PARAMETER)", async () => {
    await bridgePrepareDevice("a1", "t-none", "raop", "g1", { settleDlna: false });
    expect(h.rpcCalls[0].payload.sameHostDlnaPeer).toBeUndefined();
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
