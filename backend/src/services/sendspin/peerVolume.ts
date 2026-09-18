// ==================== Sendspin 设备音量「实时 / 持久」回显取值 ====================
//
// 音量回显有四处落点，全部走这一个取值函数，避免各写一份 live/DB 回退逻辑而再次错位：
//   1) peer 列表唯一出口 decoratePeersForClient（/v1/peers ＋ WS peer_snapshot）；
//   2) /v1/peers/:peerId/status 的 sendspin 分支（离线回显上次音量）；
//   3) 群组成员解析（Groups 页成员音量条）；
//   4) 写成功后的 WS peer_volume_changed 广播载荷。
//
// 取值口径（与 setVolumeCore/setMutedCore 的写入口径严格对称）：
//   1) 在线 → 实时**组音量**：in-proc 读真实 server，fork 读 supervisor 状态镜像
//      （与 group/index.ts 的 resolveSendspinMember 同一套原语，主进程两种模式都拿得到）。
//      ⚠️ 只读组音量，不读 conn.volume —— 后者是每连接 trim（恒 100），
//      与 setVolumeCore「只写组音量」的权威标度相反（见 playerCore.setVolumeCore）。
//   2) 离线（组缺席 / 服务未跑）→ 持久库值 sendspin_device_state；
//   3) 无行 → 缺省 100 / false（与「首次上线缺省 100」一致）。
//
// ⚠️ 刻意**不**导入 ./index.js：那会把整条 sendspin 服务栈（mDNS 广播 / 流引擎 /
//    Native API 桥接…）拖进 access 层这种超早加载的模块。这里只用 runtime + supervisor
//    两个轻量原语，与 group/index.ts 既有做法保持一致，也无循环依赖风险。
import { getServer } from "./runtime.js";
import { sendspinSupervisor } from "./supervisor.js";
import { getDeviceVolumeState } from "./deviceState.js";
import { createLogger } from "../../utils/logger.js";

const log = createLogger("Sendspin");

export interface SendspinVolumeSnapshot {
  volume: number;
  muted: boolean;
  /** 是否取到实时值（在线）。离线=false，供前端渲染灰态/决定是否需要「重连生效」提示。 */
  online: boolean;
}

function clampVol(v: unknown): number {
  const n = typeof v === "number" ? Math.round(v) : 100;
  return Math.min(100, Math.max(0, Number.isFinite(n) ? n : 100));
}

/** 取某设备的实时组音量视图：in-proc 真实 server → fork supervisor 镜像 → 都没有则 null。 */
function liveGroup(clientId: string): { volume?: number; muted?: boolean } | null {
  try {
    const srv = getServer();
    if (srv) {
      const g = srv.groups.get(clientId) as { volume?: number; muted?: boolean } | undefined;
      return g ?? null;
    }
    if (sendspinSupervisor.isRunning()) {
      const g = sendspinSupervisor.mirror.groups.get(clientId) as { volume?: number; muted?: boolean } | undefined;
      return g ?? null;
    }
  } catch (e: any) {
    log.warn(`[peer-volume] 读 ${clientId} 实时值失败: ${e?.message || e}`);
  }
  return null;
}

/** 取某 sendspin 设备（裸 clientId）的音量/静音快照：实时优先，离线回退持久值。
 *  全程 best-effort：任何异常都回退到库值/缺省，绝不抛给播控或回显热路径。 */
export function getSendspinDeviceVolume(clientId: string): SendspinVolumeSnapshot {
  if (!clientId) return { volume: 100, muted: false, online: false };
  const g = liveGroup(clientId);
  if (g && typeof g.volume === "number") {
    return { volume: clampVol(g.volume), muted: !!g.muted, online: true };
  }
  const st = getDeviceVolumeState(clientId);
  return { volume: st?.volume ?? 100, muted: st?.muted ?? false, online: false };
}

/** 给 peer 列表里的 sendspin 行补 volume/muted；其它 kind 原样返回（前端按存在性渲染）。
 *  在 decoratePeersForClient（唯一出口）里对**原始**列表调用，隐藏/打码/改名都不影响取值。 */
export function attachSendspinPeerVolumes<T extends { peerId: string; kind?: string }>(
  peers: T[],
): (T & { volume?: number; muted?: boolean })[] {
  if (!Array.isArray(peers) || peers.length === 0) return peers as (T & { volume?: number; muted?: boolean })[];
  let touched = false;
  const out = peers.map((p) => {
    if (!p || p.kind !== "sendspin") return p as T & { volume?: number; muted?: boolean };
    const clientId = typeof p.peerId === "string" && p.peerId.startsWith("sendspin:") ? p.peerId.slice(9) : "";
    if (!clientId) return p as T & { volume?: number; muted?: boolean };
    const snap = getSendspinDeviceVolume(clientId);
    touched = true;
    return { ...p, volume: snap.volume, muted: snap.muted } as T & { volume?: number; muted?: boolean };
  });
  return touched ? out : (peers as (T & { volume?: number; muted?: boolean })[]);
}
