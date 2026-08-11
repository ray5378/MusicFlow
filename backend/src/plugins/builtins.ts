// ==================== Built-in Plugin Catalog ====================
//
// The set of plugins compiled into MusicFlow-V2. Adding a new built-in source
// is now a one-line addition here (plus its provider module) — no core code
// changes. Phase 3 will additionally discover plugins from data/plugins/*.

import type { PluginManifest } from "./types.js";
import { goMusicDlManifest, goMusicDlProvider } from "../services/source/online/goMusicDl.js";

export interface BuiltinPlugin {
  manifest: PluginManifest;
  impl: any;
}

export const BUILTIN_SOURCE_PLUGINS: BuiltinPlugin[] = [
  { manifest: goMusicDlManifest, impl: goMusicDlProvider },
];

/** All built-in plugins (any type), for DB seeding. */
export const BUILTIN_PLUGINS: BuiltinPlugin[] = [...BUILTIN_SOURCE_PLUGINS];
