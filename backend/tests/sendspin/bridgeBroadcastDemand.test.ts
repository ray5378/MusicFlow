// ==================== 广播投递闭环：bridgeBroadcastTick 集成级单测（每设备游标版）====================
//
// 钉的是接线（纯函数边界在 contentDemand.test.ts）：
//   ① 闸门在环判空**之外**：环空那拍 tailUs=0 ⇒ 按「内容不足」放行泵（起播/换代不死锁）。
//   ② 游标对称跳转按**设备键**（bcCursor 以 deviceId 存取，不是组键）：
//      落后 >500ms 跳到可听域下沿（dir=behind，deltaMs 为负）；
//      超前 >2s 跳回 now（dir=ahead，deltaMs 为正）——ahead 跳回后游标必须 = now，
//      窗口内帧才能照常投出（钉死「跳回 now」修复；旧实现设成 ceil 导致白跳）。
//   ③ 内容充足（环尾 ≥ now+30s，对齐 MA _PRODUCER_BUFFER_LIMIT_US）⇒ 请求挂起不放行。
import { describe, it, expect, afterEach, beforeAll, vi } from "vitest";
vi.hoisted(() => {
  process.env.MF_PLAYER_ISOLATION = "1";
  process.env.MF_PLAYER_BROADCAST = "1";
});
import "../plugins/_env.js";
import { initDatabase } from "../../src/db/index.js";
import { SendspinGroup } from "../../src/services/sendspin/server.js";
import { nowUs } from "../../src/services/sendspin/clock.js";
import { paceBumpBus } from "../../src/services/sendspin/paceBumpBus.js";

function bridgeStub(deviceId: string) {
  const pushed: { data: Uint8Array; ts: bigint }[] = [];
  return {
    deviceId,
    pushed,
    queuedMs: undefined as number | undefined,
    pushAudio(data: Uint8Array, ts: bigint) {
      pushed.push({ data: Uint8Array.from(data), ts });
    },
  };
}

const liveGroups: SendspinGroup[] = [];
function groupWith(bridges: ReturnType<typeof bridgeStub>[]) {
  const logs: string[] = [];
  const g = new SendspinGroup("g-broadcast-demand", {
    log: (level: string, msg: string) => logs.push(level + "|" + msg),
  } as any);
  (g as any).logs = logs;
  for (const b of bridges) g.bridges.set(b.deviceId, b as any);
  liveGroups.push(g);
  return g;
}

function addRingFrame(g: SendspinGroup, tsUs: bigint, durUs = 25_000): void {
  const key = (g as any).encoderKey("pcm", 100);
  const ring = (g as any).ringFor(key);
  ring.push({ tsUs, durUs, data: new Uint8Array(2400), ep: (g as any).bridgeContentEpoch });
}

beforeAll(() => {
  if (!process.env.APP_VERSION) process.env.APP_VERSION = "1.0.0";
  initDatabase();
});

afterEach(() => {
  paceBumpBus.reset();
  for (const g of liveGroups.splice(0)) g.stopBridgePushTimer();
});

function seedEpoch(g: SendspinGroup): void {
  const key = (g as any).encoderKey("pcm", 100);
  (g as any).bcEpoch.set(key, (g as any).bridgeContentEpoch);
}

describe("bridgeBroadcastTick — 泵闸门接线", () => {
  it("① 环空 + 设备水位未知 ⇒ 放行泵（闸门在环判空之外，起播不死锁）", () => {
    const b = bridgeStub("ap-1");
    const g = groupWith([b]);
    paceBumpBus.add(500);
    (g as any).bridgeBroadcastTick(nowUs());
    expect(paceBumpBus.takeApproved()).toBe(500);
    expect(paceBumpBus.peek()).toBe(0);
  });

  it("①b 环空 + 设备水位落后（已投到 now+250ms）⇒ 同样放行（环空恒视为内容不足）", () => {
    const b = bridgeStub("ap-1");
    const g = groupWith([b]);
    const now = nowUs();
    const key = (g as any).encoderKey("pcm", 100);
    addRingFrame(g, now + 250_000n);
    (g as any).bridgeBroadcastTick(now);
    expect(b.pushed.length).toBeGreaterThan(0);
    (g as any).recentByGroup.delete(key);
    const now2 = now + 1_000_000n;
    paceBumpBus.add(300);
    (g as any).bridgeBroadcastTick(now2);
    expect(paceBumpBus.takeApproved()).toBe(300);
    expect(paceBumpBus.peek()).toBe(0);
  });

  it("③ 内容充足（环尾超前 31s ≥ 30s 上限）⇒ 请求保持挂起不放行", () => {
    const b = bridgeStub("ap-1");
    const g = groupWith([b]);
    const now = nowUs();
    addRingFrame(g, now + 31_000_000n);
    paceBumpBus.add(500);
    (g as any).bridgeBroadcastTick(now);
    expect(paceBumpBus.takeApproved()).toBe(0);
    expect(paceBumpBus.peek()).toBe(500);
  });
});

describe("bridgeBroadcastTick — 游标对称跳转接线（按设备键）", () => {
  // ahead = 该组投递戳换算量（内容 ts 比墙钟超前的常量）。桩环境下动态取，
  // 使测试不依赖具体数值（真机组 ≈4.8s）。
  function aheadOf(g: SendspinGroup): bigint {
    return BigInt(Math.round((g as any).commonSendAheadUs()));
  }

  it("② 游标落后 1.5s（调度锚定后）⇒ 无跳转，积压帧按 now 调度补发（快进追赶）", () => {
    const b = bridgeStub("ap-1");
    const g = groupWith([b]);
    const now = nowUs();
    const A = aheadOf(g);
    seedEpoch(g);
    const seeded = now + A - 1_500_000n; // 名义游标落后墙钟 1.5s
    const frameTs = seeded + 250_000n;
    addRingFrame(g, frameTs);
    (g as any).bcCursor.set("ap-1", seeded);
    (g as any).bridgeBroadcastTick(now);
    // 调度锚定后无 behind 跳转：积压帧按 now 起排补发（无迟到）
    expect((g as any).logs.some((l: string) => l.includes("bridge-cursor-jump") && l.includes("dir=behind"))).toBe(false);
    expect(b.pushed.length).toBeGreaterThan(0);
    expect((g as any).bcCursor.get("ap-1")).toBe(frameTs);
  });

  it("②b 游标超前 10s（旧开环热切遗留态）⇒ dir=ahead 跳回 now，可听域帧照常投出", () => {
    const b = bridgeStub("ap-1");
    const g = groupWith([b]);
    const now = nowUs();
    const A = aheadOf(g);
    seedEpoch(g);
    (g as any).bcCursor.set("ap-1", now + A + 10_000_000n);
    // 可听域内的帧：内容 ts ∈ [now+A−200ms, now+A+2s]
    const frameTs = now + A + 250_000n;
    addRingFrame(g, frameTs);
    (g as any).bridgeBroadcastTick(now);
    const jump = (g as any).logs.find((l: string) => l.includes("bridge-cursor-jump")) as string;
    expect(jump).toBeDefined();
    expect(jump).toContain("dir=ahead");
    expect(jump).toContain("deltaMs=" + Math.round(Number(now + A + 10_000_000n - now) / 1000));
    expect(b.pushed.length).toBeGreaterThan(0);
    // ahead 跳回后游标先 = now，随后帧被投出 ⇒ 游标推进到该帧 ts（= now + A + 250ms）
    expect((g as any).bcCursor.get("ap-1")).toBe(now + A + 250_000n);
  });

  it("②c 游标贴着可听域下沿（正常稳态：内容超前墙钟 ≈ ahead）⇒ 不打跳转日志", () => {
    const b = bridgeStub("ap-1");
    const g = groupWith([b]);
    const now = nowUs();
    const A = aheadOf(g);
    seedEpoch(g);
    addRingFrame(g, now + A + 2_100_000n);
    (g as any).bcCursor.set("ap-1", now + A + 1_800_000n);
    (g as any).bridgeBroadcastTick(now);
    expect((g as any).logs.some((l: string) => l.includes("bridge-cursor-jump"))).toBe(false);
  });
});
