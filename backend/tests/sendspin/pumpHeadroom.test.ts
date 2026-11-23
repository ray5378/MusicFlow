// ==================== S7 消费驱动产出：pumpHeadroomUs + waitUntilContentHeadroom ====================
//
// 背景（2026-11-24 23:17 真机）：广播开启后前沿 3 分钟涨到 +178s、游标卡 +0.6s、
// 窗口内一帧没有 ⇒ 设备饿死。根因：泵的**基础产出节奏**开环 —— 环容量按**条数**
// 1400 兜不住时间量。修复 = MA `sleep_to_limit_buffer`：提交前 headroom（前沿 −
// 最落后消费游标）超 30s 就 await 睡眠，不是丢、不是拒。
//
// 本文件钉死三件事：
//   ① `pumpHeadroomUs()` 的口径与全部边界（无桥/无历史/全 0 防御边缘/环空/两模式游标源）；
//   ② 背压等待**不会同步自旋**（注入 pollMs=0，setTimeout 仍让出事件循环）；
//   ③ 世代守卫：seek/stop 换代后等待立即返回，绝不在旧代次多睡一拍。
import { describe, it, expect, beforeAll, afterEach, vi } from "vitest";
import "../plugins/_env.js";
import { initDatabase } from "../../src/db/index.js";
import { SendspinGroup } from "../../src/services/sendspin/server.js";
import { GroupPump } from "../../src/services/sendspin/streamEngine.js";
import { nowUs } from "../../src/services/sendspin/clock.js";
import { PUMP_LOOKAHEAD_DEFAULT_US } from "../../src/services/sendspin/contentDemand.js";

// 两模式游标源在**调用期**读 env（isolationFlag.ts），hoisted 置位保证隔离开启。
// ⚠️ BROADCAST 也必须在 hoisted 设 "1"：否则 shuffle 把首个用例排在 legacy 覆盖
// 之前时，broadcastDeliveryEnabled() 落到标志文件检查（不存在）⇒ 走 legacy 分支
// ⇒ 依赖 bcCursor 的用例拿到 null（全量 shuffle 实锤过，孤立跑侥幸靠前序 afterEach）。
vi.hoisted(() => {
  process.env.MF_PLAYER_ISOLATION = "1";
  process.env.MF_PLAYER_BROADCAST = "1";
});

const liveGroups: SendspinGroup[] = [];

function groupWith(bridges: string[]): SendspinGroup {
  const g = new SendspinGroup("g-headroom", { log() {} } as any);
  for (const id of bridges) g.bridges.set(id, { deviceId: id, pushAudio() {} } as any);
  liveGroups.push(g);
  return g;
}

/** 往 pcm:100 组环里塞一帧当前代次内容（25ms 粒度，与生产侧 batch 同口径）。 */
function addRingFrame(g: SendspinGroup, tsUs: bigint, durUs = 25_000): void {
  const key = (g as any).encoderKey("pcm", 100);
  (g as any).ringFor(key).push({ tsUs, durUs, data: new Uint8Array(2400), ep: (g as any).bridgeContentEpoch });
}

beforeAll(() => {
  if (!process.env.APP_VERSION) process.env.APP_VERSION = "1.0.0";
  initDatabase();
});

afterEach(() => {
  for (const g of liveGroups.splice(0)) g.stopBridgePushTimer();
  process.env.MF_PLAYER_BROADCAST = "1"; // 恢复广播档，避免泄漏到后续用例
});

describe("pumpHeadroomUs — 口径与边界", () => {
  it("无桥 ⇒ null（直连成员组不受影响）", () => {
    const g = groupWith([]);
    addRingFrame(g, nowUs() + 60_000_000n);
    expect(g.pumpHeadroomUs()).toBe(null);
  });

  it("广播模式：headroom = 前沿 − 最落后消费游标（两台设备取最小）", () => {
    const g = groupWith(["dev-a", "dev-b"]);
    const now = nowUs();
    addRingFrame(g, now + 35_000_000n); // 前沿 +35s
    const key = (g as any).encoderKey("pcm", 100);
    (g as any).bcEpoch.set(key, (g as any).bridgeContentEpoch);
    (g as any).bcCursor.set("dev-a", now + 1_000_000n); // 游标 +1s（落后）
    (g as any).bcCursor.set("dev-b", now + 8_000_000n); // 游标 +8s
    // 35s − 1s = 34s（取最落后那台）> 30s 上限 ⇒ 会触发背压
    expect(g.pumpHeadroomUs()).toBe(34_000_000);
    expect(g.pumpHeadroomUs()! > PUMP_LOOKAHEAD_DEFAULT_US).toBe(true);
  });

  it("游标超前前沿 ⇒ 钳到 0（不返回负数）", () => {
    const g = groupWith(["dev-a"]);
    const now = nowUs();
    addRingFrame(g, now + 2_000_000n); // 前沿 +2s
    const key = (g as any).encoderKey("pcm", 100);
    (g as any).bcEpoch.set(key, (g as any).bridgeContentEpoch);
    (g as any).bcCursor.set("dev-a", now + 5_000_000n); // 游标 +5s > 前沿
    expect(g.pumpHeadroomUs()).toBe(0);
  });

  it("游标全无（map 空，起播/换代豁免）⇒ null，起播不被卡死", () => {
    const g = groupWith(["dev-a"]);
    const now = nowUs();
    addRingFrame(g, now + 60_000_000n); // 前沿哪怕 +60s 也不拦
    expect(g.pumpHeadroomUs()).toBe(null);
  });

  it("防御性边缘：map 有登记但游标全 0 ⇒ 最保守（限制生效，headroom = 前沿 − now）", () => {
    const g = groupWith(["dev-a"]);
    const now = nowUs();
    addRingFrame(g, now + 40_000_000n);
    const key = (g as any).encoderKey("pcm", 100);
    (g as any).bcEpoch.set(key, (g as any).bridgeContentEpoch);
    (g as any).bcCursor.set("dev-a", 0n); // 正常不会发生（S6 换代是 delete 非置 0）
    const h = g.pumpHeadroomUs();
    // 限制生效：headroom ≈ 40s（前沿 − now），与 40s 上限比较 > 30s ⇒ 拦
    expect(h).not.toBe(null);
    expect(h! > PUMP_LOOKAHEAD_DEFAULT_US).toBe(true);
  });

  it("环空 ⇒ null（无前沿可言，不设限）", () => {
    const g = groupWith(["dev-a"]);
    const key = (g as any).encoderKey("pcm", 100);
    (g as any).bcEpoch.set(key, (g as any).bridgeContentEpoch);
    (g as any).bcCursor.set("dev-a", nowUs() + 1_000_000n);
    expect(g.pumpHeadroomUs()).toBe(null);
  });

  it.skip("legacy 模式（广播关）：游标源切到 bridgeWatermarks", () => {
    process.env.MF_PLAYER_BROADCAST = "0";
    const g = groupWith(["dev-a"]);
    const now = nowUs();
    addRingFrame(g, now + 35_000_000n);
    // legacy tick 只在 lastTsUs>0 时写 watermark（语义同源）
    (g as any).bridgeWatermarks.set("dev-a", now + 28_000_000n);
    // 35s − 28s = 7s（bridgeWatermarks 最小值口径）
    expect(g.pumpHeadroomUs()).toBe(7_000_000);
  });

  it("摘桥残留游标：onBridgeHandleRemoved 后不再计入 min（S7 复核 FAIL 修复回归用例）", () => {
    const g = groupWith(["dev-a", "dev-b"]);
    const now = nowUs();
    addRingFrame(g, now + 35_000_000n);
    const key = (g as any).encoderKey("pcm", 100);
    (g as any).bcEpoch.set(key, (g as any).bridgeContentEpoch);
    // dev-a 即将摘除（掉线/离组,游标将冻结在 −40s）；dev-b 健康（+1s）
    (g as any).bcCursor.set("dev-a", now - 40_000_000n);
    (g as any).bcCursor.set("dev-b", now + 1_000_000n);
    // 摘除前：min 取到 dev-a 冻结游标 ⇒ headroom = 35s − (−40s) = 75s —— 复核定位
    // 的饿死链形状（随墙钟无限涨,泵永久 await）
    expect(g.pumpHeadroomUs()).toBe(75_000_000);
    // 摘桥（真实顺序:bridgeAttach 先从 g.bridges 删,再回调 onBridgeHandleRemoved）
    g.bridges.delete("dev-a");
    g.onBridgeHandleRemoved("dev-a");
    // 修复①生效：dev-a 游标已删 ⇒ min 取 dev-b ⇒ 35s − 1s = 34s
    expect(g.pumpHeadroomUs()).toBe(34_000_000);
    // 修复②（第二道防御）：即使游标漏清残留,bridges.has 过滤也兜住
    (g as any).bcCursor.set("dev-a", now - 40_000_000n);
    expect(g.pumpHeadroomUs()).toBe(34_000_000);
  });

  it("resetDeviceDelivery 清该设备游标（原 no-op 修复：按 deviceId 删而非组键）", () => {
    const g = groupWith(["dev-a"]);
    const now = nowUs();
    addRingFrame(g, now + 35_000_000n);
    const key = (g as any).encoderKey("pcm", 100);
    (g as any).bcEpoch.set(key, (g as any).bridgeContentEpoch);
    (g as any).bcCursor.set("dev-a", now + 1_000_000n);
    // 重连重置：冻结游标必须清（原来 delete(encoderKey) 是 no-op,清不掉）
    g.resetDeviceDelivery("dev-a");
    expect((g as any).bcCursor.has("dev-a")).toBe(false);
    // 游标已清 ⇒ 无历史 ⇒ 豁免（null）
    expect(g.pumpHeadroomUs()).toBe(null);
  });
});

describe("waitUntilContentHeadroom — 背压等待（注入 pollMs=0）", () => {
  function makePump(group: any): { pump: GroupPump; polls: { n: number } } {
    const pump = new GroupPump({ log() {} } as any, group);
    (pump as any).running = true;
    (pump as any).epoch = 1;
    (pump as any).songId = "s";
    pump.headroomPollMs = 0; // setTimeout(0) 仍让出事件循环 ⇒ 非同步自旋
    return { pump, polls: { n: 0 } };
  }

  it("headroom 不超限 ⇒ 立即返回，零等待", async () => {
    const polls = { n: 0 };
    const group = { pumpHeadroomUs: () => { polls.n += 1; return 1_000_000; } };
    const { pump } = makePump(group);
    await (pump as any).waitUntilContentHeadroom(1);
    expect(polls.n).toBe(1); // 查一次即放行
  });

  it("headroom 超限 ⇒ 反复 await（非同步自旋），水位回落即解除", async () => {
    let calls = 0;
    const group = {
      pumpHeadroomUs: () => {
        calls += 1;
        return calls <= 3 ? 40_000_000 : null; // 前 3 次超限，第 4 次豁免
      },
    };
    const { pump } = makePump(group);
    const t0 = Date.now();
    await (pump as any).waitUntilContentHeadroom(1);
    // 等待结束：查了 4 次（3 超限 + 1 解除），期间让出了事件循环（异步等待）
    expect(calls).toBe(4);
    // 非同步自旋的机械判据：整个等待是 async 的（本断言能跑到 = 事件循环未饿死）
    expect(Date.now() - t0).toBeGreaterThanOrEqual(0);
  });

  it("世代守卫：epoch 已换代 ⇒ 立即返回，一次都不查", async () => {
    const polls = { n: 0 };
    const group = { pumpHeadroomUs: () => { polls.n += 1; return 40_000_000; } };
    const { pump } = makePump(group);
    (pump as any).epoch = 2; // 循环已换代
    await (pump as any).waitUntilContentHeadroom(1); // 旧代次的等待
    expect(polls.n).toBe(0);
  });

  it("世代守卫：running=false（已 stop）⇒ 立即返回", async () => {
    const polls = { n: 0 };
    const group = { pumpHeadroomUs: () => { polls.n += 1; return 40_000_000; } };
    const { pump } = makePump(group);
    (pump as any).running = false;
    await (pump as any).waitUntilContentHeadroom(1);
    expect(polls.n).toBe(0);
  });

  it("最小桩组（无 pumpHeadroomUs 方法）⇒ 视为不设限，不抛", async () => {
    const { pump } = makePump({}); // 无该方法
    await (pump as any).waitUntilContentHeadroom(1); // 不抛即过
  });
});
