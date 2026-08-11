// ==================== Scrobbler plugins ====================
//
// Reports playback events to external services (Last.fm, ListenBrainz, ...).
// The core calls notifyScrobble() from the scrobble REST route; every enabled
// scrobbler plugin with a matching handler receives the event. A scrobbler is
// a thin plugin: it only gets the controlled `host` context and the event.

import { getEnabledByCapability, getPluginConfig } from "./registry.js";
import { createPluginHost } from "./host.js";
import { recordSuccess, recordFailure } from "./health.js";
import type { ScrobbleEvent } from "./types.js";

const APP_VERSION = process.env.APP_VERSION || "dev";

/** All enabled scrobbler plugins. */
export function getScrobblerPlugins(): { id: string; name: string }[] {
  return getEnabledByCapability("scrobbler").map((p) => ({ id: p.manifest.id, name: p.manifest.name }));
}

/**
 * Dispatch a playback event to all enabled scrobblers.
 * @param phase "play" → onPlay, "scrobble" → onScrobble
 */
export async function notifyScrobble(phase: "play" | "scrobble", event: ScrobbleEvent): Promise<void> {
  const handler = phase === "play" ? "onPlay" : "onScrobble";
  for (const { manifest, impl } of getEnabledByCapability("scrobbler")) {
    if (typeof impl?.[handler] !== "function") continue;
    const cfg = getPluginConfig(manifest.id) || {};
    const host = createPluginHost(manifest, cfg, APP_VERSION);
    try {
      await impl[handler](host, event);
      recordSuccess(manifest.id);
    } catch (e: any) {
      recordFailure(manifest.id, e?.message || String(e));
      console.error(`[scrobbler] ${manifest.id} ${handler} failed:`, e?.message || e);
    }
  }
}
