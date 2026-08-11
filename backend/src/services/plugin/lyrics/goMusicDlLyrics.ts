// ==================== go-music-dl lyrics provider ====================
//
// A `lyricProvider` plugin extracted from the go-music-dl source plugin's
// `lyricUrl` logic (see services/source/online/goMusicDl.ts). Splitting it out
// means lyrics are now served through the unified provider registry
// (first-match-wins), so a NetEase/QQ lyrics plugin can coexist and the admin
// can toggle sources independently.
//
// The plugin reuses the go-music-dl source's baseUrl when its own is empty, so
// configuring the source once is enough.

import { getPluginConfig } from "../../../plugins/registry.js";
import type { LyricProviderPlugin, LyricSongInput, PluginManifest } from "../../../plugins/types.js";

function baseUrlOf(config: Record<string, any> | null): string {
  return String(config?.baseUrl || "").replace(/\/+$/, "");
}

/** Build the go-music-dl /music/download_lrc URL from a stored web-song URL. */
function lrcUrlFromSong(song: LyricSongInput): string | null {
  if (!song.url || !song.url.includes("/music/download")) return null;
  try {
    const u = new URL(song.url);
    if (!u.pathname.endsWith("/music/download")) return null;
    u.pathname = u.pathname.slice(0, -"/music/download".length) + "/music/download_lrc";
    u.searchParams.delete("stream");
    u.searchParams.delete("range");
    u.searchParams.delete("cover");
    u.searchParams.delete("embed");
    u.searchParams.set("format", "line");
    if ((song.duration || 0) > 0 && !u.searchParams.has("duration")) {
      u.searchParams.set("duration", String(song.duration));
    }
    return u.toString();
  } catch {
    return null;
  }
}

export const GO_MUSIC_DL_LYRICS_ID = "go-music-dl-lyrics";

export const goMusicDlLyricsManifest: PluginManifest = {
  id: GO_MUSIC_DL_LYRICS_ID,
  name: "go-music-dl 歌词",
  version: "1.0.0",
  type: "lyrics",
  description: "通过 go-music-dl 服务为在线歌曲获取 LRC 歌词;baseUrl 留空则复用「go-music-dl 全网聚合」在线源配置",
  capabilities: ["lyricProvider"],
  permissions: ["net", "log"],
  defaultEnabled: true,
  configSchema: [
    { key: "baseUrl", label: "服务地址", type: "url", help: "留空则复用「go-music-dl 全网聚合」在线源的配置" },
  ],
};

export const goMusicDlLyricsPlugin: LyricProviderPlugin = {
  manifest: goMusicDlLyricsManifest,
  async searchLyrics(_host, song: LyricSongInput) {
    let base = baseUrlOf(_host.config);
    if (!base) {
      const g = getPluginConfig("go-music-dl");
      base = baseUrlOf(g);
    }
    if (!base) return null;
    const lrcUrl = lrcUrlFromSong(song);
    if (!lrcUrl) return null;
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 8000);
      const res = await fetch(lrcUrl, { signal: controller.signal });
      clearTimeout(timeout);
      if (!res.ok) return null;
      const text = await res.text();
      if (!text || text.startsWith("Lyric not found")) return null;
      return { lrc: text };
    } catch {
      return null;
    }
  },
};
