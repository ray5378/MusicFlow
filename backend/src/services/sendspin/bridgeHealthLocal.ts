/** 桥水位（**sendspin 子进程内**共享）。
 *
 *  数据链路：airplay 子进程 BridgeSession.tickStats
 *    → process.send(bridgeStats) → 主进程 supervisor
 *    → sendspinSupervisor.rpc("bridgeHealth") → 本模块 record()
 *    → streamEngine 低缓冲自愈读 min()
 *
 *  为什么绕这么远：桥水位在 airplay 子进程，泵在 sendspin 子进程，中间隔着主进程。
 *  240 2026-11-19 实测：主进程能收到事件（ev-recv），但 sendspin 侧读同一模块是
 *  Infinity（进程隔离，globalThis 也不共享）。
 */
export interface BridgeHealthLocalRow {
  minInQueueMs: number;
  at: number;
}

/** 超过该时长未更新视为陈旧（桥 tick 2s 一次，给 3 个周期余量）。 */
const STALE_MS = 6_000;

let row: BridgeHealthLocalRow | null = null;

export const bridgeHealthLocal = {
  record(minInQueueMs: number): void {
    if (!Number.isFinite(minInQueueMs)) return;
    row = { minInQueueMs, at: Date.now() };
  },

  /** 最薄那座桥的缓冲（ms）；无数据/已陈旧时返回 Infinity（判据不成立）。 */
  min(): number {
    if (!row) return Number.POSITIVE_INFINITY;
    if (Date.now() - row.at > STALE_MS) return Number.POSITIVE_INFINITY;
    return row.minInQueueMs;
  },

  reset(): void {
    row = null;
  },
};
