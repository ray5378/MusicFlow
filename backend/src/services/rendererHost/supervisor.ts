// ==================== 常驻渲染器子进程:主进程侧宿主(通用) ====================
//
// 把「一个需要硬实时/原生 addon/不可信代码的渲染器运行时」fork 到**专属常驻子进程**,
// 彻底隔离主进程事件循环被前端/后台任务阻塞对推流节奏的干扰。
//
// 本模块是通用层,由 sendspin(现网 / v3.0.34 起) 的 supervisor 固化而来。同构的两个业务:
//   - sendspin:25ms 节拍 + libflacjs WASM + @discordjs/opus 原生 addon;
//   - airplay :7.98ms 节拍 + 进程内 ALAC 打包 + AES-CBC 加密。
// 两者都是「常驻子进程 + 快照镜像 + RPC 命令 + 崩溃退避重启 + 心跳看门狗」,
// 所以宿主只写一份,业务只提供:子进程入口、镜像初值、快照/就绪的落镜方式、事件分发。
//
// 与 batch/runner.ts 的区别(别混):
//   - batch 是「一次性任务子进程」:fork → run → result → exit,靠 G2(内存峰值)+G3(不可信代码);
//   - 这里是「常驻服务子进程」:fork → init → 长驻,靠 G1(deadline 循环)+G4(状态可镜像)。
//
// 通信面(协议见 ipcProtocol.ts):
//   - 状态读:子进程周期/脏触发推 state 快照 → 本类维护 mirror,主进程同步读;
//   - 命令写:rpc(req/res 按 id 回填),长耗时操作可传更长超时;
//   - 事件:业务事件 → onEvent(由 setHooks 注入的 hooks 承接)。
// 子进程日志走 stdio inherit → 与主进程同汇 docker logs,排障路径不变。
import { fork, type ChildProcess } from "child_process";
import {
  RENDERER_RPC_TIMEOUT_MS,
  RENDERER_STOP_TIMEOUT_MS,
  RENDERER_HEARTBEAT_MS,
  RENDERER_BOOT_TIMEOUT_MS,
  RENDERER_RESPAWN_BASE_MS,
  RENDERER_RESPAWN_MAX_MS,
  RENDERER_STABLE_RESET_MS,
  type HostToChild,
  type ChildToHost,
  type ResEnvelope,
} from "./ipcProtocol.js";
import { createLogger } from "../../utils/logger.js";

export interface RendererHostOptions<TMirror, TReady, TSnapshot, TEvent, THooks extends object> {
  /** 业务名,用于日志与报错文案(如 "sendspin" / "airplay")。 */
  name: string;
  /** 日志通道名(保持既有通道,便于 docker logs 过滤)。 */
  logName: string;
  /** 子进程入口绝对路径(prod 为 dist 下的 .js,dev 为 .ts)。 */
  childEntry: string;
  /** fork 时注入的环境变量(业务标记,子进程入口据此走 in-proc 装配,避免递归 fork)。 */
  childEnv?: Record<string, string>;
  /** 状态镜像初值(主进程同步读的那份)。 */
  initialMirror: TMirror;
  /** mainReady 载荷落进镜像。 */
  applyReady?: (mirror: TMirror, info: TReady) => void;
  /** state 快照重建镜像。 */
  applyState: (mirror: TMirror, snapshot: TSnapshot) => void;
  /** 业务事件分发(hooks 由 setHooks 提供)。 */
  onEvent?: (event: TEvent, hooks: THooks) => void;
  /** 就绪日志里的镜像摘要(如 `port=38927 serverId=…`)。 */
  describeMirror?: (mirror: TMirror) => string;
  rpcTimeoutMs?: number;
  stopTimeoutMs?: number;
  heartbeatMs?: number;
  bootTimeoutMs?: number;
}

interface PendingRpc {
  resolve: (v: any) => void;
  reject: (e: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export class RendererHostSupervisor<
  TMirror,
  TReady extends object,
  TSnapshot extends object,
  TEvent extends { t: string },
  THooks extends object,
> {
  private readonly opts: RendererHostOptions<TMirror, TReady, TSnapshot, TEvent, THooks>;
  private readonly log: ReturnType<typeof createLogger>;
  private child: ChildProcess | null = null;
  private running = false;
  private stopping = false;
  private rpcSeq = 0;
  private pending = new Map<number, PendingRpc>();
  private respawnTimer: ReturnType<typeof setTimeout> | null = null;
  private respawnDelay = RENDERER_RESPAWN_BASE_MS;
  private startedAt = 0;
  private lastHeartbeat = 0;
  private heartbeatCheck: ReturnType<typeof setInterval> | null = null;
  private hooks: THooks | null = null;
  private pendingBootCleanup: (() => void) | null = null;

  /** 主进程同步读的状态镜像(子进程 state 快照)。 */
  readonly mirror: TMirror;

  /** 看门狗:超过 3 个心跳周期没任何消息视为卡死,强杀并重启。 */
  private readonly heartbeatTimeoutMs: number;

  constructor(opts: RendererHostOptions<TMirror, TReady, TSnapshot, TEvent, THooks>) {
    this.opts = opts;
    this.log = createLogger(opts.logName);
    this.mirror = opts.initialMirror;
    this.heartbeatTimeoutMs = (opts.heartbeatMs ?? RENDERER_HEARTBEAT_MS) * 3 + 5_000;
  }

  setHooks(hooks: THooks): void {
    this.hooks = hooks;
  }

  isRunning(): boolean {
    return this.running;
  }

  get childPid(): number | undefined {
    return this.child?.pid;
  }

  /** fork 子进程并等其 runtime 就绪(mainReady)。幂等:已运行直接返回。 */
  async start(): Promise<void> {
    if (this.running) return;
    this.stopping = false;
    await this.spawnAndWait();
    this.running = true;
    this.startedAt = Date.now();
    this.respawnDelay = RENDERER_RESPAWN_BASE_MS;
    this.startHeartbeatCheck();
    const suffix = this.opts.describeMirror ? ` ${this.opts.describeMirror(this.mirror)}` : "";
    this.log.info(`${this.opts.name} 子进程已就绪: pid=${this.child?.pid}${suffix}`);
  }

  /** 优雅停止:RPC stop(子进程清干净后自己退)→ 兜底 SIGKILL。幂等。 */
  async stop(): Promise<void> {
    if (!this.running && !this.child) return;
    this.stopping = true;
    this.running = false;
    this.stopHeartbeatCheck();
    if (this.respawnTimer) {
      clearTimeout(this.respawnTimer);
      this.respawnTimer = null;
    }
    const child = this.child;
    if (!child) return;
    try {
      await this.rpc("stop", undefined, this.opts.stopTimeoutMs ?? RENDERER_STOP_TIMEOUT_MS);
    } catch { /* 超时/已死都走强杀兜底 */ }
    this.killChild("SIGKILL");
    this.log.info(`${this.opts.name} 子进程已停止`);
  }

  /** RPC 请求:发 req{id,op,payload},按 id 等 res。子进程不在则立刻失败。 */
  rpc<T = unknown>(op: string, payload?: unknown, timeoutMs = this.opts.rpcTimeoutMs ?? RENDERER_RPC_TIMEOUT_MS): Promise<T> {
    const child = this.child;
    if (!child || !this.running) return Promise.reject(new Error(`${this.opts.name} 子进程未运行(${op})`));
    const id = ++this.rpcSeq;
    const name = this.opts.name;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${name} rpc 超时: ${op} (${timeoutMs}ms)`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try {
        child.send({ t: "req", id, op, payload } satisfies HostToChild);
      } catch (e: any) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(new Error(`${name} rpc 发送失败: ${op} ${e?.message || e}`));
      }
    });
  }

  /** 发即忘消息(配置热更新等,不需应答的)。 */
  post(msg: object): void {
    try {
      this.child?.send(msg);
    } catch { /* 子进程已死:重启路径会带新配置 */ }
  }

  // ==================== 内部 ====================

  private async spawnAndWait(): Promise<void> {
    const child = fork(this.opts.childEntry, [], {
      stdio: ["inherit", "inherit", "inherit", "ipc"],
      env: { ...process.env, ...(this.opts.childEnv ?? {}) },
    });
    this.child = child;
    child.on("message", (raw: ChildToHost<TReady, TSnapshot, TEvent>) => this.onMessage(raw));
    child.once("exit", (code, signal) => this.onExit(code, signal));
    // 等 mainReady(或失败)。
    await new Promise<void>((resolve, reject) => {
      const onMsg = (raw: ChildToHost<TReady, TSnapshot, TEvent>) => {
        if (raw?.t === "mainReady") {
          cleanup();
          this.opts.applyReady?.(this.mirror, raw as unknown as TReady);
          resolve();
        }
      };
      const onExitOnce = (code: number | null, signal: string | null) => {
        cleanup();
        reject(new Error(`${this.opts.name} 子进程启动即退: code=${code} signal=${signal}`));
      };
      const bootTimer = setTimeout(() => {
        cleanup();
        reject(new Error(`${this.opts.name} 子进程启动超时(${(this.opts.bootTimeoutMs ?? RENDERER_BOOT_TIMEOUT_MS) / 1000}s)`));
      }, this.opts.bootTimeoutMs ?? RENDERER_BOOT_TIMEOUT_MS);
      const cleanup = () => {
        clearTimeout(bootTimer);
        child.off("message", onMsg);
        child.off("exit", onExitOnce);
        this.pendingBootCleanup = null;
      };
      this.pendingBootCleanup = cleanup;
      child.on("message", onMsg);
      child.once("exit", onExitOnce);
    });
  }

  private onMessage(raw: ChildToHost<TReady, TSnapshot, TEvent>): void {
    if (!raw || typeof raw !== "object") return;
    this.lastHeartbeat = Date.now();
    switch ((raw as { t?: string }).t) {
      case "heartbeat":
        return; // 只喂看门狗
      case "mainReady":
        return; // 启动握手已在 spawnAndWait 消费
      case "childReady":
        return;
      case "state":
        // 信封的判别字段 t 一并传入;业务只读自己关心的字段(结构上多一个 t 无害)。
        this.opts.applyState(this.mirror, raw as unknown as TSnapshot);
        return;
      case "res": {
        // 业务事件 TEvent 理论上也可能带 t:"res" 判别,所以要显式收窄到信封类型。
        const res = raw as unknown as ResEnvelope;
        const p = this.pending.get(res.id);
        if (!p) return;
        this.pending.delete(res.id);
        clearTimeout(p.timer);
        if (res.ok) p.resolve(res.result);
        else p.reject(new Error(res.error || `${this.opts.name} rpc failed`));
        return;
      }
      case "stopped":
        return; // stop 流程由 rpc("stop") 应答驱动
      default:
        // 业务事件(activated / closed / playFailed / sessionEnded …)。
        if (this.opts.onEvent && this.hooks) {
          try { this.opts.onEvent(raw as unknown as TEvent, this.hooks); } catch { /* 事件处理失败不拖垮桥 */ }
        }
        return;
    }
  }

  private onExit(code: number | null, signal: string | null): void {
    this.child = null;
    this.pendingBootCleanup?.();
    this.pendingBootCleanup = null;
    // 失败所有挂起 rpc。
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(new Error(`${this.opts.name} 子进程退出: code=${code} signal=${signal}`));
    }
    this.pending.clear();
    if (this.stopping || !this.running) return; // 计划内停止
    // 计划外崩溃:退避重启(设备会经 mDNS/记忆重拔回连,activated 事件重建播放器)。
    this.log.error(`${this.opts.name} 子进程意外退出,${this.respawnDelay / 1000}s 后重启: code=${code} signal=${signal}`);
    if (Date.now() - this.startedAt > RENDERER_STABLE_RESET_MS) this.respawnDelay = RENDERER_RESPAWN_BASE_MS;
    const delay = this.respawnDelay;
    this.respawnDelay = Math.min(RENDERER_RESPAWN_MAX_MS, this.respawnDelay * 2);
    this.respawnTimer = setTimeout(() => {
      this.respawnTimer = null;
      if (!this.running) return;
      this.spawnAndWait()
        .then(() => {
          this.startedAt = Date.now();
          this.log.info(`${this.opts.name} 子进程重启成功`);
        })
        .catch((e) => {
          this.log.error(`${this.opts.name} 子进程重启失败: ${e?.message || e}`);
          this.running = false; // 下一次用户操作(路由/配置)会再触发 start
        });
    }, delay);
  }

  /** 强杀子进程(看门狗或 stop 兜底);onExit 会走重启/收尾分支。 */
  protected killChild(sig: NodeJS.Signals): void {
    const child = this.child;
    if (!child) return;
    try { child.kill(sig); } catch { /* ignore */ }
    this.child = null;
  }

  private startHeartbeatCheck(): void {
    this.lastHeartbeat = Date.now();
    if (this.heartbeatCheck) return;
    this.heartbeatCheck = setInterval(() => {
      if (!this.running) return;
      if (Date.now() - this.lastHeartbeat > this.heartbeatTimeoutMs) {
        this.log.error(`${this.opts.name} 子进程心跳超时(${this.heartbeatTimeoutMs}ms),强杀重启`);
        this.killChild("SIGKILL"); // onExit 走退避重启
      }
    }, 30_000);
  }

  private stopHeartbeatCheck(): void {
    if (this.heartbeatCheck) {
      clearInterval(this.heartbeatCheck);
      this.heartbeatCheck = null;
    }
  }
}
