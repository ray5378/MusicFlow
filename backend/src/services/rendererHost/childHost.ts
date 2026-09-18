// ==================== 常驻渲染器子进程:子进程侧控制器(通用) ====================
//
// 子进程入口(child.ts)把 IPC 消息交给本类处理。独立成模块是为了可单测:
// 不 fork 也能用真实的 in-proc 运行时驱动同一套 handler,保证**测试路径 = 生产路径**。
//
// 职责(与业务无关的那部分):
//  - 处理主进程 RPC:调 dispatch(op, payload) → 按 id 回 res(异常转 ok:false);
//  - 维护状态快照推送:业务侧脏了调 requestSnapshot()(THROTTLE 节流,force 跳过),
//    另有 SWEEP 兜底扫(捕捉无钩子的状态变化,如推流自然结束);
//  - 心跳上报:主进程看门狗据此判断卡死;
//  - 生命周期:markReady() 后开始推快照;stop → onStop() 清干净 → stopped → 入口自行退出。
//
// 业务侧只需提供:send 通道、buildState(组装快照消息)、dispatch(op 表)、onStop。
import {
  RENDERER_SNAPSHOT_THROTTLE_MS,
  RENDERER_SNAPSHOT_SWEEP_MS,
  RENDERER_HEARTBEAT_MS,
  type StateEnvelope,
} from "./ipcProtocol.js";

export interface ChildRpcHostOptions<TSend, TSnapshot extends object> {
  /** 回主进程的发送通道(生产为 process.send 包装;测试注入数组收集)。 */
  send: (msg: TSend) => void;
  /** 组装完整 state 消息(业务构造,含 `t: "state"`);返回 null 表示当前无可推状态。 */
  buildState: () => StateEnvelope<TSnapshot> | null;
  /** 业务 RPC 分发。抛出的错误会被包成 ok:false 的 res 回给主进程。 */
  dispatch: (op: string, payload: any) => Promise<unknown>;
  /** stop 语义:清干净本进程持有的运行时,不碰主进程的编排对象。 */
  onStop: () => Promise<void> | void;
  snapshotThrottleMs?: number;
  snapshotSweepMs?: number;
  heartbeatMs?: number;
}

export class ChildRpcHost<TSend, TSnapshot extends object> {
  private readonly opts: ChildRpcHostOptions<TSend, TSnapshot>;
  private snapshotTimer: ReturnType<typeof setTimeout> | null = null;
  private snapshotDirty = false;
  private readonly sweep: ReturnType<typeof setInterval>;
  private readonly heartbeat: ReturnType<typeof setInterval>;
  private ready = false;

  constructor(opts: ChildRpcHostOptions<TSend, TSnapshot>) {
    this.opts = opts;
    // 兜底扫描:无钩子的状态变化(如推流自然结束)也能在 SWEEP 内可见。
    this.sweep = setInterval(() => {
      if (this.ready) this.requestSnapshot(true);
    }, opts.snapshotSweepMs ?? RENDERER_SNAPSHOT_SWEEP_MS);
    this.sweep.unref?.();
    // 心跳:主进程看门狗据此判断卡死。
    this.heartbeat = setInterval(() => {
      this.emit({ t: "heartbeat", pid: process.pid });
    }, opts.heartbeatMs ?? RENDERER_HEARTBEAT_MS);
    this.heartbeat.unref?.();
  }

  markReady(): void {
    this.ready = true;
    this.requestSnapshot(true);
  }

  dispose(): void {
    clearInterval(this.sweep);
    clearInterval(this.heartbeat);
    if (this.snapshotTimer) {
      clearTimeout(this.snapshotTimer);
      this.snapshotTimer = null;
    }
  }

  /** 请求推送快照:脏标记 + 节流;force 跳过节流立即推。 */
  requestSnapshot(force = false): void {
    this.snapshotDirty = true;
    if (this.snapshotTimer && !force) return;
    if (this.snapshotTimer) {
      clearTimeout(this.snapshotTimer);
      this.snapshotTimer = null;
    }
    if (force) {
      this.snapshotDirty = false;
      this.pushSnapshot();
      return;
    }
    this.snapshotTimer = setTimeout(() => {
      this.snapshotTimer = null;
      if (!this.snapshotDirty) return;
      this.snapshotDirty = false;
      this.pushSnapshot();
    }, this.opts.snapshotThrottleMs ?? RENDERER_SNAPSHOT_THROTTLE_MS);
  }

  /** 组装当前快照并发送(业务 return null 则跳过本次)。 */
  pushSnapshot(): void {
    const msg = this.opts.buildState();
    if (!msg) return;
    this.emit(msg);
  }

  /** 处理主进程消息;RPC 请求在此分发并回 res。返回 true 表示消息已消费。 */
  async handleMessage(raw: unknown): Promise<boolean> {
    if (!raw || typeof raw !== "object") return false;
    const msg = raw as { t?: string; id?: number; op?: string; payload?: unknown };
    if (msg.t === "req") {
      await this.handleReq(Number(msg.id), String(msg.op), msg.payload);
      return true;
    }
    return false;
  }

  /**
   * 直接发一条消息给主进程。
   * ⚠️ TSend 是业务侧的完整联合类型(由 ChildToHost<…> 组合而来),必然覆盖本类发出的
   * 通用信封(heartbeat/state/res/stopped),这里断言只是把「组合保证」写给编译器看。
   */
  protected emit(msg: object): void {
    this.opts.send(msg as unknown as TSend);
  }

  private async handleReq(id: number, op: string, payload: unknown): Promise<void> {
    try {
      const result = await this.opts.dispatch(op, payload);
      this.emit({ t: "res", id, ok: true, result: result ?? null });
    } catch (e: any) {
      this.emit({ t: "res", id, ok: false, error: String(e?.message || e) });
    }
  }
}
