/** [组A] 自愈分级动作执行器（主进程侧）。
 *
 *  链路:sendspin 守卫(bridgeBroadcastTick 三级分级)→ selfhealBus → childMain emit
 *  → supervisor dispatch(case bridgeSelfhealAction)→ **本文件** → control 层 RPC →
 *  airplay 桥子进程(rebuildForShift / lightRestart)。
 *
 *  为什么独立成文件:sendspin/supervisor.ts 动态 import 本文件(静态引入 control.ts
 *  会把 API/registry 链拉进来成环 —— 与 markSongUnplayableInMain 动态 import
 *  streamFallback 同款决策)。MA 出处:sendspin_bridge.py:1411-1446
 *  (_absorb_playout_shift 折回)与 :640-693(_restart_transport 清管线不拆连接);
 *  本仓差异:MA shift 有 binary 上报,本仓用 late 帧增量估计(桥侧自估核对),
 *  三级分级是 MA 没有的补充层。
 */
import { createLogger } from "../../utils/logger.js";
import { bridgeRebuildDelayDevice, bridgeLightRestart } from "./control.js";

const log = createLogger("BRIDGE-SELFHEAL");

/** level 1=retime(桥自估 shift 平移映射,shiftUs=0 表示桥按 late 增量自估)
 *  level 2=lightRestart(清内容管线 + flush 重锚,绝不 reconnectRaop)。 */
export function bridgeSelfhealDispatch(deviceId: string, level: number, shiftUs: number): void {
  if (!deviceId) return;
  if (level === 1) {
    void bridgeRebuildDelayDevice(deviceId, shiftUs, "late-selfheal-retime").then((ok) => {
      log.info(`[bridge-selfheal] ${deviceId} retime 下发${ok ? "成功" : "失败(无会话/AP2,守卫按未奏效升级)"}`);
    }).catch(() => { /* 失败即升级,不回传 */ });
    return;
  }
  if (level === 2) {
    void bridgeLightRestart(deviceId, "late-selfheal-light-restart").then((ok) => {
      log.info(`[bridge-selfheal] ${deviceId} lightRestart 下发${ok ? "成功" : "失败(无会话,守卫按未奏效升级)"}`);
    }).catch(() => { /* 失败即升级,不回传 */ });
    return;
  }
  log.warn(`[bridge-selfheal] ${deviceId} 未知分级 level=${level},忽略`);
}
