// 低缓冲自愈（指令式）回归锁（2026-11-19）
//
// 职责划分：**桥侧判断**（它才知道 inQueue 被抽干成什么样）→ 发「请加速 ms」指令
// → 主进程转发 → **泵纯执行**（唯一能多产内容的一方，但它看不到设备侧水位）。
//
// 历史：v1 `depthMs`（sendspin 侧推算，含 30s 未投递量，崩溃时仍 3.7s）、
//       v2 `BridgeSource.queuedMs`（健康时本就小）、v3 RPC `bridgeStatus`（被
//       supervisor.running 误拒）、v4 水位跨进程推送（sendspin 侧仍读不到）——
//       四次都在真机证伪，最终落到「谁发现问题谁决策」。
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const SEND = fileURLToPath(new URL("../../src/services/sendspin", import.meta.url));
const AIR = fileURLToPath(new URL("../../src/services/airplay", import.meta.url));
const read = (dir: string, f: string) => fs.readFileSync(path.join(dir, f), "utf8");

describe("桥侧判断（airplay）", () => {
  it("判据与冷却都在桥侧，且持续 3s 才发指令", () => {
    const s = read(AIR, "bridgeSession.ts");
    expect(s).toContain("const BRIDGE_LOW_QUEUE_BUMP_MS = 2_000;");
    expect(s).toContain("const BRIDGE_LOW_QUEUE_PERSIST_MS = 3_000;");
    expect(s).toContain("const BRIDGE_PACE_BUMP_COOLDOWN_MS = 5_000;");
    expect(s).toContain("paceBumpSink?.({ deviceId: this.deviceId, ms: BRIDGE_PACE_BUMP_MS });");
  });

  it("节流：短冷却 5s + 设备缓冲天花板 8s（借自 MA）", () => {
    const s = read(AIR, "bridgeSession.ts");
    expect(s).toContain("const BRIDGE_PACE_BUMP_COOLDOWN_MS = 5_000;");
    expect(s).toContain("const BRIDGE_DEVICE_BUFFER_MAX_MS = 8_000;");
    // 判据是「补完不超天花板」，而不是数次数
    expect(s).toContain("bridgeInQ + BRIDGE_PACE_BUMP_MS <= BRIDGE_DEVICE_BUFFER_MAX_MS");
    expect(s).not.toContain("BRIDGE_PACE_BUMP_MAX_STREAK");
  });

  it("发出指令时打一条可 grep 的日志", () => {
    const s = read(AIR, "bridgeSession.ts");
    expect(s).toContain('ev: "pace-bump-req"');
  });
});

describe("转发（主进程）", () => {
  it("supervisor 收到 bridgePaceBump 后转给 sendspinSupervisor", () => {
    const s = read(AIR, "supervisor.ts");
    expect(s).toContain('ev.t === "bridgePaceBump"');
    expect(s).toContain('rpc("paceBump", { ms: ev.ms })');
  });
});

describe("纯执行（sendspin）", () => {
  it("childMain 有 paceBump handler，只转交不判断", () => {
    const s = read(SEND, "childMain.ts");
    expect(s).toContain('case "paceBump"');
    expect(s).toContain("requestPaceBump(ms)");
  });

  it("server 有 pendingPaceBumpMs 的存取", () => {
    const s = read(SEND, "server.ts");
    expect(s).toContain("private pendingPaceBumpMs = 0;");
    expect(s).toContain("requestPaceBump(ms: number): void {");
    expect(s).toContain("consumePaceBump(): number {");
  });

  it("泵每拍取走并把 pacing 墙钟基准前提（不判断阈值/冷却）", () => {
    const s = read(SEND, "streamEngine.ts");
    expect(s).toContain("consumePaceBump?.()");
    expect(s).toContain("this.paceAnchorWall -= bumpMs;");
    // 判断侧的东西不该残留在泵里
    expect(s).not.toContain("BRIDGE_LOW_QUEUE_RECOVER_MS");
    expect(s).not.toContain("bridgeHealthLocal");
  });
});
