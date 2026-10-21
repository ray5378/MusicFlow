// ==================== AirPlay 按设备音量/静音持久化 ====================
//
// 表 airplay_device_state(device_id 主键, volume, muted, updated_at):
//
// 为什么需要它(2026-10-21 现场):
//   `volumeState` 是**进程内存** Map。容器重启后为空,所有读取点都会回落到写死的
//   缺省 80;而客户端重连时会把「服务端给的缺省值」当成权威再回推一次
//   (`POST /v1/peers/:peerId/volume`)—— 设备自身在重启前设好的音量就这样被
//   覆盖掉,用户观感是「重启容器后所有播放器被强制成某个音量」。
//   把用户最后一次设置落库后:重启仍回吐上次值,客户端不会再用缺省值回推,
//   设备侧音量得以原样保留。
//
// 语义:
//   - 按设备全局(音量是设备属性,不跟账号走),任何用户调完落同一行;
//   - 写收敛在 control.ts 的 setAirPlayVolume / setAirPlayMuted(唯一音量咽喉);
//   - 读失败一律回退(无行→null),绝不阻断播控热路径;
//   - 删除设备时**不清行** —— 设备可能重新上线,清行等于把它重置成缺省;
//     只有用户显式移除且不再回来时才需要人工清理。
import { sqlite } from "../../db/index.js";
import { createLogger } from "../../utils/logger.js";

const log = createLogger("AIRPLAY");

/** 从未设置过音量的 AirPlay 设备缺省值(0-100)。
 *  与改动前的内存缺省保持一致(80),确保「无持久行」的旧行为逐字不变。 */
export const DEFAULT_AIRPLAY_VOLUME = 80;

export interface AirPlayVolumeState {
  volume: number;
  muted: boolean;
}

function clampVol(v: unknown): number {
  const n = typeof v === "number" && Number.isFinite(v) ? Math.round(v) : DEFAULT_AIRPLAY_VOLUME;
  return Math.min(100, Math.max(0, n));
}

/** 读某设备持久音量:无行 / 读失败 → null(调用方用 DEFAULT_AIRPLAY_VOLUME)。 */
export function getAirPlayVolumeState(deviceId: string): AirPlayVolumeState | null {
  try {
    if (!deviceId) return null;
    const row = sqlite
      .prepare("SELECT volume, muted FROM airplay_device_state WHERE device_id = ?")
      .get(deviceId) as any;
    if (!row) return null;
    return { volume: clampVol(row.volume), muted: row.muted === 1 };
  } catch (e: any) {
    log.warn(`[airplay-device-state] 读 ${deviceId} 失败: ${e?.message || e}`);
    return null;
  }
}

/** 写音量/静音(字段级合并:未给的字段保持原值;无行时用缺省)。失败只记日志。 */
export function saveAirPlayVolumeState(
  deviceId: string,
  patch: { volume?: number; muted?: boolean },
): void {
  try {
    if (!deviceId) return;
    const cur = getAirPlayVolumeState(deviceId);
    const volume = patch.volume === undefined
      ? (cur?.volume ?? DEFAULT_AIRPLAY_VOLUME)
      : clampVol(patch.volume);
    const muted = patch.muted === undefined ? (cur?.muted ?? false) : !!patch.muted;
    sqlite
      .prepare(
        `INSERT INTO airplay_device_state (device_id, volume, muted, updated_at)
         VALUES (?, ?, ?, ?) ON CONFLICT(device_id) DO UPDATE SET
         volume = excluded.volume, muted = excluded.muted, updated_at = excluded.updated_at`,
      )
      .run(deviceId, volume, muted ? 1 : 0, new Date().toISOString());
  } catch (e: any) {
    log.warn(`[airplay-device-state] 写 ${deviceId} 失败: ${e?.message || e}`);
  }
}

/** 删某设备持久音量行(用户**永久删除**设备时调)。
 *  删除语义 = 「这台设备从没被配置过」,旧设置不能跟着设备重新被发现而复活;
 *  与 sendspin 解绑清整行同口径。失败只记日志(不影响删除设备本身)。 */
export function deleteAirPlayVolumeState(deviceId: string): void {
  try {
    if (!deviceId) return;
    sqlite.prepare("DELETE FROM airplay_device_state WHERE device_id = ?").run(deviceId);
  } catch (e: any) {
    log.warn(`[airplay-device-state] 删 ${deviceId} 失败: ${e?.message || e}`);
  }
}
