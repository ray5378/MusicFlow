// ==================== 停播空闲回收(通用) ====================
//
// 常驻渲染器子进程的「用完即还」判定:
//   - sendspin:插件层按需加载后模块图常驻(Node 卸不掉 import),停播空闲就请主进程换进程;
//   - airplay:纯协议运行时本身很轻,但不用 AirPlay 时没必要常驻,停播空闲就直接停掉
//     (下次投屏懒启动)。
//
// 判定很保守,宁可晚回收也不打断播放:
//   - 连续 afterMs 没有会话/没有任何组持有 current;
//   - 只上报一次(不会每拍反复请求);
//   - 可选前置条件 `pluginLayerLoaded`(未加载就没有可回收的收益,不折腾设备连接)。
//
// 子进程只负责判定与上报:它看得见自己的内存/会话,看不见主进程的队列编排(切歌/预热)。

/** 连续空闲多久才回收:2 分钟。跨曲间隙通常 < 10s,留足余量给自动切歌与曲末预热。 */
export const IDLE_RECLAIM_AFTER_MS = 120_000;
/** 检查周期:15s(判定成本可忽略,时间粒度够用)。 */
export const IDLE_RECLAIM_TICK_MS = 15_000;

export interface IdleReclaimTrackerOptions {
  /** 是否仍在忙(有会话 / 播放 / 暂停 / 桥在播都算忙)。 */
  isBusy: () => boolean;
  /** 判定为空闲足够久时调用(只调一次)。 */
  onIdle: (idleMs: number) => void;
  /** 空闲阈值,默认 IDLE_RECLAIM_AFTER_MS。 */
  afterMs?: number;
}

/**
 * 空闲计时器(纯逻辑,显式传入 now,便于单测)。
 * 由 startIdleReclaim 驱动,业务无需直接使用。
 */
export class IdleReclaimTracker {
  private readonly afterMs: number;
  /** 本轮空闲起点;null = 尚未开始计时(用 0 当哨兵会被 now=0 的单测撞上)。 */
  private idleSince: number | null = null;
  private fired = false;

  constructor(private readonly opts: IdleReclaimTrackerOptions) {
    this.afterMs = opts.afterMs ?? IDLE_RECLAIM_AFTER_MS;
  }

  /** 推进一拍;返回 true 表示本次刚触发回收。 */
  tick(now: number = Date.now()): boolean {
    if (this.fired) return false;
    if (this.opts.isBusy()) {
      this.idleSince = null; // 忙过就重新计时(避免把跨曲间隙累加进空闲)
      return false;
    }
    if (this.idleSince === null) {
      this.idleSince = now;
      return false;
    }
    const idleMs = now - this.idleSince;
    if (idleMs < this.afterMs) return false;
    this.fired = true;
    this.opts.onIdle(idleMs);
    return true;
  }
}

export interface StartIdleReclaimOptions extends IdleReclaimTrackerOptions {
  /** 前置条件:未满足时不计时(如 sendspin 的插件层没加载过就没可回收的内存)。 */
  pluginLayerLoaded?: () => boolean;
  /** 检查周期,默认 IDLE_RECLAIM_TICK_MS。 */
  tickMs?: number;
}

/** 起一个不拖住进程退出的周期检查;返回停止函数。 */
export function startIdleReclaim(opts: StartIdleReclaimOptions): () => void {
  const tracker = new IdleReclaimTracker(opts);
  const timer = setInterval(() => {
    if (opts.pluginLayerLoaded && !opts.pluginLayerLoaded()) return;
    tracker.tick();
  }, opts.tickMs ?? IDLE_RECLAIM_TICK_MS);
  timer.unref?.();
  return () => clearInterval(timer);
}
