// F1/F4 定向单测:群组 airplay 在线判定的 staleness 容错。
// 覆盖(240 实证背景:MUZO/HiVi 空闲期停止应答 mDNS,90s staleness 错杀在线设备):
//   ① 全部 fresh → 直接返回,不触发快速刷新;
//   ② 全部 strict 离线 → 触发 rescanAirPlayDevices(300) 一次,刷新后恢复的设备入选;
//   ③ 刷新后仍 stale 但 lastSeen < 10min → 容错按在线进桥(桥握手预算兜底);
//   ④ lastSeen ≥ 10min(真离线)→ 照旧剔除,不拖慢起播;
//   ⑤ F4:桥 owner(isBridgeOwned)豁免 staleness;
//   ⑥ F4:活跃投屏会话(hasActiveSession)豁免 staleness;
//   ⑦ disabled 设备一律剔除;无 airplay 成员 → 空数组且不刷新。
import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => {
  const groups = new Map<string, { id: string; name: string; memberIds: string[] }>();
  const devices = new Map<string, { id: string; lastSeen: number; available: boolean }>();
  const avail = new Map<string, boolean>();
  const disabled = new Set<string>();
  const bridgeOwned = new Set<string>();
  const activeSession = new Set<string>();
  const refreshes: number[] = [];
  let refreshHelps = false;
  return {
    groups, devices, avail, disabled, bridgeOwned, activeSession, refreshes,
    setRefreshHelps(v: boolean) { refreshHelps = v; },
    reset() {
      groups.clear(); devices.clear(); avail.clear(); disabled.clear();
      bridgeOwned.clear(); activeSession.clear(); refreshes.length = 0; refreshHelps = false;
    },
  };
});

vi.mock("../../src/services/group/index.js", async (importOriginal) => {
  const actual = await importOriginal<any>();
  return {
    ...actual,
    getGroupManager: () => ({
      get: (id: string) => h.groups.get(id),
      getVolume: () => 44,
    }),
  };
});

vi.mock("../../src/services/airplay/control.js", () => ({
  getAirPlayStatus: (id: string) => ({ available: h.avail.get(id) ?? false }),
  isAirPlayDeviceDisabled: (id: string) => h.disabled.has(id),
  isBridgeOwned: (id: string) => h.bridgeOwned.has(id),
  hasActiveSession: (id: string) => h.activeSession.has(id),
  isAirplayBridgeEnabled: () => true,
  selectAirPlayBridgeProtocol: () => "raop" as const,
  bridgePrepareDevice: async () => ({ listening: true as const, socketPath: "/tmp/x.sock" }),
  bridgeStopDevice: async () => {},
}));

vi.mock("../../src/services/airplay/discovery.js", () => ({
  getAirPlayDevice: (id: string) => h.devices.get(id),
  rescanAirPlayDevices: async (ms: number) => {
    h.refreshes.push(ms);
    // 模拟 mDNS 应答:refreshHelps=true 时把所有设备标为刚被看见且 available。
    if (h.refreshHelps) {
      const now = Date.now();
      for (const d of h.devices.values()) { d.lastSeen = now; }
      for (const k of h.avail.keys()) h.avail.set(k, true);
    }
  },
}));

vi.mock("../../src/services/dlna/control.js", () => ({
  createDlnaProtocolPlayer: () => { throw new Error("not reached"); },
  getDevice: () => undefined,
  getDeviceStatus: async () => ({ state: "STOPPED" }),
  isDeviceAvailable: () => false,
}));
vi.mock("../../src/services/airplay/protocolPlayer.js", () => ({
  createAirPlayProtocolPlayer: () => { throw new Error("not reached"); },
}));
vi.mock("../../src/services/airplay/bridgeChannel.js", () => ({
  bridgeSocketPath: (d: string, t: string) => `/tmp/b_${d}_${t}.sock`,
}));
vi.mock("../../src/services/sendspin/index.js", () => ({
  getSendspinFront: () => null,
}));
vi.mock("../../src/services/sendspin/playerCore.js", () => ({
  sendspinGroupName: (gid: string) => `ug:${gid}`,
}));
vi.mock("../../src/services/airplay/supervisor.js", () => ({
  airplaySupervisor: { isRunning: () => false, rpc: async () => null },
}));
vi.mock("../../src/services/player/index.js", () => ({
  getQueueController: () => ({ stopPlayback: () => {}, snapshot: () => null }),
  getPlayerController: () => ({ reportState: () => {} }),
}));

import {
  getOnlineAirplayIdsTolerant,
  AIRPLAY_STALE_TOLERANT_MS,
} from "../../src/services/group/protocolPlayer.js";

const GID = "g-f1";
const MIN = 60 * 1000;

function seedGroup(memberIds: string[]): void {
  h.groups.set(GID, { id: GID, name: "t", memberIds });
}

beforeEach(() => {
  h.reset();
});

describe("getOnlineAirplayIdsTolerant(F1/F4)", () => {
  it("① 全部 fresh → 直接返回,不触发快速刷新", async () => {
    seedGroup(["airplay:apA", "airplay:apB"]);
    h.avail.set("apA", true);
    h.avail.set("apB", true);
    const r = await getOnlineAirplayIdsTolerant(GID);
    expect(r).toEqual(["apA", "apB"]);
    expect(h.refreshes).toEqual([]);
  });

  it("② 全部 strict 离线 → 触发一次 rescanAirPlayDevices(300),刷新后恢复的设备入选", async () => {
    seedGroup(["airplay:apA", "airplay:apB"]);
    h.avail.set("apA", false);
    h.avail.set("apB", false);
    h.devices.set("apA", { id: "apA", lastSeen: Date.now() - 2 * MIN, available: false });
    h.devices.set("apB", { id: "apB", lastSeen: Date.now() - 2 * MIN, available: false });
    h.setRefreshHelps(true); // 模拟 apA/apB 应答了这次 mDNS 查询
    const r = await getOnlineAirplayIdsTolerant(GID);
    expect(h.refreshes).toEqual([300]);
    expect(r).toEqual(["apA", "apB"]);
  });

  it("③ 刷新无应答但 lastSeen 5min → 容错按在线进桥", async () => {
    seedGroup(["airplay:apA"]);
    h.avail.set("apA", false);
    h.devices.set("apA", { id: "apA", lastSeen: Date.now() - 5 * MIN, available: false });
    const r = await getOnlineAirplayIdsTolerant(GID);
    expect(h.refreshes).toEqual([300]);
    expect(r).toEqual(["apA"]);
  });

  it("④ lastSeen ≥ 10min(真离线)→ 照旧剔除,不拖慢起播", async () => {
    seedGroup(["airplay:apA"]);
    h.avail.set("apA", false);
    h.devices.set("apA", { id: "apA", lastSeen: Date.now() - (AIRPLAY_STALE_TOLERANT_MS + MIN), available: false });
    const r = await getOnlineAirplayIdsTolerant(GID);
    expect(r).toEqual([]);
  });

  it("⑤ F4:桥 owner 设备豁免 staleness(旧 lastSeen 也入选)", async () => {
    seedGroup(["airplay:apA"]);
    h.avail.set("apA", false);
    h.devices.set("apA", { id: "apA", lastSeen: Date.now() - 30 * MIN, available: false });
    h.bridgeOwned.add("apA");
    const r = await getOnlineAirplayIdsTolerant(GID);
    expect(r).toEqual(["apA"]);
  });

  it("⑥ F4:活跃投屏会话设备豁免 staleness", async () => {
    seedGroup(["airplay:apA"]);
    h.avail.set("apA", false);
    h.devices.set("apA", { id: "apA", lastSeen: Date.now() - 30 * MIN, available: false });
    h.activeSession.add("apA");
    const r = await getOnlineAirplayIdsTolerant(GID);
    expect(r).toEqual(["apA"]);
  });

  it("⑦ disabled 设备一律剔除;无 airplay 成员 → 空数组且不刷新", async () => {
    // 混合组:apB fresh 在线保证不触发刷新;apA disabled 且 fresh 仍被剔除
    seedGroup(["airplay:apA", "airplay:apB"]);
    h.avail.set("apA", true);
    h.avail.set("apB", true);
    h.disabled.add("apA");
    expect(await getOnlineAirplayIdsTolerant(GID)).toEqual(["apB"]);
    expect(h.refreshes).toEqual([]);

    seedGroup(["sendspin:sp1"]);
    expect(await getOnlineAirplayIdsTolerant(GID)).toEqual([]);
    expect(h.refreshes).toEqual([]);
  });
});
