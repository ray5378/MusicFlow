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
import type { LyricSongInput, SongMetadata } from "./types.js";
import { createLogger } from "../utils/logger.js";

const APP_VERSION = process.env.APP_VERSION || "dev";

/** 来源优先级设置的键前缀("lyrics" | "cover" | "metadata")。 */
export type ProviderPrefPrefix = "lyrics" | "cover" | "metadata";

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

/** Whether any enabled metadata provider exists (标签补全链路的启用判定)。 */
export function hasMetadataProvider(): boolean {
  return getEnabledByCapability("metadataProvider").length > 0;
}

/**
 * 规范化优先级列表:仅保留非空字符串、trim、按值去重(保序)。非数组 → []。
 */
export function normalizeProviderPriority(list: unknown): string[] {
  if (!Array.isArray(list)) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of list) {
    if (typeof raw !== "string") continue;
    const id = raw.trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

/**
 * 读取某个能力的**有效**来源优先级(有序数组):
 *   - 新键 `<prefix>.providerPriority` 非空 → 直接用它;
 *   - 否则**兼容旧单源设置** `<prefix>.providerId`:有值则视作单源 [providerId](旧行为不丢);
 *   - 两者都空 → [](= 自动:全部启用 provider,注册顺序)。
 * @param prefix "lyrics" | "cover"
 */
export function getProviderPriority(prefix: ProviderPrefPrefix): string[] {
  const raw = getSetting(`${prefix}.providerPriority`, "");
  if (raw) {
    try {
      const list = normalizeProviderPriority(JSON.parse(raw));
      if (list.length > 0) return list;
    } catch { /* 非法 JSON → 回退 providerId */ }
  }
  const legacy = getSetting(`${prefix}.providerId`, "");
  return legacy ? [legacy] : [];
}

/**
 * 按来源优先级排序/筛选(播放来源优先级同款语义):
 *   - 新键 `<prefix>.providerPriority` 非空 → **严格按列表顺序**返回其中「存在于 all」
 *     的插件;未列出的不参与;指向不存在/未启用的插件 → 安全跳过。
 *   - 该键为空时**兼容旧单源** `<prefix>.providerId`:命中则只返回它(旧行为),
 *     未命中(插件被禁用/卸载)→ 回退全部启用项(旧行为:不因插件消失就没歌词)。
 *   - 两者都空 → 全部启用(注册顺序 first-match-wins)。
 * 核心始终只按 capability + 用户配置排序,绝不写死插件名。
 * @param all 已按 capability 过滤并启用排序的插件列表
 * @param prefix "lyrics" | "cover"
 */
export function filterProvidersByPreference(
  all: RegisteredPlugin[],
  prefix: ProviderPrefPrefix,
): RegisteredPlugin[] {
  if (all.length === 0) return all;

  // 新协议:有序优先级列表(严格)。
  const raw = getSetting(`${prefix}.providerPriority`, "");
  if (raw) {
    let priority: string[] = [];
    try { priority = normalizeProviderPriority(JSON.parse(raw)); } catch { priority = []; }
    if (priority.length > 0) {
      const byId = new Map(all.map((p) => [p.manifest.id, p]));
      const ordered: RegisteredPlugin[] = [];
      for (const id of priority) {
        const picked = byId.get(id);
        if (!picked) continue; // 不存在/未启用 → 跳过该条,继续下一项
        ordered.push(picked);
        byId.delete(id); // 去重(列表已规范化,这里防御性)
      }
      return ordered;
    }
  }

  // 兼容旧单源 providerId(未迁移的安装):命中只用它;未命中回退全部。
  const legacy = getSetting(`${prefix}.providerId`, "");
  if (!legacy) return all;
  const picked = all.filter((p) => p.manifest.id === legacy);
  return picked.length > 0 ? picked : all;
}

/**
 * 命中回调(可选):某 provider 胜出时上报来源,供调用方判定「谁打上了标签」。
 * `builtin` = 该 provider 的 manifest 声明了 `builtinTagSource`(内置标签来源)。
 */
export interface ProviderMatchOptions {
  onMatch?: (providerId: string, builtin: boolean) => void;
}

/**
 * Search lyrics across enabled lyric providers (first-match-wins), honoring the
 * user's `lyrics.providerPriority` order (falls back to legacy `lyrics.providerId`).
 * @returns LRC/plain lyric text, or null if no provider could supply it.
 */
export async function searchLyrics(song: LyricSongInput, opts?: ProviderMatchOptions): Promise<string | null> {
  const providers = filterProvidersByPreference(getEnabledByCapability("lyricProvider"), "lyrics");
  for (const { manifest, impl } of providers) {
    if (typeof impl?.searchLyrics !== "function") continue;
    const cfg = getPluginConfig(manifest.id) || {};
    const host = createPluginHost(manifest, cfg, APP_VERSION);
    try {
      const r = await impl.searchLyrics(host, song);
      if (r && (r.lrc || r.text)) {
        recordSuccess(manifest.id);
        opts?.onMatch?.(manifest.id, manifest.builtinTagSource === true);
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
 * Search cover art across enabled cover providers (first-match-wins), honoring the
 * user's `cover.providerPriority` order (falls back to legacy `cover.providerId`).
 * @returns a cover URL, or null if no provider could supply it.
 */
export async function searchCover(song: LyricSongInput, opts?: ProviderMatchOptions): Promise<string | null> {
  const providers = filterProvidersByPreference(getEnabledByCapability("coverProvider"), "cover");
  for (const { manifest, impl } of providers) {
    if (typeof impl?.searchCover !== "function") continue;
    const cfg = getPluginConfig(manifest.id) || {};
    const host = createPluginHost(manifest, cfg, APP_VERSION);
    try {
      const r = await impl.searchCover(host, song);
      if (r && r.url) {
        recordSuccess(manifest.id);
        opts?.onMatch?.(manifest.id, manifest.builtinTagSource === true);
        return r.url;
      }
    } catch (e: any) {
      recordFailure(manifest.id, e?.message || String(e));
      log.error(`provider ${manifest.id} failed`, { err: e?.message || e });
    }
  }
  return null;
}

/**
 * Search full tag metadata across enabled metadata providers (first-match-wins),
 * honoring the user's `metadata.providerPriority` order (falls back to legacy
 * `metadata.providerId`).
 * @returns the matched SongMetadata, or null if no provider could supply it.
 */
export async function searchMetadata(song: LyricSongInput, opts?: ProviderMatchOptions): Promise<SongMetadata | null> {
  const providers = filterProvidersByPreference(getEnabledByCapability("metadataProvider"), "metadata");
  for (const { manifest, impl } of providers) {
    if (typeof impl?.searchMetadata !== "function") continue;
    const cfg = getPluginConfig(manifest.id) || {};
    const host = createPluginHost(manifest, cfg, APP_VERSION);
    try {
      const r = await impl.searchMetadata(host, song);
      if (r && typeof r === "object" && Object.keys(r).length > 0) {
        recordSuccess(manifest.id);
        opts?.onMatch?.(manifest.id, manifest.builtinTagSource === true);
        return r as SongMetadata;
      }
      // Provider responded but had nothing for this song — keep trying others.
    } catch (e: any) {
      recordFailure(manifest.id, e?.message || String(e));
      log.error(`provider ${manifest.id} failed`, { err: e?.message || e });
    }
  }
  return null;
}
