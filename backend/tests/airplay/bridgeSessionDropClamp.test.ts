// ============ 切歌重锚:drop 队列不得三角累计 / 投递窗口 FLOOR 必须可达 ============
//
// 钉死 2026-10-26 真机(240)两个事实:
//   ① 桥会话重锚到 now+2.5s 后,首个交付帧比锚点早 1.48s(target 为负)→ drop 分支;
//      旧实现每帧按**绝对** drift 重记 pendingDrops ⇒ 1.48s 重叠三角累计成 43s
//      (真机日志切歌那一秒 sumDrop=1914975 帧)⇒ 43 秒 100% 输出被裁 = 45s 无声。
//      修法:pendingDrops 只补记「尚未排队」的重叠量 ⇒ 恒 ≤ 真实重叠,且可被消化完。
//   ② 投递窗口 FLOOR(1.5s)+ RAOP L(1s)+ SAFETY(50ms) 下,原 ts 打戳的首个交付帧
//      **可达**(A − L − SAFETY ≥ now)⇒ 窗口化投递本身不需要每次切歌都自锚到
//      now+2.5s;旧实现(ts − sendAhead)把首帧压到 now+1.0s < now+1.05s ⇒ 必重锚。
import { describe, expect, it } from "vitest";

import { BridgeTimelineAligner, planBridgeAnchor } from "../../src/services/airplay/bridgeSession.js";
import { BRIDGE_PUSH_FLOOR_US } from "../../src/services/sendspin/constants.js";
import { RAOP_SAFETY_MS } from "../../src/services/airplay/rates.js";

const RATE = 44100;
const FRAME = 1102;            // 25ms @44.1k
const STEP_US = 25_000n;       // 泵批次 25ms

describe("BridgeTimelineAligner:drop 不得三角累计(45s 无声根因)", () => {
  it("首帧比锚点早 1.48s → pendingDrops = 真实重叠(≈65311),后续帧不再重复记账", () => {
    const A = 1_000_000_000n;
    const a = new BridgeTimelineAligner(A, RATE);
    const overlapUs = 1_481_000n;
    const first = a.onFrame(A - overlapUs);
    const expected = Math.round((Number(overlapUs) * RATE) / 1e6);
    expect(first.dropFrames).toBe(expected);
    expect(a.pendingDrops).toBe(expected);
    // pos 未前进(drop 尚未被产出消费)→ 后续每帧都"更超前",但不得再记账
    for (let i = 1; i <= 30; i++) {
      const act = a.onFrame(A - overlapUs + BigInt(i) * STEP_US);
      expect(act.dropFrames).toBe(0);          // 缺口已在队列里
      expect(a.pendingDrops).toBe(expected);   // 不增长(旧实现在这里会翻倍再翻倍)
    }
  });

  it("重叠被产出消化完后,对齐恢复常态(drop 归零、不进入永久裁帧)", () => {
    const A = 2_000_000_000n;
    const a = new BridgeTimelineAligner(A, RATE);
    const overlapUs = 1_000_000n; // 1s 重叠 → 44100 帧
    const overlapFrames = Math.round((Number(overlapUs) * RATE) / 1e6);
    a.onFrame(A - overlapUs);
    expect(a.pendingDrops).toBe(overlapFrames);

    // 模拟 resampleIn 真实次序(onFrame → 重采样 → takeDrop → 追加剩余 → produced):
    // 全裁帧时 outBuf 为空,streamBridge 只写本帧的 insert 静音,pullChunk 不再额外
    // padded —— 真机 storm 期日志就是 insert=1103/chunk、content 全裁、queueMs≈0。
    let consumed = 0;
    let t = A - overlapUs;
    let steps = 0;
    while (a.pendingDrops > 0 && steps < 200) {
      steps++;
      t += STEP_US;
      a.onFrame(t);
      const dropped = a.takeDrop(FRAME);
      consumed += dropped;
      a.produced(FRAME - dropped);
    }
    expect(a.pendingDrops).toBe(0);
    expect(consumed).toBe(overlapFrames); // 恰好裁掉真实重叠:不多(三角累计)不少
    expect(steps).toBeLessThanOrEqual(Math.ceil(overlapFrames / FRAME) + 2); // ≈1s 消化完,不是 43s
    // 恢复常态:后续帧不再裁
    const act = a.onFrame(t + STEP_US);
    expect(act.dropFrames).toBe(0);
    expect(Math.abs(act.diff)).toBeLessThan(1102 * 3); // 残差 ~0(收敛,非永久裁帧)
  });
});

describe("planBridgeAnchor:窗口 FLOOR 打戳可达(切歌不再自锚 +2.5s)", () => {
  const now = 3_000_000_000n;
  const L = 44100; // RAOP 协商延迟 1s(真机 latencyFrames=44100)

  it("★ 原 ts 打戳:首帧 = now+FLOOR(1.5s) → 可达,不重锚,锚点 = 首帧原值(A/V 对齐设备)", () => {
    const firstFrame = now + BigInt(BRIDGE_PUSH_FLOOR_US);
    const plan = planBridgeAnchor({
      firstFrameTsUs: firstFrame, latencyFrames: L, rate: RATE, resampled: true, nowUs: now,
    });
    expect(plan.reAnchored).toBe(false);
    expect(plan.anchorUs).toBe(firstFrame); // 贴组时间线:锚点就是组 ts,不再 now+2.5s
  });

  it("旧实现(ts − sendAhead 0.5s)在真机几何下**必然**不可达 → 每次切歌自锚 +2.5s(回归防护)", () => {
    const firstFrame = now + BigInt(BRIDGE_PUSH_FLOOR_US) - 500_000n; // 真机 commandedLeadUs≈1.02s
    const plan = planBridgeAnchor({
      firstFrameTsUs: firstFrame, latencyFrames: L, rate: RATE, resampled: true, nowUs: now,
    });
    expect(plan.reAnchored).toBe(true); // L(1s)+SAFETY(50ms) > 1.0s
    expect(plan.anchorUs).toBe(now + 2_500_000n);
    expect(RAOP_SAFETY_MS).toBe(50);
  });
});
