// ==================== 广播投递闭环：bridgeBroadcastTick 集成级单测 ====================
//
// 纯函数(contentDemand.test.ts)钉边界，这里钉**接线**（5fdf0657 复核时发现的两个
// 结构性风险，2026-11-24 修复）：
//   ① 环空放行（A2）：闸门/需求计算必须在 `if (ring && ring.length > 0)` **之外** ——
//      环空那拍 tailUs=0 ⇒ 按「内容不足」放行泵。旧版包在环判空里，起播/换代瞬间
//      请求挂着、泵不产出、环保持空 ⇒ 死锁形状。
//   ② 游标对称跳回（A1）：落后跳（弃历史）之外，游标被旧开环版本推到窗口之外
//      （> now+2s）也要跳回 now，否则设备饿到 now 追上游标为止（最长 57s 静音）。
//   ③ 内容充足（环尾 ≥ now+30s，对齐 MA _PRODUCER_BUFFER_LIMIT_US）⇒ 不放行。
import { describe, it, expect, afterEach, beforeAll, vi } from "vitest";
// 广播投递开关在**调用期**读 env（isolationFlag.ts），hoisted 置位保证任何时机都成立。
vi.hoisted(() => {
  process.env.MF_PLAYER_ISOLATION = "1";
  process.env.MF_PLAYER_BROADCAST = "1";
});
import "../plugins/_env.js";
import { initDatabase } from "../../src/db/index.js";
import { SendspinGroup } from "../../src/services/sendspin/server.js";
import { nowUs } from "../../src/services/sendspin/clock.js";
import { paceBumpBus } from "../../src/services/sendspin/paceBumpBus.js";

/** 最小桥句柄桩：bridgeBroadcastTick 只会碰 queuedMs / pushAudio。 */
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
/** 建组：stub server（记录日志供跳转断言）+ 预挂桥句柄。 */
function groupWith(bridges: ReturnType<typeof bridgeStub>[]) {
  const logs: string[] = [];
  const g = new SendspinGroup("g-broadcast-demand", {
    log: (level: string, msg: string) => logs.push(`${level}|${msg}`),
  } as any);
  (g as any).logs = logs;
  for (const b of bridges) g.bridges.set(b.deviceId, b as any);
  liveGroups.push(g);
  return g;
}

/** 往 pcm:100 组环里塞一帧当前代次内容（25ms 粒度，与生产侧 batch 同口径）。 */
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

/** 预登记当前代次：否则首拍「换代分支」会把预设游标重置成 0（测不到跳转）。 */
function seedEpoch(g: SendspinGroup): string {
  const key = (g as any).encoderKey("pcm", 100);
  (g as any).bcEpoch.set(key, (g as any).bridgeContentEpoch);
  return key;
}

describe("bridgeBroadcastTick — 泵闸门接线", () => {
  it("① 环空 + 设备水位未知 ⇒ 放行泵（闸门在环判空之外，起播不死锁）", () => {
    const b = bridgeStub("ap-1");
    const g = groupWith([b]);
    paceBumpBus.add(500);
    (g as any).bridgeBroadcastTick(nowUs());
    // 放行 = pending 转入 approved，泵可取走
    expect(paceBumpBus.takeApproved()).toBe(500);
    expect(paceBumpBus.peek()).toBe(0);
  });

  it("①b 环空 + 设备水位落后（已投到 now+250ms）⇒ 同样放行（环空恒视为内容不足）", () => {
    const b = bridgeStub("ap-1");
    const g = groupWith([b]);
    const now = nowUs();
    const key = (g as any).encoderKey("pcm", 100);
    // 第一拍：投一帧，让 sink 的 lastTsUs 落在 now+250ms（真实成功投递记录）
    addRingFrame(g, now + 250_000n);
    (g as any).bridgeBroadcastTick(now);
    expect(b.pushed.length).toBeGreaterThan(0);
    // 第二拍：环已空（模拟泵尚未产出），设备水位落后于 now+2s ⇒ 应放行泵
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
    // 单帧即可代表前沿：tailUs 取环里当前代次最后一帧的 ts
    addRingFrame(g, now + 31_000_000n);
    paceBumpBus.add(500);
    (g as any).bridgeBroadcastTick(now);
    expect(paceBumpBus.takeApproved()).toBe(0);
    expect(paceBumpBus.peek()).toBe(500); // 挂起，未被消费
  });
});

describe("bridgeBroadcastTick — 游标对称跳转接线", () => {
  it("② 游标落后 1.5s ⇒ 跳回 now（dir=behind）+ warn，窗口内帧照常投出", () => {
    const b = bridgeStub("ap-1");
    const g = groupWith([b]);
    const now = nowUs();
    addRingFrame(g, now + 250_000n); // 窗口 [now−200ms, now+2s] 内
    const key = seedEpoch(g);
    (g as any).bcCursor.set(key, now - 1_500_000n);
    (g as any).bridgeBroadcastTick(now);
    const jump = (g as any).logs.find((l: string) => l.includes("bridge-broadcast-cursor-jump")) as string;
    expect(jump).toBeDefined();
    expect(jump).toContain("dir=behind");
    expect(jump).toContain("deltaMs=1500");
    // 跳回 now 后：帧 ts=now+250ms > cursor=now ⇒ 投给设备
    expect(b.pushed.length).toBeGreaterThan(0);
    expect((g as any).bcCursor.get((g as any).encoderKey("pcm", 100))).toBe(now + 250_000n);
  });

  it("②b 游标超前 10s（旧开环热切遗留态）⇒ 跳回 now（dir=ahead）+ warn，窗口内帧照常投出", () => {
    const b = bridgeStub("ap-1");
    const g = groupWith([b]);
    const now = nowUs();
    addRingFrame(g, now + 250_000n);
    const key = seedEpoch(g);
    (g as any).bcCursor.set(key, now + 10_000_000n);
    (g as any).bridgeBroadcastTick(now);
    const jump = (g as any).logs.find((l: string) => l.includes("bridge-broadcast-cursor-jump")) as string;
    expect(jump).toBeDefined();
    expect(jump).toContain("dir=ahead");
    expect(jump).toContain("deltaMs=-10000");
    // 跳回 now 后：帧不再被超前游标挡住 ⇒ 投给设备
    expect(b.pushed.length).toBeGreaterThan(0);
  });

  it("②c 游标紧贴 now（窗口内正常态）⇒ 不打跳转日志", () => {
    const b = bridgeStub("ap-1");
    const g = groupWith([b]);
    const now = nowUs();
    addRingFrame(g, now + 250_000n);
    const key = seedEpoch(g);
    (g as any).bcCursor.set(key, now);
    (g as any).bridgeBroadcastTick(now);
    expect((g as any).logs.some((l: string) => l.includes("bridge-broadcast-cursor-jump"))).toBe(false);
  });
});
