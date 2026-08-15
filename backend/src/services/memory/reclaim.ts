// ==================== 空闲内存自动回收(reclaim) ====================
//
// 需求:没有活动的播放、也没有拉取歌单/导入/同步/扫描等操作时,自动清理内存。
// 设计:「活动感知 + 分层回收」
//   - 活动信号 touch():播放状态上报(PlayerController.reportState)、导入/同步/
//     扫描/推荐等关键路由、批量任务收尾——任一发生都刷新 lastActivityAt。
//   - 空闲判定 isIdle():自动回收开关开 && 无批量任务(batchPacer.isBatchBusy,
//     全进程同时只跑 1 个批量任务,天然覆盖导入/同步/匹配/封面/歌词/推荐)&&
//     距上次活动超过 memory_idle_minutes(默认 5 分钟)。
//   - 分层回收(都只清「丢了能重建」的缓存,业务状态一律不碰):
//       L1 清空可重建缓存:曲库索引/封面二进制/封面渲染/歌词/封面路径解析/
//          在线音源 fallback + 各模块经 registerCacheCleaner 注册的清理回调。
//       L2 主动 GC:运行时 v8.setFlagsFromString('--expose_gc') + vm.runInNewContext
//          ('gc') 拿到 gc——无需 Dockerfile 加 --expose-gc 参数;30 分钟节流;
//          拿不到 gc 则优雅跳过(仅 L1/L3)。
//       L3 SQLite 维护:wal_checkpoint(TRUNCATE) 合并并截断 WAL + optimize;
//          30 分钟节流。空闲时无写事务争用,最安全。
//   - 调度:startIdleReclaimer() 每 60s 检查一轮,命中空闲即执行;运行中防重入。
import { setFlagsFromString } from "node:v8";
import vm from "node:vm";
import { getSetting, getSettingBool } from "../settings.js";
import { isBatchBusy } from "../plugin/batchPacer.js";
import { sqlite } from "../../db/index.js";
import { clearLibraryIndex } from "../plugin/libraryIndex.js";
import { clearCoverCache } from "../coverCache.js";
import { clearRenderedCovers } from "../coverImage.js";
import { clearLyricsCache } from "../lyrics.js";
import { clearCoverResolveCache } from "../playlistCover.js";
import { clearStreamFallbackCache } from "../source/online/streamFallback.js";

const CHECK_INTERVAL_MS = 60 * 1000;        // 空闲检查周期
const DEFAULT_IDLE_MINUTES = 5;             // 默认空闲阈值
const GC_COOLDOWN_MS = 30 * 60 * 1000;      // L2 GC 节流
const CHECKPOINT_COOLDOWN_MS = 30 * 60 * 1000; // L3 checkpoint 节流

let lastActivityAt = Date.now();
let lastGcAt = 0;
let lastCheckpointAt = 0;
let timer: ReturnType<typeof setInterval> | null = null;
let running = false;

/** 各模块注册的「可重建缓存」清理回调(回收时统一调用)。 */
const cleaners: (() => void)[] = [];

/** 标记一次活动(播放/导入/同步/扫描/批量任务等)。任何活跃操作都应调用。 */
export function touch(): void {
  lastActivityAt = Date.now();
}

/** 注册一个空闲回收时要执行的缓存清理回调(用于不便被直接 import 的模块)。 */
export function registerCacheCleaner(fn: () => void): void {
  if (typeof fn === "function") cleaners.push(fn);
}

export function isAutoReclaimEnabled(): boolean {
  return getSettingBool("memory_auto_reclaim", true);
}

function idleMinutes(): number {
  const v = parseInt(getSetting("memory_idle_minutes", String(DEFAULT_IDLE_MINUTES)), 10);
  return Number.isFinite(v) && v > 0 ? v : DEFAULT_IDLE_MINUTES;
}

/** 当前是否空闲:开关关 / 有批量任务 / 空闲窗口内有活动 → false。 */
export function isIdle(): boolean {
  if (!isAutoReclaimEnabled()) return false;
  if (isBatchBusy()) return false;
  return Date.now() - lastActivityAt >= idleMinutes() * 60 * 1000;
}

// ---------- L1: 清空可重建缓存 ----------
function reclaimCaches(): string[] {
  const cleared: string[] = [];
  clearLibraryIndex(); cleared.push("libraryIndex");
  clearCoverCache(); cleared.push("coverCache");
  clearRenderedCovers(); cleared.push("coverImage");
  clearLyricsCache(); cleared.push("lyrics");
  clearCoverResolveCache(); cleared.push("coverResolve");
  clearStreamFallbackCache(); cleared.push("streamFallback");
  for (const fn of cleaners) {
    try { fn(); } catch { /* 单个清理失败不阻断其余 */ }
  }
  if (cleaners.length) cleared.push("registeredCleaners");
  return cleared;
}

// ---------- L2: 主动 GC(运行时开启,无需 Dockerfile 参数) ----------
let gcFn: (() => void) | null | undefined; // undefined = 未探测
function getGc(): (() => void) | null {
  if (gcFn !== undefined) return gcFn;
  try {
    setFlagsFromString("--expose_gc");
    const g = vm.runInNewContext("gc");
    gcFn = typeof g === "function" ? g : null;
  } catch {
    gcFn = null; // 拿不到(未来 V8 变更)则优雅降级,只做 L1/L3
  }
  return gcFn ?? null;
}

function gcNow(): boolean {
  if (Date.now() - lastGcAt < GC_COOLDOWN_MS) return false;
  const g = getGc();
  if (!g) return false;
  try {
    g(); // 第一次回收标记期对象,第二次压实堆
    g();
    lastGcAt = Date.now();
    return true;
  } catch {
    return false;
  }
}

// ---------- L3: SQLite WAL 合并 + 统计优化 ----------
function checkpointDb(): boolean {
  if (Date.now() - lastCheckpointAt < CHECKPOINT_COOLDOWN_MS) return false;
  try {
    sqlite.pragma("wal_checkpoint(TRUNCATE)");
    sqlite.pragma("optimize");
    lastCheckpointAt = Date.now();
    return true;
  } catch {
    return false;
  }
}

export interface ReclaimReport {
  caches: string[];
  gc: boolean;
  checkpoint: boolean;
}

/** 执行一轮完整回收(手动「立即回收」与空闲定时器共用)。 */
export function reclaimNow(): ReclaimReport {
  return {
    caches: reclaimCaches(),
    gc: gcNow(),
    checkpoint: checkpointDb(),
  };
}

/** 启动空闲回收器:每 60s 检查一次,空闲则回收。幂等。 */
export function startIdleReclaimer(): void {
  if (timer) return;
  timer = setInterval(() => {
    if (running) return;
    running = true;
    try {
      if (isIdle()) reclaimNow();
    } catch (e: any) {
      console.error("[MEMORY-RECLAIM] 空闲回收出错:", e?.message || e);
    } finally {
      running = false;
    }
  }, CHECK_INTERVAL_MS);
  timer.unref();
}

// ---------- 测试钩子 ----------
export function _resetReclaimForTest(): void {
  lastActivityAt = Date.now();
  lastGcAt = 0;
  lastCheckpointAt = 0;
  if (timer) { clearInterval(timer); timer = null; }
  running = false;
  cleaners.length = 0;
  gcFn = undefined;
}

/** 测试用:把最后一次活动时间拨到指定时刻(模拟长时间空闲)。 */
export function _setLastActivityForTest(ts: number): void {
  lastActivityAt = ts;
}
