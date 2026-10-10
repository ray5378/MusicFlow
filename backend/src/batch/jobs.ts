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
import { matchUnmatchedPlaylistEntries, crossVerifySongs } from "../services/source/online/match.js";
import { syncAllRecommendPlaylists } from "../services/source/online/recommendImport.js";
import { purgeExpiredWebSongs } from "../services/source/online/purge.js";
import { systemOwnerId } from "../services/plugin/shared.js";
import { scanLocalSource, scanWebDAVSource } from "../services/source/scanner.js";
import { scrapeArtistList } from "../services/scraper/artist.js";
import { collectCandidates, runBackfillLoop, runBackfillChunked } from "../services/backfill.js";
import { dailyRecommendApi, localRecommendApi, comboPlaylistApi } from "../services/pluginAccess.js";
import type { BackfillKind } from "../services/backfill.js";
import type { BatchJobKind } from "./types.js";
import { createLogger } from "../utils/logger.js";
import { getPluginManifest } from "../plugins/registry.js";
import { getFetchJob, saveFetchJobItems, saveFetchJobImports, updateFetchJobStatus } from "../services/fetch/jobStore.js";
import type { FetchJobItem, FetchJobImport, FetchJobCounts } from "../services/fetch/jobStore.js";
import { resolveFetchConfig } from "../services/fetch/config.js";
import { recordLibraryAttempt, LIBRARY_TARGET_PREFIX } from "../services/fetch/library.js";
import { runFetchPipeline } from "../services/fetch/orchestrator.js";
import type { FetchItemOutcome } from "../services/fetch/orchestrator.js";
import { ensureDownloadSource } from "../services/fetch/source.js";
import type { TaskStatus } from "../services/fetch/types.js";

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

// ---------- 每日推荐全管线 / 启动补拉(同一条管线,两种门控) ----------
//
// 门控从「全局一把梭」细化为「按插件配置」:
//   - scheduleEnabled(默认 true) :是否参与每日定点同步;
//   - runOnBoot      (默认 false):容器/进程启动时是否补拉一次。
// 两个键由各插件的 configSchema 声明(内置插件在代码里,外置插件在 plugin.json),
// 用户可在插件配置页开关;未声明或未配置的插件按默认值处理。
//
// 关键:配置**缺失一律按默认值**。默认值只在插件首次安装时落库,存量安装的
// config 里没有这两个键,缺失即默认——保证老用户升级后行为连续(该跑的照跑)。

/** 插件是否声明了某项定时能力(manifest.schedules)。
 *  返回 true = 该项开关存在且应由用户配置决定;false = 插件不参与此项调度。
 *  这是宿主调度器对插件自身声明的尊重:即使 config 有这个键,schedules:false
 *  或 schedules:{ runOnBoot:false } 的插件也不应该被该项调度跑。 */
function pluginDeclaresSchedule(id: string, field: "scheduleEnabled" | "runOnBoot"): boolean {
  const m = getPluginManifest(id);
  if (!m) return true; // manifest 未知时宽松处理(按默认推断)
  const s = m.schedules;
  if (s === undefined) return true; // 缺省 = 宿主自动推断,视为参与
  if (s === false) return false;
  if (s === true) return true;
  // 对象:按字段判断
  return (s as any)[field] === true;
}

/** 是否参与每日定点同步(缺失=开)。插件声明 schedules:false 或
 *  schedules:{ scheduleEnabled:false } 时强制不跑。 */
function scheduleEnabledFor(id: string): boolean {
  if (!pluginDeclaresSchedule(id, "scheduleEnabled")) return false;
  const cfg = getPluginConfig(id);
  if (!cfg) return true;
  return cfg.scheduleEnabled !== false;
}

/** 是否在启动时补拉一次(缺失=关)。插件声明 schedules:false 或
 *  schedules:{ runOnBoot:false } 时强制不跑。 */
function runOnBootFor(id: string): boolean {
  if (!pluginDeclaresSchedule(id, "runOnBoot")) return false;
  const cfg = getPluginConfig(id);
  if (!cfg) return false;
  return cfg.runOnBoot === true;
}

/**
 * 跑一遍全量同步管线。gate 决定每个插件本次是否参与,
 * 从而让「每日定点」与「启动补拉」复用同一段编排逻辑。
 */
async function runSyncPipeline(gate: (id: string) => boolean, tag: string): Promise<any> {
  let ran = 0;
  let skipped = 0;
  // 推荐插件直接在子进程内 await(不再经 jobRunner),组合歌单在源歌单之后跑,
  // 平台推荐/网页歌清理按 capability 遍历启用 source 插件。
  for (const cap of ["dailyPlaylist", "localPlaylist", "recommendPlaylist", "localPlatformRecommend"] as const) {
    for (const { manifest, impl } of getEnabledByCapability(cap)) {
      if (typeof impl?.runDailyJob !== "function") continue;
      if (!gate(manifest.id)) { skipped++; continue; }
      try {
        const summary = await impl.runDailyJob();
        ran++;
        if (summary) log.info(`[${tag}] ${manifest.id}: ${summary}`);
      } catch (e: any) {
        log.error(`[${tag}] ${manifest.id} daily job error`, { err: e.message || e });
      }
    }
  }
  for (const { manifest, impl } of getEnabledByCapability("comboPlaylist")) {
    if (typeof impl?.runDailyJob !== "function") continue;
    if (!gate(manifest.id)) { skipped++; continue; }
    try {
      const summary = await impl.runDailyJob();
      ran++;
      if (summary) log.info(`[${tag}] ${manifest.id}: ${summary}`);
    } catch (e: any) {
      log.error(`[${tag}] ${manifest.id} combo job error`, { err: e.message || e });
    }
  }
  // 歌单清理插件(playlistCleanup):在每日推荐/同步之后执行,清理低歌曲数歌单。
  for (const { manifest, impl } of getEnabledByCapability("playlistCleanup")) {
    if (typeof impl?.runDailyJob !== "function") continue;
    if (!gate(manifest.id)) { skipped++; continue; }
    try {
      const summary = await impl.runDailyJob();
      ran++;
      if (summary) log.info(`[${tag}] ${manifest.id}: ${summary}`);
    } catch (e: any) {
      log.error(`[${tag}] ${manifest.id} cleanup error`, { err: e.message || e });
    }
  }
  for (const { manifest } of getEnabledSourcePlugins()) {
    const caps = manifest.capabilities;
    if (caps.includes("recommend")) {
      if (!gate(manifest.id)) { skipped++; continue; }
      try {
        // D27 修复:导入歌单 owner_id 有外键,必须显式传归属用户;与 dailyRecommend/
        // localRecommend 写系统歌单的口径一致,取首个 admin(无 admin 时返回 "",D27 会优雅拒绝)。
        const r = await syncAllRecommendPlaylists(manifest.id, { userId: systemOwnerId() });
        if (r.synced > 0 || r.failed > 0) {
          log.info(`[${tag}] refreshed ${r.synced} ${manifest.id} daily-recommend playlists, errors: ${r.failed}`);
        }
      } catch (e: any) {
        log.error(`[${tag}] ${manifest.id} recommend sync error`, { err: e.message || e });
      }
    }
    if (caps.includes("webRotation")) {
      if (!gate(manifest.id)) { skipped++; continue; }
      try {
        const r = purgeExpiredWebSongs(manifest.id);
        if (r.purged > 0 || r.errors > 0) {
          log.info(`[${tag}] ${manifest.id} web-song purge: ${r.purged} removed, ${r.covers} covers, errors: ${r.errors}`);
        }
      } catch (e: any) {
        log.error(`[${tag}] ${manifest.id} web-song purge error`, { err: e.message || e });
      }
    }
  }
  log.info(`[${tag}] done: ${ran} plugin job(s) ran, ${skipped} skipped by config`);
  return { ok: true, ran, skipped };
}

/** 每日定点:跑所有 scheduleEnabled 的插件(默认全参与)。 */
async function dailyJobsHandler(_args: Record<string, any>, _ctx: BatchJobContext): Promise<any> {
  return runSyncPipeline(scheduleEnabledFor, "DAILY-SCHEDULER");
}

/** 启动补拉:只跑显式打开 runOnBoot 的插件(默认一个都不跑)。
 *  除推荐管线外,还补跑「歌单自动同步 / 歌手资料抓取」(runOnBoot=true 才跑),让
 *  这两类维护型插件同样受 runOnBoot 门控。 */
async function bootSyncHandler(_args: Record<string, any>, _ctx: BatchJobContext): Promise<any> {
  const sync = await runSyncPipeline(runOnBootFor, "BOOT-SYNC");
  const maint = await maintenanceGated(runOnBootFor, "BOOT-SYNC");
  return { ok: true, ran: (sync.ran || 0) + (maint.ran || 0), skipped: (sync.skipped || 0) + (maint.skipped || 0) };
}

/** 维护型步骤(歌单自动同步 + 新歌手封面刮削)。gate 决定本次是否执行。
 *  复用同一套 gate,让「每日定点」与「启动补拉」都能按插件自身配置门控:
 *    - 歌单自动同步(playlistSync / runSyncJob) → scheduleEnabled / runOnBoot
 *    - 歌手资料抓取(新歌手封面刮削)            → artistInfo 插件同开关 */
async function maintenanceGated(gate: (id: string) => boolean, tag: string): Promise<{ ran: number; skipped: number }> {
  let ran = 0;
  let skipped = 0;
  for (const { manifest, impl } of getEnabledByCapability("playlistSync")) {
    if (typeof impl?.runSyncJob !== "function") continue;
    if (!gate(manifest.id)) { skipped++; continue; }
    try {
      const summary = await impl.runSyncJob({});
      ran++;
      if (summary) log.info(`[${tag}] ${manifest.id}: ${summary}`);
    } catch (e: any) {
      log.error(`[${tag}] ${manifest.id} sync error`, { err: e?.message || e });
    }
  }
  const artistInfo = getEnabledByCapability("artistInfo")[0];
  if (artistInfo) {
    if (!gate(artistInfo.manifest.id)) { skipped++; }
    else {
      const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
      const recent = db.select().from(artists).all()
        .filter(a => !a.coverArt && (a.createdAt || "") >= since);
      if (recent.length > 0) {
        ran++;
        const r = await scrapeArtistList(recent.map(a => a.id));
        log.info(`[${tag}] artist scrape: scraped ${r.scraped}, errors ${r.errors.length}`);
      }
    }
  }
  return { ran, skipped };
}

// ---------- 6h 维护(镜像 index.ts 维护循环;play_history 清理留在主进程) ----------
async function maintenanceHandler(_args: Record<string, any>, _ctx: BatchJobContext): Promise<any> {
  const r = await maintenanceGated(scheduleEnabledFor, "AUTO-SYNC");
  return { ok: true, ...r };
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
    id = `pl-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
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
// 用户亲选道:SPEC 契约豁免(用户点的歌视为已验证),importOnlineSongs 显式 gate:"skip"。
// 可选二次门禁(core-import-gate.reverifyUserPicked,默认关):开启后先在线静默重验,
// 不命中的歌仍然入库(尊重亲选语义,不删),但计数与明细上报到任务结果供人工甄别。
async function songSearchImportHandler(args: Record<string, any>, _ctx: BatchJobContext): Promise<any> {
  const list: any[] = Array.isArray(args.songs) ? args.songs : [];
  const providerId = String(args.providerId);
  let reverify: { enabled: boolean; passed: number; rejected: number; rejectedTitles: string[] } | undefined;
  const gateCfg = (getPluginConfig("core-import-gate") || {}) as Record<string, unknown>;
  if (gateCfg.reverifyUserPicked === true && list.length) {
    try {
      const configured = getConfiguredProvider(providerId);
      if (configured) {
        const r = await crossVerifySongs(providerId, configured.config, configured.provider, list, { interactive: true });
        const verifiedIds = new Set(r.verified.map((s: any) => `${s.source}:${s.id}`));
        const rejectedSongs = list.filter((s: any) => !verifiedIds.has(`${s.source}:${s.id}`));
        reverify = {
          enabled: true,
          passed: r.verified.length,
          rejected: r.rejected,
          rejectedTitles: rejectedSongs.slice(0, 50).map((s: any) => [s.name, s.artist].filter(Boolean).join(" - ")),
        };
        log.warn("亲选道二次门禁:存在未命中候选(仍按亲选语义入库)", { providerId, rejected: r.rejected, titles: reverify.rejectedTitles });
      }
    } catch (e: any) {
      log.warn("亲选道二次门禁执行失败(不阻断导入)", { providerId, err: e?.message || e });
    }
  }
  const imp = await importOnlineSongs(providerId, list, { userId: args.userId, interactive: true, gate: "skip" });
  if (!imp?.songs?.length) throw new Error("歌曲入库失败,请检查在线源配置");
  return {
    success: true, added: imp.added, deduped: imp.deduped, failed: imp.failed,
    trackCount: imp.songs.length, ids: imp.songs.map((s: any) => s.id),
    imported: imp.songs.map((s: any) => ({ id: s.id, fingerprint: s.fingerprint })),
    ...(reverify ? { reverify } : {}),
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

// ---------- 网络音源下载入库(MusicFetch) ----------
// 按 chunk 分片执行:一次 batch job 只处理一片(cfg.chunkSize 默认 20),片间由主进程
// 释放全局批量闸再排队(M2 §2)。targets/config 一律从 fetch_jobs 表读(args 只带
// jobId/chunk,JSON 安全),跨片进度/重试/死信全落 fetch_jobs。

/** 本片计数累加到任务累计计数(跨片累计,不是覆盖)。 */
function addCounts(base: FetchJobCounts, delta: Partial<FetchJobCounts>): FetchJobCounts {
  return {
    total: base.total + (delta.total ?? 0),
    done: base.done + (delta.done ?? 0),
    failed: base.failed + (delta.failed ?? 0),
    skipped: base.skipped + (delta.skipped ?? 0),
    added: base.added + (delta.added ?? 0),
    updated: base.updated + (delta.updated ?? 0),
    bytes: base.bytes + (delta.bytes ?? 0),
  };
}

/** 流水线单曲结果 → fetch_jobs.items_json 元素。 */
function toJobItem(o: FetchItemOutcome): FetchJobItem {
  return {
    id: o.targetId,
    targetId: o.targetId,
    status: o.status,
    attempts: o.attempts,
    chosen: o.chosen,
    // detail（拒绝原因，如「预探估算 596kbps 不达假无损下限」）一并落库，任务详情可见
    rejected: (o.rejected ?? []).map((r) => ({ candidateId: r.candidateId, reason: r.reason, detail: r.detail })),
    bytes: o.bytes,
    cachePath: o.cachePath,
    finalPath: o.finalPath,
    errorCode: o.errorCode,
    errorMsg: o.errorMsg,
  };
}

/** 按 targetId 对齐合并本片结果到既有 items(保留其它片的条目与顺序)。 */
function mergeItems(existing: FetchJobItem[], outcomes: FetchItemOutcome[]): FetchJobItem[] {
  const incoming = outcomes.map(toJobItem);
  const byTarget = new Map(incoming.map((i) => [i.targetId, i]));
  const seen = new Set<string>();
  const out: FetchJobItem[] = [];
  for (const e of existing) {
    const hit = byTarget.get(e.targetId);
    if (hit) {
      out.push(hit);
      seen.add(e.targetId);
    } else out.push(e);
  }
  for (const i of incoming) if (!seen.has(i.targetId)) out.push(i);
  return out;
}

/** 按 itemId 对齐合并 imports(重试成功只更新不追加)。 */
function mergeImports(existing: FetchJobImport[], outcomes: FetchItemOutcome[]): FetchJobImport[] {
  const map = new Map(existing.map((i) => [i.itemId, i]));
  for (const o of outcomes) {
    if (o.status === "done") {
      map.set(o.targetId, { itemId: o.targetId, songId: o.songId, result: "added", filePath: o.finalPath });
    } else if (o.status === "skipped") {
      map.set(o.targetId, { itemId: o.targetId, songId: o.songId, result: "skipped", filePath: o.finalPath });
    } else if (o.status === "failed" || o.status === "cancelled") {
      map.set(o.targetId, { itemId: o.targetId, result: "failed", err: o.errorMsg });
    }
  }
  return [...map.values()];
}

async function fetchHandler(args: Record<string, any>, ctx: BatchJobContext): Promise<any> {
  const jobId = String(args.jobId ?? "");
  const job = getFetchJob(jobId);
  if (!job) throw new Error(`fetch job 不存在: ${jobId}`);

  const cfg = resolveFetchConfig(job.config);
  // 洗版模式（config_json.__upgrade）：覆盖成品根（/MUSIC/LOSSLESS）+ 原件处置。
  // 缺失时（普通下载任务）行为与现在**完全一致**。
  const upg = (job.config as any)?.__upgrade as
    | { downloadRootOverride?: unknown; originalDisposal?: unknown }
    | undefined;
  const downloadRootOverride =
    typeof upg?.downloadRootOverride === "string" && upg.downloadRootOverride
      ? upg.downloadRootOverride
      : undefined;
  const originalDisposal =
    upg?.originalDisposal && typeof upg.originalDisposal === "object"
      ? (upg.originalDisposal as {
          action: "keep" | "move" | "delete";
          backupDir?: string;
          allowedRoots: string[];
        })
      : undefined;
  // 全库下载模式（config_json.__library）：只迁移库行（web 行 → 新本地文件），不删任何文件。
  const migrateRowOnly = (job.config as any)?.__library?.migrateRowOnly === true;
  // ensureDownloadSource 必须建「覆盖后」那个根对应的源（洗版 → LOSSLESS 源）。
  const effRoot = downloadRootOverride || cfg.downloadRoot;
  const allTargets: any[] = Array.isArray(job.targets?.targets) ? job.targets.targets : [];
  const total = allTargets.length;
  const chunkSize = Number.isFinite(cfg.chunkSize) && cfg.chunkSize > 0 ? Math.floor(cfg.chunkSize) : 20;
  const chunk = Number.isFinite(Number(args.chunk)) ? Math.max(0, Math.floor(Number(args.chunk))) : 0;
  const start = chunk * chunkSize;
  const slice = allTargets.slice(start, start + chunkSize);
  const hasMore = start + slice.length < total;

  // 空片(越界 chunk):直接返回,不改状态。
  if (slice.length === 0) {
    return { jobId, chunk, hasMore: false, counts: job.counts, warnings: [] };
  }

  // 首片置 running;并在落盘前确保下载源存在(sourceId 写回,中途失败 UI 也能看到源)。
  if (chunk === 0) updateFetchJobStatus(jobId, "running");
  let sourceId = job.sourceId ?? "";
  if (!sourceId) {
    try {
      const r = ensureDownloadSource(
        effRoot,
        effRoot === cfg.losslessRoot ? "已下载无损音质" : "已下载流媒体音质",
      );
      sourceId = r.sourceId;
      updateFetchJobStatus(jobId, "running", { sourceId });
    } catch (e) {
      // 源登记失败不致命:流水线内部还会再试一次。
      log.warn("ensureDownloadSource 失败(继续)", { jobId, err: String((e as any)?.message || e) });
    }
  }

  // PATCH19 终态记账映射：targetId → songId（仅全库下载目标 `library:<songId>` 有库记账语义）。
  const librarySongIds = new Map<string, string>();
  for (const t of allTargets) {
    const tid = String(t?.id ?? "");
    if (tid.startsWith(LIBRARY_TARGET_PREFIX)) {
      librarySongIds.set(tid, tid.slice(LIBRARY_TARGET_PREFIX.length));
    }
  }
  /** 全库记账：条目终态即写 fetch_library_attempts（UPSERT 最新终态）。 */
  const recordLibraryTerminal = (o: FetchItemOutcome): void => {
    if (librarySongIds.size === 0) return;
    const st = String(o.status);
    // COOLDOWN_SKIPPED 不记账——记了会把冷却起点不断后推，反复触发的任务永远跑不动。
    const rec =
      st === "done" ||
      st === "failed" ||
      (st === "skipped" && o.errorCode !== "COOLDOWN_SKIPPED");
    if (!rec) return;
    const sid = librarySongIds.get(String(o.targetId));
    if (!sid) return;
    try {
      recordLibraryAttempt(sid, jobId, st);
    } catch {
      /* 记账失败不影响主流程 */
    }
  };

  // PATCH17 断点续跑：本片里已有终态（done/skipped/failed）的项直接跳过，只跑
  // 未处理/被中断（cancelled 或尚无结果）的项 —— 中断重跑不再从头重试整片。
  // done 项的 items 里带 songId（flush 反查后才增量落库），可安全跳过；cancelled
  // 项刻意不落库，重跑时照常处理。
  const TERMINAL_STATUSES = new Set(["done", "skipped", "failed"]);
  const terminalIds = new Set(
    job.items.filter((x) => TERMINAL_STATUSES.has(String(x.status))).map((x) => x.targetId),
  );
  const todo = slice.filter((t: any) => !terminalIds.has(String(t?.id)));

  if (todo.length === 0) {
    // 本片已全部有终态（中断重跑场景）：不碰流水线，直接推进下一片/落终态。
    if (!hasMore) {
      const c = job.counts;
      const anyFailed = c.failed > 0;
      const anyOk = c.done > 0 || c.skipped > 0;
      let status: TaskStatus;
      if (ctx.signal.aborted) status = "cancelled";
      else if (anyFailed && anyOk) status = "partial";
      else if (anyFailed) status = "failed";
      else status = "done";
      updateFetchJobStatus(jobId, status);
    }
    return { jobId, chunk, hasMore, counts: job.counts, warnings: [] };
  }

  const result = await runFetchPipeline({
    targets: todo,
    config: cfg,
    sourceId: sourceId || undefined,
    signal: ctx.signal,
    downloadRootOverride,
    originalDisposal,
    migrateRowOnly,
    // 🔴 progress 即心跳:每完成一首回报一次,防 15min 看门狗 SIGKILL。
    onProgress: (p) => ctx.onProgress({ stage: "fetch", ...p }),
    // PATCH17 增量落库：每首歌终态立刻进 fetch_jobs.items_json（done 项在 flush 反查
    // songId 后回调），中断重跑按终态秒跳。计数从 items 重推导（幂等，可安全覆盖）。
    onItem: (o) => {
      try {
        const fresh = getFetchJob(jobId);
        if (!fresh) return;
        const merged = mergeItems(fresh.items, [o]);
        const by = { done: 0, failed: 0, skipped: 0 };
        let bytes = 0;
        for (const it of merged) {
          if (it.status === "done") by.done++;
          else if (it.status === "failed") by.failed++;
          else if (it.status === "skipped") by.skipped++;
          if (it.bytes) bytes += it.bytes;
        }
        saveFetchJobItems(jobId, merged, {
          ...fresh.counts,
          total: allTargets.length,
          done: by.done,
          failed: by.failed,
          skipped: by.skipped,
          bytes,
        });
        // PATCH19 全库记账：条目终态即写 fetch_library_attempts（UPSERT 最新终态）。
        // 创建时整批预记的老做法会在中断/重启后把未处理歌锁进冷却期，废弃。
        recordLibraryTerminal(o);
      } catch {
        /* 增量落库失败不影响主流程（片尾还有全量落库兜底） */
      }
    },
  });

  // 本片结果合并进 fetch_jobs(按 targetId/itemId 对齐,不丢其它片)。
  const mergedItems = mergeItems(job.items, result.items);
  const mergedCounts = addCounts(job.counts, result.counts);
  saveFetchJobItems(jobId, mergedItems, mergedCounts);
  saveFetchJobImports(jobId, mergeImports(job.imports, result.items));
  // PATCH19 片尾兜底记账：onItem 被吞（增量落库异常）的终态项在此补记（UPSERT 幂等）。
  for (const o of result.items) recordLibraryTerminal(o);

  // 只有最后一片才落终态;非末片保持 running 等下一片。
  if (!hasMore) {
    let status: TaskStatus;
    const anyFailed = mergedCounts.failed > 0;
    const anyOk = mergedCounts.done > 0 || mergedCounts.skipped > 0;
    if (ctx.signal.aborted) status = "cancelled";
    else if (anyFailed && anyOk) status = "partial";
    else if (anyFailed) status = "failed";
    else status = "done";
    updateFetchJobStatus(jobId, status);
  }

  // PATCH21 观测修复：`result.warnings` 此前只被原样返回，而子进程返回值既不落库也不落日志
  // —— 流水线的关键告警（源整体故障保护、死链清理结果、台账写入失败…）等于**静默丢弃**，
  // 运维侧看不到「这次清理为什么没发生」。这里统一落到日志，保证任何一条告警都可追溯。
  for (const w of result.warnings) log.warn(`[fetch ${jobId.slice(0, 8)}] ${w}`);

  return { jobId, chunk, hasMore, counts: mergedCounts, warnings: result.warnings };
}

/** 任务类型 → 处理器映射(子进程 dispatch 用)。 */
export const batchJobHandlers: Record<BatchJobKind, BatchJobHandler> = {
  "daily-jobs": dailyJobsHandler,
  "boot-sync": bootSyncHandler,
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
  "fetch": fetchHandler,
};
