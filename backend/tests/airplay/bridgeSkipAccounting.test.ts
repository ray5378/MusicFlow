// 跳段分账回归锁（立项-C，2026-11-19）
//
// 问题链（240 实测 17:12~17:33，连续 7 次切歌全部命中）：
//   B（resetTimeline 清 lastResampledGen）⇒ 复位后首帧走 newgen-skip
//   ⇒ skip 帧数记进 stats.skippedFrames
//   ⇒ isContentAxisPoisoned() = skippedFrames > 0 恒真
//   ⇒ 下一次换歌必然判 warm-reuse-poisoned 再 resetTimeline
//   ⇒ 每次都重建 anchors/aligner ⇒ 曲头 10s 内更易出现内容空档
//   ⇒ 曲中 insert 变密（50min 7 次 / 2.25s；4.14.10 时代约每 25 分钟一次）
//
// docs/airplay-权威方案文档.md「已知边界」早就写明：poisoned 后**每代次只有第一次**
// 换歌出现 newgen-skip+垫音，"其后多次换歌零复现"。B 之后变成每次复现 —— 判据把
// 「换代正常跳段」误当成了「曲中污染跳段」。
//
// 本文件锁分账口径：newgen-skip 只进 `newgenSkipFrames`（诊断），`skippedFrames`
// 只收曲中跳段，从而让 `isContentAxisPoisoned()` 保持原实现却退回正确语义。
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const DIR = fileURLToPath(new URL("../../src/services/airplay", import.meta.url));
const src = fs.readFileSync(path.join(DIR, "bridgeSession.ts"), "utf8");

describe("跳段分账", () => {
  it("newgen-skip 分支给动作打 newgenSkip 标记", () => {
    const i = src.indexOf('ev: "newgen-skip"');
    expect(i).toBeGreaterThanOrEqual(0);
    // 标记在上游（act 构造）里，与日志同处一个 if 块
    const seg = src.slice(Math.max(0, i - 1200), i);
    expect(seg).toContain("newgenSkip: true");
  });

  it("累加处按标记分账，不再一律记 skippedFrames", () => {
    expect(src).toContain("if (act.newgenSkip) this.stats.newgenSkipFrames += act.skipFrames;");
    expect(src).toContain("else this.stats.skippedFrames += act.skipFrames;");
  });

  it("两只计数器都进 stats 接口与初始化", () => {
    expect(src).toMatch(/newgenSkipFrames:\s*number;/);
    expect(src).toContain("newgenSkipFrames: 0,");
  });

  it("resetTimeline 同时清两只计数器", () => {
    const i = src.indexOf("  resetTimeline(reason: string): void {");
    const seg = src.slice(i, src.indexOf("\n  }\n", i));
    expect(seg).toContain("this.stats.skippedFrames = 0;");
    expect(seg).toContain("this.stats.newgenSkipFrames = 0;");
  });

  it("★污染判据仍只看 skippedFrames（曲中跳段），不看 newgenSkipFrames", () => {
    // 守卫 check-airplay-bridge.mjs 按此字面量钉行，这里再锁一次语义
    expect(src).toMatch(/isContentAxisPoisoned\(\)\s*:\s*boolean\s*\{\s*return\s+this\.stats\.skippedFrames\s*>\s*0\s*;\s*\}/);
    // 只看方法体本身（相邻的 resetTimeline 里有 newgenSkipFrames = 0，不能算进来）
    const i = src.indexOf('isContentAxisPoisoned(): boolean {');
    expect(i).toBeGreaterThanOrEqual(0);
    const body = src.slice(i, src.indexOf('}', i) + 1);
    expect(body).not.toContain('newgenSkipFrames');
  });

  it("tick 上报带 newgenSkipFrames（便于真机区分两类跳段）", () => {
    expect(src).toContain("newgenSkipFrames: this.stats.newgenSkipFrames,");
  });
});
