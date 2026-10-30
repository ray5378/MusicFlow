// ==================== 桥会话活性看门狗:判据阈值 + 设备级熔断(v4.10.1 C/D 组) ====================
//
// 背景(2026-10-30 240 线上取证):
//   ① 看门狗判据 = 设备 timing(NTP)心跳静默。全量 pcap 实测 HiVi 上行 NTP 共 4611 包 /
//      9 个会话 / ≈4.1 小时,**会话内最大间隔只有 6.0 秒**(>10s 样本为 0) ⇒ 健康期铁定
//      20 次/分钟。旧缺省 45s 把每次"接收端僵死"的失声拖长到 45s 以上,故降到 15s
//      (自然上限的 2.5 倍)。
//   ② 旧熔断状态挂在 BridgeSession 实例上,而看门狗每次触发都会重建会话对象 ⇒ 历史随旧
//      实例销毁 ⇒ "10 分钟内 ≥2 次"永远攒不满。240 实证 2026-10-29 10:03–10:48 连炸
//      10 次、间隔精确 300s,熔断一次都没生效 ⇒ 状态上提为**设备级**。
//
// 钉死:
//   ① raopBridgeLivenessMs 缺省 15000、env 可覆盖、下限 5000;
//   ② livenessWatchdogShouldFire 在 16s/15s 处放行、6s 处拦下;paused/非 streaming 恒拦;
//   ③ noteLivenessFire 跨"会话重建"累计(不依赖任何 session 实例);
//   ④ 窗口内第 2 次起退避 30s、≥3 次退避 120s;
//   ⑤ 连续 3 次重连都没救回心跳 ⇒ 停用 30min;任何一次救回来就立刻归零。
import "../plugins/_env.js";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  livenessBreakerState,
  livenessWatchdogShouldFire,
  noteLivenessFire,
  raopBridgeLivenessMs,
  raopBridgeLivenessWatchdogEnabled,
  resetLivenessBreaker,
} from "../../src/services/airplay/bridgeSession.js";

const ENV_KEY = "MF_BRIDGE_RAOP_LIVENESS_MS";

function baseOpts(over: Partial<Parameters<typeof livenessWatchdogShouldFire>[0]> = {}) {
  return {
    enabled: true,
    isAp2: false,
    paused: false,
    connected: true,
    closed: false,
    hasPlayer: true,
    streaming: true,
    reconnectInFlight: false,
    reconnectTimerSet: false,
    quietMs: 0,
    thresholdMs: raopBridgeLivenessMs(),
    ...over,
  };
}

beforeEach(() => {
  delete process.env[ENV_KEY];
  resetLivenessBreaker();
});

afterEach(() => {
  delete process.env[ENV_KEY];
  resetLivenessBreaker();
});

describe("raopBridgeLivenessMs:阈值", () => {
  it("缺省 15000ms(不是旧的 45000)", () => {
    expect(raopBridgeLivenessMs()).toBe(15000);
  });

  it("env 可覆盖到 15000 以上", () => {
    process.env[ENV_KEY] = "20000";
    expect(raopBridgeLivenessMs()).toBe(20000);
  });

  it("env 低于下限 5000 视为误配,回落缺省", () => {
    process.env[ENV_KEY] = "3000";
    expect(raopBridgeLivenessMs()).toBe(15000);
    process.env[ENV_KEY] = "abc";
    expect(raopBridgeLivenessMs()).toBe(15000);
  });

  it("看门狗总开关缺省 ON,0/false 关闭", () => {
    expect(raopBridgeLivenessWatchdogEnabled()).toBe(true);
    process.env.MF_BRIDGE_RAOP_LIVENESS_WATCHDOG = "0";
    expect(raopBridgeLivenessWatchdogEnabled()).toBe(false);
  });
});

describe("livenessWatchdogShouldFire:判据边界", () => {
  it("心跳静默 16s > 15s 阈值 ⇒ 触发", () => {
    expect(livenessWatchdogShouldFire(baseOpts({ quietMs: 16000 }))).toBe(true);
  });

  it("心跳静默 6s(实测健康期最大间隔)⇒ 绝不触发", () => {
    expect(livenessWatchdogShouldFire(baseOpts({ quietMs: 6000 }))).toBe(false);
  });

  it("静默 15s 恰好等于阈值 ⇒ 不触发(严格大于)", () => {
    expect(livenessWatchdogShouldFire(baseOpts({ quietMs: 15000 }))).toBe(false);
  });

  it("暂停/未起流/重连中/已关闭 一律拦下", () => {
    const over = [
      { paused: true },
      { streaming: false },
      { connected: false },
      { closed: true },
      { hasPlayer: false },
      { reconnectInFlight: true },
      { reconnectTimerSet: true },
      { isAp2: true },
      { enabled: false },
    ];
    for (const o of over) {
      expect(livenessWatchdogShouldFire(baseOpts({ quietMs: 999999, ...o }))).toBe(false);
    }
  });
});

describe("noteLivenessFire:设备级熔断状态机", () => {
  it("★ 状态按 deviceId 持久:跨「会话重建」仍累计(回归钉)", () => {
    // 这里完全不构造 BridgeSession —— 旧实现的状态在实例上,这样写必然拿不到历史。
    const t0 = 1_000_000;
    const a = noteLivenessFire("dev-x", t0, false);
    expect(a.firesInWindow).toBe(1);
    expect(a.cooldownUntil).toBe(0); // 第 1 次立即重连
    const b = noteLivenessFire("dev-x", t0 + 1000, true);
    expect(b.firesInWindow).toBe(2); // ← 旧实现此处恒为 1
    expect(b.cooldownUntil).toBe(t0 + 1000 + 30000); // 第 2 次退避 30s
  });

  it("不同设备互不干扰", () => {
    noteLivenessFire("dev-a", 1000, false);
    const b = noteLivenessFire("dev-b", 2000, false);
    expect(b.firesInWindow).toBe(1);
    expect(livenessBreakerState("dev-a").fireAt.length).toBe(1);
  });

  it("窗口内第 3 次起退避 120s", () => {
    const t0 = 5_000_000;
    noteLivenessFire("dev-y", t0, true);
    noteLivenessFire("dev-y", t0 + 31_000, true);
    const third = noteLivenessFire("dev-y", t0 + 62_000, true);
    expect(third.firesInWindow).toBe(3);
    expect(third.cooldownUntil).toBe(t0 + 62_000 + 120_000);
  });

  it("超过 10 分钟窗口的旧记录被剔除", () => {
    const t0 = 9_000_000;
    noteLivenessFire("dev-z", t0, true);
    const later = noteLivenessFire("dev-z", t0 + 601_000, true);
    expect(later.firesInWindow).toBe(1);
    expect(later.cooldownUntil).toBe(0);
  });

  it("★ 连续 3 次重连都没救回心跳 ⇒ 停用 30min", () => {
    const t0 = 20_000_000;
    const f1 = noteLivenessFire("dev-d", t0, false);
    const f2 = noteLivenessFire("dev-d", t0 + 200_000, false);
    const f3 = noteLivenessFire("dev-d", t0 + 400_000, false);
    expect(f1.disabled).toBe(false);
    expect(f2.disabled).toBe(false);
    expect(f2.failedRun).toBe(1);
    expect(f3.disabled).toBe(true);
    expect(f3.cooldownUntil).toBe(t0 + 400_000 + 1_800_000);
    expect(livenessBreakerState("dev-d").cooldownUntil).toBe(t0 + 400_000 + 1_800_000);
  });

  it("★ 只要救回一次心跳,failedRun 立刻归零(不许把正常设备钉死)", () => {
    const t0 = 30_000_000;
    noteLivenessFire("dev-r", t0, false);
    const f2 = noteLivenessFire("dev-r", t0 + 200_000, false);
    expect(f2.failedRun).toBe(1);
    // 第 3 次之前设备恢复过心跳 ⇒ 不算连续失败
    const f3 = noteLivenessFire("dev-r", t0 + 400_000, true);
    expect(f3.failedRun).toBe(0);
    expect(f3.disabled).toBe(false);
  });

  it("resetLivenessBreaker 清空后重新计数", () => {
    noteLivenessFire("dev-m", 1000, true);
    noteLivenessFire("dev-m", 2000, true);
    expect(livenessBreakerState("dev-m").fireAt.length).toBe(2);
    resetLivenessBreaker("dev-m");
    expect(livenessBreakerState("dev-m").fireAt.length).toBe(0);
    expect(noteLivenessFire("dev-m", 3000, true).firesInWindow).toBe(1);
  });
});
