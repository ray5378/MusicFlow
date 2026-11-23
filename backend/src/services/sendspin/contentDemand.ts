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
// —— 对齐 Music Assistant 的语义（/workspace/ma-ref，只读参照）——
// 关键判据都对照过 MA 的实现，差异逐条写在各常量/函数的注释里：
//   · MA `providers/sendspin/playback.py` 的 `_PRODUCER_BUFFER_LIMIT_US`（30s，
//     `push_stream.sleep_to_limit_buffer(30s)`：缓冲超 30s 生产者睡眠）——
//     与本模块 `PUMP_LOOKAHEAD_DEFAULT_US` 同一角色（生产者背压上限）；
//   · MA `providers/airplay/sendspin_bridge.py` 的 `BRIDGE_MIN_BUFFER_MS`（1s，
//     「整个流期间 Sendspin 保持给桥的最低缓冲」）与 warm lead 2.5s ——
//     与 `DELIVER_LOOKAHEAD_US` 同量级；
//   · MA `providers/sendspin/playback.py` 的 `ANCHOR_REBASE_SIGNIFICANT_US`（500ms，
//     「锚点移动超过它才算显著偏移、才值得立即发布/重锚」）——
//     与 `CURSOR_JUMP_BEHIND_US` 同一角色。
//
// 纪律：本文件**禁止** import 任何业务模块、禁止读写 IO、禁止读时钟 —— 时间一律由
// 调用方通过 `DemandInput` 传入，否则单测无法确定性驱动。

/**
 * 投递窗口下沿允许比游标再往回看的余量：只补「刚刚错过」的 200ms，不追历史。
 *
 * MA 对照：MA 的 `_JOIN_PROMOTE_TOLERANCE_US`（50ms）是「追赶处理器的输出何时
 * 接入实时管线」的容差，角色不同 —— 我们广播路径没有 DSP 追赶管线（新设备直接
 * 预灌到游标处），不存在等价的接入判据；200ms 是我们自己的止损线（老过 200ms 的
 * 帧投出去也来不及播）。**不采纳 50ms**：那是 MA join 晋升的判据，不是投递窗口的。
 */
export const BEHIND_GRACE_US = 200_000;
/**
 * 投递窗口上沿的前瞻量：只把未来 2s 内的内容交给设备队列（再远就是无谓积压）。
 *
 * MA 对照：MA airplay 桥的 warm start lead = 2.5s（`BRIDGE_WARM_START_LEAD_MS`，
 * = `AIRPLAY_LATE_JOIN_MIN_HEADROOM_MS`）、min_buffer = 1s（`BRIDGE_MIN_BUFFER_MS`，
 * 「整个流期间保持给桥的最低缓冲」）—— 我们 2s 落在两者之间，同量级。
 * 差异说明：MA 的桥由 aiosendspin 按该 lead 调度首发；我们的设备侧队列另有
 * 4s 背压闸（queuedMs > 4s 拒收），窗口 2s 只是「每拍最多预备这么多」，
 * 实际设备持有量由背压决定，两者不冲突。
 */
export const DELIVER_LOOKAHEAD_US = 2_000_000;
/**
 * 游标偏离（落后或超前）超过这个量 ⇒ 判定「追不上/遥不可及」，直接跳到 now。
 *
 * MA 对照（2026-11-24 对齐）：取 MA `ANCHOR_REBASE_SIGNIFICANT_US` 的 500ms ——
 * MA 的语义是「锚点移动超过 500ms 才算显著偏移，才值得立即发布时间线/重锚」；
 * 小于它的偏差 MA 选择容忍并自然追赶。我们同语义：≤500ms 的落后仍在窗口余量
 * 内可自然补齐，不值得跳（跳=丢内容）；>500ms 才触发重锚 + warn 日志。
 */
export const CURSOR_JUMP_BEHIND_US = 500_000;
/**
 * 泵的「内容够用」判据缺省值：内容前沿超前 now ≥ 30s 即视为不缺料，不再放行加速。
 *
 * MA 对照（2026-11-24 对齐）：取 MA `_PRODUCER_BUFFER_LIMIT_US` = 30s ——
 * MA 的生产循环每提交一片就 `sleep_to_limit_buffer(30s)`：缓冲超 30s 生产者睡眠。
 * 同一角色（生产者背压上限）。
 * 架构差异（为什么同样是 30s 但位置不同）：MA 是**每播放器**一条 PushStream，
 * 30s 缓冲直接堆在成员自己的时间线队列里；我们是**一份内容环广播**，设备队列
 * 被 2s 窗口 + 4s 背压刻意保持薄，环内超前内容不进设备 —— 它的角色是「泵/设备
 * 抖动的保险」（设备停 5s 再恢复时环里仍有料可喂），并由环容量
 * `LATE_JOIN_RING_MAX_US`(35s，含 1s 历史) 兜底，不会退化成「产到 59s 之外」
 * 的旧开环形状。历史教训（240 2026-11-19 18:42：前沿超前 34.96s、queueMs=0）
 * 的根因是**投递窗口写死**而非「内容超前」本身 —— 窗口已改为 now 驱动后，
 * 超前内容只滞留环内，不再阻塞投递。
 */
export const PUMP_LOOKAHEAD_DEFAULT_US = 30_000_000;
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
  /**
   * 非 null ⇒ 游标偏离过大（落后追不上，或超前到窗口够不着），调用方应把游标
   * **直接设为**该值（= now）并打日志告警。调用方可用 `cursor < now` 区分方向：
   * 落后跳 = 弃历史；超前跳 = 弃「够不着的未来」。
   */
  jumpToUs: number | null;
}

/**
 * 计算本拍的投递窗口。
 *
 * 语义：
 *   · `loUs = max(now - 200ms, cursor)` —— 下沿既不能追太老的内容（超过 200ms 的
 *     历史帧投出去也来不及播），也不能跑到游标前面（那会重复广播）；
 *   · `hiUs = now + 2s` —— 上沿固定前瞻 2s（量级对齐 MA 桥 warm lead 2.5s /
 *     min_buffer 1s，见常量注释），把「未来太远」的内容留在环里等下一拍；
 *   · **游标落后** >500ms（MA `ANCHOR_REBASE_SIGNIFICANT_US`）⇒ `jumpToUs = now`：
 *     反正是过期内容，逐帧追只会让设备持续吃旧帧（真机表现为「越播越晚」）；
 *   · **游标超前** 超出窗口上沿（> now + 2s）⇒ 同样 `jumpToUs = now`（对称保护，
 *     2026-11-24 补）：从旧开环版本热切过来时游标可能已被推到 now + 59s ——
 *     窗口内的帧全部 ≤ cursor 被跳过，设备会饿到 now 追上 cursor 为止
 *     （最长可达 57s 的静音）。跳回后窗口内的帧会被**再次广播**，依赖设备侧
 *     按 ts 去重（广播 sink 队列的既有不变量）保证不重复出声。
 *
 * 注意：只要调用方按约定先处理 `jumpToUs`（把游标归位到 now）再扫环，扫环时的
 * 窗口恒非空（`hiUs > loUs`：2s 前瞻 vs 最多回看 200ms 或 ≤ now 的游标），
 * 无需特判空窗口。
 */
export function deliverWindow(i: DemandInput): DeliverWindow {
  const loUs = Math.max(i.nowUs - BEHIND_GRACE_US, i.cursorUs);
  const hiUs = i.nowUs + DELIVER_LOOKAHEAD_US;
  // 游标为 0（元数据缺失/换代刚重置）时不跳：此时没有「落后」概念，从头广播即可。
  const behind = i.cursorUs !== 0 && i.cursorUs < i.nowUs - CURSOR_JUMP_BEHIND_US;
  // 超前判定不需要 cursor!==0 前置：cursor > now + 2s 必然非 0。
  const ahead = i.cursorUs > i.nowUs + DELIVER_LOOKAHEAD_US;
  const jumpToUs = behind || ahead ? i.nowUs : null;
  return { loUs, hiUs, jumpToUs };
}

/**
 * 泵的加速请求（paceBump）该不该放行。
 *
 * 这是整个闭环的关键闸门 —— **只有「内容不够」时才允许加速**：
 *   · 内容不够：`tailUs === 0`（环空，必须产 —— 闸门必须在环判空**之外**计算，
 *     否则环空那拍请求永远挂着、泵不产出、环保持空 ⇒ 死锁）或
 *     `tailUs < now + lookaheadUs`（缺省 30s，对齐 MA `_PRODUCER_BUFFER_LIMIT_US`，
 *     见常量注释）；
 *   · 且设备落后：`minDeviceTsUs === 0`（还没有设备成功投递过 —— 未知即放行，
 *     否则起播阶段会永久卡死）或 `minDeviceTsUs < now + 2s`（设备水位没跑起来）。
 *
 * 两者必须**同时**满足 —— MA 的单一低水位阈值（缓冲超 30s 即睡眠）在它的
 * 「每播放器独立 PushStream」架构里够用：缓冲只属于一台设备，水位即真相。
 * 我们是**一份环 + N 台设备**：内容够（环里堆着料）但设备全都没消费到（水位落后）
 * 时，瓶颈在设备/投递而非供给 —— 加速只会把料堆得更远，所以必须加第二条件。
 *
 * @param lookaheadUs 内容「够用」的前瞻阈值，缺省 30s（可由调用方按组配置覆盖）。
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
