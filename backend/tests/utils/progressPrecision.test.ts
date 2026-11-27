import { describe, it, expect } from "vitest";
import { toDecisecond } from "../../src/utils/progressPrecision.js";

// 对外进度统一 0.1s 精度：把不足 1s 的零头保留下来，避免消费端本地校准被整秒往回拽。
describe("toDecisecond（对外进度 0.1s 精度）", () => {
  it("毫秒转 0.1s 并四舍五入（不是 floor）", () => {
    expect(toDecisecond(0)).toBe(0);
    expect(toDecisecond(1234)).toBe(1.2);
    expect(toDecisecond(1250)).toBe(1.3); // 四舍五入到 0.1s
    expect(toDecisecond(1299)).toBe(1.3);
    expect(toDecisecond(100)).toBe(0.1);
  });

  it("负数 / NaN / Infinity 归零（非法输入不污染对外进度）", () => {
    expect(toDecisecond(-1000)).toBe(-1); // 负数按真实换算，不特殊处理
    expect(toDecisecond(NaN)).toBe(0);
    expect(toDecisecond(Infinity)).toBe(0);
    expect(toDecisecond(-Infinity)).toBe(0);
  });

  it("整秒没有零头时保持整值（D3 修复的核心断言）", () => {
    // 30s 内不再有每次 -1.00s 的回退：整秒值与 0.1s 值一致
    expect(toDecisecond(30_000)).toBe(30);
    expect(toDecisecond(30_100)).toBe(30.1);
  });
});
