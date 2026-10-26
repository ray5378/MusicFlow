// #4 BridgeMember post-stop reconnect leak 修复配套单测:
//   1) 空组回收必须清桥(改法2;守卫 ⑩ 终态白名单②的行为面);
//   2) bridgeLeaveMember 泵侧 sync 未确认 → 推迟 bridgeStopDevice(改法3,不产生单侧孤儿);
//   3) 桥路由对账器(改法4):孤儿首见只登记,超宽限摘除;登记内设备不动。
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { BridgeSocketSpec } from "../../src/services/sendspin/bridgeAttach.js";

const h = vi.hoisted(() => ({
  clearGroupBridges: vi.fn(),
  stopGroupPump: vi.fn(),
  bridgeStopDevice: vi.fn(),
  bridgeSync: vi.fn(),
  spinStatus: vi.fn(),
  spinDetach: vi.fn(),
}));

vi.mock("../../src/services/sendspin/bridgeAttach.js", async (importActual) => {
  const actual = await importActual<typeof import("../../src/services/sendspin/bridgeAttach.js")>();
  return { ...actual, clearGroupBridges: h.clearGroupBridges };
});
vi.mock("../../src/services/sendspin/streamEngine.js", async (importActual) => {
  const actual = await importActual<typeof import("../../src/services/sendspin/streamEngine.js")>();
  return { ...actual, stopGroupPump: h.stopGroupPump };
});
vi.mock("../../src/services/airplay/control.js", async (importActual) => {
  const actual = await importActual<typeof import("../../src/services/airplay/control.js")>();
  return { ...actual, bridgeStopDevice: h.bridgeStopDevice };
});
vi.mock("../../src/services/sendspin/index.js", () => ({
  getSendspinFront: () => null,
  sendspinGroupBridgeSync: h.bridgeSync,
  sendspinBridgeStatus: h.spinStatus,
  sendspinBridgeDetach: h.spinDetach,
}));

import { SendspinServer } from "../../src/services/sendspin/server.js";
import {
  bridgeLeaveMember,
  reconcileBridgeRoutesOnce,
  setBridgeRoutesForTest,
  resetBridgeRouteReconcilerForTest,
} from "../../src/services/group/protocolPlayer.js";

const ROUTE: [string, BridgeSocketSpec[]][] = [
  ["g1", [{ deviceId: "devA", socketPath: "/tmp/mock.bridge.sock", token: "t1", protocol: "raop" }]],
];

beforeEach(() => {
  vi.clearAllMocks();
  resetBridgeRouteReconcilerForTest();
});
afterEach(() => {
  resetBridgeRouteReconcilerForTest();
  vi.useRealTimers();
});

describe("改法2:空组回收必须清桥", () => {
  it("onConnectionClosed 的 g.empty 分支调 clearGroupBridges 且组出注册表", () => {
    const g: Record<string, unknown> = {
      name: "ug:g1",
      empty: true,
      remove: vi.fn(),
      close: vi.fn(() => 1),
    };
    const conn: Record<string, unknown> = { clientId: "c1", group: g };
    const srv = Object.create(SendspinServer.prototype) as Record<string, any>;
    srv.clients = new Map([["c1", conn]]);
    srv.groups = new Map([["ug:g1", g]]);
    srv.log = vi.fn();
    (SendspinServer.prototype as unknown as { onConnectionClosed: (c: unknown) => void })
      .onConnectionClosed.call(srv, conn);
    expect(h.clearGroupBridges).toHaveBeenCalledWith(g);
    expect(h.stopGroupPump).toHaveBeenCalledWith(g);
    expect(g.close).toHaveBeenCalled();
    expect((srv.groups as Map<string, unknown>).has("ug:g1")).toBe(false);
    expect(conn.group).toBeNull();
  });
});

describe("改法3:bridgeLeaveMember 泵侧未确认不拆 sock", () => {
  it("sync 未确认(confirmed=false)→ 推迟 bridgeStopDevice", async () => {
    h.bridgeSync.mockResolvedValue({ synced: 0, backfilled: 0, confirmed: false });
    setBridgeRoutesForTest(new Map(ROUTE));
    const r = await bridgeLeaveMember("g1", "devA");
    expect(r).toBe(true);
    expect(h.bridgeStopDevice).not.toHaveBeenCalled();
  });

  it("sync 抛错 → 同样推迟(不产生单侧孤儿)", async () => {
    h.bridgeSync.mockRejectedValue(new Error("supervisor down"));
    setBridgeRoutesForTest(new Map(ROUTE));
    const r = await bridgeLeaveMember("g1", "devA");
    expect(r).toBe(true);
    expect(h.bridgeStopDevice).not.toHaveBeenCalled();
  });

  it("sync 确认摘除 → 照常 bridgeStopDevice", async () => {
    h.bridgeSync.mockResolvedValue({ synced: 1, backfilled: 0, confirmed: true });
    setBridgeRoutesForTest(new Map(ROUTE));
    const r = await bridgeLeaveMember("g1", "devA");
    expect(r).toBe(true);
    expect(h.bridgeStopDevice).toHaveBeenCalledWith("t1", "devA");
  });
});

describe("改法4:桥路由对账器", () => {
  it("泵侧孤儿首见只登记,超宽限摘除;登记内设备不动", async () => {
    vi.useFakeTimers();
    setBridgeRoutesForTest(new Map(ROUTE));
    h.spinStatus.mockResolvedValue([
      { group: "ug:orphan", deviceId: "ghost", generation: null, state: "stalled" },
    ]);
    h.spinDetach.mockResolvedValue(true);
    await reconcileBridgeRoutesOnce();
    expect(h.spinDetach).not.toHaveBeenCalled(); // 首见 → 只登记
    vi.setSystemTime(new Date(Date.now() + 61_000));
    await reconcileBridgeRoutesOnce();
    expect(h.spinDetach).toHaveBeenCalledWith("ug:orphan", "ghost");
    // 登记内设备不得被摘
    h.spinStatus.mockResolvedValue([
      { group: "ug:g1", deviceId: "devA", generation: null, state: "live" },
    ]);
    await reconcileBridgeRoutesOnce();
    expect(h.spinDetach).toHaveBeenCalledTimes(1);
  });
});
