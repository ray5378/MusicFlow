// ==================== Sendspin 子进程管理器(主进程侧) ====================
//
// 把 sendspin 运行时(WS 38927 + 解码/编码/推流 + mDNS + 拨号 + 6053 桥)fork 到
// **专属常驻子进程**,彻底隔离主进程事件循环被前端/后台任务阻塞对推流节奏的干扰。
// 仿 batch/runner.ts 的成熟模式,但语义不同:
//  - batch 是「一次性任务子进程」:fork → run → result → exit;
//  - 这里是「常驻服务子进程」:fork → init → 长驻;崩溃自动重启(退避),插件停用才停。
//
// 通信面(协议见 ipcProtocol.ts):
//  - 状态读:child 周期/脏触发推 `state` 快照 → 本模块维护 Mirror,主进程同步读;
//  - 命令写:rpc(req/res 按 id 回填),dial/stop 有更长超时;
//  - 事件:activated/closed/playFailed → 转给 index.ts 的注册/注销逻辑。
// 子进程日志走 stdio inherit → 与主进程同汇 docker logs,排障路径不变。
import { fork, type ChildProcess } from "child_process";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";
import {
  SENDSPIN_RPC_TIMEOUT_MS,
  SENDSPIN_STOP_TIMEOUT_MS,
  SENDSPIN_HEARTBEAT_MS,
  type ParentToSendspinChild,
  type SendspinChildToParent,
  type ClientMirrorMsg,
  type GroupMirrorMsg,
  type PairRecordMirrorMsg,
  type SendspinIpcConfig,
} from "./ipcProtocol.js";
import { createLogger } from "../../utils/logger.js";

const log = createLogger("Sendspin-supervisor");

const here = path.dirname(fileURLToPath(import.meta.url));
const CHILD_ENTRY = fs.existsSync(path.join(here, "child.js"))
  ? path.join(here, "child.js")
  : path.join(here, "child.ts");

/** 崩溃重启退避:3s 起步,指数×2,封顶 30s;连续稳定 5min 后复位。 */
const RESPAWN_BASE_MS = 3_000;
const RESPAWN_MAX_MS = 30_000;
const STABLE_RESET_MS = 5 * 60_000;

interface PendingRpc {
  resolve: (v: any) => void;
  reject: (e: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export interface SendspinMirror {
  serverId: string;
  port: number;
  clients: Map<string, ClientMirrorMsg>;
  groups: Map<string, GroupMirrorMsg>;
  records: Map<string, PairRecordMirrorMsg>;
  attempts: unknown[];
}

export interface SupervisorHooks {
  /** 客户端激活(主进程据此注册 QC/PM 播放器,与 in-proc registerServerPlayer 同构)。 */
  onActivated?: (clientId: string, name: string, legacy: boolean) => void;
  onClosed?: (clientId: string) => void;
  onPlayFailed?: (clientId: string, songId: string, message: string) => void;
}

class SendspinSupervisor {
  private child: ChildProcess | null = null;
  private running = false;
  private stopping = false;
  private port = 38927;
  private rpcSeq = 0;
  private pending = new Map<number, PendingRpc>();
  private respawnTimer: ReturnType<typeof setTimeout> | null = null;
  private respawnDelay = RESPAWN_BASE_MS;
  private startedAt = 0;
  private lastHeartbeat = 0;
  private heartbeatCheck: ReturnType<typeof setInterval> | null = null;
  private hooks: SupervisorHooks = {};
  /** 主进程同步读的状态镜像(child state 快照)。 */
  readonly mirror: SendspinMirror = {
    serverId: "",
    port: 0,
    clients: new Map(),
    groups: new Map(),
    records: new Map(),
    attempts: [],
  };

  /** 看门狗:超过 3 个心跳周期没任何消息视为卡死,强杀并重启。 */
  private static HEARTBEAT_TIMEOUT_MS = SENDSPIN_HEARTBEAT_MS * 3 + 5_000;

  setHooks(hooks: SupervisorHooks): void {
    this.hooks = hooks;
  }

  isRunning(): boolean {
    return this.running;
  }

  /** fork 子进程并等其 runtime 就绪(mainReady)。幂等:已运行直接返回。 */
  async start(port: number): Promise<void> {
    if (this.running) return;
    this.stopping = false;
    this.port = port;
    await this.spawnAndWait();
    this.running = true;
    this.startedAt = Date.now();
    this.respawnDelay = RESPAWN_BASE_MS;
    this.startHeartbeatCheck();
    log.info(`sendspin 子进程已就绪: pid=${this.child?.pid} port=${port}`);
  }

  /** 优雅停止:RPC stop(child 清干净后自己退)→ 兜底 SIGKILL。幂等。 */
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
      await this.rpc("stop", undefined, SENDSPIN_STOP_TIMEOUT_MS);
    } catch { /* 超时/已死都走强杀兜底 */ }
    this.killChild("SIGKILL");
    log.info("sendspin 子进程已停止");
  }

  /** RPC 请求:发 req{id,op,payload},按 id 等 res。child 不在则立刻失败。 */
  rpc<T = unknown>(op: string, payload?: unknown, timeoutMs = SENDSPIN_RPC_TIMEOUT_MS): Promise<T> {
    const child = this.child;
    if (!child || !this.running) return Promise.reject(new Error(`sendspin 子进程未运行(${op})`));
    const id = ++this.rpcSeq;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`sendspin rpc 超时: ${op} (${timeoutMs}ms)`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try {
        child.send({ t: "req", id, op, payload } as ParentToSendspinChild);
      } catch (e: any) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(new Error(`sendspin rpc 发送失败: ${op} ${e?.message || e}`));
      }
    });
  }

  /** 发即忘消息(cfg 热更新等,不需应答的)。 */
  post(msg: ParentToSendspinChild): void {
    try {
      this.child?.send(msg);
    } catch { /* child 已死:重启路径会带新配置 */ }
  }

  // ==================== 内部 ====================

  private async spawnAndWait(): Promise<void> {
    const child = fork(CHILD_ENTRY, [], {
      stdio: ["inherit", "inherit", "inherit", "ipc"],
      env: {
        ...process.env,
        // 标记自身是 sendspin 子进程:内部 index.ts 走 in-proc 装配(不递归 fork)。
        MUSICFLOW_SENDSPIN_CHILD: "1",
      },
    });
    this.child = child;
    child.on("message", (raw: SendspinChildToParent) => this.onMessage(raw));
    child.once("exit", (code, signal) => this.onExit(code, signal));
    // 等 mainReady(或失败)。
    await new Promise<void>((resolve, reject) => {
      const onMsg = (raw: SendspinChildToParent) => {
        if (raw?.t === "mainReady") {
          cleanup();
          this.mirror.serverId = raw.serverId;
          this.mirror.port = raw.port;
          resolve();
        }
      };
      const onExitOnce = (code: number | null, signal: string | null) => {
        cleanup();
        reject(new Error(`sendspin 子进程启动即退: code=${code} signal=${signal}`));
      };
      const bootTimer = setTimeout(() => {
        cleanup();
        reject(new Error("sendspin 子进程启动超时(30s)"));
      }, 30_000);
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

  private pendingBootCleanup: (() => void) | null = null;

  private onMessage(raw: SendspinChildToParent): void {
    if (!raw || typeof raw !== "object") return;
    this.lastHeartbeat = Date.now();
    switch (raw.t) {
      case "heartbeat":
        return; // 只喂看门狗
      case "mainReady":
        return; // 启动握手已在 spawnAndWait 消费
      case "state":
        this.applySnapshot(raw);
        return;
      case "activated":
        try { this.hooks.onActivated?.(raw.clientId, raw.name, raw.legacy); } catch { /* 注册失败不拖垮桥 */ }
        return;
      case "closed":
        try { this.hooks.onClosed?.(raw.clientId); } catch { /* ignore */ }
        return;
      case "playFailed":
        try { this.hooks.onPlayFailed?.(raw.clientId, raw.songId, raw.message); } catch { /* ignore */ }
        return;
      case "res": {
        const p = this.pending.get(raw.id);
        if (!p) return;
        this.pending.delete(raw.id);
        clearTimeout(p.timer);
        if (raw.ok) p.resolve(raw.result);
        else p.reject(new Error(raw.error || "sendspin rpc failed"));
        return;
      }
      case "stopped":
        return; // stop 流程由 rpc("stop") 应答驱动
      case "childReady":
        return;
    }
  }

  private applySnapshot(s: Extract<SendspinChildToParent, { t: "state" }>): void {
    this.mirror.clients = new Map(s.clients.map((c) => [c.clientId, c]));
    this.mirror.groups = new Map(s.groups.map((g) => [g.name, g]));
    this.mirror.records = new Map(s.records.map((r) => [r.clientId, r]));
    this.mirror.attempts = s.attempts;
  }

  private onExit(code: number | null, signal: string | null): void {
    this.child = null;
    this.pendingBootCleanup?.();
    this.pendingBootCleanup = null;
    // 失败所有挂起 rpc。
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(new Error(`sendspin 子进程退出: code=${code} signal=${signal}`));
    }
    this.pending.clear();
    if (this.stopping || !this.running) return; // 计划内停止
    // 计划外崩溃:退避重启(设备会经 mDNS/记忆重拔回连,activated 事件重建播放器)。
    log.error(`sendspin 子进程意外退出,${this.respawnDelay / 1000}s 后重启: code=${code} signal=${signal}`);
    if (Date.now() - this.startedAt > STABLE_RESET_MS) this.respawnDelay = RESPAWN_BASE_MS;
    const delay = this.respawnDelay;
    this.respawnDelay = Math.min(RESPAWN_MAX_MS, this.respawnDelay * 2);
    this.respawnTimer = setTimeout(() => {
      this.respawnTimer = null;
      if (!this.running) return;
      this.spawnAndWait()
        .then(() => {
          this.startedAt = Date.now();
          log.info("sendspin 子进程重启成功");
        })
        .catch((e) => {
          log.error(`sendspin 子进程重启失败: ${e?.message || e}`);
          this.running = false; // 下一次用户操作(路由/配置)会再触发 start
        });
    }, delay);
  }

  private killChild(sig: NodeJS.Signals): void {
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
      if (Date.now() - this.lastHeartbeat > SendspinSupervisor.HEARTBEAT_TIMEOUT_MS) {
        log.error(`sendspin 子进程心跳超时(${SendspinSupervisor.HEARTBEAT_TIMEOUT_MS}ms),强杀重启`);
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

export const sendspinSupervisor = new SendspinSupervisor();

/** 构造热更新配置(主进程 DB 为单一可信源,child 不读 plugins 表)。 */
export function sendspinIpcConfigFrom(cfg: {
  port: number;
  allowLegacyClients: boolean;
  preferredCodec: "pcm" | "flac";
  autoDiscover: boolean;
  esphomeMirror: boolean;
  esphomePsk: string;
  esphomePort: number;
}): SendspinIpcConfig {
  return { ...cfg };
}
