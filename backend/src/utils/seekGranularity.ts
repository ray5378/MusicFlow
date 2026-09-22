/**
 * 拖动 seek 目标的精度契约 —— 「**最小粒度 1 秒**」。
 *
 * 硬约束(2026-09-22 事故):`GroupPump.pushLoop` 按 **25ms 帧栅格**取帧
 * (`lo = floor(pos / FRAME_MS) * frameSamples`,`FRAME_MS = 25`),而滑动窗口的
 * 基准是「毫秒 → 样本」换算(`PcmWindow.baseSample = floor(pos / 1000 * SR * CH)`)。
 * **只有 pos 是 25ms 整数倍时两者严格相等**;否则 `lo < baseSample` → `slice()`
 * 抛 `WindowEvictedError` → 主循环 `continue` 用同一游标重算 → 再抛 → 纯微任务
 * 自旋(不 await I/O) → 事件循环饿死 → 心跳/`poll` RPC 全排不上队 → 65s 看门狗
 * SIGKILL 重启 → frozen 兜底重投(位置仍是毫秒精度) → 再挂。
 *
 * 现场表现:HA 卡片 / Web 前端拖动进度条后**子进程被强杀**(supervisor 日志
 * 「悬挂 RPC 12~15 个 / 最后消息 70s 前」),而客户端正常 —— 因为客户端下发的是
 * `position.inSeconds`(整秒),1000 / 25 = 40,**整秒必然是 25ms 的整数倍**。
 *
 * 于是本契约把「整秒」固化成跨端统一粒度:所有拖拽入口(Web / HA 卡片 / 客户端 /
 * HA 集成)一律整秒,对齐客户端 `Duration.inSeconds`。代价 ≤999ms(向下取整),
 * 换来「目标恒落在帧栅格上」这一结构性保证。
 *
 * 三层防御,缺一不可:
 *   ① 各端入口对齐(本文件,最外层契约:别让非整秒值出门);
 *   ② `sendspin/streamEngine.ts::alignFrameMs` 帧栅格兜底(1/25s 粒度);
 *   ③ `streamSource.ts::PcmWindow.slice()` 亚帧容错 + `pushLoop` 淘汰护栏(机制上
 *      保证「每轮淘汰必然前进」,杜绝自旋)。
 *
 * 守卫:`backend/scripts/check-seek-granularity.mjs`(CI 阻挡式,见 ci.yml)。
 */

/** 拖拽 seek 的最小粒度(秒)。1 秒是 25ms 帧栅格的整数倍(1000 / 25 = 40)。 */
export const SEEK_GRANULARITY_SEC = 1;

/**
 * 把任意精度的 seek 目标对齐到 [SEEK_GRANULARITY_SEC] 的整数倍(向下取整)。
 *
 * 向下取整(而非四舍五入)是与客户端 `Duration.inSeconds` 严格同语义的选择:
 * 两端得到逐位相同的结果,不存在「客户端与网页拖同一位置落到不同秒」的偏差。
 * 负数 / 非有限值一律归 0(调用方无需再钳制下限)。
 */
export function alignSeekSeconds(seconds: number): number {
  if (!Number.isFinite(seconds)) return 0;
  return Math.max(0, Math.floor(seconds / SEEK_GRANULARITY_SEC) * SEEK_GRANULARITY_SEC);
}
