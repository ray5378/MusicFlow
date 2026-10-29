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

import { afterEach, describe, expect, it } from "vitest";
import { bridgeSocketPath } from "../../src/services/airplay/bridgeChannel.js";
import { BridgeSession } from "../../src/services/airplay/bridgeSession.js";

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
