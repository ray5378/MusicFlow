// ==================== go-music-dl cover provider ====================
//
// A `coverProvider` plugin: fills in cover art for songs that lack one. This
// is brand-new capability in V2 (previously covers only came from the source
// search result or local scan). First-match-wins across all enabled cover
// providers; a NetEase/QQ cover plugin could be added the same way.
//
// Strategy:
//   1. If the song is a go-music-dl web song, reuse its `cover` URL param.
//   2. Otherwise search go-music-dl by title+artist and take the first cover.

import { getPluginConfig } from "../../../plugins/registry.js";
import { parseSongCards } from "../../source/online/goMusicDl.js";
import type { CoverProviderPlugin, LyricSongInput, PluginManifest } from "../../../plugins/types.js";

function baseUrlOf(config: Record<string, any> | null): string {
  return String(config?.baseUrl || "").replace(/\/+$/, "");
}

export const GO_MUSIC_DL_COVER_ID = "go-music-dl-cover";

export const goMusicDlCoverManifest: PluginManifest = {
  id: GO_MUSIC_DL_COVER_ID,
  name: "go-music-dl 封面",
  version: "1.0.0",
  type: "cover",
  description: "通过 go-music-dl 服务为缺少封面的歌曲补全封面;baseUrl 留空则复用「go-music-dl 全网聚合」在线源配置",
  capabilities: ["coverProvider"],
  permissions: ["net", "log"],
  defaultEnabled: true,
  configSchema: [
    { key: "baseUrl", label: "服务地址", type: "url", help: "留空则复用「go-music-dl 全网聚合」在线源的配置" },
  ],
};

export const goMusicDlCoverPlugin: CoverProviderPlugin = {
  manifest: goMusicDlCoverManifest,
  async searchCover(_host, song: LyricSongInput) {
    let base = baseUrlOf(_host.config);
    if (!base) {
      const g = getPluginConfig("go-music-dl");
      base = baseUrlOf(g);
    }
    if (!base) return null;

    // 1) go-music-dl web song → reuse its cover param.
    if (song.url && song.url.includes("/music/download")) {
      try {
        const u = new URL(song.url);
        const c = u.searchParams.get("cover");
        if (c) return { url: c };
      } catch { /* fall through to search */ }
    }

    // 2) Search go-music-dl by title + artist.
    if (!song.title) return null;
    const q = `${song.artist ? song.artist + " " : ""}${song.title}`;
    const qs = new URLSearchParams({ q, type: "song", sources: "netease,qq,kugou,kuwo" });
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 15000);
      const res = await fetch(`${base}/music/search?${qs.toString()}`, { signal: controller.signal });
      clearTimeout(timeout);
      if (!res.ok) return null;
      const html = await res.text();
      for (const card of parseSongCards(html)) {
        if (card.cover) return { url: card.cover };
      }
    } catch { /* ignore — another provider may supply a cover */ }
    return null;
  },
};
