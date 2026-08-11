// ==================== Unified Plugin Manifest Types ====================
//
// These types describe every plugin kind MusicFlow-V2 can load, not just the
// online "source" plugins. The core only ever reasons about capabilities
// (declared in the manifest) — it never references a concrete plugin by name.
//
// A plugin receives a `host` context (see host.ts) instead of importing the
// backend. Provider-style plugins (lyrics/cover/renderer/scrobbler) take that
// context as their first argument so they can log, read config, use storage,
// and talk to other plugins — all through the controlled surface.

import type { PluginHost } from "./host.js";

export type PluginType =
  | "source"      // online music source (search/stream/...)
  | "importer"    // playlist import (URL or file)
  | "recommender" // builds/refreshes recommendation playlists
  | "sync"        // re-syncs imported playlists
  | "lyrics"      // supplies lyrics (lyricProvider)
  | "cover"       // supplies cover art (coverProvider)
  | "renderer"    // casts audio to a device (DLNA / Chromecast / ...)
  | "scrobbler";  // reports plays to an external service (Last.fm / ListenBrainz)

/** Optional abilities a plugin may declare. The core only calls the matching
 *  method when the capability is present. */
export type PluginCapability =
  // ---- source plugins ----
  | "search" // online search
  | "recommend" // daily-recommend playlists
  | "playlistSongs" // fetch songs of a single remote playlist
  | "stream" // build an audio stream URL
  | "lyrics" // online lyrics (legacy: a source plugin that also serves lyrics)
  | "webRotation" // expire unreferenced web songs (daily-recommend rotation)
  // ---- importer plugins ----
  | "playlistImport" // parse a share URL -> remote playlist track list
  | "playlistFile" // parse an uploaded playlist file (native export, m3u, ...)
  // ---- recommender plugins ----
  | "dailyPlaylist" // build/refresh a scheduled recommendation playlist
  | "localPlaylist" // contribute local-library recommendations
  // ---- sync plugins ----
  | "playlistSync" // re-fetch an imported playlist and rebuild its entries
  | "autoMatch" // match unmatched playlist entries against an online source
  // ---- provider plugins ----
  | "lyricProvider" // supplies lyrics via searchLyrics()
  | "coverProvider" // supplies cover art via searchCover()
  | "renderer" // casts audio to a device via discover/cast/control
  | "scrobbler"; // reports playback events via onPlay/onScrobble

export interface ConfigField {
  key: string;
  label: string;
  type: "text" | "url" | "number" | "select" | "multiselect" | "radio" | "switch";
  required?: boolean;
  default?: unknown;
  options?: { label: string; value: string }[];
  help?: string;
}

export interface PluginManifest {
  id: string; // unique, e.g. "go-music-dl"
  name: string; // display name
  version: string;
  type: PluginType;
  description?: string;
  capabilities: PluginCapability[];
  /** Source plugins only: supported platform slugs (netease, qq, ...). */
  platforms?: string[];
  /** Source plugins only: prefix used to tag daily-recommend imported playlists. */
  recommendPrefix?: string;
  minAppVersion?: string;
  /** Declared permissions (see host.KNOWN_PERMISSIONS). Unknown perms are
   *  rejected at manifest-validation time. */
  permissions?: string[];
  /** Metadata (for the admin UI / marketplace). All optional. */
  author?: string;
  homepage?: string;
  license?: string;
  icon?: string; // URL or data-uri
  updateUrl?: string; // self-update source (zip or manifest URL)
  downloadUrl?: string; // canonical download location
  /** Whether the plugin is enabled the first time its row is seeded.
   *
   *  Source plugins default to OFF (they need a baseUrl before they do anything
   *  useful). Built-in importer/recommender/sync plugins default to ON, because
   *  they are the code paths that used to be hardcoded in the core — seeding
   *  them disabled would silently turn off playlist import / daily recommend. */
  defaultEnabled?: boolean;
  /** Importer plugins only: URL patterns this importer claims (documentation +
   *  admin UI hint; actual routing uses the impl's canHandle()). */
  urlPatterns?: string[];
  /** Drives the admin config form (no more hardcoded baseUrl/sources fields). */
  configSchema: ConfigField[];
}

// ==================== Capability-specific impl contracts ====================

/** A track parsed from a remote playlist (mirrors services/plugin/playlistImport). */
export interface ImportedTrackShape {
  externalId: string;
  title: string;
  artist: string;
  album?: string;
  duration?: number;
}

export interface ImportedPlaylistShape {
  name: string;
  platform: string;
  coverUrl?: string;
  tracks: ImportedTrackShape[];
}

/** Implemented by `importer` plugins that declare the "playlistImport" capability. */
export interface ImporterPlugin {
  manifest: PluginManifest;
  /** True if this importer recognizes the share URL. */
  canHandle(url: string): boolean;
  /** Fetch and parse the remote playlist. */
  fetchPlaylist(url: string): Promise<ImportedPlaylistShape>;
}

/** Implemented by `importer` plugins that declare the "playlistFile" capability
 *  (parsing an uploaded playlist file rather than a share URL). */
export interface PlaylistFilePlugin {
  manifest: PluginManifest;
  /** True if this importer recognizes the parsed file payload. */
  canHandleFile(raw: unknown): boolean;
  /** Parse the payload into one or more playlists. */
  parseFile(raw: unknown): ImportedPlaylistShape[];
}

/** Implemented by `recommender` plugins that declare "dailyPlaylist". */
export interface RecommenderPlugin {
  manifest: PluginManifest;
  /** Build/refresh this recommender's playlist. Returns a short summary line
   *  for the scheduler log, or null when nothing was done. */
  runDailyJob(): Promise<string | null>;
}

/** Implemented by `sync` plugins that declare "playlistSync". Called by the
 *  maintenance loop; must never throw (return a summary or null instead). */
export interface SyncPlugin {
  manifest: PluginManifest;
  /** Re-sync everything this plugin owns. Returns a short summary line for the
   *  scheduler log, or null when nothing was done. */
  runSyncJob(): Promise<string | null>;
}

/** Implemented by `recommender` plugins that declare "localPlaylist".
 *  Contributes a date-seeded set of local-library song ids to the daily mix. */
export interface LocalRecommendPlugin {
  manifest: PluginManifest;
  /** Return playable local song ids for today's daily playlist. */
  pickSongs(date?: Date): Promise<{ songIds: string[]; sourceUsers: number; fallback: boolean }>;
}

/** Implemented by `lyrics` plugins that declare "lyricProvider".
 *  First-match-wins across all enabled lyric providers. */
export interface LyricProviderPlugin {
  manifest: PluginManifest;
  /** Return LRC/plain lyrics for a song, or null if this provider can't. */
  searchLyrics(host: PluginHost, song: LyricSongInput): Promise<{ lrc?: string; text?: string } | null>;
}

/** Implemented by `cover` plugins that declare "coverProvider".
 *  First-match-wins across all enabled cover providers. */
export interface CoverProviderPlugin {
  manifest: PluginManifest;
  /** Return a cover URL for a song, or null if this provider can't. */
  searchCover(host: PluginHost, song: LyricSongInput): Promise<{ url?: string } | null>;
}

/** A discovered / controllable playback device (renderer). */
export interface RendererDevice {
  id: string;
  name: string;
  type: string; // "dlna" | "chromecast" | ...
  available: boolean;
  /** Optional vendor metadata (manufacturer, model, volume support, ...). */
  meta?: Record<string, any>;
}

/** Implemented by `renderer` plugins that declare "renderer". */
export interface RendererPlugin {
  manifest: PluginManifest;
  /** Enumerate currently available devices. */
  discover(): Promise<RendererDevice[]>;
  /** Cast a song (by songId) to a device. Returns a session token/handle. */
  cast(deviceId: string, songId: string): Promise<{ mediaUri: string }>;
  /** Optional transport control (play/pause/stop/seek/volume/next/prev). */
  control?(deviceId: string, action: string, payload?: any): Promise<any>;
}

/** Implemented by `scrobbler` plugins that declare "scrobbler". */
export interface ScrobblerPlugin {
  manifest: PluginManifest;
  /** Called when a track starts playing. */
  onPlay?(host: PluginHost, event: ScrobbleEvent): Promise<void>;
  /** Called when a track has been played past the scrobble threshold. */
  onScrobble?(host: PluginHost, event: ScrobbleEvent): Promise<void>;
}

/** Playback event passed to scrobblers. */
export interface ScrobbleEvent {
  songId: string;
  title: string;
  artist: string;
  album?: string;
  duration?: number;
  playedAt: string; // ISO timestamp
}

/** Minimal song shape the lyrics/cover subsystems need from a DB song row. */
export interface LyricSongInput {
  url?: string | null;
  duration?: number | null;
  title?: string | null;
  artist?: string | null;
  album?: string | null;
  source?: string | null;
  extra?: Record<string, any> | null;
}
