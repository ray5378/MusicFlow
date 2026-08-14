// ==================== 歌单元数据辅助 ====================
// 区分「导入歌单」(真实平台链接,由导入插件按 URL 认领同步)与「插件同步歌单」
// (如 go-music-dl 私人歌单,由插件 runDailyJob 刷新)。
// 判定基于「是否有导入插件认领该 sourceUrl」(findUrlImporter)——核心不写死任何
// 插件名或 URL 前缀(插件化架构:核心只按能力/契约推断,平台标识只存在于插件里)。

import { findUrlImporter } from "../services/plugin/playlistImport.js";

/** 插件同步歌单:有 sourceUrl 但没有导入插件认领(如 go-music-dl / listenbrainz 生成)。 */
export function isPluginSyncPlaylist(p: { sourceUrl?: string | null }): boolean {
  if (!p.sourceUrl) return false;
  return !findUrlImporter(p.sourceUrl);
}

/** 真正的「导入歌单」:有 sourceUrl 且被某个导入插件认领。 */
export function isImportedPlaylist(p: { sourceUrl?: string | null }): boolean {
  return !!p.sourceUrl && !!findUrlImporter(p.sourceUrl);
}
