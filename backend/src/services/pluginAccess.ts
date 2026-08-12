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

/** 歌单同步能力(playlistSync):按歌单同步/重建/导出等参数化方法。 */
export function playlistSyncApi(): any {
  return getEnabledByCapability("playlistSync")[0]?.impl;
}

/** 每日推荐歌单标识(TAG):从启用插件的 manifest.dailyTag 读,无则返回空串。 */
export function dailyRecommendTag(): string {
  return getEnabledByCapability("dailyPlaylist")[0]?.manifest?.dailyTag || "";
}
