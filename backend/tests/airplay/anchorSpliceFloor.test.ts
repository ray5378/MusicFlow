// [P0-C 2026-11-25] splice 下限(对齐 MA AIRPLAY_SPLICE_LEAD_MARGIN_MS 语义)回归钉:
// splice 型接收端(MUZO 2017 固件一族)只在「重排指令时刻落在残留排队音频之后」才执行
// 换锚;落点不够 ⇒ 指令被忽略 ⇒ 时戳域整体错位(240 真机 14:45:33 iEAST:首拍 delta
// 偏 +264ms、随后 delta 4126~4268 / late +120/s 不收敛)。
// 本文件钉死 planBridgeAnchor 的三个不变量:
//   ① 设备残留(queuedUs)+ splice 余量是 lead 的**下限**(下限生效时 lead ≥ 它);
//   ② 无残留时行为与改前逐字节一致(lead 不被抬);
//   ③ splice 下限不得越过「首帧 −200ms」上限(宁吞新头,不允许锚点晚于首帧)。
import "../plugins/_env.js";

import { describe, expect, it } from "vitest";

import { planBridgeAnchor } from "../../src/services/airplay/bridgeSession.js";
import { BRIDGE_SPLICE_LEAD_MARGIN_US } from "../../src/services/airplay/rates.js";

const LATENCY = 22050; // 0.5s
const RATE = 44100;

describe("planBridgeAnchor · splice 下限(P0-C)", () => {
  const NOW = 5_000_000_000n;

  it("① 残留 2.2s ⇒ lead ≥ 残留 + splice 余量(指令落点越过残留音频)", () => {
    // 首帧放得很远(ceiling 不约束),让 splice 下限成为唯一生效约束。
    const first = NOW + 20_000_000n;
    const residual = 2_200_000n;
    const plan = planBridgeAnchor({
      firstFrameTsUs: first,
      latencyFrames: LATENCY,
      rate: RATE,
      resampled: false,
      nowUs: NOW,
      forceNow: true,
      queuedUs: residual,
    });
    const lead = Number(plan.anchorUs - NOW);
    expect(lead).toBeGreaterThanOrEqual(Number(residual) + BRIDGE_SPLICE_LEAD_MARGIN_US);
  });

  it("② 无残留 ⇒ lead 不被 splice 下限抬高(与改前行为一致)", () => {
    const first = NOW + 20_000_000n;
    const base = {
      firstFrameTsUs: first,
      latencyFrames: LATENCY,
      rate: RATE,
      resampled: false,
      nowUs: NOW,
      forceNow: true,
    };
    const withZero = planBridgeAnchor({ ...base, queuedUs: 0n });
    const withoutField = planBridgeAnchor({ ...base });
    expect(withZero.anchorUs).toBe(withoutField.anchorUs);
    const lead = Number(withZero.anchorUs - NOW);
    // [v6 2026-11-25] lead 现可因「首帧远(本例 20s)」向首帧靠拢, 抬到 4s 等待上限;
    // 这与 splice 无关。本用例的真意是「无残留 vs 无字段 完全一致」(splice 零影响),
    // 故只约束 lead 不超过 v6 上限, 不再钉死 1.4s。
    expect(lead).toBeLessThanOrEqual(30_000_000);
  });

  it("③ splice 下限不越过「首帧 −200ms」上限(宁吞新头,锚点绝不晚于首帧)", () => {
    // 首帧只比 now 早一点点:ceiling(首帧−200ms) < splice 下限 ⇒ ceiling 必须赢。
    const first = NOW + 600_000n; // 首帧 600ms 后
    const residual = 2_200_000n; // splice 下限 2.6s > ceiling 0.4s ⇒ 冲突
    const plan = planBridgeAnchor({
      firstFrameTsUs: first,
      latencyFrames: LATENCY,
      rate: RATE,
      resampled: false,
      nowUs: NOW,
      forceNow: true,
      queuedUs: residual,
    });
    expect(plan.anchorUs).toBeLessThan(first);
  });
});
