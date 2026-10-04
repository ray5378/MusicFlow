// 开环检测「设备已不再消费」回归守卫(2026-10)。
//
// 事故(v4.0.85 生产):Sendspin 群组里唯一在线成员 esp32-player2 播放**中途突然完全
// 无声且不恢复**——设备侧仍在正常收包解码(`Stream Started` / `Processed new codec
// header` 照打),但下游管线(speaker_mixer → i2s)从未起来,导致服务端照 1× 实时猛推、
// `Failed to send audio chunk` 以 ≈11~12 条/秒刷屏且**永不恢复**。服务端此前完全开环:
// 发送出口只查 `ws.readyState`,对「设备到底有没有在消费」零记账 —— 进度条照走、
// 音量可调、界面一切正常。
//
// 设备侧根因(240 定位):sendspin-cpp `pending_start_` 只在 play_uri 内清零,首轮
// 被拒后**永久锁死**,之后每首 `stream/start` 都被 `if(!pending_start_)` 吞掉 ⇒ 设备
// 再也回不到 IDLE;软手段救不回来,只剩 `stream/end`(协议里唯一能回 IDLE 的消息)
// 与硬重启两条。
//
// 本文件钉住:
//   ① 三窗计数(连续 3 窗峰值 > 32KB 才判 stalled);
//   ② 中途回落到 < 16KB ⇒ 清窗重计(设备还在消费,绝不误报);
//   ③ 三个豁免:建连宽限 10s、起播预填充窗口(pump.prefillSettled)、60s 硬回退;
//   ④ 分级自愈 L0(仅 WARN)→ L1(stream/end 探针)→ L2(远程重启)+ 5s 冷却;
//   ⑤ 「组内仍在 playing 且只有这一位卡住」才允许升到 L1 以上;
//   ⑥ esphomeBridge.restartDevice 拿不到 button 实体 ⇒ 返回 false 不抛;
//   ⑦ 组级 health 聚合;
//   ⑧ 全程不改播放状态(不 pause / 不报 stopped / 不踢出群组)。
import { describe, it, expect, beforeEach, vi } from "vitest";
import { SendspinConnection, SendspinGroup } from "./server.js";
import { esphomeBridge } from "./esphomeBridge.js";
import { peekPump, pumpFor } from "./streamEngine.js";

/** 采样与判定的阈值(与 server.ts 常量一致,故意不 import 私有常量)。 */
const THRESHOLD = 32_000;
const RECOVER = 16_000;
const WINDOWS = 3;
const CONNECT_GRACE_MS = 10_000;
const PREFILL_MAX_MS = 60_000;

type Conn = SendspinConnection & { sampleSinkHealth(): void };

/** 造一个只跑纯逻辑的连接:ws 用桩(构造函数只挂事件,不做任何判断)。 */
function makeConn(group: SendspinGroup): Conn {
  const ws: any = {
    bufferedAmount: 0,
    readyState: 1, // WebSocket.OPEN
    on: () => ws,
    once: () => ws,
    off: () => ws,
    removeListener: () => ws,
    terminate() {},
    ping() {},
    send() {},
  };
  const c: any = new SendspinConnection({ log() {} } as any, ws, "192.0.2.10");
  c.group = group;
  c.clientId = "client-A";
  // connectedAt 是构造时打的;这里显式回拨到「建连已过宽限、也过了 60s 预填充硬回退」
  // ⇒ 每次采样都直接 arm,后面的用例只测计数与自愈本身(豁免单独测)。
  c.connectedAt = Date.now() - PREFILL_MAX_MS - 5_000;
  return c as Conn;
}

/** 连打 N 窗超阈值(每窗=一次采样,同真实心跳轮)。 */
function pumpWindows(c: Conn, n: number, bytes: number): void {
  for (let i = 0; i < n; i++) {
    (c as any).ws.bufferedAmount = bytes;
    c.sampleSinkHealth();
  }
}

describe("sendspin sink 开环检测(设备不再消费)", () => {
  let group: SendspinGroup;

  beforeEach(() => {
    esphomeBridge.stop();
    group = new SendspinGroup("g", { log() {} } as any);
    group.current = { songId: "s1", durationMs: 100_000 }; // 组内「仍在 playing」
  });

  it("① 连续 3 窗超阈值才判 stalled,不足 3 窗不判", () => {
    const c = makeConn(group);
    pumpWindows(c, WINDOWS - 1, THRESHOLD + 1000);
    expect(c.sinkHealth).toBe("ok");
    pumpWindows(c, 1, THRESHOLD + 1000);
    expect(c.sinkHealth).toBe("stalled");
    expect((c as any).sinkStallWindows).toBe(WINDOWS);
  });

  it("② 中途回落到 < 16KB ⇒ 清窗重计(设备还在消费,不误报)", () => {
    const c = makeConn(group);
    pumpWindows(c, WINDOWS + 2, THRESHOLD + 1000);
    expect(c.sinkHealth).toBe("stalled");
    pumpWindows(c, 1, RECOVER - 1); // 排空一窗
    expect(c.sinkHealth).toBe("ok");
    expect((c as any).sinkStallWindows).toBe(0);
    expect(c.sinkStalledSinceMs).toBe(0);
    pumpWindows(c, WINDOWS - 1, THRESHOLD + 1000); // 只来 2 窗又不能判
    expect(c.sinkHealth).toBe("ok");
    pumpWindows(c, 1, THRESHOLD + 1000);
    expect(c.sinkHealth).toBe("stalled");
  });

  it("③a 建连宽限内(10s)一律不判", () => {
    const c = makeConn(group);
    c.connectedAt = Date.now(); // 就「刚刚建连」
    pumpWindows(c, WINDOWS + 2, THRESHOLD + 1000);
    expect(c.sinkHealth).toBe("ok");
    expect((c as any).sinkWatchArmed).toBe(false);
  });

  it("③b 起播预填充窗口内(pump 未 settle)不判;pump settle 后立刻 arm", () => {
    const c = makeConn(group);
    c.connectedAt = Date.now() - 30_000; // 已过建连宽限,但还没到 60s 硬回退
    // 真起一个泵(默认 prefillSettled=false),再显式钉住,免得被别的用例带到 true。
    const p: any = pumpFor({ log() {} } as any, group);
    p.prefillSettled = false;
    pumpWindows(c, WINDOWS + 2, THRESHOLD + 1000);
    expect(c.sinkHealth).toBe("ok");
    expect((c as any).sinkWatchArmed).toBe(false); // 还在豁免期
    p.prefillSettled = true;
    pumpWindows(c, WINDOWS, THRESHOLD + 1000);
    expect(c.sinkHealth).toBe("stalled");
  });

  it("③c 设备不消费时 wantFill 恒 true ⇒ 60s 硬回退必须让检测 arm 上(核心回归)", () => {
    const c = makeConn(group);
    const p: any = pumpFor({ log() {} } as any, group);
    p.prefillSettled = false; // 设备根本不取数,pump 永远停在 fill
    // 只靠「建连已过 60s」这一条 arm 路径,不靠 pump settle(采样是瞬时的,
    // 得把 connectedAt 拨到 60s 之外,否则 3 窗打完 elapsed 还没到回退点)。
    c.connectedAt = Date.now() - PREFILL_MAX_MS - 500;
    pumpWindows(c, WINDOWS + 1, THRESHOLD + 1000);
    expect((c as any).sinkWatchArmed).toBe(true);
    expect(c.sinkHealth).toBe("stalled");
  });

  it("②③ 中间带(16KB~32KB)既不累加也不清窗", () => {
    const c = makeConn(group);
    pumpWindows(c, 2, Math.round((THRESHOLD + RECOVER) / 2));
    expect(c.sinkHealth).toBe("ok");
    pumpWindows(c, 1, THRESHOLD + 1);
    expect((c as any).sinkStallWindows).toBe(1);
    expect(c.sinkHealth).toBe("ok");
  });

  it("④ L0 只告警:判 stalled 那一轮不发任何下行、不改播放状态", () => {
    const c = makeConn(group);
    group.members.add(c); // 进组,L0→L1 的闸门才可能被打开
    const sent: string[] = [];
    c.sendJson = ((t: string) => {
      sent.push(t);
      return;
    }) as any;
    pumpWindows(c, WINDOWS + 1, THRESHOLD + 1000);
    expect(c.sinkHealth).toBe("stalled");
    expect(c.sinkRecoveryLevel).toBe(1); // L0 已执行
    expect(sent).toEqual([]); // L0 不动流
    // 已判过就不再重复触发(每 10s 一窗,不会每窗都 escalation)
    pumpWindows(c, 5, THRESHOLD + 1000);
    expect(c.sinkRecoveryLevel).toBe(1);
    expect(sent).toEqual([]);
    expect(group.paused).toBe(false);
    expect(group.current).not.toBeNull();
  });

  it("④ 冷却期内不升级;过冷却才发 L1 stream/end 探针", () => {
    const c = makeConn(group);
    group.members.add(c);
    const sent: string[] = [];
    c.sendJson = ((t: string) => {
      sent.push(t);
      return;
    }) as any;
    c.sinkHealth = "stalled";
    c.sinkRecoveryLevel = 1;
    c.sinkLastRecoveryAt = Date.now();
    group.escalateSinkRecovery(c); // 冷却中 ⇒ 直接 return
    expect(c.sinkRecoveryLevel).toBe(1);
    expect(sent).toEqual([]);
    c.sinkLastRecoveryAt = Date.now() - 60_000;
    group.escalateSinkRecovery(c); // 过冷却 ⇒ L1 探针
    expect(c.sinkRecoveryLevel).toBe(2);
    expect(sent).toContain("stream/end");
    // ⚠️ 探针只发流级收尾,**不发 group/update(stopped)** —— 否则真机会把 stopped
    //    镜像成组播放器 IDLE,把「无声」伪装成「正常停止」(见 finishPlayback 注释)。
    expect(sent.filter((t) => t === "group/update")).toEqual([]);
  });

  it("④ 升级到 L2:有 6053 host 且桥上能按下按钮 ⇒ ok", () => {
    const c = makeConn(group);
    group.members.add(c);
    const spy = vi.spyOn(group as any, "restartStalledMember").mockResolvedValue(undefined);
    c.sinkHealth = "stalled";
    c.sinkRecoveryLevel = 2; // 已经历过 L0/L1,下一级就是 L2 远程重启
    c.sinkLastRecoveryAt = 0;
    group.escalateSinkRecovery(c);
    expect(c.sinkRecoveryLevel).toBe(3);
    expect(spy).toHaveBeenCalledTimes(1);
    spy.mockRestore();
  });

  it("⑤ 组内多位卡死 ⇒ 闸在 L0,不折腾设备", () => {
    const c1 = makeConn(group);
    const c2 = makeConn(group);
    group.members.add(c1);
    group.members.add(c2);
    c1.sinkHealth = "stalled";
    c2.sinkHealth = "stalled";
    const sent: string[] = [];
    c1.sendJson = ((t: string) => {
      sent.push(t);
      return;
    }) as any;
    c1.sinkRecoveryLevel = 1;
    c1.sinkLastRecoveryAt = 0;
    group.escalateSinkRecovery(c1);
    expect(c1.sinkRecoveryLevel).toBe(1); // 被闸住
    expect(sent).toEqual([]);
  });

  it("⑤ 组内只有一位卡住 + 仍在 playing ⇒ 允许升到 L2", () => {
    const c1 = makeConn(group);
    const c2 = makeConn(group);
    group.members.add(c1);
    group.members.add(c2);
    c1.sinkHealth = "stalled";
    c2.sinkHealth = "ok";
    c1.sinkRecoveryLevel = 2; // 闸门开 ⇒ 从 L2 继续往 L3 走
    c1.sinkLastRecoveryAt = 0;
    group.escalateSinkRecovery(c1);
    expect(c1.sinkRecoveryLevel).toBe(3);
  });

  it("⑤ 组已 pause / 无 current ⇒ 只 L0,不动设备", () => {
    const c = makeConn(group);
    group.members.add(c);
    c.sinkHealth = "stalled";
    group.current = null;
    c.sinkRecoveryLevel = 1;
    c.sinkLastRecoveryAt = 0;
    group.escalateSinkRecovery(c);
    expect(c.sinkRecoveryLevel).toBe(1);
    group.current = { songId: "s1", durationMs: 100_000 };
    group.paused = true;
    c.sinkLastRecoveryAt = 0;
    group.escalateSinkRecovery(c);
    expect(c.sinkRecoveryLevel).toBe(1);
  });

  it("⑥ restartDevice:拿不到 button 实体 ⇒ 返回 false 不抛(no-entity / no-bridge)", () => {
    const r = esphomeBridge.restartDevice("192.0.2.77"); // 桥里没有这台
    expect(r.ok).toBe(false);
    expect(r.code).toBe("no-bridge");
    const r2 = esphomeBridge.restartDevice(""); // 空 host 不允许走到查表
    expect(r2.ok).toBe(false);
    expect(r2.code).toBe("no-bridge");
  });

  it("⑦ 组 health 聚合:任一 stalled ⇒ stalled;有堆积但未 stalled ⇒ degraded", () => {
    const c1 = makeConn(group);
    const c2 = makeConn(group);
    group.members.add(c1);
    group.members.add(c2);
    expect(group.health()).toBe("ok");
    c2.lastBufferedAmount = RECOVER + 1000; // ok 但堆积偏高
    expect(group.health()).toBe("degraded");
    c1.sinkHealth = "stalled";
    expect(group.health()).toBe("stalled");
  });

  it("⑧ 全程不 pause、不报 stopped、不踢出群组", () => {
    const c = makeConn(group);
    group.members.add(c);
    pumpWindows(c, WINDOWS + 1, THRESHOLD + 1000);
    expect(group.paused).toBe(false);
    expect(group.current).not.toBeNull();
    expect(group.members.has(c)).toBe(true);
    expect(c.sinkHealth).toBe("stalled");
  });
});
