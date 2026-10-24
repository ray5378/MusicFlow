import { describe, expect, it } from "vitest";
import { ntpFromHostUs, ntpToHostUs, nowUs, setNowUsOverride } from "../../src/utils/hostClock.js";
import {
  audibleAtUs,
  bridgeStartLeadUs,
  computeBridgeAnchors,
  driftCorrection,
  groupDelayUs,
  ntpToRtpMod,
  rtpAt,
  sendAtUs,
} from "../../src/services/airplay/bridgeMath.js";
import { RESAMPLE_GROUP_DELAY_OUT_SAMPLES } from "../../src/services/airplay/rates.js";

describe("hostClock:单一时钟源", () => {
  it("nowUs 单调不减", () => {
    let last = 0n;
    for (let i = 0; i < 1000; i++) {
      const t = nowUs();
      expect(t).toBeGreaterThanOrEqual(last);
      last = t;
    }
  });

  it("override 接缝生效并可恢复", () => {
    setNowUsOverride(() => 1234n);
    expect(nowUs()).toBe(1234n);
    setNowUsOverride(null);
    expect(nowUs()).toBeGreaterThan(0n);
  });

  it("ntpFromHostUs ⇄ ntpToHostUs 往返误差 ≤1µs", () => {
    for (const us of [0n, 1n, 999_999n, 1_000_000n, 27n * 3600n * 1_000_000n, 100_000n * 1_000_000n]) {
      const back = ntpToHostUs(ntpFromHostUs(us));
      expect(Number(us - back)).toBeLessThanOrEqual(1);
      expect(Number(back - us)).toBeLessThanOrEqual(1);
    }
  });
});

describe("bridgeMath:锚点四字段(MAJ-09)", () => {
  const RATE = 44100;
  const LATENCY = 44100; // 1s
  const A = 2_000_000_000n; // 内容首样本应可听的 host µs

  it("baseTs=startTs=headTs=B;B ≤ 0xFFFFFFFF 且 %352==0;positionSec 从 0 起", () => {
    const a = computeBridgeAnchors({ anchorUs: A, latencyFrames: LATENCY, rate: RATE });
    expect(a.baseTs).toBe(a.startTs);
    expect(a.startTs).toBe(a.headTs);
    expect(a.headTs).toBeLessThanOrEqual(0xFFFFFFFF);
    expect(a.headTs % 352).toBe(0);
    // positionSec = ts2ms((headTs − baseTs) >>> 0)/1000 = 0
    expect((a.headTs - a.baseTs) >>> 0).toBe(0);
  });

  it("首包(映射)可听时刻 = A + 群延迟 ±1 sample(误差 ≤22.7µs @44.1k)", () => {
    const a = computeBridgeAnchors({ anchorUs: A, latencyFrames: LATENCY, rate: RATE });
    const mappedAudible = ntpToHostUs(a.startNtp) + BigInt(Math.round((LATENCY / RATE) * 1e6));
    const gd = BigInt(Math.round(groupDelayUs(RATE)));
    const diff = Number(mappedAudible - (A + gd));
    expect(Math.abs(diff)).toBeLessThanOrEqual(23);
  });

  it("MIN-01 符号方向:映射锚点比内容锚点**晚** GD(后移,不是前移)", () => {
    const a = computeBridgeAnchors({ anchorUs: A, latencyFrames: LATENCY, rate: RATE });
    expect(a.anchorUsShifted).toBeGreaterThan(A);
    expect(Number(a.anchorUsShifted - A)).toBeCloseTo(groupDelayUs(RATE), 0);
    expect(groupDelayUs(RATE)).toBeGreaterThan(0);
    expect(groupDelayUs(RATE)).toBeCloseTo(362.7, 0); // µs
    expect(RESAMPLE_GROUP_DELAY_OUT_SAMPLES).toBe(16);
  });

  it("MAJ-10:uptime 100_000s 下四字段全部落在 32 位模域且对齐不被破坏", () => {
    const a = computeBridgeAnchors({
      anchorUs: 100_000n * 1_000_000n,
      latencyFrames: LATENCY,
      rate: RATE,
    });
    expect(a.baseTs).toBeLessThanOrEqual(0xFFFFFFFF);
    expect(a.baseTs % 352).toBe(0);
    // rtpAt 从 B 前后取点,模域差值可解码
    const ahead = rtpAt(a.anchorUsShifted + 1_000_000n, a.anchorUsShifted, a.baseTs, RATE);
    expect((ahead - a.baseTs) >>> 0).toBe(44100); // +1s = 44100 帧
  });

  it("rtpAt 跨 2^32 回绕:B 靠近 0xFFFFFFFF 时差值解码仍正确", () => {
    // 构造 baseTs 靠近回绕点:用 rtpBase 注入预对齐值
    const nearWrap = 0xFFFFFF00 - (0xFFFFFF00 % 352);
    const a = computeBridgeAnchors({
      anchorUs: A,
      latencyFrames: LATENCY,
      rate: RATE,
      rtpBase: nearWrap,
    });
    expect(a.baseTs).toBe(nearWrap);
    const after = rtpAt(a.anchorUsShifted + 500_000n, a.anchorUsShifted, a.baseTs, RATE);
    // 4294966720 + 22050 越过 2^32 → 回绕到小值
    expect(after).toBeLessThan(100_000);
    expect((after - a.baseTs) >>> 0).toBe(Math.round((500000 * RATE) / 1e6)); // 22050
    const before = rtpAt(a.anchorUsShifted - 500_000n, a.anchorUsShifted, a.baseTs, RATE);
    expect(before).toBeGreaterThan(0xFFF00000);
    expect((before - a.baseTs) >>> 0).toBe(2 ** 32 - Math.round((500000 * RATE) / 1e6));
  });

  it("audibleAtUs 与 rtpAt 互逆(±1 帧)", () => {
    const a = computeBridgeAnchors({ anchorUs: A, latencyFrames: LATENCY, rate: RATE });
    for (const idx of [0, 441, 44100, 1000000]) {
      const t = audibleAtUs(idx, a.anchorUsShifted, RATE);
      const ts = rtpAt(t, a.anchorUsShifted, a.baseTs, RATE);
      expect(Math.abs(((ts - a.baseTs) >>> 0) - idx)).toBeLessThanOrEqual(1);
    }
  });

  it("sendAtUs:sendAt = audible − L − 50ms", () => {
    const audible = 10_000_000n;
    const sendAt = sendAtUs(audible, 44100, 44100);
    expect(Number(audible - sendAt)).toBe(1_000_000 + 50_000);
  });
});

describe("bridgeMath:漂移与 lead", () => {
  it("driftCorrection:+10ms 空洞 → 补 441 帧;−10ms 重叠 → 裁 441 帧;阈值内不动", () => {
    expect(driftCorrection(10000, 10000 - 441)).toEqual({ insert: 441, drop: 0, diff: 441 });
    expect(driftCorrection(10000, 10000 + 441)).toEqual({ insert: 0, drop: 441, diff: -441 });
    expect(driftCorrection(10000, 10000 + 400)).toEqual({ insert: 0, drop: 0, diff: -400 });
    expect(driftCorrection(10000, 10000 - 400)).toEqual({ insert: 0, drop: 0, diff: 400 });
  });

  it("bridgeStartLeadUs:无桥 0;任一 cold 4.5s;全部 warm 2.5s", () => {
    expect(bridgeStartLeadUs([])).toBe(0);
    expect(bridgeStartLeadUs([{ warm: false }, { warm: true }])).toBe(4_500_000);
    expect(bridgeStartLeadUs([{ warm: true }, { warm: true }])).toBe(2_500_000);
    expect(bridgeStartLeadUs([{ warm: false }])).toBe(4_500_000);
  });

  it("ntpToRtpMod:2^32−1 边界处 >>>0 得大值(非 & 的 −1),对齐保持", () => {
    // 构造 raw ts = 0xFFFFFFFF 的 ntp:raw = Number(((ntp>>16)*rate)>>16)
    // 反解:ntp = ((0xFFFFFFFF << 16) / rate) << 16(近似即可,验证语义)
    const rate = 44100;
    const rawTs = 4294967295;
    const ntp = ((BigInt(rawTs) << 16n) / BigInt(rate)) << 16n;
    const ts = ntpToRtpMod(ntp, rate, 352);
    // 语义:>>>0 后 −352+... 反正必须 ≤ 0xFFFFFFFF 且 %352==0
    expect(ts).toBeLessThanOrEqual(0xFFFFFFFF);
    expect(ts % 352).toBe(0);
    // 证明 & 0xFFFFFFFF 在此处会得 −1(负余数破坏对齐)——钉死为什么必须 >>>
    expect(rawTs & 0xffffffff).toBe(-1);
    expect(rawTs >>> 0).toBe(4294967295);
  });
});
