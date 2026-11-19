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

type Bus = { pendingMs: number };

function bus(): Bus {
  const g = globalThis as unknown as Record<string, Bus | undefined>;
  let b = g[GKEY];
  if (!b) {
    b = { pendingMs: 0 };
    g[GKEY] = b;
  }
  return b;
}

export const paceBumpBus = {
  add(ms: number): void {
    if (!Number.isFinite(ms) || ms <= 0) return;
    bus().pendingMs += Math.round(ms);
  },

  /** 取走并清零。 */
  take(): number {
    const b = bus();
    const v = b.pendingMs;
    b.pendingMs = 0;
    return v;
  },

  reset(): void {
    bus().pendingMs = 0;
  },
};
