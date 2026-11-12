// 2026-11-12 回归:设备上线补桥(mDNS alive → notifyAirplayDeviceOnline)。
//
// 现场(240 容器):容器重启后 mDNS 尚未回填,持久化设备行 lastSeen 还是上一进程的旧值
// (实测 8.5h)→ 组起播时 getOnlineAirplayIdsTolerant 判离线 ⇒ 整条流没有桥 ⇒ HiVi 首曲
// 整首静默;设备约 20s 后才被 mDNS 发现,旧实现没有任何「上线补桥」路径,只能等下一首
// playMedia(第二首)才出声。修复后 alive 事件会给**正在播放**的组补挂桥。
//
// ⚠️ activeBridgeRoutes 是 protocolPlayer 的模块级状态,用例间不自动清空 ⇒ 每个用例
// 用**独立 deviceId**(vitest 允许 shuffle,不能依赖用例顺序)。
import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => {
  const groups = new Map<string, { id: string; name: string; memberIds: string[] }>();
  const prepares: Array<{ deviceId: string; token: string; protocol: string; groupId: string | null }> = [];
  const syncs: Array<{ group: string; devices: string[] }> = [];
  let queue: { isActive: boolean; currentIndex: number } | null = { isActive: true, currentIndex: 0 };
  let paused = false;
  let prepareFails = false;
  return {
    groups, prepares, syncs,
    setQueue(q: typeof queue) { queue = q; },
    setPaused(v: boolean) { paused = v; },
    setPrepareFails(v: boolean) { prepareFails = v; },
    getQueue() { return queue; },
    isPaused() { return paused; },
    prepareFailsNow() { return prepareFails; },
    reset() {
      groups.clear();
      prepares.length = 0;
      syncs.length = 0;
      queue = { isActive: true, currentIndex: 0 };
      paused = false;
      prepareFails = false;
    },
  };
});

vi.mock("../../src/services/group/index.js", async (importOriginal) => {
  const actual = await importOriginal<any>();
  return {
    ...actual,
    getGroupManager: () => ({
      get: (id: string) => h.groups.get(id),
      list: () => [...h.groups.values()],
      getVolume: () => 44,
    }),
  };
});

vi.mock("../../src/services/airplay/control.js", () => ({
  getAirPlayStatus: () => ({ available: true }),
  isAirPlayDeviceDisabled: () => false,
  isBridgeOwned: () => false,
  hasActiveSession: () => false,
  isAirplayBridgeEnabled: () => true,
  selectAirPlayBridgeProtocol: () => "raop" as const,
  bridgePrepareDevice: async (deviceId: string, token: string, protocol: string, groupId: string | null) => {
    h.prepares.push({ deviceId, token, protocol, groupId });
    if (h.prepareFailsNow()) throw new Error("ECONNREFUSED");
    return { listening: true as const, socketPath: `/tmp/b_${deviceId}.sock` };
  },
  bridgeStopDevice: async () => {},
  bridgeManualDevice: async () => {},
}));

vi.mock("../../src/services/airplay/discovery.js", () => ({
  getAirPlayDevice: () => undefined,
  rescanAirPlayDevices: async () => {},
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
  sendspinGroupPoll: async () => ({
    playing: !h.isPaused(),
    paused: h.isPaused(),
    positionMs: 1000,
    durationMs: 200000,
    buffering: false,
  }),
  sendspinGroupBridgeSync: async (group: string, sockets: Array<{ deviceId: string }>) => {
    h.syncs.push({ group, devices: sockets.map((s) => s.deviceId) });
    return { synced: sockets.length, backfilled: 120, confirmed: true };
  },
}));
vi.mock("../../src/services/sendspin/playerCore.js", () => ({
  sendspinGroupName: (gid: string) => `ug:${gid}`,
}));
vi.mock("../../src/services/airplay/supervisor.js", () => ({
  airplaySupervisor: { isRunning: () => false, rpc: async () => null },
}));
vi.mock("../../src/services/player/index.js", () => ({
  getQueueController: () => ({ snapshot: () => h.getQueue() }),
  getPlayerController: () => ({ reportState: () => {} }),
}));

import { notifyAirplayDeviceOnline } from "../../src/services/group/protocolPlayer.js";

const GID = "g-up";

function seed(members: string[]): void {
  h.groups.set(GID, { id: GID, name: "t", memberIds: members });
}

beforeEach(() => {
  h.reset();
});

describe("notifyAirplayDeviceOnline(设备上线补桥)", () => {
  it("① 正在播放的组 + 起播时无路由 → prepare 一次并 sync 到组泵", async () => {
    const AP = "AP-1";
    seed(["sendspin:sp1", `airplay:${AP}`]);
    expect(await notifyAirplayDeviceOnline(AP)).toBe(1);
    expect(h.prepares).toHaveLength(1);
    expect(h.prepares[0]).toMatchObject({ deviceId: AP, protocol: "raop", groupId: GID });
    // 路由是模块级状态(同文件 shuffle 时可能已有别的用例设备) ⇒ 只断言「本次设备被同步进组泵」。
    expect(h.syncs).toHaveLength(1);
    expect(h.syncs[0].group).toBe(`ug:${GID}`);
    expect(h.syncs[0].devices).toContain(AP);
  });

  it("② 幂等:重复 alive(AP2 能力翻动等)不重复建桥", async () => {
    const AP = "AP-2";
    seed([`airplay:${AP}`]);
    expect(await notifyAirplayDeviceOnline(AP)).toBe(1);
    expect(await notifyAirplayDeviceOnline(AP)).toBe(0);
    expect(h.prepares).toHaveLength(1);
  });

  it("③ 队列未激活(空闲组)→ 不挂孤儿桥", async () => {
    const AP = "AP-3";
    seed([`airplay:${AP}`]);
    h.setQueue({ isActive: false, currentIndex: 0 });
    expect(await notifyAirplayDeviceOnline(AP)).toBe(0);
    expect(h.prepares).toHaveLength(0);
  });

  it("④ 组泵暂停中 → 不补(交给 resume 的 ensureBridgeRouteOnResume)", async () => {
    const AP = "AP-4";
    seed([`airplay:${AP}`]);
    h.setPaused(true);
    expect(await notifyAirplayDeviceOnline(AP)).toBe(0);
    expect(h.prepares).toHaveLength(0);
  });

  it("⑤ 设备不是该组成员 → 零动作", async () => {
    const AP = "AP-5";
    seed(["sendspin:sp1"]);
    expect(await notifyAirplayDeviceOnline(AP)).toBe(0);
    expect(h.prepares).toHaveLength(0);
  });

  it("⑥ prepare 失败 → 返回 0;下一次 alive 仍会重新尝试(空路由不残留)", async () => {
    const AP = "AP-6";
    seed([`airplay:${AP}`]);
    h.setPrepareFails(true);
    expect(await notifyAirplayDeviceOnline(AP)).toBe(0);
    h.setPrepareFails(false);
    expect(await notifyAirplayDeviceOnline(AP)).toBe(1);
    expect(h.prepares).toHaveLength(2);
  });
});
