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
    // [S8 校准闭环]上报扩为多行(新增 actualSendAtUs/commandedAnchorUs/commandedLeadUs/holdDepthMs),
    // 文本锁改为锁「sink 调用 + 扩展字段」两个锚点。
    expect(s).toContain("bridgeStatsSink?.({");
    expect(s).toContain("deviceId: this.deviceId,");
    expect(s).toContain("inQueueMs: bridgeInQ,");
    expect(s).toContain("actualSendAtUs: this.actualSendAtUs");
    expect(s).toContain("commandedAnchorUs:");
    expect(s).toContain("backlogMs: bridgeInQ");
    expect(s).toContain("firstPacketLeadUs: this.firstPacketLeadUs");
    expect(s).toContain("isAp2: this.ap2Session !== null");
  });

  it("childMain 在构造函数内接线（send 在作用域内）", () => {
    const s = read("childMain.ts");
    expect(s).toContain("setBridgeStatsSink(");
    // [S8]上报改多行对象,文本锁改为锁事件类型 + 扩展字段透传
    expect(s).toContain('t: "bridgeStats"');
    expect(s).toContain("actualSendAtUs: row.actualSendAtUs");
    expect(s).toContain("backlogMs: row.backlogMs");
    expect(s).toContain("isAp2: row.isAp2");
  });

  it("事件类型与 supervisor 分支就位", () => {
    const ipc = read("ipcProtocol.ts");
    // [S8]事件扩展字段文本锁(实测 actualSendAtUs/commandedLeadUs/holdDepthMs)
    expect(ipc).toContain('{ t: "bridgeStats"; deviceId: string; inQueueMs: number; backlogMs: number; actualSendAtUs: number | null');
    const sup = read("supervisor.ts");
    expect(sup).toContain('ev.t === "bridgeStats"');
    expect(sup).toContain("bridgeHealth.record(ev.deviceId, ev.inQueueMs, ev.backlogMs)");
    expect(sup).toContain("!ev.isAp2");
    // [2026-11-24] S8 校准闭环已**停用并整块移除**：其测量口径错误
    // （firstPacketLeadUs 在 forceNow 形态置 0，而实际命令提前量为 cold 预热值）
    // 导致 drift 恒 >500ms、每 10s nudge 累积补偿到 12.9s ⇒ 切歌后卡顿。
    // 现断言「已停用」并保留原因注释，防止误恢复。
    expect(sup).toContain("校准闭环已停用");
    expect(sup).not.toContain("bridgeNudgeDelayDevice(ev.deviceId");
  });
});
