// v4.9.7 RAOP 重连互斥门回归测试
//
// 事故链(240 实证 2026-10-29 05:33:00,HiVi/MUZO 00226CFFA0C0):
//   ① v4.9.6 的 liveness 看门狗把「设备停发 NTP timing 请求 120s」判成假死
//      (该机曲目后半段正常播放时就停发,每分钟 20 次的 3s 心跳在 05:31/05:32 完整消失,
//       而同一段 45739 chunks / 365.1s 全程健康播完)
//   ② reconnectRaop() 在 await player.connect() 窗口内,maybeBeginStream 在 oldPlayer
//      上起了新流(05:33:00.388 anchor)
//   ③ connect 完成后 oldPlayer.forceClose() 把刚起 0.3~0.6s 的新流当场掐断
//      (05:33:00.708 sendChunk false destroying=true)
//   ④ .then() 见 !streamAborted(被 ② 复位) 再调度重连 ⇒ 6 轮 / 36s 无声死循环
//   ⑤ 直到 onBoundary 换代把流起在正确实例上才恢复
//
// 修法:窗口内禁止起流 + 重连重入直接返回(内层 finally 不得复位外层门)。
import "../plugins/_env.js";

import { afterEach, describe, expect, it, vi } from "vitest";
import { bridgeSocketPath } from "../../src/services/airplay/bridgeChannel.js";
import {
  BridgeSession,
  livenessBreakerState,
  noteLivenessFire,
  resetLivenessBreaker,
} from "../../src/services/airplay/bridgeSession.js";

const sessions: BridgeSession[] = [];

function mkSession(): BridgeSession {
  const n = Math.floor(Math.random() * 1e9);
  const s = new BridgeSession({
    deviceId: `rg-${n}`,
    token: `rg-${n}`,
    protocol: "raop",
    socketPath: bridgeSocketPath(`rg-${n}`, `rg-${n}`),
    dry: true,
    waitDataMs: 50,
  });
  sessions.push(s);
  return s;
}

afterEach(async () => {
  while (sessions.length > 0) await sessions.pop()!.stop().catch(() => {});
});

describe("v4.9.7 RAOP 重连互斥门(修复 36s 无声死循环)", () => {
  it("重连窗口内 maybeBeginStream 不起流(aligner/anchors 保持 null)", async () => {
    const s = mkSession();
    await s.start();
    const any = s as any;
    // 绕过 dry 早退,把判据推到真正的门位置
    any.opts.dry = false;
    any.connected = true;
    any.firstFrameTsUs = 1000000n;
    // 模拟 player.connect() 仍未返回
    any.raopReconnectInFlight = true;
    await any.maybeBeginStream();
    expect(any.aligner).toBeNull();
    expect(any.anchors).toBeNull();
  });

  it("重连窗口内再次 reconnectRaop 直接返回:不新建 player,且不复位外层门", async () => {
    const s = mkSession();
    await s.start();
    const any = s as any;
    any.connected = true;
    const before = any.player;
    any.raopReconnectInFlight = true;
    await any.reconnectRaop();
    expect(any.player).toBe(before);
    // 关键:内层因门早退,不应在 finally 里把外层门复位(否则互斥失效)
    expect(any.raopReconnectInFlight).toBe(true);
  });

  it("门关闭后 maybeBeginStream 恢复可起流(门不是永久锁死)", async () => {
    const s = mkSession();
    await s.start();
    const any = s as any;
    any.opts.dry = false;
    any.connected = true;
    any.firstFrameTsUs = 1000000n;
    // 最小 player/会话桩:够 maybeBeginStream 走到 planBridgeAnchor 并落锚。
    any.player = {
      lastDeviceSignalAt: Date.now(),
      negotiatedLatencyFrames: 44100,
      streamBridge: () => Promise.resolve(),
    };
    any.raopSession = {};
    // 不设门 ⇒ 应走到 planBridgeAnchor 之后(锚点写入)
    await any.maybeBeginStream();
    expect(any.anchors).not.toBeNull();
    expect(any.anchorUs).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// v4.10.1:看门狗重连之后「新会话永不进 live」的根因修复
//
// 事故链(240 实证 2026-10-30 04:21:37–04:21:44):
//   ① 看门狗判定心跳停止 ⇒ reconnectRaop();
//   ② connect() 的 await 窗口(~0.5s)内 bridge 侧照常送 AUDIO 帧,这些帧把
//      firstFrameTsUs 设好,并在 maybeBeginStream 里因 raopReconnectInFlight=true 早退;
//   ③ finally 只复位了门,没有补一次起流判定;而 ingestAudio 只在 firstFrameTsUs
//      由 null→非null 的那一帧才触发起流 ⇒ 从此没人再触发;
//   ④ 结果 aligner 恒 null = 没有消费者,接收侧积压按实时速率涨到 8s
//      ⇒ §4.4 overflow 断连 ⇒ 发送侧再等 ~6s rehost(tick 一直是 state:"connected",
//      全程没有一个 ev:"anchor")。
// 于是看门狗只手握 0.5s 的动作,被放大成两次断音合计 ~14s。
// ---------------------------------------------------------------------------
describe("v4.10.1 重连后补起流判定 + overflow 清积压", () => {
  it("★ 重连结束后必须补一次起流判定(无论 connect 成不成)", async () => {
    const s = mkSession();
    await s.start();
    const any = s as any;
    any.opts.dry = false;
    any.connected = true;
    const spy = vi.spyOn(any, "maybeBeginStream");
    await any.reconnectRaop();
    expect(spy).toHaveBeenCalled();
    // 门必须复位,否则后续永远不起流
    expect(any.raopReconnectInFlight).toBe(false);
  });

  it("★ 心跳健康即解除熔断(C-3:熔断状态是模块级、跨会话永生,不许把活设备钉住)", async () => {
    const s = mkSession();
    await s.start();
    const any = s as any;
    any.connected = true;
    // 先把该设备的熔断窗口填满
    noteLivenessFire(s.deviceId, Date.now() - 2000, true);
    noteLivenessFire(s.deviceId, Date.now() - 1000, true);
    expect(livenessBreakerState(s.deviceId).fireAt.length).toBe(2);
    // 设备确实在发心跳 ⇒ tick 里必须解除
    any.player = { lastTimingAt: Date.now(), timingCount: 7, bridgeLateCount: 0 };
    any.aligner = null;
    any.emitStatsTick();
    expect(livenessBreakerState(s.deviceId).fireAt.length).toBe(0);
    resetLivenessBreaker(s.deviceId);
  });

  it("★ 有 player 却无消费者且积压很厚 ⇒ 主动补一次起流(C-4 自愈)", async () => {
    const s = mkSession();
    await s.start();
    const any = s as any;
    any.connected = true;
    any.player = { lastTimingAt: Date.now(), timingCount: 1, bridgeLateCount: 0 };
    any.aligner = null;
    any.inBytes = 48000 * 4 * 2; // 2s 的 48k s16le 立体声
    any.noConsumerSince = Date.now() - 9000;
    const spy = vi.spyOn(any, "maybeBeginStream").mockResolvedValue(undefined);
    any.emitStatsTick();
    expect(spy).toHaveBeenCalledTimes(1);
    // 触发后必须重置计时,避免每 2s 刷一次日志/调用
    expect(Date.now() - any.noConsumerSince).toBeLessThan(1000);
  });

  it("★ 接收侧 overflow 必须丢弃无消费者的积压 PCM(in/out 一并清)", async () => {
    const s = mkSession();
    await s.start();
    const any = s as any;
    any.inQueue = [Buffer.alloc(64), Buffer.alloc(64)];
    any.inBytes = 128;
    any.outBuf = Buffer.alloc(256);
    any.onReceiveOverflow(8025);
    expect(any.inBytes).toBe(0);
    expect(any.inQueue.length).toBe(0);
    expect(any.outBuf.length).toBe(0);
  });
});
