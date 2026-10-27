/** 桥接接入编排(Phase 3):把主进程 bridgePrepare 好的 socket 规格同步到
 *  SendspinGroup.bridges(并行桥集合,§2.1 —— 绝不进 members)。
 *
 *  语义(同步而非追加,playGroupCore/bridgeAttach op 共用):
 *  - 同 deviceId 且 token/socketPath/protocol 未变 → **热复用**现有句柄
 *    (seek 走 playGroupCore 重建时桥不重连,BLK-02);
 *  - 规格变化或新设备 → 停旧起新;
 *  - 不在新集合里的设备 → 停并移除;
 *  - `g.bridgeSpecs` 记录当前生效规格,seekCore 重建路径据此透传。
 *
 *  硬约束:桥只消费组泵 PCM(纯数据面);本文件不做任何选歌/预取决策。
 */

import type { SendspinGroup, SendspinBridgeHandle } from "./server.js";
import { BridgeMember } from "./bridgeMember.js";
import type { BridgeProtocol } from "../airplay/rates.js";
import { createLogger } from "../../utils/logger.js";

const log = createLogger("Sendspin");

/** 一座桥的接入规格(主进程 bridgePrepare 的产物,原样下发)。 */
export interface BridgeSocketSpec {
  deviceId: string;
  socketPath: string;
  token: string;
  protocol: BridgeProtocol;
}

/** 创建 BridgeMember 的工厂(测试注入点;生产 = 真 socket 会合)。 */
export type BridgeMemberFactory = (spec: BridgeSocketSpec) => SendspinBridgeHandle;

export const defaultBridgeMemberFactory: BridgeMemberFactory = (spec) =>
  new BridgeMember({
    deviceId: spec.deviceId,
    socketPath: spec.socketPath,
    token: spec.token,
    protocol: spec.protocol,
    log: (...args: unknown[]) =>
      log.info(`[bridge ${spec.deviceId}] ` + args.map((a) => String(a)).join(" ")),
  });

/** 把组内桥集合同步到 specs(幂等;seek 重建重复调用时零副作用)。
 *  ⚠️ 防御式读取:最小组桩(单测)没有 bridges/bridgeSpecs 字段 —— 与流引擎对
 *  stub 组的可选调用风格一致;真实 SendspinGroup 恒有两字段,行为不变。 */
export function syncGroupBridges(
  g: SendspinGroup,
  specs: BridgeSocketSpec[],
  factory: BridgeMemberFactory = defaultBridgeMemberFactory,
): void {
  const bridges = g.bridges;
  if (!bridges) return;
  const prevSpecs = new Map((g.bridgeSpecs ?? []).map((s) => [s.deviceId, s]));
  let rebuilt = false; // B 方案:有句柄重建 ⇒ track 边界用冷 lead(见 SendspinGroup.bridgeWarmAttach)
  const seen = new Set<string>();
  const nextSpecs: BridgeSocketSpec[] = [];
  for (const spec of specs) {
    if (seen.has(spec.deviceId)) continue; // 同设备重复规格:取首份
    seen.add(spec.deviceId);
    const prev = prevSpecs.get(spec.deviceId);
    const unchanged = !!prev &&
      prev.token === spec.token &&
      prev.socketPath === spec.socketPath &&
      prev.protocol === spec.protocol &&
      bridges.has(spec.deviceId);
    if (unchanged) {
      nextSpecs.push(spec); // 热复用:句柄与连接原样保留
      continue;
    }
    const old = bridges.get(spec.deviceId);
    if (old) {
      try { old.stop(); } catch { /* 单桥停止失败不连累 */ }
      bridges.delete(spec.deviceId);
      g.onBridgeHandleRemoved?.(spec.deviceId); // 窗口投递水位/定时器清理(§6.2)
    }
    const handle = factory(spec);
    handle.start?.();
    bridges.set(spec.deviceId, handle);
    rebuilt = true;
    nextSpecs.push(spec);
  }
  // 摘除不再 bridging 的设备
  for (const [deviceId, handle] of bridges) {
    if (!seen.has(deviceId)) {
      try { handle.stop(); } catch { /* ignore */ }
      bridges.delete(deviceId);
      g.onBridgeHandleRemoved?.(deviceId); // 窗口投递水位/定时器清理(§6.2)
    }
  }
  // B 方案:全暖复用(无句柄重建)⇒ track 边界用暖 lead;有重建/首挂 ⇒ 冷 lead。
  g.bridgeWarmAttach = nextSpecs.length > 0 && !rebuilt;
  g.bridgeSpecs = nextSpecs;
  if (nextSpecs.length > 0) g.ensureBridgePushTimer?.(); // 桥在跑 → 保证补投定时器在跑(§6.2)
  log.info(`bridge-sync group=${g.name} before=${prevSpecs.size} after=${nextSpecs.length} devices=[${nextSpecs.map((s) => s.deviceId).join(",")}]`);
}

/** 摘除单座桥(bridgeDetach op)。返回是否确有摘除。 */
export function detachGroupBridge(g: SendspinGroup, deviceId: string): boolean {
  const bridges = g.bridges;
  if (!bridges) return false;
  const handle = bridges.get(deviceId);
  if (!handle) return false;
  try { handle.stop(); } catch { /* ignore */ }
  bridges.delete(deviceId);
  g.onBridgeHandleRemoved?.(deviceId); // 窗口投递水位/定时器清理(§6.2)
  g.bridgeSpecs = (g.bridgeSpecs ?? []).filter((s) => s.deviceId !== deviceId);
  return true;
}

/** 清空组内全部桥(stopGroupCore / 显式停流)。 */
export function clearGroupBridges(g: SendspinGroup): void {
  const bridges = g.bridges;
  if (!bridges) return; // 最小组桩(单测)无 bridges 字段 → 无桥可清
  for (const handle of bridges.values()) {
    try { handle.stop(); } catch { /* ignore */ }
  }
  bridges.clear();
  g.onBridgesCleared?.(); // 窗口投递状态整体作废:清水位 + 停补投定时器(§6.2)
  g.bridgeSpecs = [];
}
