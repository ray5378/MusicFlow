// [组A 2026-11-25] 桥侧 retime 自估 + lightRestart 的回归钉。
// 覆盖缺口来源:守卫三级(bridgeLateSelfheal.test.ts)只测 sendspin 侧 selfhealBus
// 上行;桥侧 rebuildForShift 的 late-selfheal-retime 分支(自估/基线防重放/10s 门)
// 与 lightRestart(清管线+flush,绝不 reconnectRaop)是执行体,必须独立钉死。
// MA 出处:sendspin_bridge.py:1411-1446(_absorb_playout_shift 折回口径)、
// :640-693(_restart_transport 清管线不拆连接)。
import { describe, it, expect, vi, beforeAll } from "vitest";
vi.hoisted(() => {
  process.env.MF_PLAYER_ISOLATION = "1";
});
import "../plugins/_env.js";
import { initDatabase } from "../../src/db/index.js";
import { BridgeSession, BridgeSessionManager } from "../../src/services/airplay/bridgeSession.js";

function makeSession(fields: Record<string, unknown> = {}): any {
  const s = Object.create(BridgeSession.prototype) as any;
  s.deviceId = "dev-x";
  s.closed = false;
  s.closedAt = null;
  s.ap2Session = null;
  s.generation = 7;
  s.lastRetimeLateTotal = 0;
  s.player = { bridgeLateCount: 0, flush: vi.fn() };
  s.aligner = {};
  s.anchors = {};
  s.anchorUs = 123n;
  s.commandedLeadUs = 456;
  s.firstPacketLeadUs = 789;
  s.firstFrameTsUs = 111n;
  s.streamAborted = false;
  Object.assign(s, fields);
  return s;
}

beforeAll(() => {
  if (!process.env.APP_VERSION) process.env.APP_VERSION = "1.0.0";
  initDatabase();
});

describe("组A: 桥侧 retime 自估 + lightRestart(MA :1411-1446 / :640-693 对齐)", () => {
  it("① 无新增 late(基线相等) ⇒ skip 不平移(无证据不动作,禁止猜测当实测),返回 true", async () => {
    const s = makeSession();
    const spy = vi.spyOn(BridgeSession.prototype as any, "applyAnchorShift");
    const ok = await s.rebuildForShift(0, "late-selfheal-retime");
    expect(ok).toBe(true);
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it("② 新增 late 500 帧(基线 1000 → 现值 1500) ⇒ 自估 shift=500×7980=3_990_000 并平移,基线推进", async () => {
    const s = makeSession({ lastRetimeLateTotal: 1000, player: { bridgeLateCount: 1500, flush: vi.fn() } });
    const spy = vi.spyOn(BridgeSession.prototype as any, "applyAnchorShift").mockReturnValue(true);
    const ok = await s.rebuildForShift(0, "late-selfheal-retime");
    expect(ok).toBe(true);
    expect(spy).toHaveBeenCalledWith(3_990_000);
    expect(s.lastRetimeLateTotal).toBe(1500); // 基线推进(防重放)
    spy.mockRestore();
  });

  it("③ 自估超 10s 门(2000 帧 ≈ 15.96s) ⇒ skip 不平移(过深错位 retime 救不动,让位二级)", async () => {
    const s = makeSession({ lastRetimeLateTotal: 0, player: { bridgeLateCount: 2000, flush: vi.fn() } });
    const spy = vi.spyOn(BridgeSession.prototype as any, "applyAnchorShift");
    const ok = await s.rebuildForShift(0, "late-selfheal-retime");
    expect(ok).toBe(true);
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it("④ 非 selfheal reason(delay-change) ⇒ shift 原样平移(自估分支不介入,D9 路径不变)", async () => {
    const s = makeSession();
    const spy = vi.spyOn(BridgeSession.prototype as any, "applyAnchorShift").mockReturnValue(true);
    const ok = await s.rebuildForShift(500_000, "delay-change");
    expect(ok).toBe(true);
    expect(spy).toHaveBeenCalledWith(500_000);
    spy.mockRestore();
  });

  it("⑤ lightRestart: 锚点/对齐器/首帧时戳全清 + streamAborted + flush 恰一次(不拆 socket)", () => {
    const s = makeSession();
    const flushSpy = s.player.flush;
    const ok = s.lightRestart("late-selfheal-light-restart");
    expect(ok).toBe(true);
    expect(s.firstFrameTsUs).toBeNull();
    expect(s.aligner).toBeNull();
    expect(s.anchors).toBeNull();
    expect(s.anchorUs).toBeNull();
    expect(s.commandedLeadUs).toBeNull();
    expect(s.firstPacketLeadUs).toBeNull();
    expect(s.streamAborted).toBe(true);
    expect(flushSpy).toHaveBeenCalledTimes(1);
  });

  it("⑥ manager.lightRestart 按 deviceId 分发(命中 true / 未命中 false)", () => {
    const m = Object.create(BridgeSessionManager.prototype) as any;
    m.sessions = new Map();
    const s = makeSession();
    m.sessions.set("tok-x", s);
    m.pruneClosed = BridgeSessionManager.prototype.pruneClosed;
    expect(m.lightRestart("dev-x", "r")).toBe(true);
    expect(m.lightRestart("dev-none", "r")).toBe(false);
  });

  it("⑦ closed 会话 ⇒ rebuildForShift/lightRestart 均返回 false(生命周期闸)", async () => {
    const s = makeSession({ closed: true });
    expect(await s.rebuildForShift(0, "late-selfheal-retime")).toBe(false);
    expect(s.lightRestart("r")).toBe(false);
  });
});
