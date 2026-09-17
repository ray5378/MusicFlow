import { describe, it, expect, beforeEach } from "vitest";
import {
  computeCommonSendAhead, distributeGroupVolume, SendspinGroup, DEFAULT_MIN_BUFFER_MS,
} from "./group.js";

// send_ahead 单位回归锁:协议单位是**微秒**(aiosendspin models/player.py
// "Microseconds from server transmit to timestamp_us";DEFAULT_INITIAL_DELAY_US = 250_000)。
// 2026-09-17 真机事故:曾按毫秒填 800 → 设备视为 0.8ms → 调度器认为目标时刻已过、
// 立即输出 → 全程 underrun → 日志全绿(Stream Started/codec header/speaker Starting)
// 但完全无声。此测试盯死「必须是微秒量级」,防止再次退回毫秒。
describe("computeCommonSendAhead 单位", () => {
  it("返回微秒量级(≥10 万),绝不退回毫秒量级的几百", () => {
    const v = computeCommonSendAhead([]);
    expect(v).toBeGreaterThanOrEqual(100_000);
  });

  it("空成员 = 缺省 min_buffer 800ms → 800000 微秒", () => {
    expect(computeCommonSendAhead([])).toBe(800_000);
    expect(DEFAULT_MIN_BUFFER_MS).toBe(800);
  });
});

// P1(2026-09-17):send_ahead 改为由**设备上报的 client/state 参数**驱动,
// 对齐 MA 公式:`max(min_buffer, required_lead) + output_delay`(均毫秒 → 微秒)。
// 设备未上报时回落缺省 800ms —— 与改动前行为一致,保证旧固件不受影响。
describe("computeCommonSendAhead 设备参数(MA 公式)", () => {
  it("设备上报 min_buffer=300 → 300000 微秒(不再恒 800ms)", () => {
    expect(computeCommonSendAhead([{ minBufferMs: 300 }])).toBe(300_000);
  });

  it("取 min_buffer 与 required_lead 的较大值", () => {
    // max(200, 500) = 500 → 500_000
    expect(computeCommonSendAhead([{ minBufferMs: 200, requiredLeadTimeMs: 500 }])).toBe(500_000);
    // max(700, 100) = 700 → 700_000
    expect(computeCommonSendAhead([{ minBufferMs: 700, requiredLeadTimeMs: 100 }])).toBe(700_000);
  });
  it("output_delay 叠加在 base 之上(MA:base + output_delay)", () => {
    // max(300, 0) + 120 = 420 → 420_000
    expect(computeCommonSendAhead([{ minBufferMs: 300, outputDelayMs: 120 }])).toBe(420_000);
  });

  it("多成员取最大值(余量须满足最慢的那个)", () => {
    const v = computeCommonSendAhead([
      { minBufferMs: 200 },
      { minBufferMs: 900, outputDelayMs: 50 },
    ]);
    expect(v).toBe(950_000);
  });

  it("未上报参数(全 undefined)→ 缺省 800ms,保持向后兼容", () => {
    expect(computeCommonSendAhead([{}, {}])).toBe(800_000);
  });

  it("字段缺失时各自回落缺省(仅给 output_delay 仍以 800ms 为底)", () => {
    expect(computeCommonSendAhead([{ outputDelayMs: 100 }])).toBe(900_000);
  });

  it("设备全报 0 → 回落缺省 800ms(ESPHome 真实上报形态)", () => {
    // 实测 2026-09-17:ESPHome `client/state` 恒报全 0("表达能力缺失",不是真实诉求)。
    // 曾用 `??` 判缺省 → 取 0 → send_ahead=0 → 设备立即输出 → underrun 无声。
    expect(
      computeCommonSendAhead([{ minBufferMs: 0, requiredLeadTimeMs: 0, outputDelayMs: 0 }]),
    ).toBe(800_000);
  });

  it("0 与缺失等价,负值/NaN 同样回落", () => {
    expect(computeCommonSendAhead([{}])).toBe(computeCommonSendAhead([{ minBufferMs: 0 }]));
    expect(computeCommonSendAhead([{ minBufferMs: -5 }])).toBe(800_000);
    expect(computeCommonSendAhead([{ minBufferMs: Number.NaN }])).toBe(800_000);
    // 只有有效正值才参与计算
    expect(computeCommonSendAhead([{ minBufferMs: 0, outputDelayMs: 150 }])).toBe(950_000);
  });
});

describe("distributeGroupVolume", () => {
  it("两成员音量 50/100 → 有效 50/100", () => {
    const r = distributeGroupVolume([
      { volume: 50, muted: false },
      { volume: 100, muted: false },
    ]);
    expect(r.members.map((m) => m.effective)).toEqual([50, 100]);
  });

  it("静音成员有效音量归 0", () => {
    const r = distributeGroupVolume([
      { volume: 100, muted: true },
      { volume: 0, muted: false },
    ]);
    expect(r.members[0].effective).toBe(0);
  });

  it("空组 scale=1", () => {
    expect(distributeGroupVolume([]).scale).toBe(1);
  });
});

describe("SendspinGroup", () => {
  let g: SendspinGroup;
  beforeEach(() => {
    g = new SendspinGroup("g1");
  });
  it("默认组音量/位置", () => {
    expect(g.props.volume).toBe(100);
    expect(g.props.muted).toBe(false);
  });
});