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
import { db, sqlite } from "../../db/index.js";
import { playlistSongs, playlists } from "../../db/schema.js";
import { eq } from "drizzle-orm";
import { getConfiguredProvider, getOnlineProvider, getSourcePluginConfig, OnlineSongResult } from "../../services/source/online/index.js";
import { importOnlineSongs } from "../../services/source/online/service.js";
import { matchUnmatchedPlaylistEntries, matchToOnlineSong } from "../../services/source/online/match.js";
import { importRecommendPlaylist, isDailyRecommendPlaylist, findRecommendPlaylist } from "../../services/source/online/recommendImport.js";
import { touch } from "../../services/memory/reclaim.js";
import { getPluginManifest, getEnabledByCapability } from "../../plugins/registry.js";
import { runPluginJob } from "../../services/plugin/jobRunner.js";
import { runBatchJob } from "../../batch/runner.js";

export const onlineRoutes = new Hono();

// 批量在线适配任务(一键适配所有含未匹配条目的歌单)。后台串行逐个歌单,
// 每个歌单内部沿用 MATCH_CONCURRENCY 并发控制;状态存内存,TTL 同 matchJobs。
const batchMatchJobs = new Map<string, { status: string; startedAt: string; finishedAt?: string; total: number; done: number; current: string; results: any[]; error: string | null }>();

// 「同步所有平台」聚合任务状态(路径 A 推荐歌单重导;插件任务状态在 jobRunner)。
const syncAllState = new Map<string, { running: boolean; startedAt: string; finishedAt?: string; result: any; error: string | null }>();

// Background match jobs (large playlists). In-memory like scanJobs in api/index.ts.
const matchJobs = new Map<string, { status: string; playlistId: string; startedAt: string; finishedAt?: string; progress: { done: number; total: number }; result: any; error: string | null }>();
const INLINE_MATCH_LIMIT = 30;

// 完成/失败后的 job 保留 30 min 供前端轮询取结果,超时后清理防 Map 慢增长
// (参照 services/lyrics.ts 的 lrcCacheSweep 模式;running 中的 job 不清理)。
// batchMatchJobs(results 数组按歌单累积)与 syncAllState 同用这套 TTL 清扫。
const MATCH_JOB_TTL_MS = 30 * 60 * 1000;
const matchJobsSweep = setInterval(() => {
  const now = Date.now();
  for (const [k, v] of matchJobs) {
    if (!v.finishedAt) continue;
    if (now - Date.parse(v.finishedAt) >= MATCH_JOB_TTL_MS) matchJobs.delete(k);
  }
  for (const [k, v] of batchMatchJobs) {
    if (!v.finishedAt) continue;
    if (now - Date.parse(v.finishedAt) >= MATCH_JOB_TTL_MS) batchMatchJobs.delete(k);
  }
  for (const [k, v] of syncAllState) {
    if (!v.finishedAt) continue;
    if (now - Date.parse(v.finishedAt) >= MATCH_JOB_TTL_MS) syncAllState.delete(k);
  }
}, 5 * 60 * 1000);
(matchJobsSweep as any).unref?.();

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
    // 平台 → 展示名 映射由插件 manifest 声明(platformLabels),核心不写死平台词典。
    const platformLabels = getPluginManifest(providerId)?.platformLabels || {};
    const songs = result.songs.map((s) => ({
      ...s,
      platformLabel: platformLabels[s.source] || s.source,
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
    // 匹配在一次性批量子进程里执行(方案3);进度经 IPC 转发,全局批量闸由
    // runBatchJob 持有(FIFO 排队),这里不再重复取锁。
    try {
      const { result } = await runBatchJob("match-playlist", { providerId, playlistId }, {
        onProgress: (p) => { const j = matchJobs.get(jobId); if (j && p) j.progress = { done: p.done, total: p.total }; },
      });
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

// 批量在线适配:对「所有含未匹配(外部占位)条目的歌单」启动后台串行匹配。
// 只处理有占位条目的歌单(不空转);每个歌单内部沿用 MATCH_CONCURRENCY 并发控制。
//   POST /v1/online/:providerId/match-playlists -> { success, started, batchId, total, alreadyMatched }
//   GET  /v1/online/:providerId/match-playlists/status?batchId= -> { status, total, done, current, results, error }
onlineRoutes.post("/v1/online/:providerId/match-playlists", async (c) => {
  const providerId = c.req.param("providerId");
  if (!providerId) return c.json({ success: false, error: "缺少在线源 id" });
  const configured = getConfiguredProvider(providerId);
  if (!configured) return c.json({ success: false, error: "在线源未启用或未配置" });

  // 收集所有含未匹配条目的歌单(entryCount > 0)。
  // 单条 GROUP BY 聚合替代「每歌单全量扫描」的 N+1 查询。
  const all = db.select().from(playlists).all();
  const allById = new Map(all.map((p) => [p.id, p]));
  const targets: { id: string; name: string; count: number }[] = [];
  const counts = sqlite.prepare(`
    SELECT playlist_id AS id, COUNT(*) AS count
    FROM playlist_songs
    WHERE playable = 0 AND song_id IS NULL
      AND external_title IS NOT NULL AND external_title != ''
    GROUP BY playlist_id
  `).all() as { id: string; count: number }[];
  for (const r of counts) {
    const pl = allById.get(r.id);
    if (!pl) continue;
    targets.push({ id: pl.id, name: pl.name || pl.id, count: Number(r.count) });
  }
  if (targets.length === 0) return c.json({ success: true, started: false, total: 0, alreadyMatched: true });

  const batchId = `batch-match-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const job = { status: "running", startedAt: new Date().toISOString(), finishedAt: undefined as string | undefined, total: targets.length, done: 0, current: "", results: [] as any[], error: null as string | null };
  batchMatchJobs.set(batchId, job);
  (async () => {
    // 批量匹配在一次性批量子进程里执行(方案3);进度经 IPC 转发,全局批量闸由
    // runBatchJob 持有(整个批量适配作为一个批量任务参与全局互斥)。
    try {
      const { result } = await runBatchJob("match-playlists", { providerId }, {
        onProgress: (p) => { if (p) Object.assign(job, { done: p.done, total: p.total, current: p.current || "" }); },
      });
      job.results = Array.isArray(result?.results) ? result.results : [];
      Object.assign(job, { status: "completed", done: result?.done ?? job.total, finishedAt: new Date().toISOString() });
    } catch (e: any) {
      job.error = String(e?.message || e);
      Object.assign(job, { status: "failed", finishedAt: new Date().toISOString() });
    }
  })();
  return c.json({ success: true, started: true, batchId, total: targets.length });
});

onlineRoutes.get("/v1/online/:providerId/match-playlists/status", (c) => {
  const batchId = c.req.query("batchId");
  if (!batchId) return c.json({ success: false, error: "缺少 batchId" });
  const job = batchMatchJobs.get(batchId);
  if (!job) return c.json({ success: false, error: "任务不存在" }, 404);
  return c.json({ success: true, status: job.status, startedAt: job.startedAt, finishedAt: job.finishedAt, total: job.total, done: job.done, current: job.current, results: job.results, error: job.error });
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
      externalSongId: entry.externalSongId || undefined,
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

// ==================== Daily-recommend playlists (按渠道查看各平台推荐) ====================

// Fetch go-music-dl's /music/recommend, grouped by channel (netease/qq/kugou/kuwo).
// GET /v1/online/:providerId/recommend
onlineRoutes.get("/v1/online/:providerId/recommend", async (c) => {
  const providerId = c.req.param("providerId");
  if (!providerId) return c.json({ success: false, error: "缺少在线源 id" });
  const configured = getConfiguredProvider(providerId);
  if (!configured || !configured.provider.recommend) return c.json({ success: false, error: "在线源不支持推荐歌单" });
  try {
    const result = await configured.provider.recommend(configured.config);
    // Annotate each playlist with whether it's already imported locally.
    for (const ch of result.channels) {
      for (const pl of ch.playlists) {
        pl["imported"] = !!findRecommendPlaylist(pl.id);
      }
    }
    return c.json({ success: true, ...result });
  } catch (e: any) {
    return c.json({ success: false, error: e.message || "获取推荐歌单失败" });
  }
});

// List local daily-recommend playlists that were imported from the provider.
// GET /v1/online/:providerId/recommend/local
onlineRoutes.get("/v1/online/:providerId/recommend/local", (c) => {
  const all = db.select().from(playlists).all();
  const list = all.filter((p) => isDailyRecommendPlaylist(p)).map((p) => ({
    id: p.id, name: p.name, source: p.sourcePlatform || "", imported: true, coverArt: p.coverArt ? `pl-${p.id}` : null, songCount: p.songCount || 0,
    _remoteId: p.externalId || "",
  }));
  return c.json({ success: true, playlists: list });
});

// Import (or full-replace) one recommended playlist into a local playlist.
// POST /v1/online/:providerId/recommend/import { source, id, name, cover, creator, trackCount }
onlineRoutes.post("/v1/online/:providerId/recommend/import", async (c) => {
  const providerId = c.req.param("providerId");
  if (!providerId) return c.json({ success: false, error: "缺少在线源 id" });
  const configured = getConfiguredProvider(providerId);
  if (!configured?.provider.playlistSongs) return c.json({ success: false, error: "在线源未启用或未配置" });
  const user = c.get("user");
  const body = await c.req.json().catch(() => ({}));
  if (!body.source || !body.id) return c.json({ success: false, error: "缺少推荐歌单 source/id" });
  const info = { id: String(body.id), source: String(body.source), name: String(body.name || ""), creator: String(body.creator || ""), cover: String(body.cover || ""), trackCount: String(body.trackCount || ""), link: String(body.link || "") };
  try {
    const result = await importRecommendPlaylist(providerId, info, { userId: user?.id });
    return c.json(result);
  } catch (e: any) {
    // 沙箱限制错误透传 sandboxCode/hint,前端可展示「错误码 + 说明 + 修复提示」。
    return c.json({
      success: false,
      error: e.message || "导入推荐歌单失败",
      sandboxCode: e?.sandboxCode,
      hint: e?.hint,
    });
  }
});

// Re-import all locally-imported daily-recommend playlists (full-replace each).
// 聚合「同步所有平台」:
//   ① 路径 A 公开推荐歌单全量重导(后台执行,状态可查);
//   ② 所有 recommendPlaylist 能力插件(go-music-dl 私人歌单 / listenbrainz 推荐)
//      经 jobRunner 异步 runDailyJob(force)——per-plugin 串行锁自动防撞车。
// 立即返回(不阻塞 HTTP),前端轮询各任务状态:
//   GET /v1/online/:providerId/recommend/sync-all/status(路径 A)
//   GET /v1/plugins/:id/job(各插件)
// POST /v1/online/:providerId/recommend/sync-all
onlineRoutes.post("/v1/online/:providerId/recommend/sync-all", async (c) => {
  touch(); // 标记活动:聚合同步所有平台
  const providerId = c.req.param("providerId");
  if (!providerId) return c.json({ success: false, error: "缺少在线源 id" });
  const configured = getConfiguredProvider(providerId);
  if (!configured) return c.json({ success: false, error: "在线源未启用或未配置" });

  // ① 路径 A 推荐歌单重导(后台,状态存 syncAllState)。
  const existing = syncAllState.get(providerId);
  if (existing?.running) return c.json({ success: false, error: "同步任务进行中,请稍候" }, 409);
  const state = { running: true, startedAt: new Date().toISOString(), finishedAt: undefined as string | undefined, result: null as any, error: null as string | null };
  syncAllState.set(providerId, state);
  (async () => {
    // 路径 A 在一次性批量子进程里执行(方案3),全局批量闸由 runBatchJob 持有。
    try {
      const { result } = await runBatchJob("recommend-sync-all", { providerId, userId: c.get("user")?.id });
      Object.assign(state, { running: false, result, finishedAt: new Date().toISOString() });
    } catch (e: any) {
      Object.assign(state, { running: false, error: String(e?.message || e), finishedAt: new Date().toISOString() });
    }
  })();

  // ② 所有 recommendPlaylist 插件 runDailyJob(force)(仅外置:内置 daily/local 是
  //    dailyPlaylist/localPlaylist 能力,不在此集合,不会误触发)。
  const tasks: { pluginId: string; started: boolean; alreadyRunning: boolean }[] = [];
  for (const { manifest } of getEnabledByCapability("recommendPlaylist")) {
    if (!manifest || !manifest.id) continue;
    const r = runPluginJob(manifest.id, "runDailyJob", { force: true });
    tasks.push({ pluginId: manifest.id, started: r.started, alreadyRunning: r.alreadyRunning });
  }

  return c.json({ success: true, started: true, pathA: { running: true }, tasks });
});

// 路径 A(公开推荐歌单重导)任务状态查询。
// GET /v1/online/:providerId/recommend/sync-all/status
onlineRoutes.get("/v1/online/:providerId/recommend/sync-all/status", (c) => {
  const providerId = c.req.param("providerId");
  const st = syncAllState.get(providerId);
  if (!st) return c.json({ success: false, error: "尚无同步记录" }, 404);
  return c.json({ success: true, running: st.running, startedAt: st.startedAt, finishedAt: st.finishedAt, result: st.result, error: st.error });
});

// Manually purge expired unreferenced web songs for a provider (admin).
// Honors the plugin's webSongsMode/webSongsRetentionDays config.
// POST /v1/online/:providerId/purge-web-songs
onlineRoutes.post("/v1/online/:providerId/purge-web-songs", adminMiddleware, async (c) => {
  const providerId = c.req.param("providerId");
  if (!providerId) return c.json({ success: false, error: "缺少在线源 id" });
  if (!getConfiguredProvider(providerId)) return c.json({ success: false, error: "在线源未启用或未配置" });
  try {
    // 清理在一次性批量子进程里执行(方案3);结果经 IPC 回传。
    const { result } = await runBatchJob("purge-web-songs", { providerId });
    return c.json({ success: true, ...result });
  } catch (e: any) {
    return c.json({ success: false, error: e.message || "清理失败" });
  }
});
