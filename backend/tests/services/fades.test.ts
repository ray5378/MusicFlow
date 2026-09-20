/**
 * P3-7（核心部分）：Smart Fades L0 的纯函数层。
 *
 * 被锁的四条都是"错了也不报错、只是听感坏掉"的性质，所以必须逐条断言：
 *   ① **帧对齐**（P3-8）：跨半帧混合 ⇒ 声场左右错位 / 编码器整段静默；
 *   ② **权重曲线连续**（P3-2）：起点必须是"全 outgoing"、终点必须是"全 incoming"，
 *      中间单调无跳变 —— 跳变就是可听的爆音；
 *   ③ **静音剥离**（P3-3）：曲尾静音不得进入过渡窗口；
 *   ④ **增益不跳变**（P3-4）：过渡窗口内两首歌各自的增益恒定（本文件用"逐侧增益 +
 *      混合"的等价模型断言包络连续），会话级的"af 只解析一次"在 flow.test.ts 里锁。
 */
import { describe, it, expect } from "vitest";
import {
  DEFAULT_FADE_CONFIG,
  F32_BYTES_PER_SAMPLE,
  FADE_DEFAULT_SEC,
  FADE_MIN_SEC,
  alignToFrame,
  crossfadeFrames,
  crossfadeSamples,
  dbToLinear,
  effectiveFadeFrames,
  fadeWeights,
  fadeWeightCurve,
  frameBytesOf,
  mixCrossfade,
  normalizeFadeConfig,
  trailingSilenceFrames,
} from "../../src/services/audio/fades.js";

describe("P3-8 帧对齐（bytes // frame_size * frame_size）", () => {
  it("按帧取整：不足一帧的尾巴被丢掉", () => {
    expect(alignToFrame(100, 8)).toBe(96);
    expect(alignToFrame(8, 8)).toBe(8);
    expect(alignToFrame(7, 8)).toBe(0);
  });

  it("非法/非正入参一律 0（宁可不成过渡，也不产生半帧）", () => {
    for (const [b, f] of [[0, 8], [-8, 8], [NaN, 8], [100, 0], [100, -1], [Infinity, 8]] as const) {
      expect(alignToFrame(b, f)).toBe(0);
    }
  });

  it("f32 立体声一帧 = 8 字节；单声道 = 4 字节", () => {
    expect(frameBytesOf(2)).toBe(2 * F32_BYTES_PER_SAMPLE);
    expect(frameBytesOf(1)).toBe(F32_BYTES_PER_SAMPLE);
    expect(frameBytesOf(0)).toBe(F32_BYTES_PER_SAMPLE); // 非法声道数按 1 处理
  });

  it("过渡窗口的采样数恒为声道数的整数倍（帧对齐的可断言形式）", () => {
    for (const ch of [1, 2, 6]) {
      const samples = crossfadeSamples(8, 48000, ch);
      expect(samples % ch).toBe(0);
      expect(samples).toBe(crossfadeFrames(8, 48000) * ch);
    }
    // 8s @48k 立体声 = 384000 帧 = 768000 采样
    expect(crossfadeSamples(8, 48000, 2)).toBe(768000);
  });

  it("时长为 0 / 非法 → 窗口 0", () => {
    expect(crossfadeFrames(0, 48000)).toBe(0);
    expect(crossfadeSamples(8, 0, 2)).toBe(0);
  });
});

describe("P3-2 权重曲线（连续、起止点正确）", () => {
  it("起止点：t=0 全 outgoing，t=1 全 incoming", () => {
    for (const curve of ["equal_power", "linear"] as const) {
      expect(fadeWeights(0, curve)).toEqual({ out: 1, in: 0 });
      const end = fadeWeights(1, curve);
      expect(end.out).toBeCloseTo(0, 10);
      expect(end.in).toBeCloseTo(1, 10);
    }
  });

  it("等功率：w_out² + w_in² ≡ 1（两首不相关时的功率守恒）", () => {
    for (let i = 0; i <= 100; i++) {
      const w = fadeWeights(i / 100, "equal_power");
      expect(w.out * w.out + w.in * w.in).toBeCloseTo(1, 6);
    }
  });

  it("线性：w_out + w_in ≡ 1", () => {
    for (let i = 0; i <= 100; i++) {
      const w = fadeWeights(i / 100, "linear");
      expect(w.out + w.in).toBeCloseTo(1, 10);
    }
  });

  it("越界 t 被夹住（浮点误差不该造出负增益）", () => {
    expect(fadeWeights(-5, "linear").out).toBe(1);
    expect(fadeWeights(5, "linear").in).toBe(1);
    expect(fadeWeights(NaN, "equal_power")).toEqual({ out: 1, in: 0 });
  });

  it("逐帧序列单调下降且无跳变（out 权重 1 → 0）", () => {
    const frames = 4800; // 0.1s @48k
    const curve = fadeWeightCurve(frames, "equal_power");
    expect(curve.length).toBe(frames);
    expect(curve[0]).toBeCloseTo(1, 6); // 起点全 outgoing
    expect(curve[frames - 1]).toBeCloseTo(0, 6); // 终点全 incoming
    let maxStep = 0;
    for (let i = 1; i < frames; i++) {
      const step = curve[i] - curve[i - 1];
      expect(step).toBeLessThanOrEqual(1e-7); // 单调不增
      maxStep = Math.max(maxStep, -step);
    }
    // out 权重是 cos(π/2·t)：最陡处（窗口中点）斜率 = π/2 ⇒ 每帧步进 ≈ (π/2)/4800
    expect(maxStep).toBeLessThan((Math.PI / 2) / (frames - 1) + 1e-6);
    // 但也不该"一步到底"（那才叫跳变）
    expect(maxStep).toBeGreaterThan(0.5 / frames);
  });

  it("frames ≤ 1 退化：单帧 = 全 incoming（out 权重为 0）", () => {
    expect([...fadeWeightCurve(0)]).toEqual([]);
    expect([...fadeWeightCurve(1)]).toEqual([0]);
  });
});

describe("P3-3 静音剥离", () => {
  it("尾部无静音 → 0", () => {
    const pcm = new Float32Array([0.5, -0.5, 0.4, 0.4]);
    expect(trailingSilenceFrames(pcm, 2, -60)).toBe(0);
  });

  it("尾部静音按帧计（任一声道有声即不算静音）", () => {
    // 4 帧立体声：前 2 帧有声，后 2 帧静音
    const pcm = new Float32Array([0.5, 0.5, -0.3, 0.2, 0, 0, 0, 0]);
    expect(trailingSilenceFrames(pcm, 2, -60)).toBe(2);
    // 第 3 帧只有右声道有极轻的声音 → 只有最后 1 帧算静音
    const pcm2 = new Float32Array([0.5, 0.5, -0.3, 0.2, 0, 0.01, 0, 0]);
    expect(trailingSilenceFrames(pcm2, 2, -60)).toBe(1);
  });

  it("整段静音 → 返回总帧数；阈值 null → 不剥离", () => {
    const pcm = new Float32Array(8);
    expect(trailingSilenceFrames(pcm, 2, -60)).toBe(4);
    expect(trailingSilenceFrames(pcm, 2, null)).toBe(0);
  });

  it("阈值按线性幅度比较（-60dBFS ≈ 0.001）", () => {
    expect(dbToLinear(-60)).toBeCloseTo(0.001, 4);
    const pcm = new Float32Array([0.0005, 0.0005]); // 低于阈值 → 静音
    expect(trailingSilenceFrames(pcm, 2, -60)).toBe(1);
    const loud = new Float32Array([0.002, 0.002]); // 高于阈值 → 有声
    expect(trailingSilenceFrames(loud, 2, -60)).toBe(0);
  });

  it("有效窗口 = min(配置, 可用) − 静音，且不会为负", () => {
    expect(effectiveFadeFrames({ wantFrames: 384000, outgoingFrames: 400000, incomingFrames: 400000, silenceFrames: 0 })).toBe(384000);
    expect(effectiveFadeFrames({ wantFrames: 384000, outgoingFrames: 100000, silenceFrames: 0 })).toBe(100000);
    expect(effectiveFadeFrames({ wantFrames: 384000, outgoingFrames: 400000, incomingFrames: 50000, silenceFrames: 0 })).toBe(50000);
    // 静音占比不能超过窗口 → 宁可不混，也不要淡一段静音
    expect(effectiveFadeFrames({ wantFrames: 384000, outgoingFrames: 400000, incomingFrames: 400000, silenceFrames: 396000 })).toBe(4000);
    expect(effectiveFadeFrames({ wantFrames: 384000, outgoingFrames: 1000, silenceFrames: 5000 })).toBe(0);
  });
});

describe("P3-2 混合（逐帧加权，两侧增益恒定 ⇒ 不跳变）", () => {
  it("长度为 0 之外的相等长度才允许（不等长直接抛错，不静默截断）", () => {
    const a = new Float32Array(8);
    const b = new Float32Array(4);
    expect(() => mixCrossfade(a, b, { channels: 2 })).toThrow(/长度不等/);
  });

  it("未帧对齐直接抛错（P3-8 的守门人）", () => {
    const a = new Float32Array(5); // 5 个采样在 2 声道下是 2.5 帧
    const b = new Float32Array(5);
    expect(() => mixCrossfade(a, b, { channels: 2 })).toThrow(/未帧对齐/);
    // 6 采样 = 整 3 帧 → 允许
    expect(() => mixCrossfade(new Float32Array(6), new Float32Array(6), { channels: 2 })).not.toThrow();
  });

  it("端点精确：首帧 = 纯 outgoing，末帧 = 纯 incoming", () => {
    const outg = new Float32Array([0.8, -0.8, 0.8, -0.8]);
    const inc = new Float32Array([0.2, -0.2, 0.2, -0.2]);
    const mixed = mixCrossfade(outg, inc, { channels: 2 });
    expect(mixed[0]).toBeCloseTo(0.8, 6);
    expect(mixed[mixed.length - 2]).toBeCloseTo(0.2, 6);
  });

  it("线性曲线中点 = 两侧均值（帧数取奇，中点才落在采样点上）", () => {
    const frames = 65; // t = i/(n-1)：n 为奇数时 i=(n-1)/2 正好是 t=0.5
    const outg = new Float32Array(frames * 2).fill(1);
    const inc = new Float32Array(frames * 2).fill(0);
    const mixed = mixCrossfade(outg, inc, { channels: 2, curve: "linear" });
    expect(mixed[32 * 2]).toBeCloseTo(0.5, 6);
  });

  it("等功率下两侧都非零时峰值不超过各侧峰值之和的功率上界（不削顶）", () => {
    const n = 4800 * 2;
    const outg = new Float32Array(n);
    const inc = new Float32Array(n);
    for (let i = 0; i < n; i++) { outg[i] = 0.5; inc[i] = 0.5; }
    const mixed = mixCrossfade(outg, inc, { channels: 2 });
    // 等功率：0.5·(cos+sin) ≤ 0.5·√2 ≈ 0.707
    for (let i = 0; i < n; i++) expect(Math.abs(mixed[i])).toBeLessThanOrEqual(0.7072);
  });

  it("两侧各自的静态增益在窗口内恒定 ⇒ 输出包络 = 权重曲线（无增益台阶）", () => {
    // 模拟两首歌各自已应用过响度增益（A: ×2 = +6dB，B: ×0.5 = −6dB），
    // 混合后包络应当只随权重变化；若谁在窗口中间"重新解析"了增益，这里会出现台阶
    // （单帧跃变远大于权重曲线自身的最大斜率）。
    const frames = 480;
    const gainA = 2, gainB = 0.5;
    const n = frames * 2;
    const outg = new Float32Array(n).fill(gainA);
    const inc = new Float32Array(n).fill(gainB);
    const mixed = mixCrossfade(outg, inc, { channels: 2 });
    // 逐帧与权重公式严格一致（混合算法 = 两侧各自恒定增益 × 权重）
    for (let f = 0; f < frames; f++) {
      const w = fadeWeights(f / (frames - 1), "equal_power");
      expect(mixed[f * 2]).toBeCloseTo(gainA * w.out + gainB * w.in, 6);
    }
    expect(mixed[0]).toBeCloseTo(gainA, 6); // 起点纯 A
    expect(mixed[(frames - 1) * 2]).toBeCloseTo(gainB, 6); // 终点纯 B
    // 包络单调下降（A 比 B 响）；单帧步进上界 = 等功率曲线自身的最陡斜率 / 帧距。
    // 包络 e(t) = gA·cos(πt/2) + gB·sin(πt/2)，|e'| 峰值 = (π/2)·max(gA,gB)（落在 t=1，
    // 即"响的那首正在淡出"的末端），所以上界按 max(gA,gB) 取，不能按差值取。
    let maxStep = 0;
    for (let f = 1; f < frames; f++) maxStep = Math.max(maxStep, mixed[(f - 1) * 2] - mixed[f * 2]);
    expect(maxStep).toBeGreaterThan(0);
    expect(maxStep).toBeLessThan(((Math.PI / 2) * Math.max(gainA, gainB)) / (frames - 1) + 1e-6);
    // 若中途"重解析"增益，跃变至少是差值量级 ⇒ 远大于上面的上界，断言抓得住
    expect(maxStep).toBeLessThan((gainA - gainB) / 50);
  });

  it("不改入参（上曲尾段还要被别处复用）", () => {
    const outg = new Float32Array([1, 1, 1, 1]);
    const inc = new Float32Array([0, 0, 0, 0]);
    const snapshot = [...outg];
    mixCrossfade(outg, inc, { channels: 2 });
    expect([...outg]).toEqual(snapshot);
    expect([...inc]).toEqual([0, 0, 0, 0]);
  });
});

describe("配置归一化", () => {
  it("缺省 = 8s / 等功率 / -60dBFS", () => {
    expect(normalizeFadeConfig(null)).toEqual(DEFAULT_FADE_CONFIG);
    expect(DEFAULT_FADE_CONFIG.durationSec).toBe(FADE_DEFAULT_SEC);
  });

  it("时长夹到下限 3s（D7 对齐 MA），取整秒", () => {
    expect(normalizeFadeConfig({ durationSec: 1 }).durationSec).toBe(FADE_MIN_SEC);
    expect(normalizeFadeConfig({ durationSec: 7.6 }).durationSec).toBe(8);
    expect(normalizeFadeConfig({ durationSec: NaN }).durationSec).toBe(FADE_DEFAULT_SEC);
  });

  it("曲线只认两个值；阈值可用 null 显式关闭剥离，非法值回退默认", () => {
    expect(normalizeFadeConfig({ curve: "linear" }).curve).toBe("linear");
    expect(normalizeFadeConfig({ curve: "smart" as any }).curve).toBe("equal_power");
    expect(normalizeFadeConfig({ silenceThresholdDb: null }).silenceThresholdDb).toBeNull();
    expect(normalizeFadeConfig({ silenceThresholdDb: NaN }).silenceThresholdDb).toBe(-60);
    expect(normalizeFadeConfig({ silenceThresholdDb: -45 }).silenceThresholdDb).toBe(-45);
  });
});
