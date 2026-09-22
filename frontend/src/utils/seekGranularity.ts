/**
 * 拖动 seek 目标的精度契约 —— 「**最小粒度 1 秒**」。
 *
 * 硬约束(2026-09-22 事故):服务端 sendspin 流式引擎按 **25ms 帧栅格**取帧,
 * 而滑动窗口基准是「毫秒 → 样本」换算,**只有目标落在 25ms 整数倍上两者才严格
 * 相等**。目标不是 25ms 整数倍时子进程会陷入纯微任务自旋 → 事件循环饿死 →
 * 心跳超时被 65s 看门狗 SIGKILL(表现:拖完进度条后播放静默死掉)。
 *
 * 客户端下发的是 `Duration.inSeconds`(整秒),而 1000 / 25 = 40 —— **整秒必然是
 * 25ms 的整数倍**,这就是客户端一直正常、而网页/卡片拖动会挂的原因。
 *
 * 于是本契约把「整秒」固化成跨端统一粒度:对齐客户端 `inSeconds` 语义
 * (向下取整),所有拖拽入口一律整秒。代价 ≤999ms,换来「目标恒落在帧栅格上」。
 *
 * 服务端 `backend/src/utils/seekGranularity.ts` 有同语义的另一份实现(两个构建
 * 根无法共享源码,故各自持有一份)+ `POST /v1/peers/:peerId/seek` 入口再兜一层;
 * 本文件是最外层契约:**别让非整秒值出门**。
 *
 * 守卫:`backend/scripts/check-seek-granularity.mjs`(CI 阻挡式,见 ci.yml)。
 */

/** 拖拽 seek 的最小粒度(秒)。1 秒是 25ms 帧栅格的整数倍(1000 / 25 = 40)。 */
export const SEEK_GRANULARITY_SEC = 1;

/**
 * 把任意精度的 seek 目标对齐到 [SEEK_GRANULARITY_SEC] 的整数倍(向下取整)。
 *
 * 向下取整(而非四舍五入)是为了与客户端 `Duration.inSeconds` 严格同语义:
 * 同一位置在客户端与网页上得到逐位相同的秒数。负数 / 非有限值一律归 0。
 */
export function alignSeekSeconds(seconds: number): number {
  if (!Number.isFinite(seconds)) return 0;
  return Math.max(0, Math.floor(seconds / SEEK_GRANULARITY_SEC) * SEEK_GRANULARITY_SEC);
}
