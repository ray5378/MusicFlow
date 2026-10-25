// ==================== AP2 HAP 配对凭据契约（Phase 6a，MIN-10 前置门禁）====================
//
// 契约定案（权威文档 Phase 6a 五条，本文件是凭据读写与切分的**唯一出处**）：
//
//   1. 写入时机：HAP pair-setup M1-M4 成功即写（经 pairingContract.recordPairSetupSuccess
//      → 本文件 saveHapCredentials）；pair-verify 失败**绝不写**（写入口只有这一个）。
//   2. 存储形态：airplay_devices.hap_credentials（192 hex）—— 凭据是设备行的列，
//      天然「一设备一行、按 deviceId 唯一」（id 为 PRIMARY KEY）。
//      192 hex = accessoryLTPK（64 hex = 32B Ed25519 公钥）++ controllerLTSK
//      （128 hex = 64B Ed25519 私钥）。切分/拼装只在本文件：任何消费方
//      （6b 的 pair-verify / 加密 RTSP）必须经 getHapCredentials 拿已切分字段，
//      禁止自行 substring。
//      （注：原始文档写「accessoryLTPK/controllerLTSK 各 64 hex」与 192 hex 总长
//       矛盾 —— Ed25519 LTSK 为 64 字节即 128 hex，64+128=192 才自洽，按此定案。）
//   3. 验证方式：进程重启后凭该行凭据可免 PIN 重建 HAP 会话。机械验证钉在
//      tests/airplay/ap2HapCredentials.qa.test.ts（写入 → 新 Database 实例重读
//      → parse 逐字节一致）；真机「重启免 PIN 重连」留 e2e（230 /root/ap2_bed.sh）。
//   4. 失效清理：设备被删除（hap_credentials 是 airplay_devices 的列，
//      control.ts deleteAirPlayDeviceRecord 的 DELETE 连带凭据一起消失 ——
//      「清行回到配对窗」天然成立）或 pair-verify 连续失败 N 次
//      （pairingContract.ts，默认 3，可配）⇒ clearHapCredentials 置空。
//   5. 迁移兼容：db/index.ts 已有幂等加列（PRAGMA 探测后 ALTER，752-761），
//      仓库无迁移框架，遵守「新列手写幂等搬迁」惯例，无需二次迁移。
import { sqlite } from "../../../db/index.js";
import { createLogger } from "../../../utils/logger.js";

const log = createLogger("AP2");

/** 凭据列总长：64 hex LTPK + 128 hex LTSK。 */
export const HAP_CREDENTIALS_HEX_LEN = 192;
/** accessoryLTPK：Ed25519 长期公钥，32 字节 = 64 hex。 */
export const ACCESSORY_LTPK_HEX_LEN = 64;
/** controllerLTSK：Ed25519 长期私钥，64 字节 = 128 hex。 */
export const CONTROLLER_LTSK_HEX_LEN = 128;

/** 已切分的 HAP 长期凭据（pair-setup M1-M4 产出）。 */
export interface HapCredentials {
  /** 接收端 accessory 长期公钥（64 hex）。 */
  accessoryLTPK: string;
  /** 控制端 controller 长期私钥（128 hex）。 */
  controllerLTSK: string;
}

const HEX_RE = /^[0-9a-fA-F]+$/;

/** 解析 192 hex 凭据串 → 切分字段。非法（非串/长度/字符）一律返回 null。 */
export function parseHapCredentials(raw: string | null | undefined): HapCredentials | null {
  if (typeof raw !== "string" || raw.length !== HAP_CREDENTIALS_HEX_LEN) return null;
  if (!HEX_RE.test(raw)) return null;
  return {
    accessoryLTPK: raw.slice(0, ACCESSORY_LTPK_HEX_LEN),
    controllerLTSK: raw.slice(ACCESSORY_LTPK_HEX_LEN),
  };
}

/** 拼装存储串（统一小写）。任一段长度/字符非法即抛错 —— 坏凭据绝不允许入库。 */
export function buildHapCredentials(creds: HapCredentials): string {
  const { accessoryLTPK, controllerLTSK } = creds;
  if (
    typeof accessoryLTPK !== "string" ||
    accessoryLTPK.length !== ACCESSORY_LTPK_HEX_LEN ||
    !HEX_RE.test(accessoryLTPK)
  ) {
    throw new Error(`accessoryLTPK 必须是 ${ACCESSORY_LTPK_HEX_LEN} 位 hex`);
  }
  if (
    typeof controllerLTSK !== "string" ||
    controllerLTSK.length !== CONTROLLER_LTSK_HEX_LEN ||
    !HEX_RE.test(controllerLTSK)
  ) {
    throw new Error(`controllerLTSK 必须是 ${CONTROLLER_LTSK_HEX_LEN} 位 hex`);
  }
  return (accessoryLTPK + controllerLTSK).toLowerCase();
}

/** 读某设备的 HAP 凭据：无行 / 列空 / 解析失败 → null（调用方走 transient 配对窗）。 */
export function getHapCredentials(deviceId: string): HapCredentials | null {
  try {
    if (!deviceId) return null;
    const row = sqlite
      .prepare("SELECT hap_credentials FROM airplay_devices WHERE id = ?")
      .get(deviceId) as { hap_credentials?: unknown } | undefined;
    if (!row) return null;
    return parseHapCredentials(typeof row.hap_credentials === "string" ? row.hap_credentials : "");
  } catch (e: any) {
    log.warn(`[hap-credentials] 读 ${deviceId} 失败: ${e?.message || e}`);
    return null;
  }
}

/** 写某设备 HAP 凭据（pair-setup M1-M4 成功后调用，upsert）。
 *  设备行不存在时补建最小行（与 control.setAirPlayDisabled 同模式）。
 *  失败抛错 —— 写凭据失败时 M4 不得向对端宣称配对成功（由
 *  pairingContract.recordPairSetupSuccess 捕获并返回 false）。 */
export function saveHapCredentials(deviceId: string, creds: HapCredentials): void {
  if (!deviceId) throw new Error("deviceId 不能为空");
  // buildHapCredentials 先校验，非法直接抛 —— 保证库里永远只有合法 192 hex。
  const stored = buildHapCredentials(creds);
  const now = new Date().toISOString();
  const res = sqlite
    .prepare("UPDATE airplay_devices SET hap_credentials = ?, updated_at = ? WHERE id = ?")
    .run(stored, now, deviceId);
  if (res.changes === 0) {
    sqlite
      .prepare(
        `INSERT INTO airplay_devices
           (id, name, alias, first_seen, last_seen, available, disabled, hap_credentials, updated_at)
         VALUES (?, '', '', ?, ?, 0, 0, ?, ?)`,
      )
      .run(deviceId, now, now, stored, now);
    log.info(`[hap-credentials] 设备 ${deviceId} 无行，pair-setup 写凭据时补建设备行`);
  }
}

/** 清某设备凭据（pair-verify 连续失败 N 次的失效路径）：列置空 = 回到配对窗。
 *  行不存在 / 已为空是无害 no-op。**不删设备行** —— 设备可能重新配对回来。 */
export function clearHapCredentials(deviceId: string): void {
  try {
    if (!deviceId) return;
    sqlite
      .prepare("UPDATE airplay_devices SET hap_credentials = '', updated_at = ? WHERE id = ?")
      .run(new Date().toISOString(), deviceId);
  } catch (e: any) {
    log.warn(`[hap-credentials] 清 ${deviceId} 失败: ${e?.message || e}`);
  }
}
