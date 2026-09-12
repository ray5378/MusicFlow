// ==================== seek / stream / clear 语义 + 时钟收敛门 ====================
//
// 纯函数,便于单测。对接 server.ts 的命令处理:
//   - `server/command.stream.<codec>`: contains(family)] + 流时刻
//   - `stream/clear`: 复位会话状态
//   - seek 位置钳制到 [0, duration]。

export const DEFAULT_CONVERGE_MS = 3000;

export function clampPositionMs(requestedMs: number, durationMs: number): number {
  if (!Number.isFinite(requestedMs) || requestedMs < 0) return 0;
  if (Number.isFinite(durationMs) && requestedMs > durationMs) return durationMs;
  return Math.floor(requestedMs);
}

export function clockConverged(offsetUs: bigint, thresholdMs = DEFAULT_CONVERGE_MS): boolean {
  const ms = Math.abs(Number(offsetUs)) / 1000;
  return ms <= thresholdMs;
}

/** 收敛门:返回继续参与同步所需的等待声明(drift 聚合前须先收敛)。 */
export function driftAggregateGate(offsetsUs: bigint[], thresholdMs = DEFAULT_CONVERGE_MS): boolean {
  return offsetsUs.every((o) => clockConverged(o, thresholdMs));
}

export type StreamParams = {
  codec: string;
  sampleRate: number;
  channels: number;
  sendAheadMs: number;
};

export function buildStreamStart(params: StreamParams): { type: string; payload: Record<string, any> } {
  const { codec, sendAheadMs, sampleRate, channels } = params;
  const payload: Record<string, any> = {
    codec,
    send_ahead: Math.round(sendAheadMs),
    timestamp: 0,
  };
  if (codec === "pcm") {
    payload.containers = ["f32le"];
    payload.sample_rate = sampleRate;
    payload.channels = channels;
  } else if (codec === "flac") {
    payload.containers = ["flac"];
  } else if (codec === "opus") {
    payload.containers = ["ogg"];
  }
  return { type: "server/command.stream." + codec, payload };
}