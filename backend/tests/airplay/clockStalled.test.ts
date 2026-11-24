// [验收11 2026-11-25] MA ClockReadiness.STALLED(:903-911)姿态回归钉:
//   ① 设备时钟一直未就绪(timing 心跳 0 次)⇒ 打 warning(clock-stalled)**且照常锚定**
//      —— 停下会掐死音箱,stall 不足以证明该弃;
//   ② 报告逐锚定周期重臂:第二次起流(锚点复位后再次 begin)仍会再打一行;
//   ③ 时钟已就绪(timingCount>0)⇒ 不打。
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
    deviceId: `st-${n}`,
    token: `st-${n}`,
    protocol: "raop",
    socketPath: bridgeSocketPath(`st-${n}`, `st-${n}`),
    waitDataMs: 30,
  });
  sessions.push(s);
  return s;
}

function fakePlayer(timingCount: number) {
  return {
    negotiatedLatencyFrames: 44100,
    timingCount,
    lastTimingAt: timingCount > 0 ? Date.now() : 0,
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

function stalledLines(): string[] {
  return logSpy.mock.calls
    .map((c) => c.map(String).join(" "))
    .filter((l) => l.includes("clock-stalled"));
}

afterEach(async () => {
  while (sessions.length > 0) await sessions.pop()!.stop().catch(() => {});
  logSpy.mockClear();
});

describe("clock-stalled 姿态(验收11/MA STALLED)", () => {
  it("① 时钟未就绪 ⇒ warning 且锚定照常(aligner 建立、anchor 事件发出)", async () => {
    const s = mk();
    injectConnected(s, fakePlayer(0));
    feed(s, 4_000_000_000n, 1);
    await new Promise((r) => setTimeout(r, 30));
    expect((s as any).aligner).not.toBeNull();
    expect(stalledLines().length).toBeGreaterThanOrEqual(1);
    expect(stalledLines()[0]).toContain("anchoring anyway");
  });

  it("② 时钟已就绪(timingCount>0)⇒ 不打 clock-stalled", async () => {
    const s = mk();
    injectConnected(s, fakePlayer(3));
    feed(s, 4_000_000_000n, 1);
    await new Promise((r) => setTimeout(r, 30));
    expect((s as any).aligner).not.toBeNull();
    expect(stalledLines().length).toBe(0);
  });

  it("③ 逐周期重臂:复位锚点后再次起流 ⇒ 再次报告", async () => {
    const s = mk();
    const player = fakePlayer(0);
    injectConnected(s, player);
    feed(s, 4_000_000_000n, 1);
    await new Promise((r) => setTimeout(r, 30));
    const first = stalledLines().length;
    expect(first).toBeGreaterThanOrEqual(1);
    // 换代复位锚点 ⇒ 下一帧重新走 maybeBeginStream ⇒ 报告重臂
    (s as any).streamAborted = true;
    (s as any).aligner = null;
    (s as any).anchors = null;
    (s as any).anchorUs = null;
    (s as any).firstFrameTsUs = null;
    feed(s, 5_000_000_000n, 2);
    await new Promise((r) => setTimeout(r, 30));
    expect(stalledLines().length).toBeGreaterThan(first);
  });
});
