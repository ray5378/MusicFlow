/** 147/160 多相 FIR 重采样器(AirPlay 桥接 Phase 1)。
 *
 *  用途:sendspin 组泵出 48k PCM,AP1 接收端强制 44.1k(D1a);有理比 48000/44100
 *  = 160/147,经典多相结构,系数按输出相位预表(160 相 × 33 抽头)。
 *
 *  内容时间映射(⚠️ 符号方向,MIN-01):输出第 n 个样本代表输入流时刻
 *  `(n − GROUP_DELAY)·160/147` 输入样本 —— 即输出流比内容时间**晚** 16/44100 s
 *  ≈ 0.3627ms:脉冲打在输入第 0 帧,输出峰落在第 16 个输出样本。桥接把首输出样本
 *  盖在锚点 A 上 ⇒ 内容实际出声点 = A + 0.3627ms,由 bridgeMath 把锚点后移同值补偿。
 *
 *  帧数契约(可整除验证):totalOut 恒等于 `ceil(totalIn·147/160)`,纯整数累进,
 *  任意时刻零累计误差(测试钉住)。
 *
 *  末尾 0.3627ms 的群延迟尾巴在流结束即丢弃(-song 末尾不足 0.4ms,不可闻);
 *  连续流跨块无损失。 */

import { RESAMPLE_L, RESAMPLE_M } from "./rates.js";

/** 抽头数(奇数);群延迟 = (TAPS−1)/2 = 16 输出样本。 */
export const RESAMPLE_TAPS = 33;
/** 群延迟(输出样本)。 */
export const RESAMPLE_GROUP_DELAY_OUT = (RESAMPLE_TAPS - 1) / 2;

/** Kaiser 窗 β(旁瓣 ≈ −63dB;过渡带 ≈ ±2.9kHz ⇒ 15k 全通、23k ≥60dB 抑制)。 */
const KAISER_BETA = 6.0;
/** 原型低通截止(Hz,输入域)。取 19k:pass 边沿 16.1k(15k 测试点留余量),
 *  stop 边沿 21.9k(23k 测试点 ≥40dB 要求留足)。 */
const CUTOFF_HZ = 19_000;

function besselI0(x: number): number {
  let sum = 1;
  let term = 1;
  for (let k = 1; k < 64; k++) {
    term *= ((x / 2) / k) ** 2;
    sum += term;
    if (term < 1e-18 * sum) break;
  }
  return sum;
}

function sinc(x: number): number {
  if (x === 0) return 1;
  const px = Math.PI * x;
  return Math.sin(px) / px;
}

/** 连续核:h(u) = fc_norm·sinc(fc_norm·u)·kaiser(u/half),u 单位 = 输入样本。 */
function kernel(u: number, fcNorm: number, half: number): number {
  if (Math.abs(u) >= half) return 0;
  const t = u / half;
  const w = besselI0(KAISER_BETA * Math.sqrt(1 - t * t)) / besselI0(KAISER_BETA);
  return fcNorm * sinc(fcNorm * u) * w;
}

export class PolyphaseResampler {
  readonly inRate: number;
  readonly outRate: number;
  readonly channels: number;
  readonly L: number; // 上采样因子(147)
  readonly M: number; // 下采样因子(160)

  /** phases[p][j]:输出相位 p(0..M−1,即 f = p/M)下,对输入 hist[c+j] 的系数。 */
  private readonly phases: Float64Array[];
  private readonly half: number;

  /** 每声道输入历史(hist[0] 的绝对帧号 = histBase)。 */
  private readonly hist: Float64Array[] = [];
  private histBase = 0;
  private histLen = 0;

  private totalInFrames = 0;
  private totalOutFrames = 0;

  constructor(inRate: number, outRate: number, channels = 2) {
    if (inRate <= 0 || outRate <= 0) throw new Error("invalid rates");
    const g = gcd(inRate, outRate);
    this.inRate = inRate;
    this.outRate = outRate;
    this.channels = channels;
    this.L = outRate / g;
    this.M = inRate / g;
    this.half = RESAMPLE_GROUP_DELAY_OUT + 0.5;

    // 归一化截止(输入奈奎斯特域):cutoff / (inRate/2)。
    const fcNorm = CUTOFF_HZ / (inRate / 2);
    this.phases = [];
    for (let p = 0; p < this.M; p++) {
      const f = p / this.M;
      const row = new Float64Array(RESAMPLE_TAPS);
      for (let j = 0; j < RESAMPLE_TAPS; j++) {
        // y[n] = Σ_j x[c+j]·h(f − (j−GROUP_DELAY))
        row[j] = kernel(f - (j - RESAMPLE_GROUP_DELAY_OUT), fcNorm, this.half);
      }
      this.phases.push(row);
    }
    for (let ch = 0; ch < channels; ch++) this.hist.push(new Float64Array(0));
  }

  /** 群延迟(输出样本)。 */
  get groupDelayOut(): number {
    return RESAMPLE_GROUP_DELAY_OUT;
  }

  get totalIn(): number {
    return this.totalInFrames;
  }

  get totalOut(): number {
    return this.totalOutFrames;
  }

  /** 推入交错的 PCM 帧,返回全部可得的交错输出(Float32,与输入同声道布局)。
   *  输出帧数恒 = ceil((totalIn 累计)·L/M) − (此前已产出),纯整数零漂移。 */
  process(input: Float32Array): Float32Array {
    const ch = this.channels;
    const frames = Math.floor(input.length / ch);
    if (frames * ch !== input.length) throw new Error("interleaved input length not a multiple of channels");
    this.append(input, frames);

    // 本轮可产出:n 满足 floor(n·M/L) ≤ totalIn−1(数据可得性 ⇒ 右窗口边
    // c(n)+GD ≤ floor(n·M/L) 恒成立,证明见文件头注释推导)。
    const outFrames = Math.max(0, Math.ceil((this.totalInFrames * this.L) / this.M) - this.totalOutFrames);
    const out = new Float32Array(outFrames * ch);
    let outPos = 0;

    for (let k = 0; k < outFrames; k++) {
      const n = this.totalOutFrames + k;
      const num = (n - RESAMPLE_GROUP_DELAY_OUT) * this.M; // 可为负(n < GD 的预热段)
      const c = Math.floor(num / this.L);                  // 中心输入帧(可 <0 ⇒ 左补零)
      const p = ((num % this.L) + this.L) % this.L;        // 正剩余(相位)
      const coeffs = this.phases[p];
      // 数据窗口:x[c−GD .. c+GD](权重 H[j] = kernel(f+GD−j) 配 x[c−GD+j],
      // 中心 j=GD 配 x[c] —— f=0 时 y[n]=x(c),脉冲峰验证见 resampler.test.ts)。
      const off = c - RESAMPLE_GROUP_DELAY_OUT - this.histBase;
      for (let channel = 0; channel < ch; channel++) {
        const h = this.hist[channel];
        let acc = 0;
        for (let j = 0; j < RESAMPLE_TAPS; j++) {
          const idx = off + j;
          const s = idx >= 0 && idx < this.histLen ? h[idx] : 0;
          acc += s * coeffs[j];
        }
        out[outPos++] = acc;
      }
    }
    this.totalOutFrames += outFrames;

    // 裁剪历史:下一输出 n 的左窗沿 = c(next) − GD;保留到该处即可。
    const nextNum = (this.totalOutFrames - RESAMPLE_GROUP_DELAY_OUT) * this.M;
    const nextC = Math.floor(nextNum / this.L);
    const keepFrom = Math.min(nextC - RESAMPLE_GROUP_DELAY_OUT, this.totalInFrames);
    this.trim(keepFrom);
    return out;
  }

  private append(input: Float32Array, frames: number): void {
    const ch = this.channels;
    for (let channel = 0; channel < ch; channel++) {
      const old = this.hist[channel];
      const merged = new Float64Array(this.histLen + frames);
      merged.set(old.subarray(0, this.histLen), 0);
      for (let i = 0; i < frames; i++) merged[this.histLen + i] = input[i * ch + channel];
      this.hist[channel] = merged;
    }
    this.histLen += frames;
    this.totalInFrames += frames;
  }

  private trim(fromAbs: number): void {
    const drop = Math.min(Math.max(0, fromAbs - this.histBase), this.histLen - (RESAMPLE_TAPS - 1));
    if (drop <= 0) return;
    const ch = this.channels;
    for (let channel = 0; channel < ch; channel++) {
      this.hist[channel] = this.hist[channel].slice(drop);
    }
    this.histBase += drop;
    this.histLen -= drop;
  }
}

// ---------------------------------------------------------------------------
// S16 互换(桥帧/RAOP 负载都是 S16LE;重采样核在 Float32 域做)
// ---------------------------------------------------------------------------

export function pcmS16ToFloat(input: Int16Array): Float32Array {
  const out = new Float32Array(input.length);
  for (let i = 0; i < input.length; i++) out[i] = input[i] / 32768;
  return out;
}

export function floatToPcmS16(input: Float32Array): Int16Array {
  const out = new Int16Array(input.length);
  for (let i = 0; i < input.length; i++) {
    const v = Math.max(-1, Math.min(1, input[i]));
    // 刻度统一 32768(往返误差 ≤0.5 LSB;混用 32767 会引入比例偏差)
    out[i] = Math.max(-32768, Math.min(32767, Math.round(v * 32768)));
  }
  return out;
}

function gcd(a: number, b: number): number {
  while (b !== 0) {
    const t = a % b;
    a = b;
    b = t;
  }
  return a;
}
