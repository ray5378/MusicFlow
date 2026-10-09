// ==================== 核心 → 插件能力门面 ====================
//
// 核心(路由等)经此文件按能力访问内置/外置插件的参数化方法,绝不直接 import
// services/plugin/ 下的具体插件文件(合规:check-core 规则 B)。
//
// 语义:按「能力」取第一个启用插件的 impl;无启用插件时返回 undefined,调用方
// 负责给出可读错误(通常是「该功能未启用/未安装插件」)。

import { getEnabledByCapability, getPluginConfig, getPluginManifest } from "../plugins/registry.js";

/** 每日推荐能力(dailyPlaylist):候选池/生成等参数化方法。 */
export function dailyRecommendApi(): any {
  return getEnabledByCapability("dailyPlaylist")[0]?.impl;
}

/** 本地推荐能力(localPlaylist):生成本地口味歌单。 */
export function localRecommendApi(): any {
  return getEnabledByCapability("localPlaylist")[0]?.impl;
}

/** 组合歌单能力(comboPlaylist):合并多个推荐歌单(如 今日漫游)。 */
export function comboPlaylistApi(): any {
  return getEnabledByCapability("comboPlaylist")[0]?.impl;
}

// ---- 首页固定卡:推荐插件自治(showOnHome + homePosition) ----
// 哪些推荐歌单固定在首页顶部、按什么位次排,由各插件自己的配置决定:
//   - manifest.configSchema 声明 showOnHome(switch)/homePosition(number);
//   - manifest.homePlaylistId 声明该插件在首页展示时对应的固定歌单 id。
// 核心按能力收集(不写死插件名),保存插件配置时校验位次冲突。

/** 首页固定卡能力的集合(推荐类插件)。recommendPlaylist 为第三方通用推荐歌单插件
 *  (如 ListenBrainz),与内置 daily/local/combo 一样支持 showOnHome/homePosition 首页卡位。 */
export const HOME_RECOMMENDER_CAPS = ["dailyPlaylist", "localPlaylist", "comboPlaylist", "recommendPlaylist"] as const;

/** 插件声明的首页卡列表(多卡 homePlaylistIds 优先;仅单数 homePlaylistId 时回落
 *  为单元素卡:键固定 showOnHome/homePosition,名称用插件名——行为完全不变)。 */
function homeCardsOf(
  manifest: any,
): Array<{ id: string; name: string; showOnHomeKey: string; positionKey: string }> {
  if (Array.isArray(manifest?.homePlaylistIds) && manifest.homePlaylistIds.length) {
    return manifest.homePlaylistIds
      .map((c: any) => ({
        id: String(c?.id || ""),
        name: String(c?.name || ""),
        showOnHomeKey: String(c?.showOnHomeKey || "showOnHome"),
        positionKey: String(c?.positionKey || "homePosition"),
      }))
      .filter((c: { id: string }) => !!c.id);
  }
  if (manifest?.homePlaylistId) {
    return [
      {
        id: String(manifest.homePlaylistId),
        name: manifest.name || manifest.id,
        showOnHomeKey: "showOnHome",
        positionKey: "homePosition",
      },
    ];
  }
  return [];
}

/** 读插件配置中某字段,缺失时回落 manifest configSchema 的 default。 */
function readConfigField(manifest: any, key: string, cfg: Record<string, any> | null): any {
  if (cfg && cfg[key] !== undefined && cfg[key] !== null) return cfg[key];
  const field = (manifest?.configSchema || []).find((f: any) => f.key === key);
  return field?.default;
}

/** 推荐插件在首页展示的配置(未启用/未配置时给安全默认)。 */
export interface HomeCardConfig {
  pluginId: string;
  name: string;
  playlistId: string; // 多卡 manifest.homePlaylistIds[].id 或单数 manifest.homePlaylistId
  capabilities: string[];
  showOnHome: boolean;
  position: number; // 0 = 未固定
}

/** 收集所有「启用且声明首页歌单」的推荐插件配置(含未开 showOnHome 的,供冲突校验)。 */
export function listHomeCardPlugins(): HomeCardConfig[] {
  const out: HomeCardConfig[] = [];
  for (const cap of HOME_RECOMMENDER_CAPS) {
    for (const { manifest } of getEnabledByCapability(cap)) {
      const cfg = getPluginConfig(manifest.id);
      for (const card of homeCardsOf(manifest)) {
        const showOnHome = !!readConfigField(manifest, card.showOnHomeKey, cfg);
        const rawPos = parseInt(String(readConfigField(manifest, card.positionKey, cfg) ?? 0), 10);
        const position = Number.isFinite(rawPos) && rawPos >= 1 ? rawPos : 0;
        out.push({
          pluginId: manifest.id,
          name: card.name || manifest.name || manifest.id,
          playlistId: card.id,
          capabilities: manifest.capabilities || [],
          showOnHome,
          position,
        });
      }
    }
  }
  return out;
}

/** 位次冲突校验(保存/启用插件时调用):用目标插件的新配置(替换其 DB 值)检查
 *  它是否与「其它显示在首页的插件」占用同一位次(0=未固定不参与)。
 *  目标插件可处于未启用状态(如启用开关时校验),按 manifest 默认值计算其配置。
 *  返回冲突描述,无冲突返回 null。 */
export function homePositionConflictForSave(
  pluginId: string,
  newConfig: Record<string, any>,
): string | null {
  const manifest = getPluginManifest(pluginId);
  if (!manifest) return null;
  const cards = homeCardsOf(manifest);
  if (!cards.length) return null; // 非首页卡插件
  // 计算目标插件各卡的新 showOnHome / homePosition(替换其 DB 值)。
  const cfg = { ...newConfig };
  const mine: Array<{ name: string; position: number }> = [];
  for (const card of cards) {
    const showOnHome = !!readConfigField(manifest, card.showOnHomeKey, cfg);
    const rawPos = parseInt(String(readConfigField(manifest, card.positionKey, cfg) ?? 0), 10);
    const position = Number.isFinite(rawPos) && rawPos >= 1 ? rawPos : 0;
    if (showOnHome && position > 0) {
      mine.push({ name: card.name || manifest.name || manifest.id, position });
    }
  }
  if (!mine.length) return null;
  const others = listHomeCardPlugins().filter((p) => p.pluginId !== pluginId); // 已启用的其它首页卡
  for (const m of mine) {
    // 自身多卡之间撞位次。
    const selfDup = mine.find((x) => x !== m && x.position === m.position);
    if (selfDup) return `首页位次 ${m.position} 已被「${selfDup.name}」占用,请改用其它位次`;
    const other = others.find((p) => p.showOnHome && p.position === m.position);
    if (other) return `首页位次 ${m.position} 已被「${other.name}」占用,请改用其它位次`;
  }
  return null;
}

/** 首页顶部「今日推荐 + 随机歌单」展示张数(含今日推荐),由每日推荐插件配置 homeCount 控制。 */
export function dailyRecommendHomeCount(): number {
  const api = dailyRecommendApi();
  const n = api && typeof api.getHomeCount === "function" ? api.getHomeCount() : 0;
  return Number.isFinite(n) && n >= 1 ? Math.min(Math.trunc(n), 24) : 8;
}

/** 歌单同步能力(playlistSync):按歌单同步/重建/导出等参数化方法。
 *  优先返回实现了「歌单重建/导入冷却」等参数化方法(rebuildPlaylistEntries /
 *  checkImportCooldown)的插件——内置 playlist-sync 提供这些方法;只实现
 *  runSyncJob 的外置插件(如第三方声明 playlistSync 能力)不应劫持核心路由的
 *  导入/重建调用(单例陷阱)。方法驱动分发,不写死插件 id。 */
export function playlistSyncApi(): any {
  const enabled = getEnabledByCapability("playlistSync");
  for (const p of enabled) {
    if (typeof p.impl?.rebuildPlaylistEntries === "function") return p.impl;
  }
  return enabled[0]?.impl;
}

/** 每日推荐歌单标识(TAG):从启用插件的 manifest.dailyTag 读,无则返回空串。 */
export function dailyRecommendTag(): string {
  return getEnabledByCapability("dailyPlaylist")[0]?.manifest?.dailyTag || "";
}
