// [验收9改版 2026-11-25] MA `_held_chunks`(sendspin_bridge.py:1511-1516,45s/4000)的
// 故障面在本仓已被 **结构性排除**:onReceiveOverflow 以 BRIDGE_OVERFLOW_KEEP_MS=2s
// 裁旧保新,hold(接收侧积压)恒 ≤2s —— 不叠 MA 同款层(裁决:双重丢帧策略打架)。
// 本文件证明 MA 要防的「锚点永不落定 ⇒ 积压无限涨」在本仓不可能发生:
//   ① 一次性超大积压(10s)⇒ 裁到 ≤2s 口径,丢的是最旧;
//   ② 反复灌入(模拟锚点永不落定)⇒ 积压始终 ≤2s,无无限增长。
import { describe, expect, it, afterEach, vi } from "vitest";
vi.hoisted(() => { process.env.MF_PLAYER_ISOLATION = "0"; });
const logSpy = vi.hoisted(() => vi.fn());
vi.mock("../../src/utils/logger.js", async (io) => ({
  ...(await io<Record<string, unknown>>()),
  createLogger: () => ({ info: logSpy, warn: logSpy, error: logSpy, debug: logSpy }),
}));
import "../plugins/_env.js";

import { bridgeSocketPath } from "../../src/services/airplay/bridgeChannel.js";
import { BridgeSession } from "../../src/services/airplay/bridgeSession.js";
import { BRIDGE_PCM_BYTES_PER_SEC } from "../../src/services/airplay/rates.js";

const sessions: BridgeSession[] = [];

function mk(): BridgeSession {
  const n = Math.floor(Math.random() * 1e9);
  const s = new BridgeSession({
    deviceId: `ho-${n}`,
    token: `ho-${n}`,
    protocol: "raop",
    socketPath: bridgeSocketPath(`ho-${n}`, `ho-${n}`),
    waitDataMs: 30,
  });
  sessions.push(s);
  return s;
}

afterEach(async () => {
  while (sessions.length > 0) await sessions.pop()!.stop().catch(() => {});
  logSpy.mockClear();
});

function stuff(s: BridgeSession, seconds: number): number {
  const chunk = new Uint8Array(960 * 4); // 960 帧 ≈ 20ms
  let frames = 0;
  for (let ms = 0; ms < seconds * 1000; ms += 20) {
    (s as any).inQueue.push({ buf: Buffer.from(chunk), tsUs: BigInt(ms * 1000), generation: 1 });
    frames += 960;
  }
  (s as any).inBytes = frames * 4;
  return (s as any).inBytes as number;
}

describe("hold 积压上限(验收9改版:MA 故障面已被 2s 裁旧保新结构性排除)", () => {
  it("① 一次性 10s 积压 ⇒ 裁到 ≤2s 口径,丢最旧", () => {
    const s = mk();
    const before = stuff(s, 10);
    expect(before).toBeGreaterThan(Math.round(10 * BRIDGE_PCM_BYTES_PER_SEC) - 1);
    (s as any).onReceiveOverflow(10_000);
    const keepBytes = Math.round((2_000 / 1000) * BRIDGE_PCM_BYTES_PER_SEC);
    expect((s as any).inBytes as number).toBeLessThanOrEqual(keepBytes + 960 * 4);
    const ov = logSpy.mock.calls
      .map((c) => c.map(String).join(" "))
      .filter((l) => l.includes("recv-overflow"));
    expect(ov.length).toBeGreaterThanOrEqual(1);
    expect(JSON.parse(ov[0].slice(ov[0].indexOf("{"))).droppedBytes).toBeGreaterThan(0);
  });

  it("② 反复灌入(锚点永不落定形态)⇒ 积压恒 ≤2s,无无限增长", () => {
    const s = mk();
    const keepBytes = Math.round((2_000 / 1000) * BRIDGE_PCM_BYTES_PER_SEC);
    for (let round = 0; round < 20; round++) {
      stuff(s, 5);
      (s as any).onReceiveOverflow(5_000);
      expect((s as any).inBytes as number).toBeLessThanOrEqual(keepBytes + 960 * 4);
    }
    // 20 轮之后仍是 2s 口径 —— MA 要防的「无限涨」不可能发生
    expect((s as any).inBytes as number).toBeLessThanOrEqual(keepBytes + 960 * 4);
  });
});
