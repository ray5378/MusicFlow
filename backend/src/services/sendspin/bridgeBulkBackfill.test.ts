// 开局 bulk 投递(曲中失声根因修复)单测:换代后 tick 发现本代新料 ≥6s 时对每座桥
// 一次性批量投递(分片 + setImmediate 让出);不足 6s 不硬投;严格 ts 升序。
// 全部直接驱动 bridgePushTick(公开给单测确定性驱动),时间用 setNowUsOverride 冻结。
import { describe, it, expect, afterEach } from "vitest";
import { SendspinServer, SendspinGroup } from "./server.js";
import type { BridgeBoundaryReason } from "../airplay/bridgeChannel.js";
import { setNowUsOverride } from "./clock.js";
import { BRIDGE_BACKFILL_MAX_US, BRIDGE_PUSH_TICK_MS } from "./constants.js";

const PCM_KEY = "pcm:100";
// 组无成员 → computeCommonSendAhead 回落 DEFAULT_MIN_BUFFER_MS(800ms)。
const SEND_AHEAD_US = 800_000;
const AHEAD = BigInt(SEND_AHEAD_US);
const NOW = 1_000_000_000n;
const FRAME_US = 20_000; // 20ms/帧(与既有投递用例同口径)

type RingEntry = { tsUs: bigint; durUs: number; data: Uint8Array; ep?: number };

// 事件轮次计数:stub 在 pushAudio 时记录当前轮次,用于断言「分片之间真的让出了
// 事件循环」(一次性猛灌 = 全部帧落在同一轮次;分片 = ≥2 个轮次)。
let turnCounter = 0;

/** 带队列账本的桥桩:sinceDrain 超过 capFrames 即判断连(模拟 Tx 侧 hardCap);
 *  pushTurns 记录每次 push 所处的事件轮次。 */
class TrackingBridge {
  readonly deviceId: string;
  frames: Array<{ ts: bigint }> = [];
  pushTurns = new Set<number>();
  sinceDrain = 0;
  disconnected = false;
  capFrames = Number.POSITIVE_INFINITY;
  constructor(deviceId: string) {
    this.deviceId = deviceId;
  }
  pushAudio(_pcm: Uint8Array, tsUs: bigint): void {
    if (this.disconnected) throw new Error("disconnected");
    this.sinceDrain += 1;
    if (this.sinceDrain > this.capFrames) {
      this.disconnected = true;
      throw new Error("hardCap exceeded");
    }
    this.pushTurns.add(turnCounter);
    this.frames.push({ ts: tsUs });
  }
  notifyGeneration(_generation: number, _reason: BridgeBoundaryReason): void {}
  sendBoundary(_reason: BridgeBoundaryReason): void {}
  stop(): void {}
  drain(): void {
    this.sinceDrain = 0;
  }
}

const groups: SendspinGroup[] = [];

function makeGroup(): { g: SendspinGroup; ring: RingEntry[]; durByTs: Map<string, number> } {
  const server = { log: () => {} } as unknown as SendspinServer;
  const g = new SendspinGroup("t", server);
  const ring: RingEntry[] = [];
  (g as any).recentByGroup.set(PCM_KEY, ring);
  groups.push(g);
  return { g, ring, durByTs: new Map() };
}

/** 注入一帧(ep 由调用方给;换代后必须 = bridgeContentEpoch)。 */
function frame(ring: RingEntry[], durByTs: Map<string, number>, tsUs: bigint, ep: number, durUs = FRAME_US): void {
  ring.push({ tsUs, durUs, data: new Uint8Array([1, 2, 3]), ep });
  durByTs.set(tsUs.toString(), durUs);
}

/** 注入 [fromXUs, toXUs] 步长 FRAME_US 的当前代次帧(ts = NOW+AHEAD+X)。 */
function injectRange(ring: RingEntry[], durByTs: Map<string, number>, ep: number, fromXUs: number, toXUs: number): void {
  for (let x = fromXUs; x <= toXUs; x += FRAME_US) {
    frame(ring, durByTs, NOW + AHEAD + BigInt(x), ep);
  }
}

function deliveredDurUs(b: TrackingBridge, durByTs: Map<string, number>): number {
  return b.frames.reduce((acc, f) => acc + (durByTs.get(f.ts.toString()) ?? 0), 0);
}

/** 驱动 tick 启动 bulk 并等它跑完(期间逐轮 drain 桩队列,模拟 Tx 侧消化)。 */
async function runBulk(g: SendspinGroup, bridges: TrackingBridge[]): Promise<void> {
  g.bridgePushTick();
  for (let i = 0; i < 500; i++) {
    if ((g as any).bridgeBulkInFlight.size === 0) return;
    turnCounter += 1;
    await new Promise((r) => setImmediate(r));
    for (const b of bridges) b.drain();
  }
}

afterEach(() => {
  setNowUsOverride(null);
  for (const g of groups) g.stopBridgePushTimer();
  groups.length = 0;
});

describe("桥开局 bulk 投递(曲中失声根因修复)", () => {
  it("(a) 换代后对每座桥各触发一次 bulk:一次性灌入 ≤6s、严格升序、水位登记后 tick 不重投且领先封顶", async () => {
    setNowUsOverride(() => NOW);
    const { g, ring, durByTs } = makeGroup();
    const b1 = new TrackingBridge("d1");
    const b2 = new TrackingBridge("d2");
    g.bridges.set("d1", b1 as any);
    g.bridges.set("d2", b2 as any);
    g.notifyBridgeGeneration(2, "track"); // epoch 0→1;两桥登记 pending
    const ep = (g as any).bridgeContentEpoch as number;
    injectRange(ring, durByTs, ep, 500_000, 9_000_000); // lo(1.5s)之上存量 7.5s ≥ 6s
    await runBulk(g, [b1, b2]);

    for (const b of [b1, b2]) {
      const dur = deliveredDurUs(b, durByTs);
      // 单次 ≤ BRIDGE_BACKFILL_MAX_US(6s),且确实是把存量灌到位(≥5.9s)
      expect(dur).toBeLessThanOrEqual(BRIDGE_BACKFILL_MAX_US);
      expect(dur).toBeGreaterThanOrEqual(5_900_000);
      // 严格 ts 升序(锚点由首帧锁定,乱序打歪时间线)
      for (let i = 1; i < b.frames.length; i++) {
        expect(b.frames[i].ts).toBeGreaterThan(b.frames[i - 1].ts);
      }
      // 全部落在可听域窗口底之上(lo = NOW+1.5s)
      expect(b.frames[0].ts).toBeGreaterThanOrEqual(NOW + 1_500_000n);
      // floor 之下的帧(X<1.5s)绝不出现
      expect(b.frames.every((f) => f.ts >= NOW + 1_500_000n)).toBe(true);
    }
    // pending 已消费:同 NOW 再 tick 不得重投已投帧,也不得凭空放大领先量。
    // [Fix D 2026-10-31] 旧断言写的是「帧数完全不变」——那是把窗口死锁当契约:
    // 窗口恒为 (watermark, hi],而 bulk 建立的领先量远高于 hi,两者同速前进 ⇒ 窗口
    // 永远为空 ⇒ bulk 的 6s 吃完即断粮(真机:bulk 4.625s 吃完 → rebase +2.768s)。
    // 正确语义 = ① 绝不重投已投帧(严格 ts 升序且大于 bulk 末帧);② 稳态 tick 至多
    // 把水位补到 lo+BRIDGE_BACKFILL_MAX_US 这个领先硬上限。
    const before1 = b1.frames.length;
    const before2 = b2.frames.length;
    const lastTs1 = b1.frames[before1 - 1].ts;
    const lastTs2 = b2.frames[before2 - 1].ts;
    g.bridgePushTick();
    const leadCapTs = NOW + AHEAD + 1_500_000n + BigInt(BRIDGE_BACKFILL_MAX_US);
    for (const [b, lastTs, before] of [
      [b1, lastTs1, before1] as const,
      [b2, lastTs2, before2] as const,
    ]) {
      for (let i = before; i < b.frames.length; i++) {
        expect(b.frames[i].ts).toBeGreaterThan(lastTs);
      }
      // 单次 tick 的产量上限(tick 时长换算成帧数)
      expect(b.frames.length - before).toBeLessThanOrEqual(Math.ceil((BRIDGE_PUSH_TICK_MS * 1_000) / FRAME_US));
      // 领先量不超过 lo+6s 硬上限(否则会一路追到泵预填充前沿,顶穿接收端 8s 红线)
      expect(b.frames[b.frames.length - 1].ts).toBeLessThanOrEqual(leadCapTs);
    }
  });

  it("(b) 本代新料不足 6s ⇒ 不硬投(pending 保留,只走常态 1s 窗口 tick)", async () => {
    setNowUsOverride(() => NOW);
    const { g, ring, durByTs } = makeGroup();
    const b = new TrackingBridge("d1");
    g.bridges.set("d1", b as any);
    g.notifyBridgeGeneration(2, "track");
    const ep = (g as any).bridgeContentEpoch as number;
    injectRange(ring, durByTs, ep, 500_000, 3_000_000); // lo 之上存量仅 1.5s < 6s
    g.bridgePushTick();
    await new Promise((r) => setImmediate(r));

    expect((g as any).bridgeBulkPending.has("d1")).toBe(true);
    expect((g as any).bridgeBulkInFlight.has("d1")).toBe(false);
    // 只走了常态窗口投递([1.5s, 2.5s] ≈ 1s),没有任何 bulk 超量灌入
    const dur = deliveredDurUs(b, durByTs);
    expect(dur).toBeGreaterThan(0);
    expect(dur).toBeLessThanOrEqual(1_100_000);
    expect(b.frames.every((f) => f.ts >= NOW + 1_500_000n && f.ts <= NOW + 2_500_000n)).toBe(true);
  });

  it("(c) bulk 与常态 tick 并发交错,桥收到的帧仍严格 ts 升序", async () => {
    setNowUsOverride(() => NOW);
    const { g, ring, durByTs } = makeGroup();
    const b = new TrackingBridge("d1");
    g.bridges.set("d1", b as any);
    g.notifyBridgeGeneration(2, "track");
    const ep = (g as any).bridgeContentEpoch as number;
    injectRange(ring, durByTs, ep, 500_000, 9_000_000);
    // bulk 分片让出期间反复驱动 tick(模拟真实 250ms 定时器并发)
    g.bridgePushTick();
    for (let i = 0; i < 100 && (g as any).bridgeBulkInFlight.size > 0; i++) {
      turnCounter += 1;
      g.bridgePushTick();
      await new Promise((r) => setImmediate(r));
      b.drain();
    }
    expect((g as any).bridgeBulkInFlight.size).toBe(0);
    for (let i = 1; i < b.frames.length; i++) {
      expect(b.frames[i].ts).toBeGreaterThan(b.frames[i - 1].ts);
    }
    expect(deliveredDurUs(b, durByTs)).toBeLessThanOrEqual(BRIDGE_BACKFILL_MAX_US + 1_000_000);
  });

  it("(d) 分片之间让出事件循环:小 hardCap 桩不断连,且 push 跨 ≥2 个事件轮次", async () => {
    setNowUsOverride(() => NOW);
    const { g, ring, durByTs } = makeGroup();
    const b = new TrackingBridge("d1");
    // 小 hardCap:自上次 drain 起 >100 帧(2s)即判断连 —— 一次性猛灌 300 帧(6s)
    // 必断连;分片(每片 250ms ≈ 13 帧)+ 片间让出则每轮只累积 ≤13 帧。
    b.capFrames = 100;
    g.bridges.set("d1", b as any);
    g.notifyBridgeGeneration(2, "track");
    const ep = (g as any).bridgeContentEpoch as number;
    injectRange(ring, durByTs, ep, 500_000, 9_000_000);
    await runBulk(g, [b]);

    expect(b.disconnected).toBe(false);
    expect(deliveredDurUs(b, durByTs)).toBeGreaterThanOrEqual(5_900_000);
    // 分片让出的直接证据:push 分布在 ≥2 个事件轮次(旧的一次性实现 = 1 个轮次)
    expect(b.pushTurns.size).toBeGreaterThanOrEqual(2);
  });
});
