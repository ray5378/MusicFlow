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
import { db } from "../../db/index.js";
import { playlistSongs, playlists } from "../../db/schema.js";
import { eq } from "drizzle-orm";
import { getConfiguredProvider, getOnlineProvider, getSourcePluginConfig, OnlineSongResult } from "../../services/source/online/index.js";
import { importOnlineSongs } from "../../services/source/online/service.js";
import { matchUnmatchedPlaylistEntries, matchToOnlineSong } from "../../services/source/online/match.js";

export const onlineRoutes = new Hono();

// Background match jobs (large playlists). In-memory like scanJobs in api/index.ts.
const matchJobs = new Map<string, { status: string; playlistId: string; startedAt: string; finishedAt?: string; progress: { done: number; total: number }; result: any; error: string | null }>();
const INLINE_MATCH_LIMIT = 30;

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

// Auto-match a playlist's "曲库中未找到" tracks through the online source.
// For each unmatched entry: search go-music-dl, import best hit as an online
// DB song, and link it back so the track becomes playable.
// Body: { playlistId: string }
//
// For large playlists this runs as a background job:
//   POST  .../match-playlist -> { success, started, jobId, total, running }
//   GET   .../match-playlist/status?jobId=  -> { status, progress, result?, error? }
onlineRoutes.post("/v1/online/:providerId/match-playlist", async (c) => {
  const providerId = c.req.param("providerId");
  if (!providerId) return c.json({ success: false, error: "缺少在线源 id" });
  const configured = getConfiguredProvider(providerId);
  if (!configured) return c.json({ success: false, error: "在线源未启用或未配置" });

  const body = await c.req.json().catch(() => ({}));
  const playlistId = typeof body.playlistId === "string" ? body.playlistId : null;
  if (!playlistId) return c.json({ success: false, error: "缺少歌单 id" });

  const pl = db.select().from(playlists).where(eq(playlists.id, playlistId)).get();
  if (!pl) return c.json({ success: false, error: "歌单不存在" }, 404);

  const entryCount = db.select().from(playlistSongs).where(eq(playlistSongs.playlistId, playlistId)).all()
    .filter((e) => !e.playable && !e.songId && (e.externalTitle || "").trim()).length;
  if (entryCount === 0) return c.json({ success: true, total: 0, matched: 0, noMatch: 0, error: 0, results: [], alreadyMatched: true });

  // Small playlists match inline; large ones run in the background for the UI.
  if (entryCount <= INLINE_MATCH_LIMIT) {
    try {
      const result = await matchUnmatchedPlaylistEntries(providerId, configured.config, configured.provider, playlistId);
      return c.json({ success: true, jobId: null, ...result });
    } catch (e: any) {
      return c.json({ success: false, error: e.message || "匹配失败" });
    }
  }

  const jobId = `match-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  matchJobs.set(jobId, { status: "running", playlistId, startedAt: new Date().toISOString(), progress: { done: 0, total: entryCount }, result: null, error: null });
  (async () => {
    try {
      const result = await matchUnmatchedPlaylistEntries(
        providerId, configured.config, configured.provider, playlistId,
        (done, total) => { matchJobs.get(jobId)!.progress = { done, total }; },
      );
      matchJobs.set(jobId, { status: "completed", playlistId, startedAt: matchJobs.get(jobId)!.startedAt, finishedAt: new Date().toISOString(), progress: { done: entryCount, total: entryCount }, result, error: null });
    } catch (e: any) {
      matchJobs.set(jobId, { status: "failed", playlistId, startedAt: matchJobs.get(jobId)!.startedAt, finishedAt: new Date().toISOString(), progress: matchJobs.get(jobId)!.progress, result: null, error: e.message || "匹配失败" });
    }
  })();
  return c.json({ success: true, jobId, running: true, progress: { done: 0, total: entryCount } });
});

// Poll status of a background match job.
onlineRoutes.get("/v1/online/:providerId/match-playlist/status", (c) => {
  const jobId = c.req.query("jobId");
  if (!jobId) return c.json({ success: false, error: "缺少 jobId" });
  const job = matchJobs.get(jobId);
  if (!job) return c.json({ success: false, error: "任务不存在" }, 404);
  return c.json({ success: true, status: job.status, startedAt: job.startedAt, finishedAt: job.finishedAt, progress: job.progress, result: job.result, error: job.error });
});

// Auto-match a single unmatched playlist entry before playing it.
// Body: { entryId }
onlineRoutes.post("/v1/online/:providerId/match-track", async (c) => {
  const providerId = c.req.param("providerId");
  if (!providerId) return c.json({ success: false, error: "缺少在线源 id" });
  const configured = getConfiguredProvider(providerId);
  if (!configured) return c.json({ success: false, error: "在线源未启用或未配置" });

  const body = await c.req.json().catch(() => ({}));
  const entryId = Number(body.entryId);
  if (!Number.isInteger(entryId) || entryId <= 0) return c.json({ success: false, error: "缺少条目 id" });

  const entry = db.select().from(playlistSongs).where(eq(playlistSongs.id, entryId)).get();
  if (!entry) return c.json({ success: false, error: "条目不存在" }, 404);
  if (entry.playable && entry.songId) return c.json({ success: true, alreadyPlayable: true });

  try {
    const result = await matchToOnlineSong(providerId, configured.config, configured.provider, entry.playlistId, {
      entryId,
      title: entry.externalTitle || "",
      artist: entry.externalArtist || "",
      album: entry.externalAlbum || undefined,
      duration: entry.externalDuration || undefined,
    });
    return c.json({ success: result.status === "matched", ...result });
  } catch (e: any) {
    return c.json({ success: false, error: e.message || "匹配失败" });
  }
});

// Convenience count of unmatched entries in a playlist.
// GET /v1/online/:providerId/unmatched?playlistId=
onlineRoutes.get("/v1/online/:providerId/unmatched", async (c) => {
  const providerId = c.req.param("providerId");
  const playlistId = c.req.query("playlistId");
  if (!providerId || !playlistId) return c.json({ success: false, error: "缺少参数" });
  try {
    const entries = db.select().from(playlistSongs).where(eq(playlistSongs.playlistId, playlistId)).all();
    const unmatched = entries.filter((e) => !e.playable && !e.songId && (e.externalTitle || "").trim());
    return c.json({ success: true, count: unmatched.length, entries: unmatched.map((e) => ({
      id: e.id, title: e.externalTitle, artist: e.externalArtist, album: e.externalAlbum, duration: e.externalDuration,
    })) });
  } catch (e: any) {
    return c.json({ success: false, error: e.message || "查询失败" });
  }
});
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