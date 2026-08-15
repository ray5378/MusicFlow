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

/** 批量任务批间主动睡眠: 基础时长,ELD 忙时加倍;full 档不主动睡(0ms)。 */
export async function sleepBetweenBatch(): Promise<void> {
  ensureEldTimer();
  const p = PACE_PARAMS[currentPace()];
  if (p.sleepMs <= 0) return;
  const mul = eventLoopLag() > ELD_BUSY_MS ? 2 : 1;
  await sleep(p.sleepMs * mul);
}

/** 批量任务并发: 档位基础并发,ELD 忙时 -1(最低 1)。 */
export function batchConcurrency(): number {
  ensureEldTimer();
  const p = PACE_PARAMS[currentPace()];
  if (eventLoopLag() > ELD_BUSY_MS) return Math.max(1, p.concurrency - 1);
  return p.concurrency;
}

// ---------- 全局闸(FIFO promise 链;天然互斥,无忙等) ----------
let lockChain: Promise<void> = Promise.resolve();

/**
 * 获取全局批量锁。全进程同时只允许 1 个批量任务持有;其余按 FIFO 排队等待。
 * 返回释放函数,**调用方必须在 finally 中调用**,否则队列永久阻塞。
 */
export async function acquireBatchLock(): Promise<() => void> {
  ensureEldTimer();
  let releaseNext: () => void = () => {};
  const gate = new Promise<void>((r) => { releaseNext = r; });
  const prev = lockChain;
  lockChain = lockChain.then(() => gate);
  await prev; // 前面所有持锁者释放后,本调用才获得执行权
  let released = false;
  return () => {
    if (released) return;
    released = true;
    releaseNext(); // 唤醒队列中下一个
  };
}

/** 是否正有批量任务持有全局闸(供状态端点/前端提示)。 */
export function isBatchBusy(): boolean {
  // 有未完成的链 = 有持锁者或排队者;队列非空即视为忙
  return lockChain !== Promise.resolve();
}

// ---------- 测试钩子 ----------
export function _resetPacerForTest(): void {
  eldSamples = [];
  lastTick = 0;
  if (eldTimer) { clearInterval(eldTimer); eldTimer = null; }
  lockChain = Promise.resolve();
}
