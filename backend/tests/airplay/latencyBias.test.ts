// 自适应延迟偏置：纯学习函数单测（无 IO）。
import { describe, expect, it } from "vitest";
import { fastStep, learnStep, type BiasRecord } from "../../src/services/airplay/latencyBias.js";

describe("airplay latencyBias — learnStep", () => {
  it("残差小于 40ms 视为噪声，不计入、不推进", () => {
    const r = learnStep(null, 10_000);
    expect(r.biasUs).toBe(0);
    expect(r.hits).toBe(0);
  });

  it("单次跳变不推进（要连续同向稳定才学）", () => {
    let rec: BiasRecord | null = null;
    rec = learnStep(rec, 225_000);
    expect(rec.biasUs).toBe(0);
    expect(rec.hits).toBe(1);
    // 符号翻转 ⇒ 重新计数
    rec = learnStep(rec, -225_000);
    expect(rec.hits).toBe(1);
    expect(rec.biasUs).toBe(0);
  });

  it("连续 5 次稳定同向（±40ms 内）⇒ 按半步长推进偏置", () => {
    let rec: BiasRecord | null = null;
    for (let i = 0; i < 5; i++) rec = learnStep(rec, 225_000 + i * 1000);
    // 第 5 次触发时用的是当次残差（229ms）⇒ 半步 ≈114.5ms
    expect(rec!.biasUs).toBe(114_500);
    expect(rec!.hits).toBe(0); // 推进后重新累计
  });

  it("慢通道步进夹 500ms、总偏置上限 ±10s（= min(成员延迟量程, insertCap)）", () => {
    let rec: BiasRecord | null = null;
    for (let i = 0; i < 5; i++) rec = learnStep(rec, 1_500_000);
    expect(rec!.biasUs).toBe(500_000); // 半步 750ms 被夹到 500ms
    for (let round = 0; round < 40; round++) {
      for (let i = 0; i < 5; i++) rec = learnStep(rec, 1_500_000);
    }
    expect(rec!.biasUs).toBe(10_000_000);
  });

  it("fast 通道单步夹 2s（成员变更时一次多走，但仍不越总上限）", () => {
    let rec: BiasRecord | null = null;
    rec = fastStep(rec, 5_000_000);
    expect(rec!.biasUs).toBe(2_000_000);
    for (let i = 0; i < 10; i++) rec = fastStep(rec, 5_000_000);
    expect(rec!.biasUs).toBe(10_000_000);
  });

  it("残差消失后不再推进（已收敛）", () => {
    let rec: BiasRecord | null = null;
    for (let i = 0; i < 5; i++) rec = learnStep(rec, 225_000);
    const fixed = rec!.biasUs;
    for (let i = 0; i < 20; i++) rec = learnStep(rec, 5_000);
    expect(rec!.biasUs).toBe(fixed);
  });
});
