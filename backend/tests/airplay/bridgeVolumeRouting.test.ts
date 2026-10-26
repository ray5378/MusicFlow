// ==================== 桥会话音量路由(缺陷:桥占用设备的音量落不到 RAOP) ====================
//
// 缺陷链(childMain.ts 的 `case "setVolumeDb"` → sessionRuntime.ts:372-377):
//   主进程 `applyVolumeDb` 的回落通道只把 dB 交给子进程,子进程**只查 native 会话表**
//   (`this.sessions.get(deviceId)`),桥占用设备根本不在那张表里 ⇒ 命不中就 return false,
//   而 false 之后**没人接手** ⇒ 桥的 RaopPlayer 永远收不到 `SET_PARAMETER volume`
//   (它只在建会话 bridgeSession.ts:374 与 RAOP 重连 :586 时收到一次初始音量)。
//   线上症状:组内桥占用设备(HiVi)在切歌 / 拖音量条 / 静音切换后音量冻结在起播值。
//
// 修复(三处最小侵入):
//   ① `BridgeSession.setVolumeDb(db)`          —— 直连 RaopPlayer,player 未就绪只 warn;
//   ② `BridgeSessionManager.setVolumeDb(id,db)` —— 按 deviceId 遍历桥会话表,命中返回 true;
//   ③ `childMain.ts` native 未命中时回落给桥,并保留 `Number.isFinite` 那条注释语义。
//
// 本文件钉死的契约(每条都对应一个线上可见行为):
//   ① 桥占用设备:volume RPC 必须打到**桥会话的 RaopPlayer**,实参 dB 原样;
//   ② native 会话在场时**仍走 native**(桥回落不得抢走 native 的音量);
//   ③ native 与桥都不在场:不抛、res 正常返回(result=null),重复调用幂等;
//   ④ `db = 0`(最大音量)必须原样传 0,绝不能被 `||` 短路成 -144(静音,踩过的坑);
//   ⑤ db 非有限数(NaN / Infinity / 垃圾字符串)→ 落 -144(静音兜底)。
//
// 子进程相关一律 mock:本路径唯一可能 spawn 的是解码器(ffmpeg),测试里必须永不 spawn。
import "../plugins/_env.js";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../src/services/airplay/decoder.js", () => ({
  spawnDecoder: vi.fn(() => {
    throw new Error("测试内不得 spawn 解码器");
  }),
  makeProducer: vi.fn(() => ({ pull: async () => null, stop: () => {} })),
  killDecoder: vi.fn(),
  degreesToDb: vi.fn(() => -18),
}));

import { AirplayChildController, type ChildSend } from "../../src/services/airplay/childMain.js";
import { BridgeSession, BridgeSessionManager } from "../../src/services/airplay/bridgeSession.js";
import { bridgeSocketPath } from "../../src/services/airplay/bridgeChannel.js";

type Any = any;

/** 桥会话的假 RaopPlayer:本路径只碰 setVolumeDb 一个成员。 */
function fakeRaopPlayer(): Any {
  return { setVolumeDb: vi.fn() };
}

/**
 * 造一座**真** BridgeSession(不 start:setVolumeDb 不需要 listener、也不需要 RTSP 握手),
 * 只把私有 `player` 换成 spy —— 这样测的是生产里 `this.player?.setVolumeDb(db)` 那行代码,
 * 而不是替身自己的逻辑。生产赋值点在 bridgeSession.ts:372(首连)与 :583(重连)。
 */
function realBridgeSession(deviceId: string): { session: BridgeSession; player: Any } {
  const token = `tok-${deviceId}`;
  const session = new BridgeSession({
    deviceId,
    token,
    protocol: "raop",
    socketPath: bridgeSocketPath(deviceId, token),
    dry: true,
    waitDataMs: 50,
  });
  const player = fakeRaopPlayer();
  (session as Any).player = player;
  return { session, player };
}

/** native 会话的最小壳:只给 setVolumeDb 与 snapshot() 读到的字段(避免 null 解引用)。 */
function fakeNativeSession(deviceId: string): { active: Any; player: Any } {
  const player = { setVolumeDb: vi.fn(), isPaused: false, positionSec: 0, durationSec: 0 };
  const active = {
    deviceId,
    player,
    session: {},
    seat: "",
    songId: "song-1",
    title: "标题",
    artist: "艺人",
    album: "专辑",
    duration: 0,
    streamUrl: "http://127.0.0.1/stream",
    startedAt: 0,
    ended: false,
  };
  return { active, player };
}

describe("桥会话音量路由(缺陷 1)", () => {
  let sent: Any[];
  let ctl: AirplayChildController;

  beforeEach(() => {
    sent = [];
    const send: ChildSend = (m) => sent.push(m as Any);
    ctl = new AirplayChildController(send);
  });

  afterEach(() => {
    ctl.dispose();
  });

  /** 生产里 bridgeSessions 是 private;测试通过同一实例的真实 Map 落表(等价 prepare 之后的状态)。 */
  const bridgeSessions = (): BridgeSessionManager => (ctl as Any).bridgeSessions as BridgeSessionManager;
  const nativeSessions = (): Map<string, Any> => (ctl as Any).runtime.sessions as Map<string, Any>;

  /** 落一座桥会话(等同 bridgePrepare 成功后 Map 里的样子),返回其 RaopPlayer 替身。 */
  function attachBridge(deviceId: string): Any {
    const { session, player } = realBridgeSession(deviceId);
    ((bridgeSessions() as Any).sessions as Map<string, BridgeSession>).set(session.token, session);
    return player;
  }

  /** 落一个 native 会话(等同 runtime.cast 成功后 Map 里的样子),返回其 player 替身。 */
  function attachNative(deviceId: string): Any {
    const { active, player } = fakeNativeSession(deviceId);
    nativeSessions().set(deviceId, active);
    return player;
  }

  /** 走真实 RPC 入口(与子进程收到主进程消息同一条路径),返回 res 消息。 */
  async function rpc(op: string, payload?: unknown): Promise<Any> {
    sent.length = 0;
    await ctl.handleMessage({ t: "req", id: 7, op, payload });
    const res = sent.find((m) => m?.t === "res");
    expect(res, `op=${op} 必须有 res 回包`).toBeTruthy();
    return res;
  }

  it("① 桥占用设备:volume RPC 打到桥会话的 RaopPlayer(实参 dB 原样)", async () => {
    const bridgePlayer = attachBridge("dev-bridge");
    expect(nativeSessions().size).toBe(0); // 前提:该设备没有 native 会话

    const res = await rpc("setVolumeDb", { deviceId: "dev-bridge", db: -12.5 });

    expect(res.ok).toBe(true);
    expect(res.result).toBeNull();
    expect(bridgePlayer.setVolumeDb).toHaveBeenCalledTimes(1);
    expect(bridgePlayer.setVolumeDb).toHaveBeenCalledWith(-12.5);
  });

  it("② native 会话在场时仍走 native(桥回落不得抢走 native 的音量)", async () => {
    // 同 deviceId 同时存在两种会话属异常态(双向互斥),这里刻意构造它来钉「优先级」:
    // native 命中就必须 return,不能再往桥发一遍,否则会出现「一条音量两次 SET_PARAMETER」。
    const nativePlayer = attachNative("dev-both");
    const bridgePlayer = attachBridge("dev-both");

    const res = await rpc("setVolumeDb", { deviceId: "dev-both", db: -6 });

    expect(res.ok).toBe(true);
    expect(nativePlayer.setVolumeDb).toHaveBeenCalledTimes(1);
    expect(nativePlayer.setVolumeDb).toHaveBeenCalledWith(-6);
    expect(bridgePlayer.setVolumeDb).not.toHaveBeenCalled();
  });

  it("③ native 与桥都不在场:不抛异常、返回 null,且重复调用幂等", async () => {
    const first = await rpc("setVolumeDb", { deviceId: "dev-ghost", db: -20 });
    expect(first.ok).toBe(true);
    expect(first.result).toBeNull();

    // 幂等:同样的请求再来一次仍然正常回包(音量是旁路能力,绝不能因"找不到会话"报错)
    const second = await rpc("setVolumeDb", { deviceId: "dev-ghost", db: -20 });
    expect(second.ok).toBe(true);
    expect(second.result).toBeNull();
  });

  it("④ db=0(最大音量)原样传 0:不得被 || 短路成 -144(native 与桥两条路都要验)", async () => {
    const nativePlayer = attachNative("dev-zero-native");
    const bridgePlayer = attachBridge("dev-zero-bridge");

    await rpc("setVolumeDb", { deviceId: "dev-zero-native", db: 0 });
    expect(nativePlayer.setVolumeDb).toHaveBeenCalledWith(0);
    expect(nativePlayer.setVolumeDb).not.toHaveBeenCalledWith(-144);

    await rpc("setVolumeDb", { deviceId: "dev-zero-bridge", db: 0 });
    expect(bridgePlayer.setVolumeDb).toHaveBeenCalledWith(0);
    expect(bridgePlayer.setVolumeDb).not.toHaveBeenCalledWith(-144);
  });

  it("⑤ db 非有限数(NaN / Infinity / 垃圾字符串)→ 落 -144 静音", async () => {
    const nativePlayer = attachNative("dev-bad-native");
    const bridgePlayer = attachBridge("dev-bad-bridge");

    await rpc("setVolumeDb", { deviceId: "dev-bad-native", db: Number.NaN });
    expect(nativePlayer.setVolumeDb).toHaveBeenLastCalledWith(-144);

    await rpc("setVolumeDb", { deviceId: "dev-bad-native", db: Number.POSITIVE_INFINITY });
    expect(nativePlayer.setVolumeDb).toHaveBeenLastCalledWith(-144);

    await rpc("setVolumeDb", { deviceId: "dev-bad-native", db: "not-a-number" });
    expect(nativePlayer.setVolumeDb).toHaveBeenLastCalledWith(-144);

    // 桥回路同样要兜底(回落路径不能把 NaN 直接写进 SET_PARAMETER volume)
    await rpc("setVolumeDb", { deviceId: "dev-bad-bridge", db: Number.NaN });
    expect(bridgePlayer.setVolumeDb).toHaveBeenLastCalledWith(-144);
  });

  it("BridgeSessionManager.setVolumeDb:按 deviceId 命中返回 true,未命中 false", () => {
    const { session, player } = realBridgeSession("dev-mgr");
    const mgr = new BridgeSessionManager();
    ((mgr as Any).sessions as Map<string, BridgeSession>).set(session.token, session);

    expect(mgr.setVolumeDb("dev-mgr", -9)).toBe(true);
    expect(player.setVolumeDb).toHaveBeenCalledWith(-9);

    expect(mgr.setVolumeDb("dev-other", -9)).toBe(false);
    expect(player.setVolumeDb).toHaveBeenCalledTimes(1); // 未命中不得误发
  });

  it("BridgeSession.setVolumeDb:player 未就绪(null)与抛错都只 warn,绝不冒泡", () => {
    const { session } = realBridgeSession("dev-null");
    (session as Any).player = null;
    expect(() => session.setVolumeDb(-3)).not.toThrow();

    (session as Any).player = {
      setVolumeDb: () => {
        throw new Error("socket closed");
      },
    };
    expect(() => session.setVolumeDb(-3)).not.toThrow(); // 音量失败不得打断推流
  });
});
