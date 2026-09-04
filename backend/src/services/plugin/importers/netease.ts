// ==================== NetEase Cloud Music playlist importer plugin ====================

import type { ImportedPlaylistShape, ImportedTrackShape, ImporterPlugin, PluginManifest } from "../../../plugins/types.js";
import { fetchJson } from "./http.js";

export const NETEASE_IMPORTER_ID = "netease-playlist-importer";

export function extractNeteasePlaylistId(url: string): string | null {
  const m = url.match(/[?&]id=(\d+)/) || url.match(/playlist\/(\d+)/);
  return m ? m[1] : null;
}

/**
 * 把网易云单曲原始对象转成导入曲目。
 *
 * externalId 形如 "netease:123456"(source:平台歌曲 id):rebuildPlaylistEntries 会把
 * 它写进 playlist_songs.external_song_id,后台 auto-match 的已知 source:id 直通路径
 * (onlineSongFromExternalId)据此免在线搜索直接导入。修复前这里只存裸 id,
 * 每日推荐里未匹配曲目 605 首只能逐曲重搜(见 P0 监控)。纯函数,便于单测。
 */
export function buildNeteaseTrack(s: any): ImportedTrackShape {
  return {
    externalId: s && s.id ? `netease:${String(s.id)}` : "",
    title: s?.name || "",
    artist: (s?.ar || []).map((a: any) => a.name).filter(Boolean).join("/"),
    album: s?.al?.name || "",
    duration: s?.dt || undefined,
  };
}

export async function fetchNeteasePlaylist(id: string): Promise<ImportedPlaylistShape> {
  const data = await fetchJson(`https://music.163.com/api/v6/playlist/detail?id=${id}`);
  const pl = data?.playlist;
  if (!pl) throw new Error("网易云歌单不存在或无法访问");

  const allIds: number[] = (pl.trackIds || []).map((t: any) => Number(t.id)).filter(Boolean);
  const tracks: ImportedTrackShape[] = [];

  // The detail response only embeds ~10 full tracks, but trackIds holds them all —
  // fetch the rest in batches. 分批小并发拉取(替代串行+每批固定 300ms):大歌单的
  // 网络等待被摊到 3 条 worker 上,显著降导入耗时;每批保留少量节流防网易限流。
  const batchSize = 100;
  const batches: number[][] = [];
  for (let i = 0; i < allIds.length; i += batchSize) {
    batches.push(allIds.slice(i, i + batchSize));
  }
  const CONCURRENCY = 3;
  let di = 0;
  async function fetchBatchWorker(): Promise<void> {
    // di++/tracks.push 都是同步原子操作,单事件循环下 worker 间无竞态。
    while (di < batches.length) {
      const batch = batches[di++];
      try {
        const body = JSON.stringify(batch.map((x) => ({ id: x })));
        const songs = await fetchJson(
          `https://music.163.com/api/v3/song/detail?c=${encodeURIComponent(body)}`,
          { Referer: "https://music.163.com/" },
        );
        for (const s of songs?.songs || []) {
          tracks.push(buildNeteaseTrack(s));
        }
      } catch {
        // 单批失败不影响其余批:空批稍后由 fallback(embedded tracks)兜底。
      }
      // 仅多批时才节流;多数曲目都嵌在首响应里时无需额外等待。
      if (batches.length > 1) await new Promise((r) => setTimeout(r, 120));
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, batches.length) }, fetchBatchWorker));

  // Fallback: use the tracks embedded in the detail response if the batch fetch failed.
  if (tracks.length === 0) {
    for (const t of pl.tracks || []) {
      tracks.push(buildNeteaseTrack(t));
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
  // 插件侧 i18n 字典:默认文案即中文,故 zh 省略、只补 en。前端按当前界面语言取用。
  i18n: {
    en: {
      name: "NetEase Cloud Playlist Importer",
      description:
        "Parse NetEase Cloud Music playlist share links and import the track list",
      fields: {
        scheduleEnabled: {
          label: "Participate in daily scheduled sync",
          help: "When off, the scheduled daily sync skips this plugin (manual refresh still works).",
        },
        runOnBoot: {
          label: "Run once on container startup",
          help: "When on, MusicFlow runs this plugin's playlist once on every startup/restart to keep it fresh.",
        },
        batchParallel: {
          label: "Allow parallel execution",
          help: "Off (default): this plugin's scheduled/batch jobs always run serially in the global queue; On: allowed to run in parallel with other plugins that enable this switch (uses more CPU but is faster).",
        },
      },
    },
  },
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
