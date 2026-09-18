// ==================== Sendspin 子进程 IPC 协议(纯类型 + 常量) ====================
//
// 主进程(supervisor) ⇄ sendspin 专属子进程(child)之间的消息契约。
// 设计要点:
//  - 所有请求都带自增 id,rpc-res 按 id 回填 Promise(见 supervisor.ts);
//  - 状态读走「快照推送」(state 消息,child 脏了就推,节流 1s),主进程同步读镜像;
//    命令写走 rpc(请求/响应)。positionMs 这类 40 次/秒的高频字段**不进快照**,
//    一律走 poll 轮询(QC 5s 一次),避免 IPC 风暴;
//  - 心跳由 child 周期上报,主进程看门狗据此判断卡死(仿 batch/runner.ts)。
// 注意:本文件只放类型,不许 import 任何重依赖(两边都要用)。

/** child 侧上报的连接快照(镜像给主进程同步读)。 */
export interface ClientMirrorMsg {
  clientId: string;
  name: string;
  roles: string[];
  legacy: boolean;
  ready: boolean;
  remoteHost: string;
  dialed: boolean;
  dialHost: string;
  dialPort: number;
  volume: number;
  muted: boolean;
}

/** child 侧上报的组快照(不含 positionMs —— 高频,走 poll)。 */
export interface GroupMirrorMsg {
  name: string;
  volume: number;
  muted: boolean;
  current: {
    songId: string;
    title?: string;
    artist?: string;
    album?: string;
    coverArt?: string;
    durationMs: number;
  } | null;
}

/** 配对记录快照(供 /v1/sendspin/clients 与 approve 页同步读)。 */
export interface PairRecordMirrorMsg {
  clientId: string;
  createdAt: number | null;
  lastUsedAt: number | null;
  approved: boolean;
}

/** 主进程 → child。 */
export type ParentToSendspinChild =
  | { t: "init"; port?: number }
  | { t: "cfg"; cfg: SendspinIpcConfig }
  | { t: "stop" }
  // —— RPC 请求(id 回填)——
  | { t: "req"; id: number; op: string; payload?: unknown };

/** child → 主进程。 */
export type SendspinChildToParent =
  | { t: "childReady"; pid: number }
  | { t: "mainReady"; serverId: string; port: number }
  | { t: "heartbeat"; pid: number }
  | { t: "state"; clients: ClientMirrorMsg[]; groups: GroupMirrorMsg[]; records: PairRecordMirrorMsg[]; attempts: unknown[] }
  | { t: "activated"; clientId: string; name: string; legacy: boolean }
  | { t: "closed"; clientId: string }
  | { t: "playFailed"; clientId: string; songId: string; message: string }
  | { t: "res"; id: number; ok: boolean; result?: unknown; error?: string }
  | { t: "stopped" };

/** 热更新配置(主进程读 DB 后下发;child 不自己读 plugins 表,单一可信源在主进程)。 */
export interface SendspinIpcConfig {
  port: number;
  allowLegacyClients: boolean;
  preferredCodec: "pcm" | "flac";
  autoDiscover: boolean;
  esphomeMirror: boolean;
  esphomePsk: string;
  esphomePort: number;
}

/** rpc 超时缺省:控制面操作(dial 需要 15s+ 宽限)。 */
export const SENDSPIN_RPC_TIMEOUT_MS = 25_000;
/** 停止宽限:child 收 stop 后清干净(反注册/关连接/停 mDNS)再退。 */
export const SENDSPIN_STOP_TIMEOUT_MS = 15_000;
/** 快照节流:脏了立即推,但最小间隔,防 IPC 风暴。 */
export const SENDSPIN_SNAPSHOT_THROTTLE_MS = 150;
/** 快照兜底周期:没有钩子也能捕捉的状态(如自然结束清 current)。 */
export const SENDSPIN_SNAPSHOT_SWEEP_MS = 1_000;
/** 心跳周期。 */
export const SENDSPIN_HEARTBEAT_MS = 30_000;
