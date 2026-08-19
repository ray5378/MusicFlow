// ==================== Built-in Plugin Catalog + Bootstrap ====================
//
// The set of plugins compiled into MusicFlow, and the two-step bootstrap that
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
import { eq } from "drizzle-orm";
import type { PluginManifest } from "./types.js";
import { registerPlugin, listRegistered } from "./registry.js";

// ---- source ----
// NOTE: go-music-dl 三合一(源/歌词/封面)改回**外置**插件(MusicFlow-plugins
// 仓库分发),随后端加固「能力推导权限」(discovery.ts 的 derivePermissions)
// 根治了外置静默失效根因后,无需再内置。外置版通过官方注册表 / 市场安装。
// ---- importer ----
import { qqImporterManifest, qqImporter } from "../services/plugin/importers/qq.js";
import { neteaseImporterManifest, neteaseImporter } from "../services/plugin/importers/netease.js";
import { nativeImporterManifest, nativeImporter } from "../services/plugin/importers/native.js";
// ---- recommender ----
import { dailyRecommendManifest, dailyRecommendPlugin } from "../services/plugin/dailyRecommend.js";
import { localRecommendManifest, localRecommendPlugin } from "../services/plugin/localRecommend.js";
import { dailyRoamManifest, dailyRoamPlugin } from "../services/plugin/dailyRoam.js";
// ---- sync ----
import { playlistSyncManifest, playlistSyncPlugin } from "../services/plugin/playlistSync.js";
// ---- lyrics / cover providers ----
// NOTE: go-music-dl 的歌词 / 封面能力随该外置 source 插件分发(capabilities 含
// lyricProvider/coverProvider),由核心按能力遍历调用,不再单独内置。
// ---- renderer (device casting) ----
import { dlnaRendererManifest, dlnaRendererPlugin } from "../services/plugin/renderers/dlna.js";
import { airplayRendererManifest, airplayRendererPlugin } from "../services/plugin/renderers/airplay.js";
// ---- artist (artist info scraping) ----
import { artistInfoManifest, artistInfoPlugin } from "../services/plugin/artistInfo.js";

export interface BuiltinPlugin {
  manifest: PluginManifest;
  impl: any;
}

export const BUILTIN_SOURCE_PLUGINS: BuiltinPlugin[] = [
  // go-music-dl 已改回外置(MusicFlow-plugins 仓库分发),此处不再内置。
];

export const BUILTIN_IMPORTER_PLUGINS: BuiltinPlugin[] = [
  { manifest: qqImporterManifest, impl: qqImporter },
  { manifest: neteaseImporterManifest, impl: neteaseImporter },
  { manifest: nativeImporterManifest, impl: nativeImporter },
];

export const BUILTIN_RECOMMENDER_PLUGINS: BuiltinPlugin[] = [
  { manifest: dailyRecommendManifest, impl: dailyRecommendPlugin },
  { manifest: localRecommendManifest, impl: localRecommendPlugin },
  // 「今日漫游」组合歌单:合并前两者输出,按 comboPlaylist 能力在调度器最后跑。
  { manifest: dailyRoamManifest, impl: dailyRoamPlugin },
];

export const BUILTIN_SYNC_PLUGINS: BuiltinPlugin[] = [
  { manifest: playlistSyncManifest, impl: playlistSyncPlugin },
];

export const BUILTIN_LYRIC_PLUGINS: BuiltinPlugin[] = [];
export const BUILTIN_COVER_PLUGINS: BuiltinPlugin[] = [];

export const BUILTIN_RENDERER_PLUGINS: BuiltinPlugin[] = [
  { manifest: dlnaRendererManifest, impl: dlnaRendererPlugin },
  { manifest: airplayRendererManifest, impl: airplayRendererPlugin },
];

export const BUILTIN_ARTIST_PLUGINS: BuiltinPlugin[] = [
  { manifest: artistInfoManifest, impl: artistInfoPlugin },
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
  ...BUILTIN_ARTIST_PLUGINS,
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
 *  config/enabled state survives restarts.
 *
 *  升级同步：已存在的**内置**插件行若 DB manifest 是旧快照（例如升级前播种的
 *  configSchema 为空、新增了配置项），刷新 manifest + version 列，让升级部署
 *  对新增配置项立即可见；用户 enabled / config / description 一律保留。
 *  外置插件的行不在此刷新（其 manifest 以安装包为准）。 */
export function seedPluginRows(): number {
  const now = new Date().toISOString();
  let inserted = 0;
  const existing = new Set(
    (db.select({ name: plugins.name }).from(plugins).all() as any[]).map((r: any) => r.name),
  );
  const builtinIds = new Set(BUILTIN_PLUGINS.map((b) => b.manifest.id));
  for (const { manifest } of listRegistered()) {
    if (existing.has(manifest.id)) {
      if (builtinIds.has(manifest.id)) {
        const row = db.select().from(plugins).where(eq(plugins.name, manifest.id)).get() as any;
        if (row && row.manifest !== JSON.stringify(manifest)) {
          db.update(plugins)
            .set({ manifest: JSON.stringify(manifest), version: manifest.version, updatedAt: now })
            .where(eq(plugins.name, manifest.id))
            .run();
        }
      }
      continue;
    }
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
