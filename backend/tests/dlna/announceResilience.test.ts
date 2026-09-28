// services/dlna/announce.ts —— 残余分支:编排链路里"某一步失败"的降级契约。
//
// 已存的 announceService.test.ts 覆盖的是主干编排顺序;这里专补**半失败**形态 ——
// 真实家里的播报几乎不会全链路干净:组里有台成员已经掉线、某台音箱的音量
// SOAP 刚好超时、AirPlay 会话还在起播判定里面先把服务卫视起来。
// 这些形态的共同要求是:失败只能留下痕迹,**不能把整次播报带崩**,
// 更不能把用户原来在听的歌搞丢。
import "../plugins/_env.js";

import { describe, it, expect, beforeEach, vi } from "vitest";

type Any = any;

const f = vi.hoisted(() => ({
  getDevice: vi.fn(),
  getDeviceStatus: vi.fn(),
  setDeviceVolume: vi.fn(),
  playUriOnDevice: vi.fn(),
  waitUntilStopped: vi.fn(),
  getEffectiveBaseUrl: vi.fn(),
  getQueueController: vi.fn(),
  getGroupManager: vi.fn(),
  getAirPlayStatus: vi.fn(),
  setAirPlayVolume: vi.fn(),
  castToAirPlayDevice: vi.fn(),
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
vi.mock("../../src/services/player/index.js", () => ({ getQueueController: f.getQueueController }));
vi.mock("../../src/services/group/index.js", () => ({ getGroupManager: f.getGroupManager }));
vi.mock("../../src/services/airplay/control.js", () => ({
  getAirPlayStatus: f.getAirPlayStatus,
  setAirPlayVolume: f.setAirPlayVolume,
  castToAirPlayDevice: f.castToAirPlayDevice,
}));
vi.mock("../../src/services/sendspin/mode.js", () => ({ isForkMode: f.isForkMode }));
vi.mock("../../src/services/sendspin/supervisor.js", () => ({
  sendspinSupervisor: { isRunning: f.supervisorIsRunning, rpc: f.supervisorRpc },
}));
vi.mock("../../src/services/sendspin/index.js", () => ({ getSendspinServer: f.getSendspinServer }));
vi.mock("../../src/services/sendspin/playerCore.js", () => ({
  announceProbeCore: f.announceProbeCore,
  announceCore: f.announceCore,
}));

import { announceOnPeer, isAnnouncing } from "../../src/services/dlna/announce.js";

const URL_TTS = "http://192.168.10.5:8123/api/tts_proxy/abc.mp3";
const BASE = "http://192.168.10.240:46400";

let callLog: string[];
// AirPlay 假体的调用计数保存在这里:需要「第 N 次查询才开始返回 IDLE」这种时序,
// 用顶层标量会被不同用例互相污染。
let apStatusSeq: Any[];

function mkQc() {
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
  };
}

beforeEach(() => {
  vi.resetAllMocks();
  callLog = [];
  apStatusSeq = [];

  f.getDevice.mockImplementation((id: string) => (id.includes("missing") ? undefined : { id }));
  f.getDeviceStatus.mockResolvedValue({ volume: 40, state: "PLAYING", position: 30 });
  f.setDeviceVolume.mockImplementation(async (id: string, v: number) => {
    callLog.push(`setVolume:${id}:${v}`);
  });
  f.playUriOnDevice.mockImplementation(async (id: string, url: string, meta: Any) => {
    callLog.push(`playUri:${id}:${url}:${meta?.title}`);
  });
  f.waitUntilStopped.mockResolvedValue(undefined);
  f.getEffectiveBaseUrl.mockReturnValue(BASE);

  f.getQueueController.mockReturnValue(mkQc());
  f.getGroupManager.mockReturnValue({ get: vi.fn(() => undefined) });

  f.getAirPlayStatus.mockImplementation(() => apStatusSeq.shift()
    ?? { volume: 50, playbackState: "IDLE", position: 10 });
  f.setAirPlayVolume.mockImplementation(async (id: string, v: number) => {
    callLog.push(`apVolume:${id}:${v}`);
  });
  f.castToAirPlayDevice.mockImplementation(async () => ({ mediaUri: "u" }));

  f.isForkMode.mockReturnValue(false);
  f.getSendspinServer.mockReturnValue({ kind: "srv" });
  f.announceProbeCore.mockReturnValue({ wasPlaying: true, savedPos: 3000 });
  f.announceCore.mockResolvedValue({ targets: 1 });
  f.supervisorIsRunning.mockReturnValue(true);
});

// ===========================================================================
describe("resolveTargets:成员列表缺失的形态", () => {
  it("组记录存在但没有 memberIds 字段 → 按空成员处理,明确报不支持", async () => {
    // group table 里一条记录可能只有 id 没有 memberIds;走到 `(g?.memberIds || [])`
    // 之外的字面空数组,不能变成 TypeError。
    f.getGroupManager.mockReturnValue({ get: vi.fn(() => ({ memberIds: undefined })) });
    await expect(announceOnPeer({ peerId: "group:no-members", url: URL_TTS })).rejects.toThrow(
      "该播放器不支持播报",
    );
    expect(f.playUriOnDevice).not.toHaveBeenCalled();
    expect(isAnnouncing("group:no-members")).toBe(false);
  });

  it("组记录是个空对象 → 同上,不影响后续其它群体的播报", async () => {
    f.getGroupManager.mockReturnValue({ get: vi.fn(() => ({})) });
    await expect(announceOnPeer({ peerId: "group:empty", url: URL_TTS })).rejects.toThrow(
      "该播放器不支持播报",
    );
    f.getGroupManager.mockReturnValue({ get: vi.fn(() => ({ memberIds: ["devK"] })) });
    await expect(announceOnPeer({ peerId: "group:ok", url: URL_TTS })).resolves.toEqual({ targets: 1 });
  });
});

// ===========================================================================
describe("DLNA 音量失败只留痕迹:不能带崩整次播报", () => {
  it("部分成员音量设不上 → 不中断播报,其余步骤与还原照跑", async () => {
    // 两次 monospace 调用:先设播报音量(devA 失败、devB 成功),再还原(devB 失败)。
    f.getGroupManager.mockReturnValue({ get: vi.fn(() => ({ memberIds: ["devA", "devB"] })) });
    const seen: string[] = [];
    f.setDeviceVolume.mockImplementation(async (id: string, v: number) => {
      const key = `${id}:${v}`;
      seen.push(key);
      // 只让“设播报音量”这一步对 devA 失败;还原(40)一律失败一次也不影响断言目标。
      if (id === "devA" && v === 70) throw new Error("SetVolume 500");
      callLog.push(`setVolume:${key}`);
    });
    f.getDeviceStatus.mockResolvedValue({ volume: 40, state: "PLAYING", position: 30 });

    const r = await announceOnPeer({ peerId: "group:g1", url: URL_TTS, volume: 70 });
    expect(r).toEqual({ targets: 2 });
    // 两台都尝过一次音量(失败的那台不重发,不拖长播报链路)
    expect(seen).toContain("devA:70");
    expect(seen).toContain("devB:70");
    // 还原 stage 依然对全部成员执行
    expect(seen).toContain("devA:40");
    expect(seen).toContain("devB:40");
    expect(f.playUriOnDevice).toHaveBeenCalledTimes(2);
  });

  it("还原音量失败 → 播报已成功交付,且占位释放(不影响下一次播报)", async () => {
    f.setDeviceVolume.mockImplementation(async (id: string, v: number) => {
      // 还原(30)失败 —— 这是用户最直观的感受点:歌会以播报音量继续放
      if (v === 30) throw new Error("restore rejected");
      callLog.push(`setVolume:${id}:${v}`);
    });
    f.getDeviceStatus.mockResolvedValue({ volume: 30, state: "PLAYING", position: 30 });

    await expect(announceOnPeer({ peerId: "dlna:restore-fail", url: URL_TTS, volume: 90 }))
      .resolves.toEqual({ targets: 1 });
    expect(isAnnouncing("dlna:restore-fail")).toBe(false);
    // 铃恢复原曲这一步不能被音量的失败带上
    expect(callLog).toContain("playFrom");
    expect(callLog).toContain("transport:seek:30");
  });
});

// ===========================================================================
describe("AirPlay 通道:失败被吞掉,占位必须释放", () => {
  it("播报音量设不上 → 不中断,后续 cast 与还原照跑", async () => {
    apStatusSeq = [
      { volume: 50, playbackState: "PLAYING", position: 12 },
      { volume: 50, playbackState: "IDLE", position: 12 },
    ];
    let n = 0;
    f.setAirPlayVolume.mockImplementation(async (id: string, v: number) => {
      n += 1;
      if (n === 1) throw new Error("raop 未就绪");
      callLog.push(`apVolume:${id}:${v}`);
    });

    await expect(announceOnPeer({ peerId: "airplay:apVolFail", url: URL_TTS, volume: 30 }))
      .resolves.toEqual({ targets: 1 });
    expect(f.castToAirPlayDevice).toHaveBeenCalledTimes(1);
    // 还原依然下发(用播报前记录的 50)
    expect(f.setAirPlayVolume).toHaveBeenCalledWith("apVolFail", 50);
  });

  it("还原音量失败 → 已是成功播报,兑换占位并恢复原曲", async () => {
    apStatusSeq = [
      { volume: 50, playbackState: "PLAYING", position: 12 },
      { volume: 50, playbackState: "IDLE", position: 12 },
    ];
    let n = 0;
    f.setAirPlayVolume.mockImplementation(async (id: string, v: number) => {
      n += 1;
      if (n === 2) throw new Error("raop TEARDOWN 失败");
      callLog.push(`apVolume:${id}:${v}`);
    });

    await expect(announceOnPeer({ peerId: "airplay:apRestoreFail", url: URL_TTS, volume: 30 }))
      .resolves.toEqual({ targets: 1 });
    expect(isAnnouncing("airplay:apRestoreFail")).toBe(false);
    expect(callLog).toContain("playFrom");
    expect(callLog).toContain("transport:seek:12");
  });

  it("等 IDLE 的过程中会话查询抖动 → 继续轮询到真正结束(不提前收尾)", async () => {
    // waitUntilAirPlayIdle 的轮询里,第一次查询是给「保存现场」用的,之后每次都可能
    // 因为会话刚拉起而抛错 —— 错必须被吞掉并继续轮询,不能提前判定「播完了」。
    apStatusSeq = [
      { volume: 50, playbackState: "PLAYING", position: 12 }, // 第 1 次:保存现场
      new Error("session not ready"),                          // 轮询第 1 次:抛错
      { volume: 50, playbackState: "PLAYING", position: 12 },  // 轮询第 2 次:还在播
      { volume: 50, playbackState: "IDLE", position: 12 },     // 轮询第 3 次:结束
    ];

    // 带上播报音量,才能同时验证「设 → 播 → 等停 → 还原」四步都用同一条假体
    await expect(announceOnPeer({ peerId: "airplay:apFlaky", url: URL_TTS, volume: 60 }))
      .resolves.toEqual({ targets: 1 });
    // 抖动被吞掉了 —— 查询至少被调过 4 次(1 次保存现场 + 3 次轮询)
    expect(f.getAirPlayStatus.mock.calls.length).toBeGreaterThanOrEqual(4);
    // 会话确实走到「已结束」后才进入还原与恢复
    expect(f.setAirPlayVolume).toHaveBeenLastCalledWith("apFlaky", 50);
    expect(callLog).toContain("playFrom");
  });
});
