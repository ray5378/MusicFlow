// 低缓冲自愈（指令式）回归锁（2026-11-19）
//
// 职责划分：**桥侧判断**（只有它知道 inQueue 被抽干成什么样）→ 发「请加速 ms」指令
// → 主进程转发 → **泵纯执行**（唯一能多产内容的一方，但它看不到设备侧水位）。
//
// 历史（四次真机证伪后落到这个设计）：
//   v1 `depthMs`（sendspin 侧推算，含 30s 未投递量 ⇒ 崩溃时仍 3.7s）
//   v2 `BridgeSource.queuedMs`（健康时本就小 ⇒ 15s 缓冲时误触发）
//   v3 RPC `bridgeStatus`（被 supervisor.running 误拒）
//   v4 水位跨进程推送（sendspin 侧读同一模块仍是 Infinity —— 进程隔离）
//
// 另：加压信号最终走 **globalThis 总线**，因为 `getServer()` 在不同时机返回的对象
// 不一致（server 会重建），实例方法 `requestPaceBump` 会报 is not a function。
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { paceBumpBus } from "../../src/services/sendspin/paceBumpBus.js";

const SEND = fileURLToPath(new URL("../../src/services/sendspin", import.meta.url));
const AIR = fileURLToPath(new URL("../../src/services/airplay", import.meta.url));
const read = (dir: string, f: string) => fs.readFileSync(path.join(dir, f), "utf8");

describe("加压信号总线", () => {
  afterEach(() => paceBumpBus.reset());

  it("累加与取走清零", () => {
    paceBumpBus.add(2000);
    paceBumpBus.add(1000);
    expect(paceBumpBus.take()).toBe(3000);
    expect(paceBumpBus.take()).toBe(0);
  });

  it("忽略非法值", () => {
    paceBumpBus.add(Number.NaN);
    paceBumpBus.add(-5);
    expect(paceBumpBus.take()).toBe(0);
  });
});

describe("桥侧判断（airplay）", () => {
  it("阈值为 2s、持续 3s、冷却 5s、天花板 8s", () => {
    const s = read(AIR, "bridgeSession.ts");
    expect(s).toContain("const BRIDGE_LOW_QUEUE_BUMP_MS = 2_000;");
    expect(s).toContain("const BRIDGE_LOW_QUEUE_PERSIST_MS = 3_000;");
    expect(s).toContain("const BRIDGE_PACE_BUMP_COOLDOWN_MS = 5_000;");
    expect(s).toContain("const BRIDGE_DEVICE_BUFFER_MAX_MS = 8_000;");
  });

  it("节流按剩余空间（补完不超天花板），不是数次数", () => {
    const s = read(AIR, "bridgeSession.ts");
    expect(s).toContain("bridgeInQ + BRIDGE_PACE_BUMP_MS <= BRIDGE_DEVICE_BUFFER_MAX_MS");
    expect(s).not.toContain("BRIDGE_PACE_BUMP_MAX_STREAK");
  });

  it("发指令时打可 grep 的日志", () => {
    const s = read(AIR, "bridgeSession.ts");
    expect(s).toContain('ev: "pace-bump-req"');
  });
});

describe("转发（主进程）", () => {
  it("supervisor 把 bridgePaceBump 转给 sendspinSupervisor", () => {
    const s = read(AIR, "supervisor.ts");
    expect(s).toContain('ev.t === "bridgePaceBump"');
    expect(s).toContain('rpc("paceBump", { ms: ev.ms })');
  });
});

describe("纯执行（sendspin）", () => {
  it("childMain 只写总线，不判断", () => {
    const s = read(SEND, "childMain.ts");
    expect(s).toContain('case "paceBump"');
    expect(s).toContain("paceBumpBus.add(ms)");
  });

  it("泵每拍取走并前提 paceAnchorWall（不残留阈值/冷却/本地水位）", () => {
    const s = read(SEND, "streamEngine.ts");
    expect(s).toContain("const bumpMs = paceBumpBus.take();");
    expect(s).toContain("this.paceAnchorWall -= bumpMs;");
    expect(s).not.toContain("BRIDGE_LOW_QUEUE_RECOVER_MS");
    expect(s).not.toContain("bridgeHealthLocal");
  });
});
