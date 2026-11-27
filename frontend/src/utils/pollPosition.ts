/**
 * 投屏轮询回写的**单向防抖**（纯函数）—— 与 Flutter 客户端
 * `cast_peer_policy.dart::adoptPolledPosition` / HA 卡片
 * `_adoptProjectedPosition` 同款语义，三端一致。
 *
 * 背景：服务端把 position 报到 0.1s 精度，外推值 `采样 + (now − reportedAt)`
 * 每 2s（Web castPoll 周期）重新对齐一次。截断误差 + 网络往返让它有时比本地
 * 250ms tick 已推进的 `st.currentTime` 小 0.1~0.3s，写回即「进度条往前走时
 * 轻微后跳」。
 *
 * 规则（只拦「同曲内的小回退」，其余一律采纳）：
 *   - projected < local 且差距 ≤ toleranceSec（默认 0.5s）→ 返回 local，不采纳；
 *   - 前进（projected ≥ local）→ 返回 projected（真前进、真纠偏不受影响）；
 *   - 大回退（差距 > 容差）→ 返回 projected（真 seek 不能被吞）；
 *   - 非同一首歌（sameSong=false）→ 返回 projected（换歌起点原样采纳）。
 *
 * 单向 + 同曲是安全线：seek 由 castPoll 的 seekIssued 守卫在前挡住，换歌靠
 * sameSong=false 兜底（切歌极快、旧歌进度尚 <0.5s 时不吞新曲起点）。
 * 容差 0.5s 覆盖 0.1s 精度 + 网络抖动，又不至于掩盖真实跑偏。
 */
export function adoptPolledPosition(
  projected: number,
  local: number,
  sameSong = true,
  toleranceSec = 0.5,
): number {
  if (!sameSong) return projected;
  const back = local - projected;
  return back > 0 && back <= toleranceSec ? local : projected;
}
