// 桥水位「跨进程转发」回归锁（2026-11-19）
//
// airplay 子进程(BridgeSession) → 主进程(supervisor) → sendspin 子进程(泵)。
// 240 实测：前两跳通了（ev-recv 有值），但 sendspin 侧读同一模块是 Infinity ——
// 进程隔离，globalThis 也不共享。故 sendspin 侧必须有自己的单元，由主进程经
// sendspinSupervisor.rpc("bridgeHealth") 灌入。
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { bridgeHealthLocal } from "../../src/services/sendspin/bridgeHealthLocal.js";

const SPIN = fileURLToPath(new URL("../../src/services/sendspin", import.meta.url));
const AIR = fileURLToPath(new URL("../../src/services/airplay", import.meta.url));
const read = (dir: string, f: string) => fs.readFileSync(path.join(dir, f), "utf8");

describe("bridgeHealthLocal（sendspin 子进程内）", () => {
  afterEach(() => bridgeHealthLocal.reset());

  it("无数据为 Infinity", () => {
    expect(bridgeHealthLocal.min()).toBe(Number.POSITIVE_INFINITY);
  });

  it("记录后可读", () => {
    bridgeHealthLocal.record(3200);
    expect(bridgeHealthLocal.min()).toBe(3200);
  });

  it("忽略非有限值", () => {
    bridgeHealthLocal.record(Number.NaN);
    expect(bridgeHealthLocal.min()).toBe(Number.POSITIVE_INFINITY);
  });
});

describe("跨进程转发链路", () => {
  it("sendspin childMain 有 bridgeHealth handler", () => {
    const s = read(SPIN, "childMain.ts");
    expect(s).toContain('case "bridgeHealth"');
    expect(s).toContain("bridgeHealthLocal.record(ms)");
  });

  it("airplay supervisor 收到 bridgeStats 后转发给 sendspinSupervisor", () => {
    const s = read(AIR, "supervisor.ts");
    expect(s).toContain('sendspinSupervisor.rpc("bridgeHealth"');
    expect(s).toContain("minInQueueMs: min");
  });

  it("streamEngine 判据读 local（不是主进程的 bridgeHealth）", () => {
    const s = read(SPIN, "streamEngine.ts");
    expect(s).toContain("const bridgeInQ = bridgeHealthLocal.min()");
    expect(s).toContain("bridgeInQ < BRIDGE_LOW_QUEUE_RECOVER_MS");
  });
});
