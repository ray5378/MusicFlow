// ==================== 下一首预缓冲（后台预热 membuf，2026-10-12） ====================
//
// **要解决的问题**（240 生产实测）：播放队列里下一首若是天翼网盘（`w:` WebDAV 行）或插件在线源
// （`web` 行）的大文件，`/rest/stream` 的整曲内存缓冲要等上游取完才吐第一个字节 —— 实测 3~10s，
// 慢的那首直接撞 18s 硬顶回退直通，客户端首播体验差并触发反代超时。
//
// **做法**：服务端在切歌事件里用 `peekUpcomingPositions` 算出下一首，后台 fire-and-forget 把整曲
// 取进 membuf 并记到 `songId → token` 索引；用户真切过去时 `resolveTranscodeInput` 同步命中，
// 首字节从「等上游」变成「一次 Map 查找」。
//
// ### 三条红线（违反即事故，测试已锁）
//   1. **绝不共用播放路径的 single-flight**。`fetchSongWithRetryWindow` 的 key 是 `song:${songId}`，
//      与正在播的那条共用一个循环 —— 预取若先建循环，播放请求会**继承预取的 cfg**（30 分钟重试窗被
//      改短 / 后台任务被挂 30 分钟）。故这里只用 `fetchWholeSongBuffered`，去重**自己维护**。
//   2. **绝不动播放路径的超时**。放宽（deadline 120s / stall 30s）只发生在后台预取；
//      `STREAM_BUFFER_TOTAL_TIMEOUT_MS=18s` / `STREAM_BUFFER_STALL_MS=10s` 一个字都不改。
//   3. **失败全静默**。不 warn、不重试、不抛给调用方、不写 streamFallback 的可播性缓存
//      （那是 PreProbe 的地盘，混进去会把「慢」误判成「无源」）。
//
// ### 五道闸门（进预取前全查）
//   1. 同曲去重（已缓存 / 在途）；
//   2. 全局并发 1（串行排队，不并发 —— 天翼那跳带宽共享，并发只会一起变慢并拖慢正在播的那条）；
//   3. 预算：在途 + 预估 > 全局预算 × 0.5 → 放弃（给正在播的那条留一半）；
//   4. 单曲 > `STREAM_BUFFER_MAX_FILE_MB`(100MB) → 跳过（必然 too-big，白取）；
//   5. 只预取网络源（web 无可用 cachePath / `w:` 行）；`l:` 本地磁盘行不走 membuf，预取无意义。
//
// 一句话：**宁可预取失败，也绝不能让正在播的流变慢或断流。**

import { eq } from "drizzle-orm";
import { db } from "../../db/index.js";
import { songs } from "../../db/schema.js";
import { createLogger } from "../../utils/logger.js";
import { isNetworkSong, resolveNetworkInput } from "./networkInput.js";
import {
  bufferedInFlightBytes,
  fetchWholeSongBuffered,
  peekMemStream,
  registerMemStream,
  STREAM_BUFFER_BUDGET_MB,
  STREAM_BUFFER_MAX_FILE_MB,
} from "./bufferedFetch.js";
import { peekUpcomingPositions, type QueuePeekSource } from "../player/preProbeScheduler.js";

const log = createLogger("PREFETCH");

const MB = 1024 * 1024;

// ---------------- 配置（模块常量；先不接外部 env） ----------------

/** 向前预取几首。1 = 只预取下一首（用户痛点集中在「切到下一首卡」）。 */
export const PREFETCH_LOOKAHEAD = 1;
/** 单次预取的**总取流时长硬顶**（ms）。放宽到 120s：后台跑，用户感知不到。 */
export const PREFETCH_DEADLINE_MS = 120_000;
/** 单次预取的停摆判据（ms）。天翼是「慢但不停」，10s 太激进 —— 它不是停摆，只是慢。 */
export const PREFETCH_STALL_MS = 30_000;
/** 预取并发上限。1 = 串行。 */
export const PREFETCH_CONCURRENCY = 1;
/** 预算闸门系数：在途 + 预估超过 `全局预算 × 本系数` 就放弃本次预取。 */
export const PREFETCH_BUDGET_RATIO = 0.5;
/** 无 size 信息（web 行常为 0）时的预估字节数 —— 取 240 曲库 `w:` 行实测均值 29.3MB。 */
export const PREFETCH_ASSUMED_BYTES = 30 * MB;
/** 索引条目有效期（与 membuf 未消费条目的 TTL 10min 对齐）。 */
export const PREFETCH_ENTRY_TTL_MS = 10 * 60_000;
/** AbortController 兜底计时器在 deadline 之外的宽限（ms）。 */
const PREFETCH_GUARD_GRACE_MS = 5_000;

/**
 * 全局并发缓冲预算(字节)。优先读 env `STREAM_BUFFER_BUDGET_MB`(与 bufferedFetch 同一把尺子),
 * 没设才用模块常量 —— 运维调预算时预取闸门跟着一起变,不会各按一套算。
 */
function prefetchBudgetBytes(): number {
  const n = Number(process.env.STREAM_BUFFER_BUDGET_MB);
  return (Number.isFinite(n) && n > 0 ? Math.floor(n) : STREAM_BUFFER_BUDGET_MB) * MB;
}

/** 单文件上限(字节),同读 env `STREAM_BUFFER_MAX_MB`。 */
function prefetchMaxFileBytes(): number {
  const n = Number(process.env.STREAM_BUFFER_MAX_MB);
  return (Number.isFinite(n) && n > 0 ? Math.floor(n) : STREAM_BUFFER_MAX_FILE_MB) * MB;
}

// ---------------- 索引 ----------------

interface PrefetchEntry {
  token: string;
  /** 登记时算好的 membuf 回环 URL（`/rest/membuf/:token`）。 */
  url: string;
  bytes: number;
  at: number;
}

/** 解析后的 songId（= 出流侧实际用的 key）→ membuf 条目。
 *  只记**预取**产生的条目（播放路径的条目不进这里，避免互相污染）。
 *  ⚠ key 是 `resolvePreferredSong(row).id`，**不是**队列行 id —— 出流侧
 *  `resolveTranscodeInput` 拿到的就是解析后的行，`prefetchHit(song?.id)` 查的也是它。 */
const bySong = new Map<string, PrefetchEntry>();
/** 队列行 id → 解析后 id 的别名。去重仍按**队列行 id** 走，索引登记在**解析后 id** 上：
 *  同曲多源组里，队列行可能是 web 行、实际出流却是组内 local/webdav 兄弟行。 */
const alias = new Map<string, string>();
/** 同曲去重（自己维护，不与播放共用 —— 见文件头红线 1）。 */
const inflight = new Map<string, Promise<void>>();
/** 并发闸门后的等待队列（FIFO）。 */
const queued: string[] = [];
let running = 0;

/** `loopbackBase` 的引用。由出流模块在加载时 bind，或首次预取时惰性取。 */
let loopbackBaseRef: (() => string) | null = null;

/** 出流模块（routes/rest/index.ts）在模块加载时把自己用的 `loopbackBase` 交出来。 */
export function bindLoopbackBase(fn: () => string): void {
  loopbackBaseRef = fn;
}

async function ensureLoopbackBase(): Promise<void> {
  if (loopbackBaseRef) return;
  try {
    const m = await import("../dlna/control.js");
    loopbackBaseRef = m.loopbackBase;
  } catch {
    /* 取不到就退回「只认 token」，由调用方自行拼 URL */
  }
}

// ---------------- 查询（出流侧热路径，同步，纳秒级） ----------------

/** 该 songId 是否有**仍存活**的预取条目；返回 membuf token，没有 → null。
 *  不写 `lastReadAt`（不把预取条目标记成「已消费」，否则会被 120s 空闲回收提前清掉）。 */
export function prefetchToken(songId: string): string | null {
  if (!songId) return null;
  const e = bySong.get(songId);
  if (!e) return null;
  if (Date.now() - e.at > PREFETCH_ENTRY_TTL_MS) {
    bySong.delete(songId);
    dropAliasesFor(songId);
    return null;
  }
  // 条目可能已被 sweepMemStreams 回收（TTL / 总字节上限）→ 索引同步失效。
  if (!peekMemStream(e.token)) {
    bySong.delete(songId);
    dropAliasesFor(songId);
    return null;
  }
  return e.token;
}

/** 出流侧唯一入口：命中则返回 membuf 回环 URL，未命中返回 null。 */
export function prefetchHit(songId: string): string | null {
  const t = prefetchToken(songId);
  if (!t || !loopbackBaseRef) return null;
  return `${loopbackBaseRef()}/rest/membuf/${t}`;
}

// ---------------- 触发 ----------------

/** 该队列行 id 的「解析后 id」是否已有存活条目（= 去重命中）。 */
function aliasLive(queueId: string): boolean {
  const resolved = alias.get(queueId);
  return !!resolved && bySong.has(resolved);
}

/** 清掉所有指向该解析后 id 的别名，避免条目死后留下悬空别名。 */
function dropAliasesFor(resolvedId: string): void {
  for (const [q, r] of alias) {
    if (r === resolvedId) alias.delete(q);
  }
}

/**
 * 预取一首（幂等）。fire-and-forget 用；返回的 promise 仅供测试等待。
 * 命中任一闸门 → 立即 resolve，不产生任何副作用。
 * **入参是队列行 id**；索引实际登记在 `resolvePreferredSong` 之后的 id 上（见 doPrefetch）。
 */
export function prefetchSong(songId: string): Promise<void> {
  if (!songId) return Promise.resolve();
  if (aliasLive(songId)) return Promise.resolve(); // 闸门 1（已缓存）
  const pending = inflight.get(songId);
  if (pending) return pending; // 闸门 1（在途）
  if (running >= PREFETCH_CONCURRENCY) {
    // 闸门 2：串行排队（不并发）。
    if (!queued.includes(songId)) queued.push(songId);
    return Promise.resolve();
  }
  const p = runOne(songId);
  inflight.set(songId, p);
  return p;
}

/**
 * 队列变动后预取前方 N 首（fire-and-forget）。
 * **「下一首是谁」一律由 `peekUpcomingPositions` 算**（四种 playMode 全覆盖、只读不改状态）。
 */
export function prefetchUpcoming(peek: QueuePeekSource | undefined, n: number = PREFETCH_LOOKAHEAD): void {
  if (!peek || n <= 0) return;
  try {
    const { positions } = peekUpcomingPositions(peek, n);
    for (const p of positions.slice(0, n)) {
      const songId = peek.items?.[p]?.songId;
      if (songId) void prefetchSong(songId);
    }
  } catch (e: any) {
    // 预取绝不能影响调用方（localSetIndex / 切歌推进）。
    log.debug(`预取排程异常（已忽略）: ${String(e?.message || e).slice(0, 120)}`);
  }
}

async function runOne(songId: string): Promise<void> {
  running++;
  try {
    await doPrefetch(songId);
  } catch (e: any) {
    log.debug(`[prefetch] ${songId} 异常（已忽略）: ${String(e?.message || e).slice(0, 160)}`);
  } finally {
    running--;
    inflight.delete(songId);
    drain();
  }
}

function drain(): void {
  while (running < PREFETCH_CONCURRENCY && queued.length > 0) {
    const next = queued.shift();
    if (!next) break;
    if (aliasLive(next) || inflight.has(next)) continue;
    const p = runOne(next);
    inflight.set(next, p);
  }
}

async function doPrefetch(songId: string): Promise<void> {
  if (aliasLive(songId)) return; // 闸门 1（排队期间可能已被填上）
  const row = db.select().from(songs).where(eq(songs.id, songId)).get() as any;
  if (!row) return;

  // 出流侧（/rest/stream、cast、flow 三处）都先过 resolvePreferredSong —— 预取必须登记在
  // **解析后**的 id 上。否则「队列行是 webId、实际出流是组内 localId」时，
  // 出流查 prefetchHit(resolvedId) 必然 miss（240 实测：83dc3a9b 预取、fa623669 出流）。
  // 惰性 import：preferredSource 会拉进 playPreference / localSourceProbe，
  // 静态 import 可能引出循环依赖（参照 networkInput 对 streamFallback 的 await import 写法）。
  const { resolvePreferredSong } = await import("./preferredSource.js");
  const resolved: any = await resolvePreferredSong(row);
  const resolvedId: string = resolved?.id ?? songId;

  // 解析后去重：同一个 resolvedId 可能被多个队列行映射（组内多个 web 兄弟行）。
  if (bySong.has(resolvedId)) {
    alias.set(songId, resolvedId);
    return;
  }

  // 闸门 5：只预取网络源（`l:` 本地磁盘行不走 membuf，预取纯浪费）—— 用**解析后**的行判。
  if (!(await isNetworkSong(resolved))) return;

  // 闸门 4：超单文件上限必然 too-big，白取一趟。
  const size = typeof resolved.size === "number" && resolved.size > 0 ? resolved.size : 0;
  if (size > prefetchMaxFileBytes()) return;

  // 闸门 3：预算 —— 给正在播的那条留一半（在途字节是**全局**记账，预取也占）。
  const estimate = size > 0 ? size : PREFETCH_ASSUMED_BYTES;
  const budgetBytes = prefetchBudgetBytes();
  if (bufferedInFlightBytes() + estimate > budgetBytes * PREFETCH_BUDGET_RATIO) {
    log.debug(`[prefetch] ${songId} → ${resolvedId} 预算闸门拦下 inFlight=${bufferedInFlightBytes()} est=${estimate}`);
    return;
  }

  // 与出流**共用同一份** URL 推导（见 networkInput.ts）—— 同样喂**解析后**的行。
  const net = await resolveNetworkInput(resolved);
  if (!net) return;
  await ensureLoopbackBase();

  // 自带 AbortController + 兜底计时器：预取没人会 abort 它，不能泄漏。
  const ctrl = new AbortController();
  const guard = setTimeout(() => ctrl.abort(), PREFETCH_DEADLINE_MS + PREFETCH_GUARD_GRACE_MS);
  try {
    const r = await fetchWholeSongBuffered(net.url, net.headers, {
      signal: ctrl.signal,
      retries: 0,
      deadlineMs: PREFETCH_DEADLINE_MS,
      stallMs: PREFETCH_STALL_MS,
    });
    if (!r.ok) {
      // 静默：kind 不写任何可播性缓存（那是 PreProbe 的地盘）。
      log.debug(`[prefetch] ${songId} → ${resolvedId} 未成 kind=${r.kind}${r.err ? ` err=${r.err}` : ""}`);
      return;
    }
    const token = registerMemStream(r.buf, undefined, { songId: resolvedId, prefetched: true });
    // 驱逐不掉（全是正在消费的在用条目）→ 放弃登记，绝不踢正在播的那条。
    if (!token) {
      log.debug(`[prefetch] ${songId} → ${resolvedId} 注册表无空位，放弃登记（不驱逐在用条目）`);
      return;
    }
    if (!loopbackBaseRef) {
      log.debug(`[prefetch] ${songId} → ${resolvedId} 取不到 loopbackBase，放弃索引`);
      return;
    }
    bySong.set(resolvedId, {
      token,
      url: `${loopbackBaseRef()}/rest/membuf/${token}`,
      bytes: r.bytes,
      at: Date.now(),
    });
    alias.set(songId, resolvedId);
    log.info(`[prefetch] ${songId} → ${resolvedId} 预取完成 ${r.bytes}B/${Math.round(r.ms)}ms → 切过去即零上游`);
  } finally {
    clearTimeout(guard);
  }
}

// ---------------- 测试用 ----------------

/** 清空全部预取内存状态。 */
export function resetPrefetchForTest(): void {
  bySong.clear();
  alias.clear();
  inflight.clear();
  queued.length = 0;
  running = 0;
}

/** 观测用：当前索引条目数 / 在途数 / 排队数。 */
export function prefetchStats(): { cached: number; inflight: number; queued: number; running: number } {
  return { cached: bySong.size, inflight: inflight.size, queued: queued.length, running };
}

/** 观测用：别名表（队列行 id → 解析后 id）快照。用于断言「条目回收后别名不悬空」。 */
export function prefetchAliasesForTest(): Array<[string, string]> {
  return [...alias.entries()];
}
