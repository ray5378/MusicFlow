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

// Search result ordering: prefer platforms that resolve reliably.
const SOURCE_PREFERENCE = ["netease", "kuwo", "kugou", "qq"];

// songId -> working stream URL (or null once we know there's no alternative).
const fallbackCache = new Map<string, string | null>();

export async function findFallbackStream(
  songId: string,
  title: string,
  artist: string,
  album: string,
  providerId: string,
  failingSource: string,
): Promise<{ url: string; source: string } | null> {
  if (fallbackCache.has(songId)) {
    const cached = fallbackCache.get(songId)!;
    if (cached) return { url: cached, source: "" };
    return null;
  }
  if (!title) { fallbackCache.set(songId, null); return null; }

  const configured = getConfiguredProvider(providerId);
  if (!configured?.provider.search) { fallbackCache.set(songId, null); return null; }

  const query = [title, artist].filter(Boolean).join(" ");
  let results: OnlineSongResult[];
  try {
    const r = await configured.provider.search(configured.config, { query });
    results = r.songs || [];
  } catch {
    fallbackCache.set(songId, null);
    return null;
  }

  // Rank results: must match title (exact or contained) and not be the failing source.
  const ranked = results
    .filter(s => s.source !== failingSource && s.name && normalize(s.name) === normalize(title))
    .sort((a, b) => {
      const ar = SOURCE_PREFERENCE.indexOf(a.source);
      const br = SOURCE_PREFERENCE.indexOf(b.source);
      return (ar === -1 ? 99 : ar) - (br === -1 ? 99 : br);
    });

  for (const cand of ranked) {
    const url = configured.provider.streamUrl(configured.config, cand);
    if (await probe(url)) {
      fallbackCache.set(songId, url);
      return { url, source: cand.source };
    }
  }

  fallbackCache.set(songId, null);
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

function normalize(s: string): string {
  return s.toLowerCase().replace(/[（(].*?[)）]/g, "").replace(/[\s·\-:_~]+/g, "").trim();
}

export function clearFallbackCache(songId?: string) {
  if (songId) fallbackCache.delete(songId);
  else fallbackCache.clear();
}