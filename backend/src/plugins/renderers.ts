// ==================== Renderer plugins (device casting) ====================
//
// Exposes device-casting through the plugin layer. The built-in DLNA adapter
// is registered as a `renderer` plugin (see services/plugin/renderers/dlna.ts);
// a Chromecast / AirPlay / Kodi adapter can be added later as a separate
// plugin without touching the core. The core only iterates enabled renderers.
//
// `castToRenderer` / `controlRenderer` were removed in v4.15.15: playback never
// goes through "hand a URL to the device" (that bypasses QueueController's
// progress / hold / delay handling). Playback takes a `ProtocolPlayer` from the
// renderer plugin instead (see renderer-plugin-migration-plan). This module now
// only enumerates devices; `cast` / `control` stay on the RendererPlugin contract.

import { getEnabledByCapability, getPluginConfig } from "./registry.js";
import { createPluginHost } from "./host.js";
import { recordSuccess, recordFailure } from "./health.js";
import type { RendererDevice } from "./types.js";
import { createLogger } from "../utils/logger.js";

const APP_VERSION = process.env.APP_VERSION || "dev";

/** All enabled renderer plugins (id + manifest). */
const log = createLogger("renderer");
export function getRendererPlugins(): { id: string; name: string }[] {
  return getEnabledByCapability("renderer").map((p) => ({ id: p.manifest.id, name: p.manifest.name }));
}

/** Enumerate available devices across all enabled renderer plugins. */
export async function discoverRenderers(): Promise<(RendererDevice & { pluginId: string })[]> {
  const out: (RendererDevice & { pluginId: string })[] = [];
  for (const { manifest, impl } of getEnabledByCapability("renderer")) {
    if (typeof impl?.discover !== "function") continue;
    const cfg = getPluginConfig(manifest.id) || {};
    const host = createPluginHost(manifest, cfg, APP_VERSION);
    try {
      const devices = await impl.discover(host);
      for (const d of devices) out.push({ ...d, pluginId: manifest.id });
      recordSuccess(manifest.id);
    } catch (e: any) {
      recordFailure(manifest.id, e?.message || String(e));
      log.error(`${manifest.id} discover failed`, { err: e?.message || e });
    }
  }
  return out;
}
