/** 加压信号总线（**sendspin 子进程内**，挂 globalThis）。
 *
 *  为什么不用 `SendspinServer.requestPaceBump`：240 实测同一版代码下，15 次指令里
 *  5 次成功、14 次报 `srv?.requestPaceBump is not a function` —— `getServer()` 在
 *  不同时机返回的对象不一致（server 会重建），实例方法不可靠。
 *
 *  写入方：childMain 收到主进程转发的 `paceBump` 指令。
 *  读取方：streamEngine 每拍取走并清零，把 pacing 墙钟基准前提对应毫秒。
 */
const GKEY = "__mf_paceBumpBus_v1";

type Bus = { pendingMs: number; approvedMs: number; pendingDeficitMs: number };

function bus(): Bus {
  const g = globalThis as unknown as Record<string, Bus | undefined>;
  let b = g[GKEY];
  if (!b) {
    b = { pendingMs: 0, approvedMs: 0, pendingDeficitMs: 0 };
    g[GKEY] = b;
  }
  return b;
}

export const paceBumpBus = {
  /** @param deficitMs 桥侧算出的「离目标水位还差多少」(≈ 目标 − inQueue)。
   *  只对 bulk 建缓冲有意义（泵加速用它推导不了量），由投递侧在 reject 分支取走。 */
  add(ms: number, deficitMs = 0): void {
    if (!Number.isFinite(ms) || ms <= 0) return;
    const b = bus();
    b.pendingMs += Math.round(ms);
    const d = Number(deficitMs);
    if (Number.isFinite(d) && d > 0) {
      b.pendingDeficitMs = Math.max(b.pendingDeficitMs || 0, Math.round(d));
    }
  },

  /** 只看不取（投递侧判断是否需要补时用）。 */
  peek(): number {
    return bus().pendingMs;
  },

  /** 投递侧判定「该补」：把待审量转入待执行槽。 */
  approve(): void {
    const b = bus();
    if (b.pendingMs > 0) {
      b.approvedMs += b.pendingMs;
      b.pendingMs = 0;
    }
    b.pendingDeficitMs = 0;
  },

  /** 桥侧报的缺口（ms）：0 = 未提供。 */
  peekDeficit(): number {
    return bus().pendingDeficitMs || 0;
  },

  /** 投递侧判定「不该补」：丢弃待审量，返回丢弃了多少。 */
  reject(): number {
    const b = bus();
    const v = b.pendingMs;
    b.pendingMs = 0;
    b.pendingDeficitMs = 0;
    return v;
  },

  /** 泵取走**已批准**的加压量（未经 approve 的请求不会被执行）。 */
  takeApproved(): number {
    const b = bus();
    const v = b.approvedMs;
    b.approvedMs = 0;
    return v;
  },

  reset(): void {
    const b = bus();
    b.pendingMs = 0;
    b.approvedMs = 0;
    b.pendingDeficitMs = 0;
  },
};
