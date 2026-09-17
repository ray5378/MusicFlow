// ==================== 音频编解码 ====================
//
// decoder: 任意输入 → F32/48k 立体声(PCM interleaved),基于 ffmpeg(一次性子进程)。
// encoder: F32/48k → codec。
//   - opus: 进程内 @discordjs/opus 逐 20ms 帧编码,输出「裸 opus 包」(对标 MusicAssistant)。
//     每帧独立成为一个可发送包,无管道缓冲延迟、无定时器兜底。
//   - pcm:  纯 JS 内联 F32 → s16le,零延迟,字节即 wire 格式。
//   - flac: 分段 ffmpeg —— ffmpeg flac 只在输入 EOF 时吐出整段,故按 0.5s PCM 分段,
//     每段一个 ffmpeg(自带 fLaC+STREAMINFO),关段即得完整可解码 FLAC 段并下发。
//     这是唯一能让 ESPHome 真机出声的路径(详见 FfmpegPcmEncoder 类注释)。

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

/** ffmpeg 二进制定位:FFMPEG_PATH 环境变量 → ffmpeg-static 内置 → PATH。
 *  与 transcode.ts resolveFfmpeg 同约定。之前此处硬编码 spawn("ffmpeg"),
 *  容器内无系统 ffmpeg 时 ENOENT,导致 sendspin 全曲跳过(DLNA 不转码故正常)。 */
export function ffmpegBin(): string {
  if (process.env.FFMPEG_PATH) return process.env.FFMPEG_PATH;
  try {
    const p = require("ffmpeg-static") as string | undefined;
    if (p) return p;
  } catch {
    /* 未安装 → 回退 PATH */
  }
  return "ffmpeg";
}

/** 统一 chunk 编码器接口:encode() 返回 0..N 个独立可发送包(裸包/帧)。
 *  `offsetMs` = 该包首样本相对于本次 encode() 入参起点的时间偏移(ms):
 *  逐帧编码器(opus/pcm)恒为 0;分段 FLAC 为负值(该段起始早于当前帧 —— 段已累积了
 *  前面若干帧),调用方据此校正时间戳,否则整段音频会被错标到当前帧时刻、同步漂移。 */
export interface EncodedChunk {
  data: Uint8Array;
  offsetMs: number;
}
export interface ChunkEncoder {
  encode(pcmF32: Float32Array): Promise<EncodedChunk[]>;
  flush(): Promise<EncodedChunk[]>;
  close(): void;
}

export function encodeCodecParams(codec: SendspinCodec): { format: string; codecName: string } {
  if (codec === "opus") return { format: "ogg", codecName: "libopus" };
  if (codec === "flac") return { format: "flac", codecName: "flac" };
  return { format: "s16le", codecName: "pcm_s16le" };
}

/** FLAC stream/start 用 codec_header:base64("fLaC"+0x80+u24(34)+STREAMINFO)。
 *  约定对标 aiosendspin reference(FlacEncoder.get_header:extradata 前加 fLaC 块头)。
 *  管线恒定 48kHz/立体声/16bit,STREAMINFO 定值合成(MD5/帧长/总数填 0,流式编码惯例):
 *  严格客户端(sendspin-cpp)无此头直接拒收整个 stream/start,之后每块音频全灭
 *  (2026-09-17 ESPHome 真机:"FLAC requires codec_header")。opus/pcm 自描述,不需要。 */
export function flacCodecHeaderB64(
  sampleRate = SAMPLE_RATE,
  channels = CHANNELS,
  bitDepth = 16,
): string {
  const info = Buffer.alloc(34, 0);
  // ⚠️ block size 必须与**实际流内帧**一致:ffmpeg flac 在 48kHz 下用 4096
  // (实测 STREAMINFO = 0x1000/0x1000)。此前写 4608 是错的 —— 严格解码器
  // 按 STREAMINFO 校验每个 frame header 的 blocksize,不匹配即整帧作废:
  // 设备日志停在 `Created ring buffer with size 19200`(解码环形区建好)
  // 而 `speaker_mixer Starting`/`i2s_audio.speaker Starting` 永不出现 → 无声
  // (2026-09-17 ESPHome 真机,对照 MA 金标准同一位置有 speaker 启动)。
  // v2.3.32 起的注释「与 ffmpeg 实际一致」是错的,勿再回退。
  info.writeUInt16BE(4096, 0); // min block size = ffmpeg 实际帧块大小
  info.writeUInt16BE(4096, 2); // max block size
  // min/max frame size(3+3B)与 total samples 填 0:流式未知,解码器接受。
  const pack =
    (BigInt(sampleRate) << 44n) |
    (BigInt(channels - 1) << 41n) |
    (BigInt(bitDepth - 1) << 36n);
  for (let i = 0; i < 8; i++) info[10 + i] = Number((pack >> BigInt(8 * (7 - i))) & 0xffn);
  // MD5(16B)全 0。
  const header = Buffer.concat([Buffer.from("fLaC", "ascii"), Buffer.from([0x80]), (() => {
    const len = Buffer.alloc(3);
    len.writeUIntBE(info.length, 0, 3);
    return len;
  })(), info]);
  return header.toString("base64");
}

/** F32 立体声 interleaved → raw bytes (f32le)。 */
export function f32ToBytes(f32: Float32Array): Buffer {
  const buf = Buffer.allocUnsafe(f32.length * 4);
  for (let i = 0; i < f32.length; i++) buf.writeFloatLE(f32[i], i * 4);
  return buf;
}

/** F32 立体声 interleaved ← raw bytes (f32le)。 */
export function bytesToF32(buf: Uint8Array): Float32Array {
  // 关键:用 DataView 直接读写同一块 backing 内存,逐样本零拷贝。
  // 每个样本都用 Buffer.from(buf) 会复制整个缓冲 → 288k 次 × 缓冲大小
  // (≈331GB 拷贝,实测约 29s),是解码链路最大的非必要拖慢源。
  const out = new Float32Array(Math.floor(buf.length / 4));
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  for (let i = 0; i < out.length; i++) out[i] = view.getFloat32(i * 4, true);
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
    const p = spawn(ffmpegBin(), args, { stdio: ["pipe", "pipe", "pipe"] });
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

  encode(pcmF32: Float32Array): Promise<EncodedChunk[]> {
    const out: EncodedChunk[] = [];
    const merged = concatF32(this.buf, pcmF32);
    const avail = Math.floor(merged.length / this.frameLen) * this.frameLen;
    for (let off = 0; off < avail; off += this.frameLen) {
      // 每帧相对入参起点的时间偏移:第一帧可能因残留缓冲而为负(承前帧)。
      const offsetMs = ((off - this.buf.length) / (SAMPLE_RATE * CHANNELS)) * 1000;
      out.push({ data: this.enc.encode(Buffer.from(f32ToS16(merged.subarray(off, off + this.frameLen)))), offsetMs });
    }
    this.buf = merged.subarray(avail);
    return Promise.resolve(out);
  }

  flush(): Promise<EncodedChunk[]> {
    if (this.buf.length === 0) return Promise.resolve([]);
    const padded = new Float32Array(this.frameLen);
    padded.set(this.buf);
    const out = [{ data: this.enc.encode(Buffer.from(f32ToS16(padded))), offsetMs: 0 }];
    this.buf = new Float32Array(0);
    return Promise.resolve(out);
  }

  close(): void {
    this.buf = new Float32Array(0);
  }
}

/** 纯 JS 内联 PCM(s16le)编码器:零延迟,直接返回样本字面字节。 */
export class PcmEncoder implements ChunkEncoder {
  encode(pcmF32: Float32Array): Promise<EncodedChunk[]> {
    return Promise.resolve([{ data: f32ToS16(pcmF32), offsetMs: 0 }]);
  }
  flush(): Promise<EncodedChunk[]> {
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

/**
 * 分段 FLAC 编码器(2026-09-17 真机实测确定:这是唯一能让 ESPHome 设备出声的路径)。
 *
 * 根因:ffmpeg 的 pipe:1 输出**只在输入 EOF 时整块 flush** —— 用 `-flush_packets` 亦无法
 * 强制其逐帧提前写出(实测 pcm/opus/flac 在 stdin 结束前均零输出)。若维持「单条持续
 * ffmpeg 进程」,实时播放中每次 `encode()` 只能拿到空包 → 设备收完 stream/start 后
 * 再也收不到任何音频帧 → 不建 ring buffer、不进 PLAYING、无声
 * (ESP32-S3 esp32-player-meet:见 `docs/SENDSPIN_ESPHOME_FLAC_2026-09-17.md` 五·A)。
 *
 * 解法:**分段 FLAC**。不再维持长命进程,而是按 PCM 字节量累积到 `SEGMENT_PCM_BYTES`
 * 即关闭当前 ffmpeg 段(stdin.end → EOF → 该段完整 FLAC 一次性吐出),立即返回给调用方
 * 下发,并同步起下一段新 ffmpeg 续编。每段自带 `fLaC` 魔数 + STREAMINFO 头(ffmpeg flac
 * 封装天然如此),设备端逐段解码即可 —— 与 MA 金标准「每 ~10s 一段 stream」的分段粒度
 * 同构(MA 甚至每段重发 stream/start,我们保持同一 stream 内续段,设备已实测接受)。
 *
 * 段长权衡:越小延迟越低、帧越碎(每段一个 STREAMINFO 头,~8KB 开销);约 0.5s @48kHz/2ch/f32
 * = 48000*2*4*0.5 ≈ 192KB PCM,编码后 FLAC 约 60~100KB。取 0.5s 段兼顾实时与开销。
 * `flush()`(曲终/组关闭)把最后不足一段的残余也关段吐出。
 */
const SEGMENT_PCM_BYTES = SAMPLE_RATE * CHANNELS * 4 * 0.5; // 0.5s f32 立体声字节数

export class FfmpegPcmEncoder implements ChunkEncoder {
  private readonly isPcm: boolean;
  private readonly bitrateKbps: number;
  /** 当前活动段的 ffmpeg 进程(pcm 模式恒 null)。 */
  private p: ChildProcessWithoutNullStreams | null = null;
  /** 当前段已写入的 PCM 字节数(达阈值即关段)。 */
  private segBytes = 0;
  /** 当前段累积的 PCM 样本数(= 该段起始相对当前帧的负偏移基准)。 */
  private segSamples = 0;
  /** 曲终/关闭标志:届时不再起新段。 */
  private closed = false;

  constructor(codec: SendspinCodec, bitrateKbps = 320) {
    this.isPcm = codec === "pcm";
    this.bitrateKbps = bitrateKbps;
    if (!this.isPcm) this.p = this.spawnSegment(codec);
  }

  /** 起一段新的 ffmpeg flac 进程(自带 fLaC+STREAMINFO 头)。 */
  private spawnSegment(codec: SendspinCodec): ChildProcessWithoutNullStreams {
    const c = encodeCodecParams(codec);
    const args: string[] = [
      "-hide_banner", "-loglevel", "error",
      "-ar", String(SAMPLE_RATE), "-ac", String(CHANNELS), "-f", "f32le", "-i", "pipe:0",
      "-c:a", c.codecName,
      "-f", c.format, "pipe:1",
    ];
    if (c.codecName === "libopus") args.push("-b:a", `${this.bitrateKbps}k`);
    const p = spawn(ffmpegBin(), args, { stdio: ["pipe", "pipe", "pipe"] });
    // 吞掉 stderr 防止管道背压阻塞 ffmpeg。
    p.stderr.on("data", () => { /* drain */ });
    return p;
  }

  /** 收完当前段 ffmpeg 的全部输出(等其 close,即 EOF flush 完毕)。 */
  private drainSegment(p: ChildProcessWithoutNullStreams): Promise<Uint8Array[]> {
    return new Promise((resolve) => {
      const out: Buffer[] = [];
      if (p.stdout) p.stdout.on("data", (d: Buffer) => out.push(d));
      const done = () => resolve(out.length > 0 ? [new Uint8Array(Buffer.concat(out))] : []);
      p.once("close", done);
      p.once("error", done);
    });
  }

  /** 写入一批音频;flac 累积满一段即关段吐出该段完整 FLAC(可能同时补起下一段)。 */
  async encode(pcmF32: Float32Array): Promise<EncodedChunk[]> {
    if (this.isPcm) return [{ data: f32ToS16(pcmF32), offsetMs: 0 }];
    if (this.closed || !this.p) return [];
    const bytes = f32ToBytes(pcmF32);
    this.p.stdin.write(bytes);
    this.segBytes += bytes.length;
    this.segSamples += pcmF32.length;
    if (this.segBytes >= SEGMENT_PCM_BYTES) {
      // 该段起点在「当前帧起点」之前 segSamples 个样本 → 负偏移。
      const segOffsetMs = -(this.segSamples / (SAMPLE_RATE * CHANNELS)) * 1000;
      const drained = await this.closeSegment();
      const chunks: EncodedChunk[] = drained.map((d) => ({ data: d, offsetMs: segOffsetMs }));
      // 未整体关闭则续起下一段,保证连续播放中帧不断档。
      if (!this.closed) {
        this.p = this.spawnSegment("flac");
        this.segBytes = 0;
        this.segSamples = 0;
      }
      return chunks;
    }
    return [];
  }

  /** 关闭当前段:stdin.end 触发 EOF → ffmpeg flush 出该段完整 FLAC 并返回。 */
  private async closeSegment(): Promise<Uint8Array[]> {
    const p = this.p;
    this.p = null;
    if (!p) return [];
    try {
      p.stdin.end();
    } catch {
      /* ignore */
    }
    return this.drainSegment(p);
  }

  /** 冲刷最后一段残余并关闭;此后不再起新段。 */
  async flush(): Promise<EncodedChunk[]> {
    if (this.isPcm) return [];
    this.closed = true;
    const segOffsetMs = -(this.segSamples / (SAMPLE_RATE * CHANNELS)) * 1000;
    const drained = await this.closeSegment();
    this.segBytes = 0;
    this.segSamples = 0;
    return drained.map((d) => ({ data: d, offsetMs: segOffsetMs }));
  }

  close(): void {
    this.closed = true;
    const p = this.p;
    this.p = null;
    if (!p) return;
    try {
      p.stdin.end();
      p.kill();
    } catch {
      /* ignore */
    }
  }
}