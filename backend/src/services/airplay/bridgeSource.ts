/** 发送端有界队列 + stalled 状态机 + 退避重连(AirPlay 桥接 Phase 2,spec §4.4)。
 *
 *  策略(两侧同一套):
 *  - 阈值按"秒"计量、按输入速率 48k 折算(MIN-05),字节数只进日志;
 *  - write() 返回 false → 停 drain 等 drain 事件,队列继续接受;
 *  - 超高水位:回调 onBackpressure + 统计 maxQueueMs(日志 `bridge backpressure`);
 *  - 超硬上限:判定 stalled → 关 socket → 按 5s/30s 退避(±20% 抖动)重连;
 *  - 禁止丢最旧帧(时间戳连续但内容有洞比对齐更致命):宁断不错位,队列原样保留,
 *    重连成功后由接入方发新 generation(BOUNDARY)并按需清队。
 *
 *  状态机:idle → connecting → live →(断连/硬上限)stalled → connecting → live …
 *  退避时钟与随机源均可注入(测试确定性)。
 */

import {
  BRIDGE_BACKOFF_BASE_MS,
  BRIDGE_BACKOFF_MAX_MS,
  BRIDGE_PCM_BYTES_PER_SEC,
  BRIDGE_QUEUE_HARD_CAP_MS,
  BRIDGE_QUEUE_HIGH_WATER_MS,
} from "./rates.js";

export type BridgeLinkState = "idle" | "connecting" | "live" | "stalled";

/** socket 最小接口(真 net.Socket 与测试 Stub 均满足)。 */
export interface BridgeSocketLike {
  write(data: Uint8Array): boolean;
  destroy(): void;
  on(event: "drain" | "close" | "error", cb: (...args: never[]) => void): unknown;
}

/** 重连退避:指数增长(5s 起,每次 ×2),封顶 30s,叠加 ±20% 抖动
 *  (N 台设备同时掉线时,固定退避会造成 N 条同步重连)。
 *  @param attempt 从 1 计的重连尝试序号;@param rnd [0,1) 随机数。 */
export function computeBridgeBackoffMs(
  attempt: number,
  rnd: number,
  baseMs: number = BRIDGE_BACKOFF_BASE_MS,
  maxMs: number = BRIDGE_BACKOFF_MAX_MS,
): number {
  const n = Math.max(1, Math.floor(attempt));
  const exp = Math.min(maxMs, baseMs * 2 ** (n - 1));
  const jitter = 0.8 + 0.4 * rnd; // ±20%
  return Math.round(Math.min(maxMs, exp * jitter));
}

/** ENOENT 连续 N 次上报 permanent-loss(退避 5s 起 ×2 封顶 30s:N=12 ≈ 累计 5 分钟)。 */
const BRIDGE_ENOENT_PERMANENT_AFTER = 12;

/** connect 错误是否 ENOENT(Unix socket 文件不存在)。 */
function isEnoentError(err: unknown): boolean {
  if ((err as { code?: string })?.code === "ENOENT") return true;
  return err instanceof Error && err.message.includes("ENOENT");
}

const defaultSchedule = (fn: () => void, ms: number): (() => void) => {
  const t = setTimeout(fn, ms);
  return () => clearTimeout(t);
};

export interface BridgeSourceStats {
  state: BridgeLinkState;
  queuedFrames: number;
  queuedBytes: number;
  /** 按输入速率 48k 折算的当前排队毫秒数(MIN-05)。 */
  queuedMs: number;
  /** 峰值排队毫秒数。 */
  maxQueueMs: number;
  /** 已交给 socket 的帧数。 */
  sentFrames: number;
  sentBytes: number;
  /** 对端/本地断连次数(≈ 重连次数)。 */
  reconnects: number;
}

export interface BridgeSourceOpts {
  /** 建立传输连接(TCP/unix/named pipe);resolve 后由 attach 接管 socket。 */
  connect: () => Promise<BridgeSocketLike>;
  /** 连接就绪(发送端此刻先发 CONFIG 帧,§4.1)。 */
  onConnected: (socket: BridgeSocketLike) => void;
  onStateChange?: (state: BridgeLinkState, info?: { reason?: string }) => void;
  /** 越过高水位(仅上行跨越时回调一次,回落复位)。 */
  onBackpressure?: (queuedMs: number) => void;
  /** 越过硬上限(此刻 socket 正在关闭)。 */
  onHardCap?: (queuedMs: number) => void;
  /** 重连退避注入(测试确定性);缺省 = computeBridgeBackoffMs(attempt, random)。 */
  backoffDelayMs?: (attempt: number) => number;
  /** 断连时的即时重连判定(修法②a):返回 true 则本次 closed 不进 5s/30s 退避,
   *  立即重连(0ms)。语义:泵未在跑(内容尾/过渡期)的 closed 是对端终态回收
   *  而非故障;仅作用于 closed 事件一次 —— 若对端监听尚未就绪,后续 connect
   *  失败照常退避,不会热循环。 */
  immediateReconnectOnClosed?: () => boolean;
  /** 定时器注入(测试);返回取消函数。 */
  schedule?: (fn: () => void, ms: number) => () => void;
  highWaterMs?: number;
  hardCapMs?: number;
  log?: (...args: unknown[]) => void;
}

export class BridgeSource {
  private readonly opts: BridgeSourceOpts;
  private readonly highWaterMs: number;
  private readonly hardCapMs: number;
  private readonly scheduleFn: (fn: () => void, ms: number) => () => void;

  private queue: Uint8Array[] = [];
  private queuedBytes = 0;
  private maxQueueMs = 0;
  /** ENOENT 连败计数(改法5:socket 文件消失的 permanent-loss 观测)。 */
  private connectEnoentStreak = 0;
  private sentFrames = 0;
  private sentBytes = 0;
  private reconnects = 0;

  private state_: BridgeLinkState = "idle";
  private sock: BridgeSocketLike | null = null;
  private waitingDrain = false;
  private stopping = false;
  private attempt = 0;
  private backpressureActive = false;
  private reconnectCancel: (() => void) | null = null;

  constructor(opts: BridgeSourceOpts) {
    this.opts = opts;
    this.highWaterMs = opts.highWaterMs ?? BRIDGE_QUEUE_HIGH_WATER_MS;
    this.hardCapMs = opts.hardCapMs ?? BRIDGE_QUEUE_HARD_CAP_MS;
    this.scheduleFn = opts.schedule ?? defaultSchedule;
  }

  get state(): BridgeLinkState {
    return this.state_;
  }

  start(): void {
    // stop() 后可重新启用;运行中重复 start 幂等
    this.stopping = false;
    if (this.state_ !== "idle") return;
    this.connectLoop();
  }

  /** 停止:取消重连、关 socket、清队列;之后 start() 可重新启用。 */
  stop(): void {
    this.stopping = true;
    if (this.reconnectCancel) {
      this.reconnectCancel();
      this.reconnectCancel = null;
    }
    const sock = this.sock;
    this.sock = null;
    sock?.destroy();
    this.clearQueue();
    this.setState("idle");
  }

  /** 入队一帧(已编码);立即返回,由 drain 循环异步写出。 */
  enqueue(frame: Uint8Array): void {
    if (this.stopping) return;
    this.queue.push(frame);
    this.queuedBytes += frame.byteLength;
    const queuedMs = this.queuedMs;
    if (queuedMs > this.maxQueueMs) this.maxQueueMs = queuedMs;

    if (queuedMs > this.hardCapMs) {
      // 宁断不错位:超硬上限不裁队列,断连重连(§4.4)。
      this.opts.log?.(`bridge hardCap ${Math.round(queuedMs)}ms > ${this.hardCapMs}ms,断连重连`);
      this.opts.onHardCap?.(queuedMs);
      const sock = this.sock;
      if (sock) sock.destroy(); // handleClosed → stalled → 退避重连
      // 未连接(stalled/connecting)时无从断:队列保留,重连后重新判定。
      return;
    }
    if (queuedMs > this.highWaterMs) {
      if (!this.backpressureActive) {
        this.backpressureActive = true;
        this.opts.log?.(`bridge backpressure ${Math.round(queuedMs)}ms > ${this.highWaterMs}ms (maxQueueMs=${Math.round(this.maxQueueMs)})`);
        this.opts.onBackpressure?.(queuedMs);
      }
    } else if (this.backpressureActive) {
      // 低水位恢复(Phase 5):回到 < highWater,背压解除(可 grep)。
      this.backpressureActive = false;
      this.opts.log?.(`bridge backpressure recovered ${Math.round(queuedMs)}ms <= ${this.highWaterMs}ms`);
    }
    this.drain();
  }

  /** 控制帧直写(CONFIG/BOUNDARY 等),不进队列(心跳/握手不得被积压队列阻塞)。 */
  sendNow(bytes: Uint8Array): boolean {
    const sock = this.sock;
    if (!sock) return false;
    try {
      return sock.write(bytes);
    } catch {
      return false;
    }
  }

  /** 清空队列(generation 变更时丢弃旧代次帧;这是时间线重置,不属于"丢最旧帧")。 */
  clearQueue(): void {
    this.queue = [];
    this.queuedBytes = 0;
    this.backpressureActive = false;
  }

  stats(): BridgeSourceStats {
    return {
      state: this.state_,
      queuedFrames: this.queue.length,
      queuedBytes: this.queuedBytes,
      queuedMs: this.queuedMs,
      maxQueueMs: this.maxQueueMs,
      sentFrames: this.sentFrames,
      sentBytes: this.sentBytes,
      reconnects: this.reconnects,
    };
  }

  /** 当前排队毫秒数(48k/s16le/2ch = 192000B/s 口径,MIN-05)。 */
  private get queuedMs(): number {
    return (this.queuedBytes / BRIDGE_PCM_BYTES_PER_SEC) * 1000;
  }

  private setState(state: BridgeLinkState, info?: { reason?: string }): void {
    if (this.state_ === state) return;
    const prev = this.state_;
    this.state_ = state;
    // 状态机迁移日志(Phase 5 出口判据:live→stalled→connecting→live 序列可 grep)。
    this.opts.log?.(`bridge link state: ${prev}→${state}${info?.reason ? ` (${info.reason})` : ""}`);
    this.opts.onStateChange?.(state, info);
  }

  private connectLoop(): void {
    if (this.stopping) return;
    this.setState("connecting");
    this.opts.connect().then(
      (sock) => this.attach(sock),
      (err: unknown) => {
        this.opts.log?.(`bridge connect failed: ${err instanceof Error ? err.message : String(err)}`);
        if (!this.stopping) {
          this.reconnects++;
          // 改法5(观测,不自停):ENOENT = 桥 socket 文件已不在(BridgeServer close
          // unlink 后的典型残留),该路径上退避重连注定失败。连续 12 次(退避 5s 起
          // ×2 封顶 30s,累计 ≈5 分钟)经 onStateChange 上报一次 permanent-loss 供
          // 对账/观测判定。**member 不得自停**:rebuildBridgeRoutes 靠「原 token 同
          // socketPath + 退避重连」接上,自停会破坏子进程崩溃重建语义。
          if (isEnoentError(err)) {
            this.connectEnoentStreak++;
            if (this.connectEnoentStreak === BRIDGE_ENOENT_PERMANENT_AFTER) {
              this.opts.log?.(
                `bridge permanent-loss: ENOENT 连续 ${this.connectEnoentStreak} 次(~5min,socket 文件消失;上报观测,不自停)`,
              );
              // 直接透传一次事件:setState 对同态迁移去重会吞掉 reason,这里必须让
              // onStateChange 观察方看到 permanent-loss 标记。
              this.opts.onStateChange?.("stalled", { reason: `permanent-loss:ENOENT x${this.connectEnoentStreak}` });
            }
          } else {
            this.connectEnoentStreak = 0;
          }
          this.setState("stalled", { reason: "connect-failed" });
        }
        this.scheduleReconnect();
      },
    );
  }

  private attach(sock: BridgeSocketLike): void {
    if (this.stopping) {
      sock.destroy();
      return;
    }
    if ((sock as { destroyed?: boolean }).destroyed) {
      // connect 与 destroy 竞态:close 事件可能已错过,按断连处理。
      this.handleClosed("dead-on-arrive");
      return;
    }
    this.sock = sock;
    this.waitingDrain = false;
    sock.on("drain", () => {
      this.waitingDrain = false;
      this.drain();
    });
    sock.on("close", () => this.handleClosed("closed"));
    sock.on("error", (err: { message?: string }) => {
      this.opts.log?.(`bridge socket error: ${err?.message ?? "unknown"}`); // close 随后到来
    });
    this.attempt = 0; // 连接成功,退避归位
    this.connectEnoentStreak = 0; // 连上即清 ENOENT 连败计数
    this.opts.onConnected(sock);
    this.setState("live");
    this.drain();
  }

  private handleClosed(reason: string): void {
    this.sock = null;
    this.waitingDrain = false;
    if (this.stopping) {
      this.setState("idle");
      return;
    }
    this.reconnects++;
    this.setState("stalled", { reason });
    // 修法②a:泵未在跑的过渡期 closed 不进退避,立即重连(对端未就绪则后续
    // connect 失败照常退避,不会热循环)。
    this.scheduleReconnect(
      this.opts.immediateReconnectOnClosed?.() === true ? 0 : undefined,
    );
  }

  private scheduleReconnect(forcedDelayMs?: number): void {
    if (this.stopping || this.reconnectCancel) return;
    this.attempt++;
    let delay: number;
    let tag = "";
    if (forcedDelayMs !== undefined) {
      delay = forcedDelayMs;
      tag = " (immediate: pump idle)";
    } else {
      delay = this.opts.backoffDelayMs
        ? this.opts.backoffDelayMs(this.attempt)
        : computeBridgeBackoffMs(this.attempt, Math.random());
    }
    this.opts.log?.(`bridge reconnect in ${delay}ms (attempt ${this.attempt})${tag}`);
    this.reconnectCancel = this.scheduleFn(() => {
      this.reconnectCancel = null;
      this.connectLoop();
    }, delay);
  }

  /** 把队列尽可能写进 socket;write() 返回 false 即停,等 drain 事件续传。
   *  ⚠️ Node 语义:write() 返回 false 时数据**已被接收**进流内部缓冲(只是越过
   *  high-water mark),绝不可重写,否则该帧重复。因此 false 时也 shift 出队,
   *  只暂停后续帧,drain 事件后继续。 */
  private drain(): void {
    const sock = this.sock;
    if (!sock || this.waitingDrain) return;
    while (this.queue.length > 0) {
      const frame = this.queue[0] as Uint8Array;
      let ok = false;
      try {
        ok = sock.write(frame);
      } catch {
        return; // socket 已坏,等 close → 重连
      }
      this.queue.shift();
      this.queuedBytes -= frame.byteLength;
      this.sentFrames++;
      this.sentBytes += frame.byteLength;
      if (!ok) {
        this.waitingDrain = true;
        return;
      }
    }
  }
}
