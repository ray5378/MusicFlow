// ==================== Renderer plugins (device casting) ====================
//
// Exposes device-casting through the plugin layer. The built-in DLNA adapter
// is registered as a `renderer` plugin (see services/plugin/renderers/dlna.ts);
// a Chromecast / AirPlay / Kodi adapter can be added later as a separate
// plugin without touching the core. The core only iterates enabled renderers.

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

/** Cast a song to a device owned by a renderer plugin. */
export async function castToRenderer(pluginId: string, deviceId: string, songId: string): Promise<{ mediaUri: string }> {
  const entry = getEnabledByCapability("renderer").find((p) => p.manifest.id === pluginId);
  if (!entry || typeof entry.impl?.cast !== "function") {
    throw new Error(`未找到可用的渲染器插件: ${pluginId}`);
  }
  const cfg = getPluginConfig(pluginId) || {};
  const host = createPluginHost(entry.manifest, cfg, APP_VERSION);
  try {
    const r = await entry.impl.cast(host, deviceId, songId);
    recordSuccess(pluginId);
    return r;
  } catch (e: any) {
    recordFailure(pluginId, e?.message || String(e));
    throw e;
  }
}

/** Transport control on a device owned by a renderer plugin (optional). */
export async function controlRenderer(pluginId: string, deviceId: string, action: string, payload?: any): Promise<any> {
  const entry = getEnabledByCapability("renderer").find((p) => p.manifest.id === pluginId);
  if (!entry || typeof entry.impl?.control !== "function") {
    throw new Error(`渲染器插件 ${pluginId} 不支持控制操作`);
  }
  const cfg = getPluginConfig(pluginId) || {};
  const host = createPluginHost(entry.manifest, cfg, APP_VERSION);
  return entry.impl.control(host, deviceId, action, payload);
}
