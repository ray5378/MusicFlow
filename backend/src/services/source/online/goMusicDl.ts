// ==================== go-music-dl Online Provider ====================
//
// Bridges MusicFlow to a self-hosted go-music-dl web service (the user's
// Docker deployment). go-music-dl's /music/* search endpoint returns an HTML
// page where every result is a <li class="song-card" data-*="...">; we parse
// those structured attributes instead of relying on the backend's HTML.
//
// Streaming: we reuse go-music-dl's /music/download?stream=1 which is a raw
// audio proxy that honours Range requests — matching /rest/stream's needs.

import { OnlineProvider, OnlineSongResult, OnlineRecommendChannel, OnlinePlaylistInfo, registerOnlineProvider } from "./types.js";

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

/** Parse the per-channel playlist tabs + cards out of /music/recommend HTML. */
export function parseRecommendPlaylists(html: string): OnlineRecommendChannel[] {
  const channels: OnlineRecommendChannel[] = [];

  // Each channel is a <button class="category-source-tab" data-target="...recommend-<src>"
  // containing <span class="category-source-tab-name">Name</span> and
  // <span class="category-source-tab-count">N</span>.
  const tabRe = /<button[^>]*class="category-source-tab[^"]*"[^>]*data-target="([^"]*recommend-([a-z]+))"[^>]*>([\s\S]*?)<\/button>/g;
  let tm: RegExpExecArray | null;
  while ((tm = tabRe.exec(html)) !== null) {
    const source = tm[2].toLowerCase();
    const inner = tm[3];
    const nameM = /category-source-tab-name"[^>]*>\s*([^<]+?)\s*</.exec(inner);
    const countM = /category-source-tab-count"[^>]*>\s*(\d+)\s*</.exec(inner);
    channels.push({
      source,
      name: nameM ? decodeAttr(nameM[1]) : source,
      count: countM ? parseInt(countM[1], 10) || 0 : 0,
      playlists: [],
    });
  }

  // Playlist cards: <div class="playlist-card" onclick="navigateTo('/music/playlist?source=..&id=..&name=..&creator=..&cover=..&track_count=..&link=..')">
  const cardRe = /<div\s+class="playlist-card"[^>]*onclick="navigateTo\(\s*['"](.*?)['"]\s*\)"/g;
  let cm: RegExpExecArray | null;
  while ((cm = cardRe.exec(html)) !== null) {
    let path = decodeAttr(cm[1]).replace(/\\\//g, "/").replace(/\\u0026/gi, "&");
    if (!path.startsWith("/music/playlist")) continue;
    const p = path.split("?")[1] || "";
    if (!p) continue;
    const params = new URLSearchParams(p);
    const source = params.get("source") || "";
    const id = params.get("id") || "";
    if (!source || !id) continue;
    const info: OnlinePlaylistInfo = {
      id,
      source,
      name: params.get("name") || "",
      creator: params.get("creator") || "",
      cover: params.get("cover") || "",
      trackCount: params.get("track_count") || "",
      link: params.get("link") || "",
    };
    const ch = channels.find(c => c.source === source) || channels.find(c => c.source.toLowerCase() === source.toLowerCase());
    if (ch) ch.playlists.push(info);
    else channels.push({ source, name: source, count: 0, playlists: [info] });
  }
  return channels;
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

  async recommend(config) {
    const url = `${baseUrl(config)}/music/recommend`;
    const res = await fetch(url, { signal: AbortSignal.timeout(20000) });
    if (!res.ok) throw new Error(`go-music-dl 获取推荐歌单失败: HTTP ${res.status}`);
    const html = await res.text();
    return { channels: parseRecommendPlaylists(html) };
  },

  async playlistSongs(config, source, id) {
    const base = baseUrl(config);
    // go-music-dl paginates song-card rendering server-side (page_size capped at 500).
    const totalRe = /data-total-count="(\d+)"/;
    let page = 1;
    let total = 0;
    const all: OnlineSongResult[] = [];
    do {
      const qs = new URLSearchParams({ source, id, page: String(page), page_size: "500" });
      const res = await fetch(`${base}/music/playlist?${qs.toString()}`, { signal: AbortSignal.timeout(30000) });
      if (!res.ok) throw new Error(`go-music-dl 获取歌单详情失败: HTTP ${res.status}`);
      const html = await res.text();
      if (page === 1) {
        const m = totalRe.exec(html);
        if (m) total = parseInt(m[1], 10) || 0;
      }
      all.push(...parseSongCards(html));
      page++;
    } while (total > 0 && all.length < total && page <= 50); // hard cap pages
    return { songs: all, name: "" };
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