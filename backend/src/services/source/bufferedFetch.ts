// ==================== 整曲内存缓冲 + 内存流出流注册表(batch44) ====================
//
// **要解决的问题**(240 生产实测):服务端断网几秒后恢复,之后所有播放都给不出真实
// 音频内容,但播放器进度条照常走 —— 僵尸流:上游死了下游响应没终止,客户端基于时间
// 推进的进度与实际内容脱节。另外插件源(lx 类)解析出的在线 URL 多为**临时外链**,
// 本身不稳定、有效期短:整曲一次取完反而是最稳策略。
//
// **做法**:在源解析之后的统一取流层(两条调用方链:/rest/stream 与 DLNA/AirPlay
// cast 出流,都经 resolveTranscodeInput)把**网络源**(web 插件行 / WebDAV 行)的歌曲
// 先整曲取进内存,再经 `/rest/membuf/:token` 回环喂 ffmpeg。取完之后播放/转码全走
// 内存,中途上游断网不影响本首。本地磁盘文件不经过本层。
//
// ### 保护(全部环境变量可调,读值在调用时发生,测试可按用例覆写)
// - 单文件上限(缺省 100MB):Content-Length 预检 + 流式累计双保险,超限回退直通;
// - 全局并发预算(缺省 300MB):进入时按单文件上限**悲观占位**判断
//   `inFlight + maxFile > budget ⇒ 拒绝`(选择「立即回退直通」而非等待 —— 等待会
//   把起播延迟叠加到不可控,直通是旧行为,永远安全);
// - 停摆看门狗(缺省 10s 无字节):abort 本次尝试,计入瞬时错误参与重试;
// - 总取流时长硬顶(缺省 18s):跨重试共享截止线,超时回退直通;
// - 瞬时错误有限重试(缺省 2 次,退避 400ms×attempt):网络抖动/5xx/429/停摆;
//   明确死亡(403/404/410 / 显式非音频 content-type / 空体)不重试。
//
// ### 失败语义(与「僵尸流修复」契约对齐)
// - `too-big` / `budget` / `timeout` ⇒ **回退直通**(loopbackRawStreamUrl 旧行为);
// - `dead` / `stalled` / `error` ⇒ **显式失败**(resolveTranscodeInput 返回 null ⇒
//   调用方回 fail,客户端收到明确错误走既有跳歌/重试,绝不发一个挂着的 200)。
//
// ### 与回环流代理(services/dlna/rawStreamCache.ts)的分层关系
// 本层在 rawStreamCache **上游**:缓冲成功时整条 rawStreamCache 被绕过(零上游往返);
// 缓冲回退直通时,行为与改动前完全一致(rawStreamCache 照常工作)。不重复建设、
// 不破坏其形态红线(首响应不等数据的性质由「回退直通」路径保住)。

import { randomBytes } from "node:crypto";
import { createLogger } from "../../utils/logger.js";

const log = createLogger("BUF-STREAM");

const MB = 1024 * 1024;

function envInt(name: string, dflt: number): number {
  const raw = process.env[name];
  const n = raw === undefined || raw === "" ? NaN : Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : dflt;
}

// ---------------- 配置常量(缺省值;env 覆盖见各字段) ----------------

/** 单文件缓冲上限(MB)。env `STREAM_BUFFER_MAX_MB`。 */
export const STREAM_BUFFER_MAX_FILE_MB = 100;
/** 全局并发缓冲预算(MB)。env `STREAM_BUFFER_BUDGET_MB`。 */
export const STREAM_BUFFER_BUDGET_MB = 300;
/** 停摆看门狗:连续无字节多久判停摆(ms)。env `STREAM_BUFFER_STALL_MS`。 */
export const STREAM_BUFFER_STALL_MS = 10_000;
/** 总取流时长硬顶(ms),跨重试共享。env `STREAM_BUFFER_TIMEOUT_MS`。 */
export const STREAM_BUFFER_TOTAL_TIMEOUT_MS = 18_000;
/** 首次失败后的额外重试次数(瞬时错误)。env `STREAM_BUFFER_RETRIES`。 */
export const STREAM_BUFFER_RETRIES = 2;
/** 重试退避基数(ms),实际 = 基数 × 第几次重试。env `STREAM_BUFFER_BACKOFF_MS`。 */
export const STREAM_BUFFER_BACKOFF_MS = 400;

interface BufferCfg {
  maxFileBytes: number;
  budgetBytes: number;
  stallMs: number;
  deadlineMs: number;
  retries: number;
  backoffMs: number;
}

function resolveCfg(over?: Partial<BufferCfg>): BufferCfg {
  return {
    maxFileBytes: over?.maxFileBytes ?? envInt("STREAM_BUFFER_MAX_MB", STREAM_BUFFER_MAX_FILE_MB) * MB,
    budgetBytes: over?.budgetBytes ?? envInt("STREAM_BUFFER_BUDGET_MB", STREAM_BUFFER_BUDGET_MB) * MB,
    stallMs: over?.stallMs ?? envInt("STREAM_BUFFER_STALL_MS", STREAM_BUFFER_STALL_MS),
    deadlineMs: over?.deadlineMs ?? envInt("STREAM_BUFFER_TIMEOUT_MS", STREAM_BUFFER_TOTAL_TIMEOUT_MS),
    retries: over?.retries ?? envInt("STREAM_BUFFER_RETRIES", STREAM_BUFFER_RETRIES),
    backoffMs: over?.backoffMs ?? envInt("STREAM_BUFFER_BACKOFF_MS", STREAM_BUFFER_BACKOFF_MS),
  };
}

// ---------------- 结果类型与语义 ----------------

export type BufferedKind =
  | "too-big"   // 超单文件上限 → 回退直通
  | "budget"    // 并发预算不足 → 回退直通
  | "timeout"   // 总时长硬顶 → 回退直通
  | "stalled"   // 上游停摆(重试耗尽) → 显式失败
  | "dead"      // 明确不可播(403/404/410/非音频/空体) → 显式失败
  | "error";    // 其它网络错误(重试耗尽) → 显式失败

export type BufferedFetchResult =
  | { ok: true; buf: Buffer; bytes: number; attempts: number; ms: number }
  | { ok: false; kind: BufferedKind; status?: number; attempts: number; ms: number; err?: string };

/** 显式失败类 kind(调用方不得回退直通,应让下游看到明确错误)。 */
export function isBufferedDeadKind(kind: BufferedKind): boolean {
  return kind === "dead" || kind === "stalled" || kind === "error";
}

/** content-type 明确非音频(JSON/text 错误体)—— 与 streamFallback.probe 同一把尺子。 */
function isExplicitNonAudioContentType(contentType: string | null): boolean {
  const ct = (contentType || "").split(";")[0].trim().toLowerCase();
  if (!ct) return false;
  return ct === "application/json" || ct.endsWith("+json") || ct.startsWith("text/");
}

// ---------------- 并发预算记账 ----------------

let inFlightBytes = 0;

/** 当前在途缓冲字节数(观测/测试用)。 */
export function bufferedInFlightBytes(): number {
  return inFlightBytes;
}

// ---------------- 停摆/截止 abort 原因 ----------------

class StallAbort extends Error {
  constructor() { super("stream-buffer: 上游停摆(连续无字节超时)"); this.name = "StallAbort"; }
}
class DeadlineAbort extends Error {
  constructor() { super("stream-buffer: 总取流时长超限"); this.name = "DeadlineAbort"; }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---------------- 单次尝试 ----------------

async function attemptOnce(
  url: string,
  headers: Record<string, string>,
  cfg: BufferCfg,
  deadlineLeftMs: number,
  outer?: { signal?: AbortSignal },
): Promise<BufferedFetchResult> {
  const t0 = Date.now();
  const ctrl = new AbortController();
  const onOuterAbort = () => ctrl.abort(new DeadlineAbort());
  if (outer?.signal) {
    if (outer.signal.aborted) return { ok: false, kind: "error", attempts: 1, ms: 0, err: "caller aborted" };
    outer.signal.addEventListener("abort", onOuterAbort, { once: true });
  }
  let stallTimer: ReturnType<typeof setTimeout> | null = null;
  let deadlineTimer: ReturnType<typeof setTimeout> | null = null;
  let downloaded = 0; // 已计入 inFlightBytes 的字节数(finally 里归还)
  const armStall = () => {
    if (stallTimer) clearTimeout(stallTimer);
    stallTimer = setTimeout(() => ctrl.abort(new StallAbort()), cfg.stallMs);
  };
  const disarm = () => {
    if (stallTimer) clearTimeout(stallTimer);
    if (deadlineTimer) clearTimeout(deadlineTimer);
    if (outer?.signal) outer.signal.removeEventListener("abort", onOuterAbort);
  };
  try {
    deadlineTimer = setTimeout(() => ctrl.abort(new DeadlineAbort()), Math.max(1, deadlineLeftMs));
    const res = await fetch(url, { headers, redirect: "follow", signal: ctrl.signal });
    if (res.status === 403 || res.status === 404 || res.status === 410) {
      await res.body?.cancel().catch(() => {});
      return { ok: false, kind: "dead", status: res.status, attempts: 1, ms: Date.now() - t0 };
    }
    if (res.status === 429 || res.status >= 500) {
      await res.body?.cancel().catch(() => {});
      // 瞬时状态 → 调用方决定是否重试
      return { ok: false, kind: "error", status: res.status, attempts: 1, ms: Date.now() - t0, err: `upstream ${res.status}` };
    }
    if (res.status !== 200 && res.status !== 206) {
      await res.body?.cancel().catch(() => {});
      return { ok: false, kind: "dead", status: res.status, attempts: 1, ms: Date.now() - t0 };
    }
    const ct = res.headers.get("content-type");
    if (isExplicitNonAudioContentType(ct)) {
      await res.body?.cancel().catch(() => {});
      return { ok: false, kind: "dead", status: res.status, attempts: 1, ms: Date.now() - t0, err: `non-audio content-type ${ct}` };
    }
    const cl = Number(res.headers.get("content-length") || "");
    if (Number.isFinite(cl) && cl > 0 && cl > cfg.maxFileBytes) {
      await res.body?.cancel().catch(() => {});
      return { ok: false, kind: "too-big", status: res.status, attempts: 1, ms: Date.now() - t0 };
    }
    if (!res.body) {
      return { ok: false, kind: "dead", status: res.status, attempts: 1, ms: Date.now() - t0, err: "empty body" };
    }
    armStall();
    const reader = res.body.getReader();
    const chunks: Buffer[] = [];
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      armStall();
      const chunk = Buffer.from(value);
      downloaded += chunk.length;
      inFlightBytes += chunk.length;
      if (downloaded > cfg.maxFileBytes) {
        await reader.cancel().catch(() => {});
        return { ok: false, kind: "too-big", status: res.status, attempts: 1, ms: Date.now() - t0 };
      }
      chunks.push(chunk);
    }
    if (downloaded === 0) {
      return { ok: false, kind: "dead", status: res.status, attempts: 1, ms: Date.now() - t0, err: "empty body" };
    }
    return { ok: true, buf: Buffer.concat(chunks), bytes: downloaded, attempts: 1, ms: Date.now() - t0 };
  } catch (e: any) {
    // abort 原因会原样作为 rejection 抛出(StallAbort/DeadlineAbort 是 Error 子类);
    // 无 reason 的 abort → DOMException(name=AbortError),只可能是外部 signal。
    if (e instanceof StallAbort) {
      return { ok: false, kind: "stalled", attempts: 1, ms: Date.now() - t0, err: e.message };
    }
    if (e instanceof DeadlineAbort) {
      return { ok: false, kind: "timeout", attempts: 1, ms: Date.now() - t0, err: e.message };
    }
    if (e?.name === "AbortError") {
      return { ok: false, kind: "error", attempts: 1, ms: Date.now() - t0, err: "aborted" };
    }
    return { ok: false, kind: "error", attempts: 1, ms: Date.now() - t0, err: String(e?.message || e).slice(0, 200) };
  } finally {
    disarm();
    inFlightBytes -= downloaded;
  }
}

/**
 * 整曲取进内存(带瞬时错误重试 / 停摆看门狗 / 总时长硬顶 / 单文件上限 / 并发预算)。
 * 失败语义见文件头;`opts` 逐项覆写配置(测试注入小超时用)。
 */
export async function fetchWholeSongBuffered(
  url: string,
  headers: Record<string, string> = {},
  opts?: { signal?: AbortSignal } & Partial<BufferCfg>,
): Promise<BufferedFetchResult> {
  const cfg = resolveCfg(opts);
  const t0 = Date.now();
  log.info(`buf-start ${url.slice(0, 120)} stall=${cfg.stallMs} deadline=${cfg.deadlineMs} retries=${cfg.retries} maxFile=${cfg.maxFileBytes} budget=${cfg.budgetBytes} inFlight=${inFlightBytes}`);
  // 预算判断:在途字节数已达预算 ⇒ 立即回退直通(不等待 —— 等待会把起播延迟叠成不可控)。
  // 不按单文件上限悲观占位:那会让 budget ≈ maxFile 的合法组合永远进不来。
  // 并发上界 = 预算 + 单文件上限(已入场的各自最多涨到 maxFile)。
  if (inFlightBytes >= cfg.budgetBytes) {
    log.warn("stream-buffer: 并发预算不足,回退直通", { inFlightBytes, budgetBytes: cfg.budgetBytes });
    return { ok: false, kind: "budget", attempts: 0, ms: 0 };
  }
  let attempts = 0;
  for (;;) {
    if (opts?.signal?.aborted) {
      return { ok: false, kind: "error", attempts, ms: Date.now() - t0, err: "caller aborted" };
    }
    attempts++;
    const left = cfg.deadlineMs - (Date.now() - t0);
    if (left <= 0) {
      return { ok: false, kind: "timeout", attempts, ms: Date.now() - t0, err: "deadline before attempt" };
    }
    const r = await attemptOnce(url, headers, cfg, left, { signal: opts?.signal });
    const transient = r.ok === false && (r.kind === "stalled" || r.kind === "error");
    if (r.ok || !transient || attempts > cfg.retries) {
      return r.ok ? r : { ...r, attempts, ms: Date.now() - t0 };
    }
    const backoff = Math.min(cfg.backoffMs * attempts, Math.max(0, cfg.deadlineMs - (Date.now() - t0)));
    if (backoff > 0) await sleep(backoff);
  }
}

// ==================== 内存流出流注册表 ====================
//
// 缓冲结果在这里登记,ffmpeg 经 `${loopbackBase()}/rest/membuf/:token` 回环取字节
// (路由在 routes/rest/index.ts,支持 Range —— ffmpeg 输入侧定位零上游往返)。
// 仅同进程服务进程消费(/rest/* 出流的 ffmpeg 都是主进程子进程;sendspin fork
// 子进程走的是 fetchRowBytes/WindowSource,不经本注册表),故用进程内存 Map 即可,
// **不**沿用 raw_stream_tokens 的 SQLite 形态。

/** 注册表条目空闲多久可回收。env `MEMBUF_TTL_MIN`(分钟)。 */
export const MEM_STREAM_TTL_MS = 10 * 60 * 1000;
/** 最多同时保留多少条。env `MEMBUF_MAX_ENTRIES`。 */
export const MEM_STREAM_MAX_ENTRIES = 16;
/** 注册表总字节上限。env `MEMBUF_MAX_TOTAL_MB`。 */
export const MEM_STREAM_MAX_TOTAL_BYTES = 400 * MB;

interface MemStreamEntry {
  buf: Buffer;
  mime?: string;
  at: number;
  /** 最近一次被消费(membuf 路由 GET)的时间。undefined = 注册后从未被消费。
   *  每次新 stream 请求都重新整曲缓冲(条目不复用),消费完的条目是死重,
   *  由 sweepMemStreams 按空闲阈值主动回收,不必等 TTL。 */
  lastReadAt?: number;
}

const memStreams = new Map<string, MemStreamEntry>();

function memCfg() {
  return {
    ttlMs: envInt("MEMBUF_TTL_MIN", MEM_STREAM_TTL_MS / 60000) * 60000,
    maxEntries: envInt("MEMBUF_MAX_ENTRIES", MEM_STREAM_MAX_ENTRIES),
    maxTotalBytes: envInt("MEMBUF_MAX_TOTAL_MB", MEM_STREAM_MAX_TOTAL_BYTES / MB) * MB,
  };
}

function memTotalBytes(): number {
  let n = 0;
  for (const e of memStreams.values()) n += e.buf.length;
  return n;
}

/** 登记一条内存流,返回不可猜 token。LRU + TTL + 总字节上限驱逐。 */
export function registerMemStream(buf: Buffer, mime?: string): string {
  const c = memCfg();
  const now = Date.now();
  for (const [k, v] of memStreams) {
    if (now - v.at > c.ttlMs) memStreams.delete(k);
  }
  while (memStreams.size > 0 && (memStreams.size >= c.maxEntries || memTotalBytes() + buf.length > c.maxTotalBytes)) {
    const oldest = memStreams.keys().next().value;
    if (oldest === undefined) break;
    memStreams.delete(oldest);
  }
  const token = randomBytes(16).toString("hex");
  memStreams.set(token, { buf, mime, at: now });
  return token;
}

/** 取一条内存流(命中即续期)。过期/不存在返回 null。
 *  `now` 仅供测试注入时间轴(生产不传 = Date.now(),行为不变)。 */
export function resolveMemStream(
  token: string,
  now: number = Date.now(),
): { buf: Buffer; mime?: string } | null {
  const e = memStreams.get(token);
  if (!e) return null;
  if (now - e.at > memCfg().ttlMs) {
    memStreams.delete(token);
    return null;
  }
  e.at = now;
  e.lastReadAt = now;
  return { buf: e.buf, mime: e.mime };
}

/** 测试用:清空注册表。 */
export function resetMemStreamsForTest(): void {
  memStreams.clear();
}

// ==================== 主动回收(周期清扫) ====================
// 旧机制只有注册时惰性驱逐(条数/总量/TTL),低流量时段消费完的整曲会驻留到
// TTL(10min)甚至更久 —— 而 membuf 条目按设计**不复用**(每次新 stream 请求都
// 重新整曲缓冲),滞留即死重。这里补两层:
//   1. 消费过的条目(lastReadAt 存在)空闲超过 MEM_STREAM_IDLE_RECYCLE_MS 即回收;
//   2. 从未消费的条目仍按 TTL 回收(给 ffmpeg 留足起播窗口)。
// sweepMemStreams 是纯函数(测试直调);模块级定时器每 60s 扫一轮,unref 不阻退出。
/** 消费后空闲回收阈值。ffmpeg 同 token 的 Range 重连间隔为秒级,120s 绰绰有余。 */
export const MEM_STREAM_IDLE_RECYCLE_MS = 120_000;
/** 清扫周期。 */
export const MEM_STREAM_SWEEP_INTERVAL_MS = 60_000;

export function sweepMemStreams(now: number = Date.now()): {
  removed: number;
  remaining: number;
  totalBytes: number;
} {
  const c = memCfg();
  let removed = 0;
  for (const [k, e] of memStreams) {
    const idleAt = Math.max(e.at, e.lastReadAt ?? 0);
    const limit = e.lastReadAt !== undefined ? Math.min(c.ttlMs, MEM_STREAM_IDLE_RECYCLE_MS) : c.ttlMs;
    if (now - idleAt > limit) {
      memStreams.delete(k);
      removed++;
    }
  }
  let totalBytes = 0;
  for (const e of memStreams.values()) totalBytes += e.buf.length;
  if (removed > 0) {
    log.info(`[membuf] 清扫回收 ${removed} 条,余 ${memStreams.size} 条/${Math.round(totalBytes / MB)}MB`);
  }
  return { removed, remaining: memStreams.size, totalBytes };
}

const memSweepTimer = setInterval(() => {
  try {
    sweepMemStreams();
  } catch { /* 清扫失败不影响主流程,下一轮重试 */ }
}, MEM_STREAM_SWEEP_INTERVAL_MS);
memSweepTimer.unref?.();

// ==================== D:取流失败长窗口自动重试(batch44) ====================
//
// 用户拍板节奏:新流取流失败(**完整取流尝试**失败,含其内部的瞬时短重试)后,服务端
// **挂起该请求**自动重试 —— 前 1 分钟每 10 秒一次 → 之后每 1 分钟一次 → 总窗口
// 30 分钟。窗口内任一次成功 ⇒ 立即整曲缓冲→正常供流(用户只感觉起播晚几秒);
// 窗口耗尽 ⇒ 显式失败(与 C3 契约一致:绝不发一个挂着的僵尸 200)。
//
// 分类边界(与上方失败语义表对齐,均不进入本窗口):
//   - `dead`(403/404/410/非音频/空体)= 明确死链:重试同一 URL 不会复活 ⇒ 立即
//     显式失败,客户端走跳歌/重解析,不给用户白等 30 分钟;
//   - `timeout` / `too-big` / `budget` = 「回退直通」类 ⇒ 立即返回,调用方落回
//     loopbackRawStreamUrl 旧行为(慢速大文件不该被挂 30 分钟)。
//   断网场景的真实形态恰好都落在窗口内:接口 down / 连接拒绝 ⇒ `error`;
//   建连黑洞(丢包不回 RST)⇒ undici 连接超时 ⇒ `error`;传输中途黑洞 ⇒
//   停摆看门狗 ⇒ `stalled`。
//
// single-flight:同歌曲(key=songId)的并发挂起请求共享同一个重试循环 —— 后到者直接
// await 先到者的 promise,不叠加上游压力。挂起等待阶段不占全局缓冲预算(预算只在
// fetchWholeSongBuffered 真正开始取流那一刻按在途字节记账)。每个调用方的 abort
// signal 单独登记为引用:**全部**调用方都断开才中止循环 —— 客户端提前超时掐断重发
// 的新请求要么加入在途循环、要么重启新循环,等效达成全程窗口(E 语义,服务端无需
// 特殊处理)。

/** 快节奏重试间隔(ms):前 1 分钟每 10 秒一次。env `STREAM_RETRY_FAST_MS`。 */
export const STREAM_RETRY_FAST_INTERVAL_MS = 10_000;
/** 慢节奏重试间隔(ms):之后每 1 分钟一次。env `STREAM_RETRY_SLOW_MS`。 */
export const STREAM_RETRY_SLOW_INTERVAL_MS = 60_000;
/** 快节奏重试次数(10s × 6 ≈ 覆盖前 1 分钟)。env `STREAM_RETRY_FAST_COUNT`。 */
export const STREAM_RETRY_FAST_COUNT = 6;
/** 重试总窗口(ms),自首次取流尝试开始计。env `STREAM_RETRY_WINDOW_MS`。 */
export const STREAM_RETRY_WINDOW_MS = 30 * 60_000;

export interface RetryCfg {
  fastMs: number;
  slowMs: number;
  fastCount: number;
  windowMs: number;
}

function resolveRetryCfg(over?: Partial<RetryCfg>): RetryCfg {
  return {
    fastMs: over?.fastMs ?? envInt("STREAM_RETRY_FAST_MS", STREAM_RETRY_FAST_INTERVAL_MS),
    slowMs: over?.slowMs ?? envInt("STREAM_RETRY_SLOW_MS", STREAM_RETRY_SLOW_INTERVAL_MS),
    fastCount: over?.fastCount ?? envInt("STREAM_RETRY_FAST_COUNT", STREAM_RETRY_FAST_COUNT),
    windowMs: over?.windowMs ?? envInt("STREAM_RETRY_WINDOW_MS", STREAM_RETRY_WINDOW_MS),
  };
}

/** 可被 signal 打断的 sleep;返回 true=被打断。 */
function sleepAbortable(ms: number, signal?: AbortSignal): Promise<boolean> {
  return new Promise((resolve) => {
    if (signal?.aborted) { resolve(true); return; }
    const t = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve(false);
    }, ms);
    const onAbort = () => { clearTimeout(t); resolve(true); };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/** 长窗口重试循环本体(无 single-flight 包装,测试可直接驱动)。 */
async function runRetryWindowLoop(
  url: string,
  headers: Record<string, string>,
  opts: { signal?: AbortSignal } & Partial<BufferCfg> & Partial<RetryCfg>,
): Promise<BufferedFetchResult> {
  const rc = resolveRetryCfg(opts);
  const t0 = Date.now();
  let retryNo = 0;
  for (;;) {
    const r = await fetchWholeSongBuffered(url, headers, opts);
    if (r.ok) return r;
    // dead / too-big / budget / timeout:明确死链或回退直通类,不挂窗口立即返回。
    if (r.kind !== "stalled" && r.kind !== "error") return r;
    const elapsed = Date.now() - t0;
    if (elapsed >= rc.windowMs) {
      return {
        ...r,
        attempts: retryNo + 1,
        ms: elapsed,
        err: `retry window exhausted(${Math.round(rc.windowMs / 1000)}s): ${r.err || r.kind}`,
      };
    }
    retryNo += 1;
    const wait = Math.min(retryNo <= rc.fastCount ? rc.fastMs : rc.slowMs, rc.windowMs - elapsed);
    if (await sleepAbortable(wait, opts?.signal)) {
      return { ok: false, kind: "error", attempts: retryNo, ms: Date.now() - t0, err: "caller aborted during retry wait" };
    }
  }
}

// ---------------- single-flight 注册表 ----------------

interface SharedRetryLoop {
  /** 仍在等待本次循环的调用方数(含创建者);归零 ⇒ 中止无人消费的循环。 */
  refs: number;
  promise: Promise<BufferedFetchResult>;
  ctrl: AbortController;
}
const retryLoops = new Map<string, SharedRetryLoop>();

/**
 * 带长窗口自动重试 + 同曲 single-flight 的整曲取流(bufferNetworkSource 统一入口)。
 * `key` 用 songId;`opts` 同时透传 BufferCfg / RetryCfg 覆写(测试注入小节奏用)。
 */
export async function fetchSongWithRetryWindow(
  key: string,
  url: string,
  headers: Record<string, string> = {},
  opts?: { signal?: AbortSignal; singleFlight?: boolean } & Partial<BufferCfg> & Partial<RetryCfg>,
): Promise<BufferedFetchResult> {
  if (opts?.signal?.aborted) {
    return { ok: false, kind: "error", attempts: 0, ms: 0, err: "caller aborted" };
  }
  if (opts?.singleFlight === false) return runRetryWindowLoop(url, headers, opts);
  let shared = retryLoops.get(key);
  if (!shared) {
    const ctrl = new AbortController();
    const entry: SharedRetryLoop = { refs: 0, promise: null as unknown as Promise<BufferedFetchResult>, ctrl };
    entry.promise = runRetryWindowLoop(url, headers, { ...opts, signal: ctrl.signal }).finally(() => {
      retryLoops.delete(key);
    });
    shared = entry;
    retryLoops.set(key, entry);
  }
  const mine = shared;
  mine.refs += 1;
  let left = false;
  const onAbort = () => {
    if (left) return;
    left = true;
    mine.refs -= 1;
    if (mine.refs <= 0) mine.ctrl.abort();
  };
  opts?.signal?.addEventListener("abort", onAbort, { once: true });
  try {
    return await mine.promise;
  } finally {
    onAbort();
  }
}

/** 测试用:清空 single-flight 注册表。 */
export function resetRetryLoopsForTest(): void {
  retryLoops.clear();
}
