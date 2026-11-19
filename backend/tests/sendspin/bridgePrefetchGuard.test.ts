// 供给侧加固回归锁（2026-11-19）
//
// 现场（240 10:26–10:30）：`keptFrames=7250`（旧尾仅 0.16s）→ inQueue 3325 → 0
// → late 涨到 27928 → 靠重锚恢复，卡顿 4 分钟。同一时刻 `bridge-prefetch-drop frames=0`
// 说明 `pushBridgePrefetch` 早退了（帧从没进 ring），但它仍返回 nextEpoch，上层据此
// 认为「预取就绪」⇒ prefetched=true ⇒ keepTail 保留旧尾却**不做 bulk 回填** ⇒ 断粮。
//
// 加固：记 `lastPrefetchFrames`（早退 0），keepTail 条件追加 `> 0`，不满足则降级 bulk。
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const DIR = fileURLToPath(new URL("../../src/services/sendspin", import.meta.url));
const src = fs.readFileSync(path.join(DIR, "server.ts"), "utf8");

describe("预取落 ring 校验（供给侧加固）", () => {
  it("有 lastPrefetchFrames 字段", () => {
    expect(src).toMatch(/private lastPrefetchFrames = 0;/);
  });

  it("pushBridgePrefetch 早退时置 0 并告警（不得让上层误判为已就绪）", () => {
    const i = src.indexOf('if (this.bridges.size === 0 || pcm.length === 0) {');
    expect(i).toBeGreaterThanOrEqual(0);
    const seg = src.slice(i, i + 500);
    expect(seg).toContain("this.lastPrefetchFrames = 0;");
    expect(seg).toContain("bridge-prefetch-skip");
  });

  it("正常路径记录真实写入帧数", () => {
    expect(src).toMatch(/this\.lastPrefetchFrames = ring\.length > 0 \? Math\.ceil\(pcm\.length \/ perFrame\) : 0;/);
  });

  it("keepTail 在预取未落 ring 时降级为 bulk", () => {
    expect(src).toContain("let keepTail = reason === \"track\" && prefetched === true");
    const i = src.indexOf("if (keepTail && this.lastPrefetchFrames <= 0) {");
    expect(i).toBeGreaterThanOrEqual(0);
    const seg = src.slice(i, i + 400);
    expect(seg).toContain("keepTail = false;");
    expect(seg).toContain("bridge-keep-degraded");
  });

  it("降级分支仍在「否则 bulk 回填」的同一函数里（不能只记日志不生效）", () => {
    const keep = src.indexOf("if (keepTail && this.lastPrefetchFrames <= 0) {");
    const bulk = src.indexOf("this.bridgeBulkPending.clear();", keep);
    expect(keep).toBeGreaterThanOrEqual(0);
    expect(bulk).toBeGreaterThan(keep);
  });
});
