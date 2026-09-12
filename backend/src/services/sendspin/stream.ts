// ==================== 推流引擎:时间线 + 每客户端独立编码 ====================
//
// 对照 MA server timeline(F32/48k stereo、norm_aligned monotonic)与
// aiosendspin server/stream.py(SendspinStreamSession)。decoder 输出 PCM,
// `SendspinStreamSession` 依每条流的 latency_func 计算 deadline 并逐客户端编码下发。
//
// 编码器注入(`EncodeFn`),便于纯单测用假编码器;e2e 用 ffmpeg 真实编码。
export const DEFAULT_SEND_INTERVAL_NS = 46_875_000; // ~21.33fps
export const MAX_DECODE_HEAD_ROOM_S = 1.5; // 解码超前余量(秒)
export const DEFAULT_SEND_AHEAD_MS = 800;

export type ClientStream = {
  client: any;
  sendAheadMs: number;
  latencyFuncMs: number;
  positionMs: number;
  bitrateBitsPerSec?: number;
  lastFrameN: number;
  encode: EncodeFn;
};

export type EncodeFn = (pcmF32: Float32Array, sampleRate: number, codec: string) => Uint8Array;

/** latency_func 的 slow_x3 是妙秒(s);latencyFuncMs ≈ slow_x3*1000*3。 */
export function latencyFuncToMs(slowXS3Seconds: number): number {
  return slowXS3Seconds * 1000 * 3;
}

/** frame < 0 → 视为过期。 */
export function isLate(dtMs: number): boolean {
  return dtMs < 0;
}

export type Timeline = { monotonicUs(): bigint };

export function serverFrameTimestampUs(
  timeline: Timeline,
  groupStartUs: bigint,
  sampleRate: number,
  framesProcessed: number,
): bigint {
  const playedUs = (framesProcessed / sampleRate) * 1_000_000;
  return groupStartUs + BigInt(Math.floor(playedUs));
}

export const defaultSendInterval = (): number => DEFAULT_SEND_INTERVAL_NS;

export const maxChunkSizeBytes = 1024 * 1024;

/** 纯函数:给定帧在流中的位置,判断是否已晚到无法追上链路。 */
export function frameDeadlineBehind(nowUs: bigint, chunkTsUs: bigint, sendAheadMs: number): boolean {
  const lead = Number(nowUs - chunkTsUs) / 1000;
  return lead > sendAheadMs + MAX_DECODE_HEAD_ROOM_S * 1000;
}

export class SendspinStreamSession {
  /** 解码时间线:server 视角单调微秒 */
  timeline: Timeline = { monotonicUs: defaultMonotonicUs };
  nowUs(): bigint {
    return this.timeline.monotonicUs();
  }
}

/** 进程内单调微秒时钟(默认)。 */
function defaultMonotonicUs(): bigint {
  const hr = process.hrtime.bigint();
  return hr / 1000n;
}