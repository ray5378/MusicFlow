// ==================== 常驻渲染器子进程:IPC 通用信封 ====================
//
// 主进程 RendererHostSupervisor ⇄ 子进程 ChildRpcHost 之间共享的**信封契约**。
// 信封本身（req/res/heartbeat/ready/state/stop）全业务一致,业务载荷由泛型注入:
//   TExtra  主进程 → 子进程的附加消息(如 cfg 热更新);
//   TReady  mainReady 的载荷(业务自报的就绪信息);
//   TSnapshot  state 快照的载荷(业务要镜像到主进程的内容);
//   TEvent  子进程主动上报的业务事件(activated/closed/sessionEnded …)。
//
// 关键技巧:`({ t: "state" } & TSnapshot)` 这类交叉类型让业务侧**保持扁平消息形状**
// (`{ t:"state", clients, groups, … }`),信封只是类型层面的约定,不改运行时形状。
//
// 设计要点(从 sendspin 现网实现固化而来):
//  - 所有请求都带自增 id,res 按 id 回填 Promise(见 supervisor.ts);
//  - 状态读走「快照推送」:业务侧脏了就推,150ms 节流 + 1s 兜底扫;主进程同步读镜像。
//    40 次/秒级的高频字段(如 positionMs)不进快照,走 RPC 轮询,避免 IPC 风暴;
//  - 心跳由子进程周期上报,主进程看门狗据此判卡死(仿 batch/runner.ts)。
//
// ⚠️ 本文件只放类型与常量,不许 import 任何重依赖(主/子两侧都要用)。

/** 主进程 → 子进程:通用信封 + 业务附加消息。 */
export type HostToChild<TExtra extends object = never> =
  | { t: "req"; id: number; op: string; payload?: unknown }
  | { t: "stop" }
  | TExtra;

/** 子进程 → 主进程:mainReady 信封(业务载荷 TReady 交叉进来,保持扁平)。 */
export type MainReadyEnvelope<TReady extends object> = { t: "mainReady" } & TReady;

/** 子进程 → 主进程:state 快照信封(业务载荷 TSnapshot 交叉进来,保持扁平)。 */
export type StateEnvelope<TSnapshot extends object> = { t: "state" } & TSnapshot;

/** 子进程 → 主进程:RPC 应答 / 心跳 / 停止确认。 */
export type ResEnvelope = { t: "res"; id: number; ok: boolean; result?: unknown; error?: string };
export type HeartbeatEnvelope = { t: "heartbeat"; pid: number };
export type StoppedEnvelope = { t: "stopped" };
export type ChildReadyEnvelope = { t: "childReady"; pid: number };

/** 子进程 → 主进程:通用信封 + 业务事件 TEvent(自带判别字段 t)。 */
export type ChildToHost<TReady extends object, TSnapshot extends object, TEvent extends { t: string }> =
  | ChildReadyEnvelope
  | MainReadyEnvelope<TReady>
  | HeartbeatEnvelope
  | StateEnvelope<TSnapshot>
  | ResEnvelope
  | StoppedEnvelope
  | TEvent;

/** 子进程侧允许自己发的信封子集(ChildRpcHost 内部只用这些)。 */
export type ChildBaseEnvelope<TSnapshot extends object> =
  | HeartbeatEnvelope
  | StateEnvelope<TSnapshot>
  | ResEnvelope
  | StoppedEnvelope;

// ==================== 时序常量 ====================

/** rpc 超时缺省:控制面操作(如拨号/握手)需要十几秒宽限。 */
export const RENDERER_RPC_TIMEOUT_MS = 25_000;
/** 停止宽限:子进程收 stop 后清干净(反注册/关连接/停发现)再退。 */
export const RENDERER_STOP_TIMEOUT_MS = 15_000;
/** 快照节流:脏了立即推,但最小间隔,防 IPC 风暴。 */
export const RENDERER_SNAPSHOT_THROTTLE_MS = 150;
/** 快照兜底周期:没有钩子也能捕捉的状态变化(如自然结束清 current)。 */
export const RENDERER_SNAPSHOT_SWEEP_MS = 1_000;
/** 心跳周期;看门狗按 3× + 5s 判卡死。 */
export const RENDERER_HEARTBEAT_MS = 30_000;
/** 启动握手超时(fork 后等 mainReady)。 */
export const RENDERER_BOOT_TIMEOUT_MS = 30_000;
/** 崩溃重启退避:3s 起步,指数 ×2,封顶 30s;连续稳定 5min 后复位。 */
export const RENDERER_RESPAWN_BASE_MS = 3_000;
export const RENDERER_RESPAWN_MAX_MS = 30_000;
export const RENDERER_STABLE_RESET_MS = 5 * 60_000;
