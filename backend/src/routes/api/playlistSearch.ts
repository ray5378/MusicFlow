// ==================== Playlist-search routes ====================
//
// Backing endpoints for searching REMOTE playlists through enabled source
// plugins (e.g. go-music-dl's "playlistSearch" capability), and importing a
// found playlist into the local library.
//   GET  /v1/playlist-search/providers          — enabled playlistSearch plugins
//   POST /v1/playlist-search/:providerId/search — { q, sources? } -> { playlists }
//   POST /v1/playlist-search/:providerId/import — { source, id, name?, cover? }
//
// Mounted under /rest/api (api/index.ts) so the auth middleware is inherited.
// 核心只按 capability 查插件(getEnabledByCapability),不写死任何插件 id。

import { Hono } from "hono";
import { db } from "../../db/index.js";
import { playlists } from "../../db/schema.js";
import { eq, and } from "drizzle-orm";
import { getEnabledByCapability, getPluginConfig } from "../../plugins/registry.js";
import { playlistSyncApi } from "../../services/pluginAccess.js";
import { importOnlineSongs } from "../../services/source/online/service.js";
import { replacePlaylistSongs } from "../../services/source/online/recommendImport.js";
import { refreshPlaylistCounts } from "../../services/plugin/shared.js";
import { cacheRemoteCover } from "../../services/playlistCover.js";
import { clearLibraryIndex } from "../../services/plugin/libraryIndex.js";
import { touch } from "../../services/memory/reclaim.js";

export const playlistSearchRoutes = new Hono();

/** 合成 sourceUrl:保证「同一远程歌单幂等」(upsert 去重键)且 isImportedPlaylist 判定为平台歌单。 */
function syntheticSourceUrl(providerId: string, source: string, id: string): string {
  return `${providerId}://${source}/${id}`;
}

// List enabled plugins that can search remote playlists. The frontend renders
// the search-mode switcher from this (动态,不写死「本地/go-music-dl」)。
playlistSearchRoutes.get("/v1/playlist-search/providers", (c) => {
  const providers = getEnabledByCapability("playlistSearch").map(({ manifest }) => ({
    id: manifest.id,
    name: manifest.name,
    platforms: manifest.platforms || [],
    platformLabels: manifest.platformLabels || {},
  }));
  return c.json({ success: true, providers });
});

// Aggregate remote-playlist search across the plugin's platforms.
// Body: { q: string, sources?: string[] } -> { playlists: [...] }
// 未显式传 sources 时插件搜索其声明的全部平台;平台展示名由 manifest.platformLabels 映射。
playlistSearchRoutes.post("/v1/playlist-search/:providerId/search", async (c) => {
  const providerId = c.req.param("providerId")!;
  const plugin = getEnabledByCapability("playlistSearch").find((p) => p.manifest.id === providerId);
  if (!plugin || typeof plugin.impl?.searchPlaylists !== "function") {
    return c.json({ success: false, error: "未找到已启用的歌单搜索插件", providers: getEnabledByCapability("playlistSearch").map((p) => p.manifest.id) }, 404);
  }
  const body = await c.req.json().catch(() => ({}));
  const q = String(body.q || "").trim();
  if (!q) return c.json({ success: false, error: "请输入搜索关键词" });
  const sources = Array.isArray(body.sources) ? body.sources.map(String) : undefined;
  const config = getPluginConfig(providerId) || {};
  try {
    const res = await plugin.impl.searchPlaylists(config, { query: q, sources });
    const labels = plugin.manifest.platformLabels || {};
    const list: any[] = Array.isArray(res?.playlists) ? res.playlists : [];
    const playlists = list.map((p: any) => ({
      id: p.id,
      source: p.source,
      name: p.name || "",
      creator: p.creator || "",
      cover: p.cover || "",
      trackCount: p.trackCount ?? "",
      link: p.link || "",
      platformLabel: labels[p.source] || p.source,
    }));
    return c.json({ success: true, total: playlists.length, playlists });
  } catch (e: any) {
    return c.json({ success: false, error: e.message || "搜索失败" });
  }
});

// Import a searched playlist into the library: pull its songs through the
// plugin's playlistSongs capability, persist them as online DB songs, and
// create/update a platform playlist row (synthetic sourceUrl -> idempotent).
// Body: { source: string, id: string, name?: string, cover?: string }
playlistSearchRoutes.post("/v1/playlist-search/:providerId/import", async (c) => {
  const user = c.get("user");
  const providerId = c.req.param("providerId")!;
  const plugin = getEnabledByCapability("playlistSearch").find((p) => p.manifest.id === providerId);
  if (!plugin || typeof plugin.impl?.playlistSongs !== "function") {
    return c.json({ success: false, error: "插件缺少 playlistSongs 能力(无法拉取歌单歌曲)" }, 404);
  }
  const body = await c.req.json().catch(() => ({}));
  const source = String(body.source || "").trim();
  const id = String(body.id || "").trim();
  if (!source || !id) return c.json({ success: false, error: "缺少歌单 source/id" });
  const config = getPluginConfig(providerId) || {};
  const fallbackName = String(body.name || "").trim();
  const cover = String(body.cover || "").trim();
  const sourceUrl = syntheticSourceUrl(providerId, source, id);

  try {
    const { songs: list } = await plugin.impl.playlistSongs(config, source, id);
    if (!Array.isArray(list) || list.length === 0) {
      return c.json({ success: false, error: "该歌单没有可导入的歌曲" });
    }
    // 歌曲入库为在线歌曲(可播),返回 { songs: [{ id, title, ... }], added, deduped, failed }
    const imp = await importOnlineSongs(providerId, list, { userId: user?.id });
    if (!imp?.songs?.length) {
      return c.json({ success: false, error: "歌曲入库失败,请检查在线源配置" });
    }

    const name = fallbackName || `歌单 ${source}/${id}`;
    const existing = db.select().from(playlists)
      .where(and(eq(playlists.sourceUrl, sourceUrl), eq(playlists.ownerId, user?.id || "")))
      .get();

    let playlistId: string;
    if (existing) {
      playlistId = existing.id;
      const upd: any = { updatedAt: new Date().toISOString() };
      if (fallbackName) upd.name = name;
      if (cover) {
        const cached = await cacheRemoteCover(cover, `pl-${playlistId}`, true);
        if (cached) upd.coverArt = cached;
      }
      db.update(playlists).set(upd).where(eq(playlists.id, playlistId)).run();
    } else {
      playlistId = `pl-${Date.now()}`;
      let coverRef: string | undefined = undefined;
      if (cover) {
        const cached = await cacheRemoteCover(cover, `pl-${playlistId}`);
        if (cached) coverRef = cached;
      }
      db.insert(playlists).values({
        id: playlistId,
        name,
        ownerId: user?.id || "",
        sourceUrl,
        sourcePlatform: source,
        sourcePlugin: providerId,
        externalId: id,
        coverArt: coverRef,
        syncEnabled: 0, // 搜索结果歌单默认不同步;用户可在歌单管理手动开启(由插件能力决定是否支持)
      }).run();
    }

    // 全量替换条目为本次拉取的歌曲(在线歌曲直接关联 songId,可播放)
    replacePlaylistSongs(playlistId, imp.songs);
    refreshPlaylistCounts(playlistId);
    clearLibraryIndex(); // 回收曲库索引缓存(避免大歌单残留内存)
    touch(); // 标记活动:搜索歌单导入

    return c.json({
      success: true,
      playlistId,
      name,
      platform: source,
      trackCount: imp.songs.length,
      added: imp.added,
      deduped: imp.deduped,
      failed: imp.failed,
      created: !existing,
    });
  } catch (e: any) {
    return c.json({ success: false, error: e.message || "导入失败" });
  }
});
