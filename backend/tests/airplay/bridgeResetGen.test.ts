// resetTimeline 的代次重置回归锁（2026-11-18）
//
// 背景（240 实测 15:04:09）：
//   上一代 newgen-skip 留下 `stats.skippedFrames > 0`
//   → 暖复用时 `isContentAxisPoisoned()` 命中 → `resetTimeline("warm-reuse-poisoned")`
//   → resetTimeline 置 `aligner=null`、清 skippedFrames，但**没清 lastResampledGen**
//   → 新曲首帧的 `entry.generation` 恰等于旧 `lastResampledGen` ⇒ `genChanged=false`
//   → 2.15s 结构缺口不进 newgen-skip（阈值 500ms），落进 `aligner.onFrame` 被物化成
//     静音：`insert=94809`（2149.9ms）可闻断音。
//   同一时段另外 4 次正常切歌（未 reset）全部零 realigned —— 复现率 1/5，条件明确。
//
// 钉三件事：
//   ① resetTimeline 必须清 lastResampledGen（否则 genChanged 失效）；
//   ② 它**不能**改 `this.generation` —— 该字段由泵侧代次驱动（refreshGeneration），
//      桥侧自行递增会让组锚点登记与 tick 口径错位；
//   ③ resetTimeline 仍保留 skippedFrames 清零（否则下次暖复用又被判污染）。
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const SRC_DIR = fileURLToPath(new URL("../../src/services/airplay", import.meta.url));
const src = fs.readFileSync(path.join(SRC_DIR, "bridgeSession.ts"), "utf8");

/** 切出 resetTimeline 方法体（按文本标记，行号会漂）。 */
function resetBody(): string {
  const start = src.indexOf("  resetTimeline(reason: string): void {");
  expect(start, "找不到 resetTimeline 定义").toBeGreaterThanOrEqual(0);
  const end = src.indexOf("\n  }\n", start);
  expect(end, "找不到 resetTimeline 结束").toBeGreaterThan(start);
  return src.slice(start, end);
}

describe("resetTimeline 代次重置", () => {
  it("清 lastResampledGen（否则新曲首帧 genChanged=false，缺口被物化成静音）", () => {
    expect(resetBody()).toContain("this.lastResampledGen = 0");
  });

  it("清理发生在 aligner 置空之后（同一次重规划内生效）", () => {
    const body = resetBody();
    const alignerAt = body.indexOf("this.aligner = null");
    const genAt = body.indexOf("this.lastResampledGen = 0");
    expect(alignerAt).toBeGreaterThanOrEqual(0);
    expect(genAt).toBeGreaterThan(alignerAt);
  });

  it("不得改 this.generation（该字段由泵侧代次驱动，桥侧无权递增）", () => {
    expect(resetBody()).not.toMatch(/this\.generation\s*(\+\+|\+=|=)/);
  });

  it("仍清 skippedFrames（否则下次暖复用再次被判 poisoned）", () => {
    expect(resetBody()).toContain("this.stats.skippedFrames = 0");
  });

  it("新代次缺口阈值必须小于那 2.15s（否则 skip 分支永不触发）", () => {
    const m = src.match(/const BRIDGE_NEWGEN_GAP_SKIP_US = ([\d_]+);/);
    expect(m, "找不到 BRIDGE_NEWGEN_GAP_SKIP_US").not.toBeNull();
    const us = Number(m![1].replace(/_/g, ""));
    expect(us).toBeGreaterThan(0);
    expect(us).toBeLessThan(2_150_000);
  });
});
