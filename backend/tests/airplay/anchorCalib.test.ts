// ==================== S8 校准闭环:anchorCalib 纯函数单测(复核修复后口径)====================
//
// 钉死四件事(复核 4 项 MUST FIX 的回归锚):
//   ① drift 公式:actual − (anchor − firstPacketLeadUs) —— 与设备真实出声对齐
//     (旧公式 commandedLeadUs=anchor−now_plan 会锚点对消,测的是计划→首包墙钟差);
//   ② AP2 会话排除出判定面(执行端 applyAnchorShift 对 AP2 是 no-op ⇒ 空转);
//   ③ 测量实例绑定:同一 actualSendAtUs 只判一次 —— 防「测量冻结 + 迟滞到期」的
//      无上限棘轮(每 10s 对同一冻结测量再减一次同样的 drift);
//   ④ 显著性 500ms(MA ANCHOR_REBASE_SIGNIFICANT_US)+ 10s 迟滞 + 按设备隔离。
import { describe, it, expect, beforeEach } from "vitest";
import {
  ANCHOR_CALIB_HYSTERESIS_MS,
  anchorAdjustDecision,
  anchorDriftUs,
  resetAnchorCalibForTest,
} from "../../src/services/airplay/anchorCalib.js";

describe("anchorDriftUs — drift 公式(复核②:new = actual − (A − L_eff))", () => {
  it("符号用例:实际发出晚于预期 ⇒ 正 drift(出声晚)", () => {
    // 锚 A=10s、首包预期提前量 L_eff=1s ⇒ 预期发出 = 9s;实际 9.8s ⇒ drift = +0.8s
    expect(anchorDriftUs(9_800_000, 10_000_000, 1_000_000)).toBe(800_000);
  });

  it("实际发出早于预期 ⇒ 负 drift(出声早)", () => {
    expect(anchorDriftUs(8_800_000, 10_000_000, 1_000_000)).toBe(-200_000);
  });

  it("RAOP forceNow 形态(L_eff=0,预期首包=now_plan):drift = actual − A", () => {
    expect(anchorDriftUs(10_700_000, 10_000_000, 0)).toBe(700_000);
  });

  it("无测量/未锚/异常 L_eff ⇒ 0(不判定)", () => {
    expect(anchorDriftUs(0, 10_000_000, 1_000_000)).toBe(0);
    expect(anchorDriftUs(9_000_000, 0, 1_000_000)).toBe(0);
    expect(anchorDriftUs(9_000_000, 10_000_000, -1)).toBe(0);
  });
});

describe("anchorAdjustDecision — 复核 4 项判定面", () => {
  beforeEach(() => resetAnchorCalibForTest());

  it("② AP2 会话 ⇒ 无决策(执行端 no-op,排除出判定面)", () => {
    expect(anchorAdjustDecision("dev-a", 9_800_000, 800_000, 1000, true)).toBe(null);
    // AP2 即便换新测量实例也永不决策
    expect(anchorAdjustDecision("dev-a", 9_900_000, 900_000, 20_000, true)).toBe(null);
  });

  it("① 测量实例绑定:同一 actualSendAtUs 二次决策 ⇒ 不调(防棘轮)", () => {
    const actual = 9_800_000;
    expect(anchorAdjustDecision("dev-a", actual, 800_000, 1000)).toBe(-800_000);
    // 时间迟滞已过期(1000 + 60_000 > 10s),但测量值没变 ⇒ 仍不调(棘轮根除)
    expect(anchorAdjustDecision("dev-a", actual, 800_000, 61_000)).toBe(null);
    // 新测量实例 ⇒ 可再判
    expect(anchorAdjustDecision("dev-a", 9_900_000, 900_000, 61_000)).toBe(-900_000);
  });

  it("③④ 不显著(|drift| ≤ 500ms)⇒ 不调,且该测量实例也记为已判", () => {
    const actual = 9_300_000;
    expect(anchorAdjustDecision("dev-a", actual, 300_000, 1000)).toBe(null);
    // 同值再判仍 null(已判过)
    expect(anchorAdjustDecision("dev-a", actual, 300_000, 61_000)).toBe(null);
  });

  it("④ 10s 迟滞:不同测量实例、10s 内 ⇒ null;过迟滞 ⇒ 调", () => {
    expect(anchorAdjustDecision("dev-a", 9_800_000, 800_000, 1000)).toBe(-800_000);
    expect(anchorAdjustDecision("dev-a", 9_900_000, 900_000, 1000 + ANCHOR_CALIB_HYSTERESIS_MS - 1)).toBe(null);
    expect(anchorAdjustDecision("dev-a", 9_950_000, 950_000, 1000 + ANCHOR_CALIB_HYSTERESIS_MS)).toBe(-950_000);
  });

  it("④ 迟滞按设备隔离:dev-b 不受 dev-a 牵制", () => {
    expect(anchorAdjustDecision("dev-a", 9_800_000, 800_000, 1000)).not.toBe(null);
    expect(anchorAdjustDecision("dev-b", 9_800_000, 800_000, 1000)).not.toBe(null);
  });
});
