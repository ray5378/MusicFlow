// Unit tests for services/plugin/shared.ts 的通用跨源兜底 runner ——
// 「逐个候选试、第一个可用的就返回、全耗尽回传轨迹」的纯逻辑(与业务解耦):
//   - 首个候选可用 → 直接返回,不再试后面的;
//   - 候选抛错 / 返回不可用 → 记轨迹后换下一个;
//   - maxTries 闸门:候选再多也只试 N 个;
//   - budgetMs 双闸门:预算耗尽即停手(超预算的候选记 "…(超预算)");
//   - 全耗尽 → ok=false + exhausted=true + 完整 trace;
//   - onError/onEmpty 返回 null 表示不记该段。
import { describe, it, expect } from "vitest";
import {
  runSourceFallback,
  FALLBACK_BUDGET_MS_DEFAULT,
  FALLBACK_MAX_TRIES_DEFAULT,
} from "../../src/services/plugin/shared.js";

/** 构造一个候选:可同步/异步返回,或抛错;attempts 记录被实际调用的次数。 */
function cand(label: string, impl: () => Promise<any>) {
  return { label, run: impl };
}

const okValue = { v: 1 };

describe("runSourceFallback — 通用兜底 runner", () => {
  it("首个候选可用即返回,不再试后续候选", async () => {
    const calls: string[] = [];
    const r = await runSourceFallback({
      candidates: [
        cand("a", async () => { calls.push("a"); return okValue; }),
        cand("b", async () => { calls.push("b"); return okValue; }),
      ],
      isUsable: (v) => !!v,
      now: () => 0,
    });
    expect(r.ok).toBe(true);
    expect(r.value).toBe(okValue);
    expect(r.exhausted).toBe(false);
    expect(r.trace).toEqual([]);
    expect(calls).toEqual(["a"]); // b 根本没机会跑
  });

  it("候选抛错 → 记 trace 后换下一个,最终命中", async () => {
    const r = await runSourceFallback({
      candidates: [
        cand("netease", async () => { throw new Error("403"); }),
        cand("lx-source", async () => okValue),
      ],
      isUsable: (v) => !!v,
      now: () => 0,
    });
    expect(r.ok).toBe(true);
    expect(r.trace).toEqual(["netease(403)"]); // 命中即返回,不追加命中项的 (空结果) 段
  });

  it("错误摘要截断到 80 字(根因在前)", async () => {
    const long = "E".repeat(200);
    const r = await runSourceFallback({
      candidates: [cand("slow", async () => { throw new Error(long); })],
      isUsable: (v) => !!v,
      now: () => 0,
    });
    const seg = r.trace[0] || "";
    expect(seg.startsWith("slow(")).toBe(true);
    expect(seg.endsWith("…)")).toBe(true);
    expect(seg.length).toBeLessThanOrEqual("slow(".length + 80 + "…)".length);
  });

  it("isUsable 判定不可用 → 记 (空结果) 并继续", async () => {
    const r = await runSourceFallback({
      candidates: [
        cand("a", async () => ({ songs: [] })),
        cand("b", async () => ({ songs: [{ id: "1" }] })),
      ],
      isUsable: (v) => Array.isArray(v.songs) && v.songs.length > 0,
      now: () => 0,
    });
    expect(r.ok).toBe(true);
    expect(r.value?.songs.length).toBe(1);
    expect(r.trace).toEqual(["a(空结果)"]);
  });

  it("maxTries 闸门:候选多也只试 maxTries 个,其余不执行", async () => {
    const calls: string[] = [];
    const r = await runSourceFallback({
      candidates: ["a", "b", "c", "d"].map((l) => cand(l, async () => {
        calls.push(l);
        return null; // 全不可用
      })),
      isUsable: (v) => !!v,
      maxTries: 2,
      now: () => 0,
    });
    expect(r.ok).toBe(false);
    expect(r.exhausted).toBe(true);
    expect(calls).toEqual(["a", "b"]); // c/d 没跑
    expect(r.trace).toEqual(["a(空结果)", "b(空结果)"]);
  });

  it("默认闸门口径(budgetMs 6000 / maxTries 2)由常量暴露", () => {
    expect(FALLBACK_BUDGET_MS_DEFAULT).toBe(6000);
    expect(FALLBACK_MAX_TRIES_DEFAULT).toBe(2);
  });

  it("budgetMs 耗尽 → 停手并把下一个候选记为 (超预算)", async () => {
    let clock = 0;
    const calls: string[] = [];
    const r = await runSourceFallback({
      candidates: [
        cand("a", async () => { clock = 6100; calls.push("a"); return null; }),
        cand("b", async () => { calls.push("b"); return { late: true }; }),
      ],
      isUsable: (v) => !!v,
      budgetMs: 6000,
      now: () => clock,
    });
    // a 消耗掉预算后剩余 <=0 → b 连一次都没开始,直接记 (超预算)。
    expect(r.ok).toBe(false);
    expect(calls).toEqual(["a"]);
    expect(r.trace).toEqual(["a(空结果)", "b(超预算)"]);

    // now() 每次调用都往前走 1000ms:起步即已超支 100ms 预算 → 第一个候选都没开始
    let t2 = 0;
    const clock2 = () => (t2 += 1000);
    const r2 = await runSourceFallback({
      candidates: [cand("a", async () => null)],
      isUsable: (v) => !!v,
      budgetMs: 100,
      now: clock2,
    });
    expect(r2.ok).toBe(false);
    expect(r2.trace).toEqual(["a(超预算)"]);
  });

  it("单个候选也被总预算约束:超时抛错 → 记超过兜底预算段", async () => {
    const r = await runSourceFallback({
      candidates: [cand("hang", () => new Promise((_res) => { /* 永不 settle */ }))],
      isUsable: (v) => !!v,
      budgetMs: 30,
      now: () => 0,
    });
    expect(r.ok).toBe(false);
    expect(r.trace).toEqual(["hang(超过兜底预算 30ms)"]);
  });

  it("onError/onEmpty 返回 null → 该段不记入 trace", async () => {
    const r = await runSourceFallback({
      candidates: [
        cand("a", async () => { throw new Error("boom"); }),
        cand("b", async () => null),
      ],
      isUsable: (v) => !!v,
      onError: (label) => (label === "a" ? `custom-a` : null),
      onEmpty: () => null,
      now: () => 0,
    });
    expect(r.ok).toBe(false);
    expect(r.trace).toEqual(["custom-a"]); // b 的 (空结果) 被 onEmpty null 抑制
  });

  it("空候选列表 → ok=false + exhausted=true(不抛错)", async () => {
    const r = await runSourceFallback({ candidates: [], isUsable: () => true, now: () => 0 });
    expect(r).toEqual({ ok: false, value: null, trace: [], exhausted: true });
  });

  it("candidates 非数组/缺字段时安全降级(不抛错)", async () => {
    const r = await runSourceFallback({
      candidates: [{ label: "x" } as any, null as any],
      isUsable: () => true,
      now: () => 0,
    });
    expect(r.ok).toBe(false);
    expect(r.exhausted).toBe(true);
  });
});
