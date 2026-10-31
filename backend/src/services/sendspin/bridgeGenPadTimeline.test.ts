// 切歌垫片(pendingTrackLeadUs)时间线 / bulk 触发与投递量 / 稳态窗口对位回归。
//
// ── 历史(为什么这个文件长这样)────────────────────────────────────────────
// 真机两次失败,把「垫片」的语义钉死成**逐帧衰减**(D2 结论):
//
//  run① ad294ae2(衰减语义 + `hi = lo + 6s`):判据成立但只投 1.725s
//      (`bridge-bulk durUs=1725000`),桥 2.7s 无米下锅 ⇒
//      `bridge pacing rebase +2765314µs` ⇒ tick late ~125/s、deltaUs 恒负。
//      → Fix C:去掉按 lo 起算的 `hi` 位置上界,6s 改由内容量(capUs)兜。
//      → Fix B:触发判据从 `currentGenTailUs - lo`(位置)改成
//               `currentGenDeliverableUs`(内容量)。
//
//  run② Fix A(把垫片改为「每代次常数偏移」,整代 ts 统一 +Δ 且不衰减):
//      确实修好了 run① 的一切(bulk 投满 `durUs=6000000`),但**稳态彻底打死**:
//      `lo/hi` 是按 **now** 建立的、且不含垫片 ⇒ 常数垫片让 ring 内容 ts 永久比
//      窗口高 Δ ⇒ 每 tick `e.tsUs > hi` 一帧投不出 ⇒ bulk 的 6s 吃完即断粮
//      (真机 `pacing rebase +2764901µs idx=752`,752×352/44100 = 6.0000s,
//       恰好等于 bulk 投递量)。→ **D2 完整回退 Fix A,只留 Fix B + Fix C。**
//
// ── 衰减语义的精确模型(本文件所有断言都基于它,已与真机 240 帧实测对齐)──
//   设代次开始后泵游标从 `cursor0` 起按 1x 推进、垫片 = Δ:
//       ts(b) = cursor0 + max(b × 25ms, Δ)
//   即:代次开头 0~Δ 这段内容 ring ts **恒定**(= 内容起点 + Δ,衰减量与游标推进
//   等量相消),Δ 之后恢复严格 1:1 递增。实测旁证:240 帧 + Δ=4.5s 时
//   `distinctTs=60/240`(1 + 59)、`spanUs=1475000`(= 239×25ms − 4.5s)、
//   `nonMono=180`,与本模型逐位吻合。
//
//   ⇒「代次开头 ts 不前进」是**已知既有行为**(v4.10.6 同此),本版显式钉住、
//     不再当 bug 修;它的正解是让投递窗口感知垫片(D1:lo/hi 同时 + pad,
//     与 currentGenDeliverableUs 同口径),单独一版。
import { describe, it, expect, afterEach } from "vitest";
import { SendspinGroup } from "./server.js";
import type { BridgeBoundaryReason } from "../airplay/bridgeChannel.js";
import { setNowUsOverride } from "./clock.js";
import {
  BRIDGE_BACKFILL_MAX_US,
  BRIDGE_PUSH_FLOOR_US,
  BRIDGE_PUSH_HORIZON_US,
  BRIDGE_TRACK_LEAD_COLD_US,
} from "./constants.js";
import { BRIDGE_RESUME_REBASE_US } from "../airplay/rates.js";

const PCM_KEY = "pcm:100";
const DEVICE = "00226CFFA0C0";
const NOW = 1_000_000_000n;
const SAMPLE_RATE = 48_000;
const FRAME_MS = 25;
// 48k 立体声 25ms = 2400 **交错**样本(streamEngine FRAME_MS 口径);每批 1 chunk。
const FRAME_SAMPLES = Math.floor((SAMPLE_RATE * 2 * FRAME_MS) / 1000);
const FRAME_US = BigInt(FRAME_MS) * 1000n; // 25_000n
// 组无 WS 成员 => computeCommonSendAhead 回落 DEFAULT_MIN_BUFFER_MS(800ms)。
const AHEAD_US = 800_000n;
const FLOOR_US = BigInt(BRIDGE_PUSH_FLOOR_US);
const HORIZON_US = BigInt(BRIDGE_PUSH_HORIZON_US);
// 冷启垫片 Δ。PAD_FRAMES 是「恒定平台」跨过的内容帧数(平台含端点,共 +1 帧)。
const PAD_US = BigInt(BRIDGE_TRACK_LEAD_COLD_US);
const PAD_FRAMES = PAD_US / FRAME_US;
// 240 实测的纯桥组深锚(`sendspin timeline anchored: ... lead=4000000us`)。
const PURE_BRIDGE_LEAD_US = 4_000_000n;

type RingEntry = { tsUs: bigint; durUs: number; data: Uint8Array; ep?: number };

class StubBridge {
  readonly deviceId: string;
  frames: Array<{ ts: bigint }> = [];
  /** 发送侧当前排队字节与峰值(诊断/安全钳用;= BridgeMember.stats 同口径)。 */
  queuedBytes = 0;
  maxQueueMs = 0;
  constructor(deviceId: string) {
    this.deviceId = deviceId;
  }
  pushAudio(_pcm: Uint8Array, tsUs: bigint): void {
    this.frames.push({ ts: tsUs });
  }
  notifyGeneration(_generation: number, _reason: BridgeBoundaryReason): void {}
  sendBoundary(_reason: BridgeBoundaryReason): void {}
  setPaused(_p: boolean): void {}
  stop(): void {}
  stats(): { queuedBytes: number; maxQueueMs: number } {
    return { queuedBytes: this.queuedBytes, maxQueueMs: this.maxQueueMs };
  }
}

function makeGroup(): { g: any; bridge: StubBridge; logs: string[] } {
  const logs: string[] = [];
  const g = new (SendspinGroup as any)("t", {
    log: (_level: string, msg: string) => logs.push(msg),
  });
  const bridge = new StubBridge(DEVICE);
  g.bridges.set(bridge.deviceId, bridge);
  g.bridgeWarmAttach = false; // 冷启 => coldBoundary=true => 垫片 = COLD
  return { g, bridge, logs };
}

const chunk = new Float32Array(FRAME_SAMPLES).fill(0.25);

/** ring 内当前代次最后一帧的 ts(无则 null)。 */
function tailOf(ring: RingEntry[], epoch: number): bigint | null {
  for (let i = ring.length - 1; i >= 0; i--) {
    if (ring[i].ep === epoch) return ring[i].tsUs;
  }
  return null;
}

/** 本 tick 的可听域窗口(与 bridgePushTick 同式;shift=0,组名非 ug:) */
function windowAt(now: bigint): { lo: bigint; hi: bigint } {
  return {
    lo: now + FLOOR_US + AHEAD_US,
    hi: now + HORIZON_US + AHEAD_US,
  };
}

/** 衰减语义下第 b 批(0 基)的期望 ts:ts(b) = cursor0 + max(b×25ms, Δ)。 */
function expectTsAt(cursor0: bigint, b: number): bigint {
  const dur = BigInt(b) * FRAME_US;
  return cursor0 + (dur > PAD_US ? dur : PAD_US);
}

/** 泵真实口径:游标按 pushFrame 实测产出推进(每批 1 chunk × 25ms)。 */
async function pushContent(g: any, nBatch: number, startUs = NOW): Promise<bigint> {
  let cur = startUs;
  for (let b = 0; b < nBatch; b++) {
    const produced = await g.pushFrame(cur, chunk);
    cur += BigInt(Math.round((produced * 1_000_000) / SAMPLE_RATE));
  }
  return cur;
}

/** 驱动 tick 并等 bulk 跑完(分片会 await setImmediate 让出事件循环)。 */
async function drainBulk(g: any): Promise<void> {
  g.bridgePushTick();
  for (let i = 0; i < 500; i++) {
    if (g.bridgeBulkInFlight.size === 0) return;
    await new Promise((r) => setImmediate(r));
  }
}

afterEach(() => {
  setNowUsOverride(null);
});

describe("切歌垫片(D2=逐帧衰减)时间线 / bulk 判据 / 稳态窗口对位", () => {
  it("P1: 代次开头 0~Δ 段 ts 恒定(已知既有行为,钉住),之后恢复 1:1 递增", async () => {
    setNowUsOverride(() => NOW);
    const { g } = makeGroup();
    g.notifyBridgeGeneration(2000006, "track");
    expect(g.pendingTrackLeadUs).toBe(PAD_US);

    const N = 160; // 4s 内容:前 2.5s 在平台内,后 1.5s 已越平台
    const cursor0 = NOW;
    await pushContent(g, N, cursor0);

    const ring: RingEntry[] = g.recentByGroup.get(PCM_KEY) ?? [];
    expect(ring.length).toBe(N);

    // ① 逐帧对齐衰减模型(最强的钉子:任何"改垫片语义"都会立刻打破它)
    for (let b = 0; b < N; b++) {
      expect(ring[b].tsUs, `ts 不符模型 @${b}`).toBe(expectTsAt(cursor0, b));
    }
    // ② 平台:0..PAD_FRAMES 同 ts(共 PAD_FRAMES+1 帧),不前进
    for (let b = 1; b <= Number(PAD_FRAMES); b++) {
      expect(ring[b].tsUs).toBe(ring[0].tsUs);
    }
    // ③ 越平台后立刻恢复 25ms/帧
    expect(ring[Number(PAD_FRAMES) + 1].tsUs - ring[Number(PAD_FRAMES)].tsUs).toBe(FRAME_US);
    // ④ 整段跨度 = 内容跨度 − Δ(平台白吃掉的 Δ)
    expect(ring[N - 1].tsUs - ring[0].tsUs).toBe(BigInt(N - 1) * FRAME_US - PAD_US);
  });

  it("P2: 越过平台后严格单调(投递水位去重不再误吞真内容)", async () => {
    setNowUsOverride(() => NOW);
    const { g } = makeGroup();
    g.notifyBridgeGeneration(2000006, "track");
    const N = 160;
    await pushContent(g, N, NOW);
    const ring: RingEntry[] = g.recentByGroup.get(PCM_KEY) ?? [];
    for (let b = Number(PAD_FRAMES) + 1; b < N; b++) {
      expect(
        ring[b].tsUs > ring[b - 1].tsUs,
        `平台之后 ts 非单调 @${b}: ${ring[b - 1].tsUs} -> ${ring[b].tsUs}`,
      ).toBe(true);
    }
    // 平台内确实"相等"(不是递增):这是 D2 明确保留的既有行为
    expect(ring[1].tsUs > ring[0].tsUs).toBe(false);
  });

  it("P3: 垫片语义 = 新代次整体晚 Δ 起播(首帧带完整 COLD 偏移)", async () => {
    setNowUsOverride(() => NOW);
    const { g } = makeGroup();
    g.notifyBridgeGeneration(2000006, "track");
    await pushContent(g, 1);
    const ring: RingEntry[] = g.recentByGroup.get(PCM_KEY) ?? [];
    expect(ring.length).toBe(1);
    expect(ring[0].tsUs - NOW).toBe(PAD_US);
  });

  it("P4: 平台内 tail 是幻影(不随内容推进),Fix B 按内容量计数才不漏料", async () => {
    setNowUsOverride(() => NOW);
    const { g } = makeGroup();
    g.notifyBridgeGeneration(2000006, "track");
    const cursor0 = NOW;

    await pushContent(g, 4, cursor0); // 100ms 内容
    const ring4: RingEntry[] = g.recentByGroup.get(PCM_KEY) ?? [];
    const tail4 = tailOf(ring4, g.bridgeContentEpoch) as bigint;
    // 幻影:只有 100ms 内容,tail 却已经顶到 cursor0 + Δ
    expect(tail4).toBe(cursor0 + PAD_US);
    // ⇒ 旧判据(tail − lo)在此完全脱钩;新判据按内容量:4 帧 = 100ms
    expect(g.currentGenDeliverableUs(ring4, NOW, 0n) as bigint).toBe(4n * FRAME_US);

    // 平台内继续推(tail 不动),可投量按帧数线性增长 —— 判据只看内容量
    await pushContent(g, 36, cursor0 + 4n * FRAME_US);
    const ring40: RingEntry[] = g.recentByGroup.get(PCM_KEY) ?? [];
    expect(ring40.length).toBe(40);
    expect(tailOf(ring40, g.bridgeContentEpoch)).toBe(tail4); // 幻影仍冻结
    expect(g.currentGenDeliverableUs(ring40, NOW, 0n) as bigint).toBe(40n * FRAME_US);
  });

  it("P5: 三重叠加(换代 + 垫片 + 深锚)—— 幻影判据成立但只有 1.725s 真料时绝不触发 bulk", async () => {
    setNowUsOverride(() => NOW);
    const { g } = makeGroup();
    g.notifyBridgeGeneration(2000006, "track");

    const { lo } = windowAt(NOW);
    // 取「让幻影判据 tail − lo ≥ 6s 恰好成立」的最小泵推进量:
    //   tail = cursor0 + Δ(cursor0 仍落在平台内) ⇒ cursor0 = lo + 6s − Δ
    const cursor0 = lo + BigInt(BRIDGE_BACKFILL_MAX_US) - PAD_US;
    // 真机那一拍 ring 里只有 69 帧 = 1.725s(`bridge-bulk durUs=1725000` 的来源)
    const REAL_FRAMES = 69;
    await pushContent(g, REAL_FRAMES, cursor0);

    const ring: RingEntry[] = g.recentByGroup.get(PCM_KEY) ?? [];
    expect(ring.length).toBe(REAL_FRAMES);
    const tail = tailOf(ring, g.bridgeContentEpoch) as bigint;
    // ① 旧判据(位置口径)此刻成立 —— 这正是 run① "判据说 6s" 的来源
    expect(tail - lo).toBeGreaterThanOrEqual(BigInt(BRIDGE_BACKFILL_MAX_US));
    // ② 但真实可投存量只有 1.725s ⇒ 新判据不成立
    expect(g.currentGenDeliverableUs(ring, lo, 0n) as bigint).toBe(
      BigInt(REAL_FRAMES) * FRAME_US,
    );

    g.bridgePushTick();
    await new Promise((r) => setImmediate(r));
    expect(g.bridgeBulkPending.has(DEVICE)).toBe(true); // 仍在等
    expect(g.bridgeBulkInFlight.has(DEVICE)).toBe(false);
  });

  it("P6: 真料够 6s 时 bulk 必须投满 6s(Fix C:hi=lo+6s 会把内容挡在窗外)", async () => {
    setNowUsOverride(() => NOW);
    const { g, bridge } = makeGroup();
    g.notifyBridgeGeneration(2000006, "track");
    // 深锚 4.0s(真机值)+ 垫片 Δ ⇒ 内容起点 = cursor0 + Δ = NOW+6.5s
    const cursor0 = NOW + PURE_BRIDGE_LEAD_US;
    const contentStart = cursor0 + PAD_US;
    const TOTAL = 340; // (Δ + 6s)/25ms:越过平台后仍有 6s 真料
    await pushContent(g, TOTAL, cursor0);

    const { lo } = windowAt(NOW);
    const ring: RingEntry[] = g.recentByGroup.get(PCM_KEY) ?? [];
    expect(ring.length).toBe(TOTAL);
    // 旧实现的上界是 `hi = lo + BRIDGE_BACKFILL_MAX_US`(位置口径,不是 now+HORIZON)
    //   ⇒ 可用窗只剩 hi − contentStart = 1.8s(≈73 帧),这正是 run① 只投 1.725s 的形状
    const oldHi = lo + BigInt(BRIDGE_BACKFILL_MAX_US);
    expect(oldHi - contentStart).toBe(1_800_000n);
    // 新判据:内容量口径,6s 成立
    expect(g.currentGenDeliverableUs(ring, lo, 0n) as bigint).toBe(BigInt(TOTAL) * FRAME_US);

    await drainBulk(g);

    // 投满 6s(旧实现:hi 挡在 1.8s ⇒ ≈1.825s / 73 帧)
    const deliveredUs = BigInt(bridge.frames.length) * FRAME_US;
    expect(deliveredUs).toBe(BigInt(BRIDGE_BACKFILL_MAX_US));
    expect(bridge.frames.length).toBe(240);
    // 严格 ts 升序(锚点由首帧锁定,乱序会打歪桥时间线)
    for (let i = 1; i < bridge.frames.length; i++) {
      expect(bridge.frames[i].ts > bridge.frames[i - 1].ts, `bulk ts 非单调 @${i}`).toBe(true);
    }
    // 投递时戳 = ts − ahead + shift(shift=0);首帧 = 平台帧(内容起点)
    expect(bridge.frames[0].ts).toBe(contentStart - AHEAD_US);
    // 水位已登记:同 now 再 tick 不重复投
    const before = bridge.frames.length;
    g.bridgePushTick();
    expect(bridge.frames.length).toBe(before);
  });

  it("P7: bulk 投递量决定是否跨过 rebase 阈值(run① 1.725s 必炸 / 修复后 6s 有余额)", async () => {
    setNowUsOverride(() => NOW);
    // 真机三条硬数字(UTC 02:34:15.5577 / 02:34:20.0468 / 11:47 复发)
    const MEASURED_BULK_US = 1_725_000n; // run① `bridge-bulk durUs=1725000`
    const MEASURED_LAG_US = 2_765_314n; // run① `pacing rebase +2765314µs`
    const RUN2_REBASE_US = 2_764_901n; // run② `pacing rebase +2764901µs idx=752`

    // ① run① 现场:投 1.725s、然后饿 2.765s ⇒ 余额为负,必然欠料
    expect(MEASURED_BULK_US - MEASURED_LAG_US < 0n).toBe(true);
    // ② 且这段饥饿**跨过** rebase 阈值 ⇒ 走 rebase 分支而非 late++ 死区
    expect(MEASURED_LAG_US > BigInt(BRIDGE_RESUME_REBASE_US)).toBe(true);
    // ③ run② 的 rebase 位置恰好等于 bulk 投递量 ⇒ "6s 吃完即断粮" 的算术铁证
    //    (752 个 RAOP 包 × 352 帧 / 44100 = 6.0024s,与 6s 相差 2.4ms < 1 个包)
    const rebaseAtUs = (752n * 352n * 1_000_000n) / 44_100n;
    expect(BigInt(BRIDGE_BACKFILL_MAX_US) - rebaseAtUs < 5_000n).toBe(true);
    expect(rebaseAtUs - BigInt(BRIDGE_BACKFILL_MAX_US) < 5_000n).toBe(true);
    expect(RUN2_REBASE_US > BigInt(BRIDGE_RESUME_REBASE_US)).toBe(true);

    // ④ 修复后:bulk 投满 6s,同样的 2.765s 饥饿吃得下、且留 > 2s 余额
    const { g, bridge } = makeGroup();
    g.notifyBridgeGeneration(2000006, "track");
    await pushContent(g, 340, NOW + PURE_BRIDGE_LEAD_US);
    await drainBulk(g);
    const deliveredUs = BigInt(bridge.frames.length) * FRAME_US;
    expect(deliveredUs - MEASURED_LAG_US > BigInt(BRIDGE_RESUME_REBASE_US)).toBe(true);
  });

  it("P8: 曲末 pad 已归零 ⇒ 续静音 ts == 泵游标(不得再加 Δ)", async () => {
    setNowUsOverride(() => NOW);
    const { g } = makeGroup();
    g.notifyBridgeGeneration(2000006, "track");
    const cursor0 = NOW + PURE_BRIDGE_LEAD_US;
    const N = 120; // 3s > Δ ⇒ 垫片已吃光
    const cursorAfter = await pushContent(g, N, cursor0);
    expect(g.pendingTrackLeadUs).toBe(0n);

    const ring: RingEntry[] = g.recentByGroup.get(PCM_KEY) ?? [];
    const before = ring.length;
    const lastContentTs = ring[before - 1].tsUs;
    // 曲末排空:streamEngine 传的正是泵游标 `fillTsUs = cursorUs`(不含垫片)
    const n = g.pushBridgeOnlySilence(cursorAfter, 200_000);
    expect(n).toBeGreaterThan(0);
    expect(ring.length).toBe(before + n);

    // ① 全程不倒退(平台内允许相等,见 P1;越过平台后必须严格递增)
    for (let i = 1; i < ring.length; i++) {
      expect(
        ring[i].tsUs >= ring[i - 1].tsUs,
        `ts 倒退 @${i}: ${ring[i - 1].tsUs} -> ${ring[i].tsUs}`,
      ).toBe(true);
    }
    for (let i = Number(PAD_FRAMES) + 1; i < ring.length; i++) {
      expect(
        ring[i].tsUs > ring[i - 1].tsUs,
        `平台之后 ts 非单调 @${i}: ${ring[i - 1].tsUs} -> ${ring[i].tsUs}`,
      ).toBe(true);
    }
    // ② 首帧续静音 == 游标 == 末帧内容 + 25ms(pad 归零后逐字节同域)
    expect(ring[before].tsUs).toBe(cursorAfter);
    expect(ring[before].tsUs).toBe(lastContentTs + FRAME_US);
    expect(ring[before - 1].tsUs).toBe(cursorAfter - FRAME_US);
    // ③ 每片 +25ms
    for (let i = 1; i < n; i++) {
      expect(ring[before + i].tsUs - ring[before + i - 1].tsUs).toBe(FRAME_US);
    }
  });

  it("P9: 稳态窗口对位必须恒定且落在窗内(常数垫片形态在此必红)", async () => {
    // 泵游标领先 now 2.8s(稳态预填充深度):窗口 [now+2.3s, now+3.3s] ⇒ 尾帧落在窗内
    const LEAD = 2_800_000n;
    let clock = NOW;
    setNowUsOverride(() => clock);

    const { g, bridge } = makeGroup();
    g.notifyBridgeGeneration(2000006, "track");
    // 本用例只测「窗口补投」,摘掉开局 bulk 登记,避免 6s 判据干扰
    g.bridgeBulkPending.delete(DEVICE);

    const diffs: string[] = [];
    const ITERS = 140; // 3.5s > Δ ⇒ 后段已进入稳态
    const STEADY_FROM = 110;
    for (let i = 0; i < ITERS; i++) {
      clock += FRAME_US;
      const before = bridge.frames.length;
      // 泵在 t=clock 推出「从现在起 LEAD 之后要播」的那一帧(1x,与墙钟同步)
      await g.pushFrame(clock + LEAD, chunk);
      g.bridgePushTick();

      if (i >= STEADY_FROM) {
        const ring: RingEntry[] = g.recentByGroup.get(PCM_KEY) ?? [];
        const tail = tailOf(ring, g.bridgeContentEpoch) as bigint;
        const { lo, hi } = windowAt(clock);
        // ① 尾帧必须在窗内(常数垫片形态:tail − hi = +Δ ⇒ 永久窗外)
        expect(tail <= hi, `尾帧超前窗口上沿 @${i}: tail-hi=${tail - hi}`).toBe(true);
        expect(tail >= lo, `尾帧落在窗口下沿之下 @${i}: tail-lo=${tail - lo}`).toBe(true);
        diffs.push(String(tail - lo));
        // ② 每 tick 都必须真的补上一帧(断粮 = 本次故障的直接形态)
        expect(bridge.frames.length, `tick @${i} 一帧未投(稳态断粮)`).toBeGreaterThan(before);
      }
    }

    // ③ 量级差恒定:不得随时间放大(本故障的判别式)
    expect(new Set(diffs).size).toBe(1);
    expect(diffs[0]).toBe("500000"); // LEAD − (FLOOR + ahead) = 2.8s − 2.3s
    // ④ 平台期之后仍有持续投递(不是靠 bulk 的一次性注入撑住)
    expect(bridge.frames.length).toBeGreaterThanOrEqual(ITERS - STEADY_FROM);
  });

  it("P10: bulk 上限受硬上限钳位(6s + 既有排队 ≈ 8s 不许顶格断连)", async () => {
    setNowUsOverride(() => NOW);
    const BYTES_PER_SEC = 192_000; // 48k/s16le/2ch

    // ① 健康路径:0 排队 ⇒ 8 − 0 − 1 = 7s > 6s ⇒ 上限仍是 6s(行为零变化)
    const a = makeGroup();
    a.g.notifyBridgeGeneration(2000006, "track");
    a.bridge.queuedBytes = 0;
    await pushContent(a.g, 340, NOW + PURE_BRIDGE_LEAD_US);
    await drainBulk(a.g);
    expect(BigInt(a.bridge.frames.length) * FRAME_US).toBe(BigInt(BRIDGE_BACKFILL_MAX_US));

    // ② 已有 3s 排队 ⇒ 上限 = 8000 − 3000 − 1000 = 4s(而不是继续灌 6s 顶格)
    const b2 = makeGroup();
    b2.g.notifyBridgeGeneration(2000006, "track");
    b2.bridge.queuedBytes = 3 * BYTES_PER_SEC;
    await pushContent(b2.g, 340, NOW + PURE_BRIDGE_LEAD_US);
    await drainBulk(b2.g);
    expect(BigInt(b2.bridge.frames.length) * FRAME_US).toBe(4_000_000n);

    // ③ 排队已顶格(8s)⇒ 预算 ≤ 0 ⇒ 整包跳过并留痕,绝不硬灌触发 socket.destroy
    const c = makeGroup();
    c.g.notifyBridgeGeneration(2000006, "track");
    c.bridge.queuedBytes = 8 * BYTES_PER_SEC;
    await pushContent(c.g, 340, NOW + PURE_BRIDGE_LEAD_US);
    await drainBulk(c.g);
    expect(c.bridge.frames.length).toBe(0);
    expect(
      c.logs.some((l) => l.includes("bridge-bulk skipped") && l.includes("queue-full")),
    ).toBe(true);
  });

  it("P11: bridge-window 诊断字段必须真的打出来(padUs / contentFrontierVsNowUs / queuePeakMs)", async () => {
    setNowUsOverride(() => NOW);
    const { g, bridge, logs } = makeGroup();
    g.notifyBridgeGeneration(2000006, "track");
    bridge.queuedBytes = 0;
    bridge.maxQueueMs = 2012; // 真机 backpressure 那行的 maxQueueMs 快照
    const N = 120; // 3s > Δ ⇒ pad 已归零
    await pushContent(g, N, NOW + PURE_BRIDGE_LEAD_US);
    g.bridgePushTick();

    const line = logs.find((l) => l.startsWith("bridge-window"));
    expect(line).toBeDefined();
    // pad 已归零
    expect(line).toContain("padUs=0");
    // 内容前沿相对墙钟 = 游标前沿 = NOW+4.0s + 119×25ms
    expect(line).toContain("contentFrontierVsNowUs=6975000");
    // 发送侧排队(当前 0 / 峰值实测 2012,而不是"越过高水位的首次采样")
    expect(line).toContain("queueMs=0");
    expect(line).toContain("queuePeakMs=2012");
  });
});
