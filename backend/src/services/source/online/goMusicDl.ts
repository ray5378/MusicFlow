// ==================== go-music-dl Online Provider ====================
//
// Bridges MusicFlow to a self-hosted go-music-dl web service (the user's
// Docker deployment). go-music-dl's /music/* search endpoint returns an HTML
// page where every result is a <li class="song-card" data-*="...">; we parse
// those structured attributes instead of relying on the backend's HTML.
//
// Streaming: we reuse go-music-dl's /music/download?stream=1 which is a raw
// audio proxy that honours Range requests — matching /rest/stream's needs.

import { OnlineProvider, OnlineSongResult, registerOnlineProvider } from "./types.js";

function baseUrl(config: Record<string, any>): string {
  return String(config?.baseUrl || "").replace(/\/+$/, "");
}

function decodeAttr(v: string): string {
  // The backend HTML-escapes attribute values (&#34; etc.) — restore them.
  return v
    .replace(/&#34;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .trim();
}

function parseSongExtra(raw: string | null | undefined): Record<string, string> | null {
  if (!raw) return null;
  const cleaned = raw.replace(/&#34;/g, '"').replace(/&#39;/g, "'");
  try {
    const direct = JSON.parse(cleaned);
    if (direct && typeof direct === "object") return direct as Record<string, string>;
  } catch {
    // fall through to generic dict parse
  }
  const generic: Record<string, any> = {};
  for (const m of cleaned.matchAll(/"([^"]+)"\s*:\s*"([^"]*)"/g)) {
    generic[m[1]] = m[2];
  }
  return Object.keys(generic).length ? generic : null;
}

/** Parse the song cards out of a go-music-dl search HTML page. */
export function parseSongCards(html: string): OnlineSongResult[] {
  const songs: OnlineSongResult[] = [];
  // Each song is a <li class="song-card" data-id=... data-source=... ...>
  const itemRe = /<li\s+class="song-card"([\s\S]*?)<\/li>/g;
  let m: RegExpExecArray | null;
  while ((m = itemRe.exec(html)) !== null) {
    const block = m[1];
    const attr = (name: string) => {
      // go-music-dl HTML uses double quotes for most data-* attrs but single
      // quotes for data-extra='{"...":"..."}' (it embeds a JSON object).
      const re = new RegExp(`data-${name}=(["'])(.*?)\\1`, "i");
      const a = re.exec(block);
      return a ? a[2] : "";
    };
    const id = decodeAttr(attr("id"));
    if (!id) continue;
    songs.push({
      id,
      source: decodeAttr(attr("source")),
      name: decodeAttr(attr("name")),
      artist: decodeAttr(attr("artist")),
      album: decodeAttr(attr("album")),
      duration: parseInt(attr("duration"), 10) || 0,
      cover: decodeAttr(attr("cover")),
      extra: parseSongExtra(attr("extra")),
      sortSize: decodeAttr(attr("sort-size")),
      sortBitrate: decodeAttr(attr("sort-bitrate")),
    });
  }
  return songs;
}

const PROVIDER_ID = "go-music-dl";

const goMusicDlProvider: OnlineProvider = {
  id: PROVIDER_ID,
  name: "go-music-dl 全网聚合",
  async test(config) {
    const url = baseUrl(config);
    if (!url) return { success: false, message: "未配置 go-music-dl 地址" };
    try {
      const res = await fetch(`${url}/music/?type=song&sources=netease`, { method: "GET", signal: AbortSignal.timeout(8000) });
      if (!res.ok) return { success: false, message: `HTTP ${res.status}` };
      const html = await res.text();
      if (!html.includes("music-dl") && !html.includes("聚合搜索")) {
        return { success: false, message: "响应不是 go-music-dl 页面(地址可能指向了其他服务)" };
      }
      return { success: true, message: "连接成功" };
    } catch (e: any) {
      return { success: false, message: e.message || "连接失败" };
    }
  },

  async search(config, params) {
    const url = `${baseUrl(config)}/music/search`;
    const qs = new URLSearchParams({ q: params.query, type: "song" });
    for (const s of params.sources || []) qs.append("sources", s);
    const res = await fetch(`${url}?${qs.toString()}`, { signal: AbortSignal.timeout(15000) });
    if (!res.ok) throw new Error(`go-music-dl 搜索失败: HTTP ${res.status}`);
    const html = await res.text();
    return { songs: parseSongCards(html) };
  },

  streamUrl(config, song, range) {
    const qs = new URLSearchParams({
      id: song.id,
      source: song.source,
      name: song.name || "Unknown",
      artist: song.artist || "Unknown",
      stream: "1",
    });
    if (song.album) qs.set("album", song.album);
    if (song.cover) qs.set("cover", song.cover);
    if (song.extra) qs.set("extra", JSON.stringify(song.extra));
    if (range) qs.set("range", range);
    return `${baseUrl(config)}/music/download?${qs.toString()}`;
  },
};

export const GO_MUSIC_DL_PROVIDER_ID = PROVIDER_ID;

export function initOnlineProviders() {
  registerOnlineProvider(goMusicDlProvider);
}