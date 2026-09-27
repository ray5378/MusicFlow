// services/dlna/announce.ts 服务层契约测试。
//
// 播报(announcement)的编排语义:保存现场 → 冻结队列 → 调播报音量 → 播 → 等播完
// → 还原音量 → 恢复原曲(含 seek 回原进度)。
//
// 这些分支几乎无法用真机稳定触发 —— 要真让某台设备 description 掉线、真要挂一台
// 不响应的成员、要真把音量设失败、要真让 TTS 外链播完超时。于是把 control /
// player / group / airplay / sendspin 五个依赖全部换成 vi.fn(),只验证编排本身:
// 并发保护、调用顺序与参数、"部分设备失败"下的降级、以及原曲恢复的边界。
import "../plugins/_env.js";

import { describe, it, expect, beforeEach, vi } from "vitest";

type Any = any;

// vi.mock 工厂会被提升到 import 之前,不能闭包引用外层变量 —— 用 vi.hoisted 造句柄。
const f = vi.hoisted(() => ({
  // dlna/control
  getDevice: vi.fn(),
  getDeviceStatus: vi.fn(),
  setDeviceVolume: vi.fn(),
  playUriOnDevice: vi.fn(),
  waitUntilStopped: vi.fn(),
  getEffectiveBaseUrl: vi.fn(),
  // player / group
  getQueueController: vi.fn(),
  getGroupManager: vi.fn(),
  // airplay/control
  getAirPlayStatus: vi.fn(),
  setAirPlayVolume: vi.fn(),
  castToAirPlayDevice: vi.fn(),
  // sendspin
  isForkMode: vi.fn(),
  supervisorIsRunning: vi.fn(),
  supervisorRpc: vi.fn(),
  getSendspinServer: vi.fn(),
  announceProbeCore: vi.fn(),
  announceCore: vi.fn(),
}));

vi.mock("../../src/services/dlna/control.js", () => ({
  getDevice: f.getDevice,
  getDeviceStatus: f.getDeviceStatus,
  setDeviceVolume: f.setDeviceVolume,
  playUriOnDevice: f.playUriOnDevice,
  waitUntilStopped: f.waitUntilStopped,
  getEffectiveBaseUrl: f.getEffectiveBaseUrl,
}));

vi.mock("../../src/services/player/index.js", () => ({
  getQueueController: f.getQueueController,
}));

vi.mock("../../src/services/group/index.js", () => ({
  getGroupManager: f.getGroupManager,
}));

vi.mock("../../src/services/airplay/control.js", () => ({
  getAirPlayStatus: f.getAirPlayStatus,
  setAirPlayVolume: f.setAirPlayVolume,
  castToAirPlayDevice: f.castToAirPlayDevice,
}));

vi.mock("../../src/services/sendspin/mode.js", () => ({
  isForkMode: f.isForkMode,
}));

vi.mock("../../src/services/sendspin/supervisor.js", () => ({
  sendspinSupervisor: { isRunning: f.supervisorIsRunning, rpc: f.supervisorRpc },
}));

vi.mock("../../src/services/sendspin/index.js", () => ({
  getSendspinServer: f.getSendspinServer,
}));

vi.mock("../../src/services/sendspin/playerCore.js", () => ({
  announceProbeCore: f.announceProbeCore,
  announceCore: f.announceCore,
}));

import { announceOnPeer, isAnnouncing } from "../../src/services/dlna/announce.js";

const URL_TTS = "http://192.168.10.5:8123/api/tts_proxy/abc.mp3";
const BASE = "http://192.168.10.240:46400";

function deferred<T = void>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

let qc: Any;
let callLog: string[];
let apStatusCalls = 0;

// announceAirPlay 会读两次状态:第一次是在 deactivate 之前「保存现场」,之后是
// waitUntilAirPlayIdle 的轮询。假体必须让第二次起返回 IDLE,否则轮询会一直转到
// 300s 预算耗尽(表现为用例 5s 超时)。这里统一:首次返回给定现场,其后一律 IDLE。
function setApStatus(initial: Any | Error) {
  apStatusCalls = 0;
  f.getAirPlayStatus.mockImplementation(() => {
    if (apStatusCalls++ === 0) {
      if (initial instanceof Error) throw initial;
      return initial;
    }
    return { volume: 50, playbackState: "IDLE", position: 0 };
  });
}

function mkQc(over: Any = {}) {
  return {
    snapshot: vi.fn(() => ({
      items: [{ songId: "s1" }, { songId: "s2" }],
      currentIndex: 0,
      isActive: true,
      ended: false,
    })),
    deactivate: vi.fn(() => { callLog.push("deactivate"); }),
    playFrom: vi.fn(async () => { callLog.push("playFrom"); return 0; }),
    transport: vi.fn(async (_id: string, op: string, arg?: number) => {
      callLog.push(`transport:${op}:${arg}`);
    }),
    ...over,
  };
}

// 注意:Vitest/Jest 的取值优先级是「once 实现 > mockReturnValue/mockResolvedValue >
// mockImplementation」。若在某用例里用 mockImplementation 覆盖一个 beforeEach 里
// 用 mockResolvedValue 设过的假体,后者会赢、前者被静默忽略 —— 这里统一用
// resetAllMocks + 全部以 mockImplementation 起底,避免这类"假体没生效"的假绿/假红。
beforeEach(() => {
  vi.resetAllMocks();
  callLog = [];
  qc = mkQc();

  f.getDevice.mockImplementation((id: string) => (id.includes("missing") ? undefined : { id }));
  f.getDeviceStatus.mockResolvedValue({ volume: 40, state: "PLAYING", position: 0 });
  f.setDeviceVolume.mockImplementation(async (id: string, v: number) => {
    callLog.push(`setVolume:${id}:${v}`);
  });
  f.playUriOnDevice.mockImplementation(async (id: string, url: string, meta: Any) => {
    callLog.push(`playUri:${id}:${url}:${meta?.title}`);
  });
  f.waitUntilStopped.mockResolvedValue(undefined);
  f.getEffectiveBaseUrl.mockReturnValue(BASE);

  f.getQueueController.mockReturnValue(qc);
  f.getGroupManager.mockReturnValue({ get: vi.fn(() => undefined) });

  setApStatus({ volume: 50, playbackState: "PLAYING", position: 10 });
  f.setAirPlayVolume.mockImplementation(async (id: string, v: number) => {
    callLog.push(`apVolume:${id}:${v}`);
  });
  f.castToAirPlayDevice.mockImplementation(async () => ({ mediaUri: "u" }));

  f.isForkMode.mockReturnValue(false);
  f.getSendspinServer.mockReturnValue({ kind: "srv" });
  f.announceProbeCore.mockReturnValue({ wasPlaying: true, savedPos: 3000 });
  f.announceCore.mockResolvedValue({ targets: 1 });
  f.supervisorIsRunning.mockReturnValue(true);
  f.supervisorRpc.mockImplementation(async (method: string) => {
    if (method === "announceProbe") return { wasPlaying: true, savedPos: 3000 };
    return { targets: 1 };
  });
});

// ==================== 并发保护 / 入参校验 ====================

describe("announceOnPeer — 入参与并发保护", () => {
  it("URL 不是 http(s) 绝对地址 → 直接拒绝(不发声)", async () => {
    await expect(announceOnPeer({ peerId: "dlna:dev1", url: "rtsp://x/y.mp3" })).rejects.toThrow(
      "播报 URL 必须是 http(s) 绝对地址",
    );
    expect(f.playUriOnDevice).not.toHaveBeenCalled();
    expect(isAnnouncing("dlna:dev1")).toBe(false);
  });

  it("peerId 不是可播报类型(local: / 裸 id)→ 该播放器不支持播报", async () => {
    await expect(announceOnPeer({ peerId: "local:u1:c1", url: URL_TTS })).rejects.toThrow(
      "该播放器不支持播报",
    );
    await expect(announceOnPeer({ peerId: "dev1", url: URL_TTS })).rejects.toThrow(
      "该播放器不支持播报",
    );
    expect(f.getQueueController).not.toHaveBeenCalled();
  });

  it("组播报:仅对 getDevice 命中的成员下发(已离线的成员被过滤)", async () => {
    f.getGroupManager.mockReturnValue({
      get: vi.fn(() => ({ memberIds: ["devA", "missingDev", "devC"] })),
    });
    const r = await announceOnPeer({ peerId: "group:g1", url: URL_TTS });
    expect(r).toEqual({ targets: 2 });
    const ids = f.playUriOnDevice.mock.calls.map((c: Any[]) => c[0]);
    expect(ids).toEqual(["devA", "devC"]);
    // 组内成员各自独立保存现场
    const volIds = f.getDeviceStatus.mock.calls.map((c: Any[]) => c[0]);
    expect(volIds).toEqual(["devA", "devC"]);
  });

  it("组不存在 / 成员全离线 → 不支持播报", async () => {
    f.getGroupManager.mockReturnValue({ get: vi.fn(() => ({ memberIds: ["missingA"] })) });
    await expect(announceOnPeer({ peerId: "group:gone", url: URL_TTS })).rejects.toThrow(
      "该播放器不支持播报",
    );
  });

  it("同一 DLNA peer 并发播报 → 第二个被拒(避免两次播报互相覆盖现场)", async () => {
    const gate = deferred();
    f.playUriOnDevice.mockImplementation(async () => {
      callLog.push("playUri");
      await gate.promise;
    });
    const first = announceOnPeer({ peerId: "dlna:dev1", url: URL_TTS });
    // 等第一路推进到下发阶段(此时 running 已占位)
    await vi.waitFor(() => expect(isAnnouncing("dlna:dev1")).toBe(true));

    await expect(announceOnPeer({ peerId: "dlna:dev1", url: URL_TTS })).rejects.toThrow(
      "该播放器正在播报中",
    );
    expect(f.playUriOnDevice).toHaveBeenCalledTimes(1);

    gate.resolve();
    await expect(first).resolves.toEqual({ targets: 1 });
    expect(isAnnouncing("dlna:dev1")).toBe(false);
  });

  it("同一 AirPlay peer 并发播报 → 第二个被拒,且失败后占位被释放(可再次播报)", async () => {
    const id = "airplay:apConc";
    expect(isAnnouncing(id)).toBe(false);
    const gate = deferred();
    f.castToAirPlayDevice.mockImplementation(() => gate.promise);
    const first = announceOnPeer({ peerId: id, url: URL_TTS }).catch((e: Any) => e);
    // 占位在进入 await 之前就已同步写入 running
    expect(isAnnouncing(id)).toBe(true);

    await expect(announceOnPeer({ peerId: id, url: URL_TTS })).rejects.toThrow(
      "该播放器正在播报中",
    );

    gate.reject(new Error("raop 断链"));
    expect((await first)?.message).toBe("raop 断链");
    // finally 里的 running.delete 必须生效,否则该播放器会被永久锁死
    expect(isAnnouncing(id)).toBe(false);
    // 占位释放后可再次播报
    f.castToAirPlayDevice.mockImplementation(async () => ({ mediaUri: "u" }));
    setApStatus({ volume: 50, playbackState: "IDLE", position: 0 });
    await expect(announceOnPeer({ peerId: id, url: URL_TTS })).resolves.toEqual({ targets: 1 });
  });
});

// ==================== DLNA 主路径 ====================

describe("announceOnPeer — DLNA 保存/冻结/播报/还原/恢复", () => {
  it("完整编排顺序:冻结 → 设播报音量 → 播 → 等停 → 还原音量 → 恢复原曲并 seek 回原进度", async () => {
    f.getDeviceStatus.mockResolvedValue({ volume: 35, state: "PLAYING", position: 30 });

    const r = await announceOnPeer({ peerId: "dlna:dev1", url: URL_TTS, volume: 88 });

    expect(r).toEqual({ targets: 1 });
    expect(f.getDeviceStatus).toHaveBeenCalledWith("dev1");
    expect(qc.deactivate).toHaveBeenCalledWith("dlna:dev1");
    expect(callLog).toEqual([
      "deactivate",
      "setVolume:dev1:88",
      "playUri:dev1:" + URL_TTS + ":Announcement",
      "setVolume:dev1:35",
      "playFrom",
      "transport:seek:30",
    ]);
    // 恢复:先 playFrom 再 seek(seek 走 transport,单位秒)
    expect(qc.playFrom).toHaveBeenCalledWith("dlna:dev1", expect.any(Array), 0, BASE);
    expect(qc.transport).toHaveBeenCalledWith("dlna:dev1", "seek", 30);
    // 播报占位已释放
    expect(isAnnouncing("dlna:dev1")).toBe(false);
  });

  it("未指定播报音量 → 不碰设备音量(不预先调、也不还原)", async () => {
    await announceOnPeer({ peerId: "dlna:dev1", url: URL_TTS });
    expect(f.setDeviceVolume).not.toHaveBeenCalled();
    expect(callLog).toEqual(["deactivate", `playUri:dev1:${URL_TTS}:Announcement`, "playFrom"]);
  });

  it("音量越界/小数 → 收敛到 0-100 整数后下发", async () => {
    await announceOnPeer({ peerId: "dlna:dev1", url: URL_TTS, volume: 140 });
    expect(f.setDeviceVolume.mock.calls[0]).toEqual(["dev1", 100]);

    f.setDeviceVolume.mockClear();
    callLog = [];
    await announceOnPeer({ peerId: "dlna:dev2", url: URL_TTS, volume: -7.6 });
    expect(f.setDeviceVolume.mock.calls[0]).toEqual(["dev2", 0]);
  });

  it("原进度 ≤2s → 恢复原曲但不 seek(避免刚起播就 seek 被设备丢弃)", async () => {
    f.getDeviceStatus.mockResolvedValue({ volume: 35, state: "PLAYING", position: 2 });
    await announceOnPeer({ peerId: "dlna:dev1", url: URL_TTS });
    expect(qc.playFrom).toHaveBeenCalledTimes(1);
    expect(qc.transport).not.toHaveBeenCalled();
  });

  it("播报前队列未激活 → 不冻结队列、也不恢复播放(播报不该顺手放歌)", async () => {
    qc.snapshot.mockReturnValue({ items: [], currentIndex: -1, isActive: false, ended: false });
    await announceOnPeer({ peerId: "dlna:dev1", url: URL_TTS });
    expect(qc.deactivate).not.toHaveBeenCalled();
    expect(qc.playFrom).not.toHaveBeenCalled();
    expect(f.playUriOnDevice).toHaveBeenCalledTimes(1);
  });

  it("队列激活但设备当时不在播 → 不恢复(保持安静)", async () => {
    f.getDeviceStatus.mockResolvedValue({ volume: 35, state: "IDLE", position: 30 });
    await announceOnPeer({ peerId: "dlna:dev1", url: URL_TTS });
    expect(qc.deactivate).toHaveBeenCalledTimes(1);
    expect(qc.playFrom).not.toHaveBeenCalled();
  });

  it("取设备现场失败 → 按静默 idle 兜底,播报继续,且视作未在播(不恢复)", async () => {
    f.getDeviceStatus.mockRejectedValue(new Error("description 502"));
    const r = await announceOnPeer({ peerId: "dlna:dev1", url: URL_TTS, volume: 60 });
    expect(r).toEqual({ targets: 1 });
    expect(f.playUriOnDevice).toHaveBeenCalledTimes(1);
    expect(qc.playFrom).not.toHaveBeenCalled();
    // 兜底现场 volume=0 → 还原时按 0 还原
    expect(f.setDeviceVolume).toHaveBeenLastCalledWith("dev1", 0);
  });

  it("全部目标设备下发失败 → 抛「目标设备均无响应」(不静默吞掉)", async () => {
    f.playUriOnDevice.mockRejectedValue(new Error("connection refused"));
    await expect(announceOnPeer({ peerId: "dlna:dev1", url: URL_TTS })).rejects.toThrow(
      "播报下发失败:目标设备均无响应",
    );
    expect(isAnnouncing("dlna:dev1")).toBe(false);
  });

  it("部分设备下发失败 → 不算失败,等停与还原仍对全部目标执行", async () => {
    f.getGroupManager.mockReturnValue({ get: vi.fn(() => ({ memberIds: ["devA", "devB"] })) });
    f.playUriOnDevice.mockImplementation(async (id: string) => {
      if (id === "devB") throw new Error("no route");
    });
    const r = await announceOnPeer({ peerId: "group:g1", url: URL_TTS, volume: 70 });
    expect(r).toEqual({ targets: 2 });
    expect(f.waitUntilStopped.mock.calls.map((c: Any[]) => c[0])).toEqual(["devA", "devB"]);
  });

  it("音量设置失败(设不上/还原不上)→ 只记日志,不中断播报与恢复", async () => {
    f.setDeviceVolume.mockRejectedValue(new Error("UPnP 501"));
    f.getDeviceStatus.mockResolvedValue({ volume: 35, state: "PLAYING", position: 30 });
    const r = await announceOnPeer({ peerId: "dlna:dev1", url: URL_TTS, volume: 90 });
    expect(r).toEqual({ targets: 1 });
    expect(f.playUriOnDevice).toHaveBeenCalledTimes(1);
    expect(qc.playFrom).toHaveBeenCalledTimes(1);
  });

  it("自定义 timeoutMs 透传给 waitUntilStopped", async () => {
    await announceOnPeer({ peerId: "dlna:dev1", url: URL_TTS, timeoutMs: 1234 });
    expect(f.waitUntilStopped).toHaveBeenCalledWith("dev1", 1234);

    f.waitUntilStopped.mockClear();
    await announceOnPeer({ peerId: "dlna:dev2", url: URL_TTS });
    expect(f.waitUntilStopped).toHaveBeenCalledWith("dev2", 300000);
  });
});

// ==================== AirPlay 路径 ====================

describe("announceOnPeer — AirPlay 通道", () => {
  it("完整编排:设播报音量 → RAOP 起流(用 streamUrl,不走曲库)→ 等 IDLE → 还原 → 恢复", async () => {
    const r = await announceOnPeer({ peerId: "airplay:apFull", url: URL_TTS, volume: 75 });
    expect(r).toEqual({ targets: 1 });
    expect(f.setAirPlayVolume).toHaveBeenCalledWith("apFull", 75);
    expect(f.castToAirPlayDevice).toHaveBeenCalledWith(
      expect.objectContaining({ deviceId: "apFull", streamUrl: URL_TTS, title: "Announcement" }),
    );
    // 还原用播报前记录的 50
    expect(f.setAirPlayVolume).toHaveBeenLastCalledWith("apFull", 50);
    expect(qc.deactivate).toHaveBeenCalledWith("airplay:apFull");
    expect(qc.playFrom).toHaveBeenCalledWith("airplay:apFull", expect.any(Array), 0, BASE);
    expect(qc.transport).toHaveBeenCalledWith("airplay:apFull", "seek", 10);
  });

  it("取不到 AirPlay 状态 → 按静默 idle 兜底(不恢复),还原音量按默认 80", async () => {
    setApStatus(new Error("no session"));
    const r = await announceOnPeer({ peerId: "airplay:apNoStatus", url: URL_TTS, volume: 20 });
    expect(r).toEqual({ targets: 1 });
    expect(f.setAirPlayVolume).toHaveBeenLastCalledWith("apNoStatus", 80);
    expect(qc.playFrom).not.toHaveBeenCalled();
    expect(qc.transport).not.toHaveBeenCalled();
  });

  it("未在播状态 → 不恢复播放", async () => {
    setApStatus({ volume: 50, playbackState: "IDLE", position: 10 });
    await announceOnPeer({ peerId: "airplay:apIdle", url: URL_TTS });
    expect(qc.playFrom).not.toHaveBeenCalled();
  });

  it("音量设置/还原失败 → 只记日志,不中断", async () => {
    f.setAirPlayVolume.mockRejectedValue(new Error("raop 未就绪"));
    setApStatus({ volume: 50, playbackState: "IDLE", position: 0 });
    await expect(announceOnPeer({ peerId: "airplay:apVolFail", url: URL_TTS, volume: 30 })).resolves.toEqual({
      targets: 1,
    });
    expect(f.castToAirPlayDevice).toHaveBeenCalledTimes(1);
  });

  it("原进度 ≤2s → 不 seek", async () => {
    setApStatus({ volume: 50, playbackState: "PLAYING", position: 1 });
    await announceOnPeer({ peerId: "airplay:apShortPos", url: URL_TTS });
    expect(qc.playFrom).toHaveBeenCalledTimes(1);
    expect(qc.transport).not.toHaveBeenCalled();
  });
});

// ==================== Sendspin 路径 ====================

describe("announceOnPeer — Sendspin 通道(双模式)", () => {
  it("in-proc:服务未运行 → 明确报错", async () => {
    f.getSendspinServer.mockReturnValue(undefined);
    await expect(announceOnPeer({ peerId: "sendspin:sp1", url: URL_TTS })).rejects.toThrow(
      "sendspin 服务未运行",
    );
    expect(isAnnouncing("sendspin:sp1")).toBe(false);
  });

  it("in-proc:探针 → 播报 → 恢复原曲并 seek(毫秒进度换算成秒)", async () => {
    f.announceProbeCore.mockReturnValue({ wasPlaying: true, savedPos: 9500 });
    f.announceCore.mockResolvedValue({ targets: 2 });
    const r = await announceOnPeer({ peerId: "sendspin:sp1", url: URL_TTS, volume: 66, timeoutMs: 9000 });
    expect(r).toEqual({ targets: 2 });
    expect(f.announceProbeCore).toHaveBeenCalledWith({ kind: "srv" }, "sendspin:sp1");
    expect(f.announceCore).toHaveBeenCalledWith(
      { kind: "srv" },
      "sendspin:sp1",
      URL_TTS,
      { volume: 66, timeoutMs: 9000, savedPos: 9500 },
    );
    // progress 毫秒 → 秒(向下取整)
    expect(qc.transport).toHaveBeenCalledWith("sendspin:sp1", "seek", 9);
    expect(qc.playFrom).toHaveBeenCalledWith("sendspin:sp1", expect.any(Array), 0, BASE);
  });

  it("in-proc:进度 ≤2000ms → 只恢复不 seek", async () => {
    f.announceProbeCore.mockReturnValue({ wasPlaying: true, savedPos: 2000 });
    await announceOnPeer({ peerId: "sendspin:sp1", url: URL_TTS });
    expect(qc.playFrom).toHaveBeenCalledTimes(1);
    expect(qc.transport).not.toHaveBeenCalled();
  });

  it("in-proc:播报前未在播 → 不恢复", async () => {
    f.announceProbeCore.mockReturnValue({ wasPlaying: false, savedPos: 9000 });
    await announceOnPeer({ peerId: "sendspin:sp1", url: URL_TTS });
    expect(qc.deactivate).toHaveBeenCalledTimes(1);
    expect(qc.playFrom).not.toHaveBeenCalled();
  });

  it("fork 模式:子进程未运行 → 明确报错(不去调 RPC)", async () => {
    f.isForkMode.mockReturnValue(true);
    f.supervisorIsRunning.mockReturnValue(false);
    await expect(announceOnPeer({ peerId: "sendspin:sp1", url: URL_TTS })).rejects.toThrow(
      "sendspin 服务未运行",
    );
    expect(f.supervisorRpc).not.toHaveBeenCalled();
  });

  it("fork 模式:RPC 走 announceProbe/announce,超时放宽到 6 分钟", async () => {
    f.isForkMode.mockReturnValue(true);
    f.supervisorRpc.mockImplementation(async (m: string) => {
      if (m === "announceProbe") return { wasPlaying: true, savedPos: 5000 };
      return { targets: 3 };
    });
    const r = await announceOnPeer({ peerId: "sendspin:sp1", url: URL_TTS, volume: 40 });
    expect(r).toEqual({ targets: 3 });
    expect(f.supervisorRpc.mock.calls[0]).toEqual(["announceProbe", { peerId: "sendspin:sp1" }]);
    expect(f.supervisorRpc.mock.calls[1][0]).toBe("announce");
    expect(f.supervisorRpc.mock.calls[1][1]).toEqual({
      peerId: "sendspin:sp1",
      url: URL_TTS,
      volume: 40,
      timeoutMs: undefined,
      savedPos: 5000,
    });
    expect(f.supervisorRpc.mock.calls[1][2]).toBe(360_000);
    expect(qc.playFrom).toHaveBeenCalledTimes(1);
  });

  it("fork 模式:恢复期的 seek 失败被吞掉(不把已成功的播报判成失败)", async () => {
    f.isForkMode.mockReturnValue(true);
    f.supervisorRpc.mockImplementation(async (m: string) =>
      m === "announceProbe" ? { wasPlaying: true, savedPos: 8000 } : { targets: 1 },
    );
    qc.transport.mockRejectedValue(new Error("seek 超时"));
    await expect(announceOnPeer({ peerId: "sendspin:sp1", url: URL_TTS })).resolves.toEqual({
      targets: 1,
    });
  });
});
