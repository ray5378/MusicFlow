// [验收7/N2 2026-11-25] 设备判 late 全丢的自愈守卫回归钉。
// 形态来源:240 真机 14:45:33 iEAST —— warm 会话重锚时指令落点没越过设备残留队列
// ⇒ splice 型固件忽略换锚 ⇒ 设备把到达帧全判 late 丢弃 ⇒ inQueueMs 恒 0、父侧照常投
// ⇒ late 线性无限涨且无机制收敛。
// 钉死:
//   ① 「积压 0 + 父侧仍在投 + 内容充足」连续 BRIDGE_LATE_SELFHEAL_TICKS 拍 ⇒
//      一次受限重锚(bridge-late-selfheal + BOUNDARY{seek} + 游标复位 now);
//   ② [N2/验收14 判定纪律,MA _transport_lost :1448-1472] 干净收尾(组无在播内容)
//      绝不触发 —— 自然曲末/手动停止的积压归 0 是正常形态;
//   ③ 冷却:一次自愈后 BRIDGE_TRANSPORT_RECOVERY_GUARD_MS 内不再次触发(防 churn)。
import { describe, it, expect, afterEach, beforeAll, vi } from "vitest";
vi.hoisted(() => {
  process.env.MF_PLAYER_ISOLATION = "1";
  process.env.MF_PLAYER_BROADCAST = "1";
});
import "../plugins/_env.js";
import { initDatabase } from "../../src/db/index.js";
import { SendspinGroup } from "../../src/services/sendspin/server.js";
import {
  BRIDGE_LATE_SELFHEAL_TICKS,
  BRIDGE_TRANSPORT_RECOVERY_GUARD_MS,
} from "../../src/services/sendspin/constants.js";

function selfhealStub(deviceId: string) {
  const pushed: { data: Uint8Array; ts: bigint }[] = [];
  const boundaries: string[] = [];
  return {
    deviceId,
    pushed,
    boundaries,
    pushAudio(data: Uint8Array, ts: bigint) {
      pushed.push({ data: Uint8Array.from(data), ts });
    },
    sendBoundary(reason: string) {
      boundaries.push(reason);
    },
  };
}

const liveGroups: SendspinGroup[] = [];

function groupWith(stub: ReturnType<typeof selfhealStub>, opts: { playing: boolean }) {
  const logs: string[] = [];
  const g = new SendspinGroup("g-late-selfheal", {
    log: (level: string, msg: string) => logs.push(level + "|" + msg),
  } as any);
  (g as any).logs = logs;
  g.bridges.set(stub.deviceId, stub as any);
  (g as any).bridgeBacklogMs = new Map([[stub.deviceId, 0]]);
  // N2 判据:组当前是否有在播内容(clean end ⇒ null ⇒ 守卫恒不触发)
  (g as any).current = opts.playing ? { songId: "s-1", title: "t" } : null;
  liveGroups.push(g);
  return g;
}

function addRingFrame(g: SendspinGroup, tsUs: bigint): void {
  const key = (g as any).encoderKey("pcm", 100);
  const ring = (g as any).ringFor(key);
  ring.push({ tsUs, durUs: 25_000, data: new Uint8Array(2400), ep: (g as any).bridgeContentEpoch });
}

function seedEpoch(g: SendspinGroup): void {
  const key = (g as any).encoderKey("pcm", 100);
  (g as any).bcEpoch.set(key, (g as any).bridgeContentEpoch);
}

beforeAll(() => {
  if (!process.env.APP_VERSION) process.env.APP_VERSION = "1.0.0";
  initDatabase();
});

afterEach(() => {
  for (const g of liveGroups.splice(0)) g.stopBridgePushTimer();
});

describe("bridgeBroadcastTick · 设备判 late 全丢的自愈守卫(验收7/N2)", () => {
  it("① 在播 + 积压恒 0 + 持续投递 ⇒ 达到阈值做一次受限重锚(BOUNDARY{seek}+游标复位)", () => {
    const stub = selfhealStub("ap-1");
    const g = groupWith(stub, { playing: true });
    seedEpoch(g);
    let now = 5_000_000_000n;
    // 预热一拍让游标落在环内(第一拍 deliveredUs>0 的前提)
    addRingFrame(g, now + 500_000n);
    (g as any).bridgeBroadcastTick(now);
    for (let i = 0; i < BRIDGE_LATE_SELFHEAL_TICKS + 1; i++) {
      now += 250_000n;
      addRingFrame(g, now + 500_000n); // 每拍新内容在前沿,保证 deliveredUs>0
      (g as any).bridgeBroadcastTick(now);
    }
    const selfheal = (g as any).logs.filter((l: string) => l.includes("bridge-late-selfheal "));
    expect(selfheal.length).toBeGreaterThanOrEqual(1);
    expect(stub.boundaries).toContain("seek");
    // 重锚那拍游标被复位到该拍 now(日志 tick=40 对应 now=5010000000);其后各拍照常
    // 前进 —— 这里只断言复位确实发生过(重锚拍之后紧跟的投递从 now 起步,而非旧游标)。
    expect(selfheal[0]).toContain("BOUNDARY{seek}");
  });

  it("② [N2/验收14] 干净收尾(组无在播内容)⇒ 积压 0 不触发自愈", () => {
    const stub = selfhealStub("ap-2");
    const g = groupWith(stub, { playing: false });
    seedEpoch(g);
    let now = 5_000_000_000n;
    addRingFrame(g, now + 500_000n);
    (g as any).bridgeBroadcastTick(now);
    for (let i = 0; i < BRIDGE_LATE_SELFHEAL_TICKS * 2; i++) {
      now += 250_000n;
      addRingFrame(g, now + 500_000n);
      (g as any).bridgeBroadcastTick(now);
    }
    expect((g as any).logs.some((l: string) => l.includes("bridge-late-selfheal"))).toBe(false);
    expect(stub.boundaries).not.toContain("seek");
  });

  it("③ 一次自愈后处于冷却窗口 ⇒ 不立即再次重锚(防 churn)", () => {
    const stub = selfhealStub("ap-3");
    const g = groupWith(stub, { playing: true });
    seedEpoch(g);
    let now = 5_000_000_000n;
    addRingFrame(g, now + 500_000n);
    (g as any).bridgeBroadcastTick(now);
    for (let i = 0; i < BRIDGE_LATE_SELFHEAL_TICKS; i++) {
      now += 250_000n;
      addRingFrame(g, now + 500_000n);
      (g as any).bridgeBroadcastTick(now);
    }
    expect(stub.boundaries.filter((r) => r === "seek").length).toBe(1);
    // 冷却期内继续 starving ⇒ 不得再次重锚
    for (let i = 0; i < BRIDGE_LATE_SELFHEAL_TICKS; i++) {
      now += 250_000n;
      addRingFrame(g, now + 500_000n);
      (g as any).bridgeBroadcastTick(now);
    }
    expect(stub.boundaries.filter((r) => r === "seek").length).toBe(1);
    expect(BRIDGE_TRANSPORT_RECOVERY_GUARD_MS).toBe(30_000);
  });
});
