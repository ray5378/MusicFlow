// [验收10 2026-11-25] 传输死亡恢复守卫 + rejoin 上限回归钉。
// MA 出处:sendspin_bridge.py :1481-1490(恢复后 30s 内再死 ⇒ error+放弃+移出,
// 防 churn)与 :1196-1219(BRIDGE_REJOIN_ATTEMPT_DELAYS=(5,30),两次用尽保持移出)。
// 钉死:
//   ① 尝试用尽(attempt ≥ BRIDGE_REJOIN_ATTEMPT_MAX)⇒ transportGiveUp,error 留痕,
//      不再排程重连(timer 为空、attempt 不再增长);
//   ② 30s 恢复守卫:恢复成功后守卫窗内再死 ⇒ 立即放弃(即使 attempt=0);
//   ③ 已放弃 ⇒ reconnectRaop 直接返回(看门狗直调路径也被闸住,现场保留);
//   ④ 正常单次死亡(首次、无恢复史)⇒ 照常排程(不误伤)。
import "../plugins/_env.js";

import { afterEach, describe, expect, it, vi } from "vitest";
import { bridgeSocketPath } from "../../src/services/airplay/bridgeChannel.js";
import { BridgeSession } from "../../src/services/airplay/bridgeSession.js";
import { BRIDGE_REJOIN_ATTEMPT_MAX } from "../../src/services/airplay/rates.js";
import { BRIDGE_TRANSPORT_RECOVERY_GUARD_MS } from "../../src/services/sendspin/constants.js";

const sessions: BridgeSession[] = [];
const logSpy = vi.hoisted(() => vi.fn());
vi.mock("../../src/utils/logger.js", async (io) => ({
  ...(await io<Record<string, unknown>>()),
  createLogger: () => ({ info: logSpy, warn: logSpy, error: logSpy, debug: logSpy }),
}));

function mk(): BridgeSession {
  const n = Math.floor(Math.random() * 1e9);
  const s = new BridgeSession({
    deviceId: `tu-${n}`,
    token: `tu-${n}`,
    protocol: "raop",
    socketPath: bridgeSocketPath(`tu-${n}`, `tu-${n}`),
    dry: true,
    waitDataMs: 50,
  });
  sessions.push(s);
  return s;
}

afterEach(async () => {
  while (sessions.length > 0) await sessions.pop()!.stop().catch(() => {});
  logSpy.mockClear();
});

const giveUpLines = () =>
  logSpy.mock.calls.map((c) => c.map(String).join(" ")).filter((l) => l.includes("raop transport give-up"));

describe("传输恢复守卫 + rejoin 上限(验收10/MA (5,30))", () => {
  it("① 尝试用尽 ⇒ 放弃 + error 留痕 + 不再排程", () => {
    const s = mk();
    const any = s as any;
    any.raopReconnectAttempt = BRIDGE_REJOIN_ATTEMPT_MAX;
    any.scheduleRaopReconnect("test-exhausted");
    expect(any.transportGivenUp).toBe(true);
    expect(any.raopReconnectTimer ?? null).toBeNull();
    expect(any.raopReconnectAttempt).toBe(BRIDGE_REJOIN_ATTEMPT_MAX); // 不再增长
    expect(giveUpLines().length).toBe(1);
    expect(giveUpLines()[0]).toContain("rejoin attempts exhausted");
    expect(BRIDGE_REJOIN_ATTEMPT_MAX).toBe(2);
  });

  it("② 30s 恢复守卫:恢复窗内再死 ⇒ 立即放弃(即使 attempt=0)", () => {
    const s = mk();
    const any = s as any;
    any.lastRecoveryAtMs = Date.now() - 5_000; // 5s 前刚恢复成功
    any.scheduleRaopReconnect("test-within-guard");
    expect(any.transportGivenUp).toBe(true);
    expect(any.raopReconnectTimer ?? null).toBeNull();
    expect(giveUpLines()[0]).toContain("died again within 30s");
    expect(BRIDGE_TRANSPORT_RECOVERY_GUARD_MS).toBe(30_000);
  });

  it("③ 已放弃 ⇒ reconnectRaop 直接返回(看门狗直调路径同闸)", async () => {
    const s = mk();
    const any = s as any;
    any.connected = true;
    any.transportGivenUp = true;
    const before = any.player;
    await any.reconnectRaop();
    expect(any.player).toBe(before);
    expect(any.raopReconnectInFlight).toBe(false);
  });

  it("④ 首次死亡(无恢复史、attempt=0)⇒ 照常排程,不误伤", () => {
    const s = mk();
    const any = s as any;
    any.scheduleRaopReconnect("test-first-death");
    expect(any.transportGivenUp).toBe(false);
    expect(any.raopReconnectTimer).not.toBeNull();
    expect(any.raopReconnectAttempt).toBe(1);
    clearTimeout(any.raopReconnectTimer);
  });
});
