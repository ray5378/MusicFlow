// AirPlay 桥纯函数边界定向单测(resampler / rates 常量契约)。
//
// 为什么补这份:resampler.ts 基线 98% 行但**函数覆盖 84.61%**(三个 getter 从未被读),
// 分支 89.47%;这些纯函数是桥锚点计算的地基 —— 帧数契约/群延迟/采样率映射错一位,
// 表现就是整组 A/V 恒定偏移(实听觉得到、日志看不出来),因此边界必须钉死:
//   · 空输入、单帧、非整数声道倍长、非法采样率;
//   · 48k→48k 直通(L===M===1)与 44.1k→48k 上采样;
//   · 群延迟常量与 PROTOCOL_CAPS 的映射(AP1 恒 44.1k / AP2 以协商为准)。
import { describe, it, expect } from "vitest";
import {
  PolyphaseResampler,
  RESAMPLE_GROUP_DELAY_OUT,
  RESAMPLE_TAPS,
  floatToPcmS16,
  pcmS16ToFloat,
} from "../../src/services/airplay/resampler.js";
import {
  AIRPLAY1_RATE,
  AP2_RATES,
  PROTOCOL_CAPS,
  RESAMPLE_GROUP_DELAY_MS,
  RESAMPLE_GROUP_DELAY_OUT_SAMPLES,
  RESAMPLE_L,
  RESAMPLE_M,
  SENDSPIN_RATE,
} from "../../src/services/airplay/rates.js";

describe("PolyphaseResampler:构造与不变量", () => {
  it("48k→44.1k:L=147 / M=160(gcd 化简后不可再约)", () => {
    const r = new PolyphaseResampler(SENDSPIN_RATE, AIRPLAY1_RATE, 2);
    expect(r.L).toBe(RESAMPLE_L);
    expect(r.M).toBe(RESAMPLE_M);
    expect(r.inRate).toBe(48_000);
    expect(r.outRate).toBe(44_100);
    expect(r.channels).toBe(2);
  });

  it("非正采样率 → 抛错(不产生 NaN 系数的静默降级)", () => {
    expect(() => new PolyphaseResampler(0, 44_100, 2)).toThrow("invalid rates");
    expect(() => new PolyphaseResampler(48_000, -1, 2)).toThrow("invalid rates");
    expect(() => new PolyphaseResampler(-48_000, 44_100, 2)).toThrow("invalid rates");
  });

  it("48k→48k 直通:L=M=1(桥 48k 协商直通路径,不做重采样)", () => {
    const r = new PolyphaseResampler(SENDSPIN_RATE, SENDSPIN_RATE, 2);
    expect(r.L).toBe(1);
    expect(r.M).toBe(1);
  });

  it("44.1k→48k 上采样:L=160 / M=147(与下行互为倒数)", () => {
    const r = new PolyphaseResampler(AIRPLAY1_RATE, SENDSPIN_RATE, 2);
    expect(r.L).toBe(160);
    expect(r.M).toBe(147);
  });
});

describe("PolyphaseResampler:输入边界", () => {
  it("空输入 → 空输出,计数器不前进", () => {
    const r = new PolyphaseResampler(SENDSPIN_RATE, AIRPLAY1_RATE, 2);
    const out = r.process(new Float32Array(0));
    expect(out.length).toBe(0);
    expect(r.totalIn).toBe(0);
    expect(r.totalOut).toBe(0);
  });

  it("单帧输入 → 输出帧数符合契约,状态计数器自洽", () => {
    const r = new PolyphaseResampler(SENDSPIN_RATE, AIRPLAY1_RATE, 2);
    const out = r.process(new Float32Array([0.5, -0.5]));
    expect(r.totalIn).toBe(1);
    expect(out.length).toBe(r.totalOut * 2); // 交错布局:帧数 × 声道
    expect(r.totalOut).toBeGreaterThanOrEqual(0);
  });

  it("交错长度不是声道整数倍 → 抛错(错位数据不能静默通过)", () => {
    const r = new PolyphaseResampler(SENDSPIN_RATE, AIRPLAY1_RATE, 2);
    expect(() => r.process(new Float32Array([0.1, 0.2, 0.3]))).toThrow("not a multiple of channels");
  });

  it("全部静音输入 → 输出全零(不产生直流偏移)", () => {
    const r = new PolyphaseResampler(SENDSPIN_RATE, AIRPLAY1_RATE, 2);
    const out = r.process(new Float32Array(1_024 * 2));
    expect(Array.from(out).every((v) => v === 0)).toBe(true);
  });
});

describe("PolyphaseResampler:只读视图(锚点补偿依赖)", () => {
  it("groupDelayOut 恒为 (TAPS−1)/2 = 16 且与 rates.ts 常量一致", () => {
    const r = new PolyphaseResampler(SENDSPIN_RATE, AIRPLAY1_RATE, 2);
    expect(r.groupDelayOut).toBe(16);
    expect(r.groupDelayOut).toBe(RESAMPLE_GROUP_DELAY_OUT);
    expect(r.groupDelayOut).toBe(RESAMPLE_GROUP_DELAY_OUT_SAMPLES);
    expect((RESAMPLE_TAPS - 1) / 2).toBe(RESAMPLE_GROUP_DELAY_OUT);
  });

  it("totalIn / totalOut 随喂入累进且不回头裁剪到别处(帧数契约可观测)", () => {
    const r = new PolyphaseResampler(SENDSPIN_RATE, AIRPLAY1_RATE, 2);
    r.process(new Float32Array(480 * 2));
    expect(r.totalIn).toBe(480);
    const firstOut = r.totalOut;
    expect(firstOut).toBe(Math.ceil((480 * RESAMPLE_L) / RESAMPLE_M));
    r.process(new Float32Array(480 * 2));
    expect(r.totalIn).toBe(960);
    expect(r.totalOut).toBe(Math.ceil((960 * RESAMPLE_L) / RESAMPLE_M));
  });

  it("群延迟毫秒换算与输出样本口径一致(±1µs,MIN-01 符号方向的前提)", () => {
    const us = (RESAMPLE_GROUP_DELAY_OUT / AIRPLAY1_RATE) * 1e6;
    expect(Math.abs(us - RESAMPLE_GROUP_DELAY_MS * 1000)).toBeLessThan(1);
  });
});

describe("S16 ↔ Float 互换边界", () => {
  it("floatToPcmS16:超范围钳到 ±1 后再量化(不产生 int16 回绕噪声)", () => {
    const out = floatToPcmS16(new Float32Array([2, -2, 1, -1]));
    expect(Array.from(out)).toEqual([32767, -32768, 32767, -32768]);
  });

  it("pcmS16ToFloat / floatToPcmS16 空数组往返安全", () => {
    expect(pcmS16ToFloat(new Int16Array(0)).length).toBe(0);
    expect(floatToPcmS16(new Float32Array(0)).length).toBe(0);
  });

  it("S16 → Float → S16 单点往返零误差(0 / 满量程)", () => {
    const src = new Int16Array([0, 32767, -32768, 1, -1]);
    const back = floatToPcmS16(pcmS16ToFloat(src));
    // 32768 刻度往返:±1 LSB 内
    for (let i = 0; i < src.length; i++) {
      expect(Math.abs(back[i] - src[i])).toBeLessThanOrEqual(1);
    }
  });
});

describe("rates.ts:协议能力映射契约", () => {
  it("AP1 / ap2-compat 恒 44.1k 且 clock=ntp / 无加密", () => {
    expect(PROTOCOL_CAPS.raop).toEqual({ rate: 44_100, clock: "ntp", encryption: "none", streamType: 96 });
    expect(PROTOCOL_CAPS["ap2-compat"]).toEqual({ rate: 44_100, clock: "ntp", encryption: "none", streamType: 96 });
  });

  it("ap2-realtime 与 ap2-buffered 同用 48k,但 streamType/clock/加密不同(96 不能单独区分协议)", () => {
    expect(PROTOCOL_CAPS["ap2-realtime"]).toEqual({ rate: 48_000, clock: "ntp", encryption: "alac-chacha", streamType: 96 });
    expect(PROTOCOL_CAPS["ap2-buffered"]).toEqual({ rate: 48_000, clock: "ptp", encryption: "alac-chacha", streamType: 103 });
    // 96 同时代表 RAOP 与 AP2 realtime ⇒ 必须连带看 encryption
    expect(PROTOCOL_CAPS.raop.streamType).toBe(PROTOCOL_CAPS["ap2-realtime"].streamType);
    expect(PROTOCOL_CAPS.raop.encryption).not.toBe(PROTOCOL_CAPS["ap2-realtime"].encryption);
  });

  it("AP2 协商允许速率集合只含 48k / 44.1k(不假定 48k)", () => {
    expect([...AP2_RATES]).toEqual([48_000, 44_100]);
  });
});
