// ==================== Unified Plugin Manifest Types ====================
//
// These types describe every plugin kind MusicFlow-V2 can load, not just the
// online "source" plugins. The core only ever reasons about capabilities
// (declared in the manifest) — it never references a concrete plugin by name.

export type PluginType = "source" | "importer" | "recommender" | "sync";

/** Optional abilities a plugin may declare. The core only calls the matching
 *  method when the capability is present. */
export type PluginCapability =
  | "search" // online search
  | "recommend" // daily-recommend playlists
  | "playlistSongs" // fetch songs of a single remote playlist
  | "stream" // build an audio stream URL
  | "lyrics" // online lyrics
  | "webRotation"; // expire unreferenced web songs (daily-recommend rotation)

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
  /** Drives the admin config form (no more hardcoded baseUrl/sources fields). */
  configSchema: ConfigField[];
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
