// ==================== Sendspin 按设备音量持久化 ====================
//
// 表 sendspin_device_state(client_id PK, volume, muted, updated_at):
//   - 设备级全局(不跟用户):任何用户调完落同一行,重连/重启后自动恢复;
//   - 写收敛在 playerCore.setVolumeCore/setMutedCore(播控唯一咽喉),
//     announce 播报的临时双写不落库(见 persist 参数);
//   - 只在"删除播放器"时清行:解绑 unpair / 忘记拨号目标;断开/重启/停服务都不碰;
//   - 主进程与子进程直写(WAL 多进程安全,与 readSendspinPluginConfig 同模式);
//   - 读失败一律回退(无行/null),绝不阻断播控热路径。
import { sqlite } from "../../db/index.js";
import { createLogger } from "../../utils/logger.js";

const log = createLogger("Sendspin");

export interface DeviceVolumeState {
  volume: number;
  muted: boolean;
}

function clampVol(v: unknown): number {
  const n = typeof v === "number" ? Math.round(v) : 100;
  return Math.min(100, Math.max(0, Number.isFinite(n) ? n : 100));
}

/** 读某设备持久音量:无行/读失败返回 null(调用方用缺省 100/false)。 */
export function getDeviceVolumeState(clientId: string): DeviceVolumeState | null {
  try {
    if (!clientId) return null;
    const row = sqlite
      .prepare("SELECT volume, muted FROM sendspin_device_state WHERE client_id = ?")
      .get(clientId) as any;
    if (!row) return null;
    return { volume: clampVol(row.volume), muted: row.muted === 1 };
  } catch (e: any) {
    log.warn(`[device-state] 读 ${clientId} 失败: ${e?.message || e}`);
    return null;
  }
}

/** 写某设备音量/静音(按字段合并,另一字段保持):播控热路径调用,失败只记日志。 */
export function saveDeviceVolumeState(
  clientId: string,
  patch: { volume?: number; muted?: boolean },
): void {
  try {
    if (!clientId) return;
    const cur = getDeviceVolumeState(clientId);
    const volume = patch.volume === undefined ? (cur?.volume ?? 100) : clampVol(patch.volume);
    const muted = patch.muted === undefined ? (cur?.muted ?? false) : !!patch.muted;
    sqlite
      .prepare(
        `INSERT INTO sendspin_device_state (client_id, volume, muted, updated_at)
         VALUES (?, ?, ?, ?) ON CONFLICT(client_id) DO UPDATE SET
         volume = excluded.volume, muted = excluded.muted, updated_at = excluded.updated_at`,
      )
      .run(clientId, volume, muted ? 1 : 0, new Date().toISOString());
  } catch (e: any) {
    log.warn(`[device-state] 写 ${clientId} 失败: ${e?.message || e}`);
  }
}

/** 删某设备音量行(解绑/忘记设备时调)。 */
export function deleteDeviceVolumeState(clientId: string): void {
  try {
    if (!clientId) return;
    sqlite.prepare("DELETE FROM sendspin_device_state WHERE client_id = ?").run(clientId);
  } catch (e: any) {
    log.warn(`[device-state] 删 ${clientId} 失败: ${e?.message || e}`);
  }
}
