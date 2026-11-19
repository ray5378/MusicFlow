// 桥 snapshot 暴露 inQueueMs 回归锁（2026-11-19）
//
// 低缓冲自愈需要「设备侧真实缓冲」，它只存在于 airplay 子进程的 BridgeSession 里。
// 前两轮判据（sendspin 侧 depthMs / BridgeSource.queuedMs）都被真机证伪，最终改为
// 由 `bridgeStatus` RPC 回传 snapshot.inQueueMs。
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const DIR = fileURLToPath(new URL("../../src/services/airplay", import.meta.url));
const src = fs.readFileSync(path.join(DIR, "bridgeSession.ts"), "utf8");

describe("snapshot.inQueueMs", () => {
  it("类型里声明 inQueueMs", () => {
    expect(src).toMatch(/inQueueMs:\s*number;/);
  });

  it("赋值用 backlogMs()（与 tick 日志同源，不能另算一套）", () => {
    expect(src).toContain("inQueueMs: this.backlogMs(),");
  });
});
