// ==================== Built-in Plugin Catalog + Bootstrap ====================
//
// The set of plugins compiled into MusicFlow-V2, and the two-step bootstrap that
// gets them into the registry:
//
//   1. registerBuiltinPlugins()   — pure, in-memory, safe at module load
//   2. seedPluginRows()    — DB rows, deferred until the schema exists
//                                   (wired through db's onDatabaseReady hook)
//
// This module sits *above* plugins/registry.ts on purpose: it imports the plugin
// implementations, and those implementations import the registry for capability
// lookups. Keeping registration here (instead of in registry.ts) is what keeps
// that dependency graph acyclic.
//
// Adding a built-in plugin = one line in the arrays below. No core change.

import { db, onDatabaseReady } from "../db/index.js";
import { plugins } from "../db/schema.js";
import type { PluginManifest } from "./types.js";
import { registerPlugin, listRegistered } from "./registry.js";

// ---- source ----
// NOTE: go-music-dl 已改为官方外置插件(见 https://github.com/ray5378/MusicFlow-plugins),
// 不再随后端内置。用户从「插件市场」安装后,经 discovery 自动注册,行为不变。
// 因此 BUILTIN_SOURCE_PLUGINS 目前为空;其它核心源若需内置再加回此数组。
// ---- importer ----
import { qqImporterManifest, qqImporter } from "../services/plugin/importers/qq.js";
import { neteaseImporterManifest, neteaseImporter } from "../services/plugin/importers/netease.js";
import { nativeImporterManifest, nativeImporter } from "../services/plugin/importers/native.js";
// ---- recommender ----
import { dailyRecommendManifest, dailyRecommendPlugin } from "../services/plugin/dailyRecommend.js";
import { localRecommendManifest, localRecommendPlugin } from "../services/plugin/localRecommend.js";
// ---- sync ----
import { playlistSyncManifest, playlistSyncPlugin } from "../services/plugin/playlistSync.js";
// ---- lyrics / cover providers ----
// NOTE: go-music-dl 歌词 / 封面 已改为官方外置插件(见 MusicFlow-plugins 仓库),
// 不再随后端内置。安装后随市场分发,行为不变。其余内置 provider 也遵循此迁移方向。
// ---- renderer (device casting) ----
import { dlnaRendererManifest, dlnaRendererPlugin } from "../services/plugin/renderers/dlna.js";

export interface BuiltinPlugin {
  manifest: PluginManifest;
  impl: any;
}

export const BUILTIN_SOURCE_PLUGINS: BuiltinPlugin[] = [];

export const BUILTIN_IMPORTER_PLUGINS: BuiltinPlugin[] = [
  { manifest: qqImporterManifest, impl: qqImporter },
  { manifest: neteaseImporterManifest, impl: neteaseImporter },
  { manifest: nativeImporterManifest, impl: nativeImporter },
];

export const BUILTIN_RECOMMENDER_PLUGINS: BuiltinPlugin[] = [
  { manifest: dailyRecommendManifest, impl: dailyRecommendPlugin },
  { manifest: localRecommendManifest, impl: localRecommendPlugin },
];

export const BUILTIN_SYNC_PLUGINS: BuiltinPlugin[] = [
  { manifest: playlistSyncManifest, impl: playlistSyncPlugin },
];

export const BUILTIN_LYRIC_PLUGINS: BuiltinPlugin[] = [];
export const BUILTIN_COVER_PLUGINS: BuiltinPlugin[] = [];

export const BUILTIN_RENDERER_PLUGINS: BuiltinPlugin[] = [
  { manifest: dlnaRendererManifest, impl: dlnaRendererPlugin },
];

/** All built-in plugins (any type). */
export const BUILTIN_PLUGINS: BuiltinPlugin[] = [
  ...BUILTIN_SOURCE_PLUGINS,
  ...BUILTIN_IMPORTER_PLUGINS,
  ...BUILTIN_RECOMMENDER_PLUGINS,
  ...BUILTIN_SYNC_PLUGINS,
  ...BUILTIN_LYRIC_PLUGINS,
  ...BUILTIN_COVER_PLUGINS,
  ...BUILTIN_RENDERER_PLUGINS,
];

let registered = false;

/** Register all built-in plugins into the in-memory registry.
 *
 *  PURE: touches no database. This may run at *module load* time, which happens
 *  before `initDatabase()` in the entry file and in unit tests — so doing DB
 *  work here would hit "no such table: plugins". Row seeding is deferred to
 *  seedPluginRows() via the db-ready hook. Idempotent. */
export function registerBuiltinPlugins(): void {
  if (registered) return;
  registered = true;
  for (const { manifest, impl } of BUILTIN_PLUGINS) {
    registerPlugin(manifest, impl);
  }
  // Seed rows as soon as the schema is ready (immediately, if it already is).
  onDatabaseReady(seedPluginRows);
}

/** Default config object derived from a manifest's configSchema. */
function defaultConfigFor(manifest: PluginManifest): Record<string, any> {
  const cfg: Record<string, any> = {};
  for (const f of manifest.configSchema) {
    if (f.default !== undefined) cfg[f.key] = f.default;
  }
  if (!("baseUrl" in cfg)) cfg.baseUrl = "";
  return cfg;
}

/** Seed DB rows for every registered plugin that doesn't have one yet.
 *
 *  MUST run after the schema exists (i.e. after `initDatabase()`).
 *  Manifest-driven: adding a built-in plugin needs no core change and no
 *  hardcoded plugin name. Idempotent — existing rows are left untouched so user
 *  config/enabled state survives restarts. */
export function seedPluginRows(): number {
  const now = new Date().toISOString();
  let inserted = 0;
  const existing = new Set(
    (db.select({ name: plugins.name }).from(plugins).all() as any[]).map((r: any) => r.name),
  );
  for (const { manifest } of listRegistered()) {
    if (existing.has(manifest.id)) continue;
    db.insert(plugins)
      .values({
        id: manifest.id,
        name: manifest.id,
        version: manifest.version,
        description: manifest.description || "",
        manifest: JSON.stringify(manifest),
        // Source plugins stay off until configured (they need a baseUrl);
        // built-in importer/recommender/sync plugins replace previously-
        // hardcoded core paths and must be on by default, or importing a
        // playlist / daily recommend would silently stop working.
        enabled: manifest.defaultEnabled ? 1 : 0,
        config: JSON.stringify(defaultConfigFor(manifest)),
        createdAt: now,
        updatedAt: now,
      })
      .run();
    inserted++;
  }
  return inserted;
}
