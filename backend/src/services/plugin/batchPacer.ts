// ==================== 批量任务节拍器(batchPacer) ====================
//
// 背景: v1.7.47 起批量任务(longRunning)取消墙钟硬超时(软看门狗只杀 CPU 空转),
// 任务可无限执行 → 会「全速冲刺」把活尽快干完,多任务还可能叠加 → CPU 飙高。
// 本模块把所有批量任务统一到「匀速巡航」(三阶段一次落地):
//   P0-1 主动睡眠(sleepBetweenBatch): 批间真正让 CPU 空闲——区别于 setImmediate
//        只让事件循环插空、队列里全是本任务马上又回来跑(CPU 不减)。峰值摊平成
//        均值,总量不变(无限任务无 deadline,慢一点换 CPU 平缓完全可接受)。
//   P0-2 动态并发(batchConcurrency): 按档位返回基础并发;事件循环延迟高时降 1。
//   P0-3 全局闸(acquireBatchLock): 全进程同时只跑 1 个批量任务(FIFO 排队),消除
//        gmdl 同步 + listenbrainz 补全 + 后台 auto-match + 手动导入的多任务叠加。
//   P0-4 交互优先(用户前端操作让行): 用户搜索/导入/手动同步时进入 interactive 窗口,
//        后台批量任务主动退让——批间睡眠 ×4、并发压到 1,把 CPU/DB/带宽让给用户;
//        交互操作本身走 interactiveConcurrency()(档位基础并发),不受退让影响。
//   P1   自适应(ELD): 每 200ms 探测事件循环实际节拍偏差,前台有请求在等(ELD 高)
//        时 sleep 加倍/并发降档,空闲时恢复全速——用户在用时不卡,深夜尽量快。
//   P2   档位(batch_pace): slow|standard|full,系统设置页可改,运行时生效。
//
// 用法:
//   批量循环内每批: await sleepBetweenBatch();
//   并发取数:      batchConcurrency()(替代写死的并发常量)
//   任务边界:      const release = await acquireBatchLock();
//                  try { ... } finally { release(); }   // 必须 finally 释放,否则队列永久卡死

import { getSetting, setSetting } from "../../services/settings.js";

export type BatchPace = "slow" | "standard" | "full";

const ELD_INTERVAL_MS = 200; // 节拍探测间隔
const ELD_WINDOW = 5;        // 最近 N 次均值
const ELD_BUSY_MS = 50;      // 均值 > 50ms → 前台忙,降速
const ELD_IDLE_MS = 10;      // 均值 < 10ms → 空闲,恢复全速(由 busy 分支自然回落)

// 档位参数: 基础并发 / 基础批间睡眠
// 参数经仿真反推(600 首 × 5ms CPU/首,并发 worker 重叠后):
//   slow 并发1×sleep120 → ~28%;standard 并发2×sleep120 → ~57%;full 并发4 → ~100%。
// 目标:standard 明显平缓(白天用电脑可接受),slow 最省 CPU,full 全速(用户自选)。
const PACE_PARAMS: Record<BatchPace, { concurrency: number; sleepMs: number }> = {
  slow:     { concurrency: 1, sleepMs: 120 },
  standard: { concurrency: 2, sleepMs: 120 },
  full:     { concurrency: 4, sleepMs: 0 },
};

// ---------- ELD 探测(惰性启动;unref 不阻止进程退出) ----------
let eldSamples: number[] = [];
let lastTick = 0;
let eldTimer: NodeJS.Timeout | null = null;

function ensureEldTimer(): void {
  if (eldTimer) return;
  lastTick = Date.now();
  eldTimer = setInterval(() => {
    const now = Date.now();
    const lag = Math.max(0, now - lastTick - ELD_INTERVAL_MS);
    lastTick = now;
    eldSamples.push(lag);
    if (eldSamples.length > ELD_WINDOW) eldSamples.shift();
  }, ELD_INTERVAL_MS);
  eldTimer.unref();
}

/** 事件循环延迟均值(ms);无采样返回 0。 */
export function eventLoopLag(): number {
  if (!eldSamples.length) return 0;
  return eldSamples.reduce((a, b) => a + b, 0) / eldSamples.length;
}

// ---------- 交互优先(用户前端操作让行) ----------
//
// 设计原则:批量任务(每日推荐同步 / 后台自动匹配 / 插件每日任务)是后台巡航,
// 用户前端的搜索/导入/手动同步是交互操作,必须优先。交互操作本身**不排队**
// (不加全局闸——routes/api/playlistSearch.ts 的 import 是用户单次触发、量小,
// 直接与后台并行跑),但正在跑的批量任务要在交互窗口内主动退让:
//   批间睡眠 ×4 + 并发压到 1 → 后台近乎暂停,把 CPU/DB/带宽让给用户。
// 显式计数(try/finally 成对,进程重启即清零)比 TTL 精确,无残留风险。
let interactiveDepth = 0;

/** 标记一次用户交互操作开始(前端搜索/导入/手动同步),后台批量任务将退让。 */
export function markInteractiveStart(): void {
  interactiveDepth++;
}

/** 标记一次用户交互操作结束(与 start 成对,务必放 try/finally 的 finally)。 */
export function markInteractiveEnd(): void {
  if (interactiveDepth > 0) interactiveDepth--;
}

/** 是否处于用户交互窗口内(有未结束的交互操作)。 */
export function isInteractiveActive(): boolean {
  return interactiveDepth > 0;
}

// ---------- 档位 ----------
/** 当前限速档位(settings.batch_pace,默认 standard)。 */
export function currentPace(): BatchPace {
  const v = getSetting("batch_pace", "standard");
  return v === "slow" || v === "full" ? v : "standard";
}

/** 运行时切换档位(系统设置页调用,立即生效)。 */
export function setPace(pace: BatchPace): void {
  setSetting("batch_pace", pace);
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** 批量任务批间主动睡眠: 基础时长;交互窗口内 ×4(用户优先),否则 ELD 忙时 ×2;
 *  full 档不主动睡(0ms)。 */
export async function sleepBetweenBatch(): Promise<void> {
  ensureEldTimer();
  const p = PACE_PARAMS[currentPace()];
  if (p.sleepMs <= 0) return;
  let mul = 1;
  if (isInteractiveActive()) mul = 4; // 用户在操作:大幅退让
  else if (eventLoopLag() > ELD_BUSY_MS) mul = 2; // 前台忙(无交互标记):适度退让
  await sleep(p.sleepMs * mul);
}

/** 批量任务并发: 档位基础并发;交互窗口内压到 1(后台近乎暂停,让位用户);
 *  否则 ELD 忙时 -1(最低 1)。 */
export function batchConcurrency(): number {
  ensureEldTimer();
  const p = PACE_PARAMS[currentPace()];
  if (isInteractiveActive()) return 1; // 用户优先:后台单线程,最大程度让出资源
  if (eventLoopLag() > ELD_BUSY_MS) return Math.max(1, p.concurrency - 1);
  return p.concurrency;
}

/** 交互操作自身的并发:用户操作就是优先者,不受交互退让影响,按档位基础并发全速跑。 */
export function interactiveConcurrency(): number {
  ensureEldTimer();
  return PACE_PARAMS[currentPace()].concurrency;
}

// ---------- 全局批量闸(信号量;并发度 = 批量 worker 数,默认 1) ----------
// 单线程时代:全进程同时只跑 1 个批量任务(FIFO 互斥)。
// worker 化后:沙箱批量方法在独立 worker 线程执行(不占主线程),同一时刻可以让多个
// 批量任务并行(每个任务跑在自己的 worker 上,host 调用交替回主线程执行),真正用上
// 多核。并发上限 = 已注册的批量 worker 数(registerBatchWorker),无 worker 时为 1(现状)。
let batchLimit = 1;              // 批量并发上限
let holders = 0;                 // 当前持锁任务数
let lockQueue: Array<() => void> = [];
// 持锁者 + 排队者计数。isBatchBusy 的依据(语义:只要有批量任务在跑/排队,即 busy)。
let pendingLocks = 0;
let workerPlugins = 0;           // 已注册的批量 worker 数(批量并发上限依据)

/**
 * 获取全局批量锁。最多 batchLimit 个任务同时持有,其余按 FIFO 排队等待。
 * 返回释放函数,**调用方必须在 finally 中调用**,否则队列永久阻塞。
 */
export async function acquireBatchLock(): Promise<() => void> {
  ensureEldTimer();
  pendingLocks++; // 入队即计入(持锁者 + 排队者)
  await new Promise<void>((resolve) => {
    lockQueue.push(resolve);
    pumpLock();
  });
  let released = false;
  return () => {
    if (released) return;
    released = true;
    pendingLocks--;
    holders--;
    pumpLock(); // 唤醒队列中下一个
  };
}

/** 批量并发上限变化后唤醒排队者(有空位才放行)。 */
function pumpLock(): void {
  while (holders < batchLimit && lockQueue.length > 0) {
    holders++;
    const next = lockQueue.shift()!;
    next();
  }
}

/** 设置批量并发上限(≥1)。沙箱 worker 注册/注销时由批量闸联动更新。 */
export function setBatchConcurrencyLimit(n: number): void {
  batchLimit = Math.max(1, n);
  pumpLock();
}

/** 注册一个批量 worker(沙箱插件加载成功时调用):并发上限随之提升。 */
export function registerBatchWorker(): void {
  workerPlugins++;
  setBatchConcurrencyLimit(workerPlugins);
}

/** 注销一个批量 worker(沙箱插件销毁时调用)。 */
export function unregisterBatchWorker(): void {
  workerPlugins = Math.max(0, workerPlugins - 1);
  setBatchConcurrencyLimit(workerPlugins);
}

/** 是否正有批量任务持有或排队等待全局闸(供状态端点/前端提示/空闲判定)。 */
export function isBatchBusy(): boolean {
  return pendingLocks > 0;
}

// ---------- 测试钩子 ----------
export function _batchLimitForTest(): number { return batchLimit; }

export function _resetPacerForTest(): void {
  eldSamples = [];
  lastTick = 0;
  if (eldTimer) { clearInterval(eldTimer); eldTimer = null; }
  lockQueue = [];
  holders = 0;
  pendingLocks = 0;
  batchLimit = 1;
  workerPlugins = 0;
  interactiveDepth = 0;
}
