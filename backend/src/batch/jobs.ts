// ==================== 批量任务处理器(子进程侧) ====================
//
// 每个处理器 = 一段既有批量流程的薄封装。子进程已完成 bootstrap(内置插件 + DB +
// 外置插件发现),可从自身注册表/DB 重建 provider/config/plugin 等运行时对象——
// args 只携带 JSON 安全的最小入参,不传函数/实例。
//
// 注意:这里绝不 import routes/*(那会连带拉起 HTTP/WS/播放器)。全部经
// services/pluginAccess.ts / plugins/registry.ts / services/source/online/* 调用,
// 与主进程共享同一批 service 实现(同一份代码),只是跑在隔离的进程里。

import { db, sqlite } from "../db/index.js";
import { playlists, artists, mediaSources } from "../db/schema.js";
import { eq, and } from "drizzle-orm";
import { getEnabledByCapability, getEnabledSourcePlugins, getPluginConfig, getPlugin } from "../plugins/registry.js";
import { playlistSyncApi } from "../services/pluginAccess.js";
import { importPlaylistFromUrl } from "../services/plugin/playlistImport.js";
import { importRemotePlaylistLike } from "../services/plugin/remoteImport.js";
import { cacheRemoteCover } from "../services/playlistCover.js";
import { getConfiguredProvider } from "../services/source/online/index.js";
import { importOnlineSongs } from "../services/source/online/service.js";
import { matchUnmatchedPlaylistEntries } from "../services/source/online/match.js";
import { syncAllRecommendPlaylists } from "../services/source/online/recommendImport.js";
import { purgeExpiredWebSongs } from "../services/source/online/purge.js";
import { scanLocalSource, scanWebDAVSource } from "../services/source/scanner.js";
import { scrapeArtistList } from "../services/scraper/artist.js";
import { collectCandidates, runBackfillLoop, runBackfillChunked } from "../services/backfill.js";
import { dailyRecommendApi, localRecommendApi, comboPlaylistApi } from "../services/pluginAccess.js";
import type { BackfillKind } from "../services/backfill.js";
import type { BatchJobKind } from "./types.js";
import { createLogger } from "../utils/logger.js";

const log = createLogger("batch-job");

export interface BatchJobContext {
  /** 进度上报(经 IPC 转发给主进程,主进程再落到各自的状态 Map)。 */
  onProgress: (payload: any) => void;
  /** 主进程 abort(扫描停止)时触发。 */
  signal: AbortSignal;
}

export type BatchJobHandler = (args: Record<string, any>, ctx: BatchJobContext) => Promise<any>;

/** 调插件 impl 上的方法(手动刷新 / 聚合同步 Path B 复用)。 */
async function runPluginMethod(pluginId: string, method: string, opts: any): Promise<any> {
  const reg = getPlugin(pluginId);
  if (!reg || typeof reg.impl?.[method] !== "function") {
    throw new Error(`插件 ${pluginId} 未启用或未实现 ${method}`);
  }
  return reg.impl[method](opts || {});
}

// ---------- 每日推荐全管线(镜像 index.ts runDailyJobs 的循环) ----------
// 推荐插件直接在子进程内 await(不再经 jobRunner),组合歌单在源歌单之后跑,
// 平台推荐/网页歌清理按 capability 遍历启用 source 插件。
async function dailyJobsHandler(_args: Record<string, any>, _ctx: BatchJobContext): Promise<any> {
  for (const cap of ["dailyPlaylist", "localPlaylist", "recommendPlaylist"] as const) {
    for (const { manifest, impl } of getEnabledByCapability(cap)) {
      if (typeof impl?.runDailyJob !== "function") continue;
      try {
        const summary = await impl.runDailyJob();
        if (summary) log.info(`[DAILY-SCHEDULER] ${manifest.id}: ${summary}`);
      } catch (e: any) {
        log.error(`[DAILY-SCHEDULER] ${manifest.id} daily job error`, { err: e.message || e });
      }
    }
  }
  for (const { manifest, impl } of getEnabledByCapability("comboPlaylist")) {
    if (typeof impl?.runDailyJob !== "function") continue;
    try {
      const summary = await impl.runDailyJob();
      if (summary) log.info(`[DAILY-SCHEDULER] ${manifest.id}: ${summary}`);
    } catch (e: any) {
      log.error(`[DAILY-SCHEDULER] ${manifest.id} combo job error`, { err: e.message || e });
    }
  }
  for (const { manifest } of getEnabledSourcePlugins()) {
    const caps = manifest.capabilities;
    if (caps.includes("recommend")) {
      try {
        const r = await syncAllRecommendPlaylists(manifest.id, {});
        if (r.synced > 0 || r.failed > 0) {
          log.info(`[DAILY-SCHEDULER] refreshed ${r.synced} ${manifest.id} daily-recommend playlists, errors: ${r.failed}`);
        }
      } catch (e: any) {
        log.error(`[DAILY-SCHEDULER] ${manifest.id} recommend sync error`, { err: e.message || e });
      }
    }
    if (caps.includes("webRotation")) {
      try {
        const r = purgeExpiredWebSongs(manifest.id);
        if (r.purged > 0 || r.errors > 0) {
          log.info(`[DAILY-SCHEDULER] ${manifest.id} web-song purge: ${r.purged} removed, ${r.covers} covers, errors: ${r.errors}`);
        }
      } catch (e: any) {
        log.error(`[DAILY-SCHEDULER] ${manifest.id} web-song purge error`, { err: e.message || e });
      }
    }
  }
  return { ok: true };
}

// ---------- 6h 维护(镜像 index.ts 维护循环;play_history 清理留在主进程) ----------
async function maintenanceHandler(_args: Record<string, any>, _ctx: BatchJobContext): Promise<any> {
  for (const { manifest, impl } of getEnabledByCapability("playlistSync")) {
    if (typeof impl?.runSyncJob !== "function") continue;
    try {
      const summary = await impl.runSyncJob({});
      if (summary) log.info(`[AUTO-SYNC] ${manifest.id}: ${summary}`);
    } catch (e: any) {
      log.error(`[AUTO-SYNC] ${manifest.id} sync error`, { err: e.message || e });
    }
  }
  const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
  const recent = db.select().from(artists).all()
    .filter(a => !a.coverArt && (a.createdAt || "") >= since);
  if (recent.length > 0) {
    const r = await scrapeArtistList(recent.map(a => a.id));
    log.info(`[ARTIST-SCRAPE] scheduled run: scraped ${r.scraped}, skipped ${r.skipped}, errors ${r.errors.length}`);
  }
  return { ok: true };
}

// ---------- 媒体源扫描 + 扫描后新增歌手刮削(与主进程路由一致) ----------
async function scanHandler(args: Record<string, any>, ctx: BatchJobContext): Promise<any> {
  const sourceId = String(args.sourceId);
  const mode: "full" | "incremental" = args.mode === "incremental" ? "incremental" : "full";
  const source = db.select().from(mediaSources).where(eq(mediaSources.id, sourceId)).get();
  if (!source) throw new Error("媒体源不存在");
  const config = JSON.parse(source.config || "{}");
  const preScanArtistIds = new Set(db.select().from(artists).all().map(a => a.id));

  const onScan = (p: any) => ctx.onProgress({ stage: "scan", ...p });
  let result: any;
  if (source.type === "webdav") {
    result = await scanWebDAVSource(sourceId, config, mode, onScan, ctx.signal);
  } else if (source.type === "local") {
    result = await scanLocalSource(sourceId, config, mode, onScan, ctx.signal);
  } else {
    throw new Error("不支持的媒体源类型");
  }
  if (ctx.signal.aborted) return { result, aborted: true, scrape: null };

  // 只刮削本次新增且无封面的歌手(QQ 优先 / 网易云兜底),失败不阻塞扫描完成。
  const newArtists = db.select().from(artists).all()
    .filter(a => !preScanArtistIds.has(a.id) && !a.coverArt);
  if (newArtists.length > 0) {
    ctx.onProgress({ stage: "scrape-start", total: newArtists.length });
    try {
      const scrape = await scrapeArtistList(newArtists.map(a => a.id), (p: any) => ctx.onProgress({ stage: "scrape", ...p }));
      ctx.onProgress({ stage: "scrape-done", progress: scrape });
      return { result, aborted: false, scrape };
    } catch (e: any) {
      ctx.onProgress({ stage: "scrape-failed", error: String(e?.message || e) });
      return { result, aborted: false, scrape: null };
    }
  }
  return { result, aborted: false, scrape: null };
}

// ---------- URL 歌单导入(镜像主进程路由的导入闭包) ----------
async function playlistImportHandler(args: Record<string, any>, _ctx: BatchJobContext): Promise<any> {
  const url = String(args.url || "");
  const userId = args.userId || "";
  if (!url) throw new Error("缺少歌单链接");

  const imported = await importPlaylistFromUrl(url);
  const name = (String(args.name || "") || imported.name || "导入歌单").trim();

  // Upsert:同一用户重复导入同链接 → 原位增量重建,不产生重复歌单。
  const existing = db.select().from(playlists)
    .where(and(eq(playlists.sourceUrl, url), eq(playlists.ownerId, userId)))
    .get();

  let id: string;
  if (existing) {
    id = existing.id;
    if (imported.coverUrl) {
      const cached = await cacheRemoteCover(imported.coverUrl, `pl-${id}`, true);
      const upd: any = { updatedAt: new Date().toISOString() };
      if (args.name) upd.name = name;
      if (cached) upd.coverArt = cached;
      db.update(playlists).set(upd).where(eq(playlists.id, id)).run();
    } else if (args.name) {
      db.update(playlists).set({ name, updatedAt: new Date().toISOString() }).where(eq(playlists.id, id)).run();
    }
  } else {
    id = `pl-${Date.now()}`;
    let coverRef: string | undefined = undefined;
    if (imported.coverUrl) {
      const cached = await cacheRemoteCover(imported.coverUrl, `pl-${id}`);
      if (cached) coverRef = cached;
    }
    db.insert(playlists).values({
      id, name, ownerId: userId,
      sourceUrl: url,
      sourcePlatform: imported.platform,
      externalId: url,
      coverArt: coverRef,
      syncEnabled: args.autoSync ? 1 : 0,
    }).run();
  }

  const sync = playlistSyncApi();
  if (!sync) throw new Error("歌单同步插件未启用");
  const result = await sync.rebuildPlaylistEntries(id, imported, {
    userId,
    notes: `来自歌单「${name}」导入`,
  });
  return {
    success: true, playlistId: id, name, platform: imported.platform,
    trackCount: result.total, matched: result.matched, unmatched: result.unmatched,
    wishAdded: result.wishAdded, coverUrl: imported.coverUrl, autoSync: !!args.autoSync,
  };
}

// ---------- 手动同步一张歌单 ----------
async function playlistSyncHandler(args: Record<string, any>, _ctx: BatchJobContext): Promise<any> {
  const sync = playlistSyncApi();
  if (!sync) throw new Error("歌单同步插件未启用");
  return sync.syncPlaylist(String(args.playlistId), { userId: args.userId });
}

// ---------- 歌单/专辑搜索「加入库」(共用 importRemotePlaylistLike) ----------
async function remoteImportHandler(args: Record<string, any>, _ctx: BatchJobContext): Promise<any> {
  const providerId = String(args.providerId);
  const lookupCap = String(args.lookupCap || "playlistSearch") as "playlistSearch" | "albumSearch";
  const lookup = getEnabledByCapability(lookupCap).find(p => p.manifest.id === providerId);
  if (!lookup || typeof lookup.impl?.playlistSongs !== "function") {
    throw new Error("插件缺少 playlistSongs 能力(无法拉取歌曲)");
  }
  return importRemotePlaylistLike({
    providerId,
    plugin: lookup.impl,
    config: getPluginConfig(providerId) || {},
    userId: args.userId,
    source: String(args.source || ""),
    id: String(args.id || ""),
    name: String(args.name || ""),
    cover: String(args.cover || ""),
    sourceUrl: String(args.sourceUrl || ""),
  });
}

// ---------- 歌曲搜索「加入库」(fingerprint 去重) ----------
async function songSearchImportHandler(args: Record<string, any>, _ctx: BatchJobContext): Promise<any> {
  const list: any[] = Array.isArray(args.songs) ? args.songs : [];
  const imp = await importOnlineSongs(String(args.providerId), list, { userId: args.userId, interactive: true });
  if (!imp?.songs?.length) throw new Error("歌曲入库失败,请检查在线源配置");
  return {
    success: true, added: imp.added, deduped: imp.deduped, failed: imp.failed,
    trackCount: imp.songs.length, ids: imp.songs.map((s: any) => s.id),
    imported: imp.songs.map((s: any) => ({ id: s.id, fingerprint: s.fingerprint })),
  };
}

// ---------- 在线匹配一张歌单 ----------
async function matchPlaylistHandler(args: Record<string, any>, ctx: BatchJobContext): Promise<any> {
  const providerId = String(args.providerId);
  const configured = getConfiguredProvider(providerId);
  if (!configured) throw new Error("在线源未启用或未配置");
  return matchUnmatchedPlaylistEntries(
    providerId,
    configured.config,
    configured.provider,
    String(args.playlistId),
    (done, total) => ctx.onProgress({ done, total }),
  );
}

// ---------- 在线批量匹配所有含占位条目的歌单 ----------
async function matchPlaylistsHandler(args: Record<string, any>, ctx: BatchJobContext): Promise<any> {
  const providerId = String(args.providerId);
  const configured = getConfiguredProvider(providerId);
  if (!configured) throw new Error("在线源未启用或未配置");

  const all = db.select().from(playlists).all();
  const allById = new Map(all.map(p => [p.id, p]));
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
  if (targets.length === 0) return { alreadyMatched: true, total: 0, done: 0, results: [] };

  const results: any[] = [];
  for (let i = 0; i < targets.length; i++) {
    const t = targets[i];
    ctx.onProgress({ done: i, total: targets.length, current: t.name });
    try {
      const r = await matchUnmatchedPlaylistEntries(providerId, configured.config, configured.provider, t.id);
      results.push({ playlistId: t.id, name: t.name, count: t.count, ...r });
    } catch (e: any) {
      results.push({ playlistId: t.id, name: t.name, count: t.count, error: String(e?.message || e) });
    }
  }
  ctx.onProgress({ done: targets.length, total: targets.length, current: "" });
  return { alreadyMatched: false, total: targets.length, done: targets.length, results };
}

// ---------- 平台每日推荐全量重导(路径 A) ----------
async function recommendSyncAllHandler(args: Record<string, any>, _ctx: BatchJobContext): Promise<any> {
  return syncAllRecommendPlaylists(String(args.providerId), { userId: args.userId });
}

// ---------- 过期未引用网页歌曲清理 ----------
async function purgeWebSongsHandler(args: Record<string, any>, _ctx: BatchJobContext): Promise<any> {
  return purgeExpiredWebSongs(String(args.providerId));
}

// ---------- 批量歌手信息刮削 ----------
async function scrapeArtistsHandler(args: Record<string, any>, ctx: BatchJobContext): Promise<any> {
  const ids: string[] = Array.isArray(args.artistIds) ? args.artistIds.map(String) : [];
  if (ids.length === 0) return { scraped: 0, skipped: 0, errors: [] };
  return scrapeArtistList(ids, (p: any) => ctx.onProgress(p));
}

// ---------- 歌词/封面批量补全(C 按钮) ----------
// 全量候选查询 + 逐首补全都在子进程内跑,峰值内存随进程退出归还。
async function backfillHandler(args: Record<string, any>, ctx: BatchJobContext): Promise<any> {
  const kind = String(args.kind) as BackfillKind;
  if (kind !== "lyrics" && kind !== "covers" && kind !== "covers-batch") {
    throw new Error(`未知批量补全类型: ${kind}`);
  }
  const rows = collectCandidates(kind);
  const onProgress = (p: any) => ctx.onProgress({ ...p, total: rows.length });
  if (kind === "covers-batch") {
    return runBackfillChunked(rows.map((r: any) => r.id), onProgress, ctx.signal);
  }
  return runBackfillLoop(kind, rows, onProgress, ctx.signal);
}

// ---------- 推荐手动刷新默认路径(每日/本地/漫游) ----------
// 镜像主进程路由的旧同步闭包:按 targets 顺序以 force + seedSalt 重新触发生成。
// 经 pluginAccess 能力门面调用,不写死插件名;进度按 target 回报。
async function recommendRefreshHandler(args: Record<string, any>, ctx: BatchJobContext): Promise<any> {
  const targets: string[] = Array.isArray(args.targets) ? args.targets.map(String) : ["daily", "local", "roam"];
  const seedSalt = typeof args.seedSalt === "number" ? args.seedSalt : Math.floor(Math.random() * 1_000_000);
  const results: Record<string, any> = {};
  let done = 0;
  for (const t of targets) {
    if (ctx.signal.aborted) throw new Error("刷新任务被中止");
    ctx.onProgress({ target: t, done, total: targets.length });
    if (t === "daily") {
      const api = dailyRecommendApi();
      if (!api) throw new Error("每日推荐插件未启用");
      results.daily = await api.generateDailyPlaylist(new Date(), { force: true, seedSalt });
    } else if (t === "local") {
      const api = localRecommendApi();
      if (!api || typeof api.generateLocalDailyPlaylist !== "function") throw new Error("本地推荐插件未启用");
      results.local = await api.generateLocalDailyPlaylist(new Date(), { force: true, seedSalt });
    } else if (t === "roam") {
      const api = comboPlaylistApi();
      if (!api || typeof api.generateComboPlaylist !== "function") throw new Error("今日漫游插件未启用");
      results.roam = await api.generateComboPlaylist({ force: true });
    }
    done++;
    ctx.onProgress({ target: t, done, total: targets.length });
  }
  return { success: true, seedSalt, results };
}

/** 任务类型 → 处理器映射(子进程 dispatch 用)。 */
export const batchJobHandlers: Record<BatchJobKind, BatchJobHandler> = {
  "daily-jobs": dailyJobsHandler,
  "maintenance": maintenanceHandler,
  "plugin-job": async (args) => runPluginMethod(String(args.pluginId), String(args.method), args.opts || {}),
  "scan": scanHandler,
  "playlist-import": playlistImportHandler,
  "playlist-sync": playlistSyncHandler,
  "playlist-search-import": remoteImportHandler,
  "album-search-import": remoteImportHandler,
  "song-search-import": songSearchImportHandler,
  "match-playlist": matchPlaylistHandler,
  "match-playlists": matchPlaylistsHandler,
  "recommend-sync-all": recommendSyncAllHandler,
  "purge-web-songs": purgeWebSongsHandler,
  "scrape-artists": scrapeArtistsHandler,
  "backfill": backfillHandler,
  "recommend-refresh": recommendRefreshHandler,
};
