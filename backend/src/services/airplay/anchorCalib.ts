// ==================== S8 校准闭环:锚点 drift 判定 + 迟滞(纯函数 + globalThis 状态)====================
//
// 审计 P0(2026-11-25):我们命令 anchorUs 后**从不测量设备实际何时出声** —— 没有测量
// 就没有闭环,2.2s 级的锚点偏差永远无人修正。本模块把「测量 → 判定 → 微调」三段中的
// **判定与迟滞**独立成纯函数(单测可确定性驱动),测量与执行留在 bridgeSession(上报)
// 与 control(调 bridgeSetDelayDevice 微调)。
//
// ===== 对标 MA =====
// MA 位置:providers/sendspin/playback.py:90 ANCHOR_REBASE_SIGNIFICANT_US(值 500_000,
//         语义=锚点移动超 500ms 才算**显著偏移**,才值得重锚/补偿;player.py:2706-2711
//         的播放侧锚点重锚判据同口径过滤)。
// MA 语义:小于显著阈值的偏差容忍并自然追赶,**绝不为噪声抖动锚点**。
// 我们:drift 判定阈值直接复用 contentDemand.CURSOR_JUMP_BEHIND_US(同值 500ms、
//         同源「显著偏移」语义);迟滞(同一设备 10s 内只调一次)是 MA 没有的补充 ——
//         MA 的锚点由库内统一调度,我们逐设备独立补偿,必须防两设备互相牵引振荡。

import { CURSOR_JUMP_BEHIND_US } from "../sendspin/contentDemand.js";

/** 同一设备两次校准微调的最小间隔(ms)—— 防振荡迟滞。 */
export const ANCHOR_CALIB_HYSTERESIS_MS = 10_000;

/**
 * drift 计算(µs,正 = 设备**出声晚于**命令锚点)。
 *
 * 测量口径:actualSendAtUs = 锚定后首块**实际发出**的墙钟。设备按声明 latency
 * **确定性渲染**(AP2/esp32:sendspin 按「帧头 ts − send_ahead」出声,见
 * bridgeCalib.ts 头注释)⇒ 实际出声 proxy = 实际发出 + commandedLeadUs。
 * drift = actualSendAtUs + commandedLeadUs − commandedAnchorUs。
 *
 * ⚠️ 已知边界(诚实标注):RAOP 设备的 L_true(真 latency)与声明值可能不等
 * (HiVi 不回 Audio-Latency,240 实测),该偏差需解析设备 TIMING(NTP 往返)才能
 * 精确测量 —— 判据阈值 500ms 下,发送面 proxy 的节拍粒度误差(≤1 拍)可忽略,
 * 但 L_true 级偏差(秒级)在 RAOP 上仍测不到,列为后续项(需 raop.ts 解析
 * timing 包内容;当前 timing 仅用于活性心跳 lastTimingAt/timingCount)。
 */
export function anchorDriftUs(actualSendAtUs: number, commandedAnchorUs: number, commandedLeadUs: number): number {
  if (!Number.isFinite(actualSendAtUs) || actualSendAtUs <= 0) return 0;
  if (!Number.isFinite(commandedAnchorUs) || commandedAnchorUs <= 0) return 0;
  return actualSendAtUs + commandedLeadUs - commandedAnchorUs;
}

const GKEY = "__mf_anchorCalib_v1";
type CalibState = { lastAdjustAtMs: Record<string, number> };

function calibState(): CalibState {
  const g = globalThis as unknown as Record<string, CalibState | undefined>;
  let s = g[GKEY];
  if (!s) {
    s = { lastAdjustAtMs: {} };
    g[GKEY] = s;
  }
  return s;
}

/** 测试注入:重置迟滞状态(生产永不调)。 */
export function resetAnchorCalibForTest(): void {
  calibState().lastAdjustAtMs = {};
}

/**
 * drift → 微调决策(µs,非 null = 建议对该设备 `bridgeSetDelayDevice` 施加的
 * **增量**;调用方负责与该设备的基准补偿合并后下发)。
 *
 * 判据(双门槛,均须满足):
 *   ① 显著性:|drift| > 500ms(复用 CURSOR_JUMP_BEHIND_US,对齐 MA
 *      ANCHOR_REBASE_SIGNIFICANT_US)—— 噪声级偏差容忍,不调;
 *   ② 迟滞:同一设备距上次调整 ≥ 10s —— 防测量噪声/多设备互相牵引造成振荡。
 *
 * 符号:drift > 0(出声晚)⇒ 建议负向平移(提前出声),故返回 −round(drift)。
 */
export function anchorAdjustDecision(deviceId: string, driftUs: number, nowMs: number): number | null {
  if (!Number.isFinite(driftUs) || driftUs === 0) return null;
  if (Math.abs(driftUs) <= CURSOR_JUMP_BEHIND_US) return null;
  const st = calibState();
  const last = st.lastAdjustAtMs[deviceId];
  // 无记录(该设备从未调过)⇒ 首次超限立即允许;初值若按 0 处理,小 nowMs 场景
  // (单测)会被迟滞误挡 —— 语义上「从未调过」就不该有迟滞约束。
  if (last !== undefined && nowMs - last < ANCHOR_CALIB_HYSTERESIS_MS) return null;
  st.lastAdjustAtMs[deviceId] = nowMs;
  return -Math.round(driftUs);
}
