// ==================== Online Source Provider Interface ====================
//
// A "source provider" bridges MusicFlow to an external online-music aggregator
// (like the user-deployed go-music-dl web service). Search results are stored
// as DB songs with type="web" and streams are served by proxying the provider's
// /music/download stream URL from /rest/stream (see serveWebSongStream).
//
// Providers implement this interface AND carry a self-describing `manifest`
// (declaring their capabilities, supported platforms, config schema, and the
// daily-recommend prefix). The core discovers them through the registry and
// only ever calls methods whose capability is declared — it never names a
// concrete provider.

import type { PluginManifest, LyricSongInput } from "../../../plugins/types.js";

export interface OnlineSongResult {
  // Remote identity (used to build the stream URL)
  id: string;
  source: string; // platform slug: netease / qq / kugou / bilibili ...
  // Display metadata (mirrors the DB `songs` columns)
  name: string;
  artist: string;
  album: string;
  duration: number; // seconds
  cover: string; // remote cover URL
  extra?: Record<string, string> | null;
  // Optional details surfaced by the aggregator (may be empty)
  sortSize?: string;
  sortBitrate?: string;
}

export interface OnlineSearchParams {
  query: string;
  sources?: string[];
}

export interface OnlineSearchResult {
  songs: OnlineSongResult[];
}

/** A playlist recommended by a source channel on go-music-dl's /music/recommend. */
export interface OnlinePlaylistInfo {
  id: string; // platform playlist id
  name: string;
  source: string; // platform slug: netease / qq / kugou / kuwo
  creator: string;
  cover: string; // remote cover URL
  trackCount: string; // "589" (as displayed)
  link: string; // redirect /music/playlist?source=..&id=..  (relative)
  imported?: boolean; // whether this playlist is already imported locally
}

/** A recommended channel on the recommend page (one tab = one platform). */
export interface OnlineRecommendChannel {
  source: string;
  name: string; // display name e.g. "网易云音乐"
  count: number;
  playlists: OnlinePlaylistInfo[];
}

export interface OnlineRecommendResult {
  channels: OnlineRecommendChannel[];
}

/** A configured, instantiated online source provider. */
export interface OnlineProvider {
  readonly id: string;
  readonly name: string;
  /** Self-describing manifest (capabilities, platforms, configSchema, ...). */
  readonly manifest: PluginManifest;
  /** Test connectivity to the configured instance. */
  test(config: Record<string, any>): Promise<{ success: boolean; message?: string }>;
  /** Search the aggregated online catalog. */
  search(config: Record<string, any>, params: OnlineSearchParams): Promise<OnlineSearchResult>;
  /** Fetch the daily-recommend playlist channels (/music/recommend).
   *  opts.mode === "sync":路径 A 每日同步需要「真实上游列表」入库/清理,插件应走上游
   *  (go-music-dl 插件对非网易平台默认改走本地库轮转,仅 sync 模式仍拉上游)。 */
  recommend?(config: Record<string, any>, opts?: { mode?: string }): Promise<OnlineRecommendResult>;
  /** Fetch a single remote playlist's songs (/music/playlist?source=..id=..). */
  playlistSongs?(config: Record<string, any>, source: string, id: string): Promise<{ songs: OnlineSongResult[]; name: string }>;
  /** Build the audio proxy URL for a song (go-music-dl /download?stream=1). */
  streamUrl(config: Record<string, any>, song: OnlineSongResult, range?: string): string;
  /** Build the lyrics (LRC) URL for a stored web song. Returns null if the
   *  provider cannot supply lyrics for this song. Replaces the old core-side
   *  deriveGmdlLrcUrl() so that gmdl-specific URL logic lives with the plugin. */
  lyricUrl?(config: Record<string, any>, song: LyricSongInput): string | null;
}

// ==================== Registry (delegates to the unified registry) ====================

export {
  registerOnlineProvider,
  getOnlineProvider,
  listOnlineProviders,
} from "../../../plugins/registry.js";
