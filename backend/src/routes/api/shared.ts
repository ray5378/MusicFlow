// 自动生成 —— 由 index.ts 物理拆分而来。共享 import / 常量 / 工具函数 / 模块级状态。
// 零逻辑改动：内容与拆分前逐字一致（仅声明加了 export）。

import { Hono } from "hono";
import type { Context } from "hono";
import { db } from "../../db/index.js";
import { users, playlists, playlistSongs, songs, albums, artists, mediaSources, plugins, wishes, userFavoriteSongs, userFavoriteAlbums, userFavoriteArtists, playlistFavorites, playHistory, genres, deviceQueues } from "../../db/schema.js";
import { eq, like, inArray, or, and, sql, desc, asc, isNotNull, isNull, count, ne } from "drizzle-orm";
import { v4 as uuidv4 } from "uuid";
import { randomBytes } from "node:crypto";
import { apiError, BusinessErrorCode } from "../../utils/errors.js";
import { alignSeekSeconds } from "../../utils/seekGranularity.js";
import {
  sanitizeClientId,
  resolveLocalPeerId,
  maskLocalPeerId,
  buildLocalPeerId,
  userIdOfLocalPeer,
  clientIdOfLocalPeer,
} from "../../utils/peerId.js";
import { translate } from "../../i18n.js";
import { getRequestMetrics } from "../../middleware/metrics.js";
import md5 from "md5";
import { adminMiddleware, invalidateAuthCaches } from "../../middleware/auth.js";
import {
  PERM, PERMISSION_CATALOG, permMiddleware, rendererGrantParamMiddleware,
  hasPerm, canUseRenderer, canControlPeer, decoratePeersForClient, peerToDeviceKey,
  getUserPermissions, getUserRendererGrants, effectiveAccessView,
  replaceUserPermissions, replaceRendererGrants, grantRenderer, revokeRenderer, invalidateAccessCaches,
} from "../../services/access.js";
import { testWebDAVConnection, cleanupOrphans, ScanProgress } from "../../services/source/scanner.js";
import { encryptPassword } from "../../db/index.js";
import { ImportedPlaylist, ImportedTrack, parsePlaylistFile, NATIVE_APP } from "../../services/plugin/playlistImport.js";
import { clearLibraryIndex, getLibraryIndexStats } from "../../services/plugin/libraryIndex.js";
import { touch, registerCacheCleaner, reclaimNow, isIdle, getMemorySnapshot, getReclaimStatus } from "../../services/memory/reclaim.js";
import { getCoverCacheBytes } from "../../services/coverCache.js";
import { getRenderedCoverBytes } from "../../services/coverImage.js";
import { getLyricsCacheEntries } from "../../services/lyrics.js";
import { resolveLyricContent } from "../../services/lyricsStore.js";
import { runPluginJob, getPluginJobState } from "../../services/plugin/jobRunner.js";
import { currentPace, setPace, BatchPace, isBatchBusy } from "../../services/plugin/batchPacer.js";
import { startAsyncTask, getAsyncTask, anyTaskRunning } from "../../services/plugin/asyncTasks.js";
import { runBatchJob } from "../../batch/runner.js";
import { formatDailyTime, rearmDailyScheduler } from "../../services/dailyScheduler.js";
import { anyJobRunning } from "../../services/plugin/jobRunner.js";
import { isFixedRecommendPlaylist, ensureHomePlaylist } from "../../services/plugin/fixedRecommend.js";
import { maybeRefreshRandomSongs, RANDOM_PLAYLIST_ID } from "../../services/plugin/randomSongs.js";
import { ensurePlayableStream, getCachedPlayability } from "../../services/source/online/streamFallback.js";
import { deleteAnalysis, deleteAnalysisMany } from "../../services/audio/analysisStore.js";
import { probeLocalSourceOk } from "../../utils/localSourceProbe.js";
import { dailyRecommendApi, localRecommendApi, comboPlaylistApi, dailyRecommendTag, dailyRecommendHomeCount, listHomeCardPlugins, homePositionConflictForSave, playlistSyncApi } from "../../services/pluginAccess.js";
import { sqlite } from "../../db/index.js";
import { isImportedPlaylist, isPluginSyncPlaylist } from "../../utils/playlist.js";
import { songSourceInfo, serializeSongRow, attachGroupSources, resolveSongCover } from "../../utils/songSource.js";
import { getArtistList, setArtistList, invalidateArtistList } from "../../utils/artistListCache.js";
import { clearPlaylistCoverCache } from "../../services/playlistCover.js";
import { getSetting, setSetting, getSettingBool } from "../../services/settings.js";
import { logLevelSnapshot, saveLogLevel } from "../../services/logSettings.js";
import { isLogLevel } from "../../utils/logger.js";
import { getProxyConfig, normalizeProxyUrl, testProxyConnection } from "../../services/proxy.js";
import { startBackfill, backfillStatus } from "../../services/backfill.js";
import { sendToLocalPeer, countLiveConnections } from "../../services/ws/index.js";
import { isDailyRecommendPlaylist, findRecommendPlaylist } from "../../services/source/online/recommendImport.js";
import { scrapeArtist, artistsMissingCovers, artistsMissingInfo } from "../../services/scraper/artist.js";
import {
  refreshDevices, getCachedDevices, shouldRefreshDevices, castToDevice, createCastSession,
  playDevice, pauseDevice, stopDevice, seekDevice, setDeviceVolume, setDeviceMute, getDeviceStatus,
  enqueueNextTrack, getCurrentMedia, recordBaseUrl, getEffectiveBaseUrl, isPrivateLanHostname,
  setDeviceAlias, deleteDeviceRecord, setDeviceDisabled, isDeviceDisabled,
} from "../../services/dlna/control.js";
import { announceOnPeer, isAnnouncing } from "../../services/dlna/announce.js";
import { markStaleDevices } from "../../services/dlna/discovery.js";
import { getEventManager } from "../../services/dlna/eventing.js";
import { getQueueManager } from "../../services/dlna/queue.js";
import { getPeerManager, parsePeerId, type LocalPlaybackReport } from "../../services/peer.js";
import { listAirPlayDevices, castToAirPlayDevice, getAirPlayPeerStatus, setAirPlayMuted, setAirPlayAlias, setAirPlayDisabled, deleteAirPlayDeviceRecord, isAirPlayDeviceDisabled, stopAirPlaySession, isAirPlayEnabled, startAirPlayService, stopAirPlayService } from "../../services/airplay/control.js";
import { rescanAirPlayDevices } from "../../services/airplay/discovery.js";
import { startSendspinService, stopSendspinService, getSendspinFront, sendspinGroupJoin, sendspinGroupLeave } from "../../services/sendspin/index.js";
import { sendspinGroupName } from "../../services/sendspin/playerCore.js";
import { getSendspinDeviceVolume } from "../../services/sendspin/peerVolume.js";
import { resolveContentSongs, songsToQueueItems } from "../../services/content.js";import { listFlows, createFlow, updateFlow, deleteFlow, getFlow, executeFlow, isFlowRunning } from "../../services/flows/index.js";
import { runPlaylistAutoMatch } from "../../services/playlist/autoMatch.js";
import {
  listPlayerWebhookTokens, createPlayerWebhookToken, deletePlayerWebhookToken,
  setPlayerWebhookTokenEnabled, resolvePlayerWebhookOwnerName, getPlayerWebhookTokenById,
} from "../../services/player/playerWebhook.js";
import { getGroupManager, splitMemberId } from "../../services/group/index.js";
import { getHiddenPeerIds, setPeerHidden, isPeerHidden, getNameOverrides, getPeerNameOverride, setPeerNameOverride } from "../../services/playerPrefs.js";
import { getPlayerDspConfig, setPlayerDspConfig, listPlayerDspConfigs } from "../../services/playerDsp.js";
import {
  readPipelineSwitches, updatePipelineSwitches, isDlnaFallback, setDlnaFallback,
} from "../../services/audio/pipelineSwitches.js";
import {
  resolveFlowSettings, FLOW_ENABLED_KEY, CROSSFADE_MODE_KEY, CROSSFADE_DURATION_KEY,
} from "../../services/audio/flowSource.js";
import { FADE_MIN_SEC, FADE_MAX_SEC } from "../../services/audio/fades.js";
import {
  readNormalizationSettings, updateNormalizationSettings,
} from "../../services/audio/normalization.js";
import {
  getMeasureStatus, setOfflineMeasureEnabled, startOfflineMeasure,
} from "../../services/audio/offlineMeasure.js";
import { getGroupStatus, getGroupLeaderDeviceId } from "../../services/group/protocolPlayer.js";
import { getQueueController } from "../../services/player/index.js";
import { markSeekIssued } from "../../services/player/seekSettle.js";
import { PlaybackState } from "../../services/player/types.js";
import { onlineRoutes } from "./online.js";
import { playlistSearchRoutes } from "./playlistSearch.js";
import { entitySearchRoutes } from "./entitySearch.js";
import { pingAllHealth } from "../../plugins/health.js";
import { getRendererPlugins, discoverRenderers } from "../../plugins/renderers.js";
import { getScrobblerPlugins } from "../../plugins/scrobblers.js";
import {
  listMarketplace, collectRegistryGroups, installPlugin, listRegistries, addRegistry, removeRegistry,
} from "../../plugins/registryCatalog.js";
import { BUILTIN_PLUGINS } from "../../plugins/builtins.js";
import { pluginSandboxes } from "../../plugins/discovery.js";
import { unregisterPlugin, firstEnabledByCapability, getEnabledByCapability, getPluginConfig, getPluginManifest, getPlugin } from "../../plugins/registry.js";
import { registerBatchWorker, unregisterBatchWorker } from "../../services/plugin/batchPacer.js";
import { isBatchCapable } from "../../services/plugin/scheduleFields.js";
import { preferLocalEnabled, PLAY_PREFERENCE_PLUGIN_ID } from "../../services/plugin/core/playPreference.js";
import fs from "node:fs";
import path from "node:path";
import { getDataDir } from "../../utils/env.js";
import { createLogger } from "../../utils/logger.js";

// 每日推荐 / 本地推荐 / 今日漫游 / 歌单同步能力经 registry 门面访问(核心不直连插件实现;插件未启用时返回安全默认)。

// ==================== 共享声明（原 index.ts 顶层） ====================

export const dailyApi = () => dailyRecommendApi();

export const localApi = () => localRecommendApi();

export const comboApi = () => comboPlaylistApi();

export const syncApi = () => playlistSyncApi();

export const log = createLogger("RECOMMEND");
// 传输控制(play/pause/stop/seek/volume)入口日志,单独前缀便于
// `docker logs musicflow | grep '\[Peer\]'` 只捞拖动/控制链路,不受推荐等噪音干扰。

export const seekLog = createLogger("Peer");

export const RECOMMEND_CACHE_TTL_MS = 5 * 60_000;

export const recommendCache = new Map<string, { ts: number; channels: any[] }>();
/**
 * POST /v1/stream/probe 单批最大歌曲数。
 * 原为 5(只够客户端 _probeWindow=3 用);客户端现在会在「单曲临近结束」时
 * 补探一次窗口(见 2026-09-12 时效修复),窗口要能扩到 8~10 首,故放宽到 20。
 */

export const MAX_PROBE_BATCH = 20;
/** 清空平台精选缓存(供测试/管理端"立即刷新"使用)。 */

export function clearRecommendCache(): void {
  recommendCache.clear();
}
// 空闲内存回收时一并清空(经注册回调,避免 reclaim 与路由层循环依赖)。

registerCacheCleaner(() => { recommendCache.clear(); });

/** 归一化歌名供兜底比对:去空白、去尾部省略号、小写。 */

export function normalizePlaylistName(name: unknown): string {
  return String(name ?? "").trim().replace(/[…...]+$/, "").toLowerCase();
}

/**
 * 把首页「平台精选」的远端歌单匹配到已入库的本地歌单,用于读取真实曲目数量。
 * 命中优先级:sourceUrl 前缀 → externalId+平台 → 歌名+平台。
 * 只依赖本地库定位并取 songCount,完全不用插件远程 trackCount 候补。
 * 覆盖不同入库途径:每日推荐同步/点播导入(有平台 id)、URL/搜索导入(仅剩歌名可对齐)。
 */

export function findLocalRemotePlaylist(remoteId: string, source: string, name: string): any | null {
  if (remoteId) {
    const bySourceUrl = findRecommendPlaylist(remoteId);
    if (bySourceUrl) return bySourceUrl;
  }
  const src = source || "";
  if (remoteId && src) {
    const byExternal = db.select().from(playlists)
      .where(and(eq(playlists.externalId, remoteId), eq(playlists.sourcePlatform, src)))
      .get();
    if (byExternal) return byExternal;
  }
  const norm = normalizePlaylistName(name);
  if (norm.length >= 3 && src) {
    const candidates = db.select().from(playlists).where(eq(playlists.sourcePlatform, src)).all();
    const hit = candidates.find((p) => normalizePlaylistName(p.name) === norm);
    if (hit) return hit;
  }
  return null;
}

export function assertKeyAccess(c: Context, id: string) {
  const user = c.get("user");
  return id === user?.id || user?.isAdmin;
}

export const scanJobs = new Map<string, { status: string; startedAt: string; progress?: ScanProgress; result?: any; error?: string; mode?: string; controller?: AbortController }>();

// 完成/失败/停止的扫描任务保留 30 min(前端轮询取结果),超时清理防 Map 无界
// (running 中任务不清,避免并发扫描判定失效;参照 online.ts matchJobs 同款)。

export const SCAN_JOB_TTL_MS = 30 * 60 * 1000;

export const scanJobsSweep = setInterval(() => {
  const now = Date.now();
  for (const [k, v] of scanJobs) {
    if (v.status === "running") continue;
    if (now - Date.parse(v.startedAt) >= SCAN_JOB_TTL_MS) scanJobs.delete(k);
  }
}, 5 * 60 * 1000);

(scanJobsSweep as any).unref?.();

export const BUILTIN_IDS = new Set(BUILTIN_PLUGINS.map((b) => b.manifest.id));

export const isBuiltinRow = (r: any): boolean => BUILTIN_IDS.has(r?.id) || BUILTIN_IDS.has(r?.name);
// core 内置插件(同曲多源组 / 播放优选等行为插件):不参与状态开关启停,功能开关
// 全部收在插件「配置」弹窗的 configSchema 里(开关按钮由 manifest 声明)。

export const isCoreRow = (r: any): boolean => {
  const m = getPluginManifest(r?.name) || (() => { try { return r?.manifest ? JSON.parse(r.manifest) : {}; } catch { return {}; } })();
  return m.type === "core";
};

export function deleteSongDb(id: string): boolean {
  const song = db.select().from(songs).where(eq(songs.id, id)).get();
  if (!song) return false;
  db.delete(playlistSongs).where(eq(playlistSongs.songId, id)).run();
  db.delete(userFavoriteSongs).where(eq(userFavoriteSongs.songId, id)).run();
  db.delete(playHistory).where(eq(playHistory.songId, id)).run();
  // P0-6:单曲删除是用户显式意图,回写跟删。顺序:先回写后歌曲行
  // (audio_analysis.row_id 有 FK 无 CASCADE,反了会直接抛错;崩溃也只留下
  // "无测量的歌",下次照常重测,反方向则是幽灵数据)。
  deleteAnalysis(id);
  db.delete(songs).where(eq(songs.id, id)).run();
  cleanupOrphans();
  return true;
}

export function idToCoverArt(id: string | null, prefix: string): string | undefined {
  if (!id) return undefined;
  const album = db.select().from(albums).where(eq(albums.id, id)).get();
  return album && album.coverArt ? `${prefix}-${album.id}` : undefined;
}

// Web/online-imported albums (go-music-dl etc.) cache artwork on the song rows
// (songs.cover_art), not the album row. Fall back to the first song-with-cover
// so imported albums aren't blank everywhere (grid, detail, artist pages).

export function albumCoverRef(a: any): string | undefined {
  if (a?.coverArt) return `al-${a.id}`;
  const song = db.select({ id: songs.id }).from(songs)
    // 同样排除空串:cover_art = '' 会被 isNotNull 选中却解析不出文件。
    .where(and(eq(songs.albumId, a?.id), isNotNull(songs.coverArt), ne(songs.coverArt, "")))
    .limit(1).get();
  return song ? `so-${song.id}` : undefined;
}

// ==================== Genres (with unique ids + song counts) ====================
// 风格 ID 由 genres 表分配(启动时 backfillGenres 回填;此处兜底按需补建)。

export function genreIdFor(name: string): string {
  const row = sqlite.prepare("SELECT id FROM genres WHERE name = ?").get(name) as any;
  if (row?.id) return row.id;
  const id = uuidv4();
  const now = new Date().toISOString();
  sqlite.prepare("INSERT OR IGNORE INTO genres (id, name, song_count, created_at, updated_at) VALUES (?, ?, 0, ?, ?)").run(id, name, now, now);
  const re = sqlite.prepare("SELECT id FROM genres WHERE name = ?").get(name) as any;
  return re?.id || id;
}

export function buildArtistList(cacheKey: string, query: string): typeof artists.$inferSelect[] {
  const fetched = query
    ? db.select().from(artists).where(like(artists.name, `%${query}%`)).all()
    : db.select().from(artists).all();
  const sorted = fetched.sort((a, b) => (a.name || "").localeCompare(b.name || ""));
  setArtistList(cacheKey, sorted);
  return sorted;
}

// ==================== Artist scrape (QQ Music first, NetEase fallback) ====================
// Manual scrape: scrapes ALL artists missing covers, with real-time progress.
// POST /v1/artists/scrape  { name? }  -> single artist when name given, else full scrape
// GET  /v1/artists/scrape-status     -> current progress { total, processed, scraped, skipped, current, status }

export const scrapeJobs = new Map<string, any>();

export const SCRAPE_JOB_ID = "default";

export const setLyricsCoversSettings = async (c: Context, prefix: "lyrics" | "cover") => {
  const body = await c.req.json().catch(() => ({}));
  // providerId: 字符串直接存;清空(el-select clearable → undefined/null)→ 存空串(=自动)。
  if (typeof body.providerId === "string") setSetting(`${prefix}.providerId`, body.providerId);
  else if (body.providerId === undefined || body.providerId === null) setSetting(`${prefix}.providerId`, "");
  if (typeof body.onDemand === "boolean") setSetting(`${prefix}.onDemand`, body.onDemand ? "true" : "false");
  if (typeof body.persist === "boolean") setSetting(`${prefix}.persist`, body.persist ? "true" : "false");
  return c.json({ success: true });
};

export function getDlnaBaseUrl(c: any): string {
  const envBase = process.env.DLNA_BASE_URL;
  if (envBase) { const u = envBase.replace(/\/+$/, ""); recordBaseUrl(u); return u; }
  const host = c.req.header("host") || "";
  const hostname = host.split(":")[0] || "";
  const port = process.env.PORT || "46400";
  // 仅当 Host 是局域网可达地址(私有 IP / .local)时才直接复用;公网域名与回环地址
  // 一律回退到自动探测的 LAN IP,避免把公网域名推给设备。
  if (!isPrivateLanHostname(hostname)) return getEffectiveBaseUrl();
  const u = `http://${hostname}:${port}`;
  recordBaseUrl(u);
  return u;
}

// ==================== 播放器管理(细粒度权限) ====================
// 双层模型(见 services/access.ts):
//   - 功能权限 renderer.use 控制"能否使用播放器",设备/群组授权
//     user_renderer_grants 控制"能用哪些播放器"。管理员恒全量。
//   - 控制类端点(play/pause/status/queue…)按设备授权判定;
//     管理类端点(扫描/改名/删除/禁用/群组 CRUD)要求 renderer.manage。
//   - 本机播放器 local:<userId> 属用户自己的 Web 播放器,永远可用。
// WS 连接同样按用户过滤(见 services/ws)。

export const serializeDlnaDevices = (devices: ReturnType<typeof getCachedDevices>) => devices.map(d => ({
  id: d.id, name: d.name, alias: d.alias || "",
  displayName: d.alias || d.name,
  manufacturer: d.manufacturer, model: d.model,
  hasVolumeControl: !!d.renderingControlUrl,
  available: d.available,
  disabled: !!d.disabled,
}));

export function sendspinServerOr404(c: any) {
  // fork 模式下这是「镜像代理」:同步读走子进程推送的状态快照,写走 RPC。
  const srv = getSendspinFront();
  if (!srv) return null;
  return srv;
}

export const pm = getPeerManager();

/** 取出调用方上报的临时端 ID(请求头优先,其次 query)。它只在服务端内部使用,
 *  不会出现在任何响应里(见 utils/peerId.ts 的 maskLocalPeerId)。 */

export function clientIdOf(c: any): string | null {
  return sanitizeClientId(c.req.header("x-mf-client-id")) ?? sanitizeClientId(c.req.query("clientId"));
}

/** 规整客户端上报的「设备名片」字段(platform / model):仅字符串、去空白、限长;
 *  非法或空 → undefined(前端退回兜底显示,不报错)。 */

export function sanitizeLabel(raw: unknown, max: number): string | undefined {
  if (typeof raw !== "string") return undefined;
  const v = raw.trim();
  return v ? v.slice(0, max) : undefined;
}

/** 解出 peerId,并把「调用方视角」的本机 peerId 换算成服务端真实那一行。两种形式:
 *  - `local:<userId>:<instanceKey>`(新)→ 按实例键反查真实 peerId(可指向同账号的
 *    任意实例,不限于自己那条);
 *  - `local:<userId>`(旧客户端)→ 退回本次请求上报的 clientId 对应那行。
 *  除本机外其余 peer 原样返回。 */

export function decodePeerId(c: any): string {
  const raw = decodeURIComponent(c.req.param("peerId") || "");
  return resolveLocalPeerId(
    raw,
    c.get("user")?.id ?? "",
    clientIdOf(c),
    (uid, key) => pm.resolveMaskedLocalPeerId(uid, key),
  );
}

/** **body 里**带 peerId 的端点专用(如 `/v1/play`):与 `decodePeerId` 完全同一套解析。
 *  调用方(Web / HA / 客户端)只看得到对外形式 `local:<userId>:<instanceKey>`,不解析
 *  就会把掩码当真实键直接落库,凭空造出一条无人读的僵尸队列行 —— 目标实例读的是自己
 *  那条真实行,于是「投到这台客户端」变成投给了一个幻影(2026-09-15 实测)。 */

export function resolveBodyPeerId(c: any, raw: string): string {
  return resolveLocalPeerId(
    raw,
    c.get("user")?.id ?? "",
    clientIdOf(c),
    (uid, key) => pm.resolveMaskedLocalPeerId(uid, key),
  );
}

// 可投屏/可控制 peer:dlna 设备、播放器群组(group)与 AirPlay 设备(airplay)。
// dlna/group/airplay 队列都归 QueueController 管(内部按裸 id),
// 传输控制 dlna 走 control.ts、group 走组扇出、airplay 走 airplay/control.ts。

export function isCastPeer(parsed: { kind: string }): boolean {
  return parsed.kind === "dlna" || parsed.kind === "group" || parsed.kind === "airplay" || parsed.kind === "sendspin";
}

// List all known peers (local + dlna + group + airplay) with their queue
// snapshots. The Web client calls this to populate the player-switcher popup.
// 权限:管理员看到全部;普通用户看到「自己的本机播放器 + 被授权的设备/群组」,
// 其余 peer 一律不可见(见 services/access.ts 的 filterPeersByAccess)。

export const PEER_PATH_RESERVED = new Set(["register"]);

export function finiteNumOrUndefined(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

// 本机实例的播放状态上报:state / position(秒) / duration(秒) / volume(0-100) / songId。
//
// 为什么需要它:本机播放的传输状态权威在客户端本地播放器,服务端只有队列元数据。
// 当**别的**播放端(Web / HA / 另一台客户端)遥控这台本机实例时,它靠轮询
// `GET /v1/peers/:peerId/status` 镜像进度条与播放按钮 —— 没有这份上报,轮询只能
// 拿到队列快照,进度条恒为 0、按钮恒显示「未播放」。
//
// 只对 local 有效(DLNA/组/airplay/sendspin 的状态由各自链路实时查询,不走上报),
// 只存进程内存,TTL 30s(见 PeerManager.getLocalStatusReport)。

export function localShuffleInfo(snap: any) {
  return {
    currentIndex: snap?.currentIndex ?? -1,
    playMode: snap?.playMode ?? "order",
    isActive: !!snap?.isActive,
    shuffleOrder: Array.isArray(snap?.shuffleOrder) ? snap.shuffleOrder : [],
    shufflePos: typeof snap?.shufflePos === "number" ? snap.shufflePos : -1,
    shuffleEpoch: typeof snap?.shuffleEpoch === "number" ? snap.shuffleEpoch : 0,
  };
}

export async function readPeerPositionSeconds(peerId: string): Promise<number | null> {
  const parsed = parsePeerId(peerId);
  if (!parsed) return null;
  try {
    if (parsed.kind === "dlna") {
      const st = await getDeviceStatus(parsed.id);
      return typeof st?.position === "number" && Number.isFinite(st.position) ? st.position : null;
    }
    if (parsed.kind === "group") {
      const st = await getGroupStatus(parsed.id);
      return typeof st?.position === "number" && Number.isFinite(st.position) ? st.position : null;
    }
    if (parsed.kind === "airplay") {
      const st = getAirPlayPeerStatus(parsed.id);
      return typeof st?.position === "number" && Number.isFinite(st.position) ? st.position : null;
    }
    if (parsed.kind === "sendspin") {
      const st = await getQueueController().getPlayerState(parsed.id);
      return typeof st?.position === "number" && Number.isFinite(st.position) ? st.position : null;
    }
    // local:对端客户端上报的状态(服务端只做暂存,见 LocalPlaybackReport)。
    const rep = pm.getLocalStatusReport(peerId);
    return typeof rep?.position === "number" && Number.isFinite(rep.position) ? rep.position : null;
  } catch (e: any) {
    seekLog.debug(`[position] 读取 ${peerId} 进度失败: ${e?.message || e}`);
    return null;
  }
}

/** 把某个播放端 seek 到 [seconds] 秒(在起播完成后调用)。返回是否下发成功。
 *  <=0 视为「从头播」,不下发(既无意义,也可能被设备当成异常 target)。 */

export async function seekPeerToSeconds(peerId: string, seconds: number): Promise<boolean> {
  const parsed = parsePeerId(peerId);
  if (!parsed) return false;
  if (!Number.isFinite(seconds) || seconds <= 0) return false;
  const t0 = Date.now();
  try {
    // seek 冷静期:与 HTTP seek 入口同款 —— 重定位窗口内设备必然短暂非 PLAYING,
    // 此窗口的 IDLE 不得被判成「真结束」而放行切歌(见 services/player/seekSettle.ts)。
    markSeekIssued(parsed.id);
    if (parsed.kind === "dlna") await seekDevice(parsed.id, seconds);
    else if (parsed.kind === "local") dispatchPeerCommand(peerId, "seek", { seconds });
    else await getQueueController().transport(parsed.id, "seek", seconds);
    seekLog.info(`[transfer] 进度对齐 ${peerId} → ${seconds.toFixed(2)}s ${Date.now() - t0}ms`);
    return true;
  } catch (e: any) {
    seekLog.warn(`[transfer] 进度对齐 ${peerId} → ${seconds.toFixed(2)}s 失败 ${Date.now() - t0}ms: ${e?.message || e}`);
    return false;
  }
}

export function dispatchPeerCommand(peerId: string, action: string, payload?: Record<string, unknown>) {
  // 方案收敛:Web 播放器不再是被控端 —— 即便调用方持有历史 peerId,指令也不下发。
  // (列表已隐藏 web 实例,这里是防御性兜底,防缓存直呼。)
  const target = pm.get(peerId);
  if (target?.kind === "local" && target.platform === "web") {
    return { success: true, delivered: false };
  }
  const delivered = sendToLocalPeer(peerId, { type: "peer_command", action, payload }) > 0;
  return { success: true, delivered };
}

export function broadcastSendspinVolume(peerId: string, patch: { volume?: number; muted?: boolean }): void {
  const parsed = parsePeerId(peerId);
  if (!parsed || parsed.kind !== "sendspin") return;
  const cur = getSendspinDeviceVolume(parsed.id);
  const volume = Math.min(100, Math.max(0, Math.round(patch.volume ?? cur.volume)));
  const muted = patch.muted ?? cur.muted;
  try { pm.notifyPeerVolume(peerId, volume, !!muted); } catch { /* 广播失败不影响写入 */ }
}

export async function setSendspinMemberMuted(clientId: string, muted: boolean): Promise<void> {
  const srv = getSendspinFront();
  if (!srv) throw new Error("sendspin 服务未运行");
  // 镜像视图的 muted setter = 本地即时更新 + RPC 下发子进程(fork 模式)。
  srv.group(clientId).muted = muted;
  const conn = srv.clients.get(clientId);
  if (conn) conn.muted = muted;
  try {
    const { saveDeviceVolumeState } = await import("../../services/sendspin/deviceState.js");
    saveDeviceVolumeState(clientId, { muted });
  } catch { /* 持久化失败不影响本次静音 */ }
  // 置位成功后广播回显(组静音与单设备静音共用本函数,故一并覆盖)。
  const peerId = `sendspin:${clientId}`;
  broadcastSendspinVolume(peerId, { muted });
}

// Peer status: for dlna returns the device transport state; for groups the
// leader's state (MA 同款:组状态从 leader 派生);for local returns the stored
// queue metadata (HA uses this to read the local peer's queue).

export const gm = getGroupManager();

/** 成员变更后对齐(新增→加入当前播放,摘除→断开):PUT 与 POST 增量口共用,语义单源。
 *  - dlna 新增:现有 rejoinMembers(cast 当前曲＋seek 到 leader 进度);
 *  - sendspin 新增:直播沿加入(无需历史,见 sendspinGroupJoin);
 *  - sendspin 摘除:stream/end 后移出(不断其余成员);
 *  - dlna 摘除:沿用旧行为(不主动停成员设备)。
 *  全部 best-effort:单个成员失败记日志,不影响其余成员与接口成功。 */
// 显式操控成员 → 自动脱离活跃组(MA ensure_player_ungrouped 语义):
// 成员在组播期间不独立受理播放指令;用户把播放/切歌/流转明确指向成员本身时,
// 先把它从所属活跃组摘出(写库 + 断流对齐),再走各 kind 的独立播放分支。
// 仅设备型成员(dlna / sendspin)适用;group/local 目标本就不从属于任何组。
/** sendspin → sendspin 的「借流」武装(泵移交,见 services/sendspin/playerCore.ts)。
 *
 *  两端都是 sendspin 系 peer 时才尝试。armed=true 表示紧随其后的那次起播会把源端
 *  **已经解码好**的那条流整体接过去(目标端零解码、零 seek、零预缓冲即出声),落点
 *  由移交方给出 —— 调用方必须跳过事后的 seek(seek 会走完整重建,把泵打死)。 */

export async function tryArmSendspinBorrow(
  fromPeerId: string,
  toPeerId: string,
  askPosition: number | null,

): Promise<{ armed: boolean; positionSeconds: number | null; songId: string | null }> {
  const miss = { armed: false, positionSeconds: null, songId: null };
  try {
    const { sendspinArmBorrow, sendspinGroupNameForPeer } = await import("../../services/sendspin/index.js");
    const fromGroup = sendspinGroupNameForPeer(fromPeerId);
    const toGroup = sendspinGroupNameForPeer(toPeerId);
    if (!fromGroup || !toGroup) return miss; // 有一端不是 sendspin:没有可移交的流对象
    const r = await sendspinArmBorrow(toGroup, fromGroup, askPosition != null ? askPosition * 1000 : null);
    if (!r?.armed) {
      if (r?.reason) seekLog.debug(`[transfer] 借流未武装(${r.reason}),走常规对齐`);
      return miss;
    }
    return {
      armed: true,
      positionSeconds: typeof r.positionMs === "number" ? r.positionMs / 1000 : null,
      songId: r.songId ?? null,
    };
  } catch (e: any) {
    seekLog.debug(`[transfer] 借流武装异常: ${e?.message || e}`);
    return miss;
  }
}

/** 泵移交是否真的落位:读目标端实时进度与移交落点比对。
 *
 *  为什么必须读回来:移交成没成,在返回值上区分不了(playCore 是 fire-and-forget,
 *  武装之后源端可能在毫秒级窗口里被停/被换歌),而两种情形的后续处置**完全相反**
 *  —— 成了就必须跳过 seek,没成又必须 seek。一次读回把这个不确定性消掉。
 *  容差 1.5s:移交后 pushLoop 的「可听位置」会短暂落后落点(最多一个 ≤800ms 的锚点
 *  提前量);而"从 0 播"在落点 >1.5s 时必然落在容差外。 */

export async function borrowLandingConfirmed(toPeerId: string, expectSeconds: number | null): Promise<boolean> {
  if (expectSeconds === null || expectSeconds <= 0) return false;
  const back = await readPeerPositionSeconds(toPeerId);
  return back !== null && Math.abs(back - expectSeconds) <= 1.5;
}

export async function detachFromActiveGroups(parsed: { kind: string; id: string }): Promise<void> {
  if (parsed.kind !== "dlna" && parsed.kind !== "sendspin") return;
  const bare = splitMemberId(parsed.kind === "sendspin" ? `sendspin:${parsed.id}` : parsed.id)?.id ?? parsed.id;
  const gid = getQueueController().activeGroupOfDevice(bare);
  if (!gid) return;
  // memberIds 存的是组内原样写法(sendspin:<id> / 裸 id ≡ dlna),按裸 id 找回原样再删。
  const memberKey = (gm.get(gid)?.memberIds ?? []).find(m => (splitMemberId(m)?.id ?? m) === bare);
  if (!memberKey) return;
  try {
    gm.applyMemberDelta(gid, { remove: [memberKey] });
    await alignGroupMembers(gid, [], [memberKey]);
    log.info(`[group] ${gid}: 成员 ${memberKey} 因被显式操控自动脱离组`);
  } catch (e: any) {
    log.warn(`[group] ${gid}: 成员 ${memberKey} 自动脱离失败: ${e?.message || e}`);
  }
}

export async function alignGroupMembers(groupId: string, added: string[], removed: string[]): Promise<void> {
  const kindOf = (m: string) => splitMemberId(m)?.kind ?? "dlna";
  const bareOf = (m: string) => splitMemberId(m)?.id ?? m;
  const dlnaAdded = added.filter(m => kindOf(m) === "dlna").map(bareOf);
  const spinAdded = added.filter(m => kindOf(m) === "sendspin").map(bareOf);
  const spinRemoved = removed.filter(m => kindOf(m) === "sendspin").map(bareOf);
  if (dlnaAdded.length > 0) {
    // 成员加入播放中的组:把当前曲 cast 给新成员并 seek 到 leader 进度
    // (仅加入时一次,不做周期漂移校正——纯 MA 忠实策略)。
    getQueueController().rejoinMembers(groupId, dlnaAdded).catch((e: any) => {
      log.warn(`[group] ${groupId}: 成员加入对齐失败: ${e?.message || e}`);
    });
  }
  const sg = sendspinGroupName(groupId);
  for (const cid of spinAdded) {
    try {
      // ug 懒创建缺省 100:入组前灌 GroupManager 持久值(与起播 playMedia 同源)。
      const { sendspinGroupTransport } = await import("../../services/sendspin/index.js");
      await sendspinGroupTransport(sg, "volume", gm.getVolume(groupId));
      await sendspinGroupJoin(sg, cid);
    } catch (e: any) {
      log.warn(`[group] ${groupId}: sendspin 成员 ${cid} 加入失败: ${e?.message || e}`);
    }
  }
  for (const cid of spinRemoved) {
    try {
      await sendspinGroupLeave(sg, cid);
    } catch (e: any) {
      log.warn(`[group] ${groupId}: sendspin 成员 ${cid} 摘除失败: ${e?.message || e}`);
    }
  }
}

// 列出全部组(含成员设备信息:名称/可用性)。
// 播放器群组按用户划分:管理员看到全部;普通用户只看到自己创建的组(ownerUserId === 本人)。
// 普通用户看不到管理员建的组,也看不到别人的组;组内成员设备访问安全由 peer 控制层把关。

export const DEFAULT_DEFINITION = {
  // 节点化默认模板:触发 → 目标 → 播放内容 → 设置音量。
  nodes: [
    { type: "trigger", triggerType: "webhook" },
    { type: "target", targets: [] },
    { type: "content", contentType: "playlist", id: "", startIndex: 0 },
    { type: "volume", value: 20 },
  ],
  waitTimeoutSec: 0,
  scanIntervalSec: 5,
};

// 对外可复制链接:用局域网可达 base,保证外部 webhook 能命中。/rest、/api 均受鉴权,
// 音流链接悬停在 /webhooks/... 路径上(免鉴权),且必须携带所绑定的「通用播放器控制」渠道 token。
// 绑定 token 缺失或已停用时,flow.webhookUrl 为空(前端提示先到「通用播放器控制」创建/启用 token)。

export function flowWithWebhook(flow: any) {
  let webhookUrl = "";
  const tok = flow.tokenId ? getPlayerWebhookTokenById(flow.tokenId) : undefined;
  if (tok && tok.enabled) {
    webhookUrl = `${getEffectiveBaseUrl()}/webhooks/flows/${flow.id}?token=${encodeURIComponent(tok.token)}`;
  }
  return { ...flow, tokenId: flow.tokenId || "", tokenName: tok?.name || "", webhookUrl };
}

// 音流按用户划分:管理员可见/操作全部;普通用户仅自己的(ownerUserId 兜底)。

export function flowOwner(c: any): string | undefined {
  const user = c.get("user");
  return user && !user.isAdmin ? user.id : undefined;
}

/** 非管理员只能绑定属于自己的渠道 token(音流按用户划分的延伸)。 */

export function assertOwnToken(c: any, tokenId: string): boolean {
  const user = c.get("user");
  if (!user || user.isAdmin) return true;
  const t = getPlayerWebhookTokenById(tokenId);
  return !!t && t.ownerUserId === user.id;
}

// 创建时未指定 tokenId:自动绑定第一个启用渠道 token,让新音流立即可触发。
// 普通用户优先绑定自己的启用 token,找不到则空(不跨用户借用)。

export function resolveDefaultTokenId(userId?: string): string {
  const list = listPlayerWebhookTokens();
  const t = userId
    ? list.find(x => x.enabled && x.ownerUserId === userId)
    : list.find(x => x.enabled);
  return t ? t.id : "";
}

export function tokenOfUser(c: any, id: string): { id: string } | undefined {
  const user = c.get("user")!;
  const t = getPlayerWebhookTokenById(id);
  if (!t) return undefined;
  if (!user.isAdmin && t.ownerUserId !== user.id) return undefined;
  return t;
}

// ==================== 转出原始 import，供各域模块复用 ====================
export {
  BUILTIN_PLUGINS,
  BatchPace,
  BusinessErrorCode,
  CROSSFADE_DURATION_KEY,
  CROSSFADE_MODE_KEY,
  FADE_MAX_SEC,
  FADE_MIN_SEC,
  FLOW_ENABLED_KEY,
  Hono,
  ImportedPlaylist,
  ImportedTrack,
  LocalPlaybackReport,
  NATIVE_APP,
  PERM,
  PERMISSION_CATALOG,
  PLAY_PREFERENCE_PLUGIN_ID,
  PlaybackState,
  RANDOM_PLAYLIST_ID,
  ScanProgress,
  addRegistry,
  adminMiddleware,
  albums,
  alignSeekSeconds,
  and,
  announceOnPeer,
  anyJobRunning,
  anyTaskRunning,
  apiError,
  artists,
  artistsMissingCovers,
  artistsMissingInfo,
  asc,
  attachGroupSources,
  backfillStatus,
  buildLocalPeerId,
  canControlPeer,
  canUseRenderer,
  castToAirPlayDevice,
  castToDevice,
  cleanupOrphans,
  clearLibraryIndex,
  clearPlaylistCoverCache,
  clientIdOfLocalPeer,
  collectRegistryGroups,
  comboPlaylistApi,
  count,
  countLiveConnections,
  createCastSession,
  createFlow,
  createLogger,
  createPlayerWebhookToken,
  currentPace,
  dailyRecommendApi,
  dailyRecommendHomeCount,
  dailyRecommendTag,
  db,
  decoratePeersForClient,
  deleteAirPlayDeviceRecord,
  deleteAnalysis,
  deleteAnalysisMany,
  deleteDeviceRecord,
  deleteFlow,
  deletePlayerWebhookToken,
  desc,
  deviceQueues,
  discoverRenderers,
  effectiveAccessView,
  encryptPassword,
  enqueueNextTrack,
  ensureHomePlaylist,
  ensurePlayableStream,
  entitySearchRoutes,
  eq,
  executeFlow,
  findRecommendPlaylist,
  firstEnabledByCapability,
  formatDailyTime,
  fs,
  genres,
  getAirPlayPeerStatus,
  getArtistList,
  getAsyncTask,
  getCachedDevices,
  getCachedPlayability,
  getCoverCacheBytes,
  getCurrentMedia,
  getDataDir,
  getDeviceStatus,
  getEffectiveBaseUrl,
  getEnabledByCapability,
  getEventManager,
  getFlow,
  getGroupLeaderDeviceId,
  getGroupManager,
  getGroupStatus,
  getHiddenPeerIds,
  getLibraryIndexStats,
  getLyricsCacheEntries,
  getMeasureStatus,
  getMemorySnapshot,
  getNameOverrides,
  getPeerManager,
  getPeerNameOverride,
  getPlayerDspConfig,
  getPlayerWebhookTokenById,
  getPlugin,
  getPluginConfig,
  getPluginJobState,
  getPluginManifest,
  getProxyConfig,
  getQueueController,
  getQueueManager,
  getReclaimStatus,
  getRenderedCoverBytes,
  getRendererPlugins,
  getRequestMetrics,
  getScrobblerPlugins,
  getSendspinDeviceVolume,
  getSendspinFront,
  getSetting,
  getSettingBool,
  getUserPermissions,
  getUserRendererGrants,
  grantRenderer,
  hasPerm,
  homePositionConflictForSave,
  inArray,
  installPlugin,
  invalidateAccessCaches,
  invalidateArtistList,
  invalidateAuthCaches,
  isAirPlayDeviceDisabled,
  isAirPlayEnabled,
  isAnnouncing,
  isBatchBusy,
  isBatchCapable,
  isDailyRecommendPlaylist,
  isDeviceDisabled,
  isDlnaFallback,
  isFixedRecommendPlaylist,
  isFlowRunning,
  isIdle,
  isImportedPlaylist,
  isLogLevel,
  isNotNull,
  isNull,
  isPeerHidden,
  isPluginSyncPlaylist,
  isPrivateLanHostname,
  like,
  listAirPlayDevices,
  listFlows,
  listHomeCardPlugins,
  listMarketplace,
  listPlayerDspConfigs,
  listPlayerWebhookTokens,
  listRegistries,
  localRecommendApi,
  logLevelSnapshot,
  markSeekIssued,
  markStaleDevices,
  maskLocalPeerId,
  maybeRefreshRandomSongs,
  md5,
  mediaSources,
  ne,
  normalizeProxyUrl,
  onlineRoutes,
  or,
  parsePeerId,
  parsePlaylistFile,
  path,
  pauseDevice,
  peerToDeviceKey,
  permMiddleware,
  pingAllHealth,
  playDevice,
  playHistory,
  playlistFavorites,
  playlistSearchRoutes,
  playlistSongs,
  playlistSyncApi,
  playlists,
  pluginSandboxes,
  plugins,
  preferLocalEnabled,
  probeLocalSourceOk,
  randomBytes,
  readNormalizationSettings,
  readPipelineSwitches,
  rearmDailyScheduler,
  reclaimNow,
  recordBaseUrl,
  refreshDevices,
  registerBatchWorker,
  registerCacheCleaner,
  removeRegistry,
  rendererGrantParamMiddleware,
  replaceRendererGrants,
  replaceUserPermissions,
  rescanAirPlayDevices,
  resolveContentSongs,
  resolveFlowSettings,
  resolveLocalPeerId,
  resolveLyricContent,
  resolvePlayerWebhookOwnerName,
  resolveSongCover,
  revokeRenderer,
  runBatchJob,
  runPlaylistAutoMatch,
  runPluginJob,
  sanitizeClientId,
  saveLogLevel,
  scrapeArtist,
  seekDevice,
  sendToLocalPeer,
  sendspinGroupJoin,
  sendspinGroupLeave,
  sendspinGroupName,
  serializeSongRow,
  setAirPlayAlias,
  setAirPlayDisabled,
  setAirPlayMuted,
  setArtistList,
  setDeviceAlias,
  setDeviceDisabled,
  setDeviceMute,
  setDeviceVolume,
  setDlnaFallback,
  setOfflineMeasureEnabled,
  setPace,
  setPeerHidden,
  setPeerNameOverride,
  setPlayerDspConfig,
  setPlayerWebhookTokenEnabled,
  setSetting,
  shouldRefreshDevices,
  songSourceInfo,
  songs,
  songsToQueueItems,
  splitMemberId,
  sql,
  sqlite,
  startAirPlayService,
  startAsyncTask,
  startBackfill,
  startOfflineMeasure,
  startSendspinService,
  stopAirPlayService,
  stopAirPlaySession,
  stopDevice,
  stopSendspinService,
  testProxyConnection,
  testWebDAVConnection,
  touch,
  translate,
  unregisterBatchWorker,
  unregisterPlugin,
  updateFlow,
  updateNormalizationSettings,
  updatePipelineSwitches,
  userFavoriteAlbums,
  userFavoriteArtists,
  userFavoriteSongs,
  userIdOfLocalPeer,
  users,
  uuidv4,
  wishes,
};
export type {
  Context,
};
