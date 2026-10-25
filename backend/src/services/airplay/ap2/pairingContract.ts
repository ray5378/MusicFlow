// ==================== AP2 配对契约状态机挂点（Phase 6a）====================
//
// 6b 的 HAP pair-setup / pair-verify 实现消费本模块，本模块只做**契约裁决**，
// 不含任何 HAP 报文/加密逻辑（那是 6b 的事）：
//
//   - 写入时机：pair-setup M1-M4 成功（对端返回 M4 且校验通过）→
//     recordPairSetupSuccess 唯一写入口；pair-verify 失败绝不写。
//   - 失效清理：pair-verify **连续**失败 N 次（默认 3，env 可配）⇒
//     清凭据回到配对窗。计数是进程内存态 —— 重启清零是**有意**的：
//     重启后凭据仍在、设备只需正常 pair-verify，一次成功即复位。
//
// 与 Phase 2-5 桥接代码零耦合（AP2 走 airplay/ap2/ 新目录）。
import { createLogger } from "../../../utils/logger.js";
import {
  clearHapCredentials,
  getHapCredentials,
  saveHapCredentials,
} from "./hapCredentials.js";

const log = createLogger("AP2");

/** pair-verify 连续失败上限缺省值（文档建议 3）。 */
export const DEFAULT_PAIR_VERIFY_MAX_FAILURES = 3;
/** 可配环境变量名（Phase 6a 第 4 条「N 可配」）。 */
export const PAIR_VERIFY_MAX_FAILURES_ENV = "MUSICFLOW_AP2_VERIFY_MAX_FAILURES";

/** 每次调用现读 env —— 测试可在用例内改环境变量验证「N 可配」。 */
export function pairVerifyMaxFailures(): number {
  const raw = process.env[PAIR_VERIFY_MAX_FAILURES_ENV];
  const n = raw === undefined ? NaN : Number(raw);
  if (!Number.isInteger(n) || n < 1) return DEFAULT_PAIR_VERIFY_MAX_FAILURES;
  return n;
}

/** 设备 → 连续 verify 失败计数（进程内存；重启清零，语义见文件头）。 */
const verifyFailures = new Map<string, number>();

/** recordPairVerifyResult 的返回值：
 *  - retained：凭据保留（成功复位 / 失败未达阈值）
 *  - cleared：达到连续失败上限，凭据已清，回到配对窗
 *  - no-credentials：本来就没有凭据（无需也无处失效） */
export type PairVerifyOutcome = "retained" | "cleared" | "no-credentials";

/** pair-setup M1-M4 成功钩子：唯一写入口。写库失败（磁盘/约束）返回 false，
 *  6b 不得向对端宣称配对成功。成功同时清零 verify 连败计数。 */
export function recordPairSetupSuccess(
  deviceId: string,
  accessoryLTPK: string,
  controllerLTSK: string,
): boolean {
  try {
    saveHapCredentials(deviceId, { accessoryLTPK, controllerLTSK });
    verifyFailures.delete(deviceId);
    log.info(`[pairing] device ${deviceId} pair-setup 成功，凭据已入库（免 PIN 重连生效）`);
    return true;
  } catch (e: any) {
    log.error(`[pairing] device ${deviceId} pair-setup 凭据写库失败: ${e?.message || e}`);
    return false;
  }
}

/** pair-setup / pair-verify 失败钩子：契约定案「失败不写」—— 本函数**只记日志**，
 *  绝不触碰凭据列。钉住语义防 6b 顺手把临时/坏凭据写进库。 */
export function recordPairingFailure(deviceId: string, stage: "pair-setup" | "pair-verify"): void {
  log.warn(`[pairing] device ${deviceId} ${stage} 失败（契约：失败不写凭据）`);
}

/** pair-verify 结果钩子：成功复位连败计数；失败累加，连续达到
 *  pairVerifyMaxFailures() ⇒ 清凭据回到配对窗并复位计数。 */
export function recordPairVerifyResult(deviceId: string, ok: boolean): PairVerifyOutcome {
  if (ok) {
    verifyFailures.delete(deviceId);
    return "retained";
  }
  if (!getHapCredentials(deviceId)) return "no-credentials";
  const n = (verifyFailures.get(deviceId) ?? 0) + 1;
  const max = pairVerifyMaxFailures();
  if (n >= max) {
    clearHapCredentials(deviceId);
    verifyFailures.delete(deviceId);
    log.warn(`[pairing] device ${deviceId} pair-verify 连续失败 ${n} 次（上限 ${max}），清凭据回到配对窗`);
    return "cleared";
  }
  verifyFailures.set(deviceId, n);
  log.warn(`[pairing] device ${deviceId} pair-verify 失败 ${n}/${max}`);
  return "retained";
}

/** 当前连败计数（测试 / 观测用）。 */
export function getPairVerifyFailureCount(deviceId: string): number {
  return verifyFailures.get(deviceId) ?? 0;
}

/** 手动复位连败计数（测试 / 设备侧重连成功路径用）。 */
export function resetPairVerifyFailures(deviceId: string): void {
  verifyFailures.delete(deviceId);
}
