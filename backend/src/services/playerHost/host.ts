// ==================== 每播放器一进程：父进程侧宿主 ====================
//
// ===== 对标 MA =====
// MA 位置：music_assistant/providers/airplay/stream.py:327
//          （AsyncProcess(args, stdin=True, stdout=True, stderr=True, name="cliairplay")
//          —— 每台播放器一个专属子进程，connect() 挂起、start() 锚定、stop() 收尾）
//          + stream.py:93-99（_STDIN_DRAIN_TIMEOUT=2s：stdin 排空超时 ⇒ 判定
//          读取端卡死 ⇒ 「cold restart … is the right answer anyway」）。
// MA 语义：一台播放器 = 一个专属进程；子进程卡死不做进程内抢救，直接进程级
//          冷重启；故障域 = 单台设备，绝不牵连组内其它播放器。
// 我们：fork 子进程 + 心跳(2s)/无响应判死(6s)/SIGKILL + 指数退避重启(250ms→8s)
//          —— 同一哲学的 TS 实现。差异：MA 的活性信号是「写 stdin 是否能排空」
//          （它有写路径可探）；我们契约里没有可写探针，用 ping/pong 心跳 +
//          status 上报新鲜度作为等价活性信号。
import { fork, type ChildProcess } from "node:child_process";
import path from "node:path";
import { resolveChildEntry } from "../rendererHost/paths.js";
import { createLogger } from "../../utils/logger.js";
import type { ParentToPlayer, PlayerStatus, PlayerToParent } from "./ipcProtocol.js";

const log = createLogger("player-host");

export interface PlayerHostOptions {
  deviceId: string;
  /** 子进程入口；默认同目录 child.js（dev 下自动退回 child.ts） */
  entry?: string;
  /** 额外环境变量（子进程侧可用作 runtime 选择） */
  env?: Record<string, string>;
  /** 心跳间隔 / 判死阈值 */
  heartbeatMs?: number;
  deadAfterMs?: number;
  /** 崩溃重启退避上限 */
  maxBackoffMs?: number;
}

/**
 * 一台播放器 = 一个常驻子进程。
 *
 * 设计要点（对齐 MA 的 cliairplay 单进程模型）：
 *  · 父进程**只**发控制与 PCM，不做任何设备协议；
 *  · 子进程卡住时，父进程通过心跳判死 → 杀 → 退避重启，**不影响其他播放器**；
 *  · 状态由子进程主动上报（等价 MA 的 stderr [STATUS]）。
 */
export class PlayerHost {
  readonly deviceId: string;
  private child: ChildProcess | null = null;
  private readonly opts: Required<Omit<PlayerHostOptions, "env" | "entry">> & {
    entry: string;
    env: Record<string, string>;
  };
  private statusCb: ((s: PlayerStatus) => void) | null = null;
  private lastPongAt = 0;
  private lastStatusAt = 0;
  private heartbeat: NodeJS.Timeout | null = null;
  private watchdog: NodeJS.Timeout | null = null;
  private backoffMs = 250;
  private stopped = false;
  private ready = false;

  constructor(options: PlayerHostOptions) {
    this.deviceId = options.deviceId;
    this.opts = {
      deviceId: options.deviceId,
      entry: options.entry ?? resolveChildEntry(import.meta.url),
      env: options.env ?? {},
      heartbeatMs: options.heartbeatMs ?? 2_000,
      deadAfterMs: options.deadAfterMs ?? 6_000,
      maxBackoffMs: options.maxBackoffMs ?? 8_000,
    };
  }

  /** 启动并等待 ready（超时按失败抛出，调用方决定是否降级）。 */
  async start(timeoutMs = 10_000): Promise<void> {
    this.stopped = false;
    await this.spawn(timeoutMs);
  }

  private spawn(timeoutMs: number): Promise<void> {
    return new Promise((resolve, reject) => {
      const child = fork(this.opts.entry, [], {
        stdio: ["ignore", "inherit", "inherit", "ipc"],
        env: { ...process.env, ...this.opts.env, MF_PLAYER_DEVICE: this.deviceId },
      });
      this.child = child;
      this.ready = false;
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        try {
          child.kill("SIGKILL");
        } catch {
          /* 已退出 */
        }
        reject(new Error(`player ${this.deviceId} ready 超时(${timeoutMs}ms)`));
      }, timeoutMs);

      child.on("message", (raw: unknown) => this.handleMessage(raw as PlayerToParent));
      child.on("exit", (code, signal) => {
        if (this.child === child) this.child = null;
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          reject(new Error(`player ${this.deviceId} 启动即退出 code=${code} signal=${signal}`));
        }
        if (this.stopped) return;
        log.warn(`[player-host] ${this.deviceId} 子进程退出 code=${code} signal=${signal}，准备重启`);
        this.scheduleRestart();
      });

      const onReady = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.ready = true;
        this.backoffMs = 250;
        this.lastPongAt = Date.now();
        this.startTimers();
        log.info(`[player-host] ${this.deviceId} 子进程就绪 pid=${child.pid}`);
        resolve();
      };
      // ready 由子进程主动上报；这里挂一次性监听
      this.onceReady = onReady;
    });
  }

  private onceReady: (() => void) | null = null;

  private handleMessage(msg: PlayerToParent): void {
    switch (msg.t) {
      case "ready":
        this.lastPongAt = Date.now();
        this.onceReady?.();
        break;
      case "pong":
        this.lastPongAt = Date.now();
        break;
      case "status":
        this.lastStatusAt = Date.now();
        this.statusCb?.(msg);
        break;
      case "underrun":
        log.warn(`[player-host] ${this.deviceId} 饥荒 ${msg.ms}ms (${msg.reason})`);
        break;
      case "ended":
        log.info(`[player-host] ${this.deviceId} 会话结束: ${msg.reason}`);
        break;
      case "fatal":
        log.error(`[player-host] ${this.deviceId} 致命错误: ${msg.error}`);
        break;
      default:
        break;
    }
  }

  private startTimers(): void {
    this.stopTimers();
    this.heartbeat = setInterval(() => {
      this.send({ t: "ping", at: Date.now() });
    }, this.opts.heartbeatMs);
    this.watchdog = setInterval(() => {
      const silent = Date.now() - Math.max(this.lastPongAt, this.lastStatusAt);
      if (silent > this.opts.deadAfterMs) {
        log.error(`[player-host] ${this.deviceId} ${silent}ms 无响应，判死重启`);
        this.kill();
      }
    }, this.opts.heartbeatMs);
  }

  private stopTimers(): void {
    if (this.heartbeat) clearInterval(this.heartbeat);
    if (this.watchdog) clearInterval(this.watchdog);
    this.heartbeat = null;
    this.watchdog = null;
  }

  private scheduleRestart(): void {
    this.stopTimers();
    const delay = this.backoffMs;
    this.backoffMs = Math.min(this.opts.maxBackoffMs, this.backoffMs * 2);
    setTimeout(() => {
      if (this.stopped) return;
      this.spawn(10_000).catch((e) => {
        log.error(`[player-host] ${this.deviceId} 重启失败: ${(e as Error).message}`);
        this.scheduleRestart();
      });
    }, delay);
  }

  send(msg: ParentToPlayer): boolean {
    if (!this.child || !this.child.connected) return false;
    try {
      this.child.send(msg);
      return true;
    } catch {
      return false;
    }
  }

  onStatus(cb: (s: PlayerStatus) => void): void {
    this.statusCb = cb;
  }

  isReady(): boolean {
    return this.ready && this.child !== null;
  }

  private kill(): void {
    try {
      this.child?.kill("SIGKILL");
    } catch {
      /* ignore */
    }
    this.child = null;
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.stopTimers();
    const child = this.child;
    this.child = null;
    if (!child) return;
    this.send({ t: "stop" });
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        try {
          child.kill("SIGKILL");
        } catch {
          /* ignore */
        }
        resolve();
      }, 2_000);
      child.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }
}

export { path };
