import { db, sqlite } from "../db/index.js";
import { songs, mediaSources } from "../db/schema.js";
import { eq } from "drizzle-orm";
import { getPluginImpl, getPluginConfig } from "../plugins/registry.js";
import { hasLyricProvider, searchLyrics } from "../plugins/providers.js";
import { getSettingBool } from "./settings.js";
import { saveLyricFile, resolveLyricContent } from "./lyricsStore.js";

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
  album?: string | null;
  url?: string | null;
  type?: string | null;
  duration?: number | null;
  pluginEntry?: string | null;
  sourceData?: string | null;
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

// 读取 sidecar .lrc(本地文件 / WebDAV 同目录 URL)。离线优先、最准;
// web 歌曲 path 不是 w:/l: 前缀,直接返回 null。
async function readSidecarLrc(song: SongRow): Promise<string | null> {
  try {
    const colon1 = song.path.indexOf(":");
    if (colon1 < 0) return null;
    const prefix = song.path.slice(0, colon1);
    if (prefix !== "w" && prefix !== "l") return null;
    const rest = song.path.slice(colon1 + 1);
    const colon2 = rest.indexOf(":");
    if (colon2 < 0) return null;
    const sourceId = rest.slice(0, colon2);
    const filePath = rest.slice(colon2 + 1);
    const lrcPath = filePath.replace(/\.[^.]+$/, "") + ".lrc";

    const source = db.select().from(mediaSources).where(eq(mediaSources.id, sourceId)).get();
    if (!source) return null;
    const config = JSON.parse(source.config || "{}");

    if (prefix === "w") {
      const base = config.url?.replace(/\/+$/, "");
      if (!base) return null;
      const url = new URL(base).origin + lrcPath;
      const headers: Record<string, string> = { Range: "bytes=0-65535" };
      if (config.username && config.password) {
        headers["Authorization"] = "Basic " + Buffer.from(`${config.username}:${config.password}`).toString("base64");
      }
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 8000);
      try {
        const res = await fetch(url, { headers, signal: controller.signal });
        if (res.ok || res.status === 206) return await res.text();
      } finally { clearTimeout(timeout); }
    } else if (prefix === "l") {
      const fs = await import("fs");
      if (fs.existsSync(lrcPath)) return fs.readFileSync(lrcPath, "utf8");
    }
  } catch { /* 任何失败都当作无 sidecar */ }
  return null;
}

// Fetch lyrics for a song, unified across ALL song types:
//   ① 已落库歌词(songs.lyrics 存文件引用或旧文本,离线可用)
//   ② sidecar .lrc(本地 / WebDAV)
//   ③ 在线按需(A 开关,默认开):lyricProvider 插件,命中且 B(persist) 开则落库为文件
//   ④ web 歌曲 legacy 源插件 lyricUrl
export async function fetchLrcForSong(song: SongRow): Promise<string | null> {
  const cached = lrcCache.get(song.id);
  if (cached && Date.now() - cached.at < CACHE_TTL) return cached.content;

  let content: string | null = null;

  // ① 已落库的歌词:优先读 online-lyrics/<ref>.lrc 文件(新格式),文件缺失时
  //    把列内旧文本当歌词(v1.7.4 兼容)。离线也能显示,不依赖 provider 常驻。
  try {
    const row = sqlite.prepare("SELECT lyrics FROM songs WHERE id = ?").get(song.id) as any;
    if (row?.lyrics) content = resolveLyricContent(row.lyrics);
  } catch { /* ignore */ }

  // ② sidecar .lrc(离线优先、最准)
  if (!content) content = await readSidecarLrc(song);

  // ③ 在线按需(A 开关):sidecar/落库都没有时,问 lyricProvider 插件
  if (!content && getSettingBool("lyrics.onDemand", true) && hasLyricProvider()) {
    // 把 source/album/extra 一并传给 lyric provider:插件据此优先同平台回退
    // (go-music-dl 的搜索回退需要 source 判断"本平台优先",否则只能盲目多平台搜索)。
    let sourceData: any = null;
    try { sourceData = JSON.parse((song as any).sourceData || "{}"); } catch {}
    const fromProviders = await searchLyrics({
      url: song.url,
      duration: song.duration,
      title: song.title,
      artist: song.artist,
      album: song.album,
      source: sourceData?.source || undefined,
      extra: sourceData?.extra || null,
    });
    if (fromProviders) {
      content = fromProviders;
      // B 落库(默认关):命中即写 online-lyrics/<id>.lrc 文件 + songs.lyrics 存引用,
      // 拉一次永存、离线也能显示(与封面 online-covers 同构,可单独挂卷/清空)。
      if (getSettingBool("lyrics.persist", false)) {
        const ref = saveLyricFile(song.id, content);
        if (ref) {
          try { sqlite.prepare("UPDATE songs SET lyrics = ? WHERE id = ?").run(ref, song.id); } catch { /* ignore */ }
        }
      }
    }
  }

  // ④ web 歌曲 legacy 源插件 lyricUrl(仅当上面都没有):provider 特定 URL 逻辑
  //    (如 go-music-dl 的 /music/download_lrc)留在插件侧,核心不重复实现。
  if (!content && song.type === "web" && song.pluginEntry) {
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
      }
    }
  }

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
