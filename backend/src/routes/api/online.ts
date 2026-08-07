// ==================== Online source routes ====================
//
// Backing endpoints for the built-in "go-music-dl" source plugin:
//   POST /v1/online/:providerId/test   — connectivity check (admin)
//   POST /v1/online/:providerId/search — aggregated online search
//   POST /v1/online/:providerId/import — persist search results as online DB songs
//
// All routes are under /rest/api (mounted in api/index.ts), so they inherit
// the /rest/api/* auth middleware; admin-only ones add adminMiddleware.

import { Hono } from "hono";
import { adminMiddleware } from "../../middleware/auth.js";
import { getConfiguredProvider, getOnlineProvider, getSourcePluginConfig, OnlineSongResult } from "../../services/source/online/index.js";
import { importOnlineSongs } from "../../services/source/online/service.js";

export const onlineRoutes = new Hono();

// Connectivity test for an admin-configured provider instance.
onlineRoutes.post("/v1/online/:providerId/test", adminMiddleware, async (c) => {
  const providerId = c.req.param("providerId");
  if (!providerId) return c.json({ success: false, error: "缺少在线源 id" });
  const provider = getOnlineProvider(providerId);
  if (!provider) return c.json({ success: false, error: `未知的在线源: ${providerId}` });
  const config = getSourcePluginConfig(providerId);
  if (!config) return c.json({ success: false, error: "在线源未启用或未配置" });
  const result = await provider.test(config);
  return c.json({ success: result.success, message: result.message });
});

// Aggregate online search across the configured go-music-dl instance.
// Body: { q: string, sources?: string[] } -> { songs: OnlineSongResult[] }
onlineRoutes.post("/v1/online/:providerId/search", async (c) => {
  const providerId = c.req.param("providerId");
  if (!providerId) return c.json({ success: false, error: "缺少 provider id" });
  const configured = getConfiguredProvider(providerId);
  if (!configured) return c.json({ success: false, error: "在线源未启用或未配置" });
  const body = await c.req.json().catch(() => ({}));
  const q = String(body.q || "").trim();
  if (!q) return c.json({ success: false, error: "请输入搜索关键词" });
  const sources = Array.isArray(body.sources) ? body.sources.map(String) : undefined;
  try {
    const result = await configured.provider.search(configured.config, { query: q, sources });
    const platformNames = new Map([
      ["netease", "网易云"], ["qq", "QQ 音乐"], ["kugou", "酷狗"], ["kuwo", "酷我"],
      ["migu", "咪咕"], ["qianqian", "千千"], ["soda", "汽水"], ["fivesing", "5sing"],
      ["jamendo", "Jamendo"], ["joox", "JOOX"], ["bilibili", "Bilibili"], ["apple", "Apple Music"],
    ]);
    const songs = result.songs.map((s) => ({
      ...s,
      platformLabel: platformNames.get(s.source) || s.source,
      streamUrl: configured.provider.streamUrl(configured.config, s),
    }));
    return c.json({ success: true, total: songs.length, songs });
  } catch (e: any) {
    return c.json({ success: false, error: e.message || "搜索失败" });
  }
});

// Persist chosen search results as online DB songs.
// Body: { songs: OnlineSongResult[], playlistId?: string }
// Returns per-song DB ids (deduped rows are reported too).
onlineRoutes.post("/v1/online/:providerId/import", async (c) => {
  const providerId = c.req.param("providerId");
  if (!providerId) return c.json({ success: false, error: "缺少在线源 id" });
  if (!getSourcePluginConfig(providerId)) return c.json({ success: false, error: "在线源未启用或未配置" });
  const user = c.get("user");
  const body = await c.req.json().catch(() => ({}));
  const songList: OnlineSongResult[] = Array.isArray(body.songs) ? body.songs : null;
  if (!songList || songList.length === 0) return c.json({ success: false, error: "没有可导入的歌曲" });
  const playlistId = typeof body.playlistId === "string" ? body.playlistId : undefined;
  try {
    const result = await importOnlineSongs(providerId, songList, { playlistId, userId: user?.id });
    return c.json({ success: true, ...result });
  } catch (e: any) {
    return c.json({ success: false, error: e.message || "导入失败" });
  }
});