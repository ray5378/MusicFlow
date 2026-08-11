// ==================== Plugin Registry (runtime) ====================
//
// Single source of truth for which plugins are loaded. The core queries this
// registry by *capability* / *type* — never by a concrete plugin name. Plugins
// are registered at boot (built-ins) and, in Phase 3, from data/plugins/*.

// NOTE: this module must NOT import ./builtins.js. The built-in catalog pulls in
// the actual plugin implementations, and those implementations import *this*
// registry (capability lookups) — importing builtins here would close the cycle
// `registry -> builtins -> impl -> registry` and leave half-initialised ESM
// bindings at load time. Registration + DB seeding therefore live in builtins.ts.

import { db } from "../db/index.js";
import { plugins } from "../db/schema.js";
import { eq } from "drizzle-orm";
import type { PluginManifest, PluginType, PluginCapability, LyricSongInput } from "./types.js";

export interface RegisteredPlugin {
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

/** Enabled plugins declaring `cap`, in registration order.
 *
 *  This is THE lookup the core should use. Anything that used to hardcode a
 *  plugin id ("go-music-dl", the QQ/NetEase if-chain, ...) becomes "give me the
 *  enabled plugins that can do X". */
export function getEnabledByCapability(cap: PluginCapability): RegisteredPlugin[] {
  return getEnabledPlugins().filter((p) => p.manifest.capabilities.includes(cap));
}

/** First enabled plugin declaring `cap`, or undefined. */
export function firstEnabledByCapability(cap: PluginCapability): RegisteredPlugin | undefined {
  return getEnabledByCapability(cap)[0];
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
