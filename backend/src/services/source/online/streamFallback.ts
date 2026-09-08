// ==================== Stream fallback (multi-source replay) ====================
//
// go-music-dl's platform parsers fail for some songs (e.g. an original QQ/kugou
// version may resolve to 404 while the same song exists and streams fine on
// netease). When /rest/stream proxies a web song and the original upstream URL
// fails, we search the same provider for an alternative version on another
// platform and stream that instead — so the track still plays.
//
// Fallbacks are memoized per song id (in memory) to avoid re-searching on every
// Range / next-play request.

import { getConfiguredProvider } from "./index.js";
import { OnlineSongResult } from "./types.js";
import { db } from "../../../db/index.js";
import { songs } from "../../../db/schema.js";
import { eq } from "drizzle-orm";
import { getEnabledSourcePlugins, getPluginManifest, getPluginConfig } from "../../../plugins/registry.js";
import { passesImportGate, getImportGateConfig, type ImportGateConfig } from "./importGate.js";
import { STREAM_FALLBACK_PLUGIN_ID } from "../../plugin/core/streamFallbackPlugin.js";

/** 读取换源兜底配置(core-stream-fallback 内置插件):enabled 总开关 + 时长容差覆写。 */
function getFallbackConfig(): { enabled: boolean; durationTolerance: number } {
  const cfg = (getPluginConfig(STREAM_FALLBACK_PLUGIN_ID) || {}) as Record<string, unknown>;
  const tol = Number(cfg.durationTolerance);
  return {
    enabled: cfg.enabled !== false,
    durationTolerance: Number.isFinite(tol) && tol > 0 ? tol : 0,
  };
}

// Bounded in-memory caches. Both grow with every web song played, so enforce a
// FIFO cap to keep memory usage bounded on long-running servers.
const FALLBACK_CACHE_MAX = 2000;
const PLAYABLE_CACHE_MAX = 5000;

// 搜索结果的源排序偏好:由源插件 manifest.sourcePreference 声明(核心不写死平台顺序)。
function getSourcePreference(providerId: string): string[] {
  return getPluginManifest(providerId)?.sourcePreference || [];
}

// Default fallback provider: the song's own pluginEntry if known, else the first
// enabled source plugin that declares the "stream" capability. Returns "" when no
// source plugin is available (no plugin → no fallback, behaviour-safe).
function defaultStreamProviderId(songPluginEntry?: string | null): string {
  if (songPluginEntry) return songPluginEntry;
  for (const { manifest } of getEnabledSourcePlugins()) {
    if (manifest.capabilities.includes("stream")) return manifest.id;
  }
  return "";
}

// songId -> working stream URL (or null once we know there's no alternative).
const fallbackCache = new Map<string, string | null>();

function setFallback(key: string, value: string | null) {
  fallbackCache.set(key, value);
  if (fallbackCache.size > FALLBACK_CACHE_MAX) {
    const oldest = fallbackCache.keys().next().value;
    if (oldest !== undefined) fallbackCache.delete(oldest);
  }
}

export async function findFallbackStream(
  songId: string,
  title: string,
  artist: string,
  album: string,
  duration: number,
  providerId: string,
  failingSource: string,
): Promise<{ url: string; source: string } | null> {
  if (fallbackCache.has(songId)) {
    const cached = fallbackCache.get(songId)!;
    if (cached) return { url: cached, source: "" };
    return null;
  }
  if (!title) { setFallback(songId, null); return null; }

  // 总开关(core-stream-fallback):关闭时不再搜索替代源。不写负缓存——开关
  // 随时可改,负缓存会让重新开启后首次播放仍误判无兜底。
  const fbCfg = getFallbackConfig();
  if (!fbCfg.enabled) return null;

  const configured = getConfiguredProvider(providerId);
  if (!configured?.provider.search) { setFallback(songId, null); return null; }

  const query = [title, artist].filter(Boolean).join(" ");
  let results: OnlineSongResult[];
  try {
    const r = await configured.provider.search(configured.config, { query });
    results = r.songs || [];
  } catch {
    setFallback(songId, null);
    return null;
  }

  // 换源兜底与导入门禁同套断言(v2.3.4):候选必须通过 passesImportGate——
  // 规范化标题+歌手(强制)+ 专辑一致(开关默认开)+ 时长差 ≤ 容差,全命中才允许换源。
  // 此前兜底只有「歌名严格相等 + 歌手首位名分」两维,元数据冒名候选(如《恋人》
  // 被换成网易云「李荣浩-、Montagem」的 funk remix:歌名相等、'李荣浩-'.includes
  // ('李荣浩') 恒真)通过后还被 updateSongUrl 持久化污染 songs.url,此后每次播放
  // 都直用错链。期望侧缺字段(无专辑/无时长)时对应维度自动跳过,与导入语义一致。
  // 时长容差默认沿用导入门禁;core-stream-fallback.durationTolerance > 0 时覆写
  // (仅放宽时长维度,标题/歌手/专辑不可放宽)。排序偏好(sourcePreference)不变。
  const gateCfg: ImportGateConfig | undefined = fbCfg.durationTolerance > 0
    ? { ...getImportGateConfig(), durationTolerance: fbCfg.durationTolerance }
    : undefined;
  const preference = getSourcePreference(providerId);
  const ranked = results
    .filter(s => {
      if (s.source === failingSource || !s.name) return false;
      return passesImportGate(
        { title, artist, album: album || null, duration: duration > 0 ? duration : null },
        { name: s.name, artist: s.artist, album: s.album, duration: s.duration },
        gateCfg,
      ).ok;
    })
    .sort((a, b) => {
      const ar = preference.indexOf(a.source);
      const br = preference.indexOf(b.source);
      return (ar === -1 ? 99 : ar) - (br === -1 ? 99 : br);
    });

  for (const cand of ranked) {
    const url = configured.provider.streamUrl(configured.config, cand);
    if (await probe(url)) {
      setFallback(songId, url);
      return { url, source: cand.source };
    }
  }

  setFallback(songId, null);
  return null;
}

async function probe(url: string): Promise<boolean> {
  try {
    const res = await fetch(url, { headers: { Range: "bytes=0-20000" }, signal: AbortSignal.timeout(12000) });
    if (res.status === 404 || (res.status !== 206 && res.status !== 200)) {
      await res.body?.cancel();
      return false;
    }
    await res.body?.cancel();
    return true;
  } catch {
    return false;
  }
}

export { probe as probeStream };

export function clearFallbackCache(songId?: string) {
  if (songId) fallbackCache.delete(songId);
  else fallbackCache.clear();
}

/** 清空全部回退缓存(含可播记忆,供空闲内存回收;下次使用会重新探测)。 */
export function clearStreamFallbackCache(): void {
  fallbackCache.clear();
  playableCache.clear();
}

// songId -> true once we confirmed the original url plays (independent of the
// fallback cache, which only stores fallback hits / misses).
const playableCache = new Set<string>();

function addPlayable(songId: string) {
  playableCache.add(songId);
  if (playableCache.size > PLAYABLE_CACHE_MAX) {
    const oldest = playableCache.values().next().value;
    if (oldest !== undefined) playableCache.delete(oldest);
  }
}

/**
 * Ensure a web song has a streamable URL before casting it to a renderer.
 *   - If the original URL probes OK, returns it (cached per songId).
 *   - Otherwise tries findFallbackStream (multi-source) and, on a hit,
 *     persists the replacement URL back into songs.url so future casts and
 *     /rest/stream proxies use it directly.
 *   - Returns null when no source is playable (caller should skip the track).
 */
export async function ensurePlayableStream(
  song: { id: string; title?: string | null; artist?: string | null; album?: string | null; duration?: number | null; url?: string | null; pluginEntry?: string | null; sourceData?: string | null },
): Promise<string | null> {
  if (!song?.id) return null;
  if (playableCache.has(song.id)) return song.url || null;
  if (fallbackCache.has(song.id)) {
    const cached = fallbackCache.get(song.id)!;
    if (cached) {
      addPlayable(song.id);
      // Persist the previously-discovered replacement URL if the song still
      // carries the failing original (keeps /rest/stream fast on later plays).
      if (song.url && cached !== song.url) updateSongUrl(song.id, cached);
    }
    return cached;
  }

  // Original already missing → nothing to probe.
  if (!song.url) return null;

  if (await probe(song.url)) {
    addPlayable(song.id);
    return song.url;
  }

  // Original fails → try the multi-source fallback.
  let sd: any = null;
  try { sd = JSON.parse(song.sourceData || "{}"); } catch {}
  const fb = await findFallbackStream(
    song.id, song.title || sd?.title || "", song.artist || sd?.artist || "",
    song.album || sd?.album || "", Number(song.duration || sd?.duration || 0),
    defaultStreamProviderId(song.pluginEntry), sd?.source || "",
  );
  if (fb) {
    addPlayable(song.id);
    updateSongUrl(song.id, fb.url);
    return fb.url;
  }
  return null;
}

function updateSongUrl(songId: string, url: string): void {
  try {
    db.update(songs).set({ url }).where(eq(songs.id, songId)).run();
  } catch {}
}