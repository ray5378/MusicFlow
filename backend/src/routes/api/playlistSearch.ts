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
import { markInteractiveStart, markInteractiveEnd } from "../../services/plugin/batchPacer.js";
import { startAsyncTask } from "../../services/plugin/asyncTasks.js";
import { createLogger } from "../../utils/logger.js";

const log = createLogger("PLAYLIST-SEARCH");
export const playlistSearchRoutes = new Hono();

/** 合成 sourceUrl:保证「同一远程歌单幂等」(upsert 去重键)且 isImportedPlaylist 判定为平台歌单。 */
function syntheticSourceUrl(providerId: string, source: string, id: string): string {
  return `${providerId}://${source}/${id}`;
}

// List enabled plugins that can search remote playlists. The frontend renders
// the search-mode switcher from this (动态,不写死「本地/go-music-dl」)。
// 同时返回每插件「歌单筛选平台」配置(filterPlatforms),供前端筛选下拉动态构建。
playlistSearchRoutes.get("/v1/playlist-search/providers", (c) => {
  const providers = getEnabledByCapability("playlistSearch").map(({ manifest }) => {
    const config = getPluginConfig(manifest.id);
    const filterPlatforms = config?.filterPlatforms;
    // 如果有 filterPlatforms 配置且非空,用它覆盖 manifest.platforms
    const platforms = Array.isArray(filterPlatforms) && filterPlatforms.length > 0
      ? filterPlatforms
      : (manifest.platforms || []);
    return {
      id: manifest.id,
      name: manifest.name,
      platforms,
      platformLabels: manifest.platformLabels || {},
    };
  });
  return c.json({ success: true, providers });
});

// Aggregate remote-playlist search across ALL enabled playlistSearch plugins
// (前端「聚合」默认模式的端点)。并发 Promise.allSettled:单个插件失败不阻断整体,
// 失败仅记日志;每条结果带 providerId/providerName,供前端详情/导入/播放归位到对应插件。
// 单独服务于「聚合」静态段语义;既有 /:providerId/search(单插件)不在此覆盖。
playlistSearchRoutes.post("/v1/playlist-search/aggregate/search", async (c) => {
  markInteractiveStart();
  try {
    const q = String((await c.req.json().catch(() => ({}))).q || "").trim();
    if (!q) return c.json({ success: false, error: "请输入搜索关键词" });
    const providers = getEnabledByCapability("playlistSearch").filter((p) => typeof p.impl?.searchPlaylists === "function");
    if (providers.length === 0) return c.json({ success: true, total: 0, providers: [], playlists: [] });

    const settled = await Promise.allSettled(providers.map(async (p) => {
      const config = getPluginConfig(p.manifest.id) || {};
      const res = await p.impl.searchPlaylists(config, { query: q });
      const list = Array.isArray(res?.playlists) ? res.playlists : [];
      return { providerId: p.manifest.id, providerName: p.manifest.name, labels: p.manifest.platformLabels || {}, list };
    }));

    const playlists: any[] = [];
    settled.forEach((s, i) => {
      if (s.status === "fulfilled") {
        for (const p of s.value.list) {
          playlists.push({
            providerId: s.value.providerId,
            providerName: s.value.providerName,
            id: p.id, source: p.source, name: p.name || "", creator: p.creator || "",
            cover: p.cover || "", trackCount: p.trackCount ?? "", link: p.link || "",
            platformLabel: s.value.labels[p.source] || p.source,
          });
        }
      } else {
        // 单个插件失败只降级,不拖垮聚合;必须记日志且带插件 id。
        log.error("聚合搜索插件失败", { providerId: providers[i]?.manifest.id || "?", err: s.reason instanceof Error ? s.reason.message : String(s.reason) });
      }
    });

    return c.json({
      success: true,
      total: playlists.length,
      providers: providers.map((pt) => ({ id: pt.manifest.id, name: pt.manifest.name, platforms: pt.manifest.platforms || [], platformLabels: pt.manifest.platformLabels || {} })),
      playlists,
    });
  } catch (e: any) {
    return c.json({ success: false, error: e.message || "搜索失败" });
  } finally {
    markInteractiveEnd();
  }
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
  const fallbackName = String(body.name || "").trim();
  const cover = String(body.cover || "").trim();
  const sourceUrl = syntheticSourceUrl(providerId, source, id);

  // 拉歌 → 入库 → 平台歌单 upsert → 全量替换条目,在一次性批量子进程里执行(方案3),
  // 子进程从自身注册表按 providerId + capability 重建插件/config。
  const started = startAsyncTask("playlist-search-import", `pl:${sourceUrl}:${user?.id || ""}`, {
    kind: "playlist-search-import",
    args: { providerId, lookupCap: "playlistSearch", source, id, name: fallbackName, cover, sourceUrl, userId: user?.id },
  });
  if (!started.started) return c.json({ success: false, alreadyRunning: true, taskId: started.taskId });
  return c.json({ success: true, taskId: started.taskId });
});

// Remote detail (只拉不导入):点击远程歌单卡片后预览其歌曲列表。调用插件
// playlistSongs 拉歌但**不写库**,前端可据此直接播放(/rest/stream-remote)或加入库。
playlistSearchRoutes.get("/v1/playlist-search/:providerId/items", async (c) => {
  markInteractiveStart();
  try {
    const providerId = c.req.param("providerId")!;
    const plugin = getEnabledByCapability("playlistSearch").find((p) => p.manifest.id === providerId);
    if (!plugin || typeof plugin.impl?.playlistSongs !== "function") {
      return c.json({ success: false, error: "插件缺少 playlistSongs 能力(无法拉取歌单歌曲)" }, 404);
    }
    const source = String(c.req.query("source") || "").trim();
    const id = String(c.req.query("id") || "").trim();
    if (!source || !id) return c.json({ success: false, error: "缺少歌单 source/id" });
    const config = getPluginConfig(providerId) || {};
    const res = await plugin.impl.playlistSongs(config, source, id);
    const list = Array.isArray(res?.songs) ? res.songs : [];
    const labels = plugin.manifest.platformLabels || {};
    const items = list.map((s: any) => ({
      id: s.id,
      source: s.source,
      name: s.name || "",
      artist: s.artist || "",
      album: s.album || "",
      duration: s.duration || 0,
      cover: s.cover || "",
      // 插件可在歌曲上告知音频格式,透传给前端(本机播放优先采用,不探测)。
      suffix: s.suffix || "",
      platformLabel: labels[s.source] || s.source,
    }));
    return c.json({ success: true, total: items.length, items });
  } catch (e: any) {
    return c.json({ success: false, error: e.message || "拉取失败" });
  } finally {
    markInteractiveEnd();
  }
});
