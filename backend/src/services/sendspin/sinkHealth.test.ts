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
import {
  SendspinConnection,
  SendspinGroup,
  // 阈值/节奏一律从**实现** import:谁把它们改坏了,下面的守卫用例必须红。
  SINK_STALL_THRESHOLD_BYTES as THRESHOLD,
  SINK_STALL_RECOVER_BYTES as RECOVER,
  SINK_STALL_WINDOWS as WINDOWS,
  SINK_WATCH_CONNECT_GRACE_MS as CONNECT_GRACE_MS,
  SINK_WATCH_PREFILL_MAX_MS as PREFILL_MAX_MS,
  SINK_RECOVERY_STEP_MS as STEP_MS,
  SINK_RECOVERY_L2_MS as SINK_L2_MS,
  SINK_RESUME_COOLDOWN_MS as RESUME_COOLDOWN_MS,
} from "./server.js";
import { esphomeBridge } from "./esphomeBridge.js";
import { peekPump, pumpFor } from "./streamEngine.js";

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
    // 判出来后的第一档内(STEP_MS)什么都不该再做 —— 网络抖动常常自己排空,别瞎动。
    // 注意这里**不是**「判过就永久不再触发」:那条早退会把 L1/L2 变成死代码,
    // 真正的 repeat 靠「已 stall 多久」驱动(见 ④-反例)。
    pumpWindows(c, 5, THRESHOLD + 1000);
    expect(c.sinkRecoveryLevel).toBe(1);
    expect(sent).toEqual([]);
    expect(group.paused).toBe(false);
    expect(group.current).not.toBeNull();
  });

  it("④-反例(关键回归):判 stalled 后阶梯靠时间继续往上走,L1 探针必须发得出去", () => {
    vi.useFakeTimers();
    try {
      const c = makeConn(group);
      group.members.add(c);
      const sent: string[] = [];
      c.sendJson = ((t: string) => {
        sent.push(t);
        return;
      }) as any;
      pumpWindows(c, WINDOWS, THRESHOLD + 1000);
      expect(c.sinkHealth).toBe("stalled");
      expect(c.sinkRecoveryLevel).toBe(1); // L0

      vi.advanceTimersByTime(STEP_MS - 1);
      pumpWindows(c, 3, THRESHOLD + 1000);
      expect(c.sinkRecoveryLevel).toBe(1); // 还没到点,不动
      expect(sent).toEqual([]);

      vi.advanceTimersByTime(STEP_MS);
      pumpWindows(c, 1, THRESHOLD + 1000);
      expect(c.sinkRecoveryLevel).toBe(2); // L1 已执行
      expect(sent).toContain("stream/end");
      expect(sent.filter((t) => t === "group/update")).toEqual([]); // L1 不改播放状态
    } finally {
      vi.useRealTimers();
    }
  });

  it("④ L2 默认关(sinkAutoRestart=false):到点只复述告警,绝不按重启", () => {
    const c = makeConn(group);
    group.members.add(c);
    const spy = vi.spyOn(group as any, "restartStalledMember").mockResolvedValue(undefined);
    c.sinkHealth = "stalled";
    c.sinkStalledSinceMs = Date.now() - STEP_MS - SINK_L2_MS - 1;
    c.sinkRecoveryLevel = 2; // 已经历 L0/L1
    c.sinkLastRecoveryAt = 0;
    group.escalateSinkRecovery(c);
    expect(spy).not.toHaveBeenCalled();
    expect(c.sinkRecoveryLevel).toBe(3); // 钉在「已到顶」,别每窗刷同一条
    spy.mockRestore();
  });

  it("④ L2 开了:重启下发后阶梯归零 + 冷却前推(设备回来前绝不重复按)", () => {
    const c = makeConn(group);
    group.members.add(c);
    (group.server as any).sinkAutoRestart = true;
    const spy = vi.spyOn(group as any, "restartStalledMember").mockResolvedValue(undefined);
    c.sinkHealth = "stalled";
    c.sinkStalledSinceMs = Date.now() - STEP_MS - SINK_L2_MS - 1;
    c.sinkRecoveryLevel = 2;
    c.sinkLastRecoveryAt = 0;
    const before = Date.now();
    group.escalateSinkRecovery(c);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(c.sinkRecoveryLevel).toBe(0);
    expect(c.sinkLastRecoveryAt).toBeGreaterThanOrEqual(before + RESUME_COOLDOWN_MS);
    spy.mockRestore();
  });

  it("⑨ 常量守卫:阈值/节奏被人改坏了,这里必须红", () => {
    expect(RECOVER * 2).toBeLessThanOrEqual(THRESHOLD); // 16KB~32KB 中间带得真实存在
    expect(WINDOWS).toBe(3);
    expect(CONNECT_GRACE_MS).toBe(10_000);
    expect(PREFILL_MAX_MS).toBeGreaterThanOrEqual(STEP_MS); // 预填充兜底不短于自愈一档
    expect(STEP_MS).toBeGreaterThanOrEqual(30_000); // 不许把自动动作压到秒级
    expect(SINK_L2_MS).toBeGreaterThanOrEqual(3 * 60_000);
    expect(RESUME_COOLDOWN_MS).toBeGreaterThanOrEqual(5 * 60_000);
    expect(Math.round((THRESHOLD + RECOVER) / 2)).toBeGreaterThan(RECOVER);
    expect(Math.round((THRESHOLD + RECOVER) / 2)).toBeLessThan(THRESHOLD);
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

  it("④ 升级到 L2:开了 autoRestart ⇒ 走重启分支", () => {
    const c = makeConn(group);
    group.members.add(c);
    (group.server as any).sinkAutoRestart = true;
    const spy = vi.spyOn(group as any, "restartStalledMember").mockResolvedValue(undefined);
    c.sinkHealth = "stalled";
    c.sinkRecoveryLevel = 2; // 已经历过 L0/L1,下一级就是 L2 远程重启
    c.sinkLastRecoveryAt = 0;
    group.escalateSinkRecovery(c);
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

  it("⑤ 组内只有一位卡住 + 仍在 playing ⇒ 闸门开着,L2 走得通", () => {
    const c1 = makeConn(group);
    const c2 = makeConn(group);
    group.members.add(c1);
    group.members.add(c2);
    (group.server as any).sinkAutoRestart = true;
    c1.sinkHealth = "stalled";
    c2.sinkHealth = "ok";
    c1.sinkRecoveryLevel = 2; // 闸门开 ⇒ 走到 L2
    c1.sinkLastRecoveryAt = 0;
    const spy = vi.spyOn(group as any, "restartStalledMember").mockResolvedValue(undefined);
    group.escalateSinkRecovery(c1);
    expect(spy).toHaveBeenCalledTimes(1);
    spy.mockRestore();
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

  it("⑥b 实体挑选:safe-mode 按钮排在前头也不能被当成重启键", () => {
    // software-engineer 240 取证:真重启实体是 `esp32_player2_restart`;
    // ESPHome 的 safe-mode 按钮 object_id 常为 `restart_safe_mode`,同样命中 /restart/i,
    // 一旦排在实体表前面,旧实现会把它当重启键按下 ⇒ 设备进安全模式启动。
    const cmds: string[] = [];
    // entityId() 返回的是字符串形式的 branded id(`button-<object_id>`),不是对象。
    const cli: any = { command: (id: any) => void cmds.push(String(id)) };
    (esphomeBridge as any).entries.set("192.0.2.78", {
      host: "192.0.2.78",
      psk: "",
      port: 6053,
      cli,
      deviceName: "",
      esphomeVersion: "",
      connected: true,
      connectedAt: Date.now(),
      lastStateAt: Date.now(),
      lastError: "",
      states: new Map(),
      entities: new Map<string, any>([
        [
          "restart_safe_mode",
          { name: "esp32-player2 Safe Mode", objectId: "restart_safe_mode", type: "button" },
        ],
        [
          "esp32_player2_restart",
          { name: "esp32-player2 Restart", objectId: "esp32_player2_restart", type: "button" },
        ],
      ]),
    });
    const r = esphomeBridge.restartDevice("192.0.2.78");
    expect(r.ok).toBe(true);
    expect(cmds).toEqual(["button-esp32_player2_restart"]); // 必须挑中真重启,不是 safe mode
  });

  it("⑥c 命名不规范时按名字兜底,但仍记 warn 并照发", () => {
    const cmds: string[] = [];
    // entityId() 返回的是字符串形式的 branded id(`button-<object_id>`),不是对象。
    const cli: any = { command: (id: any) => void cmds.push(String(id)) };
    (esphomeBridge as any).entries.set("192.0.2.79", {
      host: "192.0.2.79",
      psk: "",
      port: 6053,
      cli,
      deviceName: "",
      esphomeVersion: "",
      connected: true,
      connectedAt: Date.now(),
      lastStateAt: Date.now(),
      lastError: "",
      states: new Map(),
      entities: new Map<string, any>([
        ["esp32_player2_restart_now", { name: "esp32-player2 Restart Now", objectId: "esp32_player2_restart_now", type: "button" }],
      ]),
    });
    const r = esphomeBridge.restartDevice("192.0.2.79");
    expect(r.ok).toBe(true);
    expect(cmds).toEqual(["button-esp32_player2_restart_now"]);
  });

  it("⑥d L2 真实成功路径:重启命令真的进设备(不 mock 掉被测方法本身)", async () => {
    // 旧用例把 group.restartStalledMember 整个 mock 掉,只验了「level+1」,
    // 真正按下按钮这一段等于没测 —— 这里注入一台桥里已知的机器,真走完
    // restartDevice → esphomeBridge 的 cli.command(...) 全链路。
    const cmds: string[] = [];
    const cli: any = { command: (id: any) => void cmds.push(String(id)) };
    (esphomeBridge as any).entries.set("192.0.2.80", {
      host: "192.0.2.80",
      psk: "",
      port: 6053,
      cli,
      deviceName: "",
      esphomeVersion: "",
      connected: true,
      connectedAt: Date.now(),
      lastStateAt: Date.now(),
      lastError: "",
      states: new Map(),
      entities: new Map<string, any>([
        ["esp32_player2_restart", { name: "esp32-player2 Restart", objectId: "esp32_player2_restart", type: "button" }],
      ]),
    });
    const c = makeConn(group);
    group.members.add(c);
    (group.server as any).sinkAutoRestart = true;
    (c as any).remoteHost = "192.0.2.80";
    c.sinkHealth = "stalled";
    c.sinkStalledSinceMs = Date.now() - STEP_MS - SINK_L2_MS - 1;
    c.sinkRecoveryLevel = 2;
    c.sinkLastRecoveryAt = 0;
    group.escalateSinkRecovery(c);
    // escalateSinkRecovery 里是 `void this.restartStalledMember(c)`,异步尾巴要自己冲一冲。
    await vi.waitFor(() => expect(cmds).toEqual(["button-esp32_player2_restart"]));
    (esphomeBridge as any).entries.delete("192.0.2.80");
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
