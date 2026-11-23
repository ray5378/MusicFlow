// ==================== 过期帧判据（播放器侧护栏）====================
//
// 语义：内容帧的 ts 是「组时间线上该帧应当被听到的时刻」。若一帧的可听时刻已经
// 过去超过 grace，它就**永远不该**再投给设备 —— 投了只会让设备把它判成 late
// （真机实测：late 上万、队列恒 0、静音垫片连垫 19 分钟）。
//
// 这里只做判据，不做缓冲；缓冲/游标由 PlayerRing 负责。判据独立成纯函数是为了
// 单测能直接盯住「什么情况下丢帧」这条契约。
export const LATE_FRAME_GRACE_US = 1_500_000n;

export function isStaleFrame(tsUs: bigint, nowUs: bigint, graceUs = LATE_FRAME_GRACE_US): boolean {
  return tsUs + graceUs < nowUs;
}
