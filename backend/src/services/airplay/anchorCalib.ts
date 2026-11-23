// ==================== S8 校准闭环:anchorCalib 判定(纯函数 + globalThis 状态)====================
//
// 审计 P0:我们命令 anchorUs 后**从不测量设备实际何时出声** —— 没有测量就没有闭环。
// 本模块把「判定与迟滞」独立成纯函数(单测可确定性驱动),测量留在 bridgeSession
// (随 bridgeStats 上报),执行留在 control(bridgeNudgeDelayDevice 微调)。
//
// ===== 对标 MA =====
// MA 位置:providers/sendspin/playback.py:90 ANCHOR_REBASE_SIGNIFICANT_US(值 500_000,
//         语义=锚点移动超 500ms 才算**显著偏移**;player.py:2706-2711 同口径过滤)。
// MA 语义:小于显著阈值的偏差容忍并自然追赶,绝不为噪声抖动锚点。
// 我们:drift 阈值复用 contentDemand.CURSOR_JUMP_BEHIND_US(同值 500ms、同源语义);
//         迟滞 + 测量实例绑定是我们架构特有的防振荡机制(逐设备独立补偿)。
//
// [S8 复核②]AP2 会话**排除出判定面**:执行端 applyAnchorShift 对 AP2 直接
// return false(bridgeSession.ts),每 10s「判定→下发→false」是纯空转;且 AP2
// 的命令锚点 = warm re-anchor 的 now+lead,drift 公式在该形态下测不出设备偏差。
// 判定面只保留 RAOP(forceNow 形态,预期首包 = now_plan)。
//
// [S8 复核①]测量实例绑定(防 epoch 内棘轮):actualSendAtUs 每锚点 epoch 只测一次,
// 而 retimeByUs 只平移映射、不重置测量 ⇒ drift 冻结不变 ⇒ 若只按时间迟滞,每 10s
// 就会对**同一个冻结测量**再减一次同样的 drift = 无上限棘轮。修法:决策绑定测量
// 实例 —— 同一 actualSendAtUs 值只判一次;retime 后即便测量值不变也不会重复减。

import { CURSOR_JUMP_BEHIND_US } from "../sendspin/contentDemand.js";

/** 同一设备两次校准微调的最小间隔(ms)—— 防振荡迟滞(叠加在测量实例绑定之上)。 */
export const ANCHOR_CALIB_HYSTERESIS_MS = 10_000;

/**
 * drift 计算(µs,正 = 设备**出声晚于**命令锚点)。
 *
 * [S8 复核②]公式:`drift = actualSendAtUs − (commandedAnchorUs − firstPacketLeadUs)`
 * 其中 firstPacketLeadUs = 该会话首包的**预期提前量**(AP2 = 声明 latencyFrames→µs;
 * RAOP forceNow = 0,预期首包 = now_plan;RAOP 非 forceNow = L + SAFETY)。
 * 旧公式用 commandedLeadUs(= anchorUs − now_plan)会把计划时刻带进来:锚点对消后
 * drift ≡ actual − now_plan,测的是「计划→首包」墙钟差,与设备延迟无关 —— 已废弃。
 *
 * ⚠️ 边界(诚实标注):RAOP 的 L_true 精确值需解析设备 TIMING 包(raop.ts 现仅用
 * timing 做活性心跳),当前 L_true ≈ 声明 latency —— 判定面已排除 AP2,RAOP 上
 * L_true 级偏差的精确测量列为后续项。
 */
export function anchorDriftUs(actualSendAtUs: number, commandedAnchorUs: number, firstPacketLeadUs: number): number {
  if (!Number.isFinite(actualSendAtUs) || actualSendAtUs <= 0) return 0;
  if (!Number.isFinite(commandedAnchorUs) || commandedAnchorUs <= 0) return 0;
  if (!Number.isFinite(firstPacketLeadUs) || firstPacketLeadUs < 0) return 0;
  return actualSendAtUs - (commandedAnchorUs - firstPacketLeadUs);
}

const GKEY = "__mf_anchorCalib_v1";
type DeviceCalib = {
  /** 上次微调时刻(ms)。 */
  lastAdjustAtMs?: number;
  /** 上次参与决策的测量实例(actualSendAtUs 原值)—— 同值不再二次决策(防棘轮)。 */
  lastJudgedActualSendAtUs?: number;
};
type CalibState = { devices: Record<string, DeviceCalib> };

function calibState(): CalibState {
  const g = globalThis as unknown as Record<string, CalibState | undefined>;
  let s = g[GKEY];
  if (!s) {
    s = { devices: {} };
    g[GKEY] = s;
  }
  return s;
}

/** 测试注入:重置判定状态(生产永不调)。 */
export function resetAnchorCalibForTest(): void {
  calibState().devices = {};
}

/**
 * drift → 微调决策(µs,非 null = 建议对该设备 `bridgeNudgeDelayDevice` 施加的
 * **增量**;调用方负责与该设备的基准补偿合并后下发)。
 *
 * 判据(全部满足才调):
 *   ⓪ 非 AP2 会话 —— AP2 执行端 no-op(applyAnchorShift return false),排除出判定面
 *      (S8 复核②);
 *   ① 测量实例未判过 —— 同一 actualSendAtUs 值只判一次,防「测量冻结 + 时间迟滞
 *      到期」的无上限棘轮(S8 复核①);
 *   ② 显著性:|drift| > 500ms(复用 CURSOR_JUMP_BEHIND_US,对齐 MA
 *      ANCHOR_REBASE_SIGNIFICANT_US);
 *   ③ 迟滞:同一设备距上次调整 ≥ 10s(防测量噪声/多设备互相牵引振荡)。
 *
 * 符号:drift > 0(出声晚)⇒ 建议负向平移(提前出声),故返回 −round(drift)。
 */
export function anchorAdjustDecision(
  deviceId: string,
  actualSendAtUs: number,
  driftUs: number,
  nowMs: number,
  isAp2 = false,
): number | null {
  if (isAp2) return null; // ⓪ AP2 执行端 no-op,不决策
  if (!Number.isFinite(driftUs) || driftUs === 0) return null;
  const st = calibState();
  const d = st.devices[deviceId] ?? {};
  // ① 测量实例绑定:同一 actualSendAtUs 已判过 ⇒ null(哪怕时间迟滞早已到期)。
  if (d.lastJudgedActualSendAtUs === actualSendAtUs) return null;
  // ② 显著性
  if (Math.abs(driftUs) <= CURSOR_JUMP_BEHIND_US) {
    d.lastJudgedActualSendAtUs = actualSendAtUs; // 判过(不调),同值不再判
    st.devices[deviceId] = d;
    return null;
  }
  // ③ 时间迟滞(首次决策无约束)
  if (d.lastAdjustAtMs !== undefined && nowMs - d.lastAdjustAtMs < ANCHOR_CALIB_HYSTERESIS_MS) {
    return null; // 迟滞挡下:不记 lastJudged —— 若下次 tick 换了新测量实例仍可判
  }
  d.lastAdjustAtMs = nowMs;
  d.lastJudgedActualSendAtUs = actualSendAtUs;
  st.devices[deviceId] = d;
  return -Math.round(driftUs);
}
