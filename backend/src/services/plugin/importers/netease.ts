// ==================== NetEase Cloud Music playlist importer plugin ====================

import type { ImportedPlaylistShape, ImportedTrackShape, ImporterPlugin, PluginManifest } from "../../../plugins/types.js";
import { fetchJson } from "./http.js";

export const NETEASE_IMPORTER_ID = "netease-playlist-importer";

export function extractNeteasePlaylistId(url: string): string | null {
  const m = url.match(/[?&]id=(\d+)/) || url.match(/playlist\/(\d+)/);
  return m ? m[1] : null;
}

export async function fetchNeteasePlaylist(id: string): Promise<ImportedPlaylistShape> {
  const data = await fetchJson(`https://music.163.com/api/v6/playlist/detail?id=${id}`);
  const pl = data?.playlist;
  if (!pl) throw new Error("网易云歌单不存在或无法访问");

  const allIds: number[] = (pl.trackIds || []).map((t: any) => Number(t.id)).filter(Boolean);
  const tracks: ImportedTrackShape[] = [];

  // The detail response only embeds ~10 full tracks, but trackIds holds them all —
  // fetch the rest in batches.
  const batchSize = 100;
  for (let i = 0; i < allIds.length; i += batchSize) {
    const batch = allIds.slice(i, i + batchSize);
    const body = JSON.stringify(batch.map((x) => ({ id: x })));
    const songs = await fetchJson(
      `https://music.163.com/api/v3/song/detail?c=${encodeURIComponent(body)}`,
      { Referer: "https://music.163.com/" },
    );
    for (const s of songs?.songs || []) {
      tracks.push({
        externalId: String(s.id || ""),
        title: s.name || "",
        artist: (s.ar || []).map((a: any) => a.name).filter(Boolean).join("/"),
        album: s.al?.name || "",
        duration: s.dt || undefined,
      });
    }
    if (allIds.length > batchSize) await new Promise((r) => setTimeout(r, 300));
  }

  // Fallback: use the tracks embedded in the detail response if the batch fetch failed.
  if (tracks.length === 0) {
    for (const t of pl.tracks || []) {
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

const NETEASE_URL_RE = /163\.com|music\.163\.com|y\.music\.163\.com/i;

export const neteaseImporterManifest: PluginManifest = {
  id: NETEASE_IMPORTER_ID,
  name: "网易云歌单导入",
  version: "1.0.0",
  type: "importer",
  description: "解析网易云音乐歌单分享链接，导入曲目列表",
  capabilities: ["playlistImport"],
  platforms: ["netease"],
  defaultEnabled: true,
  urlPatterns: ["music.163.com/**", "y.music.163.com/**"],
  configSchema: [],
  documentation: `### 功能介绍
解析网易云音乐的歌单分享链接，把曲目（歌名、歌手、专辑、时长）导入 MusicFlow 并建成本地歌单。

### 处理逻辑
1. 核心按 \`playlistImport\` 能力遍历插件，逐个调用 \`canHandle(url)\` 认领链接；
2. 本插件认领 \`music.163.com\` / \`y.music.163.com\` 域名链接；
3. 从链接提取歌单 id，调用 \`fetchNeteasePlaylist\` 请求网易云接口（id 分批查询曲目详情）；
4. 转换为统一的 \`ImportedPlaylistShape\` 交给核心建歌单、写入曲库。

### 说明
- 无需配置，默认启用；
- 非网易域名链接自动跳过，不影响其他 importer 插件；
- 导入后的歌单可开启「自动同步」，由 \`playlist-sync\` 插件定期拉取更新。`,
};

export const neteaseImporter: ImporterPlugin = {
  manifest: neteaseImporterManifest,
  canHandle(url: string): boolean {
    return NETEASE_URL_RE.test(url.trim());
  },
  async fetchPlaylist(url: string): Promise<ImportedPlaylistShape> {
    const id = extractNeteasePlaylistId(url.trim());
    if (!id) throw new Error("无法从链接中识别网易云歌单 ID");
    return fetchNeteasePlaylist(id);
  },
};
