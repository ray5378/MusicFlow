/** 桥接数学(纯函数,零 IO —— AirPlay 桥接 Phase 1)。
 *
 *  职责(唯一出处,守卫 ③):时间↔样本换算、RAOP 锚点四字段(MAJ-09)、
 *  32 位模域换算(MAJ-10)、重采样群延迟补偿(MIN-01)、漂移校正计划。
 *
 *  常量出处见 rates.ts。 */

import { ntpFromHostUs, ntpToHostUs } from "../../utils/hostClock.js";
import {
  BRIDGE_COLD_START_LEAD_US,
  BRIDGE_END_DRAIN_SAFE_MAX_MS,
  BRIDGE_WARM_START_LEAD_US,
  RAOP_SAFETY_MS,
  RESAMPLE_GROUP_DELAY_OUT_SAMPLES,
} from "./rates.js";

// ---------------------------------------------------------------------------
// NTP ↔ RTP(32 位模域,MAJ-10)
// ---------------------------------------------------------------------------

/** 32.32 NTP → RTP 时间戳,**先 ToUint32 截断、再对齐 chunkLen**。
 *
 *  🔴 顺序写死:`2^32 % 352 = 224`,「先对齐后截断」会残 32 破坏 352 对齐;
 *  「先截断再对齐」恒残 0。
 *  🔴 必须用 `>>> 0`(ToUint32),不能用 `& 0xFFFFFFFF`(ToInt32 —— 边界处得 −1,
 *  负数让 `% chunkLen` 出负余数,对齐当场失效)。 */
export function ntpToRtpMod(ntp: bigint, rate: number, chunkLen: number): number {
  const raw = Number(((ntp >> 16n) * BigInt(rate)) >> 16n);
  let ts = raw >>> 0; // ① 先 ToUint32
  ts -= ts % chunkLen; // ② 再对齐
  return ts;
}

/** 可听时刻 t(host µs)→ RTP 包时间戳。`B + round((t−A)·rate/1e6)`,模 2^32。 */
export function rtpAt(tUs: bigint, anchorUs: bigint, baseTs: number, rate: number): number {
  const deltaUs = Number(tUs - anchorUs);
  const deltaFrames = Math.round((deltaUs * rate) / 1e6);
  return (baseTs + deltaFrames) >>> 0;
}

/** 输出样本序号 → 可听时刻(host µs)= A + index/rate。 */
export function audibleAtUs(sampleIndex: number, anchorUs: bigint, rate: number): bigint {
  return anchorUs + BigInt(Math.round((sampleIndex / rate) * 1e6));
}

// ---------------------------------------------------------------------------
// 锚点四字段(MAJ-09 / §3.3)
// ---------------------------------------------------------------------------

export interface BridgeAnchors {
  /** RTP base(RECORD 后选定,32 位回绕安全;baseTs/startTs/headTs 三者同值)。 */
  baseTs: number;
  startTs: number;
  headTs: number;
  /** = ntpFromHostUs(A′ − L);A′ = A + 群延迟补偿。 */
  startNtp: bigint;
  /** 补偿后的可听锚点(host µs)—— 即写进 startNtp 的那个映射锚点。 */
  anchorUsShifted: bigint;
}

/** 重采样群延迟(µs)= 16 输出样本 / rate。 */
export function groupDelayUs(rate: number): number {
  return (RESAMPLE_GROUP_DELAY_OUT_SAMPLES / rate) * 1e6;
}

/** 计算桥接锚点四字段(§3.3:四个必须一起写,漏 baseTs ⇒ positionSec 变垃圾)。
 *
 *  - `A` = anchorUs:本次桥流**内容首样本**应可听的 host µs;
 *  - 群延迟补偿(MIN-01,符号钉死):内容经重采样后实际出声点比内容时间晚 GD ⇒
 *    把映射锚点**后移**:`A′ = A + GD`。这样「经重采样的实际出声点」落回 A。
 *    (若把 A 定义成"映射锚点"则符号相反 —— 测试用脉冲方向断言防写反。)
 *  - `L` = latencyFrames / rate(接收端播放保持深度,**不得归零**);
 *  - `startNtp = ntpFromHostUs(A′ − L)`:映射时刻比可听时刻早一个 L,
 *    首包可听 = (A′−L)+L = A′;配合 RAOP 侧 offset4(headTs−latencyFrames),
 *    内容首样本实际出声 = A′ − GD + ... = A(补偿闭环)。
 *  - `B` = ntpToRtpMod(ntp(A′), rate, chunkLen) 或调用方给的预对齐 rtpBase。 */
export function computeBridgeAnchors(opts: {
  anchorUs: bigint;
  latencyFrames: number;
  rate: number;
  chunkLen?: number;
  /** 已按「截断+对齐」处理过的 RTP base;缺省从 A′ 推导。 */
  rtpBase?: number;
  /** 是否做重采样群延迟补偿(Phase 4):48k 直通(无重采样器)时传 false,
   *  否则 A′ 会多偏 16/48000 ≈ 0.333ms。缺省 true(44.1k 重采样路径,MIN-01)。 */
  compensateGroupDelay?: boolean;
}): BridgeAnchors {
  const chunkLen = opts.chunkLen ?? 352;
  const gdUs = opts.compensateGroupDelay === false ? 0 : groupDelayUs(opts.rate);
  const anchorUsShifted = opts.anchorUs + BigInt(Math.round(gdUs));
  const latencyUs = BigInt(Math.round((opts.latencyFrames / opts.rate) * 1e6));
  const startNtp = ntpFromHostUs(anchorUsShifted - latencyUs);
  const b =
    opts.rtpBase !== undefined
      ? opts.rtpBase >>> 0
      : ntpToRtpMod(startNtp, opts.rate, chunkLen);
  return { baseTs: b, startTs: b, headTs: b, startNtp, anchorUsShifted };
}

// ---------------------------------------------------------------------------
// 漂移校正(纯计划;±10ms @44.1k = 441 帧)
// ---------------------------------------------------------------------------

export interface DriftPlan {
  /** 内容落后(有洞)⇒ 补多少帧静音。 */
  insert: number;
  /** 内容超前(重叠)⇒ 裁多少帧。 */
  drop: number;
  /** 原始差 target − actual(帧)。 */
  diff: number;
}

/** 目标内容位置 vs 实际位置(帧)⇒ 校正计划。|diff| < 阈值(默认 441 帧 ≈10ms)不动作。 */
export function driftCorrection(
  targetFrames: number,
  actualFrames: number,
  opts?: { thresholdFrames?: number },
): DriftPlan {
  const diff = Math.round(targetFrames - actualFrames);
  const th = opts?.thresholdFrames ?? 441;
  if (diff >= th) return { insert: diff, drop: 0, diff };
  if (diff <= -th) return { insert: 0, drop: -diff, diff };
  return { insert: 0, drop: 0, diff };
}

// ---------------------------------------------------------------------------
// 启动 lead(MAJ-01:只进 anchorLead,不进 commonSendAheadUs)
// ---------------------------------------------------------------------------

/** 组的桥启动 lead:任一桥 cold ⇒ 4.5s;全部 warm ⇒ 2.5s;无桥 ⇒ 0。
 *  warm 语义严格 = 「该设备存在可复用、已完成 RECORD 的 RAOP 会话」(R2:
 *  cold/warm 是 airplay 侧事实,未收到 CONFIG 回执前一律按 cold 保守)。 */
export function bridgeStartLeadUs(bridges: ReadonlyArray<{ warm: boolean }>): number {
  if (bridges.length === 0) return 0;
  for (const b of bridges) if (!b.warm) return BRIDGE_COLD_START_LEAD_US;
  return BRIDGE_WARM_START_LEAD_US;
}

// ---------------------------------------------------------------------------
// 曲末排空的桥安全钳制(2026-11 真机:换歌 RTP 断流 3~7s)
// ---------------------------------------------------------------------------

/** `capEndDrainMs` 的结果。`drainMs === contentMs` ⇒ 未钳制。 */
export interface EndDrainCap {
  /** 入参:内容域排空量(ms,已按预填充上限截断,倍速折算前的值)。 */
  contentMs: number;
  /** 输出:实际可等待的排空量(ms)。组内无桥时**恒等于** contentMs。 */
  drainMs: number;
  /** 是否真的发生钳制(= drainMs < contentMs;仅在组内有桥时可能为 true)。 */
  clamped: boolean;
}

/** 曲末排空量的桥安全钳制(纯函数)。
 *
 *  组内**有桥成员** ⇒ 排空量必须让桥队列撑得住:排空期间 `pushLoop` 不再产料,
 *  桥侧队列只出不进,故上限 = `BRIDGE_QUEUE_HARD_CAP_MS − BRIDGE_END_DRAIN_MARGIN_MS`
 *  (取值理由见 rates.ts 的 BRIDGE_END_DRAIN_MARGIN_MS 注释)。
 *  组内**无桥**(纯 sendspin)⇒ 原值返回,行为与引入本函数前逐字节一致。
 *
 *  @param contentDrainMs 内容域排空量(ms);非有限值/≤0 一律归 0。
 *  @param hasBridges 组内是否存在桥成员(SendspinGroup.hasBridges())。
 */
export function capEndDrainMs(contentDrainMs: number, hasBridges: boolean): EndDrainCap {
  const contentMs = Number.isFinite(contentDrainMs) && contentDrainMs > 0 ? contentDrainMs : 0;
  if (!hasBridges) return { contentMs, drainMs: contentMs, clamped: false };
  const drainMs = Math.min(contentMs, BRIDGE_END_DRAIN_SAFE_MAX_MS);
  return { contentMs, drainMs, clamped: drainMs < contentMs };
}

/** RAOP 发送节拍:sendAt(t) = audibleAt(t) − L − SAFETY(§3.3)。 */
export function sendAtUs(audibleUs: bigint, latencyFrames: number, rate: number): bigint {
  const us = BigInt(Math.round((latencyFrames / rate) * 1e6)) + BigInt(RAOP_SAFETY_MS * 1000);
  return audibleUs - us;
}

export { ntpFromHostUs, ntpToHostUs };
