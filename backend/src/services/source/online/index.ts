// ==================== Online Source Providers (aggregated) ====================
//
// Built-in online-music source plugins. A "source plugin" in the admin Plugins
// page maps to one of these providers; the plugin's `config` JSON holds the
// provider-specific settings (e.g. the go-music-dl instance baseUrl).

import { db } from "../../../db/index.js";
import { plugins } from "../../../db/schema.js";
import { eq } from "drizzle-orm";
import { getOnlineProvider, OnlineProvider, OnlineSongResult } from "./types.js";
import { registerBuiltinPlugins } from "../../../plugins/builtins.js";

// Make sure the built-in catalog is in the registry before any lookup happens.
// The entry file calls this explicitly too; registerBuiltinPlugins() is
// idempotent, and this keeps unit tests that only import the online layer working.
registerBuiltinPlugins();

export { getOnlineProvider };
export type { OnlineSongResult };

/** Load the stored config for the source plugin backing `providerId`, if enabled. */
export function getSourcePluginConfig(providerId: string): Record<string, any> | null {
  const p = db.select().from(plugins)
    .where(eq(plugins.name, providerId))
    .get();
  if (!p || !p.enabled) return null;
  try { return JSON.parse(p.config || "{}"); } catch { return null; }
}

/** A configured provider instance for a source plugin (null if disabled/unconfigured). */
export function getConfiguredProvider(providerId: string): { provider: OnlineProvider; config: Record<string, any> } | null {
  const config = getSourcePluginConfig(providerId);
  if (!config) return null;
  const provider = getOnlineProvider(providerId);
  if (!provider) return null;
  return { provider, config };
}