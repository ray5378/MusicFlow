// ==================== Sendspin 子进程 IPC 协议(业务载荷) ====================
//
// 通用信封(req/res/heartbeat/ready/state/stop)来自 `../rendererHost/ipcProtocol.js`,
// 本文件只定义 **sendspin 自己的业务载荷**:
//   - 镜像快照:clients / groups / 配对记录 / 配对 attempts;
//   - 就绪信息:serverId + 真实监听端口(子进程自读 DB 决定,主进程只记);
//   - 业务事件:activated / closed / playFailed(主进程据此注册/注销 QC·PM 播放器);
//   - 主进程 → 子进程的附加消息:init / cfg 热更新。
//
// 注意:`{ t: "state" } & SendspinSnapshot` 这类交叉类型让消息**保持原有扁平形状**
// (`{ t:"state", clients, groups, records, attempts }`),信封只是类型层约定。
//
// ⚠️ 本文件只放类型与常量,不许 import 任何重依赖(两侧都要用)。

import type { HostToChild, ChildToHost, StateEnvelope } from "../rendererHost/ipcProtocol.js";
import {
  RENDERER_RPC_TIMEOUT_MS,
  RENDERER_STOP_TIMEOUT_MS,
  RENDERER_SNAPSHOT_THROTTLE_MS,
  RENDERER_SNAPSHOT_SWEEP_MS,
  RENDERER_HEARTBEAT_MS,
} from "../rendererHost/ipcProtocol.js";

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

/** state 快照载荷(平铺进信封,形状与重构前完全一致)。 */
export interface SendspinSnapshot {
  clients: ClientMirrorMsg[];
  groups: GroupMirrorMsg[];
  records: PairRecordMirrorMsg[];
  attempts: unknown[];
}

/** mainReady 载荷:子进程 runtime 就绪后自报的身份与端口。 */
export interface SendspinReadyInfo {
  serverId: string;
  port: number;
}

/** 主进程 → 子进程的附加消息(通用 req/stop 之外)。 */
export type SendspinHostExtra =
  | { t: "init"; port?: number }
  | { t: "cfg"; cfg: SendspinIpcConfig }
  /** 曲末预热下推(2026-10-30):主进程已算完「下一首可播」,让**子进程**在本进程内再
   *  算一次,把结论写进它自己那份 module-local 可播缓存。
   *
   *  起因(240 真机取证):主进程预热 28 次里 27 次 `cached ms=1~6`,而同一首歌 13s 后
   *  泵在子进程里 38 次全部 `ensure-ok ms=2900~3930` —— 泵命中 fresh-cache 的次数为 **0**。
   *  这 3s 落在曲末排空窗口(实测 9760~9786ms)里,超窗即可闻静音。
   *
   *  与下面 `songUnplayable`(子→主,负缓存回传)是同一类跨进程缓存断层的**反方向**。
   *  发即忘:不需要应答,子进程没起来时 `post()` 自带兜底。 */
  | { t: "preheat"; songId: string };

/** 子进程 → 主进程的业务事件。 */
export type SendspinChildEvent =
  | { t: "activated"; clientId: string; name: string; legacy: boolean }
  | { t: "closed"; clientId: string }
  | { t: "playFailed"; clientId: string; songId: string; message: string }
  /** 子进程把某首歌判死(提前 EOF / 完整性判官) —— 主进程必须**自己**再记一次负缓存。
   *  子进程的 streamFallback 缓存是 module-local Map,主进程读不到(2026-10-28 事故:
   *  子进程 18:28:22 已判死,主进程 18:28:46 重播时仍读到 unknown ⇒ 又播一遍试听片段)。 */
  | { t: "songUnplayable"; clientId: string; songId: string; reason: string }
  | { t: "pauseStopIssued"; clientId: string };

/** 主进程 → child。 */
export type ParentToSendspinChild = HostToChild<SendspinHostExtra>;

/** child → 主进程。 */
export type SendspinChildToParent = ChildToHost<SendspinReadyInfo, SendspinSnapshot, SendspinChildEvent>;

/** 热更新配置(主进程读 DB 后下发;child 不自己读 plugins 表,单一可信源在主进程)。
 *
 *  注:ESPHome 6053 的开关/密钥/端口**不在这里** —— 它们是每台设备各自的,
 *  存 sendspin_device_state(clientId → psk/port),经 `esphomeSync` 逐台下发。 */
export interface SendspinIpcConfig {
  port: number;
  allowLegacyClients: boolean;
  preferredCodec: "pcm" | "flac";
  autoDiscover: boolean;
}

export type SendspinStateEnvelope = StateEnvelope<SendspinSnapshot>;

// ==================== 时序常量 ====================
// 实现已统一到 rendererHost 通用层;这里保留 sendspin 名义下的别名,
// 既有的 supervisor/childMain/测试引用无需改动。

/** rpc 超时缺省:控制面操作(dial 需要 15s+ 宽限)。 */
export const SENDSPIN_RPC_TIMEOUT_MS = RENDERER_RPC_TIMEOUT_MS;
/** 停止宽限:child 收 stop 后清干净(反注册/关连接/停 mDNS)再退。 */
export const SENDSPIN_STOP_TIMEOUT_MS = RENDERER_STOP_TIMEOUT_MS;
/** 快照节流:脏了立即推,但最小间隔,防 IPC 风暴。 */
export const SENDSPIN_SNAPSHOT_THROTTLE_MS = RENDERER_SNAPSHOT_THROTTLE_MS;
/** 快照兜底周期:没有钩子也能捕捉的状态(如自然结束清 current)。 */
export const SENDSPIN_SNAPSHOT_SWEEP_MS = RENDERER_SNAPSHOT_SWEEP_MS;
/** 心跳周期。 */
export const SENDSPIN_HEARTBEAT_MS = RENDERER_HEARTBEAT_MS;
