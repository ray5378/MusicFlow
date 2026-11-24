// [验收7/N2 2026-11-25] 设备判 late 全丢的自愈守卫回归钉。
// 形态来源:240 真机 14:45:33 iEAST —— warm 会话重锚时指令落点没越过设备残留队列
// ⇒ splice 型固件忽略换锚 ⇒ 设备把到达帧全判 late 丢弃 ⇒ inQueueMs 恒 0、父侧照常投
// ⇒ late 线性无限涨且无机制收敛。
// [组A-分级 2026-11-25] 三级语义(MA _absorb_playout_shift/_restart_transport/
// _recover_transport 同源;本仓差异=late 增量估计+补充层):
//   一级 retime:shift ≤ 10s 门 ⇒ selfhealBus.request(level=1) 桥侧平移映射(无 BOUNDARY);
//   二级 lightRestart:retime 未奏效/shift 超门 ⇒ BOUNDARY{seek}+游标复位+清管线请求;
//   三级 exhausted:二级后仍 starving ⇒ error 留痕,停止分级动作交上层。
// 钉死:
//   ① 「积压 0 + 父侧仍在投 + 内容充足」连续 BRIDGE_LATE_SELFHEAL_TICKS 拍 ⇒
//      一级 retime 请求(selfhealBus level=1,无 BOUNDARY);
//   ② [N2/验收14 判定纪律,MA _transport_lost :1448-1472] 干净收尾(组无在播内容)
//      绝不触发 —— 自然曲末/手动停止的积压归 0 是正常形态;
//   ③ 冷却:一次自愈后 BRIDGE_TRANSPORT_RECOVERY_GUARD_MS 内不再次触发(防 churn);
//   ④ shift 超 10s 门 ⇒ 跳过一级直达二级(BOUNDARY{seek}+游标复位);
//   ⑤ retime 未奏效(绕过冷却再触发)⇒ 升级二级;
//   ⑥ 三级:二级后仍 starving ⇒ exhausted 留痕不再动作。
import { describe, it, expect, afterEach, beforeAll, vi } from "vitest";
vi.hoisted(() => {
  process.env.MF_PLAYER_ISOLATION = "1";
  process.env.MF_PLAYER_BROADCAST = "1";
});
import "../plugins/_env.js";
import { initDatabase } from "../../src/db/index.js";
import { SendspinGroup } from "../../src/services/sendspin/server.js";
import { selfhealBus } from "../../src/services/sendspin/selfhealBus.js";
import {
  BRIDGE_LATE_SELFHEAL_TICKS,
  BRIDGE_TRANSPORT_RECOVERY_GUARD_MS,
} from "../../src/services/sendspin/constants.js";

function selfhealStub(deviceId: string) {
  const pushed: { data: Uint8Array; ts: bigint }[] = [];
  const boundaries: string[] = [];
  return {
    deviceId,
    pushed,
    boundaries,
    pushAudio(data: Uint8Array, ts: bigint) {
      pushed.push({ data: Uint8Array.from(data), ts });
    },
    sendBoundary(reason: string) {
      boundaries.push(reason);
    },
  };
}

const liveGroups: SendspinGroup[] = [];

function groupWith(stub: ReturnType<typeof selfhealStub>, opts: { playing: boolean }) {
  const logs: string[] = [];
  const g = new SendspinGroup("g-late-selfheal", {
    log: (level: string, msg: string) => logs.push(level + "|" + msg),
    // [组A] 守卫读 server.bridgeLateTotal(可选链防御已就位,但显式给真 Map 才能测
    // shift 估计):key=设备 id,value=累计 late 帧。
    bridgeLateTotal: new Map<string, number>(),
  } as any);
  (g as any).logs = logs;
  g.bridges.set(stub.deviceId, stub as any);
  (g as any).bridgeBacklogMs = new Map([[stub.deviceId, 0]]);
  // N2 判据:组当前是否有在播内容(clean end ⇒ null ⇒ 守卫恒不触发)
  (g as any).current = opts.playing ? { songId: "s-1", title: "t" } : null;
  liveGroups.push(g);
  return g;
}

function addRingFrame(g: SendspinGroup, tsUs: bigint): void {
  const key = (g as any).encoderKey("pcm", 100);
  const ring = (g as any).ringFor(key);
  ring.push({ tsUs, durUs: 25_000, data: new Uint8Array(2400), ep: (g as any).bridgeContentEpoch });
}

function seedEpoch(g: SendspinGroup): void {
  const key = (g as any).encoderKey("pcm", 100);
  (g as any).bcEpoch.set(key, (g as any).bridgeContentEpoch);
}

beforeAll(() => {
  if (!process.env.APP_VERSION) process.env.APP_VERSION = "1.0.0";
  initDatabase();
});

afterEach(() => {
  for (const g of liveGroups.splice(0)) g.stopBridgePushTimer();
});

describe("bridgeBroadcastTick · 设备判 late 全丢的自愈守卫(验收7/N2)", () => {
  it("① 在播 + 积压恒 0 + 持续投递 ⇒ 达到阈值发一级 retime 请求(level=1,无 BOUNDARY)", () => {
    const stub = selfhealStub("ap-1");
    const g = groupWith(stub, { playing: true });
    seedEpoch(g);
    let now = 5_000_000_000n;
    // 预热一拍让游标落在环内(第一拍 deliveredUs>0 的前提)
    addRingFrame(g, now + 500_000n);
    (g as any).bridgeBroadcastTick(now);
    for (let i = 0; i < BRIDGE_LATE_SELFHEAL_TICKS + 1; i++) {
      now += 250_000n;
      addRingFrame(g, now + 500_000n); // 每拍新内容在前沿,保证 deliveredUs>0
      (g as any).bridgeBroadcastTick(now);
    }
    const retime = (g as any).logs.filter((l: string) => l.includes("bridge-late-selfheal-retime"));
    expect(retime.length).toBeGreaterThanOrEqual(1);
    // 一级 = 桥侧映射平移请求,不带 BOUNDARY(轻动作,SYNC 一段即生效)
    expect(stub.boundaries).not.toContain("seek");
    // selfhealBus 收到 level=1 动作(shiftUs=0 = 桥自估;late 无基线数据时估计为 0)
    const drained = selfhealBus.drain();
    expect(drained.some((a) => a.deviceId === "ap-1" && a.level === 1)).toBe(true);
  });

  it("② [N2/验收14] 干净收尾(组无在播内容)⇒ 积压 0 不触发自愈", () => {
    const stub = selfhealStub("ap-2");
    const g = groupWith(stub, { playing: false });
    seedEpoch(g);
    let now = 5_000_000_000n;
    addRingFrame(g, now + 500_000n);
    (g as any).bridgeBroadcastTick(now);
    for (let i = 0; i < BRIDGE_LATE_SELFHEAL_TICKS * 2; i++) {
      now += 250_000n;
      addRingFrame(g, now + 500_000n);
      (g as any).bridgeBroadcastTick(now);
    }
    expect((g as any).logs.some((l: string) => l.includes("bridge-late-selfheal"))).toBe(false);
    expect(stub.boundaries).not.toContain("seek");
  });

  it("③ 一次一级动作后处于冷却窗口 ⇒ 不立即再次触发(防 churn)", () => {
    const stub = selfhealStub("ap-3");
    const g = groupWith(stub, { playing: true });
    seedEpoch(g);
    let now = 5_000_000_000n;
    addRingFrame(g, now + 500_000n);
    (g as any).bridgeBroadcastTick(now);
    for (let i = 0; i < BRIDGE_LATE_SELFHEAL_TICKS; i++) {
      now += 250_000n;
      addRingFrame(g, now + 500_000n);
      (g as any).bridgeBroadcastTick(now);
    }
    selfhealBus.drain(); // 清空首次触发的动作
    const retime1 = (g as any).logs.filter((l: string) => l.includes("bridge-late-selfheal-retime")).length;
    expect(retime1).toBe(1);
    // 冷却期内继续 starving ⇒ 不得再次触发(无新 retime、无 BOUNDARY、无升级)
    for (let i = 0; i < BRIDGE_LATE_SELFHEAL_TICKS; i++) {
      now += 250_000n;
      addRingFrame(g, now + 500_000n);
      (g as any).bridgeBroadcastTick(now);
    }
    expect(selfhealBus.drain().length).toBe(0);
    expect(stub.boundaries.filter((r) => r === "seek").length).toBe(0);
    expect((g as any).logs.filter((l: string) => l.includes("bridge-late-selfheal-retime")).length).toBe(1);
    expect(BRIDGE_TRANSPORT_RECOVERY_GUARD_MS).toBe(30_000);
  });

  it("④ [组A] armed 基线早于触发 + late 增量超 10s 门 ⇒ 首触发直接二级(跳过 retime)", () => {
    const stub = selfhealStub("ap-4");
    const g = groupWith(stub, { playing: true });
    seedEpoch(g);
    // 给 server 喂一个真实 bridgeLateTotal Map(守卫按增量估 shift)
    const lateMap = new Map<string, number>([["ap-4", 0]]);
    (g as any).server.bridgeLateTotal = lateMap;
    // 预置「冷却中」:armed 基线先记、触发被冷却挡 → 基线与触发分离,delta 才 >0
    ((g as any).bridgeSelfhealAtMs as Map<string, number>).set("ap-4", Date.now());
    let now = 5_000_000_000n;
    addRingFrame(g, now + 500_000n);
    (g as any).bridgeBroadcastTick(now);
    for (let i = 0; i < BRIDGE_LATE_SELFHEAL_TICKS + 4; i++) {
      now += 250_000n;
      addRingFrame(g, now + 500_000n);
      // armed 期间 late 缓涨(+31/拍;armed 基线在第 40 拍记 ≈1240 帧)
      lateMap.set("ap-4", (lateMap.get("ap-4") ?? 0) + 31);
      (g as any).bridgeBroadcastTick(now);
    }
    expect((g as any).logs.some((l: string) => l.includes("bridge-late-selfheal-armed"))).toBe(true);
    // 冷却中只 armed 不触发(无 retime/light-restart/exhausted 动作行)
    expect((g as any).logs.some((l: string) =>
      l.includes("bridge-late-selfheal-retime")
      || l.includes("bridge-late-selfheal-light-restart")
      || l.includes("bridge-late-selfheal-exhausted"),
    )).toBe(false);
    // 冷却窗过后 late 已暴涨 +1500 帧(×7.98ms ≈ 11.97s > 10s 门)
    // ⇒ 触发拍 lateDelta 超门,level=0 直接二级(跳过 retime)。
    lateMap.set("ap-4", (lateMap.get("ap-4") ?? 0) + 1500);
    ((g as any).bridgeSelfhealAtMs as Map<string, number>).set("ap-4", Date.now() - 31_000);
    now += 250_000n;
    addRingFrame(g, now + 500_000n);
    (g as any).bridgeBroadcastTick(now);
    const lightRestart = (g as any).logs.filter((l: string) => l.includes("bridge-late-selfheal-light-restart"));
    expect(lightRestart.length).toBeGreaterThanOrEqual(1);
    expect(lightRestart[0]).toContain("跳过 retime");
    expect(stub.boundaries).toContain("seek"); // 二级保留受限重锚动作
    const drained = selfhealBus.drain();
    expect(drained.some((a) => a.deviceId === "ap-4" && a.level === 2)).toBe(true);
    expect(drained.some((a) => a.deviceId === "ap-4" && a.level === 1)).toBe(false); // 跳过一级
    // 游标复位:重锚拍之后 bcCursor = 该拍 now
    expect((g as any).bcCursor.get("ap-4")).toBe(now);
  });

  it("⑤ [组A] retime 未奏效(绕过冷却再 starving)⇒ 升级二级 lightRestart", () => {
    const stub = selfhealStub("ap-5");
    const g = groupWith(stub, { playing: true });
    seedEpoch(g);
    let now = 5_000_000_000n;
    addRingFrame(g, now + 500_000n);
    (g as any).bridgeBroadcastTick(now);
    for (let i = 0; i < BRIDGE_LATE_SELFHEAL_TICKS + 1; i++) {
      now += 250_000n;
      addRingFrame(g, now + 500_000n);
      (g as any).bridgeBroadcastTick(now);
    }
    expect((g as any).logs.some((l: string) => l.includes("bridge-late-selfheal-retime"))).toBe(true);
    selfhealBus.drain();
    // 绕过冷却(真实场景 = retime 生效延迟 > 冷却窗,设备仍全判 late):回拨动作时刻
    ((g as any).bridgeSelfhealAtMs as Map<string, number>).set("ap-5", Date.now() - 31_000);
    for (let i = 0; i < BRIDGE_LATE_SELFHEAL_TICKS + 1; i++) {
      now += 250_000n;
      addRingFrame(g, now + 500_000n);
      (g as any).bridgeBroadcastTick(now);
    }
    expect((g as any).logs.some((l: string) => l.includes("bridge-late-selfheal-light-restart"))).toBe(true);
    expect((g as any).logs.some((l: string) => l.includes("retime 未奏效"))).toBe(true);
    expect(stub.boundaries).toContain("seek");
    expect(selfhealBus.drain().some((a) => a.deviceId === "ap-5" && a.level === 2)).toBe(true);
  });

  it("⑥ [组A] 二级后仍 starving ⇒ 三级 exhausted 留痕,不再发出动作", () => {
    const stub = selfhealStub("ap-6");
    const g = groupWith(stub, { playing: true });
    seedEpoch(g);
    // 直接到二级档位(模拟一级已发过)
    ((g as any).bridgeSelfhealLevel as Map<string, number>).set("ap-6", 1);
    ((g as any).bridgeSelfhealAtMs as Map<string, number>).set("ap-6", Date.now() - 31_000);
    let now = 5_000_000_000n;
    addRingFrame(g, now + 500_000n);
    (g as any).bridgeBroadcastTick(now);
    for (let i = 0; i < BRIDGE_LATE_SELFHEAL_TICKS + 1; i++) {
      now += 250_000n;
      addRingFrame(g, now + 500_000n);
      (g as any).bridgeBroadcastTick(now);
    }
    expect((g as any).logs.some((l: string) => l.includes("bridge-late-selfheal-light-restart"))).toBe(true);
    selfhealBus.drain();
    // 再来一轮(三级):exhausted 留痕,不再发动作、不再 BOUNDARY
    ((g as any).bridgeSelfhealAtMs as Map<string, number>).set("ap-6", Date.now() - 31_000);
    const seekBefore = stub.boundaries.filter((r) => r === "seek").length;
    for (let i = 0; i < BRIDGE_LATE_SELFHEAL_TICKS + 1; i++) {
      now += 250_000n;
      addRingFrame(g, now + 500_000n);
      (g as any).bridgeBroadcastTick(now);
    }
    expect((g as any).logs.some((l: string) => l.includes("bridge-late-selfheal-exhausted"))).toBe(true);
    expect(selfhealBus.drain().length).toBe(0);
    expect(stub.boundaries.filter((r) => r === "seek").length).toBe(seekBefore);
    // 恢复健康(非 starving)+ 超冷却 ⇒ 档位复位。⚠️ 守卫读的是 server 层的
    // bridgeBacklogMs(1609 行),不是 Group 字段 —— 恢复要抬 server 侧水位。
    ((g as any).bridgeSelfhealAtMs as Map<string, number>).set("ap-6", Date.now() - 31_000);
    ((g as any).server as { bridgeBacklogMs?: Map<string, number> }).bridgeBacklogMs = new Map([["ap-6", 2600]]);
    now += 250_000n;
    addRingFrame(g, now + 500_000n);
    (g as any).bridgeBroadcastTick(now);
    expect(((g as any).bridgeSelfhealLevel as Map<string, number>).has("ap-6")).toBe(false);
  });
});
