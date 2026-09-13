// ==================== 音频编解码 ====================
//
// decoder: 任意输入 → F32/48k 立体声(PCM interleaved),基于 ffmpeg(一次性子进程)。
// encoder: F32/48k → codec。
//   - opus: 进程内 @discordjs/opus 逐 20ms 帧编码,输出「裸 opus 包」(对标 MusicAssistant)。
//     每帧独立成为一个可发送包,无管道缓冲延迟、无定时器兜底。
//   - pcm:  纯 JS 内联 F32 → s16le,零延迟,字节即 wire 格式。
//   - flac: 保留单一持续 ffmpeg 子进程(连续流可拼接;full flush 在关闭时一次性吐出)。

import { createRequire } from "node:module";
import { spawn, ChildProcessWithoutNullStreams } from "node:child_process";

// @discordjs/opus 为 CommonJS,不能用 ESM 具名导入,须经 createRequire 取整。
const require = createRequire(import.meta.url);
const { OpusEncoder: DiscordOpusEncoder } = require("@discordjs/opus") as typeof import("@discordjs/opus");

/** 仅声明 OpusEncoder 用到的最小接口(node 原生类,避免类型名冲突)。 */
export interface OpusEncoderLike {
  encode(data: Buffer): Buffer;
  setBitrate(bitrate: number): void;
}

export type SendspinCodec = "opus" | "flac" | "pcm";
export const SAMPLE_RATE = 48000;
export const CHANNELS = 2;

/** 单帧时长(ms)、每帧交错样本数(20ms @48kHz/2ch = 1920)。 */
export const OPUS_FRAME_MS = 20;
export const OPUS_FRAME_SAMPLES = (SAMPLE_RATE * CHANNELS * OPUS_FRAME_MS) / 1000;

/** 统一 chunk 编码器接口:encode() 返回 0..N 个独立可发送包(裸包/帧)。 */
export interface ChunkEncoder {
  encode(pcmF32: Float32Array): Promise<Uint8Array[]>;
  flush(): Promise<Uint8Array[]>;
  close(): void;
}

export function encodeCodecParams(codec: SendspinCodec): { format: string; codecName: string } {
  if (codec === "opus") return { format: "ogg", codecName: "libopus" };
  if (codec === "flac") return { format: "flac", codecName: "flac" };
  return { format: "s16le", codecName: "pcm_s16le" };
}

/** F32 立体声 interleaved → raw bytes (f32le)。 */
export function f32ToBytes(f32: Float32Array): Buffer {
  const buf = Buffer.allocUnsafe(f32.length * 4);
  for (let i = 0; i < f32.length; i++) buf.writeFloatLE(f32[i], i * 4);
  return buf;
}

/** F32 立体声 interleaved ← raw bytes (f32le)。 */
export function bytesToF32(buf: Uint8Array): Float32Array {
  const out = new Float32Array(Math.floor(buf.length / 4));
  for (let i = 0; i < out.length; i++) out[i] = Buffer.from(buf).readFloatLE(i * 4);
  return out;
}

async function ffmpegToF32(input: Uint8Array, args: string[], sampleRate: number): Promise<Float32Array> {
  const full = [
    "-hide_banner", "-loglevel", "error",
    "-i", "pipe:0",
    "-ar", String(sampleRate), "-ac", String(CHANNELS), "-f", "f32le", "pipe:1",
  ];
  return pipeThroughFfmpeg(params(full, args), input);
}

function params(a1: string[], a2?: string[]): string[] {
  return a1.concat(a2 ?? []);
}

function pipeThroughFfmpeg(args: string[], input: Uint8Array): Promise<Float32Array> {
  return new Promise((resolve, reject) => {
    const p = spawn("ffmpeg", args, { stdio: ["pipe", "pipe", "pipe"] });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    p.stdout.on("data", (d: Buffer) => out.push(d));
    p.stderr.on("data", (d: Buffer) => err.push(d));
    p.on("error", reject);
    p.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(`ffmpeg decode failed (${code}): ${Buffer.concat(err).toString().slice(0, 300)}`));
        return;
      }
      resolve(bytesToF32(Buffer.concat(out)));
    });
    p.stdin.end(Buffer.from(input));
  });
}

/** 解码任意编码输入为 F32/48k 立体声。 */
export async function decodeToF32(input: Uint8Array, sampleRate = SAMPLE_RATE): Promise<Float32Array> {
  return ffmpegToF32(input, [], sampleRate);
}

/** F32 立体声 interleaved → s16le 小端 PCM(实时路径,零延迟,无 ffmpeg)。 */
export function f32ToS16(f32: Float32Array): Uint8Array {
  const out = new Uint8Array(f32.length * 2);
  const dv = new DataView(out.buffer);
  for (let i = 0; i < f32.length; i++) {
    const v = Math.max(-1, Math.min(1, f32[i]));
    dv.setInt16(i * 2, Math.round(v * 32767), true);
  }
  return out;
}

function concatF32(a: Float32Array, b: Float32Array): Float32Array {
  if (a.length === 0) return b;
  if (b.length === 0) return a;
  const out = new Float32Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

/**
 * 进程内裸 opus 编码器:F32/48k 立体声 interleaved → 裸 opus 包(20ms/帧)。
 * 自带 20ms 帧缓冲:encode() 消费整数帧,残余留在缓冲;flush() 补零产尾帧。
 * 逐帧同步编码、无 ffmpeg 管道缓冲、无定时器 —— 对标 MA 每帧一次性的 psg 推送。
 */
export class OpusEncoder implements ChunkEncoder {
  private enc: OpusEncoderLike;
  private buf = new Float32Array(0) as Float32Array<ArrayBufferLike>;
  private readonly frameLen = OPUS_FRAME_SAMPLES;

  constructor(bitrateKbps = 320) {
    this.enc = new DiscordOpusEncoder(SAMPLE_RATE, CHANNELS);
    this.enc.setBitrate(bitrateKbps * 1000);
  }

  encode(pcmF32: Float32Array): Promise<Uint8Array[]> {
    const out: Uint8Array[] = [];
    const merged = concatF32(this.buf, pcmF32);
    const avail = Math.floor(merged.length / this.frameLen) * this.frameLen;
    for (let off = 0; off < avail; off += this.frameLen) {
      out.push(this.enc.encode(Buffer.from(f32ToS16(merged.subarray(off, off + this.frameLen)))));
    }
    this.buf = merged.subarray(avail);
    return Promise.resolve(out);
  }

  flush(): Promise<Uint8Array[]> {
    if (this.buf.length === 0) return Promise.resolve([]);
    const padded = new Float32Array(this.frameLen);
    padded.set(this.buf);
    const out = [this.enc.encode(Buffer.from(f32ToS16(padded)))];
    this.buf = new Float32Array(0);
    return Promise.resolve(out);
  }

  close(): void {
    this.buf = new Float32Array(0);
  }
}

/** 纯 JS 内联 PCM(s16le)编码器:零延迟,直接返回样本字面字节。 */
export class PcmEncoder implements ChunkEncoder {
  encode(pcmF32: Float32Array): Promise<Uint8Array[]> {
    return Promise.resolve([f32ToS16(pcmF32)]);
  }
  flush(): Promise<Uint8Array[]> {
    return Promise.resolve([]);
  }
  close(): void {}
}

/** 按 codec 创建 chunk 编码器:opus → 进程内, pcm → 内联, flac → ffmpeg 持续进程。 */
export function createChunkEncoder(codec: SendspinCodec, bitrateKbps = 320): ChunkEncoder {
  if (codec === "opus") return new OpusEncoder(bitrateKbps);
  if (codec === "pcm") return new PcmEncoder();
  return new FfmpegPcmEncoder(codec, bitrateKbps);
}

/** encode() 在有界时间内收不到 ffmpeg 输出时的结算窗口(ms),flac 兜底专用。 */
const ENCODE_FLUSH_MS = 60;

/**
 * 持续编码器:写 F32 PCM → 返回该批尽可能对应的编码字节。返回块按序拼接即单条连续流。
 *
 * 注意 ffmpeg 的 pipe:1 输出只在输入 EOF(flush)时整块吐出 —— 用 `-flush_packets` 亦无法
 * 强制其逐帧提前写出,实测 pcm/opus/flac 在 stdin 结束前均零输出。因此:
 *  - pcm:s16le 为纯 raw,直接在 JS 内 F32→s16le,同步逐帧、零延迟,字节即 wire 格式。
 *  - opus/flac:保留单一持续 ffmpeg 进程以保证 Ogg/FLAC 流连续性;`encode()` 带 60ms
 *    有界兜底,定时把当前缓冲(可能为空)结算返回,避免阻塞推流;完整编码字节在
 *    `flushClose()`(曲终/组关闭)时一次性吐出,接收端按连续流拼接解码。
 */
export class FfmpegPcmEncoder implements ChunkEncoder {
  private p: ChildProcessWithoutNullStreams | null;
  private buf = Buffer.alloc(0);
  private waiters: ((chunk: Uint8Array[]) => void)[] = [];
  private timer: NodeJS.Timeout | null = null;

  constructor(codec: SendspinCodec, bitrateKbps = 320) {
    if (codec === "pcm") {
      this.p = null; // 纯 JS 内联编码,无需 ffmpeg。
      return;
    }
    const c = encodeCodecParams(codec);
    const args: string[] = [
      "-hide_banner", "-loglevel", "error",
      "-ar", String(SAMPLE_RATE), "-ac", String(CHANNELS), "-f", "f32le", "-i", "pipe:0",
      "-c:a", c.codecName,
      "-f", c.format, "pipe:1",
      "-fflags", "+flush_packets", // 最佳努力:尽力让 muxer 每包 flush(实测对 ogg/raw 无效,保留)。
    ];
    if (c.codecName === "libopus") args.push("-b:a", `${bitrateKbps}k`);
    const p = spawn("ffmpeg", args, { stdio: ["pipe", "pipe", "pipe"] });
    this.p = p;
    p.on("error", () => this.settleAll());
    p.on("close", () => this.settleAll());
    p.stdout.on("data", (d: Buffer) => {
      this.buf = Buffer.concat([this.buf, d]);
      this.settleAll();
    });
  }

  private settleAll(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.waiters.length === 0) return;
    // buf 为空也结算:把空的/滞留的 waiters 全部排空,让调用方及时收手而非挂起。
    const chunk = [new Uint8Array(this.buf)];
    this.buf = Buffer.alloc(0);
    const ws = this.waiters.splice(0);
    ws.forEach((w) => w(chunk));
  }

  /** 写入一批音频,返回该批尽量对应的编码包(可能为空数组;pcm 为即时 s16le)。 */
  encode(pcmF32: Float32Array): Promise<Uint8Array[]> {
    if (!this.p) return Promise.resolve([f32ToS16(pcmF32)]);
    this.p.stdin.write(f32ToBytes(pcmF32));
    return new Promise((resolve) => {
      this.waiters.push(resolve);
      setImmediate(() => this.settleAll());
      // 兜底:ffmpeg pipe 输出只在 EOF 时 flush,带窗口避免实时推流无限阻塞(flac 兜底)。
      if (!this.timer) this.timer = setTimeout(() => this.settleAll(), ENCODE_FLUSH_MS);
    });
  }

  /** 冲刷剩余字节后关闭:ffmpeg 在此刻 flush,try 尽吐完整编码流。 */
  flush(): Promise<Uint8Array[]> {
    const p = this.p;
    if (!p) return Promise.resolve([]);
    return new Promise((resolve) => {
      p.stdin.end();
      if (this.timer) {
        clearTimeout(this.timer);
        this.timer = null;
      }
      const ws = this.waiters.splice(0);
      const flushOne = () => {
        if (this.buf.length > 0) {
          const c = [new Uint8Array(this.buf)];
          this.buf = Buffer.alloc(0);
          ws.forEach((w) => w(c));
          resolve(c);
        } else if (p.exitCode !== null && p.exitCode !== undefined) {
          resolve([]);
        } else {
          setImmediate(flushOne);
        }
      };
      flushOne();
    });
  }

  close(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (!this.p) return;
    try {
      this.p.stdin.end();
      this.p.kill();
    } catch {
      /* ignore */
    }
  }
}