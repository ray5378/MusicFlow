// ==================== 广播投递闭环：contentDemand 纯函数单测 ====================
//
// 钉死三件事（改动前是开环，真机表现为「内容堆到 59s 之外、设备饿死」）：
//   ① 投递窗口：下沿贴已消费水位（最多回看 200ms）、上沿只前瞻 2s；
//   ② 游标落后：> 1s 直接跳到 now（不追历史），≤ 1s 正常逐帧补；
//   ③ 泵加速闸门：内容够就**不放行**，内容不足且设备落后才放行，设备水位未知按可放行。
import { describe, it, expect } from "vitest";
import {
  BEHIND_GRACE_US,
  CURSOR_JUMP_BEHIND_US,
  DELIVER_LOOKAHEAD_US,
  DEVICE_LOOKAHEAD_US,
  PUMP_LOOKAHEAD_DEFAULT_US,
  contentAheadUs,
  deliverWindow,
  shouldApproveBump,
  type DemandInput,
} from "../../src/services/sendspin/contentDemand.js";

const NOW = 10_000_000; // 10s，任意基准（全部用例都用相对量断言）

/** 构造输入快照，未显式给出的字段默认为「未知/尚未开始」（= 0）。 */
function input(over: Partial<DemandInput> = {}): DemandInput {
  return { nowUs: NOW, cursorUs: 0, tailUs: 0, minDeviceTsUs: 0, ...over };
}

describe("deliverWindow — 投递窗口上下界", () => {
  it("游标紧贴 now（50ms 前）：下沿取游标 —— 不回退重投已投帧", () => {
    const w = deliverWindow(input({ cursorUs: NOW - 50_000 }));
    // 游标比 now−200ms 更靠近 now ⇒ max() 取游标：绝不回退（回退就会重复广播）
    expect(w.loUs).toBe(NOW - 50_000);
    expect(w.hiUs).toBe(NOW + DELIVER_LOOKAHEAD_US);
    expect(w.jumpToUs).toBe(null);
  });

  it("游标在 now−200ms 之外（600ms 前）：下沿仍钳到 now−200ms —— 更老的帧不补", () => {
    // 游标 = now − 600ms，比 now−200ms 更早 ⇒ 下沿取 now−200ms：
    // 「刚刚错过」的只有 200ms，更早的帧投出去也来不及播（宁可缺口，不追历史）。
    const w = deliverWindow(input({ cursorUs: NOW - 600_000 }));
    expect(w.loUs).toBe(NOW - BEHIND_GRACE_US);
    expect(w.hiUs).toBe(NOW + DELIVER_LOOKAHEAD_US);
    expect(w.jumpToUs).toBe(null);
  });

  it("游标未建立（cursorUs = 0）：下沿 = now − 200ms，且不触发跳转", () => {
    const w = deliverWindow(input({ cursorUs: 0 }));
    expect(w.loUs).toBe(NOW - BEHIND_GRACE_US);
    expect(w.jumpToUs).toBe(null);
  });

  it("窗口恒非空：hiUs 严格大于 loUs（调用方无需特判空窗口）", () => {
    const cases = [0, NOW - 1_000_000, NOW - 200_000, NOW - 50_000, NOW, NOW + 500_000];
    for (const cursorUs of cases) {
      const w = deliverWindow(input({ cursorUs }));
      expect(w.hiUs).toBeGreaterThan(w.loUs);
    }
  });
});

describe("deliverWindow — 游标落后触发跳转", () => {
  it("游标落后 1.5s ⇒ jumpToUs = now（不追历史）", () => {
    const w = deliverWindow(input({ cursorUs: NOW - 1_500_000 }));
    expect(w.jumpToUs).toBe(NOW);
    // 跳转后调用方会把游标设为 now ⇒ loUs 仍是 now−200ms，但实际已无更早的帧会投出
    expect(w.loUs).toBe(NOW - BEHIND_GRACE_US);
  });

  it("恰好落后 1s（阈值上，不满足严格小于）⇒ 不跳", () => {
    const w = deliverWindow(input({ cursorUs: NOW - CURSOR_JUMP_BEHIND_US }));
    expect(w.jumpToUs).toBe(null);
  });

  it("落后略超 1s（1.01s）⇒ 跳", () => {
    const w = deliverWindow(input({ cursorUs: NOW - CURSOR_JUMP_BEHIND_US - 10_000 }));
    expect(w.jumpToUs).toBe(NOW);
  });

  it("游标在 now 之后（已产出未来内容）⇒ 不跳", () => {
    const w = deliverWindow(input({ cursorUs: NOW + 800_000 }));
    expect(w.jumpToUs).toBe(null);
    // 下沿由游标接管：不会回头重投
    expect(w.loUs).toBe(NOW + 800_000);
  });
});

describe("shouldApproveBump — 泵加速闸门", () => {
  it("内容充足（前沿 +6s 以上）且设备正常 ⇒ 不放行", () => {
    const i = input({
      cursorUs: NOW,
      tailUs: NOW + PUMP_LOOKAHEAD_DEFAULT_US + 1, // 比 6s 前瞻更远
      minDeviceTsUs: NOW + 2_000_000, // 设备已跑到 now+2s，不算落后
    });
    expect(shouldApproveBump(i)).toBe(false);
  });

  it("内容充足但设备落后 ⇒ 仍不放行（瓶颈在设备/投递，不在供给）", () => {
    const i = input({
      tailUs: NOW + 20_000_000,
      minDeviceTsUs: NOW - 500_000,
    });
    expect(shouldApproveBump(i)).toBe(false);
  });

  it("内容不足且设备落后 ⇒ 放行", () => {
    const i = input({
      tailUs: NOW + 1_000_000, // 只超前 1s < 6s 前瞻
      minDeviceTsUs: NOW - 300_000, // 设备落后
    });
    expect(shouldApproveBump(i)).toBe(true);
  });

  it("环空（tailUs = 0）但设备水位健康 ⇒ 仍按闸门逻辑不放行（两者必须同时满足）", () => {
    const i = input({ tailUs: 0, minDeviceTsUs: NOW + 5_000_000 });
    expect(shouldApproveBump(i)).toBe(false);
  });

  it("环空（tailUs = 0）且设备落后 ⇒ 放行（必须产出，否则永久静音）", () => {
    const i = input({ tailUs: 0, minDeviceTsUs: NOW - 100_000 });
    expect(shouldApproveBump(i)).toBe(true);
  });

  it("环空（tailUs = 0）且设备水位未知 ⇒ 放行（起播阶段）", () => {
    const i = input({ tailUs: 0, minDeviceTsUs: 0 });
    expect(shouldApproveBump(i)).toBe(true);
  });

  it("minDeviceTsUs 未知（0）⇒ 按可放行处理（起播阶段否则永久卡死）", () => {
    const i = input({ tailUs: NOW + 500_000, minDeviceTsUs: 0 });
    expect(shouldApproveBump(i)).toBe(true);
  });

  it("设备水位恰在 now + 2s（阈值上，不满足严格小于）⇒ 视为不落后", () => {
    const i = input({ tailUs: NOW + 100_000, minDeviceTsUs: NOW + DEVICE_LOOKAHEAD_US });
    expect(shouldApproveBump(i)).toBe(false);
  });

  it("自定义前瞻阈值生效（lookaheadUs = 2s）", () => {
    const i = input({ tailUs: NOW + 3_000_000, minDeviceTsUs: NOW - 100_000 });
    // 用 6s 缺省判据：3s < 6s ⇒ 内容不足 ⇒ 放行
    expect(shouldApproveBump(i)).toBe(true);
    // 自定义 2s：3s ≥ 2s ⇒ 内容够 ⇒ 不放行
    expect(shouldApproveBump(i, 2_000_000)).toBe(false);
  });
});

describe("contentAheadUs — 内容前沿超前量", () => {
  it("环空 ⇒ 0", () => {
    expect(contentAheadUs(input({ tailUs: 0 }))).toBe(0);
  });

  it("正常超前 3s ⇒ 3_000_000", () => {
    expect(contentAheadUs(input({ tailUs: NOW + 3_000_000 }))).toBe(3_000_000);
  });

  it("前沿已过期 ⇒ 钳到 0（不返回负数）", () => {
    expect(contentAheadUs(input({ tailUs: NOW - 2_000_000 }))).toBe(0);
  });
});
