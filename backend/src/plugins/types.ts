// ==================== Unified Plugin Manifest Types ====================
//
// These types describe every plugin kind MusicFlow-V2 can load, not just the
// online "source" plugins. The core only ever reasons about capabilities
// (declared in the manifest) — it never references a concrete plugin by name.

export type PluginType = "source" | "importer" | "recommender" | "sync";

/** Optional abilities a plugin may declare. The core only calls the matching
 *  method when the capability is present. */
export type PluginCapability =
  // ---- source plugins ----
  | "search" // online search
  | "recommend" // daily-recommend playlists
  | "playlistSongs" // fetch songs of a single remote playlist
  | "stream" // build an audio stream URL
  | "lyrics" // online lyrics
  | "webRotation" // expire unreferenced web songs (daily-recommend rotation)
  // ---- importer plugins ----
  | "playlistImport" // parse a share URL -> remote playlist track list
  | "playlistFile" // parse an uploaded playlist file (native export, m3u, ...)
  // ---- recommender plugins ----
  | "dailyPlaylist" // build/refresh a scheduled recommendation playlist
  // ---- sync plugins ----
  | "playlistSync" // re-fetch an imported playlist and rebuild its entries
  | "autoMatch"; // match unmatched playlist entries against an online source

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

/** Minimal song shape the lyrics subsystem needs from a DB song row. */
export interface LyricSongInput {
  url?: string | null;
  duration?: number | null;
  title?: string | null;
  artist?: string | null;
  album?: string | null;
  source?: string | null;
  extra?: Record<string, any> | null;
}
