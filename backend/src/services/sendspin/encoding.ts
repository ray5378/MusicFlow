// ==================== 音频编解码 (ffmpeg 持续进程) ====================
//
// decoder: 任意输入 → F32/48k 立体声(PCM interleaved)。encoder: F32/48k → codec。
// 两者均基于单一持续 ffmpeg 子进程。编码器保持「单条连续流」输出(Ogg/FLAC 连续可拼接),
// 解码端把收到的顺序块合并成一条流解码,故块边界无需自含头。
//
// 标准 Sendspin codec: opus(ogg 容器) / flac(裸) / pcm(裸 s16le)。

import { spawn, ChildProcessWithoutNullStreams } from "node:child_process";

export type SendspinCodec = "opus" | "flac" | "pcm";
export const SAMPLE_RATE = 48000;
export const CHANNELS = 2;

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

/**
 * 持续编码器:写 F32 PCM → 累加该批 stdout 字节并返回。返回块按序拼接即单条连续流。
 */
export class FfmpegPcmEncoder {
  private p: ChildProcessWithoutNullStreams;
  private buf = Buffer.alloc(0);
  private waiters: ((chunk: Uint8Array) => void)[] = [];

  constructor(codec: SendspinCodec, bitrateKbps = 320) {
    const c = encodeCodecParams(codec);
    const args = [
      "-hide_banner", "-loglevel", "error",
      "-ar", String(SAMPLE_RATE), "-ac", String(CHANNELS), "-f", "f32le", "-i", "pipe:0",
      "-c:a", c.codecName,
      "-f", c.format, "pipe:1",
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
    if (this.waiters.length === 0 || this.buf.length === 0) return;
    const chunk = new Uint8Array(this.buf);
    this.buf = Buffer.alloc(0);
    const ws = this.waiters.splice(0);
    ws.forEach((w) => w(chunk));
  }

  /** 写入一批音频,返回该批尽量对应的编码字节(可能为空)。 */
  encode(pcmF32: Float32Array): Promise<Uint8Array> {
    this.p.stdin.write(f32ToBytes(pcmF32));
    return new Promise((resolve) => {
      this.waiters.push(resolve);
      // 若进程已退出且还有旧数据,立即结算
      setImmediate(() => this.settleAll());
    });
  }

  /** 冲刷剩余字节后关闭。 */
  flushClose(): Promise<Uint8Array> {
    return new Promise((resolve) => {
      this.p.stdin.end();
      const ws = this.waiters.splice(0);
      const flushOne = () => {
        if (this.buf.length) {
          const c = new Uint8Array(this.buf);
          this.buf = Buffer.alloc(0);
          resolve(c);
        } else {
          setImmediate(flushOne);
        }
      };
      flushOne();
    });
  }

  private finish(): void {}

  close(): void {
    this.finish();
    try {
      this.p.stdin.end();
      this.p.kill();
    } catch {
      /* ignore */
    }
  }
}