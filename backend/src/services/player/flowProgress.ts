// flow 会话的**可听边界**对外登记(2026-11-14)。
//
// 背景：flow 把整条队列拼成**一条连续流**，设备上报的 RelTime 是从起流开始的
// 累计秒（连续流不会在换曲时归零）。对外时间轴约定是**内容时间、且相对当前曲**，
// 因此 /status / WS 的 position 必须在「换曲后」减去当前曲在流里的起点。
//
// 这里登记的是 flow 会话**已经播出**的边界（itemStartSec，输出流秒），由出流路由
// 的可听时钟推进；消费方（DLNA pollState）只读。为什么不放在 QueueController：
// 边界是**编码器实际产出**的产物，队列层无从得知（交叉淡入会让每曲提前 8s 起播，
// 用"内容时长累加"估算必然错位）。
//
// 生命周期与会话一致：起流登记、会话结束清除；过期条目（>30s 未更新）视为失效，
// 避免进程内残留把某台设备的 position 永久改错。
export interface FlowProgress {
  /** index 对齐队列 items：第 i 首在**输出流秒**的起点（稀疏，跳过的曲缺失）。 */
  starts: number[];
  /** 本次 flow 会话对应的队列起始下标（队列可能被用户改短）。 */
  startIndex: number;
  /** 本会话的倍速（starts 是输出流秒，乘它换内容秒）。 */
  speed: number;
  /** 最后一次更新时刻（ms）。 */
  at: number;
}

const progress = new Map<string, FlowProgress>();
const MAX_AGE_MS = 30_000;

export function setFlowProgress(deviceId: string, p: Omit<FlowProgress, "at">): void {
  progress.set(deviceId, { ...p, at: Date.now() });
}

export function clearFlowProgress(deviceId: string): void {
  progress.delete(deviceId);
}

export function getFlowProgress(deviceId: string): FlowProgress | null {
  const p = progress.get(deviceId);
  if (!p) return null;
  if (Date.now() - p.at > MAX_AGE_MS) {
    progress.delete(deviceId);
    return null;
  }
  return p;
}

/**
 * 把「从起流累计的内容秒」换算成「相对当前曲的内容秒」。
 *
 * @param p        会话边界（输出流秒）
 * @param contentSec 当前累计内容秒（已按 speed 换算过）
 * @returns 相对当前曲的位置；无边界信息时返回 null（调用方保持原值）。
 */
export function flowRelativeContentSec(p: FlowProgress, contentSec: number): number | null {
  if (!p.starts.length) return null;
  let idx = 0;
  for (let i = 0; i < p.starts.length; i++) {
    const start = p.starts[i];
    if (typeof start !== "number") continue;
    if (start * p.speed <= contentSec + 1e-6) idx = i;
    else break;
  }
  const start = p.starts[idx];
  if (typeof start !== "number") return null;
  return Math.max(0, contentSec - start * p.speed);
}
