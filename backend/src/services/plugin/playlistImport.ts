// ==================== Playlist import dispatcher ====================
//
// This module used to *be* the QQ + NetEase importer (an if-chain on the URL).
// In this project each platform is its own `importer` plugin; what is left here is the
// capability-driven dispatcher the core calls:
//
//   share URL      -> plugins with capability "playlistImport" -> canHandle(url)
//   uploaded file  -> plugins with capability "playlistFile"   -> canHandleFile(raw)
//
// Adding support for a new platform means registering a plugin — no change here.

import { getEnabledByCapability } from "../../plugins/registry.js";
import type { ImportedPlaylistShape, ImportedTrackShape, ImporterPlugin, PlaylistFilePlugin } from "../../plugins/types.js";

// Public shapes live in plugins/types.ts (single source of truth); these aliases
// keep the historical names working for existing call sites.
export type ImportedTrack = ImportedTrackShape;
export type ImportedPlaylist = ImportedPlaylistShape;

// Re-exported so routes/tests can keep importing the native-file helpers from
// here even though they now live in the native importer plugin.
export { NATIVE_APP, parseNativePlaylist, parseNativePlaylists } from "./importers/native.js";

/** Enabled importer plugins that can turn a share URL into a playlist. */
function urlImporters(): ImporterPlugin[] {
  return getEnabledByCapability("playlistImport")
    .map((p) => p.impl as ImporterPlugin)
    .filter((impl) => typeof impl?.canHandle === "function" && typeof impl?.fetchPlaylist === "function");
}

/** Enabled importer plugins that can parse an uploaded playlist file. */
function fileImporters(): PlaylistFilePlugin[] {
  return getEnabledByCapability("playlistFile")
    .map((p) => p.impl as PlaylistFilePlugin)
    .filter((impl) => typeof impl?.canHandleFile === "function" && typeof impl?.parseFile === "function");
}

/** The importer plugin that claims `url`, or undefined. */
export function findUrlImporter(url: string): ImporterPlugin | undefined {
  const trimmed = url.trim();
  return urlImporters().find((impl) => {
    try {
      return impl.canHandle(trimmed);
    } catch {
      return false;
    }
  });
}

/** Platform slugs the currently enabled importers can handle (for UI hints). */
export function supportedImportPlatforms(): string[] {
  const out = new Set<string>();
  for (const impl of urlImporters()) {
    for (const p of impl.manifest.platforms || []) out.add(p);
  }
  return [...out];
}

/** Route a share URL to the importer plugin that claims it. */
export async function importPlaylistFromUrl(url: string): Promise<ImportedPlaylist> {
  const trimmed = url.trim();
  const importers = urlImporters();
  if (importers.length === 0) {
    throw new Error("没有启用的歌单导入插件,请在「插件」页面启用后重试");
  }
  const importer = findUrlImporter(trimmed);
  if (!importer) {
    const names = importers.map((i) => i.manifest.name).join("、");
    throw new Error(`不支持的音乐平台链接,当前已启用的导入插件: ${names}`);
  }
  return importer.fetchPlaylist(trimmed);
}

/** Route an uploaded playlist-file payload to the plugin that recognizes it. */
export function parsePlaylistFile(raw: unknown): ImportedPlaylist[] {
  const importers = fileImporters();
  if (importers.length === 0) {
    throw new Error("没有启用的歌单文件导入插件,请在「插件」页面启用后重试");
  }
  for (const impl of importers) {
    let claims = false;
    try {
      claims = impl.canHandleFile(raw);
    } catch {
      claims = false;
    }
    if (claims) return impl.parseFile(raw);
  }
  throw new Error("无法识别该歌单文件格式");
}
