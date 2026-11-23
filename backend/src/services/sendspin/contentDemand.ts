// ==================== 广播投递的「消费需求」纯函数（零依赖、零 IO）====================
//
// 背景（2026-11-23 真机实测）：AirPlay 桥接改成「一次解码 → 广播给每设备独立队列」
// 之后，广播侧仍然是**开环**的：
//   · 泵按自己的节奏把内容产出到 `now + 59s` 那么远（pacing 只受顶层请求驱动）；
//   · 而投递侧只有一个写死的 horizon（`now + 4s + sendAhead`），窗口上沿远落后于
//     内容前沿 ⇒ 环里堆着一大段永不被投递的未来内容；
//   · 下游看到「内容充足」就继续全速产出，越堆越远，设备的可听域永远落空 ⇒ 饿死
//     （实测 pushed=2 / inQueueMs=0 / 大面积 late）。
//
// 闭环就一句话：**泵要不要加速，由「各设备已消费到哪」反向决定**，而不是由
// 泵自己产了多少决定。本模块只做纯计算，方便单测把边界钉死：
//   · `deliverWindow`  —— 本拍该广播哪一段内容（下沿贴着已消费水位，上沿只看
//                         未来 2s，别把未来内容提前塞进设备队列）；
//   · `shouldApproveBump` —— 泵的加速请求该不该放行（内容够就挂着，别越补越远）；
//   · `contentAheadUs`  —— 内容前沿超前当前时刻多少（诊断/日志用）。
//
// 纪律：本文件**禁止** import 任何业务模块、禁止读写 IO、禁止读时钟 —— 时间一律由
// 调用方通过 `DemandInput` 传入，否则单测无法确定性驱动。

/** 时间常量全部用微秒，与 sendspin 内部时间线同口径。 */
/** 投递窗口下沿允许比游标再往回看的余量：只补「刚刚错过」的 200ms，不追历史。 */
export const BEHIND_GRACE_US = 200_000;
/** 投递窗口上沿的前瞻量：只把未来 2s 内的内容交给设备队列（再远就是无谓积压）。 */
export const DELIVER_LOOKAHEAD_US = 2_000_000;
/** 游标落后超过这个量 ⇒ 判定「追不上」，直接跳到 now（宁可缺口也不追历史）。 */
export const CURSOR_JUMP_BEHIND_US = 1_000_000;
/** 泵的「内容够用」判据缺省值：内容前沿必须至少超前 now 6s，才算不缺料。 */
export const PUMP_LOOKAHEAD_DEFAULT_US = 6_000_000;
/** 设备的「已消费到哪算正常」判据：设备水位须超前 now 2s，否则说明它在挨饿。 */
export const DEVICE_LOOKAHEAD_US = 2_000_000;

/**
 * 需求计算的输入快照。所有字段都是「纯数值」，`0` 一律表示**未知/尚未开始**，
 * 而不是真实的 0 时刻 —— 内容时间线是单调递增的，ts 为 0 只可能是「还没数据」。
 */
export interface DemandInput {
  /** 当前时刻（微秒）。 */
  nowUs: number;
  /** 上次广播到的内容 ts（0 = 尚未开始）。 */
  cursorUs: number;
  /** 内容环里最新一帧的 ts（0 = 环空）。 */
  tailUs: number;
  /** 各设备最近一次成功投递的最小 ts（0 = 无设备成功投递过）。 */
  minDeviceTsUs: number;
}

/** 本拍可广播的内容区间（闭区间，微秒）。 */
export interface DeliverWindow {
  /** 下沿：窗口内的帧必须 `tsUs >= loUs`。 */
  loUs: number;
  /** 上沿：窗口内的帧必须 `tsUs <= hiUs`；扫环时遇到 `tsUs > hiUs` 直接 break。 */
  hiUs: number;
  /** 非 null ⇒ 游标落后太多，调用方应把游标**直接设为**该值（= now）并打日志告警。 */
  jumpToUs: number | null;
}

/**
 * 计算本拍的投递窗口。
 *
 * 语义（与设计文档 §6.2 一致）：
 *   · `loUs = max(now - 200ms, cursor)` —— 下沿既不能追太老的内容（超过 200ms 的
 *     历史帧投出去也来不及播），也不能跑到游标前面（那会重复广播）；
 *   · `hiUs = now + 2s` —— 上沿固定前瞻 2s，把「未来太远」的内容留在环里等下一拍；
 *   · 游标落后超过 1s（且游标已建立）⇒ `jumpToUs = now`：反正是过期内容，
 *     逐帧追只会让设备持续吃旧帧（真机表现为「越播越晚」），直接跳到现时点。
 *
 * 注意 `hiUs` 与 `loUs` 恒满足 `hiUs > loUs`（2s 前瞻 vs 最多回看 200ms 或 ≤ now 的
 * 游标），窗口不会退化成空区间，因此调用方无需特判。
 */
export function deliverWindow(i: DemandInput): DeliverWindow {
  const loUs = Math.max(i.nowUs - BEHIND_GRACE_US, i.cursorUs);
  const hiUs = i.nowUs + DELIVER_LOOKAHEAD_US;
  // 游标为 0（元数据缺失/换代刚重置）时不跳：此时没有「落后」概念，从头广播即可。
  const behind = i.cursorUs !== 0 && i.cursorUs < i.nowUs - CURSOR_JUMP_BEHIND_US;
  const jumpToUs = behind ? i.nowUs : null;
  return { loUs, hiUs, jumpToUs };
}

/**
 * 泵的加速请求（paceBump）该不该放行。
 *
 * 这是整个闭环的关键闸门 —— **只有「内容不够」时才允许加速**：
 *   · 内容不够：`tailUs === 0`（环空，必须产）或 `tailUs < now + lookaheadUs`；
 *   · 且设备落后：`minDeviceTsUs === 0`（还没有设备成功投递过 —— 未知即放行，
 *     否则起播阶段会永久卡死）或 `minDeviceTsUs < now + 2s`（设备水位没跑起来）。
 *
 * 两者必须**同时**满足。反例（为什么不能无条件放行）：240 2026-11-19 18:42 事故里
 * 前沿已超前 34.96s、连补 287 次、queueMs=0 —— 一帧都投不出，越补越死。
 *
 * @param lookaheadUs 内容「够用」的前瞻阈值，缺省 6s（可由调用方按组配置覆盖）。
 */
export function shouldApproveBump(i: DemandInput, lookaheadUs: number = PUMP_LOOKAHEAD_DEFAULT_US): boolean {
  const contentShort = i.tailUs === 0 || i.tailUs < i.nowUs + lookaheadUs;
  const deviceBehind = i.minDeviceTsUs === 0 || i.minDeviceTsUs < i.nowUs + DEVICE_LOOKAHEAD_US;
  return contentShort && deviceBehind;
}

/**
 * 内容前沿超前当前时刻多少（微秒，恒 ≥ 0）。
 * 环空时返回 0（没有前沿可言）。用于诊断日志与「是否已经产出过多」的判断。
 */
export function contentAheadUs(i: DemandInput): number {
  if (i.tailUs === 0) return 0;
  return Math.max(0, i.tailUs - i.nowUs);
}
