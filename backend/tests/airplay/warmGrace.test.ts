// [裁决2/F7 2026-11-25] warm grace(流结束保活等复用)回归钉。
// MA BRIDGE_WARM_GRACE_SECONDS=4s(sendspin_bridge.py:81-85):流结束后保活等下一次
// 复用、真停(显式)立即拆。本仓生命周期**严格更长**:stop 边界只停推流,会话/RAOP
// socket 保留到显式 bridgeStop —— 故钉两例:
//   ① F7-3s 例:stop 边界后再播(新 gen 帧)⇒ **同一会话**重新锚定起流,绝不触发
//      reconnectRaop(warm 复用,无冷连);
//   ② F7-真停例:显式 stop ⇒ closed=true,会话拆除(编排侧 bridgeStop 的会话侧落点)。
import { describe, expect, it, vi, afterEach } from "vitest";
vi.hoisted(() => { process.env.MF_PLAYER_ISOLATION = "0"; });
const logSpy = vi.hoisted(() => vi.fn());
vi.mock("../../src/utils/logger.js", async (io) => ({
  ...(await io<Record<string, unknown>>()),
  createLogger: () => ({ info: logSpy, warn: logSpy, error: logSpy, debug: logSpy }),
}));
import "../plugins/_env.js";

import { bridgeSocketPath } from "../../src/services/airplay/bridgeChannel.js";
import { BridgeSession } from "../../src/services/airplay/bridgeSession.js";
import type { RaopSession } from "../../src/services/airplay/raop.js";

const sessions: BridgeSession[] = [];

function mk(): BridgeSession {
  const n = Math.floor(Math.random() * 1e9);
  const s = new BridgeSession({
    deviceId: `wg-${n}`,
    token: `wg-${n}`,
    protocol: "raop",
    socketPath: bridgeSocketPath(`wg-${n}`, `wg-${n}`),
    waitDataMs: 30,
  });
  sessions.push(s);
  return s;
}

function fakePlayer() {
  return {
    negotiatedLatencyFrames: 44100,
    timingCount: 3,
    lastTimingAt: Date.now(),
    streamBridge: vi.fn(() => new Promise<void>(() => { /* 常驻 */ })),
    pause: vi.fn(),
    resume: vi.fn(),
    flush: vi.fn(),
    forceClose: vi.fn(),
    stop: vi.fn(async () => {}),
    isStreaming: true,
    bridgeLateCount: 0,
  };
}

function injectConnected(s: BridgeSession, player: ReturnType<typeof fakePlayer>): void {
  (s as any).connected = true;
  (s as any).player = player;
  (s as any).raopSession = { session: "t", audioPort: 7000, controlPort: 7001, timingPort: 7002 } as RaopSession;
}

function feed(s: BridgeSession, tsUs: bigint, generation: number): void {
  (s as any).ingestAudio({ tsUs, generation, sequence: 1, payload: new Uint8Array(960 * 4) });
}

afterEach(async () => {
  while (sessions.length > 0) await sessions.pop()!.stop().catch(() => {});
  logSpy.mockClear();
});

describe("warm grace(F7/裁决2):流结束保活等复用,真停立即拆", () => {
  it("① F7-3s 例:stop 边界后同一会话重新锚定起流,无 reconnectRaop", async () => {
    const s = mk();
    const player = fakePlayer();
    injectConnected(s, player);
    feed(s, 4_000_000_000n, 1);
    await new Promise((r) => setTimeout(r, 30));
    expect((s as any).aligner).not.toBeNull();
    // 真 stop 边界(用户停止):停推流,会话保留
    (s as any).onBoundary(2, "stop");
    expect((s as any).aligner).toBeNull();
    expect((s as any).closed).toBe(false); // 会话仍活(等待复用)
    // 3s 内再播:新 gen 帧进来 ⇒ 同一会话重新锚定(warm 复用)
    feed(s, 5_000_000_000n, 3);
    await new Promise((r) => setTimeout(r, 30));
    expect((s as any).aligner).not.toBeNull();
    expect(player.streamBridge).toHaveBeenCalledTimes(2); // 同一 player 再次起流
    // 绝不触发 RAOP 重连(warm 复用,无冷连)
    expect((s as any).raopReconnectTimer ?? null).toBeNull();
    const reconnectLogs = logSpy.mock.calls
      .map((c) => c.map(String).join(" "))
      .filter((l) => l.includes("raop reconnect in"));
    expect(reconnectLogs.length).toBe(0);
  });

  it("② F7-真停例:显式 stop ⇒ 会话拆除(closed)", async () => {
    const s = mk();
    const player = fakePlayer();
    injectConnected(s, player);
    feed(s, 4_000_000_000n, 1);
    await new Promise((r) => setTimeout(r, 30));
    await s.stop();
    expect((s as any).closed).toBe(true);
    expect(player.stop).toHaveBeenCalled();
  });
});
