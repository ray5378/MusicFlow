// ==================== Entity-search routes (音乐 / 艺术家 / 专辑) ====================
//
// Backing endpoints for searching REMOTE songs / artists / albums through enabled
// plugins' "songSearch" / "artistSearch" / "albumSearch" capabilities — the same
// pattern as playlist-search, generic across plugins (核心只按 capability 查插件,
// 不写死任何插件 id;插件没声明该能力,providers 列表里就不出现它)。
//   GET  /v1/{song|artist|album}-search/providers          — enabled plugins
//   POST /v1/{song|artist|album}-search/:providerId/search — { q, sources? } -> { items }
//   POST /v1/song-search/:providerId/import                — { songs: [...] } 入库为可播在线歌曲
//   POST /v1/album-search/:providerId/import               — { source, id, name?, cover? } 整专入为专辑歌单
//   (artist 无导入:结果仅展示,供发现)
//
// Mounted under /rest/api (api/index.ts) so the auth middleware is inherited.

import { Hono } from "hono";
import { getEnabledByCapability, getPluginConfig } from "../../plugins/registry.js";
import { importOnlineSongs } from "../../services/source/online/service.js";
import { importRemotePlaylistLike } from "../../services/plugin/remoteImport.js";
import { clearLibraryIndex } from "../../services/plugin/libraryIndex.js";
import { markInteractiveStart, markInteractiveEnd } from "../../services/plugin/batchPacer.js";
import { startAsyncTask } from "../../services/plugin/asyncTasks.js";
import { touch } from "../../services/memory/reclaim.js";

type Kind = "song" | "artist" | "album";

interface Spec {
  kind: Kind;
  capability: "songSearch" | "artistSearch" | "albumSearch";
  method: "searchSongs" | "searchArtists" | "searchAlbums";
  resultKey: "songs" | "artists" | "albums";
  base: string;
  /** song/album 有「加入库」导入端点;artist 仅展示(无导入)。 */
  importable: boolean;
}

const SPECS: Spec[] = [
  { kind: "song", capability: "songSearch", method: "searchSongs", resultKey: "songs", base: "/v1/song-search", importable: true },
  { kind: "artist", capability: "artistSearch", method: "searchArtists", resultKey: "artists", base: "/v1/artist-search", importable: false },
  { kind: "album", capability: "albumSearch", method: "searchAlbums", resultKey: "albums", base: "/v1/album-search", importable: true },
];

export const entitySearchRoutes = new Hono();

/** 结果统一归一化:补 platformLabel(manifest.platformLabels 映射,缺失回退 source slug)。 */
function mapItems(kind: Kind, list: any[] | undefined, labels: Record<string, string>): any[] {
  const src = Array.isArray(list) ? list : [];
  if (kind === "song") {
    return src.map((s) => ({
      id: s.id,
      source: s.source,
      name: s.name || "",
      artist: s.artist || "",
      album: s.album || "",
      duration: s.duration || 0,
      cover: s.cover || "",
      platformLabel: labels[s.source] || s.source,
    }));
  }
  if (kind === "artist") {
    return src.map((a) => ({
      id: a.id,
      source: a.source,
      name: a.name || "",
      avatar: a.avatar || a.cover || "",
      link: a.link || "",
      albumCount: a.albumCount ?? "",
      songCount: a.songCount ?? "",
      platformLabel: labels[a.source] || a.source,
    }));
  }
  return src.map((al) => ({
    id: al.id,
    source: al.source,
    name: al.name || "",
    artist: al.artist || "",
    cover: al.cover || "",
    trackCount: al.trackCount ?? "",
    year: al.year ?? "",
    link: al.link || "",
    platformLabel: labels[al.source] || al.source,
  }));
}

for (const spec of SPECS) {
  // List enabled plugins that can search this entity type. The frontend renders
  // the search-mode dropdown from this (插件没声明该能力就不会出现)。
  entitySearchRoutes.get(`${spec.base}/providers`, (c) => {
    const providers = getEnabledByCapability(spec.capability).map(({ manifest }) => ({
      id: manifest.id,
      name: manifest.name,
      platforms: manifest.platforms || [],
      platformLabels: manifest.platformLabels || {},
    }));
    return c.json({ success: true, providers });
  });

  // Aggregate remote search across the plugin's platforms.
  // Body: { q: string, sources?: string[] } -> { items: [...] }
  entitySearchRoutes.post(`${spec.base}/:providerId/search`, async (c) => {
    markInteractiveStart(); // 用户交互窗口:后台批量任务让路,搜索本身不受节流
    try {
      const providerId = c.req.param("providerId")!;
      const plugin = getEnabledByCapability(spec.capability).find((p) => p.manifest.id === providerId);
      if (!plugin || typeof plugin.impl?.[spec.method] !== "function") {
        return c.json(
          { success: false, error: "未找到已启用的搜索插件", providers: getEnabledByCapability(spec.capability).map((p) => p.manifest.id) },
          404,
        );
      }
      const body = await c.req.json().catch(() => ({}));
      const q = String(body.q || "").trim();
      if (!q) return c.json({ success: false, error: "请输入搜索关键词" });
      const sources = Array.isArray(body.sources) ? body.sources.map(String) : undefined;
      const config = getPluginConfig(providerId) || {};
      const res = await plugin.impl[spec.method](config, { query: q, sources });
      const labels = plugin.manifest.platformLabels || {};
      const items = mapItems(spec.kind, res?.[spec.resultKey], labels);
      return c.json({ success: true, total: items.length, items });
    } catch (e: any) {
      return c.json({ success: false, error: e.message || "搜索失败" });
    } finally {
      markInteractiveEnd();
    }
  });

  // Import endpoints (song: payload import; album: playlist-like import via playlistSongs).
  if (spec.importable) {
    entitySearchRoutes.post(`${spec.base}/:providerId/import`, async (c) => {
      const user = c.get("user");
      const providerId = c.req.param("providerId")!;
      const plugin = getEnabledByCapability(spec.capability).find((p) => p.manifest.id === providerId);
      if (!plugin) return c.json({ success: false, error: "未找到已启用的搜索插件" }, 404);
      const body = await c.req.json().catch(() => ({}));

      if (spec.kind === "song") {
        // 歌曲:搜索结果的歌曲数据直接入库为可播在线歌曲(fingerprint 去重,重复导入无副作用)。
        const list = Array.isArray(body.songs) ? body.songs : [];
        if (!list.length) return c.json({ success: false, error: "缺少 songs 列表" });
        const started = startAsyncTask("song-search-import", `sg:${providerId}:${user?.id || ""}:${Date.now()}`, async () => {
          markInteractiveStart();
          try {
            const imp = await importOnlineSongs(providerId, list, { userId: user?.id, interactive: true });
            if (!imp?.songs?.length) throw new Error("歌曲入库失败,请检查在线源配置");
            // ids 供调用方(如 HA 卡片)「导入后立即入队播放」拿到真实 DB songId。
            // imported 带 fingerprint(providerId:source:id)供批量导入后精确映射(导入并发执行,
            // 失败项被过滤,按序对应会错位)。
            return {
              success: true, added: imp.added, deduped: imp.deduped, failed: imp.failed,
              trackCount: imp.songs.length, ids: imp.songs.map((s) => s.id),
              imported: imp.songs.map((s) => ({ id: s.id, fingerprint: s.fingerprint })),
            };
          } finally {
            clearLibraryIndex();
            touch();
            markInteractiveEnd();
          }
        });
        if (!started.started) return c.json({ success: false, alreadyRunning: true, taskId: started.taskId });
        return c.json({ success: true, taskId: started.taskId });
      }

      // album:调插件 playlistSongs 拉整专 → 以「专辑歌单」形式入库(合成 sourceUrl 幂等,重复导入=增量更新)。
      const source = String(body.source || "").trim();
      const id = String(body.id || "").trim();
      if (!source || !id) return c.json({ success: false, error: "缺少专辑 source/id" });
      if (typeof plugin.impl?.playlistSongs !== "function") {
        return c.json({ success: false, error: "插件缺少 playlistSongs 能力(无法拉取专辑歌曲)" }, 404);
      }
      const config = getPluginConfig(providerId) || {};
      // 专辑用独立 scheme,避免与同平台歌单 id 撞幂等键
      const sourceUrl = `${providerId}://album/${source}/${id}`;
      const started = startAsyncTask("album-search-import", `al:${sourceUrl}:${user?.id || ""}`, async () => {
        return importRemotePlaylistLike({
          providerId,
          plugin: plugin.impl,
          config,
          userId: user?.id,
          source,
          id,
          name: String(body.name || "").trim(),
          cover: String(body.cover || "").trim(),
          sourceUrl,
        });
      });
      if (!started.started) return c.json({ success: false, alreadyRunning: true, taskId: started.taskId });
      return c.json({ success: true, taskId: started.taskId });
    });
  }

  // Remote detail (只拉不导入):点击远程专辑/艺术家卡片后,预览其内部歌曲列表。
  //   album  → 插件 playlistSongs 拉整专歌曲
  //   artist → 插件 searchSongs 按艺术家名搜歌曲(通用能力,不新增 artist 专属接口)
  // 与 search 一样走同步返回(仅网络拉取,不写库);歌曲带 source/id,前端可拼
  // /rest/stream-remote 直接播放或「加入库」。
  if (spec.kind === "album" || spec.kind === "artist") {
    entitySearchRoutes.get(`${spec.base}/:providerId/items`, async (c) => {
      markInteractiveStart();
      try {
        const providerId = c.req.param("providerId")!;
        const plugin = getEnabledByCapability(spec.capability).find((p) => p.manifest.id === providerId);
        if (!plugin) return c.json({ success: false, error: "未找到已启用的搜索插件" }, 404);
        const source = String(c.req.query("source") || "").trim();
        const id = String(c.req.query("id") || "").trim();
        const name = String(c.req.query("name") || "").trim();
        const config = getPluginConfig(providerId) || {};
        const labels = plugin.manifest.platformLabels || {};
        let raw: any[] = [];
        if (spec.kind === "album") {
          if (!source || !id) return c.json({ success: false, error: "缺少专辑 source/id" });
          if (typeof plugin.impl?.playlistSongs !== "function") {
            return c.json({ success: false, error: "插件缺少 playlistSongs 能力(无法拉取专辑歌曲)" }, 404);
          }
          const res = await plugin.impl.playlistSongs(config, source, id);
          raw = Array.isArray(res?.songs) ? res.songs : [];
        } else {
          if (!name) return c.json({ success: false, error: "缺少艺术家名称" });
          if (typeof plugin.impl?.searchSongs !== "function") {
            return c.json({ success: false, error: "插件缺少 songSearch 能力(无法拉取歌手歌曲)" }, 404);
          }
          const res = await plugin.impl.searchSongs(config, { query: name, sources: source ? [source] : undefined });
          raw = Array.isArray(res?.songs) ? res.songs : [];
        }
        const items = mapItems("song", raw, labels);
        return c.json({ success: true, total: items.length, items });
      } catch (e: any) {
        return c.json({ success: false, error: e.message || "拉取失败" });
      } finally {
        markInteractiveEnd();
      }
    });
  }
}
