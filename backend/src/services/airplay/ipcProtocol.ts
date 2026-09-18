// ==================== AirPlay 子进程 IPC 协议(业务载荷) ====================
//
// 通用信封来自 `../rendererHost/ipcProtocol.js`;这里只定义 AirPlay 自己的载荷:
//   - 快照:各设备的会话态(设备发现/DB/peer 都留在主进程,不进快照);
//   - 就绪信息:子进程自报已加载(无 DB,故只需一个标记);
//   - 事件:sessionEnded → 主进程上报 IDLE(等价 DLNA 的 GENA,让队列自动续播)。
//
// ⚠️ 快照刻意**不含** PSK / token URL 之外的敏感信息;streamUrl 本身是 DLNA 的
//    短期 token 化地址,主进程已经持有,镜像一份只为 peerStatus.trackUri 用。
import type { HostToChild, ChildToHost, StateEnvelope } from "../rendererHost/ipcProtocol.js";
import type { AirplaySessionMirrorRow } from "./sessionRuntime.js";

// 业务侧常用的载荷类型从一处透出(type-only,运行时无 import)。
export type { AirplayCastArgs, AirplaySessionMirrorRow, AirplayRuntimeHooks } from "./sessionRuntime.js";

/** state 快照载荷(平铺进信封)。 */
export interface AirplaySnapshot {
  sessions: AirplaySessionMirrorRow[];
}

/** mainReady 载荷:子进程就绪标记 + 自身 pid(便于日志/排障)。 */
export interface AirplayReadyInfo {
  pid: number;
}

/** 子进程 → 主进程的业务事件。 */
export type AirplayChildEvent = { t: "sessionEnded"; deviceId: string };

/** 主进程 → 子进程:除通用 req/stop 外无附加消息。 */
export type AirplayHostExtra = never;

export type ParentToAirplayChild = HostToChild<AirplayHostExtra>;
export type AirplayChildToParent = ChildToHost<AirplayReadyInfo, AirplaySnapshot, AirplayChildEvent>;

export type AirplayStateEnvelope = StateEnvelope<AirplaySnapshot>;
