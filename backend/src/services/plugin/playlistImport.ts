// Built-in playlist import plugin: QQ Music + NetEase Cloud Music
// Parses share URLs and fetches the remote playlist track list.

export interface ImportedTrack {
  externalId: string;
  title: string;
  artist: string;
  album?: string;
  duration?: number;
}

export interface ImportedPlaylist {
  name: string;
  platform: "qq" | "netease";
  coverUrl?: string;
  tracks: ImportedTrack[];
}

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36";

async function fetchJson(url: string, headers: Record<string, string> = {}): Promise<any> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20000);
  try {
    const res = await fetch(url, { headers: { "User-Agent": UA, ...headers }, signal: controller.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timeout);
  }
}

// ==================== QQ Music ====================

// Extract playlist id from various QQ music share URL formats
export function extractQQPlaylistId(url: string): string | null {
  const m = url.match(/[?&]id=(\d+)/)
    || url.match(/playlist\/(\d+)/)
    || url.match(/playlist\.html\?[^#]*id=(\d+)/);
  return m ? m[1] : null;
}

// QQ share short links (c6.y.qq.com/base/fcgi-bin/u?__=xxx) redirect to the real page.
// Follow the redirect and return the final URL (or the original if it doesn't redirect).
async function resolveQQShortLink(url: string): Promise<string> {
  if (!/c6\.y\.qq\.com\/base\/fcgi-bin\/u/i.test(url)) return url;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": UA },
      redirect: "follow",
      signal: controller.signal,
    });
    return res.url || url;
  } catch {
    return url;
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchQQPlaylist(id: string): Promise<ImportedPlaylist> {
  const api = "https://c.y.qq.com/qzone/fcg-bin/fcg_ucc_getcdinfo_byids_cp.fcg";
  const params = new URLSearchParams({
    type: "1", json: "1", utf8: "1", onlysong: "0", disstid: id, format: "json",
    g_tk: "5381", loginUin: "0", hostUin: "0", inCharset: "utf8", outCharset: "utf-8",
    notice: "0", platform: "yqq.json", needNewCode: "0",
  });
  const data = await fetchJson(`${api}?${params}`, { Referer: "https://y.qq.com/" });
  const list = data?.cdlist?.[0];
  if (!list) throw new Error("QQ 歌单不存在或无法访问");
  const tracks: ImportedTrack[] = (list.songlist || []).map((s: any) => ({
    externalId: String(s.songmid || s.songid || ""),
    title: s.songname || "",
    artist: (s.singer || []).map((x: any) => x.name).filter(Boolean).join("/"),
    album: s.albumname || "",
    duration: s.interval ? s.interval * 1000 : undefined,
  })).filter((t: any) => t.title);
  return {
    name: list.dissname || `QQ 歌单 ${id}`,
    platform: "qq",
    coverUrl: list.logo || undefined,
    tracks,
  };
}

// ==================== QQ Music Official Toplists ====================

// Extract toplist id from QQ music chart URLs like:
//   https://y.qq.com/n/ryqq/toplist/26
//   https://y.qq.com/wk_toplist/index.html?topid=26
export function extractQQToplistId(url: string): string | null {
  const m = url.match(/[?&]topid=(\d+)/) || url.match(/toplist\/(\d+)/);
  return m ? m[1] : null;
}

// Fetch a QQ Music official chart (巅峰榜/飙升榜/热歌榜 etc.).
// These use a different API endpoint from user playlists (disstid) — the
// toplist endpoint takes a `topid` instead. The song data structure is
// identical, so parsing is shared with fetchQQPlaylist.
async function fetchQQToplist(id: string): Promise<ImportedPlaylist> {
  const api = "https://c.y.qq.com/v8/fcg-bin/fcg_v8_toplist_cp.fcg";
  const params = new URLSearchParams({
    tpl: "3", page: "detail", type: "top", topid: id, format: "json",
  });
  const data = await fetchJson(`${api}?${params}`, { Referer: "https://y.qq.com/" });
  const info = data?.topinfo;
  if (!info) throw new Error("QQ 榜单不存在或无法访问");
  // Song entries in toplist responses are nested under a `data` key.
  const tracks: ImportedTrack[] = (data?.songlist || []).map((entry: any) => {
    const s = entry?.data || entry;
    return {
      externalId: String(s.songmid || s.songid || ""),
      title: s.songname || "",
      artist: (s.singer || []).map((x: any) => x.name).filter(Boolean).join("/"),
      album: s.albumname || "",
      duration: s.interval ? s.interval * 1000 : undefined,
    };
  }).filter((t: any) => t.title);
  return {
    name: info.ListName || `QQ 榜单 ${id}`,
    platform: "qq",
    coverUrl: info.pic_v12 || info.pic || undefined,
    tracks,
  };
}

// ==================== NetEase Cloud Music ====================

export function extractNeteasePlaylistId(url: string): string | null {
  const m = url.match(/[?&]id=(\d+)/) || url.match(/playlist\/(\d+)/);
  return m ? m[1] : null;
}

async function fetchNeteasePlaylist(id: string): Promise<ImportedPlaylist> {
  const data = await fetchJson(`https://music.163.com/api/v6/playlist/detail?id=${id}`);
  const pl = data?.playlist;
  if (!pl) throw new Error("网易云歌单不存在或无法访问");

  const allIds: number[] = (pl.trackIds || []).map((t: any) => Number(t.id)).filter(Boolean);
  const tracks: ImportedTrack[] = [];

  // Fetch full track details in batches (API returns only ~10 tracks in detail, but trackIds has all)
  const batchSize = 100;
  for (let i = 0; i < allIds.length; i += batchSize) {
    const batch = allIds.slice(i, i + batchSize);
    const body = JSON.stringify(batch.map(x => ({ id: x })));
    const songs = await fetchJson(`https://music.163.com/api/v3/song/detail?c=${encodeURIComponent(body)}`, { Referer: "https://music.163.com/" });
    for (const s of (songs?.songs || [])) {
      tracks.push({
        externalId: String(s.id || ""),
        title: s.name || "",
        artist: (s.ar || []).map((a: any) => a.name).filter(Boolean).join("/"),
        album: s.al?.name || "",
        duration: s.dt || undefined,
      });
    }
    if (allIds.length > batchSize) await new Promise(r => setTimeout(r, 300));
  }

  // Fallback: use the tracks embedded in the detail response if batch fetch failed
  if (tracks.length === 0) {
    for (const t of (pl.tracks || [])) {
      tracks.push({
        externalId: String(t.id || ""),
        title: t.name || "",
        artist: (t.ar || []).map((a: any) => a.name).filter(Boolean).join("/"),
        album: t.al?.name || "",
        duration: t.dt || undefined,
      });
    }
  }

  return {
    name: pl.name || `网易云歌单 ${id}`,
    platform: "netease",
    coverUrl: pl.coverImgUrl || undefined,
    tracks,
  };
}

// ==================== Entry ====================

// Auto-detect platform from share URL and fetch the playlist
export async function importPlaylistFromUrl(url: string): Promise<ImportedPlaylist> {
  const trimmed = url.trim();
  if (/y\.qq\.com|i2\.y\.qq\.com|c\.y\.qq\.com|qq\.com.*playlist/i.test(trimmed)) {
    // QQ short links (c6.y.qq.com/base/fcgi-bin/u?__=xxx) need a redirect to reveal the playlist id
    const resolved = await resolveQQShortLink(trimmed);
    // Official toplists (https://y.qq.com/n/ryqq/toplist/<id>) use a separate API.
    const topid = extractQQToplistId(resolved);
    if (topid) return fetchQQToplist(topid);
    // Regular user/editorial playlists use the disstid API.
    const id = extractQQPlaylistId(resolved);
    if (!id) throw new Error("无法从链接中识别 QQ 歌单 ID");
    return fetchQQPlaylist(id);
  }
  if (/163\.com|music\.163\.com|y\.music\.163\.com/i.test(trimmed)) {
    const id = extractNeteasePlaylistId(trimmed);
    if (!id) throw new Error("无法从链接中识别网易云歌单 ID");
    return fetchNeteasePlaylist(id);
  }
  throw new Error("不支持的音乐平台链接,支持 QQ 音乐和网易云音乐歌单");
}
