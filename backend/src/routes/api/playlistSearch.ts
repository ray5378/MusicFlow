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
import { getEnabledByCapability, getPluginConfig } from "../../plugins/registry.js";
import { importRemotePlaylistLike } from "../../services/plugin/remoteImport.js";
import { markInteractiveStart, markInteractiveEnd } from "../../services/plugin/batchPacer.js";
import { startAsyncTask } from "../../services/plugin/asyncTasks.js";

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
  markInteractiveStart(); // 用户交互窗口:后台批量任务让路,搜索本身不受节流
  try {
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
  } finally {
    markInteractiveEnd();
  }
});

// Import a searched playlist into the library: pull its songs through the
// plugin's playlistSongs capability, persist them as online DB songs, and
// create/update a platform playlist row (synthetic sourceUrl -> idempotent).
// Body: { source: string, id: string, name?: string, cover?: string }
// 走异步任务:触发即返回 taskId(前端轮询 GET /v1/tasks/:id),拉歌+入库可能耗时,避免 HTTP 长时间挂起。
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

  const started = startAsyncTask("playlist-search-import", `pl:${sourceUrl}:${user?.id || ""}`, async () => {
    // 拉歌 → 入库 → 平台歌单 upsert(合成 sourceUrl 幂等)→ 全量替换条目,见 remoteImport.ts
    return importRemotePlaylistLike({
      providerId,
      plugin: plugin.impl,
      config,
      userId: user?.id,
      source,
      id,
      name: fallbackName,
      cover,
      sourceUrl,
    });
  });
  if (!started.started) return c.json({ success: false, alreadyRunning: true, taskId: started.taskId });
  return c.json({ success: true, taskId: started.taskId });
});
