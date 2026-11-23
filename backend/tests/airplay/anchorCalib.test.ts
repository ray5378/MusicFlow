// ==================== S8 校准闭环:anchorCalib 纯函数单测 ====================
//
// 钉死两件事(审计 P0 的判定面):
//   ① drift 公式:实际出声 proxy(实际首包发出 + 命令 lead)− 命令锚点;
//     正 = 出声晚。无测量/未锚 ⇒ 0(不判定)。
//   ② 双门槛:|drift| > 500ms(MA playback.py:90 ANCHOR_REBASE_SIGNIFICANT_US,
//     复用 contentDemand.CURSOR_JUMP_BEHIND_US)+ 同设备 10s 迟滞(防振荡)。
//     符号:drift > 0 ⇒ 负向平移(提前出声)。
import { describe, it, expect, beforeEach } from "vitest";
import {
  ANCHOR_CALIB_HYSTERESIS_MS,
  anchorAdjustDecision,
  anchorDriftUs,
  resetAnchorCalibForTest,
} from "../../src/services/airplay/anchorCalib.js";

describe("anchorDriftUs — drift 公式", () => {
  it("出声晚 ⇒ 正 drift(实际发出 + lead − 锚点)", () => {
    // 锚 A=10s、lead=1s ⇒ 预期首包发出 = 9s;实际 9.8s ⇒ drift = +0.8s
    expect(anchorDriftUs(9_800_000, 10_000_000, 1_000_000)).toBe(800_000);
  });

  it("出声早 ⇒ 负 drift", () => {
    expect(anchorDriftUs(8_800_000, 10_000_000, 1_000_000)).toBe(-200_000);
  });

  it("无测量(actualSendAtUs ≤ 0)或未锚 ⇒ 0(不判定)", () => {
    expect(anchorDriftUs(0, 10_000_000, 0)).toBe(0);
    expect(anchorDriftUs(-1, 10_000_000, 0)).toBe(0);
    expect(anchorDriftUs(9_000_000, 0, 0)).toBe(0);
  });
});

describe("anchorAdjustDecision — 显著性 + 10s 迟滞", () => {
  beforeEach(() => resetAnchorCalibForTest());

  it("|drift| > 500ms ⇒ 调整(负向平移:出声晚 ⇒ 提前)", () => {
    expect(anchorAdjustDecision("dev-a", 800_000, 1000)).toBe(-800_000);
    expect(anchorAdjustDecision("dev-b", -800_000, 1000)).toBe(800_000);
  });

  it("|drift| ≤ 500ms(恰 500ms,不满足严格大于)⇒ 不调(容忍自然追赶)", () => {
    expect(anchorAdjustDecision("dev-a", 500_000, 1000)).toBe(null);
    expect(anchorAdjustDecision("dev-a", -500_000, 2000)).toBe(null);
    expect(anchorAdjustDecision("dev-a", 0, 3000)).toBe(null);
  });

  it("10s 迟滞:同设备 10s 内第二次超限 ⇒ null;过迟滞 ⇒ 再调", () => {
    expect(anchorAdjustDecision("dev-a", 800_000, 1000)).toBe(-800_000);
    expect(anchorAdjustDecision("dev-a", 900_000, 1000 + ANCHOR_CALIB_HYSTERESIS_MS - 1)).toBe(null);
    expect(anchorAdjustDecision("dev-a", 900_000, 1000 + ANCHOR_CALIB_HYSTERESIS_MS)).toBe(-900_000);
  });

  it("迟滞按设备隔离:dev-b 不受 dev-a 迟滞牵制", () => {
    expect(anchorAdjustDecision("dev-a", 800_000, 1000)).not.toBe(null);
    expect(anchorAdjustDecision("dev-b", 800_000, 1000)).not.toBe(null);
  });
});
