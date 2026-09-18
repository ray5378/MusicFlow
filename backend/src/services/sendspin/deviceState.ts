// ==================== Sendspin 按设备音量持久化 + 禁用态 ====================
//
// 表 sendspin_device_state(client_id PK, volume, muted, disabled, updated_at):
//   - 设备级全局(不跟用户):任何用户调完落同一行,重连/重启后自动恢复;
//   - 写收敛在 playerCore.setVolumeCore/setMutedCore(播控唯一咽喉),
//     announce 播报的临时双写不落库(见 persist 参数);
//   - 只在"删除播放器"时清行:解绑 unpair / 忘记拨号目标;断开/重启/停服务都不碰;
//   - disabled 与 DLNA `dlna_devices.disabled` 同语义:用户手动禁用,持久化,
//     禁用设备不注册为 peer、不出现在任何流转播放入口;
//   - ⚠️ **解绑 = 清掉这一整行**(含 disabled 与 6053 密钥/端口),见
//     purgeDeviceArtifacts —— 解绑的语义是「这台设备从没被配置过」,不是「只是不配对」。
//     若只解配对却留着禁用态/密钥,设备会带着旧设置「复活」,与用户预期相反;
//   - 主进程与子进程直写(WAL 多进程安全,与 readSendspinPluginConfig 同模式);
//   - 读失败一律回退(无行/null),绝不阻断播控热路径。
import { sqlite } from "../../db/index.js";
import { purgePeerPrefsAllOwners } from "../playerPrefs.js";
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

/** 列出所有被禁用设备的 clientId。
 *  用途:Sendspin 的可见列表是按连接派生的 —— 禁用会断开连接,设备随即从列表消失,
 *  用户就没有入口再启用它。故 /clients 需用本函数把「已禁用但当前离线」的设备补回列表
 *  (与 DLNA 的 loadPersistedDevices 把禁用设备恢复进缓存同效)。 */
export function listDisabledDeviceIds(): string[] {
  try {
    const rows = sqlite
      .prepare("SELECT client_id FROM sendspin_device_state WHERE disabled = 1")
      .all() as any[];
    return rows.map((r) => String(r.client_id)).filter(Boolean);
  } catch (e: any) {
    log.warn(`[device-state] 列禁用设备失败: ${e?.message || e}`);
    return [];
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

/** 解绑一台 Sendspin 设备:清掉服务端为它保存过的**一切**。
 *
 *  与 deleteDeviceVolumeState(只删状态行)的区别 —— 这是「解绑」的完整语义:
 *  播放器行仍在(设备**保持在线**、连接不断),但「被配置过」的痕迹全部抹掉,
 *  等价于从没在这台设备上做过任何设置。
 *
 *  清理项:
 *    1. `sendspin_device_state` 行 —— 音量 / 静音 / 禁用 / 6053 密钥 / 6053 端口;
 *    2. 所有用户的改名覆盖(`player_name_overrides`,peer = `sendspin:<clientId>`);
 *    3. 所有用户的隐藏偏好(`player_prefs`,peer 同上)。
 *
 *  **刻意不清**(边界,别顺手加):
 *    - 播放队列(`device_queues`):那是播放**状态**不是配置,清掉会打断正在播的歌;
 *    - 群组成员关系:解绑后设备仍在线,从群组摘掉会破坏一个原本可用的配置 ——
 *      那是「删除设备」(如 DLNA 的 `DELETE /v1/dlna/devices/:id`)才做的事。
 *
 *  6053 桥接的解挂由调用方按 host 处理(本模块只认 clientId,不知道 host)。 */
export function purgeDeviceArtifacts(clientId: string): void {
  if (!clientId) return;
  deleteDeviceVolumeState(clientId);
  try {
    purgePeerPrefsAllOwners(`sendspin:${clientId}`);
  } catch (e: any) {
    log.warn(`[device-state] 清 ${clientId} 改名/隐藏偏好失败: ${e?.message || e}`);
  }
}

/** 读某设备是否被禁用:无行/读失败返回 false(缺省启用)。
 *  与 DLNA `isDeviceDisabled` 同语义 —— 禁用设备不出现在任何流转播放入口。 */
export function getDeviceDisabled(clientId: string): boolean {
  try {
    if (!clientId) return false;
    const row = sqlite
      .prepare("SELECT disabled FROM sendspin_device_state WHERE client_id = ?")
      .get(clientId) as any;
    return row?.disabled === 1;
  } catch (e: any) {
    log.warn(`[device-state] 读禁用态 ${clientId} 失败: ${e?.message || e}`);
    return false;
  }
}

export interface DeviceEsphomeCreds {
  /** 设备固件 `api: encryption: key`(base64)。空串 = 不连 6053。 */
  psk: string;
  /** 6053 端口;0 或非法值 = 用缺省 6053。 */
  port: number;
}

/** 读某设备的 ESPHome 6053 凭据:无行/读失败返回空凭据(即不连)。
 *
 *  ⚠️ 为什么按 clientId 而不是按 host 存:ESPHome 每台设备的密钥是各自生成的,
 *  而设备 IP 会被 DHCP 换掉 —— 按 host 存的话换一次地址就失联一次,用户得重填。
 *  clientId 是设备自报的稳定标识,host 每次连上由服务端自动代入。 */
export function getDeviceEsphome(clientId: string): DeviceEsphomeCreds {
  try {
    if (!clientId) return { psk: "", port: 0 };
    const row = sqlite
      .prepare("SELECT esphome_psk, esphome_port FROM sendspin_device_state WHERE client_id = ?")
      .get(clientId) as any;
    if (!row) return { psk: "", port: 0 };
    const psk = typeof row.esphome_psk === "string" ? row.esphome_psk.trim() : "";
    const n = Number(row.esphome_port);
    return { psk, port: Number.isInteger(n) && n >= 1 && n <= 65535 ? n : 0 };
  } catch (e: any) {
    log.warn(`[device-state] 读 ESPHome 凭据 ${clientId} 失败: ${e?.message || e}`);
    return { psk: "", port: 0 };
  }
}

/** 写某设备的 ESPHome 6053 凭据(按字段合并,不动 volume/muted/disabled)。
 *  psk 传空串 = 撤销(不再连这台)。与其余 save* 同款 UPSERT。 */
export function saveDeviceEsphome(clientId: string, psk: string, port = 0): void {
  try {
    if (!clientId) return;
    const cur = getDeviceVolumeState(clientId);
    const curDisabled = getDeviceDisabled(clientId);
    const n = Number(port);
    sqlite
      .prepare(
        `INSERT INTO sendspin_device_state (client_id, volume, muted, disabled, esphome_psk, esphome_port, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(client_id) DO UPDATE SET
         esphome_psk = excluded.esphome_psk, esphome_port = excluded.esphome_port,
         updated_at = excluded.updated_at`,
      )
      .run(
        clientId,
        cur?.volume ?? 100,
        (cur?.muted ?? false) ? 1 : 0,
        curDisabled ? 1 : 0,
        String(psk ?? "").trim(),
        Number.isInteger(n) && n >= 1 && n <= 65535 ? n : 0,
        new Date().toISOString(),
      );
  } catch (e: any) {
    log.warn(`[device-state] 写 ESPHome 凭据 ${clientId} 失败: ${e?.message || e}`);
  }
}

// ---- 升级迁移:旧版「插件页全局密钥」→ 每台设备各自的密钥 ----

/** 服务启动时刻(迁移窗口起点)。模块加载即视为服务启动。 */
const BOOT_AT = Date.now();
/** 继承窗口:服务启动后 10 分钟内连上来的设备 = 升级重启后的那波重连潮。 */
const LEGACY_PSK_INHERIT_WINDOW_MS = 10 * 60_000;
/** 同一设备只继承一次(避免反复重写)。 */
const inheritedClientIds = new Set<string>();

/** 读**旧版插件页全局密钥**(已废弃字段,仅迁移期读一次)。
 *  插件配置的解析在 services/sendspin/index.ts,但迁移判定在这里 —— 因此直读
 *  plugins 表的原始 JSON,不复用 readSendspinPluginConfig(它已刻意丢掉这些字段)。 */
export function readLegacyPluginEsphome(): { psk: string; port: number } {
  try {
    const row = sqlite
      .prepare("SELECT config FROM plugins WHERE id = 'sendspin-renderer' OR name = 'sendspin-renderer'")
      .get() as any;
    const cfg = row?.config ? JSON.parse(row.config) : {};
    const psk = typeof cfg?.esphome_psk === "string" ? cfg.esphome_psk.trim() : "";
    const n = Number(cfg?.esphome_port);
    return { psk, port: Number.isInteger(n) && n >= 1 && n <= 65535 ? n : 0 };
  } catch {
    return { psk: "", port: 0 };
  }
}

/** 升级迁移:把旧版「插件页全局密钥」继承成**这台设备自己的**密钥。
 *
 *  为什么需要:6053 密钥从「插件页一把全局」改成「每台设备各自一把」后,老用户的
 *  设备行上密钥是空的 —— 不做继承,升级后会**静默失联**(桥不再连、音量按钮置灰),
 *  用户得为每台设备重填一遍。这里让升级瞬间就连上来的设备沿用旧密钥,「像没升级过
 *  一样」继续工作。
 *
 *  边界(避免把一台设备的密钥永久泼给之后新加的每台设备):
 *   - 只在窗口期内生效 —— 默认服务启动后 10 分钟,即升级重启后的重连潮;
 *   - 已有自己密钥的设备**不覆盖**;
 *   - 同一设备只继承一次;
 *   - 窗口期过后旧字段彻底不再被读取,各设备只认自己那行(用户改/清都以后者为准)。
 *
 *  窗口长度可通过 `withinMs` 覆盖(测试用;传负数即模拟「窗口已过」)。 */
export function inheritLegacyEsphomePsk(
  clientId: string,
  withinMs = LEGACY_PSK_INHERIT_WINDOW_MS,
): boolean {
  try {
    if (!clientId) return false;
    if (inheritedClientIds.has(clientId)) return false;
    if (Date.now() - BOOT_AT > withinMs) return false;
    const cur = getDeviceEsphome(clientId);
    if (cur.psk) return false;
    const legacy = readLegacyPluginEsphome();
    if (!legacy.psk) return false;
    inheritedClientIds.add(clientId);
    // 端口:设备行已记录过就用它,否则沿用旧全局端口(0 = 缺省 6053)。
    saveDeviceEsphome(clientId, legacy.psk, cur.port || legacy.port);
    log.info(`[device-state] 旧版全局密钥已继承为设备 ${clientId} 的 6053 密钥(迁移窗口内一次性)`);
    return true;
  } catch (e: any) {
    log.warn(`[device-state] 继承旧版全局密钥失败 ${clientId}: ${e?.message || e}`);
    return false;
  }
}

/** 列出所有已填 ESPHome 密钥的设备(供启动时批量 attach)。 */
export function listEsphomeCreds(): { clientId: string; psk: string; port: number }[] {
  try {
    const rows = sqlite
      .prepare(
        "SELECT client_id, esphome_psk, esphome_port FROM sendspin_device_state WHERE esphome_psk <> ''",
      )
      .all() as any[];
    return rows
      .map((r) => ({
        clientId: String(r.client_id ?? ""),
        psk: String(r.esphome_psk ?? "").trim(),
        port: Number(r.esphome_port) || 0,
      }))
      .filter((r) => r.clientId && r.psk);
  } catch (e: any) {
    log.warn(`[device-state] 列 ESPHome 凭据失败: ${e?.message || e}`);
    return [];
  }
}

/** 写某设备禁用态(按字段合并,不动 volume/muted)。
 *  与 `saveDeviceVolumeState` 同款 UPSERT:无行则补一行(volume/muted 取缺省)。 */
export function saveDeviceDisabled(clientId: string, disabled: boolean): void {
  try {
    if (!clientId) return;
    const cur = getDeviceVolumeState(clientId);
    sqlite
      .prepare(
        `INSERT INTO sendspin_device_state (client_id, volume, muted, disabled, updated_at)
         VALUES (?, ?, ?, ?, ?) ON CONFLICT(client_id) DO UPDATE SET
         disabled = excluded.disabled, updated_at = excluded.updated_at`,
      )
      .run(
        clientId,
        cur?.volume ?? 100,
        (cur?.muted ?? false) ? 1 : 0,
        disabled ? 1 : 0,
        new Date().toISOString(),
      );
  } catch (e: any) {
    log.warn(`[device-state] 写禁用态 ${clientId} 失败: ${e?.message || e}`);
  }
}
