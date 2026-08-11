import { db } from "../db/index.js";
import { songs, mediaSources } from "../db/schema.js";
import { eq } from "drizzle-orm";
import { getPluginImpl, getPluginConfig } from "../plugins/registry.js";
import { searchLyrics } from "../plugins/providers.js";

export interface LrcLine {
  time: number; // seconds
  text: string;
}

// Parse standard LRC content into timed lines
// Handles metadata tags ([ti:...], [ar:...], [al:...], [by:...], [offset:...]) and
// multiple timestamps per line, e.g. [00:10.00][00:20.00]text
export function parseLrc(content: string): LrcLine[] {
  const lines: LrcLine[] = [];
  const timeRegex = /\[(\d{1,2}):(\d{1,2})(?:[.:](\d{1,3}))?\]/g;
  const metaRegex = /^\[(ti|ar|al|by|offset|length|re|ve|au|la):/i;
  for (const rawLine of content.split(/\r?\n/)) {
    const trimmed = rawLine.trim();
    if (!trimmed) continue;
    const matches = [...trimmed.matchAll(timeRegex)];
    if (matches.length === 0) {
      // Metadata line without timestamps -> skip
      if (metaRegex.test(trimmed)) continue;
      continue;
    }
    // Text = line with all [mm:ss.xx] timestamps removed
    const text = trimmed.replace(timeRegex, "").trim();
    if (!text) continue;
    for (const m of matches) {
      const min = parseInt(m[1]);
      const sec = parseInt(m[2]);
      const frac = m[3] ? parseInt(m[3].padEnd(3, "0")) / 1000 : 0;
      lines.push({ time: min * 60 + sec + frac, text });
    }
  }
  return lines.sort((a, b) => a.time - b.time);
}

// Build OpenSubsonic structuredLyrics from LRC lines
// OpenSubsonic spec: Line.start is in MILLISECONDS (integer)
export function lrcToStructured(lines: LrcLine[], lang: string = "und") {
  return {
    lang,
    synced: true,
    line: lines.map(l => ({ start: Math.round(l.time * 1000), value: l.text })),
  };
}

interface SongRow {
  id: string;
  path: string;
  title: string;
  artist: string | null;
  url?: string | null;
  type?: string | null;
  duration?: number | null;
  pluginEntry?: string | null;
}

const lrcCache = new Map<string, { content: string | null; at: number }>();
const CACHE_TTL = 10 * 60 * 1000; // 10 min

// Periodically evict expired entries so the in-memory cache doesn't grow
// unbounded (the TTL above is otherwise only enforced lazily on read).
const lrcCacheSweep = setInterval(() => {
  const now = Date.now();
  for (const [k, v] of lrcCache) {
    if (now - v.at >= CACHE_TTL) lrcCache.delete(k);
  }
}, 5 * 60 * 1000);
// Don't keep the process alive just for cache sweeping.
(lrcCacheSweep as any).unref?.();

// Fetch the .lrc file next to a song (WebDAV or local)
export async function fetchLrcForSong(song: SongRow): Promise<string | null> {
  const cached = lrcCache.get(song.id);
  if (cached && Date.now() - cached.at < CACHE_TTL) return cached.content;

  let content: string | null = null;

  // Online (web) songs: try the unified lyric-provider registry FIRST
  // (first-match-wins across enabled lyricProvider plugins, e.g. the
  // go-music-dl-lyrics plugin). Then fall back to the legacy source plugin
  // lyricUrl() for any source that still implements it directly.
  if (song.type === "web") {
    const fromProviders = await searchLyrics({
      url: song.url,
      duration: song.duration,
      title: song.title,
      artist: song.artist,
    });
    if (fromProviders) {
      lrcCache.set(song.id, { content: fromProviders, at: Date.now() });
      return fromProviders;
    }
  }

  // Online (web) songs: delegate lyric-URL derivation to the source plugin so
  // provider-specific URL logic (e.g. go-music-dl's /music/download_lrc) lives
  // with the plugin, not the core. The LRC is fetched in-memory and never
  // written to disk.
  if (song.type === "web" && song.pluginEntry) {
    const impl = getPluginImpl(song.pluginEntry);
    if (impl?.lyricUrl) {
      const cfg = getPluginConfig(song.pluginEntry) || {};
      const lrcUrl = impl.lyricUrl(cfg, {
        url: song.url,
        duration: song.duration,
        title: song.title,
        artist: song.artist,
      });
      if (lrcUrl) {
        try {
          const controller = new AbortController();
          const timeout = setTimeout(() => controller.abort(), 8000);
          const res = await fetch(lrcUrl, { signal: controller.signal });
          clearTimeout(timeout);
          if (res.ok) {
            const text = await res.text();
            if (text && !text.startsWith("Lyric not found")) content = text;
          }
        } catch { content = null; }
        lrcCache.set(song.id, { content, at: Date.now() });
        return content;
      }
    }
  }

  try {
    const colon1 = song.path.indexOf(":");
    const prefix = song.path.slice(0, colon1);
    const rest = song.path.slice(colon1 + 1);
    const colon2 = rest.indexOf(":");
    const sourceId = rest.slice(0, colon2);
    const filePath = rest.slice(colon2 + 1);
    const lrcPath = filePath.replace(/\.[^.]+$/, "") + ".lrc";

    const source = db.select().from(mediaSources).where(eq(mediaSources.id, sourceId)).get();
    if (!source) { lrcCache.set(song.id, { content: null, at: Date.now() }); return null; }
    const config = JSON.parse(source.config || "{}");

    if (prefix === "w") {
      const base = config.url?.replace(/\/+$/, "");
      if (!base) { lrcCache.set(song.id, { content: null, at: Date.now() }); return null; }
      const url = new URL(base).origin + lrcPath;
      const headers: Record<string, string> = { Range: "bytes=0-65535" };
      if (config.username && config.password) {
        headers["Authorization"] = "Basic " + Buffer.from(`${config.username}:${config.password}`).toString("base64");
      }
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 8000);
      const res = await fetch(url, { headers, signal: controller.signal });
      clearTimeout(timeout);
      if (res.ok || res.status === 206) content = await res.text();
    } else if (prefix === "l") {
      const fs = await import("fs");
      if (fs.existsSync(lrcPath)) content = fs.readFileSync(lrcPath, "utf8");
    }
  } catch { content = null; }

  lrcCache.set(song.id, { content, at: Date.now() });
  return content;
}

// Get parsed lyrics for a song id (null if none)
export async function getLyricsForSongId(songId: string): Promise<LrcLine[] | null> {
  const song = db.select().from(songs).where(eq(songs.id, songId)).get();
  if (!song) return null;
  const content = await fetchLrcForSong(song);
  if (!content) return null;
  const lines = parseLrc(content);
  return lines.length > 0 ? lines : null;
}
