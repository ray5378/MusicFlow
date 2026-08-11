// ==================== QQ Music playlist importer plugin ====================
//
// A self-contained `importer` plugin: it declares which share URLs it can handle
// and knows how to turn them into a track list. The core never calls into this
// module directly — it looks up enabled plugins with the "playlistImport"
// capability and asks each one `canHandle(url)`.

import type { ImportedPlaylistShape, ImportedTrackShape, ImporterPlugin, PluginManifest } from "../../../plugins/types.js";
import { fetchJson, resolveRedirect } from "./http.js";

export const QQ_IMPORTER_ID = "qq-playlist-importer";

// ---------- URL parsing ----------

/** Extract playlist id from the various QQ Music share URL formats. */
export function extractQQPlaylistId(url: string): string | null {
  const m = url.match(/[?&]id=(\d+)/)
    || url.match(/playlist\/(\d+)/)
    || url.match(/playlist\.html\?[^#]*id=(\d+)/);
  return m ? m[1] : null;
}

/** Extract toplist id from QQ Music chart URLs like:
 *    https://y.qq.com/n/ryqq/toplist/26
 *    https://y.qq.com/wk_toplist/index.html?topid=26 */
export function extractQQToplistId(url: string): string | null {
  const m = url.match(/[?&]topid=(\d+)/) || url.match(/toplist\/(\d+)/);
  return m ? m[1] : null;
}

/** Share short links (c6.y.qq.com/base/fcgi-bin/u?__=xxx) redirect to the real
 *  page — follow them so the playlist id becomes visible. */
async function resolveQQShortLink(url: string): Promise<string> {
  if (!/c6\.y\.qq\.com\/base\/fcgi-bin\/u/i.test(url)) return url;
  return resolveRedirect(url);
}

// ---------- Fetchers ----------

function parseQQSongs(list: any[]): ImportedTrackShape[] {
  return list
    .map((entry: any) => {
      // Toplist responses nest the song under `data`; playlist responses don't.
      const s = entry?.data || entry;
      return {
        externalId: String(s.songmid || s.songid || ""),
        title: s.songname || "",
        artist: (s.singer || []).map((x: any) => x.name).filter(Boolean).join("/"),
        album: s.albumname || "",
        duration: s.interval ? s.interval * 1000 : undefined,
      };
    })
    .filter((t: ImportedTrackShape) => !!t.title);
}

/** User / editorial playlists (disstid API). */
export async function fetchQQPlaylist(id: string): Promise<ImportedPlaylistShape> {
  const api = "https://c.y.qq.com/qzone/fcg-bin/fcg_ucc_getcdinfo_byids_cp.fcg";
  const params = new URLSearchParams({
    type: "1", json: "1", utf8: "1", onlysong: "0", disstid: id, format: "json",
    g_tk: "5381", loginUin: "0", hostUin: "0", inCharset: "utf8", outCharset: "utf-8",
    notice: "0", platform: "yqq.json", needNewCode: "0",
  });
  const data = await fetchJson(`${api}?${params}`, { Referer: "https://y.qq.com/" });
  const list = data?.cdlist?.[0];
  if (!list) throw new Error("QQ 歌单不存在或无法访问");
  return {
    name: list.dissname || `QQ 歌单 ${id}`,
    platform: "qq",
    coverUrl: list.logo || undefined,
    tracks: parseQQSongs(list.songlist || []),
  };
}

/** Official charts (巅峰榜/飙升榜/热歌榜 …) use a separate `topid` endpoint. */
export async function fetchQQToplist(id: string): Promise<ImportedPlaylistShape> {
  const api = "https://c.y.qq.com/v8/fcg-bin/fcg_v8_toplist_cp.fcg";
  const params = new URLSearchParams({
    tpl: "3", page: "detail", type: "top", topid: id, format: "json",
  });
  const data = await fetchJson(`${api}?${params}`, { Referer: "https://y.qq.com/" });
  const info = data?.topinfo;
  if (!info) throw new Error("QQ 榜单不存在或无法访问");
  return {
    name: info.ListName || `QQ 榜单 ${id}`,
    platform: "qq",
    coverUrl: info.pic_v12 || info.pic || undefined,
    tracks: parseQQSongs(data?.songlist || []),
  };
}

// ---------- Plugin ----------

const QQ_URL_RE = /y\.qq\.com|i2\.y\.qq\.com|c\.y\.qq\.com|qq\.com.*playlist/i;

export const qqImporterManifest: PluginManifest = {
  id: QQ_IMPORTER_ID,
  name: "QQ 音乐歌单导入",
  version: "1.0.0",
  type: "importer",
  description: "解析 QQ 音乐歌单 / 官方榜单分享链接，导入曲目列表",
  capabilities: ["playlistImport"],
  platforms: ["qq"],
  defaultEnabled: true,
  urlPatterns: ["y.qq.com/**", "c6.y.qq.com/base/fcgi-bin/u?**", "*.qq.com/**playlist**"],
  configSchema: [],
};

export const qqImporter: ImporterPlugin = {
  manifest: qqImporterManifest,
  canHandle(url: string): boolean {
    return QQ_URL_RE.test(url.trim());
  },
  async fetchPlaylist(url: string): Promise<ImportedPlaylistShape> {
    const resolved = await resolveQQShortLink(url.trim());
    const topid = extractQQToplistId(resolved);
    if (topid) return fetchQQToplist(topid);
    const id = extractQQPlaylistId(resolved);
    if (!id) throw new Error("无法从链接中识别 QQ 歌单 ID");
    return fetchQQPlaylist(id);
  },
};
