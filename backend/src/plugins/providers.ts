// ==================== Provider registries (lyrics / cover) ====================
//
// songloft's most valuable pattern: instead of hardcoding one lyrics/cover
// source, plugins REGISTER as providers and the host lazily iterates them,
// first-match-wins. Multiple providers can coexist (e.g. go-music-dl lyrics +
// a NetEase lyrics plugin) and the user toggles them independently in the
// admin Plugins page. See docs/RESEARCH-songloft-plugin-inspiration.md §1.2.
//
// Each provider receives a `host` context (never imports the backend) and
// returns structured data. Failures are recorded in the health tracker but
// never abort the loop — the next provider gets a chance.

import { getEnabledByCapability, getPluginConfig } from "./registry.js";
import { createPluginHost } from "./host.js";
import { recordSuccess, recordFailure } from "./health.js";
import type { LyricSongInput } from "./types.js";

const APP_VERSION = process.env.APP_VERSION || "dev";

/** Whether any enabled lyric provider exists (lets the core decide whether to
 *  take the plugin path at all — mirrors songloft's HasLyricProvider()). */
export function hasLyricProvider(): boolean {
  return getEnabledByCapability("lyricProvider").length > 0;
}

/** Whether any enabled cover provider exists. */
export function hasCoverProvider(): boolean {
  return getEnabledByCapability("coverProvider").length > 0;
}

/**
 * Search lyrics across all enabled lyric providers (first-match-wins).
 * @returns LRC/plain lyric text, or null if no provider could supply it.
 */
export async function searchLyrics(song: LyricSongInput): Promise<string | null> {
  for (const { manifest, impl } of getEnabledByCapability("lyricProvider")) {
    if (typeof impl?.searchLyrics !== "function") continue;
    const cfg = getPluginConfig(manifest.id) || {};
    const host = createPluginHost(manifest, cfg, APP_VERSION);
    try {
      const r = await impl.searchLyrics(host, song);
      if (r && (r.lrc || r.text)) {
        recordSuccess(manifest.id);
        return r.lrc || r.text || null;
      }
      // Provider responded but had nothing for this song — keep trying others.
    } catch (e: any) {
      recordFailure(manifest.id, e?.message || String(e));
      console.error(`[lyrics] provider ${manifest.id} failed:`, e?.message || e);
    }
  }
  return null;
}

/**
 * Search cover art across all enabled cover providers (first-match-wins).
 * @returns a cover URL, or null if no provider could supply it.
 */
export async function searchCover(song: LyricSongInput): Promise<string | null> {
  for (const { manifest, impl } of getEnabledByCapability("coverProvider")) {
    if (typeof impl?.searchCover !== "function") continue;
    const cfg = getPluginConfig(manifest.id) || {};
    const host = createPluginHost(manifest, cfg, APP_VERSION);
    try {
      const r = await impl.searchCover(host, song);
      if (r && r.url) {
        recordSuccess(manifest.id);
        return r.url;
      }
    } catch (e: any) {
      recordFailure(manifest.id, e?.message || String(e));
      console.error(`[cover] provider ${manifest.id} failed:`, e?.message || e);
    }
  }
  return null;
}
