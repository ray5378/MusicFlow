// ==================== Plugin Registry (runtime) ====================
//
// Single source of truth for which plugins are loaded. The core queries this
// registry by *capability* / *type* — never by a concrete plugin name. Plugins
// are registered at boot (built-ins) and, in Phase 3, from data/plugins/*.

import { db } from "../db/index.js";
import { plugins } from "../db/schema.js";
import { eq } from "drizzle-orm";
import type { PluginManifest, PluginType, PluginCapability, LyricSongInput } from "./types.js";
import { BUILTIN_PLUGINS } from "./builtins.js";

interface RegisteredPlugin {
  manifest: PluginManifest;
  impl: any;
}

const registry = new Map<string, RegisteredPlugin>();

/** Register a plugin (built-in or discovered). Safe to call multiple times. */
export function registerPlugin(manifest: PluginManifest, impl: any) {
  registry.set(manifest.id, { manifest, impl });
}

/** Compat shim: an OnlineProvider carries its manifest, so registering it is
 *  just registering (manifest, impl). */
export function registerOnlineProvider(p: { manifest: PluginManifest; [k: string]: any }) {
  registerPlugin(p.manifest, p);
}

/** Boot all built-in plugins: register them and seed their DB rows (once).
 *  Called once at startup (from online/index.ts). Seeding is manifest-driven
 *  so adding a built-in plugin needs no core change and no hardcoded names. */
export function registerBuiltinPlugins() {
  const now = new Date().toISOString();
  const existing = new Set(
    (db.select({ name: plugins.name }).from(plugins).all() as any[]).map((r: any) => r.name),
  );
  for (const { manifest, impl } of BUILTIN_PLUGINS) {
    registerPlugin(manifest, impl);
    if (existing.has(manifest.id)) continue;
    const defaultConfig: Record<string, any> = {};
    for (const f of manifest.configSchema) {
      if (f.default !== undefined) defaultConfig[f.key] = f.default;
    }
    if (!("baseUrl" in defaultConfig)) defaultConfig.baseUrl = "";
    db.insert(plugins)
      .values({
        id: manifest.id,
        name: manifest.id,
        version: manifest.version,
        description: manifest.description || "",
        manifest: JSON.stringify(manifest),
        enabled: 0,
        config: JSON.stringify(defaultConfig),
        createdAt: now,
        updatedAt: now,
      })
      .run();
  }
}

export function getPlugin(id: string): RegisteredPlugin | undefined {
  return registry.get(id);
}
export function getPluginImpl(id: string): any | undefined {
  return registry.get(id)?.impl;
}
/** Back-compat: an "online provider" is just the registered impl. */
export function getOnlineProvider(id: string): any | undefined {
  return registry.get(id)?.impl;
}
export function listOnlineProviders(): any[] {
  return listRegistered().map((p) => p.impl);
}
export function getPluginManifest(id: string): PluginManifest | undefined {
  return registry.get(id)?.manifest;
}
export function listRegistered(): RegisteredPlugin[] {
  return [...registry.values()];
}

/** Whether a plugin declares a capability (without requiring it to be enabled). */
export function getCapabilities(id: string): PluginCapability[] {
  return registry.get(id)?.manifest.capabilities ?? [];
}

/** Plugins that are both registered in code AND enabled in the DB. */
export function getEnabledPlugins(type?: PluginType): RegisteredPlugin[] {
  const rows = db.select().from(plugins).all();
  const enabledIds = new Set(rows.filter((r: any) => r.enabled).map((r: any) => r.name));
  return listRegistered().filter(
    (p) => (type ? p.manifest.type === type : true) && enabledIds.has(p.manifest.id),
  );
}

export function getEnabledSourcePlugins(): RegisteredPlugin[] {
  return getEnabledPlugins("source");
}

/** Read the stored config JSON for a plugin id (from the DB `plugins` row). */
export function getPluginConfig(id: string): Record<string, any> | null {
  const p = db.select().from(plugins).where(eq(plugins.name, id)).get() as any;
  if (!p || !p.enabled) return null;
  try {
    return JSON.parse(p.config || "{}");
  } catch {
    return null;
  }
}
