// [验收6/MA A 2026-11-25] 组级锚点同源回归钉。
// MA 出处:sendspin_bridge.py `_anchor_stream` —— "Always a join: the Sendspin timeline
// is the group's, never the bridge's to set";同组同 gen 只允许一个锚点,后到成员从同一
// 组参考派生(本仓 = BridgeGroupAnchorRegistry 携带组级 lead + 消费侧下限夹紧)。
// 钉死:
//   ① peek 返回 {anchorUs, leadUs},publish 首个规划者获胜(后到不覆盖);
//   ② 消费共享锚点时,若本设备自身下限(minSafe/splice)不高 ⇒ 锚点与组锚**逐 µs 同源**
//      (lead 同源,不允许独立种子漂移);
//   ③ 本设备自身下限更高(残留更多)⇒ 抬到下限并留痕 floormiss 的数值依据
//      (MA :934-945 splice 约束:命令时刻必须落在残留音频之后),且绝不晚于首帧−200ms。
import "../plugins/_env.js";

import { describe, expect, it } from "vitest";

import {
  BridgeGroupAnchorRegistry,
  planBridgeAnchor,
} from "../../src/services/airplay/bridgeSession.js";

const LATENCY = 22050; // 0.5s
const RATE = 44100;
const L_US = Math.round((LATENCY / RATE) * 1e6); // ≈500_000

describe("BridgeGroupAnchorRegistry · 组级 lead 同源(验收6/MA A)", () => {
  it("① peek 携带组级 lead;publish 首个规划者获胜", () => {
    const reg = new BridgeGroupAnchorRegistry();
    const now = 5_000_000_000n;
    const anchor = now + 2_500_000n;
    reg.publish("grp", 7, anchor, 2_500_000n);
    // 后到者不覆盖(首个规划者的组时间线零点唯一)
    reg.publish("grp", 7, now + 3_000_000n, 3_000_000n);
    const got = reg.peek("grp", 7, now, 1_000_000n);
    expect(got).not.toBeNull();
    expect(got!.anchorUs).toBe(anchor);
    expect(got!.leadUs).toBe(2_500_000n);
  });

  it("② 消费共享锚点:自身下限不高 ⇒ 锚点与组锚逐 µs 同源(lead 同源)", () => {
    const now = 5_000_000_000n;
    const shared = now + 2_500_000n;
    // 首帧远在锚点之前(ceiling 不约束)、无残留(queuedUs=0)、无保留队列:
    // 自身下限 = minSafe = L+SAFETY ≈ 550ms < 组锚 lead 2.5s ⇒ 组锚原样胜出。
    const plan = planBridgeAnchor({
      firstFrameTsUs: now + 20_000_000n,
      latencyFrames: LATENCY,
      rate: RATE,
      resampled: false,
      nowUs: now,
      forceNow: true,
      groupAnchorUs: shared,
      queuedUs: 0n,
    });
    expect(plan.anchorUs).toBe(shared);
  });

  it("③ 自身下限更高(残留 2.2s)⇒ 抬到下限且不越过首帧−200ms(floormiss 数值依据)", () => {
    const now = 5_000_000_000n;
    const shared = now + 2_500_000n;
    const first = now + 20_000_000n;
    const plan = planBridgeAnchor({
      firstFrameTsUs: first,
      latencyFrames: LATENCY,
      rate: RATE,
      resampled: false,
      nowUs: now,
      forceNow: true,
      groupAnchorUs: shared,
      queuedUs: 2_200_000n, // splice 下限 2.6s > 组锚 lead 2.5s ⇒ 必须抬高
    });
    expect(plan.anchorUs).toBeGreaterThan(shared);
    // 且绝不晚于首帧−200ms(宁吞新头,不吞开头)
    expect(plan.anchorUs).toBeLessThan(first);
  });
});
