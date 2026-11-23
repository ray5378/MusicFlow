// ==================== AirPlay 设备延迟偏置：按设备自适应学习 ====================
//
// 为什么（2026-11-23 真机）：同一「全屋」组里 iEAST 配了 -500ms 才和 HiVi 对齐，
// 说明不同固件的接收缓冲天然不同。全房组里 HiVi 的 225ms 固定偏移让桥陷入
// 「判差 225ms → 插 225ms 静音 → 下个 tick 仍差 225ms」的死循环，10 秒后队列见底，
// 只剩静音垫片（用户听到「在播但没声」）。
//
// 对症做法：把「设备固有残差」学出来，落到锚点上（anchorShift），而不是让用户去调
// 成员延迟（那是组内同步用的，改了会把两台设备调岔）。
//
// 纪律：
//   · 只学**稳定同向**的残差（连续 N 次落在 ±40ms 内），单次抖动不动；
//   · 步长取残差的 1/2，单次最多 500ms，总偏置夹在 ±2000ms；
//   · 符号翻转即重新计数，避免把真实漂移学成偏置；
//   · 按设备（MAC）持久化，重连/换歌沿用，不用每次重新收敛。
import { getSetting, setSetting } from "../settings.js";
import { createLogger } from "../../utils/logger.js";

const log = createLogger("airplay-bias");

const KEY = "airplay.latencyBias";
/** 触顶告警节流表（设备 → 上次告警时刻） */
const saturateLoggedAt = new Map<string, number>();
/** 起学阈值：|残差| 小于它视为稳态噪声 */
const MIN_US = 40_000;
/** 同向稳定判定次数 */
const HITS_NEEDED = 5;
/** 慢通道单次最大步进（收敛稳一点，避免一次学飞） */
const STEP_CAP_US = 500_000;
/** fast 通道单次最大步进（成员变更/风暴时允许一次多走） */
const FAST_STEP_CAP_US = 2_000_000;
/**
 * 总偏置上限 = min(成员延迟量程 ±30s, 桥 insertCap 10s) = **10s**。
 * 2026-11-23 修正：原值 2s 是我照搬「非组同步模式」的 insertCap 拍的，比组同步模式
 * 真正的 10s 对齐窗口还小 ⇒ 2~10s 的残差会静默饱和，永远追不进去。
 */
const BIAS_CAP_US = 10_000_000;
/** 触顶告警节流（同一设备 60s 只报一次） */
const SATURATE_LOG_GAP_MS = 60_000;

export interface BiasRecord {
  /** 施加到锚点的偏置（µs，正 = 把锚点往后推） */
  biasUs: number;
  /** 连续同向残差计数 */
  hits: number;
  /** 上一次残差（µs） */
  lastDriftUs: number;
  updatedAt: number;
}

type BiasMap = Record<string, BiasRecord>;

function loadMap(): BiasMap {
  try {
    const raw = getSetting(KEY, "");
    if (!raw) return {};
    const m = JSON.parse(raw) as BiasMap;
    return m && typeof m === "object" ? m : {};
  } catch {
    return {};
  }
}

function saveMap(m: BiasMap): void {
  try {
    setSetting(KEY, JSON.stringify(m));
  } catch {
    /* 落盘失败不影响播放 */
  }
}

/** 取某设备当前学到的偏置（µs）。 */
export function getLatencyBiasUs(deviceId: string): number {
  const rec = loadMap()[deviceId];
  if (!rec || !Number.isFinite(rec.biasUs)) return 0;
  return Math.max(-BIAS_CAP_US, Math.min(BIAS_CAP_US, rec.biasUs));
}

/** 清掉某设备的偏置（排障用）。 */
export function resetLatencyBias(deviceId: string): void {
  const m = loadMap();
  delete m[deviceId];
  saveMap(m);
}

export interface BiasObserveResult {
  biasUs: number;
  /** 本次是否推进了偏置（用于日志/观测） */
  changed: boolean;
  hits: number;
}

/**
 * 纯学习函数（无 IO，便于单测）：给定上一次记录与本次残差，算出新记录。
 * 返回的新 biasUs 只在「稳定同向 + 达到次数」时才推进。
 */
export function learnStep(prev: BiasRecord | null, driftUs: number, now = Date.now()): BiasRecord {
  const base: BiasRecord = prev ?? { biasUs: 0, hits: 0, lastDriftUs: 0, updatedAt: now };
  if (!Number.isFinite(driftUs) || Math.abs(driftUs) < MIN_US) {
    return { ...base, hits: 0, lastDriftUs: driftUs, updatedAt: now };
  }
  const sameSign = Math.sign(driftUs) === Math.sign(base.lastDriftUs);
  const closeEnough = Math.abs(driftUs - base.lastDriftUs) < MIN_US;
  const hits = sameSign && closeEnough ? base.hits + 1 : 1;
  if (hits < HITS_NEEDED) {
    return { ...base, hits, lastDriftUs: driftUs, updatedAt: now };
  }
  // 稳定残差：按一半步长把锚点往残差方向推（正残差 = 内容落后 ⇒ 锚点后移）
  const step = Math.max(-STEP_CAP_US, Math.min(STEP_CAP_US, Math.round(driftUs / 2)));
  const biasUs = Math.max(-BIAS_CAP_US, Math.min(BIAS_CAP_US, base.biasUs + step));
  return { biasUs, hits: 0, lastDriftUs: driftUs, updatedAt: now };
}

/** fast 通道：一次到位（整步 = 残差本身，夹 ±STEP_CAP_US），用于成员进出群组/风暴。 */
export function fastStep(prev: BiasRecord | null, driftUs: number, now = Date.now()): BiasRecord {
  const base: BiasRecord = prev ?? { biasUs: 0, hits: 0, lastDriftUs: 0, updatedAt: now };
  if (!Number.isFinite(driftUs) || Math.abs(driftUs) < MIN_US) {
    return { ...base, hits: 0, lastDriftUs: driftUs, updatedAt: now };
  }
  const step = Math.max(-FAST_STEP_CAP_US, Math.min(FAST_STEP_CAP_US, Math.round(driftUs)));
  const biasUs = Math.max(-BIAS_CAP_US, Math.min(BIAS_CAP_US, base.biasUs + step));
  return { biasUs, hits: 0, lastDriftUs: driftUs, updatedAt: now };
}

/** 观测一次残差并持久化；返回当前生效的偏置。 */
/** 总开关：默认**关**。
 *  2026-11-23 真机教训：把「对齐残差」当设备固有偏差去学是错的 —— iEAST 的残差来自
 *  它自己的队空/抖动（realign 计数里大量是无动作的恒定漂移），学进去只会把偏置越推越大
 *  （实测推到 800ms+ 后 iEAST 连续 19 分钟灌静音、deltaUs≈-1174s）。要开必须显式设
 *  MF_AIRPLAY_BIAS=1，且只应在「残差稳定 + 队列健康」的前提下使用。 */
function biasEnabled(): boolean {
  return process.env.MF_AIRPLAY_BIAS === "1";
}

export function observeLatencyBias(
  deviceId: string,
  driftUs: number,
  opts: { fast?: boolean } = {},
): BiasObserveResult {
  if (!biasEnabled()) return { biasUs: 0, changed: false, hits: 0 };
  const map = loadMap();
  const prev = map[deviceId] ?? null;
  // fast：组内成员变更/重对齐风暴时，不等 5 个 tick，直接按整步推进（仍然夹在上限内）。
  const next = opts.fast ? fastStep(prev, driftUs) : learnStep(prev, driftUs);
  const changed = next.biasUs !== (prev?.biasUs ?? 0);
  map[deviceId] = next;
  saveMap(map);
  // 触顶告警：偏置已到上限但残差仍同向 ⇒ 不是「固件缓存差」，是会话/内容轴异常，必须人看。
  if (Math.abs(next.biasUs) >= BIAS_CAP_US && Math.sign(driftUs) === Math.sign(next.biasUs)) {
    const now = Date.now();
    const prevAt = saturateLoggedAt.get(deviceId) ?? 0;
    if (now - prevAt > SATURATE_LOG_GAP_MS) {
      saturateLoggedAt.set(deviceId, now);
      log.warn(
        `[airplay-bias] saturated device=${deviceId} bias=${next.biasUs}µs 残差仍为 ${Math.round(driftUs)}µs —— 已到 ${BIAS_CAP_US / 1e6}s 上限，需人工排查会话/内容轴`,
      );
    }
  }
  if (changed) {
    log.info(
      `[airplay-bias] device=${deviceId} 学到偏置 ${next.biasUs}µs（上次残差 ${Math.round(driftUs)}µs）`,
    );
  }
  return { biasUs: next.biasUs, changed, hits: next.hits };
}
