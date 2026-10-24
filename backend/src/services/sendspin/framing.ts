import { BIN_JSON, BIN_FRAGMENT_MORE, BIN_FRAGMENT_END, MAX_FRAGMENT_FIRST, MAX_FRAGMENT_NEXT } from "./constants.js";

export interface JsonMessage { type: string; payload?: any }

export const packJsonBody = (m: JsonMessage): Uint8Array =>
  new Uint8Array(Buffer.concat([Buffer.from([BIN_JSON]), Buffer.from(JSON.stringify(m), "utf8")]));

export const unpackJsonBody = (b: Uint8Array): JsonMessage =>
  JSON.parse(Buffer.from(b.subarray(1)).toString("utf8"));

// 音频二进制帧头 = **9B**:1B msg_type(0x04) + 8B 大端微秒时间戳。
//
// ⚠️⚠️ 这里**绝对不能**再塞任何额外字段(2026-09-17 真机实锤,事故级)。
//
// 设备侧 sendspin-cpp `client.cpp:process_binary_message()` 只剥 **1 字节 type**,
// 再把余下交给 `player_role.cpp:233 handle_binary()`:
//     static constexpr size_t BINARY_TIMESTAMP_SIZE = 8;
//     int64_t timestamp = be64_to_host(data);                       // 前 8B = 时间戳
//     send_audio_chunk(data + 8, len - 8, timestamp, CHUNK_TYPE_ENCODED_AUDIO);
// 即设备认为 **8B 之后全是编码音频**。
//
// 曾误信「MA 金标准 `>BqI`,13B 头(1B+8B ts+4B send_ahead)」而多塞 4 字节 ——
// 后果是 send_ahead 的 4 个字节被当成 FLAC 数据的前 4 字节送进 micro-flac:
//     解码器首字节从 `0xFF` 变成 send_ahead 的高位(`0x00`)
//     → 找不到 frame sync → 每个包都报
//       `sendspin.decoder: Serious error decoding FLAC file` +
//       `sendspin.sync_task: Failed to decode audio chunk`
//     → 表现为「状态 PLAYING、进度正常推进、日志刷屏报错、**完全无声**」。
//
// 证据链:抓取服务端实发首包,帧头为
//     `04 000000a217d7b622 000c3500` + `ff f8 ca 18 ...`
//   设备剥 1B → ts 恰好读对(000000a217d7b622)✓,
//   但 payload 起点是 `000c3500`(send_ahead 值 800000 的 BE 表示)✗。
//
// **send_ahead 不是 wire 字段**:整个 sendspin-cpp 源码库中 `send_ahead` 零出现;
// `stream/start` 的 player 对象只认 codec / sample_rate / channels / bit_depth /
// codec_header(见 protocol.cpp `process_player_stream_object`)。设备端调度完全依赖
// `server/time` 时钟同步来把 `timestamp` 换算到本地时钟 —— 提前量是设备自己的事,
// 服务端只需保证「timestamp 是真实的期望播放时刻」。
/** 音频二进制帧头是否携带 `send_ahead` 字段(4B,BE)。
 *
 *  = **线上协议口径开关**,不是本项目自选:
 *    - `13B`(默认) = 1B type + 8B 微秒时间戳 + **4B send_ahead**。
 *      当前 spec 口径:aiosendspin 10.x 的 `add_audio_chunk_listener` 回调第 4 参就是
 *      `send_ahead`,其文档原文 "Microseconds from the server's transmission of the
 *      chunk to server_timestamp_us";ESPHome 2026.10 起的 sendspin-cpp 同样按 13B 切。
 *      **发 9B 会被这类客户端多吃掉 4 字节** → FLAC 帧头 `ff f8 ca 88` 的前 4 字节被吞
 *      → 每包 `Error decoding FLAC frame: -2` → 状态 PLAYING、进度推进、**完全无声**。
 *    - `9B` = 旧固件(sendspin-cpp 0.7.2 及更早)口径,只有 type + 时间戳。
 *      用 `SENDSPIN_AUDIO_HEADER=9` 环境变量切回。
 *
 *  ⚠️ 历史注记:2026-09-17 真机上「多塞 4B 导致无声」成立,是因为**当时代码与固件
 *     都是 9B 口径**,多出来的 4B 被当成 FLAC 数据;如今固件已升到 13B 口径,
 *     方向反转。判据不是「谁多谁少」,而是**两端字节数必须一致**:
 *     客户端剥掉多少,B 起才是编码音频数据。 */
export const AUDIO_HEADER_SEND_AHEAD = (process.env.SENDSPIN_AUDIO_HEADER ?? "13").trim() !== "9";

export const packAudioChunk = (timestampUs: bigint, data: Uint8Array, sendAheadUs = 0): Uint8Array => {
  const extra = AUDIO_HEADER_SEND_AHEAD ? 4 : 0;
  const head = Buffer.allocUnsafe(9 + extra);
  head[0] = 0x04;
  head.writeBigInt64BE(timestampUs, 1);
  if (extra === 4) {
    // 饱和值语义同 MA:0 与 0xFFFFFFFF 表示「无意义」,此处按实际提前量写,钳到 u32。
    const v = Math.max(0, Math.min(0xffffffff, Math.round(sendAheadUs)));
    head.writeUInt32BE(v >>> 0, 9);
  }
  return new Uint8Array(Buffer.concat([head, Buffer.from(data)]));
};

export const parseAudioChunk = (b: Uint8Array): { timestampUs: bigint; data: Uint8Array } => {
  const ts = Buffer.from(b.subarray(1, 9)).readBigInt64BE(0);
  return { timestampUs: ts, data: b.subarray(AUDIO_HEADER_SEND_AHEAD ? 13 : 9) };
};

export function fragment(data: Uint8Array, origType: number): Uint8Array[] {
  if (data.length <= MAX_FRAGMENT_FIRST + 1) {
    return [new Uint8Array(Buffer.concat([Buffer.from([BIN_FRAGMENT_MORE, origType]), Buffer.from(data)]))];
  }
  const parts: Uint8Array[] = [];
  let off = 0;
  parts.push(
    new Uint8Array(
      Buffer.concat([Buffer.from([BIN_FRAGMENT_MORE, origType]), Buffer.from(data.subarray(0, MAX_FRAGMENT_FIRST))]),
    ),
  );
  off = MAX_FRAGMENT_FIRST;
  while (off < data.length) {
    const n = Math.min(MAX_FRAGMENT_NEXT, data.length - off);
    const end = off + n >= data.length;
    const head = end ? BIN_FRAGMENT_END : BIN_FRAGMENT_MORE;
    parts.push(
      new Uint8Array(Buffer.concat([Buffer.from([head]), Buffer.from(data.subarray(off, off + n))])),
    );
    off += n;
  }
  return parts;
}

export function reassemble(parts: Uint8Array[]): Uint8Array {
  let out = Buffer.alloc(0);
  for (let i = 0; i < parts.length; i++) {
    // 首帧头 = [MORE, orig_type]（2B），续帧头 = [MORE|END]（1B）
    const skip = i === 0 ? 2 : 1;
    out = Buffer.concat([out, parts[i].subarray(skip)]);
  }
  return new Uint8Array(out);
}