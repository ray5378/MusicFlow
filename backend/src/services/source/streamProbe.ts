// ==================== 起播 TTFB 金丝雀探针(settings 驱动,默认关闭) ====================
//
// 定位(2026-10-13 用户拍板:「设置里加个探针开关,默认关闭,用户可以随时开关它」):
// 探针是**金丝雀**,不是播放链路的一环 —— 开不开完全由用户在「媒体获取」页决定。
// 它补的是真实流量覆盖不到的两块信号:
//   ① 空闲时段心跳:没人播的时候,真实流量分位是零信号;探针每小时一次,给出
//      「上游还活着、取链还通」的连续基线(240 这种个人实例一天 20h+ 空闲,
//      这是那段时间里唯一的连续信号);
//   ② 源配置静默腐烂检测:WebDAV 密码轮换 / 插件登录态过期 / 直链 403 不会
//      报错到用户面前,只表现为「某天开始播不了」—— 探针提前几小时暴露它。
// 繁忙的 7×24 服务器已有真实流量分位时,本探针边际价值下降,可以不开(kill switch
// 是设计的一部分,不是补丁)。
//
// 三条卫生条件(缺一条,探针就从金丝雀退化成噪声源):
//   ① 钉死具体 songId(用户在 UI 选):自动选歌会悄悄换测量对象,源死了天天误报;
//   ② 播放中避让:metrics 中间件对出流族请求调 noteStreamActivity(),最近
//      STREAM_PROBE_QUIET_MS 内起过播就推迟 —— 探针绝不与播放抢上行带宽;
//   ③ 失败仅在**状态翻转**时 warn(healthy→failing / failing→healthy),中间态转
//      debug:否则上游抽一小时,每小时一条 warn,真问题被淹没(与慢请求分级同哲学)。
//
// 与字面 `/rest/stream?timeOffset=1` 探针方案的有意偏差(报告 §9.1 [l7] 有记):
// 原始 B1 提案是打自己的 /rest/stream,但那条路要 Subsonic 鉴权(apiKey 只走 /v1)、
// 且会穿过整条缓冲机制(注册 membuf、等 6s 头窗、可能顶掉正在播的缓冲条目)——
// 探针反而可能干扰它要观测的对象。这里改为**直接打上游 URL**(与出流/预取共用
// 同一份 resolveNetworkInput 推导,见 ⑥ 一致性守卫):量的是同一段「上游+网络」腿,
// 不含本机处理;贴近播放体感的全链路分位由后续的真实流量 tap 补(独立任务)。
// 只读首字节即取消连接:每次探测出口流量 ≈ 一个 chunk(≤64KB),不碰播放路径任何
// 东西(rawStreamCache/membuf/prefetch/ffmpeg 全不碰),DB 仅 1 次主键读。
//
// env 旋钮(全部有默认,运维可调;settings 只管开关和歌曲,见 streamProbeConfig.ts):
//   STREAM_PROBE_INTERVAL_MS   探测间隔(默认 3600000=1h)
//   STREAM_PROBE_TTFB_WARN_MS  TTFB 告警线(默认 10000;超过即 warn,即便成功了)
//   STREAM_PROBE_TIMEOUT_MS    单次探测硬超时(默认 30000)
//   STREAM_PROBE_QUIET_MS      起播避让窗(默认 60000)
//   STREAM_PROBE_SAMPLES       环形缓冲样本数(默认 48)
//   STREAM_PROBE_SUMMARY_EVERY 每 N 次尝试打一条汇总 info(默认 24)

import { db } from "../../db/index.js";
import { songs } from "../../db/schema.js";
import { eq } from "drizzle-orm";
import { createLogger } from "../../utils/logger.js";
import { getStreamProbeSettings } from "./streamProbeConfig.js";
import { isNetworkSong, resolveNetworkInput, type SongLike } from "./networkInput.js";

const log = createLogger("STREAM-PROBE");

/** 读一个正整数毫秒型 env,非法/缺失/≤0 回落默认。 */
function envMs(name: string, def: number): number {
  const v = parseInt(process.env[name] || "", 10);
  return Number.isFinite(v) && v > 0 ? v : def;
}
const INTERVAL_MS = (): number => envMs("STREAM_PROBE_INTERVAL_MS", 3_600_000);
const TTFB_WARN_MS = (): number => envMs("STREAM_PROBE_TTFB_WARN_MS", 10_000);
const TIMEOUT_MS = (): number => envMs("STREAM_PROBE_TIMEOUT_MS", 30_000);
const QUIET_MS = (): number => envMs("STREAM_PROBE_QUIET_MS", 60_000);
const SAMPLES_MAX = (): number => envMs("STREAM_PROBE_SAMPLES", 48);
const SUMMARY_EVERY = (): number => envMs("STREAM_PROBE_SUMMARY_EVERY", 24);

/** 调度 tick 粒度:开关/歌曲改动后,最迟这个时间内静默生效(无需重启)。 */
const POLL_MS = 30_000;

// ==================== 状态(内存态,重启清零) ====================

export type ProbeHealth = "unknown" | "healthy" | "failing";

export interface ProbeSample {
  at: number;
  ttfbMs: number;
}

/** skip 的原因码(UI 状态行直接展示,便于用户自查「为什么没探」)。 */
export type ProbeSkipReason =
  | "disabled" // 开关关闭
  | "no-song" // 未选定探测歌曲
  | "recent-playback" // 避让窗内刚有起播
  | "song-missing" // 选定歌曲已不在库(被删/换了 id)
  | "not-network" // 选定行是本地直读/已缓存行,没有上游可量
  | "no-source" // 网络行但解析不出可用源(直链空、源被删、兜底解析失败)
  | "in-flight"; // 上一轮还在跑(single-flight)

export type ProbeOutcome =
  | { kind: "skipped"; reason: ProbeSkipReason }
  | { kind: "ok"; ttfbMs: number }
  | { kind: "fail"; error: string };

interface ProbeState {
  health: ProbeHealth;
  /** 最近一次探测调用的时间(skip 也记,供「上次运行」展示;不推进探测间隔闸)。 */
  lastRunAt: number;
  /** 最近一次**实际发起过网络请求**的时间(调度间隔闸按它算;skip 不算)。 */
  lastAttemptAt: number;
  /** 最近一次探测成功的时间。 */
  lastOkAt: number;
  lastTtfbMs: number | null;
  lastError: string | null;
  lastSkipReason: ProbeSkipReason | null;
  okCount: number;
  failCount: number;
  skipCount: number;
}

const state: ProbeState = {
  health: "unknown",
  lastRunAt: 0,
  lastAttemptAt: 0,
  lastOkAt: 0,
  lastTtfbMs: null,
  lastError: null,
  lastSkipReason: null,
  okCount: 0,
  failCount: 0,
  skipCount: 0,
};

/** TTFB 环形缓冲(只留最近 SAMPLES_MAX 条,算分位用)。 */
const samples: ProbeSample[] = [];

/** 最近一次出流族请求时间(metrics 中间件记;避让闸用)。0 = 本进程还没起过播。 */
let lastStreamActivityMs = 0;

/** single-flight:同一时间只允许一轮真实探测(调度 tick / UI 立即探 / 重启补跑共用)。 */
let running = false;

let timer: ReturnType<typeof setInterval> | null = null;

// ==================== 纯函数(可单测) ====================

/**
 * 最近秩(nearest-rank)分位:第 p 百分位 = 排序后第 ceil(p/100 × n) 个(1-based)。
 * 小样本下比线性插值稳(不会在两档之间造出不存在的值);空数组返回 null。
 */
export function percentileOf(values: number[], p: number): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx];
}

/** 出流族请求活动登记(metrics 中间件对 /rest/stream 族调用)。 */
export function noteStreamActivity(nowMs = Date.now()): void {
  lastStreamActivityMs = nowMs;
}

// ==================== 探测本体 ====================

/** 按 id 取库内行(仅探测路径用;返回原始行,networkInput 接受 SongLike)。 */
function lookupProbeSong(songId: string): SongLike | null {
  const row = db.select().from(songs).where(eq(songs.id, songId)).get() as any;
  return (row as SongLike) ?? null;
}

/** UI 展示用:探测歌曲的 id/标题/艺人(行不在库返回 null)。 */
export function describeProbeSong(songId: string): { id: string; title: string; artist: string } | null {
  if (!songId) return null;
  const row = lookupProbeSong(songId);
  if (!row) return null;
  return { id: String(row.id), title: String(row.title || ""), artist: String(row.artist || "") };
}

function recordSkip(reason: ProbeSkipReason, nowMs: number): ProbeOutcome {
  state.skipCount++;
  state.lastRunAt = nowMs;
  state.lastSkipReason = reason;
  log.debug(`[STREAM-PROBE] 跳过: ${reason}`, { at: nowMs });
  return { kind: "skipped", reason };
}

function pushSample(s: ProbeSample): void {
  samples.push(s);
  const max = SAMPLES_MAX();
  while (samples.length > max) samples.shift();
}

function recordOk(ttfbMs: number, nowMs: number): ProbeOutcome {
  state.lastRunAt = nowMs;
  state.lastAttemptAt = nowMs;
  state.lastOkAt = nowMs;
  state.lastTtfbMs = ttfbMs;
  state.lastError = null;
  state.lastSkipReason = null;
  state.okCount++;
  pushSample({ at: nowMs, ttfbMs });
  const prev = state.health;
  state.health = "healthy";
  if (ttfbMs > TTFB_WARN_MS()) {
    // 成功但慢:退化信号,即便健康也要 warn(这是告警线的本义)。
    log.warn(`[STREAM-PROBE] TTFB 超告警线: ${ttfbMs}ms > ${TTFB_WARN_MS()}ms`);
  } else if (prev === "failing") {
    log.info(`[STREAM-PROBE] 恢复健康: TTFB ${ttfbMs}ms`);
  } else {
    log.debug(`[STREAM-PROBE] ok: TTFB ${ttfbMs}ms`);
  }
  maybeSummary();
  return { kind: "ok", ttfbMs };
}

function recordFail(error: string, nowMs: number): ProbeOutcome {
  state.lastRunAt = nowMs;
  state.lastAttemptAt = nowMs;
  state.lastTtfbMs = null;
  state.lastError = error;
  state.lastSkipReason = null;
  state.failCount++;
  const prev = state.health;
  state.health = "failing";
  if (prev !== "failing") {
    // 只在状态翻转时 warn(healthy/unknown → failing);持续失败转 debug,防每小时一条噪音。
    log.warn(`[STREAM-PROBE] 探测失败(状态翻转为 failing): ${error}`);
  } else {
    log.debug(`[STREAM-PROBE] 仍 failing: ${error}`);
  }
  maybeSummary();
  return { kind: "fail", error };
}

function maybeSummary(): void {
  const attempts = state.okCount + state.failCount;
  const every = SUMMARY_EVERY();
  if (every <= 0 || attempts === 0 || attempts % every !== 0) return;
  const vals = samples.map((s) => s.ttfbMs);
  log.info(
    `[STREAM-PROBE] 汇总 近${vals.length}次: ` +
      `p50=${percentileOf(vals, 50)}ms p95=${percentileOf(vals, 95)}ms max=${vals.length ? Math.max(...vals) : "-"}ms ` +
      `ok=${state.okCount} fail=${state.failCount} skip=${state.skipCount}`,
  );
}

/**
 * 跑一轮探测。任何异常都吞掉转为 fail/skip 结果 —— 探针是观测器,
 * 绝不允许把异常抛进调度器或 HTTP 响应里。
 *
 * 顺序即优先级:disabled → no-song → recent-playback → song-missing → not-network
 * → no-source → 实测。避让闸放在查库前:播放中连 DB 都不读。
 */
export async function runProbeOnce(nowMs = Date.now()): Promise<ProbeOutcome> {
  if (running) return recordSkip("in-flight", nowMs);
  running = true;
  try {
    const cfg = getStreamProbeSettings();
    if (!cfg.enabled) return recordSkip("disabled", nowMs);
    if (!cfg.songId) return recordSkip("no-song", nowMs);
    if (lastStreamActivityMs > 0 && nowMs - lastStreamActivityMs < QUIET_MS()) {
      return recordSkip("recent-playback", nowMs);
    }
    const row = lookupProbeSong(cfg.songId);
    if (!row) return recordSkip("song-missing", nowMs);
    if (!(await isNetworkSong(row))) return recordSkip("not-network", nowMs);
    const net = await resolveNetworkInput(row);
    if (!net) return recordSkip("no-source", nowMs);

    const started = Date.now();
    try {
      const res = await fetch(net.url, {
        headers: net.headers,
        signal: AbortSignal.timeout(TIMEOUT_MS()),
      });
      if (!res.ok) return recordFail(`http-${res.status}`, Date.now());
      if (!res.body) return recordFail("no-body", Date.now());
      const reader = res.body.getReader();
      const first = await reader.read();
      await reader.cancel().catch(() => {
        /* 取消失败无所谓:连接终将超时关闭,不影响已测到的 TTFB */
      });
      const ttfbMs = Date.now() - started;
      if (first.done || !first.value || first.value.byteLength === 0) {
        return recordFail("empty-body", Date.now());
      }
      return recordOk(ttfbMs, Date.now());
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      const tag = e instanceof DOMException && e.name === "TimeoutError" ? "timeout" : msg;
      return recordFail(tag, Date.now());
    }
  } catch (e) {
    // 兜底:查库/解析层的意外异常也不许逃出探针。
    return recordFail(`internal:${e instanceof Error ? e.message : String(e)}`, nowMs);
  } finally {
    running = false;
  }
}

// ==================== 调度 ====================

/**
 * 挂载调度循环(幂等)。tick 每 30s 一次,但只有 enabled 且距上次**尝试**已过
 * INTERVAL_MS 才真探 —— 开关/歌曲改动静默生效,不需要重启,也不需要重建定时器。
 */
export function startStreamProbeScheduler(): void {
  if (timer) return;
  const tick = async (): Promise<void> => {
    try {
      if (running) return;
      const cfg = getStreamProbeSettings();
      if (!cfg.enabled) return;
      const now = Date.now();
      if (state.lastAttemptAt > 0 && now - state.lastAttemptAt < INTERVAL_MS()) return;
      await runProbeOnce(now);
    } catch (e) {
      log.warn("[STREAM-PROBE] tick failed: " + (e instanceof Error ? e.message : String(e)));
    }
  };
  timer = setInterval(() => void tick(), POLL_MS);
}

export function stopStreamProbeScheduler(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}

/** 调度器是否在跑(快照给 UI 展示「自动探测中/未挂载」)。 */
export function streamProbeSchedulerRunning(): boolean {
  return timer !== null;
}

// ==================== 快照 ====================

export interface StreamProbeSnapshot {
  enabled: boolean;
  songId: string;
  song: { id: string; title: string; artist: string } | null;
  health: ProbeHealth;
  lastRunAt: number;
  lastAttemptAt: number;
  lastOkAt: number;
  lastTtfbMs: number | null;
  lastError: string | null;
  lastSkipReason: ProbeSkipReason | null;
  ttfbWarnMs: number;
  samples: number;
  p50Ms: number | null;
  p95Ms: number | null;
  maxMs: number | null;
  counts: { ok: number; fail: number; skip: number };
  schedulerRunning: boolean;
  intervalMs: number;
  quietMs: number;
  timeoutMs: number;
  /** 最近 20 个样本(前端画迷你趋势点用;不含失败轮)。 */
  recent: ProbeSample[];
}

/** 全量快照:GET probe-settings 与 admin/metrics 共用(UI 状态行 + 运维面板同一份真源)。 */
export function getStreamProbeSnapshot(): StreamProbeSnapshot {
  const cfg = getStreamProbeSettings();
  const vals = samples.map((s) => s.ttfbMs);
  return {
    enabled: cfg.enabled,
    songId: cfg.songId,
    song: describeProbeSong(cfg.songId),
    health: state.health,
    lastRunAt: state.lastRunAt,
    lastAttemptAt: state.lastAttemptAt,
    lastOkAt: state.lastOkAt,
    lastTtfbMs: state.lastTtfbMs,
    lastError: state.lastError,
    lastSkipReason: state.lastSkipReason,
    ttfbWarnMs: TTFB_WARN_MS(),
    samples: vals.length,
    p50Ms: percentileOf(vals, 50),
    p95Ms: percentileOf(vals, 95),
    maxMs: vals.length ? Math.max(...vals) : null,
    counts: { ok: state.okCount, fail: state.failCount, skip: state.skipCount },
    schedulerRunning: timer !== null,
    intervalMs: INTERVAL_MS(),
    quietMs: QUIET_MS(),
    timeoutMs: TIMEOUT_MS(),
    recent: samples.slice(-20),
  };
}

/** 测试复位:清状态 + 停调度(配置表本身由 resetStreamProbeSettings 清)。
 *  running 一并复位:上一轮挂起的探测(如测试里流定时器没推进)不许污染下一轮。 */
export function resetStreamProbeForTest(): void {
  stopStreamProbeScheduler();
  running = false;
  samples.length = 0;
  lastStreamActivityMs = 0;
  state.health = "unknown";
  state.lastRunAt = 0;
  state.lastAttemptAt = 0;
  state.lastOkAt = 0;
  state.lastTtfbMs = null;
  state.lastError = null;
  state.lastSkipReason = null;
  state.okCount = 0;
  state.failCount = 0;
  state.skipCount = 0;
}
