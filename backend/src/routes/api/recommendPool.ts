// 自动生成 —— 由 index.ts 物理拆分而来（recommendPool 域，8 条路由）。零逻辑改动。
import type { Hono } from "hono";
import {
  BusinessErrorCode,
  PERM,
  apiError,
  dailyApi,
  permMiddleware,
  playlists,
  plugins,
  sqlite,
} from "./shared.js";

export function registerRecommendPool(app: Hono): void {
app.use("/v1/recommend-pool", permMiddleware(PERM.RECOMMEND_VIEW));

app.get("/v1/recommend-pool", (c) => {
  const pool = dailyApi()?.listRecommendPool() ?? [];
  return c.json({ pool });
});

// Add a playlist to the pool. Any logged-in user can do this (not admin-only)
// since it's a personalization feature, not a system config.

app.post("/v1/recommend-pool/playlist/:playlistId", async (c) => {
  const user = c.get("user");
  const playlistId = c.req.param("playlistId");
  const row = sqlite.prepare("SELECT name FROM playlists WHERE id = ?").get(playlistId) as any;
  if (!row) return c.json(apiError(BusinessErrorCode.NOT_FOUND, "errors.playlist.notFound"), 404);
  const added = dailyApi()?.addToRecommendPool("playlist", playlistId, row.name || "", user?.id || "") ?? false;
  return c.json({ success: true, added, message: added ? "已加入每日推荐池" : "该歌单已在推荐池中" });
});

// Remove a playlist from the pool.

app.delete("/v1/recommend-pool/playlist/:playlistId", (c) => {
  const playlistId = c.req.param("playlistId");
  const removed = dailyApi()?.removeFromRecommendPool("playlist", playlistId) ?? false;
  return c.json({ success: true, removed });
});

// Check if a playlist is in the pool (for the UI to show toggle state).

app.get("/v1/recommend-pool/playlist/:playlistId/status", (c) => {
  const playlistId = c.req.param("playlistId");
  return c.json({ inPool: dailyApi()?.isInRecommendPool("playlist", playlistId) ?? false });
});

// Add the current user's favorites ("我喜欢的音乐") to the pool.

app.post("/v1/recommend-pool/favorites", async (c) => {
  const user = c.get("user");
  if (!user?.id) return c.json(apiError(BusinessErrorCode.FORBIDDEN, "errors.auth.notLoggedIn"), 401);
  const added = dailyApi()?.addToRecommendPool("favorites", user.id, "我喜欢的音乐", user.id) ?? false;
  return c.json({ success: true, added, message: added ? "已加入每日推荐池" : "我喜欢的音乐已在推荐池中" });
});

// Remove the current user's favorites from the pool.

app.delete("/v1/recommend-pool/favorites", (c) => {
  const user = c.get("user");
  if (!user?.id) return c.json(apiError(BusinessErrorCode.FORBIDDEN, "errors.auth.notLoggedIn"), 401);
  const removed = dailyApi()?.removeFromRecommendPool("favorites", user.id) ?? false;
  return c.json({ success: true, removed });
});

// Check if the current user's favorites are in the pool.

app.get("/v1/recommend-pool/favorites/status", (c) => {
  const user = c.get("user");
  if (!user?.id) return c.json({ inPool: false });
  return c.json({ inPool: dailyApi()?.isInRecommendPool("favorites", user.id) ?? false });
});

// ==================== Playlist import (built-in plugins: QQ / NetEase / MusicFlow native file) ====================
// URL 导入走异步任务(触发即返回 taskId,前端轮询 GET /v1/tasks/:id):网络拉取 + 增量重建
// 可能耗时几秒~几十秒,同步 await 会长时间挂住前端请求;native 文件解析通常量小,保持同步。
}
