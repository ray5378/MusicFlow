// keepTail 旧尾存量校验回归锁（2026-11-19）
//
// 现场（240 12:29–12:55）：设备侧一次网络波动把桥缓冲抽干后，**连续 6 次换代都没恢复**：
//   keptFrames = 8634~16546（0.20~0.38s）、inQueueMs 全程 0~175，直到重启容器才恢复。
// 原因：keepTail 只看「预取就绪」，不看旧尾还剩多少 ⇒ 不清队列、不 bulk ⇒ 低缓冲被
// 一代代继承。
//
// 修法：keepTail 追加「所有在线桥的旧代次可投存量 ≥ 1s」，不满足就降级 bulk 重建缓冲。
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const DIR = fileURLToPath(new URL("../../src/services/sendspin", import.meta.url));
const src = fs.readFileSync(path.join(DIR, "server.ts"), "utf8");

describe("keepTail 旧尾存量校验", () => {
  it("阈值常量为 1 秒", () => {
    const m = src.match(/const BRIDGE_KEEP_TAIL_MIN_US = ([\d_]+);/);
    expect(m, "找不到 BRIDGE_KEEP_TAIL_MIN_US").not.toBeNull();
    expect(Number(m![1].replace(/_/g, ""))).toBe(1_000_000);
  });

  it("按旧代次（prevEpoch）累加剩余可投帧，且排除已投过的（水位）", () => {
    const i = src.indexOf("if (keepTail) {");
    expect(i).toBeGreaterThanOrEqual(0);
    const seg = src.slice(i, i + 1600);
    expect(seg).toContain("e.ep !== prevEpoch");
    expect(seg).toContain("e.tsUs <= wm");
    expect(seg).toContain("sum += BigInt(e.durUs)");
  });

  it("旧尾不足时降级（keepTail=false）并告警", () => {
    const i = src.indexOf("if (minOldUs < BRIDGE_KEEP_TAIL_MIN_US) {");
    expect(i).toBeGreaterThanOrEqual(0);
    const seg = src.slice(i, i + 400);
    expect(seg).toContain("keepTail = false;");
    expect(seg).toContain("bridge-keep-thin");
  });

  it("降级后确实落到 bulk 分支（清水位 + 登记 pending）", () => {
    const thin = src.indexOf("bridge-keep-thin");
    const bulk = src.indexOf("this.bridgeBulkPending.clear();", thin);
    expect(thin).toBeGreaterThanOrEqual(0);
    expect(bulk).toBeGreaterThan(thin);
  });

  it("与「预取未落 ring」校验共存（两者缺一不可）", () => {
    expect(src).toContain("bridge-keep-degraded");
    expect(src).toContain("bridge-keep-thin");
  });
});
