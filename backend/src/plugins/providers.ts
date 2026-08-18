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
import type { RegisteredPlugin } from "./registry.js";
import { createPluginHost } from "./host.js";
import { recordSuccess, recordFailure } from "./health.js";
import { getSetting } from "../services/settings.js";
import type { LyricSongInput } from "./types.js";
import { createLogger } from "../utils/logger.js";

const APP_VERSION = process.env.APP_VERSION || "dev";

/** Whether any enabled lyric provider exists (lets the core decide whether to
 *  take the plugin path at all — mirrors songloft's HasLyricProvider()). */
const log = createLogger("cover");
export function hasLyricProvider(): boolean {
  return getEnabledByCapability("lyricProvider").length > 0;
}

/** Whether any enabled cover provider exists. */
export function hasCoverProvider(): boolean {
  return getEnabledByCapability("coverProvider").length > 0;
}

/**
 * 独立选源:若全局设置 `<capPrefix>.providerId` 指定了插件且该插件启用,
 * 则只返回它;否则(未设置/被禁用/被卸载)回退全部启用的 provider。
 * 核心始终只按 capability + 用户配置过滤,绝不写死插件名。
 * @param all 已按 capability 过滤并启用排序的插件列表
 * @param settingKey 全局设置键,如 "lyrics.providerId" / "cover.providerId"
 */
export function filterProvidersByPreference(
  all: RegisteredPlugin[],
  settingKey: string,
): RegisteredPlugin[] {
  if (all.length === 0) return all;
  const preferred = getSetting(settingKey, "");
  if (!preferred) return all;
  const picked = all.filter((p) => p.manifest.id === preferred);
  return picked.length > 0 ? picked : all;
}

/**
 * Search lyrics across all enabled lyric providers (first-match-wins).
 * Honors the global `lyrics.providerId` selection when set.
 * @returns LRC/plain lyric text, or null if no provider could supply it.
 */
export async function searchLyrics(song: LyricSongInput): Promise<string | null> {
  const providers = filterProvidersByPreference(getEnabledByCapability("lyricProvider"), "lyrics.providerId");
  for (const { manifest, impl } of providers) {
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
      log.error(`provider ${manifest.id} failed`, { err: e?.message || e });
    }
  }
  return null;
}

/**
 * Search cover art across all enabled cover providers (first-match-wins).
 * Honors the global `cover.providerId` selection when set.
 * @returns a cover URL, or null if no provider could supply it.
 */
export async function searchCover(song: LyricSongInput): Promise<string | null> {
  const providers = filterProvidersByPreference(getEnabledByCapability("coverProvider"), "cover.providerId");
  for (const { manifest, impl } of providers) {
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
      log.error(`provider ${manifest.id} failed`, { err: e?.message || e });
    }
  }
  return null;
}
