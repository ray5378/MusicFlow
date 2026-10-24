import { describe, expect, it } from "vitest";
import {
  PolyphaseResampler,
  RESAMPLE_GROUP_DELAY_OUT,
  RESAMPLE_TAPS,
  floatToPcmS16,
  pcmS16ToFloat,
} from "../../src/services/airplay/resampler.js";

/** Goertzel 单频幅度(比 FFT 精确到任意频率)。 */
function goertzel(x: Float32Array, rate: number, freq: number): number {
  const k = (2 * Math.PI * freq) / rate;
  const coeff = 2 * Math.cos(k);
  let s1 = 0;
  let s2 = 0;
  for (let i = 0; i < x.length; i++) {
    const s0 = x[i] + coeff * s1 - s2;
    s2 = s1;
    s1 = s0;
  }
  const power = s1 * s1 + s2 * s2 - coeff * s1 * s2;
  return Math.sqrt(Math.max(0, power)) * 2 / x.length;
}

/** 过零测频(±0.5% 内足够)。 */
function zeroCrossFreq(x: Float32Array, rate: number): number {
  let crossings = 0;
  for (let i = 1; i < x.length; i++) {
    if (x[i - 1] < 0 && x[i] >= 0) crossings++;
  }
  return (crossings * rate) / x.length;
}

function sine(rate: number, frames: number, freq: number, channels = 2): Float32Array {
  const out = new Float32Array(frames * channels);
  for (let i = 0; i < frames; i++) {
    const v = Math.sin((2 * Math.PI * freq * i) / rate);
    for (let c = 0; c < channels; c++) out[i * channels + c] = v;
  }
  return out;
}

describe("PolyphaseResampler:147/160 多相 FIR(48k→44.1k)", () => {
  it("群延迟常量自洽:16 输出样本 @44.1k ≈ 0.3627ms(±1µs)", () => {
    expect(RESAMPLE_TAPS).toBe(33);
    expect(RESAMPLE_GROUP_DELAY_OUT).toBe(16);
    const ms = (16 / 44100) * 1000;
    expect(Math.abs(ms - 0.3627)).toBeLessThanOrEqual(0.001); // 1µs
  });

  it("MIN-01 符号方向:输入第 0 帧的脉冲 → 输出峰落在第 16 个输出样本(内容比输出早,不是晚)", () => {
    const r = new PolyphaseResampler(48000, 44100, 1);
    const input = new Float32Array(4800);
    input[0] = 1;
    const out = r.process(input);
    let peak = 0;
    for (let i = 1; i < out.length; i++) if (Math.abs(out[i]) > Math.abs(out[peak])) peak = i;
    expect(peak).toBe(16);
    // 输出峰时刻 = 16/44100 = 362.8µs —— 在内容时间 0 **之后**(正延迟)
    const delayUs = (peak / 44100) * 1e6;
    expect(Math.abs(delayUs - 362.7)).toBeLessThanOrEqual(1);
    expect(delayUs).toBeGreaterThan(0);
  });

  it("帧数契约:任意分块喂入,totalOut 恒 == ceil(totalIn·147/160),零累计误差", () => {
    const r = new PolyphaseResampler(48000, 44100, 2);
    let fed = 0;
    let seed = 42;
    const rand = () => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return (seed / 0x7fffffff) * 2 - 1;
    };
    for (let round = 0; round < 50; round++) {
      const n = 1 + ((round * 97) % 2000); // 刻意不齐的块长
      const buf = new Float32Array(n * 2);
      for (let i = 0; i < buf.length; i++) buf[i] = rand();
      r.process(buf);
      fed += n;
      expect(r.totalOut).toBe(Math.ceil((fed * 147) / 160));
    }
    // 精确整数点:160000 输入帧 → 147000 输出帧
    const r2 = new PolyphaseResampler(48000, 44100, 1);
    const left = 160000;
    r2.process(new Float32Array(left));
    expect(r2.totalOut).toBe(147000);
  });

  it("10 分钟量级(60s 抽测):分块连续喂 2.88M 帧 → 2.646M 输出,累计误差 0 帧", () => {
    const r = new PolyphaseResampler(48000, 44100, 2);
    const total = 2_880_000; // 60s @48k
    const chunk = 960; // 20ms
    let fed = 0;
    while (fed < total) {
      const n = Math.min(chunk, total - fed);
      const buf = new Float32Array(n * 2);
      for (let i = 0; i < n; i++) {
        const t = fed + i;
        buf[i * 2] = Math.sin((2 * Math.PI * 440 * t) / 48000);
        buf[i * 2 + 1] = Math.sin((2 * Math.PI * 660 * t) / 48000);
      }
      r.process(buf);
      fed += n;
    }
    expect(r.totalOut).toBe(Math.ceil((total * 147) / 160));
    expect(r.totalOut).toBe(2_646_000);
  });

  it("1kHz 音调:频率保持 ±0.5%,增益平坦", () => {
    const r = new PolyphaseResampler(48000, 44100, 1);
    const inAmp = 0.8;
    const frames = 48000;
    const input = new Float32Array(frames);
    for (let i = 0; i < frames; i++) input[i] = inAmp * Math.sin((2 * Math.PI * 1000 * i) / 48000);
    const out = r.process(input);
    const mid = out.subarray(4000, out.length - 4000); // 去掉群延迟/边缘
    const f = zeroCrossFreq(mid, 44100);
    expect(Math.abs(f - 1000) / 1000).toBeLessThanOrEqual(0.005);
    const amp = goertzel(mid, 44100, 1000);
    const gainDb = 20 * Math.log10(amp / inAmp);
    expect(gainDb).toBeGreaterThan(-0.5);
    expect(gainDb).toBeLessThan(0.5);
  });

  it("15kHz:通带内,损失 ≤1dB", () => {
    const r = new PolyphaseResampler(48000, 44100, 1);
    const inAmp = 0.8;
    const frames = 48000;
    const input = new Float32Array(frames);
    for (let i = 0; i < frames; i++) input[i] = inAmp * Math.sin((2 * Math.PI * 15000 * i) / 48000);
    const out = r.process(input);
    const mid = out.subarray(4000, out.length - 4000);
    const amp = goertzel(mid, 44100, 15000);
    const lossDb = -20 * Math.log10(amp / inAmp);
    expect(lossDb).toBeLessThanOrEqual(1);
  });

  it("23kHz(> 输出奈奎斯特):抑制度 ≥40dB(残余混叠到 21.1k)", () => {
    const r = new PolyphaseResampler(48000, 44100, 1);
    const inAmp = 0.8;
    const frames = 48000;
    const input = new Float32Array(frames);
    for (let i = 0; i < frames; i++) input[i] = inAmp * Math.sin((2 * Math.PI * 23000 * i) / 48000);
    const out = r.process(input);
    const mid = out.subarray(4000, out.length - 4000);
    // 23k 输入混叠到 44100−23000 = 21100
    const aliased = goertzel(mid, 44100, 21100);
    const attenDb = -20 * Math.log10(aliased / inAmp);
    expect(attenDb).toBeGreaterThanOrEqual(40);
  });

  it("立体声独立:双声道不同频率互不串扰", () => {
    const r = new PolyphaseResampler(48000, 44100, 2);
    const frames = 48000;
    const input = new Float32Array(frames * 2);
    for (let i = 0; i < frames; i++) {
      input[i * 2] = 0.8 * Math.sin((2 * Math.PI * 1000 * i) / 48000);
      input[i * 2 + 1] = 0.8 * Math.sin((2 * Math.PI * 5000 * i) / 48000);
    }
    const out = r.process(input);
    const l = new Float32Array(out.length / 2);
    const rr = new Float32Array(out.length / 2);
    for (let i = 0; i < l.length; i++) {
      l[i] = out[i * 2];
      rr[i] = out[i * 2 + 1];
    }
    const lm = l.subarray(4000, l.length - 4000);
    const rm = rr.subarray(4000, rr.length - 4000);
    expect(goertzel(lm, 44100, 1000)).toBeGreaterThan(0.5);
    expect(goertzel(lm, 44100, 5000)).toBeLessThan(0.01);
    expect(goertzel(rm, 44100, 5000)).toBeGreaterThan(0.5);
    expect(goertzel(rm, 44100, 1000)).toBeLessThan(0.01);
  });

  it("S16 互换:往返误差 ≤1 LSB", () => {
    const src = new Float32Array(1000);
    for (let i = 0; i < src.length; i++) src[i] = Math.sin(i / 7);
    const back = pcmS16ToFloat(floatToPcmS16(src));
    for (let i = 0; i < src.length; i++) {
      expect(Math.abs(back[i] - src[i])).toBeLessThanOrEqual(1 / 32768 + 1e-9);
    }
  });
});
