// 低缓冲自愈回归锁（2026-11-19）
//
// 根因：设备侧一次网络波动把桥缓冲追发到 0 后，`deltaUs` 从 2.06 塌到 1.53（贴住墙钟）
// ⇒ 系统再无「超前量」可攒回 ⇒ inQueueMs 长期 0~175、连续 6 次换代不恢复，只有重启
// 容器重建会话才回到 5500。
//
// 修法：`depthMs`（已推未播）跌破 3s 时，把 pacing 墙钟基准前提 2s ⇒ dueMs 提前 ⇒
// 泵立即多吐 ~2s 内容（源已在内存，无 IO 压力）⇒ 缓冲深度与 deltaUs 一起回升。
// 内容顺序与 ts 不变 ⇒ 设备侧连续、无静音。冷却 60s。
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const DIR = fileURLToPath(new URL("../../src/services/sendspin", import.meta.url));
const src = fs.readFileSync(path.join(DIR, "streamEngine.ts"), "utf8");

describe("低缓冲自愈", () => {
  it("三个常量就位（阈值 3s / 前提 2s / 冷却 60s）", () => {
    expect(src).toMatch(/export const BRIDGE_LOW_BUFFER_RECOVER_MS = 3_000;/);
    expect(src).toMatch(/export const BRIDGE_PACE_BUMP_MS = 2_000;/);
    expect(src).toMatch(/export const BRIDGE_PACE_BUMP_COOLDOWN_MS = 60_000;/);
  });

  it("有 lastPaceBumpAt 冷却字段", () => {
    expect(src).toMatch(/private lastPaceBumpAt = 0;/);
  });

  it("自愈动作是前提 paceAnchorWall（不是改 paceAnchorMs，避免进度错乱）", () => {
    const i = src.indexOf("sendspin buffer-recover");
    expect(i).toBeGreaterThanOrEqual(0);
    const seg = src.slice(Math.max(0, i - 600), i);
    expect(seg).toContain("this.paceAnchorWall -= BRIDGE_PACE_BUMP_MS;");
    expect(seg).not.toContain("this.paceAnchorMs -=");
  });

  it("触发条件：桥侧 inQueueMs 偏低且过冷却", () => {
    const i = src.indexOf("sendspin buffer-recover");
    const seg = src.slice(Math.max(0, i - 1200), i);
    // 判据来源：airplay 子进程主动推送的 bridgeStats 事件 → bridgeHealth.min()。
    // 前两版（depthMs / BridgeSource.queuedMs）都在真机上被证伪。
    expect(seg).toContain("bridgeInQ < BRIDGE_LOW_QUEUE_RECOVER_MS");
    expect(seg).toContain("const bridgeInQ = bridgeHealthLocal.min()");
    expect(seg).toContain("Date.now() - this.lastPaceBumpAt >= BRIDGE_PACE_BUMP_COOLDOWN_MS");
  });

  it("不再依赖 RPC 轮询（bridgeStatus 会误报子进程未运行）", () => {
    expect(src).not.toContain('rpc<');
    expect(src).not.toContain('"bridgeStatus"');
    expect(src).toContain('from "./bridgeHealthLocal.js"');
  });


  it("桥队列判据常量 2000ms", () => {
    expect(src).toMatch(/export const BRIDGE_LOW_QUEUE_RECOVER_MS = 2_000;/);
  });

  it("自愈位置在进度上报之后（本拍 cursorUs 已更新）", () => {
    const report = src.indexOf("this.group.positionMs = this.audiblePositionMs(framePosMs, cursorUs, floorMs);");
    const bump = src.indexOf("sendspin buffer-recover");
    expect(report).toBeGreaterThanOrEqual(0);
    expect(bump).toBeGreaterThan(report);
  });
});
