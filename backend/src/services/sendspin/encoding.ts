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

/** encode() 在有界时间内收不到 ffmpeg 输出时的结算窗口(ms),防止实时推流无限挂起。 */
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
export class FfmpegPcmEncoder {
  private p: ChildProcessWithoutNullStreams | null;
  private buf = Buffer.alloc(0);
  private waiters: ((chunk: Uint8Array) => void)[] = [];
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
    const chunk = new Uint8Array(this.buf);
    this.buf = Buffer.alloc(0);
    const ws = this.waiters.splice(0);
    ws.forEach((w) => w(chunk));
  }

  /** 写入一批音频,返回该批尽量对应的编码字节(可能为空;pcm 为即时 s16le)。 */
  encode(pcmF32: Float32Array): Promise<Uint8Array> {
    if (!this.p) return Promise.resolve(f32ToS16(pcmF32));
    this.p.stdin.write(f32ToBytes(pcmF32));
    return new Promise((resolve) => {
      this.waiters.push(resolve);
      setImmediate(() => this.settleAll());
      // 兜底:ffmpeg pipe 输出只在 EOF 时 flush,带窗口避免实时推流无限阻塞。
      if (!this.timer) this.timer = setTimeout(() => this.settleAll(), ENCODE_FLUSH_MS);
    });
  }

  /** 冲刷剩余字节后关闭:ffmpeg 在此刻 flush,try 尽吐完整编码流。 */
  flushClose(): Promise<Uint8Array> {
    const p = this.p;
    if (!p) return Promise.resolve(new Uint8Array(0));
    return new Promise((resolve) => {
      p.stdin.end();
      if (this.timer) {
        clearTimeout(this.timer);
        this.timer = null;
      }
      const ws = this.waiters.splice(0);
      const flushOne = () => {
        if (this.buf.length > 0) {
          const c = new Uint8Array(this.buf);
          this.buf = Buffer.alloc(0);
          ws.forEach((w) => w(c));
          resolve(c);
        } else if (p.exitCode !== null && p.exitCode !== undefined) {
          resolve(new Uint8Array(0));
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