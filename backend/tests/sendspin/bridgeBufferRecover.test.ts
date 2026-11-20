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

  it("★未批准不执行：请求必须经 approve 才能进执行槽（2026-11-19 20:04 事故）", () => {
    // 事故：泵每 25ms take 一次、server 每 250ms 才 peek，请求总被泵抢走
    // ⇒ 准入判据从未执行 ⇒ deliverable 涨到 28~30s、delta 掉负。
    paceBumpBus.add(2000);
    paceBumpBus.add(1000);
    // 未经批准，泵取不到
    expect(paceBumpBus.takeApproved()).toBe(0);
    expect(paceBumpBus.peek()).toBe(3000);
    // 批准后转入执行槽
    paceBumpBus.approve();
    expect(paceBumpBus.peek()).toBe(0);
    expect(paceBumpBus.takeApproved()).toBe(3000);
    expect(paceBumpBus.takeApproved()).toBe(0);
  });

  it("拒绝即丢弃待审量", () => {
    paceBumpBus.add(2000);
    expect(paceBumpBus.reject()).toBe(2000);
    expect(paceBumpBus.peek()).toBe(0);
    expect(paceBumpBus.takeApproved()).toBe(0);
  });

  it("忽略非法值", () => {
    paceBumpBus.add(Number.NaN);
    paceBumpBus.add(-5);
    paceBumpBus.approve();
    expect(paceBumpBus.takeApproved()).toBe(0);
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

  it("★判断是否需要补：泵侧看内容超前量，超标即拒绝（2026-11-19 18:42 事故）", () => {
    // 判断落在**投递侧**：ring 里堆着 ≥6s 未投内容 ⇒ 不是缺料，丢弃请求。
    //   用 currentGenDeliverableUs（Fix 2026-10-31 验证过的"真实可投存量"），
    //   不用 currentGenTailUs（注释明确：恒为幻影值，不参与判据）。
    const srv = read(SEND, "server.ts");
    expect(srv).toContain("if (paceBumpBus.peek() > 0) {");
    expect(srv).toContain("const deliverableUs = this.currentGenDeliverableUs(ring, lo, wm);");
    expect(srv).toContain("const BRIDGE_BUMP_MAX_DELIVERABLE_MS = 8_000;");
    expect(srv).toContain("if (deliverableUs >= BigInt(BRIDGE_BUMP_MAX_DELIVERABLE_MS) * 1000n) {");
    expect(srv).toContain("bridge-push-bulk-rebuild");
    expect(srv).toContain("const dropped = paceBumpBus.reject();");
    expect(srv).toContain("paceBumpBus.approve();");

    // 泵恢复纯执行：不做超前量判断（该判据实测不成立：正常 14.95s vs 事故 34.96s）
    const se = read(SEND, "streamEngine.ts");
    expect(se).toContain("const bumpMs = paceBumpBus.takeApproved();");
    expect(se).toContain("this.paceAnchorWall -= bumpMs;");
    expect(se).not.toContain("BRIDGE_BUMP_MAX_AHEAD_MS");
    expect(se).not.toContain("aheadMs");

    // 桥侧只报事实，不得残留任何"次数/时长"刹车
    const air = read(AIR, "bridgeSession.ts");
    expect(air).not.toContain("bumpBlockedAt");
    expect(air).not.toContain("bumpIneffective");
    expect(air).not.toContain("bumpStreak");
    expect(air).not.toContain("bumpProbeFromMs");
    expect(air).not.toContain("BRIDGE_BUMP_WINDOW_MAX");
    expect(air).not.toContain("BRIDGE_BUMP_BLOCK_MAX_MS");
    expect(air).not.toContain("pace-bump-blocked");
    // 但"设备侧饿了就报"这条保留
    expect(air).toContain('ev: "pace-bump-req"');
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
    expect(s).toContain("const bumpMs = paceBumpBus.takeApproved();");
    expect(s).toContain("this.paceAnchorWall -= bumpMs;");
    expect(s).not.toContain("BRIDGE_LOW_QUEUE_RECOVER_MS");
    expect(s).not.toContain("bridgeHealthLocal");
  });
  it("★有料投不出时触发 bulk 重建缓冲（2026-11-19 23:48 定案）", () => {
    const s = read(SEND, "server.ts");
    // 窗口只有 1.5s 宽、每拍只放 250ms；设备 5.5s 缓冲靠 bulk 一次性灌 6s 建立。
    // 所以「有料投不出」必须挂 bulk pending，而不是只 reject（那样永远干涸）。
    expect(s).toContain("bridge-push-bulk-rebuild");
    expect(s).toContain("this.bridgeBulkPending.add(deviceId);");
    // 真缺料那条路仍然走 pace-bump（泵多产）
    expect(s).toContain("paceBumpBus.approve();");
  });
});

describe("报饿门控：设备未接流时不得报饿（2026-11-20 断电实测）", () => {
  it("★判据必须要求 anchorUs 非空 —— 否则 listening/离线时 inQueue 恒 0 会被当成\"饿\"无限加速", () => {
    const s = read(AIR, "bridgeSession.ts");
    expect(s).toContain("bridgeInQ < lowThresholdMs && this.anchorUs !== null");
    // 反向锁：不允许存在"只看水位就报饿"的形态
    expect(s).not.toContain("if (bridgeInQ < BRIDGE_LOW_QUEUE_BUMP_MS) {");
  });
});

describe("换代补足：换代把缓冲打低时放宽报饿阈值（2026-11-20 实测 7.0s→2.7s）", () => {
  it("★gen 变化即重开 20s 窗口，窗口内阈值 4s", () => {
    const s = read(AIR, "bridgeSession.ts");
    expect(s).toContain("const BRIDGE_POST_GEN_LOW_MS = 4_000;");
    expect(s).toContain("const BRIDGE_POST_GEN_WINDOW_MS = 20_000;");
    // 窗口必须跟着 generation 走（不是按时间单纯滚动，也不是只判一次）
    expect(s).toContain("if (genNow !== this.postGenWindowGen)");
    expect(s).toContain("this.postGenWindowUntilMs = nowMs + BRIDGE_POST_GEN_WINDOW_MS");
  });

  it("判据用的是窗口阈值，且窗口外仍回到 2000（不改变常规饥饿语义）", () => {
    const s = read(AIR, "bridgeSession.ts");
    expect(s).toContain("const lowThresholdMs = inPostGenWindow");
    expect(s).toContain("if (bridgeInQ < lowThresholdMs && this.anchorUs !== null)");
    // 反向锁：不允许退回"只有固定 2000 阈值"的形态
    expect(s).not.toContain("if (bridgeInQ < BRIDGE_LOW_QUEUE_BUMP_MS && this.anchorUs !== null) {");
  });

  it("请求日志能区分「换代补足」与「常规饥饿」", () => {
    const s = read(AIR, "bridgeSession.ts");
    expect(s).toContain("genWindow: inPostGenWindow");
    expect(s).toContain("thrMs: lowThresholdMs");
  });
});
