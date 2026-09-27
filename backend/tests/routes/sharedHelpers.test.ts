// `src/routes/api/shared.ts` 里**运行时助手**的直测。
//
// 为什么要单独写:路由层契约测试(dlna/sendspin/playlists/peers)为了驱动 catch 分支,
// 把整个 shared.js 换成了假体 —— 于是这几个真实实现反而成了零覆盖:
//   readPeerPositionSeconds / seekPeerToSeconds / dispatchPeerCommand /
//   broadcastSendspinVolume / setSendspinMemberMuted / localShuffleInfo
// 它们承载的是「流转/起播的进度对齐」与「本机定向下发」语义,值得单独锁住。
//
// 手法:不 mock shared 自身,而是 mock 它依赖的**叶子模块**;`pm` 单例用 vi.spyOn
// 直接打在真实对象上(shared.ts 内部就是引用同一个对象,spy 对它同样生效)。
import { beforeEach, describe, expect, it, vi } from "vitest";

const leaf = vi.hoisted(() => ({
  getDeviceStatus: vi.fn(),
  seekDevice: vi.fn(),
  getGroupStatus: vi.fn(),
  getAirPlayPeerStatus: vi.fn(),
  getPlayerState: vi.fn(),
  transport: vi.fn(),
  markSeekIssued: vi.fn(),
  sendToLocalPeer: vi.fn(),
  getSendspinDeviceVolume: vi.fn(),
  getSendspinFront: vi.fn(),
  saveDeviceVolumeState: vi.fn(),
}));

vi.mock("../../src/services/dlna/control.js", async (io) => ({
  ...(await io<Record<string, unknown>>()),
  getDeviceStatus: leaf.getDeviceStatus,
  seekDevice: leaf.seekDevice,
}));

vi.mock("../../src/services/group/protocolPlayer.js", async (io) => ({
  ...(await io<Record<string, unknown>>()),
  getGroupStatus: leaf.getGroupStatus,
}));

vi.mock("../../src/services/airplay/control.js", async (io) => ({
  ...(await io<Record<string, unknown>>()),
  getAirPlayPeerStatus: leaf.getAirPlayPeerStatus,
}));

vi.mock("../../src/services/player/index.js", async (io) => ({
  ...(await io<Record<string, unknown>>()),
  getQueueController: () => ({ getPlayerState: leaf.getPlayerState, transport: leaf.transport }),
}));

vi.mock("../../src/services/player/seekSettle.js", async (io) => ({
  ...(await io<Record<string, unknown>>()),
  markSeekIssued: leaf.markSeekIssued,
}));

vi.mock("../../src/services/ws/index.js", async (io) => ({
  ...(await io<Record<string, unknown>>()),
  sendToLocalPeer: leaf.sendToLocalPeer,
}));

vi.mock("../../src/services/sendspin/peerVolume.js", async (io) => ({
  ...(await io<Record<string, unknown>>()),
  getSendspinDeviceVolume: leaf.getSendspinDeviceVolume,
}));

vi.mock("../../src/services/sendspin/index.js", async (io) => ({
  ...(await io<Record<string, unknown>>()),
  getSendspinFront: leaf.getSendspinFront,
}));

vi.mock("../../src/services/sendspin/deviceState.js", async (io) => ({
  ...(await io<Record<string, unknown>>()),
  saveDeviceVolumeState: leaf.saveDeviceVolumeState,
}));

import {
  broadcastSendspinVolume,
  dispatchPeerCommand,
  finiteNumOrUndefined,
  localShuffleInfo,
  pm,
  readPeerPositionSeconds,
  seekPeerToSeconds,
  setSendspinMemberMuted,
} from "../../src/routes/api/shared.js";

type Any = any;

beforeEach(() => {
  vi.restoreAllMocks();
  for (const f of Object.values(leaf)) (f as Any).mockReset();
  leaf.getSendspinDeviceVolume.mockReturnValue({ volume: 100, muted: false });
});

// ==================== 纯函数 ====================

describe("finiteNumOrUndefined", () => {
  it("只收有限数值,其余一律 undefined(字段级合并时沿用旧值)", () => {
    expect(finiteNumOrUndefined(0)).toBe(0);
    expect(finiteNumOrUndefined(-1.5)).toBe(-1.5);
    expect(finiteNumOrUndefined(Number.NaN)).toBeUndefined();
    expect(finiteNumOrUndefined(Number.POSITIVE_INFINITY)).toBeUndefined();
    expect(finiteNumOrUndefined("5")).toBeUndefined();
    expect(finiteNumOrUndefined(null)).toBeUndefined();
    expect(finiteNumOrUndefined(undefined)).toBeUndefined();
  });
});

describe("localShuffleInfo", () => {
  it("快照字段齐全时原样透出", () => {
    expect(localShuffleInfo({
      currentIndex: 3, playMode: "shuffle", isActive: true,
      shuffleOrder: [2, 0, 1], shufflePos: 1, shuffleEpoch: 4,
    })).toEqual({
      currentIndex: 3, playMode: "shuffle", isActive: true,
      shuffleOrder: [2, 0, 1], shufflePos: 1, shuffleEpoch: 4,
    });
  });

  it("字段缺失/类型不对时逐个兜底(游标 -1、模式 order、序列空、epoch 0)", () => {
    expect(localShuffleInfo(undefined)).toEqual({
      currentIndex: -1, playMode: "order", isActive: false,
      shuffleOrder: [], shufflePos: -1, shuffleEpoch: 0,
    });
    expect(localShuffleInfo({ shuffleOrder: "not-array", shufflePos: "1", shuffleEpoch: null })).toEqual({
      currentIndex: -1, playMode: "order", isActive: false,
      shuffleOrder: [], shufflePos: -1, shuffleEpoch: 0,
    });
    // 0 是合法值,不能被 `||` 吃掉
    expect(localShuffleInfo({ currentIndex: 0, shufflePos: 0, shuffleEpoch: 0 })).toMatchObject({
      currentIndex: 0, shufflePos: 0, shuffleEpoch: 0,
    });
  });
});

// ==================== readPeerPositionSeconds ====================

describe("readPeerPositionSeconds", () => {
  it("peerId 无法解析 → null(不抛)", async () => {
    expect(await readPeerPositionSeconds("bare-id")).toBeNull();
  });

  it("dlna:取 SOAP position", async () => {
    leaf.getDeviceStatus.mockResolvedValueOnce({ position: 12.5 });
    expect(await readPeerPositionSeconds("dlna:dev1")).toBe(12.5);
    expect(leaf.getDeviceStatus).toHaveBeenCalledWith("dev1");
  });

  it("group:取组状态 position(从 leader 派生)", async () => {
    leaf.getGroupStatus.mockResolvedValueOnce({ position: 7 });
    expect(await readPeerPositionSeconds("group:g1")).toBe(7);
  });

  it("airplay:取 peer 状态 position(同步接口)", async () => {
    leaf.getAirPlayPeerStatus.mockReturnValueOnce({ position: 3 });
    expect(await readPeerPositionSeconds("airplay:ap1")).toBe(3);
  });

  it("sendspin:取控制器 PlayerState.position", async () => {
    leaf.getPlayerState.mockResolvedValueOnce({ position: 9 });
    expect(await readPeerPositionSeconds("sendspin:sc1")).toBe(9);
    expect(leaf.getPlayerState).toHaveBeenCalledWith("sc1");
  });

  it("local:取对端上报的 position(服务端只做暂存)", async () => {
    vi.spyOn(pm, "getLocalStatusReport").mockReturnValue({ position: 5 } as Any);
    expect(await readPeerPositionSeconds("local:u1")).toBe(5);
  });

  it("position 非数值/NaN → null;状态对象为 null → null", async () => {
    leaf.getDeviceStatus.mockResolvedValueOnce({ position: "12" });
    expect(await readPeerPositionSeconds("dlna:dev1")).toBeNull();
    leaf.getDeviceStatus.mockResolvedValueOnce(null);
    expect(await readPeerPositionSeconds("dlna:dev1")).toBeNull();
    leaf.getDeviceStatus.mockResolvedValueOnce({ position: Number.NaN });
    expect(await readPeerPositionSeconds("dlna:dev1")).toBeNull();
  });

  it("上游抛错被吞掉 → null(读不到进度不该让流转失败)", async () => {
    leaf.getDeviceStatus.mockRejectedValueOnce(new Error("SOAP 超时"));
    expect(await readPeerPositionSeconds("dlna:dev1")).toBeNull();
    leaf.getGroupStatus.mockRejectedValueOnce(new Error("组状态失败"));
    expect(await readPeerPositionSeconds("group:g1")).toBeNull();
    leaf.getPlayerState.mockRejectedValueOnce(new Error("推流未起"));
    expect(await readPeerPositionSeconds("sendspin:sc1")).toBeNull();
  });
});

// ==================== seekPeerToSeconds ====================

describe("seekPeerToSeconds", () => {
  it("peerId 不可解析 / 秒数非有限 / <=0 → false,且不下发", async () => {
    expect(await seekPeerToSeconds("bare", 10)).toBe(false);
    expect(await seekPeerToSeconds("dlna:dev1", Number.NaN)).toBe(false);
    expect(await seekPeerToSeconds("dlna:dev1", Number.POSITIVE_INFINITY)).toBe(false);
    expect(await seekPeerToSeconds("dlna:dev1", 0)).toBe(false);
    expect(await seekPeerToSeconds("dlna:dev1", -3)).toBe(false);
    expect(leaf.seekDevice).not.toHaveBeenCalled();
    expect(leaf.transport).not.toHaveBeenCalled();
  });

  it("dlna 直连 seek(不经 transport)", async () => {
    expect(await seekPeerToSeconds("dlna:dev1", 30)).toBe(true);
    expect(leaf.seekDevice).toHaveBeenCalledWith("dev1", 30);
    expect(leaf.transport).not.toHaveBeenCalled();
  });

  it("local 走定向下发;其余 kind 走 transport('seek')", async () => {
    expect(await seekPeerToSeconds("local:u1", 30)).toBe(true);
    expect(leaf.transport).not.toHaveBeenCalled();
    for (const p of ["group:g1", "airplay:ap1", "sendspin:sc1"]) {
      leaf.transport.mockClear();
      expect(await seekPeerToSeconds(p, 30)).toBe(true);
      expect(leaf.transport).toHaveBeenCalledWith(p.split(":")[1], "seek", 30);
    }
  });

  it("一律先打 seek 冷静期标(覆盖 DLNA 不经 transport 的直连路径)", async () => {
    await seekPeerToSeconds("dlna:dev1", 30);
    expect(leaf.markSeekIssued).toHaveBeenCalledWith("dev1");
  });

  it("下发失败 → false(调用方据此不谎报落位)", async () => {
    leaf.seekDevice.mockRejectedValueOnce(new Error("设备拒绝"));
    expect(await seekPeerToSeconds("dlna:dev1", 30)).toBe(false);
    leaf.transport.mockRejectedValueOnce(new Error("组 seek 失败"));
    expect(await seekPeerToSeconds("group:g1", 30)).toBe(false);
  });
});

// ==================== dispatchPeerCommand ====================

describe("dispatchPeerCommand", () => {
  it("web 端不再被控:即便持有历史 peerId 也不下发(delivered=false 兜底)", () => {
    vi.spyOn(pm, "get").mockReturnValue({ kind: "local", platform: "web" } as Any);
    expect(dispatchPeerCommand("local:u1", "play")).toEqual({ success: true, delivered: false });
    expect(leaf.sendToLocalPeer).not.toHaveBeenCalled();
  });

  it("本机实例有 WS 连接 → delivered=true;无连接 → false(前端据此给「离线」反馈)", () => {
    vi.spyOn(pm, "get").mockReturnValue({ kind: "local", platform: "android" } as Any);
    leaf.sendToLocalPeer.mockReturnValueOnce(1);
    expect(dispatchPeerCommand("local:u1", "play")).toEqual({ success: true, delivered: true });
    leaf.sendToLocalPeer.mockReturnValueOnce(0);
    expect(dispatchPeerCommand("local:u1", "play")).toEqual({ success: true, delivered: false });
    expect(leaf.sendToLocalPeer).toHaveBeenCalledWith("local:u1", { type: "peer_command", action: "play", payload: undefined });
  });

  it("未知 peer(未注册)→ 仍尝试下发,交付数决定 delivered", () => {
    vi.spyOn(pm, "get").mockReturnValue(undefined);
    leaf.sendToLocalPeer.mockReturnValueOnce(2);
    expect(dispatchPeerCommand("local:u9", "seek", { seconds: 5 })).toEqual({ success: true, delivered: true });
  });
});

// ==================== broadcastSendspinVolume ====================

describe("broadcastSendspinVolume", () => {
  it("非 sendspin / 不可解析 → 静默跳过(不广播)", () => {
    broadcastSendspinVolume("dlna:dev1", { volume: 10 });
    broadcastSendspinVolume("bare", { volume: 10 });
    expect(vi.spyOn(pm, "notifyPeerVolume")).toBeTruthy();
  });

  it("音量夹到 [0,100] 并取整;缺省沿用当前值", () => {
    const spy = vi.spyOn(pm, "notifyPeerVolume").mockImplementation(() => undefined);
    leaf.getSendspinDeviceVolume.mockReturnValue({ volume: 42, muted: true });

    broadcastSendspinVolume("sendspin:sc1", { volume: 130.6 });
    expect(spy).toHaveBeenLastCalledWith("sendspin:sc1", 100, true);

    broadcastSendspinVolume("sendspin:sc1", { volume: -8 });
    expect(spy).toHaveBeenLastCalledWith("sendspin:sc1", 0, true);

    broadcastSendspinVolume("sendspin:sc1", {});
    expect(spy).toHaveBeenLastCalledWith("sendspin:sc1", 42, true);

    broadcastSendspinVolume("sendspin:sc1", { muted: false });
    expect(spy).toHaveBeenLastCalledWith("sendspin:sc1", 42, false);
  });

  it("广播失败不影响写入(静默吞掉)", () => {
    vi.spyOn(pm, "notifyPeerVolume").mockImplementation(() => { throw new Error("WS 已关"); });
    expect(() => broadcastSendspinVolume("sendspin:sc1", { volume: 10 })).not.toThrow();
  });
});

// ==================== setSendspinMemberMuted ====================

describe("setSendspinMemberMuted", () => {
  it("sendspin 服务未运行 → 抛错(静音没做成不能假装成功)", async () => {
    leaf.getSendspinFront.mockReturnValue(null);
    await expect(setSendspinMemberMuted("sc1", true)).rejects.toThrow("sendspin 服务未运行");
  });

  it("组/连接双置位,并持久化 + 广播回显", async () => {
    const group = {} as Any;
    const conn = {} as Any;
    leaf.getSendspinFront.mockReturnValue({
      group: () => group,
      clients: new Map([["sc1", conn]]),
    });
    const spy = vi.spyOn(pm, "notifyPeerVolume").mockImplementation(() => undefined);

    await setSendspinMemberMuted("sc1", true);
    expect(group.muted).toBe(true);
    expect(conn.muted).toBe(true);
    expect(leaf.saveDeviceVolumeState).toHaveBeenCalledWith("sc1", { muted: true });
    expect(spy).toHaveBeenCalledWith("sendspin:sc1", expect.any(Number), true);
  });

  it("该 clientId 当前无连接 → 只置组标记(离线重连后仍生效),不报错", async () => {
    const group = {} as Any;
    leaf.getSendspinFront.mockReturnValue({ group: () => group, clients: new Map() });
    vi.spyOn(pm, "notifyPeerVolume").mockImplementation(() => undefined);
    await setSendspinMemberMuted("sc9", false);
    expect(group.muted).toBe(false);
  });

  it("持久化失败不影响本次静音(静默吞掉)", async () => {
    leaf.getSendspinFront.mockReturnValue({ group: () => ({}), clients: new Map() });
    vi.spyOn(pm, "notifyPeerVolume").mockImplementation(() => undefined);
    leaf.saveDeviceVolumeState.mockImplementation(() => { throw new Error("DB 忙"); });
    await expect(setSendspinMemberMuted("sc1", true)).resolves.toBeUndefined();
  });
});
