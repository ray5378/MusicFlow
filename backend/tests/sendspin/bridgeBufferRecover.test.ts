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
    expect(s).toContain("rpc(\"paceBump\", { ms: ev.ms, deficitMs: ev.deficitMs })");
  });
});

describe("纯执行（sendspin）", () => {
  it("childMain 只写总线，不判断", () => {
    const s = read(SEND, "childMain.ts");
    expect(s).toContain('case "paceBump"');
    expect(s).toContain("paceBumpBus.add(ms, Number.isFinite(deficitMs) ? deficitMs : 0)");
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
    expect(s).toContain("bridgeInQ < BRIDGE_TOPUP_THRESHOLD_MS && this.anchorUs !== null");
    // 反向锁：不允许存在"只看水位就报饿"的形态
    expect(s).not.toContain("if (bridgeInQ < BRIDGE_LOW_QUEUE_BUMP_MS) {");
  });
});

describe("垫子补足：低于 6s 报一次，补量按 deficit 补到 8s", () => {
  it("★单一阈值 6s（不依赖换代窗口——keep 路径不改帧代次，感知不到）", () => {
    const s = read(AIR, "bridgeSession.ts");
    expect(s).toContain("const BRIDGE_TOPUP_THRESHOLD_MS = 6_000;");
    expect(s).toContain("if (bridgeInQ < BRIDGE_TOPUP_THRESHOLD_MS && this.anchorUs !== null) {");
    // 反向锁：窗口机制必须已删除
    expect(s).not.toContain("postGenWindowGen");
    expect(s).not.toContain("BRIDGE_POST_GEN_LOW_MS");
  });

  it("日志里能看到阈值与缺口（排障用）", () => {
    const s = read(AIR, "bridgeSession.ts");
    expect(s).toContain("thrMs: BRIDGE_TOPUP_THRESHOLD_MS");
    expect(s).toContain("deficitMs,");
  });
});

describe("换代投递损失统计（先量化，再定阈值）", () => {
  it("换代后 20 秒窗口输出「应该投 vs 实际投」", () => {
    const s = read(SEND, "server.ts");
    expect(s).toContain("const BRIDGE_GEN_LOSS_WINDOW_US = 20_000_000;");
    expect(s).toContain("bridge-gen-delivery-loss");
    expect(s).toContain("lossMs=");
    // 起点必须在换代两分支之后统一记录（keep / bulk 两条路都要量到）
    expect(s).toContain("this.genLoss.set(deviceId, { atUs: t0");
  });
});

describe("补到目标水位：deficit 限流 + 起播不开窗（2026-11-20 实测 11275 超天花板）", () => {
  it("桥侧报饿时带 deficitMs = 目标水位 − inQueue", () => {
    const s = read(AIR, "bridgeSession.ts");
    expect(s).toContain("BRIDGE_DEVICE_BUFFER_MAX_MS - Math.round(bridgeInQ)");
    expect(s).toContain("paceBumpSink?.({ deviceId: this.deviceId, ms: BRIDGE_PACE_BUMP_MS, deficitMs })");
  });

  it("deficit 跨进程透传到 sendspin（事件 → rpc → 总线）", () => {
    expect(read(AIR, "ipcProtocol.ts")).toContain("deficitMs?: number");
    expect(read(AIR, "childMain.ts")).toContain("deficitMs: req.deficitMs");
    expect(read(AIR, "supervisor.ts")).toContain("deficitMs: ev.deficitMs");
    expect(read(SEND, "childMain.ts")).toContain("paceBumpBus.add(ms, Number.isFinite(deficitMs) ? deficitMs : 0)");
    expect(read(SEND, "paceBumpBus.ts")).toContain("peekDeficit()");
  });

  it("★bulk 量按 deficit 限流（不是固定 6s）", () => {
    const s = read(SEND, "server.ts");
    expect(s).toContain("const deficitMs = paceBumpBus.peekDeficit();");
    expect(s).toContain("this.bridgeBulkDeficitMs.set(deviceId, deficitMs)");
    expect(s).toContain("const capUs = deficitUs > 0n && deficitUs < baseCapUs ? deficitUs : baseCapUs;");
  });
});

describe("★Fix H：桥队列缺料但 ring 有货 ⇒ 直接 bulk 灌桥（2026-11-20 实测 3 次加速空转）", () => {
  // 240 实测（v4.14.26, 10:39）：桥侧连发 3 次共 6000ms 加速请求，inQueue 5525→7750
  // 只 +2225；同时 deliverable 6025→8225（+2200）⇒ 泵多吐的料全堆在 ring，
  // 桥队列一点没涨，最后靠撞 8s 天花板被动转 bulk 才恢复。
  // 根因：窗口投递带宽受时间轴门控（1.5s/拍），泵产得再早也投不进桥队列。
  it("存在 6s 且缺料 ⇒ bulk 的分支，且排在 8s 判据之后、approve 之前", () => {
    const s = read(SEND, "server.ts");
    const iOverfull = s.indexOf("BRIDGE_BUMP_MAX_DELIVERABLE_MS) * 1000n");
    const iTopup = s.indexOf("bridge-push-topup-bulk");
    const iApprove = s.indexOf('bridge-push-approve-bump');
    expect(iOverfull).toBeGreaterThan(0);
    expect(iTopup).toBeGreaterThan(iOverfull);
    expect(iApprove).toBeGreaterThan(iTopup);
  });

  it("该分支必须取桥侧 deficit 并登记 bulk pending（不 approve 泵加速）", () => {
    const s = read(SEND, "server.ts");
    const start = s.indexOf("// [Fix H 2026-11-20]");
    const end = s.indexOf("paceBumpBus.approve();", start);
    expect(start).toBeGreaterThan(0);
    expect(end).toBeGreaterThan(start);
    const seg = s.slice(start, end);
    expect(seg).toContain("paceBumpBus.peekDeficit() > 0");
    expect(seg).toContain("deliverableUs >= BigInt(BRIDGE_BACKFILL_MAX_US)");
    expect(seg).toContain("this.bridgeBulkDeficitMs.set(deviceId, deficitMs)");
    expect(seg).toContain("this.bridgeBulkPending.add(deviceId)");
    // 该分支里不能再调 approve（否则等于又走回空转路径）
    expect(seg).not.toContain("paceBumpBus.approve()");
  });
});

describe("★换代损失口径：bulk 投出的量必须计入（2026-11-20 虚报 15~30%）", () => {
  // 现象：gen=10~24/27~31 每代都报 lossMs 5.3~6.1s（14~30%），而 gen=25/26 报 ≈0。
  // 根因：genLoss.frames 只在 deliverBridgeWindow 里累加，bulkBackfillBridge 投出的
  //   6s 没计 ⇒ lossUs = elapsed - actual 把整个 bulk 量算成丢失。数字与 bulk 的 6s 吻合。
  // 用户听感无损失，与此一致：这是统计口径错，不是播放缺陷。
  it("bulk 投完必须把 totalUs 折算成帧写回 genLoss，且发生在 bridge-bulk 日志之前", () => {
    const s = read(SEND, "server.ts");
    const iFrames = s.indexOf(
      "g.frames += Math.round(Number(totalUs) / BRIDGE_GEN_LOSS_FRAME_US);",
    );
    expect(iFrames).toBeGreaterThan(0);
    const iBulkLog = s.indexOf("bridge-bulk group=");
    expect(iBulkLog).toBeGreaterThan(iFrames);
    // 取出的必须是该设备的统计槽，不能凭空新建（否则窗口永不结束、永不落日志）
    expect(s.slice(iFrames - 120, iFrames)).toContain("const g = this.genLoss.get(deviceId);");
  });
});
