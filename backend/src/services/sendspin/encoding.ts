// ==================== 音频编解码 ====================
//
// decoder: 任意输入 → F32/48k 立体声(PCM interleaved),基于 ffmpeg(一次性子进程)。
// encoder: F32/48k → codec。
//   - opus: 进程内 @discordjs/opus 逐 20ms 帧编码,输出「裸 opus 包」(对标 MusicAssistant)。
//     每帧独立成为一个可发送包,无管道缓冲延迟、无定时器兜底。
//   - pcm:  纯 JS 内联 F32 → s16le,零延迟,字节即 wire 格式。
//   - flac: **进程内 libFLAC(libflacjs)逐帧编码** —— 与 aiosendspin(MA)同构。
//     ⚠️ 2026-09-17 第六次无声事故后从「常驻 ffmpeg 管道」改为进程内:
//     ffmpeg 在管道模式下会先攒 ~1.4s 再成堆吐帧(实测首帧 1436ms、之后约 130ms/帧),
//     设备按 `ts - send_ahead` 判播出时刻,成堆下发必然 underrun → 无声。
//     进程内编码器 `process_interleaved()` **同步返回、每个回调恰好一帧**,
//     无管道、无缓冲、无节奏失真。详见 FfmpegPcmEncoder → LibFlacEncoder。

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
/** FLAC 目标位深。设备(sendspin-cpp)只声明 16bit 支持;而 ffmpeg 对 f32le 输入
 *  默认编 24bit —— 必须显式 `-sample_fmt s16`,否则声明 16 而流内 24 会静音。 */
export const FLAC_BIT_DEPTH = 16;
/** FLAC 帧块大小**兜底值**(仅用于「尚无真实流可解析」时的 STREAMINFO 合成)。
 *
 *  ⚠️ 2026-09-17 更正:曾经这里写着「必须显式传 `-frame_size 4096`,否则无声」,
 *  该结论**已被推翻**。真相:
 *    - 我们**不指定**块大小,让编码器自选 —— flac 已改为**进程内 libFLAC**
 *      (`LibFlacEncoder`,`create_libflac_encoder` 的 block_size 传 0),
 *      实测自选 **4096**,故兜底值取 4096 与之对齐(对齐 aiosendspin(MA)口径:
 *      MA 明确不指定 block size,读编码器自选的 frame_size 并跟随);
 *    - `stream/start` 的 STREAMINFO 一律从**真实流**(`flacCodecHeaderFromStream`)
 *      提取,兜底值只在「首段尚未产出」的极短窗口内用一次;
 *    - 设备侧解码缓冲由 STREAMINFO `max_block_size` 算出
 *      (`decoder.cpp`:`max_block_size × channels × bytes_per_sample`),
 *      4096/4608 都能正确算出,**不存在「必须 4096」**。
 *  真正决定「有没有声音」的是**「每个音频 chunk 恰好一个完整 FLAC 帧」**,与块大小取值无关。 */
export const FLAC_BLOCK_SIZE = 4096;
/** libFLAC 压缩级别(0..8)。**5 与 ffmpeg 默认一致**,同等压缩率下 CPU 开销最低。
 *  实时路径上比压缩率更重要的是「每帧 CPU 时间 ≪ 46.9ms」(4096 样本/48kHz 的帧长),
 *  级别 5 实测稳定达标;级别 8 无收益(码率仅低 ~1%)但 CPU 翻倍。 */
export const FLAC_COMPRESSION_LEVEL = 5;
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
 *
 *  ## 时间轴契约(2026-09-17 第三次无声事故后确立)
 *
 *  每个包必须自报**所含音频的精确样本数**(`frameSamples`,单声道口径),调用方据此
 *  以样本为单位推进时间线 —— 这正是 aiosendspin `push_stream` 的做法:
 *  `audio_offset_us += 该块实际样本数换算的时长`。
 *
 *  ⚠️ 为什么不能用「入参 PCM 长度 / 调度粒度」近似:FLAC 编码块的边界由**编码器**
 *  决定(ffmpeg `-frame_size 4096`),与调用方的调度粒度(如 100ms = 4800 样本)
 *  **永不对齐**。实测:100ms 输入产出 1 或 2 个 4096 样本帧(占比 1.172 帧/批)。
 *  给整个批次打同一个「调度帧时刻」会让:
 *    a) 批内多帧共享同一时刻 → 批内时间轴塌陷(块重叠);
 *    b) 每批时间轴按 100ms 走、音频只有 85.33ms 帧 → 逐渐超前真实音频。
 *  设备按 `(ts - send_ahead) - now` 判定播出时刻,ts 一旦超前/滞后即 underrun 无声。
 *
 *  `offsetMs` = 该包首样本相对于本次 encode() 入参起点的偏移(ms,可为负):
 *  仅作诊断/兼容保留,时间线推进**一律以 `frameSamples` 为准**。 */
export interface EncodedChunk {
  data: Uint8Array;
  offsetMs: number;
  /** 本包所含音频的**精确样本数**(单声道口径,即 FLAC block size / opus 帧样本数)。
   *  时间线以此累加:下一包的起点 = 本包起点 + frameSamples / SAMPLE_RATE。 */
  frameSamples: number;
}
export interface ChunkEncoder {
  encode(pcmF32: Float32Array): Promise<EncodedChunk[]>;
  flush(): Promise<EncodedChunk[]>;
  close(): void;
  /** 已产出的首段真实 STREAMINFO 的 base64(仅 flac;未产出时 null)。
   *  对齐 aiosendspin:codec_header 取编码器**真实 extradata**,不手工合成。 */
  getCodecHeaderB64?(): string | null;
  /** 本编码器**恒定**的输出帧样本数(单声道口径);用于校验/兜底。
   *  flac: FLAC_BLOCK_SIZE(末帧可能更短);opus: OPUS_FRAME_SAMPLES;pcm: 无固定值。 */
  readonly fixedFrameSamples?: number;
}

export function encodeCodecParams(codec: SendspinCodec): { format: string; codecName: string } {
  if (codec === "opus") return { format: "ogg", codecName: "libopus" };
  if (codec === "flac") return { format: "flac", codecName: "flac" };
  return { format: "s16le", codecName: "pcm_s16le" };
}

/** FLAC stream/start 用 codec_header:base64("fLaC"+0x80+u24(34)+STREAMINFO)。
 *  约定对标 aiosendspin reference(FlacEncoder.get_header:extradata 前加 fLaC 块头)。
 *  严格客户端(sendspin-cpp)无此头直接拒收整个 stream/start,之后每块音频全灭
 *  (2026-09-17 ESPHome 真机:"FLAC requires codec_header")。opus/pcm 自描述,不需要。
 *
 *  ⚠️⚠️ 字段值必须与**实际流内帧**逐项一致,否则严格解码器按 STREAMINFO 校验帧头
 *  时逐帧作废 → 设备建好解码环形区却不出声(2026-09-17 真机两轮踩坑):
 *    - block size:必须与 ffmpeg 的 `-frame_size` 一致(当前 **4096**,见 spawnSegment)。
 *      曾推测 4608(ffmpeg 48kHz 自选值)→ 实测不可控,已显式钉死 4096。
 *    - bits per sample:必须 **16**。ffmpeg 对 f32le 输入默认编 **24-bit**(s32)!
 *      必须给编码器加 `-sample_fmt s16`(见 encodeCodecParams/spawnSegment),
 *      否则声明 16 而流内 24 → 设备按 16 初始化后解不出 → 静音。
 *    - min/max frame size 与 total samples:流式未知,填 0,解码器接受。
 *  **优先用 `flacCodecHeaderFromStream()` 从真实段头提取**,避免手工维护漂移。 */
export function flacCodecHeaderB64(
  sampleRate = SAMPLE_RATE,
  channels = CHANNELS,
  bitDepth = FLAC_BIT_DEPTH,
  minBlock = FLAC_BLOCK_SIZE,
  maxBlock = FLAC_BLOCK_SIZE,
): string {
  const info = Buffer.alloc(34, 0);
  info.writeUInt16BE(minBlock, 0);
  info.writeUInt16BE(maxBlock, 2);
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

/** 从一段真实 FLAC 字节里提取前 42B(`fLaC` + STREAMINFO 块头 + 34B STREAMINFO)并 base64。
 *  这是**唯一保证声明与流一致**的做法:不再手工合成字段。
 *  入参非法(非 fLaC 或长度不足)时返回 null,调用方回落到 `flacCodecHeaderB64()`。 */
export function flacCodecHeaderFromStream(seg: Uint8Array): string | null {
  if (seg.length < 42) return null;
  if (seg[0] !== 0x66 || seg[1] !== 0x4c || seg[2] !== 0x61 || seg[3] !== 0x43) return null;
  return Buffer.from(seg.subarray(0, 42)).toString("base64");
}

/**
 * 定位 FLAC **容器头**结束、裸帧流开始的位置(即首个 frame sync 的偏移)。
 *
 * ⚠️ 这是本轮无声事故的核心修复点(2026-09-17)。
 *
 * ffmpeg 的 flac muxer 在 pipe 输出时会写一个**完整文件头**:
 *   `fLaC`(4B) + STREAMINFO 块(4B 头 + 34B) + VORBIS_COMMENT 块 + 8KB PADDING
 * 实测容器头总长 **8288 字节**,首个帧 sync 在 8288 处。
 *
 * 而设备侧:STREAMINFO 已经通过 `stream/start.codec_header` **单独给过一次**,
 * 之后设备按「连续 FLAC 帧流」解析。我们若把整段(含 8KB 容器头)原样下发,
 * 设备会在期待 frame sync 的位置读到 `66 4c 61 43` → micro-flac 静默丢弃损坏帧
 * → **日志全绿(Stream Started / codec header / speaker_mixer Starting)、
 * 状态 PLAYING、进度正常,但完全无声、零报错**。
 *
 * MA(aiosendspin)从不产生这个问题:它用常驻 `av.AudioCodecContext`,只下发
 * `encoder.encode(frame)` 的**裸 packet**,容器头单独由 `get_header()` 供 stream/start。
 *
 * 做法:按 FLAC 元数据块规范遍历(每块 4B 头:1B [isLast|type] + 3B 长度),
 * 跳过全部 metadata block,返回其后的偏移。
 * 入参非法(非 fLaC)返回 null;块结构非法返回 null(调用方保持原样,宁可多传不截断)。
 */
export function flacFrameStreamOffset(buf: Uint8Array): number | null {
  if (buf.length < 4) return null;
  if (buf[0] !== 0x66 || buf[1] !== 0x4c || buf[2] !== 0x61 || buf[3] !== 0x43) return null;
  let off = 4;
  for (;;) {
    if (off + 4 > buf.length) return null; // 头不完整(尚未收全)
    const hdr = buf[off];
    const isLast = (hdr & 0x80) !== 0;
    const type = hdr & 0x7f;
    if (type === 127) return null; // 非法块类型
    const len = (buf[off + 1] << 16) | (buf[off + 2] << 8) | buf[off + 3];
    off += 4 + len;
    if (isLast) break;
  }
  return off <= buf.length ? off : null;
}

/** FLAC 帧头 block size 查表(RFC 9639 §9.1.1,code 6/7 走块尾 8/16bit 扩展)。 */
const FLAC_BLOCK_TBL: Record<number, number> = {
  1: 192, 2: 576, 3: 1152, 4: 2304, 5: 4608,
  8: 256, 9: 512, 10: 1024, 11: 2048, 12: 4096, 13: 8192, 14: 16384, 15: 32768,
};

/** 解析单个 FLAC 帧头,返回该帧的**样本数**(单声道口径)+ 头字节长度。
 *  仅需前若干个字节,不做全帧解码 —— 这是样本精确时间戳的基础。
 *
 *  帧头布局(小端位序,逐字节读取):
 *    b0    = 0xFF(同步)
 *    b1    = 111110[blocking]  → 高 7 位固定 0b111110
 *    b2    = [blocksize:4][samplerate:4]
 *    b3    = [channel assignment:4][sample size:3][reserved:1]
 *            channel assignment: 0b0000=同流默认,0b0001..0b0111=1..8 声道独立,
 *            0b1000=left/side,0b1001=right/side,0b1010=mid/side(后三者均 2 声道)
 *    ...   随后是 UTF-8 编码的帧/样本号(1-7 字节,这里只用于跳过)
 *    若 blocksize code == 6 → 紧随其后 8bit(值+1);code == 7 → 16bit(值+1)
 *
 *  返回 null 表示不是合法帧头(需要更多字节 / 数据损坏)。 */
export function parseFlacFrameHeader(
  buf: Uint8Array, off = 0,
): { samples: number; headerBytes: number } | null {
  if (off + 5 > buf.length) return null;
  if (buf[off] !== 0xff || (buf[off + 1] & 0xfe) !== 0xf8) return null;
  const bsizeCode = (buf[off + 2] >> 4) & 0x0f;
  const srCode = buf[off + 2] & 0x0f;
  // ⚠️ channel assignment 是 **4 bit**(0b0000..0b1010 合法,0b1011..0b1111 保留):
  //    0b1000/1001/1010 = left/side | right/side | mid/side(都是立体声)。
  //    曾经这里写 `& 0x07` 并把 `chanCode > 7` 当非法 —— 会把 mid/side 帧头
  //    直接判成「非帧头」,配合 frameChannelLayout 的位宽错误一起造成
  //    「compression ≥ 5 一帧都切不出」。详见 frameChannelLayout 注释。
  const chanCode = buf[off + 3] >> 4;
  const bpsCode = (buf[off + 3] >> 1) & 0x07;
  if (bsizeCode === 0 || srCode === 15 || chanCode > 10 || bpsCode === 3) return null;

  // UTF-8 变长「帧号或样本号」字段:统计续字节(0b10xxxxxx)。
  let p = off + 4;
  if (p >= buf.length) return null;
  const lead = buf[p];
  let extra = 0;
  if (lead >= 0x80) {
    // 前导 1 的个数 = 后续续字节数(1→0 续,110→1,1110→2,...)
    let mask = 0x80;
    while (extra < 7 && (lead & mask) !== 0) { extra++; mask >>= 1; }
    extra -= 1; // 首个 1 是标志本身
    if (extra < 0 || extra > 6) return null;
  }
  p += 1 + Math.max(0, extra);

  let samples: number;
  if (bsizeCode === 6) {
    if (p + 1 > buf.length) return null;
    samples = buf[p] + 1;
    p += 1;
  } else if (bsizeCode === 7) {
    if (p + 2 > buf.length) return null;
    samples = ((buf[p] << 8) | buf[p + 1]) + 1;
    p += 2;
  } else {
    const v = FLAC_BLOCK_TBL[bsizeCode];
    if (!v) return null;
    samples = v;
  }
  const srExtra = srCode === 12 ? 1 : srCode === 13 || srCode === 14 ? 2 : 0;
  p += srExtra;
  // CRC-8(帧头校验,1B)—— 仅用于推进偏移,不校验(廉价路径不做 CRC 计算)。
  p += 1;
  return { samples, headerBytes: p - off };
}

/** 从头解析一段**裸 FLAC 帧流**,统计每个帧的样本数。
 *
 *  裸帧流没有长度字段,必须靠「解出帧头 + 逐子帧推进」才能定位下一个同步字。
 *  完整解码过重,这里改用**同步字前向扫描**(与设备侧 micro-flac 的容错策略一致):
 *  在期望的帧边界之外,向后搜索合法的 `FF F8/F9` 且字段自洽的位置。
 *
 *  ⚠️ 局限:被扫描的字节区间理论上可能撞上伪同步字。对 **16bit 立体声** 而言
 *  连续两字节恰为 `FF Fx` 且后续 3 字节字段全合法的概率极低(约 2^-22 量级),
 *  且我们只用它做**时间戳推进**,单帧误差 85ms 属于可接受范围(设备按 ts 调度,
 *  不依赖服务端的帧计数)。这是功能正确性 suficiente 的近似,不追求比特级精确。
 *
 *  返回各帧样本数数组;空数组表示尚无完整帧。 */
export function scanFlacFrameSamples(buf: Uint8Array): number[] {
  const out: number[] = [];
  let i = 0;
  while (i + 5 <= buf.length) {
    if (buf[i] !== 0xff || (buf[i + 1] & 0xfe) !== 0xf8) { i++; continue; }
    const hdr = parseFlacFrameHeader(buf, i);
    if (!hdr) { i++; continue; }
    out.push(hdr.samples);
    i += 1; // 从下一字节继续找下一个同步字(帧长度未知)
  }
  return out;
}

/** 统计一段裸 FLAC 帧流的总样本数(单声道口径)。
 *  解析失败/无帧时回落到按字节数估算(16bit 立体声 = 4B/样本),
 *  保证时间线不会因一次解析失败而**停滞**(宁可略偏也不能卡住)。 */
export function sumFlacSamples(buf: Uint8Array): number {
  const per = scanFlacFrameSamples(buf);
  if (per.length > 0) return per.reduce((a, b) => a + b, 0);
  return Math.floor(buf.length / (CHANNELS * (FLAC_BIT_DEPTH / 8)));
}

// ==================== FLAC 帧切分(单帧一包) ====================
//
// ## 为什么必须切分(2026-09-17 第五次无声事故的确定根因)
//
// 设备侧 `sendspin-cpp` 的 `sync_task.cpp` 对**每个 chunk** 调用一次:
//     decoder->process_header(...)          // 仅 codec header 块
//     decoder->decode_audio_chunk(data, size, out, out_size, &decoded)
// 而 micro-flac 的 `decode_frame()` 是**一次调用解一帧**:
//   - 数据不足一帧 → 返回 `NEED_MORE_DATA` → 设备打
//     `Serious error decoding FLAC file` 并**丢弃该块**(不回灌缓冲);
//   - 数据超过一帧 → 只解第一帧,多余字节**被静默丢弃**。
// 即:**每个音频 chunk 必须恰好等于一个完整 FLAC 帧**。
//
// 我们的常驻 ffmpeg 是**批量**输出(实测:喂 2 秒 PCM,stdin EOF 前 stdout
// 一个字节都不吐,EOF 后一次性给 44853B / 24 帧)。旧实现直接把这一大块当作
// 一个包下发 → 设备每包都失败 → **1633 次 `Serious error`、零成功、完全无声**。
//
// MA(aiosendspin)从不产生这个问题:它用进程内 `av` 编码器,
// `encoder.encode(frame)` **一次调用返回一帧**,天然一帧一包。
//
// ## 切分算法
//
// FLAC 帧的**长度没有字段可读**(不像 MP3 有 bitrate),必须逐子帧推进算出来:
//   帧头(含 CRC-8) → 每个声道一个子帧 → 补齐到字节边界 → CRC-16
// 子帧长度按类型可精确计算:
//   - CONSTANT : 1 bit padding(0)+6bit type,之后 **samples × bps** bit;
//   - VERBATIM : 1+6bit,之后 **samples × bps** bit;
//   - FIXED    : 1+6bit(order)+1bit wasted + [unary wasted] + **order × bps**
//                残差(前 order 个样本)+ Rice 编码残差(需逐分区解 unary);
//   - LPC      : 1+6bit(order)+1bit wasted + [unary wasted] + **order × bps**
//                系数(精度可变)+ shift(5bit,有符号) + Rice 残差。
// 因此固定/线性预测子帧必须**解码 Rice 分区**才能知道长度 —— 这是本函数的核心。
//
// 实现取舍:解析失败(数据不足 / 结构异常)时返回已确认的完整帧,
// 残余留在缓冲等下一轮;绝不猜边界(猜错会让后续所有帧错位)。

/** 读 FLAC 的 unary 值。
 *
 *  ⚠️ 方向极易搞反,以 RFC 9639 §5 为准:
 *    "Unary coding in a FLAC bitstream is done with **zero bits terminated with
 *     a one bit**, e.g., the number 5 is coded unary as 0b000001."
 *  即 **数连续 0 的个数,直到出现 1** —— 不是数 1 直到 0。
 *  (写反的后果:残差长度整体偏大 → 子帧结束位错位 → 第二声道从垃圾位置起解析
 *   → 读到 `method=2`(保留值)→ 整帧切分失败 → 无声。2026-09-17 实测踩坑。)
 *
 *  返回 [值, 消耗 bit 数];数据不足返回 null。 */
function readUnary(bits: BitReader): { value: number; consumed: number } | null {
  let n = 0;
  for (;;) {
    const b = bits.read(1);
    if (b === null) return null;
    if (b === 1) return { value: n, consumed: n + 1 };
    n++;
    if (n > 1 << 20) return null; // 防御:异常数据不至于无限循环
  }
}

/** 位读取器(MSB first),越界统一返回 null。 */
class BitReader {
  private pos = 0; // bit 偏移
  constructor(private readonly buf: Uint8Array, private readonly startBit = 0) {
    this.pos = startBit;
  }
  get bitPos(): number {
    return this.pos;
  }
  read(n: number): number | null {
    if (n === 0) return 0;
    const need = this.pos + n;
    if (need > this.buf.length * 8) return null;
    let v = 0;
    for (let i = 0; i < n; i++) {
      const byte = this.buf[(this.pos + i) >> 3];
      const bit = 7 - ((this.pos + i) & 7);
      v = (v << 1) | ((byte >> bit) & 1);
    }
    this.pos = need;
    return v;
  }
  readSigned(n: number): number | null {
    const v = this.read(n);
    if (v === null) return null;
    if (n === 0) return 0;
    const sign = 1 << (n - 1);
    return v >= sign ? v - (sign << 1) : v;
  }
  skip(n: number): boolean {
    return this.read(n) !== null;
  }
  /** 对齐到下一个字节边界。 */
  alignByte(): void {
    this.pos = (this.pos + 7) & ~7;
  }
}

/** 读一个「UTF-8 风格」变长编码整数(FLAC 帧/样本号),返回**续字节**个数。 */
function utf8Len(lead: number): number {
  if ((lead & 0x80) === 0) return 0;
  let ones = 0;
  let mask = 0x80;
  while (ones < 7 && (lead & mask) !== 0) { ones++; mask >>= 1; }
  return Math.max(0, ones - 1); // 首个 1 是标志本身,其余才是续字节数
}

/** 子帧类型(bits 1-6)。 */
const SUBFRAME_CONSTANT = 0;
const SUBFRAME_VERBATIM = 1;
const SUBFRAME_FIXED = 8; // 8..12 → order = type - 8
const SUBFRAME_LPC = 32; // 32..63 → order = (type & 31) + 1

/** 解一个子帧,返回消耗的 **bit** 数(从 reader 当前位置起);失败返回 null。
 *  只需跳过数据,不需要真正重建样本 —— 但 Rice 残差长度必须先解出来。 */
function subframeBits(reader: BitReader, blockSize: number, bps: number): number | null {
  const start = reader.bitPos;
  const pad = reader.read(1);
  if (pad !== 0) return null; // 必须为 0
  const type = reader.read(6);
  if (type === null) return null;

  // 1 bit:wasted-bits 标志。为 1 时随后是 unary 编码的实际浪费位数。
  const wastedFlag = reader.read(1);
  if (wastedFlag === null) return null;
  let wasted = 0;
  if (wastedFlag === 1) {
    const u = readUnary(reader);
    if (!u) return null;
    wasted = u.value + 1;
  }
  const effBps = bps - wasted;
  if (effBps <= 0 && wasted > 0) return null;

  if (type === SUBFRAME_CONSTANT) {
    if (!reader.skip(effBps)) return null;
  } else if (type === SUBFRAME_VERBATIM) {
    if (!reader.skip(blockSize * effBps)) return null;
  } else if (type >= SUBFRAME_FIXED && type < SUBFRAME_FIXED + 5) {
    const order = type - SUBFRAME_FIXED;
    // 前 order 个样本以「warm-up」原样存储。
    if (!reader.skip(order * effBps)) return null;
    // 残差:Rice 编码,分区参数由方法位决定。
    if (!skipResidual(reader, blockSize, order)) return null;
  } else if (type >= SUBFRAME_LPC) {
    const order = (type & 31) + 1;
    if (!reader.skip(order * effBps)) return null;
    const prec = reader.read(4); // 系数精度 - 1
    if (prec === null) return null;
    if (prec === 15) return null; // 非法
    if (!reader.skip(5)) return null; // 量化左移(有符号 5bit)
    if (!reader.skip((prec + 1) * order)) return null; // 系数
    if (!skipResidual(reader, blockSize, order)) return null;
  } else {
    return null; // 保留类型
  }
  return reader.bitPos - start;
}

/** 跳过 FLAC 残差编码段(Rice / Rice2 分区)。
 *  返回是否成功(数据不足 → false,调用方保留残余等下一轮)。 */
function skipResidual(reader: BitReader, blockSize: number, predictorOrder: number): boolean {
  const method = reader.read(2);
  if (method === null) return false;
  if (method === 2) return false; // 保留
  const riceParamBits = method === 0 ? 4 : 5;
  const escapeCode = method === 0 ? 15 : 31;
  const partitionBits = reader.read(4);
  if (partitionBits === null) return false;
  const partitions = 1 << partitionBits;

  // ⚠️ 分区样本数的**权威口径**(RFC 9639 §9.2.7 / libFLAC `read_residual_partitioned`):
  //     每个分区 = `blockSize >> partitionOrder` 个样本,
  //     但**第一个分区**要再减去预测器阶数:`(blockSize >> partitionOrder) - predictorOrder`。
  //   两种常见错法:
  //     a) 用 `(blockSize - predictorOrder) / partitions` 当每分区样本数 —— 分区数>1 时偏小;
  //     b) 把余数给最后一个分区 —— 分区数>1 时首个分区样本数错。
  //   错一个样本就会让整个分区组的 unary 流错位,误读到巨大的 q 值,
  //   一路把子帧结束位推到帧外 → 切分失败(2026-09-17 实测:
  //   `-compression_level 0` 的 FIXED/LPC 子帧大量用 pb≥2,旧口径直接把首帧读爆)。
  const perPartition = blockSize >> partitionBits;
  const firstPartition = perPartition - predictorOrder;
  if (firstPartition < 0) return false; // 非法:预测阶数超过分区样本数

  for (let p = 0; p < partitions; p++) {
    const param = reader.read(riceParamBits);
    if (param === null) return false;
    const n = p === 0 ? firstPartition : perPartition;
    if (n === 0) continue;
    if (n < 0) return false;
    if (param === escapeCode) {
      const rawBits = reader.read(5);
      if (rawBits === null) return false;
      if (!reader.skip(n * rawBits)) return false;
    } else {
      for (let i = 0; i < n; i++) {
        const q = readUnary(reader);
        if (!q) return false;
        if (!reader.skip(param)) return false;
      }
    }
  }
  return true;
}

/** 跳过帧头,返回「帧体(subframes+CRC16)起始字节偏移」;失败返回 null。
 *  与 `parseFlacFrameHeader` 同布局,但额外处理 CRC-8 与字节对齐语义。 */
function frameBodyOffset(buf: Uint8Array, off: number, blockSize: number): number | null {
  let p = off + 4;
  if (p >= buf.length) return null;
  const lead = buf[p];
  const extra = utf8Len(lead);
  p += 1 + extra;
  const bsizeCode = (buf[off + 2] >> 4) & 0x0f;
  if (bsizeCode === 6) p += 1;
  else if (bsizeCode === 7) p += 2;
  const srCode = buf[off + 2] & 0x0f;
  if (srCode === 12) p += 1;
  else if (srCode === 13 || srCode === 14) p += 2;
  p += 1; // CRC-8
  if (p > buf.length) return null;
  void blockSize;
  return p;
}

/** 由帧头的 **channel assignment code(4 bit)** 推出实际子帧数与声道布局。
 *
 *  ## ⚠️ 为什么必须用 4 bit 而不是 3 bit(2026-09-17 决定性 bug)
 *
 *  RFC 9639 §9.1.3 的 byte3 布局是 `channel assignment (4 bits) | sample size
 *  (3 bits) | reserved (1 bit)` —— channel assignment 是**整整 4 bit**。
 *  曾经这里写着 `(buf[off + 3] >> 4) & 0x07`,把 4 bit 截成 3 bit,后果:
 *
 *    - `0b0000..0b0111` → 1..8 声道(独立),截 3 bit 无害;
 *    - `0b1000` = left/side stereo,`0b1001` = right/side,`0b1010` = mid/side
 *      —— 这三个都是**立体声的联合编码模式,仍然只有 2 个声道**,
 *      但截成 3 bit 后变成 `0b000` / `0b001` / `0b010` = 1/2/**3** 声道:
 *      **mid/side 被误判成 3 声道** → 多走一个子帧 → 帧长走飞 → 一帧都切不出。
 *
 *  实测:libFLAC 在 compression 0 仅用「独立立体声」(code 1)故侥幸通过;
 *  compression ≥ 5 启用 mid/side(code 10)→ **全部帧切分失败**
 *  (`frames=0, rest=全量`)。这正是「高压缩级别完全切不出帧」的根因。
 *
 *  ## 返回值
 *
 *  `subframes` = 需要解码的子帧个数(与声道数一致,联合立体声也是 2);
 *  `channels`  = 真实声道数(仅用于语义,不参与 walk)。 */
function frameChannelLayout(
  buf: Uint8Array, off: number, defChannels: number,
): { subframes: number; channels: number } {
  const chanCode = buf[off + 3] >> 4; // ← 4 bit,不掩码
  if (chanCode === 0) return { subframes: defChannels, channels: defChannels };
  if (chanCode <= 7) return { subframes: chanCode + 1, channels: chanCode + 1 };
  if (chanCode <= 10) {
    // 0b1000/0b1001/0b1010 = left/side | right/side | mid/side —— 都是 2 声道、2 子帧
    return { subframes: 2, channels: 2 };
  }
  return { subframes: defChannels, channels: defChannels }; // 保留值:按流缺省保守处理
}

/** 解析帧头里的声道布局 / 位深(code 0 时取流默认值)。 */
function frameChannelsBps(
  buf: Uint8Array, off: number, defChannels: number, defBps: number,
): { channels: number; bps: number } {
  const { channels } = frameChannelLayout(buf, off, defChannels);
  const bpsCode = (buf[off + 3] >> 1) & 0x07;
  const BPS_TABLE = [0, 8, 12, 0, 16, 20, 24, 32];
  const bps = bpsCode === 0 ? defBps : BPS_TABLE[bpsCode];
  return { channels, bps: bps || defBps };
}

/** 从一段裸 FLAC 帧流里**精确切出完整帧**的字节区间。
 *
 *  返回 `{ frames: Uint8Array[]; rest: Uint8Array }`:
 *    - `frames` 每个元素**恰好一帧**(含帧头 + subframes + CRC-16);
 *    - `rest`  为尾部不完整帧的残余(调用方保留,等下一轮数据到达再切)。
 *
 *  ⚠️ 必须精确而非同步字暴搜:FLAC 帧体的残差数据里**完全可能出现 `FF F8`**
 *  字节对,暴搜会切出非法边界,导致后续所有帧错位 —— 而设备对**每一包**
 *  都要求是完整单帧(见本文件「为什么必须切分」)。
 *
 *  `defChannels` / `defBps`:STREAMINFO 里的缺省值(帧头 code 0 表示「同流默认」)。 */
export function splitFlacFrames(
  buf: Uint8Array,
  defChannels = CHANNELS,
  defBps = FLAC_BIT_DEPTH,
): { frames: Uint8Array[]; rest: Uint8Array; skippedContainerBytes: number } {
  // ffmpeg(与任何 FLAC 编码器)在**裸帧流之前**先吐 `fLaC` 魔数 + STREAMINFO +
  // 可选 VORBIS_COMMENT/PADDING(ffmpeg 实测补齐到 8KB,首个 frame sync 在偏移 8288)。
  // 必须显式跳过,否则 `buf[0] !== 0xff` 会让下面的循环第一步就 break(实测踩坑)。
  // 容器头由 stream/start 的 `codec_header` 单独承载,绝不混进音频 chunk。
  let off = 0;
  let skippedContainerBytes = 0;
  if (buf.length >= 4 && buf[0] === 0x66 && buf[1] === 0x4c && buf[2] === 0x61 && buf[3] === 0x43) {
    const streamOff = flacFrameStreamOffset(buf);
    if (streamOff === null) {
      // 容器头尚未收全 → 一帧都切不出,原样保留等下一轮。
      return { frames: [], rest: buf, skippedContainerBytes: 0 };
    }
    off = streamOff;
    skippedContainerBytes = streamOff;
  } else if (buf.length > 0 && buf[0] !== 0xff) {
    // 既非容器头也非 frame sync:尝试向后定位第一个合法 sync(容忍零星脏字节),
    // 定位不到则原地等待下一轮,不做破坏性截断。
    const idx = findFirstFrameSync(buf);
    if (idx < 0) return { frames: [], rest: buf, skippedContainerBytes: 0 };
    off = idx;
    skippedContainerBytes = idx;
  }

  const frames: Uint8Array[] = [];
  while (off + 5 <= buf.length) {
    if (buf[off] !== 0xff || (buf[off + 1] & 0xfe) !== 0xf8) {
      // 不是帧头:说明上游给的不是裸帧流(或残余错位)。停止,余下原样返回。
      break;
    }
    const hdr = parseFlacFrameHeader(buf, off);
    if (!hdr) break;
    // ⚠️ 必须用 `subframes`(子帧个数)而不是 `channels`:联合立体声
    // (left/side、right/side、mid/side)是 2 声道但**子帧数也是 2**,两者此处一致;
    // 真正的坑在于 chanCode 的位宽(见 frameChannelLayout 注释)。
    const { subframes } = frameChannelLayout(buf, off, defChannels);
    const { bps } = frameChannelsBps(buf, off, defChannels, defBps);
    const bodyOff = frameBodyOffset(buf, off, hdr.samples);
    if (bodyOff === null) break;
    // 子帧从 bodyOff 起,按 channel 顺序排列,整体不按字节对齐(逐位连续)。
    const reader = new BitReader(buf, bodyOff * 8);
    let ok = true;
    for (let ch = 0; ch < subframes; ch++) {
      if (subframeBits(reader, hdr.samples, bps) === null) { ok = false; break; }
    }
    if (!ok) break; // 数据不足 → 保留残余
    const crcEnd = resolveFrameEnd(buf, off, reader.bitPos);
    if (crcEnd === null || crcEnd > buf.length) break; // CRC 尚未到齐
    frames.push(buf.subarray(off, crcEnd));
    off = crcEnd;
  }
  return { frames, rest: buf.subarray(off), skippedContainerBytes };
}

/** 由「最后一个子帧的结束 bit」推出**本帧结束字节偏移**(含 2B CRC-16)。
 *
 *  ## 为什么不能简单地 `alignByte() + 2`(2026-09-17 实测)
 *
 *  RFC 9639 §9.2 说帧尾是「子帧数据补齐到字节边界,再接 16bit CRC」。但按此实现
 *  (`(bitPos + 7) & ~7` 后 +2),在 **189 帧 / 6 组编码参数** 的实测中只有 ~85% 命中:
 *  凡是**子帧数据恰好落在字节边界上**的帧都会算短 **1 字节**。
 *  相反,「严格向上取整、至少留 1 字节」(`floor(bitPos/8) + 1 + 2`)命中 **189/189**。
 *
 *  ## 因此采取「候选边界 + 后继合法性验证」而非单一公式
 *
 *  两个候选:
 *    - `strict  = floor(endBit / 8) + 1 + 2`(实测主口径,至少留 1 字节再补 CRC);
 *    - `aligned = ceil(endBit / 8) + 2`(RFC 字面口径)。
 *  两者相同时只试一个。裁决顺序(2026-09-17 二次修正):
 *
 *    1. **后继位置解析出完整合法帧头** → 该候选自洽,直接采信(最可靠);
 *    2. **后继位置是 sync 但数据不足 6 字节**(缓冲尾部不可判定)→ 若 `aligned`
 *       也已越过缓冲末尾则采信 `strict`,否则**优先 `aligned`** ——
 *       因为「不足一帧头」正是「下一帧刚开始」的典型形态,而 `aligned`
 *       在字节对齐全帧上是正确值(实测 `strict` 会比真值多 1 字节);
 *    3. 都验不过 → 回落 `strict`(历史主口径,命中率最高)。
 *
 *  真实场景下第 1 条几乎总能命中(每帧后面都跟着下一帧),后两条只服务于
 *  「缓冲恰好断在帧边界」的收尾时刻。 */
function resolveFrameEnd(buf: Uint8Array, off: number, endBit: number): number | null {
  const strict = Math.floor(endBit / 8) + 1 + 2;
  const aligned = Math.ceil(endBit / 8) + 2;
  const same = strict === aligned;
  const candidates = same ? [strict] : [strict, aligned];

  // 第 1 轮:找「后继是完整合法帧头」的候选。
  for (const c of candidates) {
    if (c > buf.length) continue;
    if (c < buf.length && looksLikeFullFrameHeaderAt(buf, c)) return c;
  }

  // 第 2 轮:后继只有零星字节(不足以构成完整帧头)时的裁决。
  // 判据不看「离缓冲末尾多近」,而看**后继位置是否刚好又是一个 frame sync** ——
  // 若是,说明 `aligned` 正是下一帧的起点(残缺帧尾只是缓冲还没收全),应采信它。
  // 反之(sync 不在 aligned 处)才回落主口径。
  if (!same) {
    if (aligned <= buf.length && hasFrameSyncAt(buf, aligned)) return aligned;
    if (strict > buf.length && aligned <= buf.length) return aligned;
  }

  // 第 3 轮:回落主口径。
  return candidates[0];
}

/** 位置 `p` 是否像一帧的开头(同步字 + 帧头字段自洽);到缓冲末尾视为「像」。 */
function looksLikeFrameHeaderAt(buf: Uint8Array, p: number): boolean {
  if (p >= buf.length) return true; // 缓冲刚好用完 → 无法证伪,接受
  return looksLikeFullFrameHeaderAt(buf, p) || p + 6 > buf.length;
}

/** 位置 `p` 是否有**足够字节**构成一个字段自洽的 FLAC 帧头(不认「数据不足」)。 */
function looksLikeFullFrameHeaderAt(buf: Uint8Array, p: number): boolean {
  if (p >= buf.length) return false;
  if (p + 6 > buf.length) return false;
  if (buf[p] !== 0xff || (buf[p + 1] & 0xfe) !== 0xf8) return false;
  return parseFlacFrameHeader(buf, p) !== null;
}

/** 位置 `p` 是否是一个 FLAC frame sync(仅看 2 字节同步字,不管帧头是否收全)。
 *  用于判定「下一帧确实从这里开始」—— 即使缓冲只收到前 2~5 字节。 */
function hasFrameSyncAt(buf: Uint8Array, p: number): boolean {
  if (p + 2 > buf.length) return false;
  return buf[p] === 0xff && (buf[p + 1] & 0xfe) === 0xf8;
}

/** 向后搜索第一个位置,使其满足 FLAC frame sync 且帧头字段自洽。
 *  仅在输入既非容器头也非 sync 起点时用作「重新同步」兜底;找不到返回 -1。 */
function findFirstFrameSync(buf: Uint8Array): number {
  for (let i = 0; i + 6 <= buf.length; i++) {
    if (buf[i] !== 0xff || (buf[i + 1] & 0xfe) !== 0xf8) continue;
    if (parseFlacFrameHeader(buf, i)) return i;
  }
  return -1;
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
  /** opus 恒 20ms/帧 → 每包固定帧样本数(单声道口径)。 */
  readonly fixedFrameSamples = OPUS_FRAME_SAMPLES / CHANNELS;

  constructor(bitrateKbps = 320) {
    this.enc = new DiscordOpusEncoder(SAMPLE_RATE, CHANNELS);
    this.enc.setBitrate(bitrateKbps * 1000);
  }

  encode(pcmF32: Float32Array): Promise<EncodedChunk[]> {
    const out: EncodedChunk[] = [];
    const merged = concatF32(this.buf, pcmF32);
    const avail = Math.floor(merged.length / this.frameLen) * this.frameLen;
    const perFrameSamples = this.frameLen / CHANNELS; // 单声道口径
    for (let off = 0; off < avail; off += this.frameLen) {
      // 每帧相对入参起点的时间偏移:第一帧可能因残留缓冲而为负(承前帧)。
      const offsetMs = ((off - this.buf.length) / (SAMPLE_RATE * CHANNELS)) * 1000;
      out.push({
        data: this.enc.encode(Buffer.from(f32ToS16(merged.subarray(off, off + this.frameLen)))),
        offsetMs,
        frameSamples: perFrameSamples,
      });
    }
    this.buf = merged.subarray(avail);
    return Promise.resolve(out);
  }

  flush(): Promise<EncodedChunk[]> {
    if (this.buf.length === 0) return Promise.resolve([]);
    const padded = new Float32Array(this.frameLen);
    padded.set(this.buf);
    const out = [{
      data: this.enc.encode(Buffer.from(f32ToS16(padded))),
      offsetMs: 0,
      frameSamples: this.frameLen / CHANNELS,
    }];
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
    return Promise.resolve([{
      data: f32ToS16(pcmF32),
      offsetMs: 0,
      frameSamples: Math.floor(pcmF32.length / CHANNELS),
    }]);
  }
  flush(): Promise<EncodedChunk[]> {
    return Promise.resolve([]);
  }
  close(): void {}
}

/** 按 codec 创建 chunk 编码器:opus / flac → 进程内, pcm → 内联。 */
export function createChunkEncoder(codec: SendspinCodec, bitrateKbps = 320): ChunkEncoder {
  if (codec === "opus") return new OpusEncoder(bitrateKbps);
  if (codec === "pcm") return new PcmEncoder();
  return new LibFlacEncoder();
}

/**
 * 进程内 FLAC 编码器(2026-09-17 第六次无声事故后重写)**。
 *
 * ## 为什么必须换成进程内编码器
 *
 * 上一版是「常驻 ffmpeg 管道」(`-f f32le pipe:0` → `-f flac pipe:1`)。它有两个致命问题:
 *
 *  1. **交付节奏完全错**:实测喂 2s PCM、以 25ms 粒度写入时,
 *     ffmpeg **首帧 1436ms 才吐**,之后约 **130ms/帧**(真实应为 46.9ms/帧),
 *     且**成堆下发**(一次 11 帧)。设备按 `target_local_us = ts - send_ahead`
 *     判播出时刻,收到成堆帧时 delta 持续 ≤0 → 立即吐字节 → 缓冲空 → **underrun 无声**。
 *  2. **一包多帧**:管道按 64KB 块交付,一次 `read` 拿到的是**多帧拼接**,
 *     而设备侧 `sync_task.cpp` 对每个 chunk 只调一次 `decode_audio_chunk()`,
 *     而 micro-flac 的 `decode_frame()` **一次调用只解一帧** —— 多帧也只解第一帧、
 *     其余**静默丢弃**;不足一帧则打 `Serious error decoding FLAC file`。
 *     结果:1792 次报错、0 成功、完全无声。
 *
 * MA(aiosendspin)之所以一直正常:它用**进程内** `av` 编码器,
 * `encoder.encode(frame)` 同步返回一帧,天然一帧一包、零管道延迟。
 *
 * ## 本实现
 *
 * 用 `libflacjs`(官方 libFLAC 1.4.x 经 emscripten 编译的 **asm.js** 变体,
 * MIT,零原生依赖、alpine 免编译)在**同一进程内**编码:
 *
 *   - `create_libflac_encoder(48000, 2, 16, level, 0, verify, 0)` 建实例
 *     (block_size 传 0 = **让编码器自选**,与 MA 口径一致);
 *   - `init_encoder_stream(id, cb)` 注册写回调 —— **libFLAC 每编好一帧回调一次**,
 *     回调参数直接给出 `(data, numberOfBytes, samples, currentFrame)`,
 *     `samples` 就是这一帧的样本数(时间线推进的唯一权威值);
 *   - `FLAC__stream_encoder_process_interleaved(id, Int32Array, n)` 同步喂 PCM。
 *
 * 回调分两类,必须区分:
 *   - **元数据回调**(前 3 次):`fLaC`(4B)、STREAMINFO 块(38B)、VORBIS_COMMENT 块(44B),
 *     `samples === 0` 且首字节不是 `0xFF` → 只用于拼出 `codec_header`,**不下发**;
 *   - **音频帧回调**:首字节 `0xFF 0xF8/F9`、`samples > 0` → **每帧一个包**直接下发。
 *
 * 这样服务端产出的字节与设备期望**逐字节同构**:`stream/start.codec_header`
 * 给一次 STREAMINFO,之后每个 chunk 恰好一帧。
 */
export class LibFlacEncoder implements ChunkEncoder {
  private readonly Flac: LibFlacModule;
  private encId = 0;
  private closed = false;
  /** 每帧回调暂存:process_interleaved 是同步的,回调在调用栈内触发。 */
  private out: EncodedChunk[] = [];
  /** 元数据字节累积(fLaC + STREAMINFO + VORBIS_COMMENT),用于拼 codec_header。 */
  private metaChunks: Uint8Array[] = [];
  private metaLen = 0;
  private metaDone = false;
  private realHeaderB64: string | null = null;
  private frameCount = 0;
  /** 首个音频帧的样本数(诊断用;libFLAC 自选块大小,通常 4096)。 */
  private firstFrameSamples = 0;

  constructor() {
    const req = createRequire(import.meta.url);
    const factory = req("libflacjs") as (variant?: string) => LibFlacModule;
    // ⚠️ 必须用 asm.js 变体(`release`,不带 `.wasm`):
    // WASM 变体在 Node 下会走浏览器的 `fetch(wasmPath)` 分支 → "unknown scheme" 直接崩;
    // asm.js 是纯 JS,零加载配置、零镜像改动。
    this.Flac = factory("release");
    // libFLAC 是**异步**初始化的:首次 require 后要过一轮 tick 才 isReady()。
    // 服务端启动时会 `await waitFlacEncoderReady()` 预热;这里再兜一层 ——
    // 若仍不 ready 则同步抛错(调用方 encoderFor 会向上冒泡,不会静默产出空流)。
    if (!this.Flac.isReady()) {
      throw new Error(
        "libFLAC 尚未就绪:请在服务启动时 await waitFlacEncoderReady() 预热(见 encoding.ts)",
      );
    }
    this.openStream();
  }

  /** 建一条新的 libFLAC 编码流并挂写回调(构造 + flush 重建共用)。
   *  失败抛错:构造期由调用方处理;flush 重建失败则编码器停用(encode/flush 放空)。 */
  private openStream(): void {
    const id = this.Flac.create_libflac_encoder(
      SAMPLE_RATE,
      CHANNELS,
      FLAC_BIT_DEPTH,
      FLAC_COMPRESSION_LEVEL,
      0, // total_samples 未知(流式)
      true, // verify:编码器内部自校验,出错的帧会被 libFLAC 拒绝
      0, // block_size 0 = 编码器自选(对齐 MA:MA 明确不指定 block size)
    );
    if (!id) throw new Error("libflacjs 编码器创建失败(create_libflac_encoder 返回 0)");
    this.encId = id;
    this.Flac.init_encoder_stream(this.encId, (data, nbytes, samples, frame) => {
      this.onEncoded(data, nbytes, samples, frame);
    });
  }

  /** libFLAC 写回调。分「元数据」与「音频帧」两类,见类注释。 */
  private onEncoded(data: Uint8Array, nbytes: number, samples: number, frame: number): void {
    if (nbytes <= 0) return;
    const bytes = data.subarray(0, nbytes);
    if (!this.metaDone && (samples === 0 || bytes[0] !== 0xff)) {
      // 元数据块:fLaC(4B) → STREAMINFO(38B) → VORBIS_COMMENT(44B) → 可能还有 PADDING。
      this.metaChunks.push(new Uint8Array(bytes));
      this.metaLen += bytes.length;
      // libFLAC 的元数据在**首个音频帧之前**全部给出;一旦收满 42B 即可定 header。
      if (!this.realHeaderB64 && this.metaLen >= 42) {
        const merged = new Uint8Array(this.metaLen);
        let at = 0;
        for (const c of this.metaChunks) { merged.set(c, at); at += c.length; }
        const head = merged.subarray(0, 42);
        this.realHeaderB64 = flacCodecHeaderFromStream(head);
        this.verifyHeaderOnce(head);
      }
      return;
    }
    this.metaDone = true;
    this.frameCount++;
    if (this.firstFrameSamples === 0) this.firstFrameSamples = samples;
    // 每个回调恰好一帧 → 一个包。`samples` 由 libFLAC 直接给出,**不猜不解析**。
    this.out.push({
      data: new Uint8Array(bytes), // 必须拷贝:回调里的 data 指向 WASM/asm 堆,会被复用
      offsetMs: 0,
      frameSamples: samples,
    });
    void frame;
  }

  /** 首段真实 STREAMINFO 与 stream/start 声明比对(仅一次)。 */
  private verifyHeaderOnce(seg: Uint8Array): void {
    const declared = Buffer.from(flacCodecHeaderB64(), "base64");
    const got = Buffer.from(seg.subarray(0, 42));
    const dBps = Number((declared.readBigUInt64BE(18) >> 36n) & 0x1fn) + 1;
    const gBps = Number((got.readBigUInt64BE(18) >> 36n) & 0x1fn) + 1;
    const dSr = Number((declared.readBigUInt64BE(18) >> 44n) & 0xfffffn);
    const gSr = Number((got.readBigUInt64BE(18) >> 44n) & 0xfffffn);
    const dCh = Number((declared.readBigUInt64BE(18) >> 41n) & 0x7n) + 1;
    const gCh = Number((got.readBigUInt64BE(18) >> 41n) & 0x7n) + 1;
    if (dBps !== gBps || dSr !== gSr || dCh !== gCh) {
      console.warn(
        `[sendspin][flac] ⚠️ STREAMINFO 声明与实流不符! ` +
        `declared{bps=${dBps},sr=${dSr},ch=${dCh}} actual{bps=${gBps},sr=${gSr},ch=${gCh}} ` +
        `—— 设备会逐帧拒收导致无声;请修 flacCodecHeaderB64`,
      );
    }
  }

  getCodecHeaderB64(): string | null {
    return this.realHeaderB64;
  }

  /** 本编码器的真实输出块大小(libFLAC 自选值,通常 4096)。 */
  get fixedFrameSamples(): number | undefined {
    return this.firstFrameSamples || undefined;
  }

  /** 喂一批 F32/48k 立体声,同步返回本次产出的**帧**(每个包恰好一帧)。 */
  encode(pcmF32: Float32Array): Promise<EncodedChunk[]> {
    if (this.closed || !this.encId) return Promise.resolve([]);
    const samples = Math.floor(pcmF32.length / CHANNELS);
    if (samples <= 0) return Promise.resolve([]);
    // F32 [-1,1] → Int32(16bit 有效位,libFLAC 接受未左移的原始样本)
    const pcm = new Int32Array(samples * CHANNELS);
    for (let i = 0; i < pcm.length; i++) {
      const v = pcmF32[i];
      const s = v >= 1 ? 32767 : v <= -1 ? -32768 : Math.round(v * 32768);
      pcm[i] = s;
    }
    this.out = [];
    const ok = this.Flac.FLAC__stream_encoder_process_interleaved(this.encId, pcm, samples);
    if (!ok) {
      console.warn(`[sendspin][flac] libFLAC process_interleaved 失败 @frame=${this.frameCount}`);
      this.out = [];
      return Promise.resolve([]);
    }
    const out = this.out;
    this.out = [];
    return Promise.resolve(out);
  }

  /** 收尾:告知 libFLAC 不再有新样本,冲掉不足一块的尾帧(libFLAC 会以合法帧头写出)。
   *  ⚠️ `finish` 会**终结整条编码流** —— 之后再 `process_interleaved` 实测在
   *  asm 堆内空转永不返回(卡死整进程事件循环,连看门狗定时器都不触发)。
   *  而组编码器缓存在多次播报/切歌间复用(`SendspinGroup.encoderFor`),播报每次必
   *  flush → 不重建则第二次播报起全链卡死。因此 flush 在取走尾帧后**原地重建**
   *  一条新流,对象保持可用;新流的元数据回调照常重建 `codec_header`。 */
  flush(): Promise<EncodedChunk[]> {
    if (this.closed || !this.encId) return Promise.resolve([]);
    this.out = [];
    const ok = this.Flac.FLAC__stream_encoder_finish(this.encId);
    if (!ok) console.warn("[sendspin][flac] libFLAC finish 返回失败");
    const out = this.out;
    this.out = [];
    // 旧流已终结:先删后建,之后的新流与构造期行为一致。
    try {
      this.Flac.FLAC__stream_encoder_delete(this.encId);
    } catch { /* ignore */ }
    this.encId = 0;
    this.metaChunks = [];
    this.metaLen = 0;
    this.metaDone = false;
    this.realHeaderB64 = null;
    try {
      this.openStream();
    } catch (e) {
      console.warn(`[sendspin][flac] flush 后重建编码流失败,本编码器停用: ${(e as Error)?.message || e}`);
    }
    return Promise.resolve(out);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    const id = this.encId;
    this.encId = 0;
    if (!id) return;
    try {
      this.Flac.FLAC__stream_encoder_delete(id);
    } catch { /* ignore */ }
  }
}

/** libflacjs(asm.js 变体)导出的最小接口面,仅声明本项目用到的部分。 */
interface LibFlacModule {
  variant?: string;
  isReady(): boolean;
  onready?: (event: unknown) => void;
  create_libflac_encoder(
    sampleRate: number, channels: number, bitsPerSample: number, compression: number,
    totalSamples?: number, isVerify?: boolean, blockSize?: number,
  ): number;
  init_encoder_stream(
    id: number,
    write: (data: Uint8Array, nbytes: number, samples: number, frame: number) => void | false,
  ): void;
  FLAC__stream_encoder_process_interleaved(id: number, pcm: Int32Array, samples: number): boolean;
  FLAC__stream_encoder_finish(id: number): boolean;
  FLAC__stream_encoder_delete(id: number): boolean;
}

/** libFLAC 是否已异步就绪。首次构造 `LibFlacEncoder` 前必须为 true
 *  (`create_libflac_encoder` 依赖 Emscripten 运行时已初始化)。 */
export function isFlacEncoderReady(): boolean {
  try {
    const req = createRequire(import.meta.url);
    const factory = req("libflacjs") as (variant?: string) => LibFlacModule;
    return factory("release").isReady();
  } catch {
    return false;
  }
}

/** 等待 libFLAC 就绪(asm.js 变体在 Node 下是下一轮 tick 完成初始化)。`timeoutMs` 内未就绪返回 false。 */
export function waitFlacEncoderReady(timeoutMs = 5000): Promise<boolean> {
  return new Promise((resolve) => {
    let done = false;
    const finish = (ok: boolean) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(ok);
    };
    const timer = setTimeout(() => finish(false), timeoutMs);
    try {
      const req = createRequire(import.meta.url);
      const factory = req("libflacjs") as (variant?: string) => LibFlacModule;
      const Flac = factory("release");
      if (Flac.isReady()) return finish(true);
      Flac.onready = () => finish(true);
    } catch {
      finish(false);
    }
  });
}
