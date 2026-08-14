// ==================== 核心 → 插件能力门面 ====================
//
// 核心(路由等)经此文件按能力访问内置/外置插件的参数化方法,绝不直接 import
// services/plugin/ 下的具体插件文件(合规:check-core 规则 B)。
//
// 语义:按「能力」取第一个启用插件的 impl;无启用插件时返回 undefined,调用方
// 负责给出可读错误(通常是「该功能未启用/未安装插件」)。

import { getEnabledByCapability } from "../plugins/registry.js";

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

/** 首页顶部「今日推荐 + 随机歌单」展示张数(含今日推荐),由每日推荐插件配置 homeCount 控制。 */
export function dailyRecommendHomeCount(): number {
  const api = dailyRecommendApi();
  const n = api && typeof api.getHomeCount === "function" ? api.getHomeCount() : 0;
  return Number.isFinite(n) && n >= 1 ? Math.min(Math.trunc(n), 24) : 8;
}

/** 歌单同步能力(playlistSync):按歌单同步/重建/导出等参数化方法。 */
export function playlistSyncApi(): any {
  return getEnabledByCapability("playlistSync")[0]?.impl;
}

/** 每日推荐歌单标识(TAG):从启用插件的 manifest.dailyTag 读,无则返回空串。 */
export function dailyRecommendTag(): string {
  return getEnabledByCapability("dailyPlaylist")[0]?.manifest?.dailyTag || "";
}
