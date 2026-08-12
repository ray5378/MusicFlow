// ==================== MusicFlow native playlist-file importer plugin ====================
//
// Handles the JSON produced by `/v1/playlists/:id/export` (single playlist) and
// by "export all" (a `playlists[]` envelope). Tracks keep title/artist/album/
// duration so rebuildPlaylistEntries' library matching gives a full round-trip.

import type { ImportedPlaylistShape, ImportedTrackShape, PlaylistFilePlugin, PluginManifest } from "../../../plugins/types.js";

export const NATIVE_IMPORTER_ID = "musicflow-file-importer";

/** Identity marker written into every MusicFlow export file. */
export const NATIVE_APP = "MusicFlow";

/** True when `raw` looks like a MusicFlow export file. */
export function isNativePlaylistFile(raw: any): boolean {
  return !!raw && typeof raw === "object" && raw.app === NATIVE_APP;
}

/** Parse a MusicFlow export file into one ImportedPlaylist per playlist block. */
export function parseNativePlaylists(raw: any): ImportedPlaylistShape[] {
  if (!isNativePlaylistFile(raw)) {
    throw new Error("不是 MusicFlow 导出的歌单文件");
  }
  const blocks = Array.isArray(raw.playlists) && raw.playlists.length > 0 ? raw.playlists : [raw];
  const imported: ImportedPlaylistShape[] = [];
  for (const block of blocks) {
    const tracks: ImportedTrackShape[] = (Array.isArray(block?.tracks) ? block.tracks : [])
      .map((t: any) => {
        const title = t && t.title != null ? String(t.title).trim() : "";
        if (!title) return null;
        return {
          externalId: t?.externalId != null ? String(t.externalId) : "",
          title,
          artist: t?.artist != null ? String(t.artist) : "",
          album: t?.album != null ? String(t.album) : undefined,
          duration: typeof t?.duration === "number" && t.duration > 0 ? t.duration : undefined,
        };
      })
      .filter((t: ImportedTrackShape | null): t is ImportedTrackShape => t !== null);
    if (tracks.length === 0) throw new Error("歌单文件里没有可用曲目");
    imported.push({
      name: (block && block.name && String(block.name).trim()) || "导入歌单",
      platform: "local",
      tracks,
    });
  }
  return imported;
}

/** Single-playlist convenience wrapper (kept for backward compatibility). */
export function parseNativePlaylist(raw: any): ImportedPlaylistShape {
  return parseNativePlaylists(raw)[0];
}

export const nativeImporterManifest: PluginManifest = {
  id: NATIVE_IMPORTER_ID,
  name: "MusicFlow 歌单文件导入",
  version: "1.0.0",
  type: "importer",
  description: "导入 MusicFlow 导出的歌单 JSON 文件（支持单个歌单与全量导出）",
  capabilities: ["playlistFile"],
  platforms: ["local"],
  defaultEnabled: true,
  configSchema: [],
  documentation: `### 功能介绍
导入 MusicFlow 导出的歌单文件（单个歌单导出或「全量导出」打包的 JSON），把歌单搬到当前实例。

### 处理逻辑
1. 核心按 \`playlistFile\` 能力遍历插件，调用 \`canHandleFile(raw)\` 认领上传的文件；
2. 本插件根据文件内容特征（MusicFlow 导出 JSON 结构）认领；
3. \`parseFile(raw)\` 解析 JSON，还原歌单名与曲目列表，返回统一结构交给核心建歌单。

### 说明
- 适用于「备份 / 迁移 / 分享」场景——把另一台 MusicFlow 的歌单搬过来；
- 无需配置，默认启用。`,
};

export const nativeImporter: PlaylistFilePlugin = {
  manifest: nativeImporterManifest,
  canHandleFile: isNativePlaylistFile,
  parseFile: parseNativePlaylists,
};
