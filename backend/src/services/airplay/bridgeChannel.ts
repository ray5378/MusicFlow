/** MFAB 28B 帧编解码 + socket 会合路径(AirPlay 桥接 Phase 2,spec §4.1/§4.2)。
 *
 *  帧格式:28 字节小端头 + payload;
 *    offset 0  magic "MFAB" / 4 version=1 / 5 type / 6 flags(bit0=keyframe)
 *    offset 8  generation(u32) / 12 sequence(u32,同一 generation 内自增)
 *    offset 16 tsUs(i64,仅 AUDIO 有效) / 24 payloadLen(u32,上限 1 MiB)
 *  编解码为纯函数;流式解析器 FrameDecoder 正确处理 TCP 粘包/半包;
 *  非法 magic/version/type/payloadLen 立即抛错 —— 调用方必须断连,不得错位续读。
 *
 *  generation/sequence:sequence 由 FrameSequencer 管理,同一 generation 内自增、
 *  跨帧类型共享;generation 派生自 (epoch, timelineReseed)(§4.3,Phase 3 接入)。
 *
 *  socket 会合路径(§4.1):`<tmpdir>/mfab/<sha1(deviceId:token) 前 11 位 base36>.sock`,
 *  deviceId/token 只进 CONFIG payload 不进文件名;Windows 走命名管道;
 *  创建前断言路径 < 100 字节(sockaddr_un.sun_path 上限 108,留余量)。
 */

import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";

import { SENDSPIN_RATE } from "./rates.js";

// ---------------------------------------------------------------------------
// 帧常量
// ---------------------------------------------------------------------------

export const FRAME_MAGIC = "MFAB";
export const FRAME_VERSION = 1;
export const FRAME_HEADER_SIZE = 28;
/** payload 上限(spec §4.2:1 MiB)。 */
export const MAX_PAYLOAD_BYTES = 1024 * 1024;

export const FRAME_TYPE = { AUDIO: 1, BOUNDARY: 2, CONFIG: 3, HEARTBEAT: 4, STATS: 5 } as const;
export type FrameType = (typeof FRAME_TYPE)[keyof typeof FRAME_TYPE];

/** flags bit0=keyframe,其余保留。 */
export const FRAME_FLAG_KEYFRAME = 0x0001;

export interface BridgeFrame {
  type: FrameType;
  flags: number;
  generation: number;
  sequence: number;
  /** 仅 AUDIO 有效;其余帧恒 0n。 */
  tsUs: bigint;
  payload: Uint8Array;
}

// ---------------------------------------------------------------------------
// 编解码(纯函数)
// ---------------------------------------------------------------------------

/** 编码一帧(头 + payload,连续 Buffer)。payload 超上限立即抛错。 */
export function encodeFrame(frame: BridgeFrame): Buffer {
  if (frame.payload.byteLength > MAX_PAYLOAD_BYTES) {
    throw new Error(`mfab payload too large: ${frame.payload.byteLength} > ${MAX_PAYLOAD_BYTES}`);
  }
  const buf = Buffer.allocUnsafe(FRAME_HEADER_SIZE + frame.payload.byteLength);
  buf.write(FRAME_MAGIC, 0, 4, "latin1");
  buf.writeUInt8(FRAME_VERSION, 4);
  buf.writeUInt8(frame.type, 5);
  buf.writeUInt16LE(frame.flags & 0xffff, 6);
  buf.writeUInt32LE(frame.generation >>> 0, 8);
  buf.writeUInt32LE(frame.sequence >>> 0, 12);
  buf.writeBigInt64LE(frame.tsUs, 16);
  buf.writeUInt32LE(frame.payload.byteLength, 24);
  if (frame.payload.byteLength > 0) {
    payloadToBuffer(frame.payload).copy(buf, FRAME_HEADER_SIZE);
  }
  return buf;
}

function payloadToBuffer(payload: Uint8Array): Buffer {
  return Buffer.from(payload.buffer, payload.byteOffset, payload.byteLength);
}

/** payload → UTF-8 字符串(CONFIG/BOUNDARY 用)。 */
function payloadToUtf8(payload: Uint8Array): string {
  return payloadToBuffer(payload).toString("utf8");
}

/** 流式累积解析器:TCP 粘包/半包安全。
 *  非法 magic/version/type/payloadLen 抛 Error(调用方必须立即断连,不得错位续读)。 */
export class FrameDecoder {
  private buf: Buffer = Buffer.allocUnsafe(0);

  /** 喂入一段字节流,返回其中已完整收到的帧(0..n 帧)。 */
  push(chunk: Uint8Array): BridgeFrame[] {
    if (chunk.byteLength > 0) {
      const incoming = Buffer.isBuffer(chunk) ? chunk : payloadToBuffer(chunk);
      this.buf = this.buf.length === 0 ? incoming : Buffer.concat([this.buf, incoming]);
    }
    const frames: BridgeFrame[] = [];
    let off = 0;
    const total = this.buf.length;
    while (total - off >= FRAME_HEADER_SIZE) {
      if (this.buf.toString("latin1", off, off + 4) !== FRAME_MAGIC) {
        throw new Error(`mfab bad magic at offset ${off}`);
      }
      const version = this.buf.readUInt8(off + 4);
      if (version !== FRAME_VERSION) throw new Error(`mfab bad version ${version}`);
      const type = this.buf.readUInt8(off + 5);
      if (type < FRAME_TYPE.AUDIO || type > FRAME_TYPE.STATS) {
        throw new Error(`mfab bad frame type ${type}`);
      }
      const payloadLen = this.buf.readUInt32LE(off + 24);
      if (payloadLen > MAX_PAYLOAD_BYTES) {
        throw new Error(`mfab payload too large: ${payloadLen} > ${MAX_PAYLOAD_BYTES}`);
      }
      if (total - off < FRAME_HEADER_SIZE + payloadLen) break; // 半包,等下一段
      frames.push({
        type: type as FrameType,
        flags: this.buf.readUInt16LE(off + 6),
        generation: this.buf.readUInt32LE(off + 8),
        sequence: this.buf.readUInt32LE(off + 12),
        tsUs: this.buf.readBigInt64LE(off + 16),
        // 拷贝出独立 Buffer,避免整段接收缓冲被单帧引用滞留
        payload: Buffer.from(this.buf.subarray(off + FRAME_HEADER_SIZE, off + FRAME_HEADER_SIZE + payloadLen)),
      });
      off += FRAME_HEADER_SIZE + payloadLen;
    }
    if (off > 0) this.buf = Buffer.from(this.buf.subarray(off));
    return frames;
  }

  /** 当前未消费的字节数(诊断用)。 */
  get pendingBytes(): number {
    return this.buf.length;
  }
}

// ---------------------------------------------------------------------------
// 各类型帧的构造/解析帮助函数
// ---------------------------------------------------------------------------

export interface BridgeConfigPayload {
  deviceId: string;
  protocol: string;
  rate: number;
  channels: number;
  format: "s16le";
  sessionToken: string;
}

export type BridgeBoundaryReason = "track" | "seek" | "stop" | "rehost";

const BOUNDARY_REASONS: readonly BridgeBoundaryReason[] = ["track", "seek", "stop", "rehost"];

/** AUDIO payload = s16le/48000/2ch 原始 PCM(重采样在 airplay 侧做)。 */
export function encodeAudio(generation: number, sequence: number, tsUs: bigint, payload: Uint8Array): Buffer {
  return encodeFrame({ type: FRAME_TYPE.AUDIO, flags: 0, generation, sequence, tsUs, payload });
}

/** CONFIG:连接建立后发送端先发;generation/sequence 恒 0(握手先于流代次)。 */
export function encodeConfig(cfg: BridgeConfigPayload): Buffer {
  return encodeFrame({
    type: FRAME_TYPE.CONFIG, flags: 0, generation: 0, sequence: 0, tsUs: 0n,
    payload: Buffer.from(JSON.stringify(cfg), "utf8"),
  });
}

/** BOUNDARY:payload = {"reason":"track"|"seek"|"stop"|"rehost"},frame.generation 为新值。 */
export function encodeBoundary(generation: number, sequence: number, reason: BridgeBoundaryReason): Buffer {
  return encodeFrame({
    type: FRAME_TYPE.BOUNDARY, flags: 0, generation, sequence, tsUs: 0n,
    payload: Buffer.from(JSON.stringify({ reason }), "utf8"),
  });
}

/** HEARTBEAT:空 payload;接收端 2s 未收到任何帧判 stalled。 */
export function encodeHeartbeat(generation: number, sequence: number): Buffer {
  return encodeFrame({ type: FRAME_TYPE.HEARTBEAT, flags: 0, generation, sequence, tsUs: 0n, payload: new Uint8Array(0) });
}

/** 解析并校验 CONFIG payload(字段缺失/口径不符即抛,调用方断连)。 */
export function decodeConfigPayload(frame: BridgeFrame): BridgeConfigPayload {
  let raw: Partial<BridgeConfigPayload>;
  try {
    raw = JSON.parse(payloadToUtf8(frame.payload)) as Partial<BridgeConfigPayload>;
  } catch (err) {
    throw new Error(`config payload not JSON: ${(err as Error).message}`);
  }
  if (typeof raw.deviceId !== "string" || raw.deviceId.length === 0) throw new Error("config deviceId missing");
  if (typeof raw.sessionToken !== "string" || raw.sessionToken.length === 0) throw new Error("config sessionToken missing");
  if (typeof raw.protocol !== "string" || raw.protocol.length === 0) throw new Error("config protocol missing");
  if (raw.rate !== SENDSPIN_RATE) throw new Error(`config rate ${String(raw.rate)} != ${SENDSPIN_RATE}`);
  if (raw.channels !== 2) throw new Error(`config channels ${String(raw.channels)} != 2`);
  if (raw.format !== "s16le") throw new Error(`config format ${String(raw.format)} != s16le`);
  return raw as BridgeConfigPayload;
}

/** 解析并校验 BOUNDARY payload。 */
export function decodeBoundaryReason(frame: BridgeFrame): BridgeBoundaryReason {
  let raw: { reason?: unknown };
  try {
    raw = JSON.parse(payloadToUtf8(frame.payload)) as { reason?: unknown };
  } catch (err) {
    throw new Error(`boundary payload not JSON: ${(err as Error).message}`);
  }
  const reason = raw.reason;
  if (typeof reason !== "string" || !BOUNDARY_REASONS.includes(reason as BridgeBoundaryReason)) {
    throw new Error(`boundary reason ${String(reason)} 非法`);
  }
  return reason as BridgeBoundaryReason;
}

// ---------------------------------------------------------------------------
// generation / sequence 管理
// ---------------------------------------------------------------------------

/** sequence 发号器:同一 generation 内自增(跨帧类型共享),generation 切换时归零。 */
export class FrameSequencer {
  private gen = 0;
  private seq = 0;

  get generation(): number {
    return this.gen;
  }

  /** 切换到新流代次(§4.3:新歌/seek/rehost/重连),sequence 归零。 */
  reset(generation: number): void {
    this.gen = generation >>> 0;
    this.seq = 0;
  }

  /** 取下一个 sequence(u32 回绕安全)。 */
  take(): number {
    this.seq = (this.seq + 1) >>> 0;
    return this.seq;
  }
}

// ---------------------------------------------------------------------------
// socket 会合路径(§4.1)
// ---------------------------------------------------------------------------

/** 计算桥接 socket 路径:`<tmpdir>/mfab/<11 位 base36 hash>.sock`;
 *  Windows 用 `\\.\pipe\mfab-<hash>`。deviceId/token 只进 hash,不进文件名。
 *  @throws 路径 ≥ 100 字节时抛错(bind 前断言,spec §4.1)。 */
export function bridgeSocketPath(deviceId: string, token: string, platform: NodeJS.Platform = process.platform): string {
  const hash = createHash("sha1").update(`${deviceId}:${token}`, "utf8").digest("hex");
  // 取 sha1 前 64 bit 转 base36,取前 11 位(不足左补 0)—— 碰撞概率可忽略,
  // 且文件名与 deviceId/token 长度无关,恒定 11 字符。
  const name = BigInt(`0x${hash.slice(0, 16)}`).toString(36).padStart(11, "0").slice(0, 11);
  const p = platform === "win32"
    ? `\\\\.\\pipe\\mfab-${name}`
    : path.join(os.tmpdir(), "mfab", `${name}.sock`);
  if (Buffer.byteLength(p, "utf8") >= 100) {
    throw new Error(`mfab socket path too long (${Buffer.byteLength(p)}B, limit 100): ${p}`);
  }
  return p;
}
