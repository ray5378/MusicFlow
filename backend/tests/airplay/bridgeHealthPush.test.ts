// 桥水位「子进程主动推送」回归锁（2026-11-19）
//
// 为什么不用 RPC：`airplaySupervisor.rpc("bridgeStatus")` 会因 rendererHost/supervisor
// 的 running 标志与真实状态不同步而误报「子进程未运行」——240 实测桥 tick 一直在打、
// 音频一直在播，RPC 却全拒。改走 process.send 单向事件。
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { bridgeHealth } from "../../src/services/airplay/bridgeHealth.js";

const DIR = fileURLToPath(new URL("../../src/services/airplay", import.meta.url));
const read = (f: string) => fs.readFileSync(path.join(DIR, f), "utf8");

describe("bridgeHealth 共享状态", () => {
  afterEach(() => bridgeHealth.reset());

  it("无数据时为 Infinity（判据不成立）", () => {
    expect(bridgeHealth.min()).toBe(Number.POSITIVE_INFINITY);
  });

  it("多桥取最薄", () => {
    bridgeHealth.record("a", 5200);
    bridgeHealth.record("b", 300);
    expect(bridgeHealth.min()).toBe(300);
  });

  it("忽略非有限值", () => {
    bridgeHealth.record("a", Number.NaN);
    expect(bridgeHealth.min()).toBe(Number.POSITIVE_INFINITY);
  });
});

describe("推送链路（子进程侧）", () => {
  it("bridgeSession 有 sink 且在 tick 里上报 backlogMs", () => {
    const s = read("bridgeSession.ts");
    expect(s).toContain("export function setBridgeStatsSink");
    expect(s).toContain("bridgeStatsSink?.({ deviceId: this.deviceId, inQueueMs: this.backlogMs() });");
  });

  it("childMain 在构造函数内接线（send 在作用域内）", () => {
    const s = read("childMain.ts");
    expect(s).toContain("setBridgeStatsSink(");
    expect(s).toContain('send({ t: "bridgeStats"');
  });

  it("事件类型与 supervisor 分支就位", () => {
    const ipc = read("ipcProtocol.ts");
    expect(ipc).toContain('{ t: "bridgeStats"; deviceId: string; inQueueMs: number }');
    const sup = read("supervisor.ts");
    expect(sup).toContain('ev.t === "bridgeStats"');
    expect(sup).toContain("bridgeHealth.record(ev.deviceId, ev.inQueueMs)");
  });
});
