// 桥投递可听域窗口化(§6.2,2026-10-25)单测:窗口三边 / 回填窗口+上限 /
// BOUNDARY 代次重置(旧代次过滤) / 摘桥清桥生命周期清理。
// 全部直接驱动 bridgePushTick(公开给单测确定性驱动),不依赖真实定时器;
// 时间用 setNowUsOverride 冻结,保证窗口边界判定完全确定。
import { describe, it, expect, afterEach } from "vitest";
import { SendspinServer, SendspinGroup } from "./server.js";
import type { BridgeBoundaryReason } from "../airplay/bridgeChannel.js";
import {
  syncGroupBridges,
  detachGroupBridge,
  clearGroupBridges,
  type BridgeSocketSpec,
} from "./bridgeAttach.js";
import { setNowUsOverride } from "./clock.js";
import { BRIDGE_BACKFILL_MAX_US } from "./constants.js";

const PCM_KEY = "pcm:100";
// 组无成员 → computeCommonSendAhead 回落 DEFAULT_MIN_BUFFER_MS(800ms)。
const SEND_AHEAD_US = 800_000;
// 投递窗口判定在**原始 ts 域**执行(边界 = 可听域窗口 +sendAhead),故注入帧同样抬 +AHEAD,
// 帧仍落在「+1.0s=floor 下 / +2.0s=窗内 / +3.0s=horizon 上」的位置。
const AHEAD = BigInt(SEND_AHEAD_US);
// 注:注入帧已抬 +AHEAD，交付侧再减一次 ahead ⇒ 桥收 ts = NOW + X，断言不再单独减 SEND_AHEAD_US。
const NOW = 1_000_000_000n;

type RingEntry = { tsUs: bigint; durUs: number; data: Uint8Array; ep?: number };

/** 最小桥桩:只记录收到的帧/BOUNDARY/代次通知。 */
class StubBridge {
  readonly deviceId: string;
  frames: Array<{ ts: bigint; data: Uint8Array }> = [];
  gens: Array<{ generation: number; reason: BridgeBoundaryReason }> = [];
  boundaries: BridgeBoundaryReason[] = [];
  stopped = false;
  constructor(deviceId: string) {
    this.deviceId = deviceId;
  }
  pushAudio(pcm: Uint8Array, tsUs: bigint): void {
    this.frames.push({ ts: tsUs, data: pcm });
  }
  notifyGeneration(generation: number, reason: BridgeBoundaryReason): void {
    this.gens.push({ generation, reason });
  }
  sendBoundary(reason: BridgeBoundaryReason): void {
    this.boundaries.push(reason);
  }
  stop(): void {
    this.stopped = true;
  }
}

/** 真 SendspinGroup + 桩 server(构造器只存字段,无副作用);ring 手工注入。 */
function makeGroup(): { g: SendspinGroup; ring: RingEntry[] } {
  const server = { log: () => {} } as unknown as SendspinServer;
  const g = new SendspinGroup("t", server);
  const ring: RingEntry[] = [];
  (g as any).recentByGroup.set(PCM_KEY, ring);
  return { g, ring };
}

function frame(ring: RingEntry[], tsUs: bigint, durUs = 20_000, ep = 0): void {
  ring.push({ tsUs, durUs, data: new Uint8Array([1, 2, 3]), ep });
}

afterEach(() => {
  setNowUsOverride(null);
});

describe("桥投递可听域窗口化", () => {
  it("窗口三边:floor 丢弃 / 窗口内做 ts−sendAhead 转换投递 / horizon 顺延到下一 tick", () => {
    setNowUsOverride(() => NOW);
    const { g, ring } = makeGroup();
    const b = new StubBridge("d1");
    g.bridges.set("d1", b as any);
    frame(ring, NOW + AHEAD + 1_000_000n); // < now+FLOOR(1.5s) → 丢弃
    frame(ring, NOW + AHEAD + 2_000_000n); // ∈ [1.5s, 2.5s] → 投递
    frame(ring, NOW + AHEAD + 3_000_000n); // > now+HORIZON(2.5s) → 顺延
    g.bridgePushTick();
    expect(b.frames.length).toBe(1);
    // 投递转换:ts' = ts − commonSendAheadUs(无成员回落 800ms)。
    expect(b.frames[0].ts).toBe(NOW + 2_000_000n);
    // 推进 1s 再 tick:顺延帧进入窗口被投;floor 丢弃帧永不出现。
    setNowUsOverride(() => NOW + 1_000_000n);
    g.bridgePushTick();
    expect(b.frames.length).toBe(2);
    expect(b.frames[1].ts).toBe(NOW + 3_000_000n);
    expect(b.frames.every((f) => f.ts !== NOW + 1_000_000n)).toBe(true);
  });

  it("backfillBridge:只回填窗口内、做转换、登记水位,后续 tick 不重复投递", () => {
    setNowUsOverride(() => NOW);
    const { g, ring } = makeGroup();
    const b = new StubBridge("d1");
    g.bridges.set("d1", b as any);
    frame(ring, NOW + AHEAD + 1_000_000n); // 窗口下:不回填
    frame(ring, NOW + AHEAD + 2_000_000n); // 窗口内
    frame(ring, NOW + AHEAD + 2_400_000n); // 窗口内
    frame(ring, NOW + AHEAD + 3_000_000n); // 窗口上:顺延
    expect(g.backfillBridge("d1")).toBe(2);
    expect(b.frames.map((f) => f.ts)).toEqual([
      NOW + 2_000_000n,
      NOW + 2_400_000n,
    ]);
    // 水位已登记:同 now 再 tick 不重复;窗口外帧等时间推进后由 tick 补投。
    g.bridgePushTick();
    expect(b.frames.length).toBe(2);
    setNowUsOverride(() => NOW + 1_000_000n);
    g.bridgePushTick();
    expect(b.frames.length).toBe(3);
    expect(b.frames[2].ts).toBe(NOW + 3_000_000n);
  });

  it("backfillBridge:总量上限跳过异常大帧继续扫(不整体断流)", () => {
    setNowUsOverride(() => NOW);
    const { g, ring } = makeGroup();
    const b = new StubBridge("d1");
    g.bridges.set("d1", b as any);
    frame(ring, NOW + AHEAD + 2_000_000n, BRIDGE_BACKFILL_MAX_US + 1_000_000); // 单帧超上限 → 跳过
    frame(ring, NOW + AHEAD + 2_200_000n, 20_000); // 正常帧 → 回填
    expect(g.backfillBridge("d1")).toBe(1);
    expect(b.frames.length).toBe(1);
    expect(b.frames[0].ts).toBe(NOW + 2_200_000n);
  });

  it("notifyBridgeGeneration:旧代次帧被过滤(即使落在新窗口内),水位清零后新代次正常投递", () => {
    setNowUsOverride(() => NOW);
    const { g, ring } = makeGroup();
    const b = new StubBridge("d1");
    g.bridges.set("d1", b as any);
    frame(ring, NOW + AHEAD + 2_000_000n); // ep0:投递 → 水位 = 此 ts
    g.bridgePushTick();
    expect(b.frames.length).toBe(1);
    frame(ring, NOW + AHEAD + 2_200_000n); // ep0 旧代次帧,仍在 ring 且在新窗口内
    g.notifyBridgeGeneration(2, "seek");
    expect(b.gens).toEqual([{ generation: 2, reason: "seek" }]);
    // 新代次帧,ts 低于旧水位 —— 若未清水位会被误跳(中途 seek 场景)。
    frame(ring, NOW + AHEAD + 1_900_000n, 20_000, 1);
    g.bridgePushTick();
    expect(b.frames.length).toBe(2);
    expect(b.frames[1].ts).toBe(NOW + 1_900_000n);
    // ep0 的 NOW+2.2s 帧虽然落在窗口内也不投(代次过滤,防旧 cursor 误投)。
    expect(b.frames.every((f) => f.ts !== NOW + 2_200_000n)).toBe(true);
  });

  it("生命周期:sync 启定时器,摘桥/清桥停表并清水位,空转 tick 安全", () => {
    setNowUsOverride(() => NOW);
    const { g, ring } = makeGroup();
    const specs: BridgeSocketSpec[] = [
      { deviceId: "d1", socketPath: "/tmp/a.sock", token: "t1", protocol: "ap2" as any },
    ];
    syncGroupBridges(g as any, specs, (s) => new StubBridge(s.deviceId) as any);
    expect(g.bridges.size).toBe(1);
    expect((g as any).bridgePushTimer).toBeDefined(); // sync → 补投定时器在跑
    frame(ring, NOW + AHEAD + 2_000_000n);
    g.bridgePushTick();
    expect((g as any).bridgeWatermarks.get("d1")).toBe(NOW + AHEAD + 2_000_000n);
    // 单桥摘除:水位清除;最后一座桥摘除 → 停表。
    detachGroupBridge(g as any, "d1");
    expect((g as any).bridgeWatermarks.has("d1")).toBe(false);
    expect((g as any).bridgePushTimer).toBeUndefined();
    // 清桥路径(clearGroupBridges):句柄 stop + 停表 + 清水位。
    syncGroupBridges(g as any, specs, (s) => new StubBridge(s.deviceId) as any);
    const h = g.bridges.get("d1") as any;
    clearGroupBridges(g as any);
    expect(h.stopped).toBe(true);
    expect((g as any).bridgePushTimer).toBeUndefined();
    expect(g.bridges.size).toBe(0);
    expect(() => g.bridgePushTick()).not.toThrow(); // 空转安全
  });
});
