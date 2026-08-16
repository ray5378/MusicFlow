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

export function parseQQSongs(list: any[]): ImportedTrackShape[] {
  return list
    .map((entry: any) => {
      // Toplist responses nest the song under `data`; playlist responses don't.
      const s = entry?.data || entry;
      // externalId 带 "qq:" 前缀(source:平台歌曲 id):rebuildPlaylistEntries 写入
      // external_song_id 后,后台 auto-match 已知 source:id 直通路径可免搜索直接导入。
      return {
        externalId: s.songmid || s.songid ? `qq:${String(s.songmid || s.songid || "")}` : "",
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
  documentation: `### 功能介绍
解析 QQ 音乐的歌单 / 官方榜单分享链接，把曲目（歌名、歌手、专辑、时长）导入 MusicFlow 并建成本地歌单。

### 处理逻辑
1. 核心收到导入请求后，按 \`playlistImport\` 能力遍历已启用插件，逐个调用 \`canHandle(url)\` 认领链接；
2. 本插件用域名正则（\`y.qq.com\` / \`*.qq.com/**playlist**\` 等）认领 QQ 相关链接；
3. 从链接提取歌单 id（\`disstid\`）或榜单 id（\`topid\`），分别调用 \`fetchQQPlaylist\` / \`fetchQQToplist\` 请求 QQ 接口；
4. 把 QQ 返回的歌单信息与曲目数组转换为统一的 \`ImportedPlaylistShape\`，交给核心建歌单、写入曲库。

### 说明
- 无需配置（configSchema 为空），默认启用；
- 链接不被本插件认领（非 QQ 域名）时自动跳过，其他 importer 插件继续尝试；
- 导入后的歌单可开启「自动同步」，由 \`playlist-sync\` 插件定期拉取更新。`,
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
