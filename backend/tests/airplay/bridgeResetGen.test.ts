// resetTimeline 帧代次重置（立项-B，2026-11-19 重试）
//
// 背景：暖复用时旧会话 `skippedFrames > 0` ⇒ `isContentAxisPoisoned()` ⇒
// `resetTimeline("warm-reuse-poisoned")`。复位后首帧若 `genChanged=false`，
// 那 2.1~2.3s 结构缺口会落进 `aligner.onFrame` 被**物化成静音**（240 实测
// `insert=94434`），而不是走 `newgen-skip`（阈值 `BRIDGE_NEWGEN_GAP_SKIP_US=500ms`）。
//
// ⚠️ 4.14.11 曾加过同一行并被真机否决：那次起播全程无声，真因是**旧推流循环未终止**
//   （`waitUntilUs` 卡在 sendAt ≈2s，新旧两流并行发包，`idx` 25788/240 交错，pacing 恒
//   lag 600ms）。4.14.12 撤回本行；4.14.13 在 P1（waitUntilUs 可中止）上线并真机验证
//   后重试 —— 所以本文件最后一条锁「P1 必须同时在场」是**前提条件**，不是可选检查。
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const DIR = fileURLToPath(new URL("../../src/services/airplay", import.meta.url));
const bsSrc = fs.readFileSync(path.join(DIR, "bridgeSession.ts"), "utf8");
const raopSrc = fs.readFileSync(path.join(DIR, "raop.ts"), "utf8");

function resetBody(): string {
  const start = bsSrc.indexOf("  resetTimeline(reason: string): void {");
  expect(start, "找不到 resetTimeline 定义").toBeGreaterThanOrEqual(0);
  const end = bsSrc.indexOf("\n  }\n", start);
  expect(end, "找不到 resetTimeline 结束").toBeGreaterThan(start);
  return bsSrc.slice(start, end);
}

describe("resetTimeline 帧代次重置（B）", () => {
  it("清 lastResampledGen（否则 genChanged=false，缺口被物化成静音）", () => {
    expect(resetBody()).toContain("this.lastResampledGen = 0");
  });

  it("清理发生在 aligner 置空之后（同一次重规划内生效）", () => {
    const body = resetBody();
    expect(body.indexOf("this.lastResampledGen = 0")).toBeGreaterThan(body.indexOf("this.aligner = null"));
  });

  it("不得改 this.generation（该字段由泵侧 refreshGeneration 驱动）", () => {
    expect(resetBody()).not.toMatch(/this\.generation\s*(\+\+|\+=|=)/);
  });

  it("仍清 skippedFrames（否则下次暖复用再次被判 poisoned）", () => {
    expect(resetBody()).toContain("this.stats.skippedFrames = 0");
  });

  it("新代次缺口阈值必须小于那 2.1s（否则 skip 分支永不触发）", () => {
    const m = bsSrc.match(/const BRIDGE_NEWGEN_GAP_SKIP_US = ([\d_]+);/);
    expect(m, "找不到 BRIDGE_NEWGEN_GAP_SKIP_US").not.toBeNull();
    const us = Number(m![1].replace(/_/g, ""));
    expect(us).toBeGreaterThan(0);
    expect(us).toBeLessThan(2_100_000);
  });

  it("★前提：P1 必须同时在场（waitUntilUs 可中止），否则本改动会重演 4.14.11 无声", () => {
    const i = raopSrc.indexOf("private async waitUntilUs(");
    expect(i, "找不到 waitUntilUs").toBeGreaterThanOrEqual(0);
    const seg = raopSrc.slice(i, raopSrc.indexOf("\n  }\n", i));
    expect(seg).toContain("!this.streaming || this.destroying");
  });
});
