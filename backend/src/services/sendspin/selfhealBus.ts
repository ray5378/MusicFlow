/** 自愈分级动作总线（**sendspin 子进程内**，挂 globalThis —— 仿 paceBumpBus 模式：
 *  server/Group 会重建，实例方法不可靠，挂 globalThis 保生命周期无关）。
 *
 *  写入方：sendspin/server.ts 守卫（bridgeBroadcastTick 的 late-selfheal 三级分级）。
 *  读取方：sendspin/childMain.ts 周期 drain 后经 emit 上行主进程，由主进程
 *  dispatchSendspinChildEvent → airplay/selfhealExec 落到 control 层 RPC。
 *
 *  为什么经子进程 emit 而不是直接 rpc：retime/lightRestart 的执行体在 **airplay 桥
 *  子进程**（rebuildForShift/lightRestart），sendspin 子进程无法直达，必须经主进程
 *  control 层转发 —— 与 bridgeStats 的上行链（bridgeStatsSink → supervisor →
 *  bridgeHealth rpc）互为反向，且都是异步非阻塞语义。
 */
const GKEY = "__mf_selfhealBus_v1";

/** level: 1=retime(桥自估 shift 平移映射) 2=lightRestart(清管线+flush 重锚)。
 *  shiftUs 仅 level=1 有意义(0=由桥按 late 增量自估;主进程透传给 RPC reason)。 */
export type SelfhealAction = { deviceId: string; level: 1 | 2; shiftUs: number };

function bus(): { pending: SelfhealAction[] } {
  const g = globalThis as unknown as Record<string, { pending: SelfhealAction[] } | undefined>;
  let b = g[GKEY];
  if (!b) {
    b = { pending: [] };
    g[GKEY] = b;
  }
  return b;
}

export const selfhealBus = {
  /** 守卫触发分级动作（非阻塞，等主进程侧转发执行）。 */
  request(a: SelfhealAction): void {
    if (!a?.deviceId) return;
    bus().pending.push(a);
  },

  /** childMain 周期取走全部待上行动作（取走即清）。 */
  drain(): SelfhealAction[] {
    const b = bus();
    const out = b.pending;
    b.pending = [];
    return out;
  },
};
