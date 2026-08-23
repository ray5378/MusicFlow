import { Hono } from "hono";
import type { Context } from "hono";
import { db } from "../../db/index.js";
import { users, playlists, playlistSongs, songs, albums, artists, mediaSources, plugins, wishes, userFavoriteSongs, playlistFavorites, playHistory, genres, deviceQueues } from "../../db/schema.js";
import { eq, like, inArray, or, and, sql, desc, asc, isNotNull, isNull, count } from "drizzle-orm";
import { v4 as uuidv4 } from "uuid";
import { randomBytes } from "node:crypto";
import { apiError, BusinessErrorCode } from "../../utils/errors.js";
import { getRequestMetrics } from "../../middleware/metrics.js";
import md5 from "md5";
import { adminMiddleware, invalidateAuthCaches } from "../../middleware/auth.js";
import { testWebDAVConnection, cleanupOrphans, ScanProgress } from "../../services/source/scanner.js";
import { encryptPassword } from "../../db/index.js";
import { ImportedPlaylist, ImportedTrack, parsePlaylistFile, NATIVE_APP } from "../../services/plugin/playlistImport.js";
import { clearLibraryIndex, getLibraryIndexStats } from "../../services/plugin/libraryIndex.js";
import { touch, registerCacheCleaner, reclaimNow, isIdle, getMemorySnapshot, getReclaimStatus } from "../../services/memory/reclaim.js";
import { getCoverCacheBytes } from "../../services/coverCache.js";
import { getRenderedCoverBytes } from "../../services/coverImage.js";
import { getLyricsCacheEntries } from "../../services/lyrics.js";
import { runPluginJob, getPluginJobState } from "../../services/plugin/jobRunner.js";
import { currentPace, setPace, BatchPace, isBatchBusy } from "../../services/plugin/batchPacer.js";
import { startAsyncTask, getAsyncTask, anyTaskRunning } from "../../services/plugin/asyncTasks.js";
import { runBatchJob } from "../../batch/runner.js";
import { anyJobRunning } from "../../services/plugin/jobRunner.js";
import { isFixedRecommendPlaylist, ensureHomePlaylist } from "../../services/plugin/fixedRecommend.js";
import { maybeRefreshRandomSongs, RANDOM_PLAYLIST_ID } from "../../services/plugin/randomSongs.js";
import { ensurePlayableStream } from "../../services/source/online/streamFallback.js";
import { dailyRecommendApi, localRecommendApi, comboPlaylistApi, dailyRecommendTag, dailyRecommendHomeCount, listHomeCardPlugins, homePositionConflictForSave, playlistSyncApi } from "../../services/pluginAccess.js";
import { sqlite } from "../../db/index.js";
import { isImportedPlaylist, isPluginSyncPlaylist } from "../../utils/playlist.js";
import { getArtistList, setArtistList, invalidateArtistList } from "../../utils/artistListCache.js";
import { clearPlaylistCoverCache } from "../../services/playlistCover.js";
import { getSetting, setSetting, getSettingBool } from "../../services/settings.js";
import { getProxyConfig, normalizeProxyUrl, testProxyConnection } from "../../services/proxy.js";
import { startBackfill, backfillStatus } from "../../services/backfill.js";
import { isDailyRecommendPlaylist, findRecommendPlaylist } from "../../services/source/online/recommendImport.js";
import { scrapeArtist, artistsMissingCovers, artistsMissingInfo } from "../../services/scraper/artist.js";
import {
  refreshDevices, getCachedDevices, shouldRefreshDevices, castToDevice,
  playDevice, pauseDevice, stopDevice, seekDevice, setDeviceVolume, setDeviceMute, getDeviceStatus,
  enqueueNextTrack, getCurrentMedia, recordBaseUrl, getEffectiveBaseUrl, isPrivateLanHostname,
  setDeviceAlias, deleteDeviceRecord, setDeviceDisabled, isDeviceDisabled,
} from "../../services/dlna/control.js";
import { announceOnPeer, isAnnouncing } from "../../services/dlna/announce.js";
import { markStaleDevices } from "../../services/dlna/discovery.js";
import { getEventManager } from "../../services/dlna/eventing.js";
import { getQueueManager } from "../../services/dlna/queue.js";
import { getPeerManager, parsePeerId } from "../../services/peer.js";
import { listAirPlayDevices, castToAirPlayDevice, getAirPlayPeerStatus, setAirPlayMuted, setAirPlayAlias, setAirPlayDisabled, deleteAirPlayDeviceRecord, isAirPlayDeviceDisabled, stopAirPlaySession, isAirPlayEnabled, startAirPlayService, stopAirPlayService } from "../../services/airplay/control.js";
import { resolveContentSongs, songsToQueueItems } from "../../services/content.js";import { listFlows, createFlow, updateFlow, deleteFlow, getFlow, executeFlow, isFlowRunning } from "../../services/flows/index.js";
import {
  listPlayerWebhookTokens, createPlayerWebhookToken, deletePlayerWebhookToken,
  setPlayerWebhookTokenEnabled, resolvePlayerWebhookOwnerName, getPlayerWebhookTokenById,
} from "../../services/player/playerWebhook.js";
import { getGroupManager } from "../../services/group/index.js";
import { getGroupStatus, getGroupLeaderDeviceId } from "../../services/group/protocolPlayer.js";
import { getQueueController } from "../../services/player/index.js";
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
import { unregisterPlugin, firstEnabledByCapability, getPluginConfig, getPluginManifest, getPlugin } from "../../plugins/registry.js";
import fs from "node:fs";
import path from "node:path";
import { getDataDir } from "../../utils/env.js";
import { createLogger } from "../../utils/logger.js";

// 每日推荐 / 本地推荐 / 今日漫游 / 歌单同步能力经 registry 门面访问(核心不直连插件实现;插件未启用时返回安全默认)。
const dailyApi = () => dailyRecommendApi();
const localApi = () => localRecommendApi();
const comboApi = () => comboPlaylistApi();
const syncApi = () => playlistSyncApi();

const log = createLogger("RECOMMEND");
export const apiRoutes = new Hono();
apiRoutes.route("/", onlineRoutes);
apiRoutes.route("/", playlistSearchRoutes);
apiRoutes.route("/", entitySearchRoutes);

// ==================== 首页平台精选（能力驱动，不写死插件名） ====================
// 首页「平台精选」分区由启用的 `recommend` 能力插件提供（如 go-music-dl 的
// /music/recommend）。每个平台展示的歌单数量由插件自身 config.homeCount 控制并
// 在插件内部截断；核心只按能力查询并透传数据，补充远程封面完整 URL + 已导入标记。
// 5min TTL 缓存避免每次首页加载都实时打插件网络请求；失败降级返回空 channels。
const RECOMMEND_CACHE_TTL_MS = 5 * 60_000;
const recommendCache = new Map<string, { ts: number; channels: any[] }>();
/** 清空平台精选缓存(供测试/管理端"立即刷新"使用)。 */
export function clearRecommendCache(): void {
  recommendCache.clear();
}
// 空闲内存回收时一并清空(经注册回调,避免 reclaim 与路由层循环依赖)。
registerCacheCleaner(() => { recommendCache.clear(); });

/** 归一化歌名供兜底比对:去空白、去尾部省略号、小写。 */
function normalizePlaylistName(name: unknown): string {
  return String(name ?? "").trim().replace(/[…...]+$/, "").toLowerCase();
}

/**
 * 把首页「平台精选」的远端歌单匹配到已入库的本地歌单,用于读取真实曲目数量。
 * 命中优先级:sourceUrl 前缀 → externalId+平台 → 歌名+平台。
 * 只依赖本地库定位并取 songCount,完全不用插件远程 trackCount 候补。
 * 覆盖不同入库途径:每日推荐同步/点播导入(有平台 id)、URL/搜索导入(仅剩歌名可对齐)。
 */
function findLocalRemotePlaylist(remoteId: string, source: string, name: string): any | null {
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

apiRoutes.get("/v1/recommend", async (c) => {
  const rp = firstEnabledByCapability("recommend");
  const providerId = rp?.manifest.id || "";
  if (!providerId) return c.json({ success: true, channels: [], providerId: "" });
  const cached = recommendCache.get(providerId);
  if (cached && Date.now() - cached.ts < RECOMMEND_CACHE_TTL_MS) {
    return c.json({ success: true, channels: cached.channels, providerId });
  }
  if (!rp || typeof rp.impl?.recommend !== "function") {
    return c.json({ success: true, channels: [], providerId: "" });
  }
  const config = getPluginConfig(providerId) || {};
  try {
    const result = await rp.impl.recommend(config);
    const baseUrl = String(config.baseUrl || "").replace(/\/+$/, "");
    const channels = (Array.isArray(result?.channels) ? result.channels : []).map((ch: any) => ({
      source: ch.source || "",
      name: ch.name || ch.source || "",
      count: ch.count || 0,
      playlists: (Array.isArray(ch.playlists) ? ch.playlists : []).map((pl: any) => {
        // 首页平台精选歌单均已入库,先用三重匹配定位本地歌单,再取数据库真实
        // songCount(与歌单列表/详情页口径一致)。不再透传插件远程 trackCount——
        // 对已入库歌单该值常为空,导致首页不显示数字。
        const source = pl.source || ch.source || "";
        const local = findLocalRemotePlaylist(pl.id, source, pl.name || "");
        return {
          id: pl.id,
          source,
          name: pl.name || "",
          creator: pl.creator || "",
          // 远程封面 URL:go-music-dl 返回相对路径时用插件 baseUrl 拼成完整地址,
          // 前端才能直接 <img> 渲染。
          cover: pl.cover && !/^https?:\/\//i.test(String(pl.cover))
            ? `${baseUrl}${String(pl.cover).startsWith("/") ? "" : "/"}${pl.cover}`
            : (pl.cover || ""),
          trackCount: local ? String(local.songCount ?? "") : "",
          link: pl.link || "",
          imported: !!local,
        };
      }),
    }));
    recommendCache.set(providerId, { ts: Date.now(), channels });
    return c.json({ success: true, channels, providerId });
  } catch (e: any) {
    console.warn(`[RECOMMEND] ${providerId} recommend() failed:`, e?.message || e);
    return c.json({ success: true, channels: [], providerId, error: String(e?.message || e) });
  }
});

// 首页顶部「每日推荐 + 本地推荐 + 随机歌单」展示张数(含两张固定推荐)。
// 由每日推荐插件的 homeCount 配置控制(默认 8),核心经能力门面读取,不写死插件名。
apiRoutes.get("/v1/home/playlist-count", (c) => {
  return c.json({ success: true, count: dailyRecommendHomeCount() });
});

// ==================== 首页固定卡(推荐插件自治) ====================
// 哪些推荐歌单固定在首页顶部、按什么位次排,由各插件自己的配置决定:
//   manifest.configSchema 声明 showOnHome(switch) / homePosition(number);
//   manifest.homePlaylistId 声明首页对应的固定歌单 id。
// 核心按能力收集(不写死插件名),位次冲突在保存插件配置时校验。
apiRoutes.get("/v1/recommend/home-cards", (c) => {
  // ?all=1 返回全部固定推荐歌单(含未开启「在首页显示」的),供音流等场景
  // 选择固定引用;默认只返回 showOnHome(首页展示)。
  const all = c.req.query("all") === "1";
  const plugins = listHomeCardPlugins().filter((p) => p.showOnHome || all);
  // 位次排序:0(未固定)排最后,固定位次升序。
  const sorted = [...plugins].sort((a, b) => {
    const pa = a.position || Number.MAX_SAFE_INTEGER;
    const pb = b.position || Number.MAX_SAFE_INTEGER;
    return pa - pb || a.pluginId.localeCompare(b.pluginId);
  });
  const cards = sorted.map((p) => {
    const pl = sqlite.prepare("SELECT id, name, song_count, cover_art FROM playlists WHERE id = ?").get(p.playlistId) as any;
    return {
      pluginId: p.pluginId,
      name: p.name,
      playlistId: p.playlistId,
      position: p.position,
      capabilities: p.capabilities,
      isCombo: p.capabilities.includes("comboPlaylist"),
      // 歌单信息(前端按 songCount > 30 门槛展示)
      playlistName: pl?.name || "",
      songCount: pl?.song_count || 0,
      // 统一返回标准逻辑 ref pl-<id>(getCoverArt 按 pl- 前缀查歌单行解析;
      // 直接返回 cover_art 原始值(如 pl-pl-daily-today.jpg)会被当成 playlistId
      // 查表失败 → 首页卡片无封面)。
      coverArt: pl ? `pl-${p.playlistId}` : null,
    };
  });
  return c.json({ success: true, cards });
});

// ==================== 网络代理(管理员,仅插件拉取链路) ====================
// 系统设置里的「网络代理」:http://ip:port、https://ip:port 或 socks5://ip:port,
// 用于插件市场拉取 GitHub 等源(registry / plugin.json / 安装包)。仅影响插件拉取,
// 其它后端网络直连。
apiRoutes.get("/v1/proxy", adminMiddleware, (c) => {
  const { enabled, url } = getProxyConfig();
  return c.json({ success: true, enabled, url });
});

apiRoutes.put("/v1/proxy", adminMiddleware, async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const enabled = !!body.enabled;
  const url = normalizeProxyUrl(String(body.url || ""));
  if (enabled && !url)
    return c.json({ error: "代理地址格式应为 http://ip:port、https://ip:port 或 socks5://ip:port" }, 400);
  setSetting("proxy_enabled", enabled ? "true" : "false");
  setSetting("proxy_url", url);
  return c.json({ success: true, enabled, url });
});

// 测试连接:验证代理通道能否出网(解耦单一 GitHub 域名,区分「代理坏」与「仅 GitHub 被挡」)。
// 返回 { success, message, githubReachable, probes }。
apiRoutes.post("/v1/proxy/test", adminMiddleware, async (c) => {
  const result = await testProxyConnection();
  return c.json(result);
});

// ==================== 后台任务限速档位 ====================
// 批量任务(歌单同步/在线匹配/推荐补全)的 CPU 节流档位:slow|standard|full。
// 存 settings.batch_pace,batchPacer 运行时读取(无需重启)。
apiRoutes.get("/v1/batch-pace", adminMiddleware, (c) => {
  return c.json({ success: true, pace: currentPace() });
});

apiRoutes.put("/v1/batch-pace", adminMiddleware, async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const pace = String(body.pace || "standard");
  if (pace !== "slow" && pace !== "standard" && pace !== "full") {
    return c.json({ error: "档位必须为 slow | standard | full" }, 400);
  }
  setPace(pace as BatchPace);
  return c.json({ success: true, pace });
});

// ==================== Users ====================
apiRoutes.get("/v1/users", adminMiddleware, (c) => {
  return c.json(db.select().from(users).all().map(u => ({ id: u.id, username: u.username, isAdmin: !!u.isAdmin, isActive: !!u.isActive, apiKeySet: !!u.apiKey, apiKeyExpiresAt: u.apiKeyExpiresAt, createdAt: u.createdAt, updatedAt: u.updatedAt })));
});

apiRoutes.post("/v1/users", adminMiddleware, async (c) => {
  const body = await c.req.json();
  const { username, password } = body;
  const subsonicSalt = Math.random().toString(16).substring(2, 10);
  const id = uuidv4();
  db.insert(users).values({ id, username, password: md5(password + subsonicSalt), salt: Math.random().toString(36).substring(2, 10), subsonicSalt, passEnc: encryptPassword(password), isAdmin: 0, isActive: 1 }).run();
  return c.json({ id, username });
});

apiRoutes.put("/v1/users/:id/password", async (c) => {
  const user = c.get("user");
  const id = c.req.param("id")!;
  if (id !== user?.id && !user?.isAdmin) return c.json({ error: "无权修改该用户密码" }, 403);
  const body = await c.req.json();
  if (!body.newPassword) return c.json({ error: "新密码不能为空" }, 400);
  const newSubsonicSalt = Math.random().toString(16).substring(2, 10);
  db.update(users).set({ password: md5(body.newPassword + newSubsonicSalt), subsonicSalt: newSubsonicSalt, passEnc: encryptPassword(body.newPassword), mustChangePassword: 0, apiKey: null, updatedAt: new Date().toISOString() }).where(eq(users.id, id)).run();
  invalidateAuthCaches(); // 密码变更会清空 apiKey → 重建鉴权索引
  return c.json({ success: true });
});

apiRoutes.put("/v1/users/:id/username", async (c) => {
  const user = c.get("user");
  const id = c.req.param("id")!;
  if (id !== user?.id && !user?.isAdmin) return c.json({ error: "无权修改该用户名" }, 403);
  const body = await c.req.json().catch(() => ({}));
  const name = String(body.username || "").trim();
  if (!name) return c.json({ error: "用户名不能为空" }, 400);
  const existing = db.select().from(users).where(eq(users.username, name)).get();
  if (existing && existing.id !== id) return c.json({ error: "用户名已被占用" }, 409);
  db.update(users).set({ username: name, updatedAt: new Date().toISOString() }).where(eq(users.id, id)).run();
  invalidateAuthCaches(); // 用户名变更影响鉴权缓存
  return c.json({ success: true, username: name });
});

apiRoutes.delete("/v1/users/:id", adminMiddleware, (c) => {
  const user = c.get("user");
  const id = c.req.param("id")!;
  if (id === user?.id) return c.json({ error: "不能删除当前登录账号" }, 400);
  const target = db.select().from(users).where(eq(users.id, id)).get();
  if (!target) return c.json(apiError(BusinessErrorCode.NOT_FOUND, "用户不存在"), 404);
  const owned = db.select().from(playlists).where(eq(playlists.ownerId, id)).all();
  if (owned.length > 0) {
    db.delete(playlistSongs).where(inArray(playlistSongs.playlistId, owned.map(p => p.id))).run();
    owned.forEach(p => clearPlaylistCoverCache(p.id));
    db.delete(playlists).where(inArray(playlists.id, owned.map(p => p.id))).run();
  }
  db.delete(userFavoriteSongs).where(eq(userFavoriteSongs.userId, id)).run();
  db.delete(playlistFavorites).where(eq(playlistFavorites.userId, id)).run();
  db.delete(playHistory).where(eq(playHistory.userId, id)).run();
  db.delete(wishes).where(eq(wishes.userId, id)).run();
  db.delete(users).where(eq(users.id, id)).run();
  return c.json({ success: true });
});

// ==================== Current user (HA integration health check) ====================
// Used by the hass-musicflow config flow to verify the API key works.
apiRoutes.get("/v1/users/me", (c) => {
  const user = c.get("user");
  return c.json({ id: user?.id, username: user?.username, isAdmin: user?.isAdmin });
});

// ==================== API Key (long-lived token for third-party clients) ====================
// JWT expires in 24h, which is useless for an always-on client like the Home
// Assistant integration. middleware/auth.ts already accepts users.api_key as a
// Bearer fallback — this is the missing management surface for it.
// Stored in plaintext because authenticateApiKey() compares it directly; that
// also lets the user re-read the key later instead of it being show-once.

apiRoutes.get("/v1/users/me/api-key", (c) => {
  const user = c.get("user");
  const row = db.select().from(users).where(eq(users.id, user!.id)).get();
  return c.json({
    apiKey: row?.apiKey || null,
    expiresAt: row?.apiKeyExpiresAt || null,
  });
});

// body: { expiresInDays?: number }  — omit or 0 for a key that never expires
apiRoutes.post("/v1/users/me/api-key", async (c) => {
  const user = c.get("user");
  const body = await c.req.json().catch(() => ({} as any));
  const days = Number(body?.expiresInDays) || 0;
  const apiKey = `mf_${randomBytes(24).toString("base64url")}`;
  const expiresAt = days > 0
    ? new Date(Date.now() + days * 86400_000).toISOString()
    : null;
  db.update(users)
    .set({ apiKey, apiKeyExpiresAt: expiresAt, updatedAt: new Date().toISOString() })
    .where(eq(users.id, user!.id))
    .run();
  invalidateAuthCaches(); // 新 key 生效前重建索引
  return c.json({ apiKey, expiresAt });
});

apiRoutes.delete("/v1/users/me/api-key", (c) => {
  const user = c.get("user");
  db.update(users)
    .set({ apiKey: null, apiKeyExpiresAt: null, updatedAt: new Date().toISOString() })
    .where(eq(users.id, user!.id))
    .run();
  invalidateAuthCaches(); // 撤销 key 后立即失效
  return c.json({ success: true });
});

// Per-user variants, used by the admin user list so an admin can issue a key for
// a dedicated service account (e.g. a "homeassistant" user) without logging in
// as them. Declared after the /me routes so "me" is not captured by :id.
// Self-service is allowed too, mirroring the password/username endpoints.
function assertKeyAccess(c: Context, id: string) {
  const user = c.get("user");
  return id === user?.id || user?.isAdmin;
}

apiRoutes.get("/v1/users/:id/api-key", (c) => {
  const id = c.req.param("id")!;
  if (!assertKeyAccess(c, id)) return c.json(apiError(BusinessErrorCode.FORBIDDEN, "无权查看该用户的 API Key"), 403);
  const row = db.select().from(users).where(eq(users.id, id)).get();
  if (!row) return c.json(apiError(BusinessErrorCode.NOT_FOUND, "用户不存在"), 404);
  return c.json({ apiKey: row.apiKey || null, expiresAt: row.apiKeyExpiresAt || null });
});

// body: { expiresInDays?: number }  — omit or 0 for a key that never expires
apiRoutes.post("/v1/users/:id/api-key", async (c) => {
  const id = c.req.param("id")!;
  if (!assertKeyAccess(c, id)) return c.json(apiError(BusinessErrorCode.FORBIDDEN, "无权签发该用户的 API Key"), 403);
  const row = db.select().from(users).where(eq(users.id, id)).get();
  if (!row) return c.json(apiError(BusinessErrorCode.NOT_FOUND, "用户不存在"), 404);
  const body = await c.req.json().catch(() => ({} as any));
  const days = Number(body?.expiresInDays) || 0;
  const apiKey = `mf_${randomBytes(24).toString("base64url")}`;
  const expiresAt = days > 0 ? new Date(Date.now() + days * 86400_000).toISOString() : null;
  db.update(users)
    .set({ apiKey, apiKeyExpiresAt: expiresAt, updatedAt: new Date().toISOString() })
    .where(eq(users.id, id))
    .run();
  invalidateAuthCaches(); // 新 key 生效前重建索引
  return c.json({ apiKey, expiresAt });
});

apiRoutes.delete("/v1/users/:id/api-key", (c) => {
  const id = c.req.param("id")!;
  if (!assertKeyAccess(c, id)) return c.json(apiError(BusinessErrorCode.FORBIDDEN, "无权撤销该用户的 API Key"), 403);
  db.update(users)
    .set({ apiKey: null, apiKeyExpiresAt: null, updatedAt: new Date().toISOString() })
    .where(eq(users.id, id))
    .run();
  invalidateAuthCaches(); // 撤销 key 后立即失效
  return c.json({ success: true });
});

// ==================== Sources ====================
apiRoutes.get("/v1/sources", adminMiddleware, (c) => c.json(db.select().from(mediaSources).all().map(s => ({ ...s, config: JSON.parse(s.config || "{}") }))));

apiRoutes.post("/v1/sources", adminMiddleware, async (c) => {
  const body = await c.req.json();
  const id = uuidv4();
  db.insert(mediaSources).values({ id, name: body.name, type: body.type || "webdav", enabled: body.enabled !== false ? 1 : 0, config: JSON.stringify(body.config || {}) }).run();
  return c.json({ id });
});

apiRoutes.put("/v1/sources/:id", adminMiddleware, async (c) => {
  const id = c.req.param("id")!;
  const body = await c.req.json();
  const existing = db.select().from(mediaSources).where(eq(mediaSources.id, id)).get();
  if (!existing) return c.json({ error: "Source not found" }, 404);
  db.update(mediaSources).set({
    name: body.name || existing.name,
    enabled: body.enabled !== undefined ? body.enabled : existing.enabled,
    config: body.config ? JSON.stringify(body.config) : existing.config,
    updatedAt: new Date().toISOString(),
  }).where(eq(mediaSources.id, id)).run();
  return c.json({ success: true });
});

apiRoutes.delete("/v1/sources/:id", adminMiddleware, (c) => {
  const id = c.req.param("id")!;
  // Find all songs belonging to this source (webdav: w:<id>:, local: l:<id>:)
  const sourceSongs = db.select().from(songs).all().filter(s => s.path.startsWith(`w:${id}:`) || s.path.startsWith(`l:${id}:`));
  const songIds = sourceSongs.map(s => s.id);
  if (songIds.length > 0) {
    // Delete dependent rows first (FK constraints)
    db.delete(playlistSongs).where(inArray(playlistSongs.songId, songIds)).run();
    db.delete(userFavoriteSongs).where(inArray(userFavoriteSongs.songId, songIds)).run();
    db.delete(playHistory).where(inArray(playHistory.songId, songIds)).run();
    db.delete(songs).where(inArray(songs.id, songIds)).run();
    cleanupOrphans();
  }
  db.delete(mediaSources).where(eq(mediaSources.id, id)).run();
  return c.json({ success: true, removedSongs: songIds.length });
});

// Test connection
apiRoutes.post("/v1/sources/:id/test", adminMiddleware, async (c) => {
  const id = c.req.param("id")!;
  const source = db.select().from(mediaSources).where(eq(mediaSources.id, id)).get();
  if (!source) return c.json(apiError(BusinessErrorCode.NOT_FOUND, "媒体源不存在"));

  const config = JSON.parse(source.config || "{}");

  if (source.type === "webdav") {
    try {
      console.log("[TEST] URL:", config.url, "root_path:", config.root_path, "user:", config.username);
      const result = await testWebDAVConnection(config.url, config.username, config.password, config.root_path);
      console.log("[TEST] Result:", JSON.stringify(result));
      return c.json(result);
    } catch (e: any) {
      console.log("[TEST] Error:", e.message);
      return c.json(apiError(BusinessErrorCode.UPSTREAM_ERROR, e.message || "连接失败"));
    }
  } else if (source.type === "local") {
    const fs = await import("fs");
    if (fs.existsSync(config.path)) {
      return c.json({ success: true, message: `路径 ${config.path} 存在` });
    } else {
      return c.json({ success: false, error: `路径 ${config.path} 不存在` });
    }
  }
  return c.json(apiError(BusinessErrorCode.INVALID_PARAM, "不支持的媒体源类型"));
});

// Scan source
const scanJobs = new Map<string, { status: string; startedAt: string; progress?: ScanProgress; result?: any; error?: string; mode?: string; controller?: AbortController }>();

// 完成/失败/停止的扫描任务保留 30 min(前端轮询取结果),超时清理防 Map 无界
// (running 中任务不清,避免并发扫描判定失效;参照 online.ts matchJobs 同款)。
const SCAN_JOB_TTL_MS = 30 * 60 * 1000;
const scanJobsSweep = setInterval(() => {
  const now = Date.now();
  for (const [k, v] of scanJobs) {
    if (v.status === "running") continue;
    if (now - Date.parse(v.startedAt) >= SCAN_JOB_TTL_MS) scanJobs.delete(k);
  }
}, 5 * 60 * 1000);
(scanJobsSweep as any).unref?.();

apiRoutes.post("/v1/sources/:id/scan", adminMiddleware, async (c) => {
  touch(); // 标记活动:媒体源扫描
  const id = c.req.param("id")!;
  const source = db.select().from(mediaSources).where(eq(mediaSources.id, id)).get();
  if (!source) return c.json(apiError(BusinessErrorCode.NOT_FOUND, "媒体源不存在"));
  if (!source.enabled) return c.json(apiError(BusinessErrorCode.CONFLICT, "媒体源已禁用"));
  if (scanJobs.has(id) && scanJobs.get(id)!.status === "running") {
    return c.json(apiError(BusinessErrorCode.CONFLICT, "扫描正在进行中"));
  }

  const body = await c.req.json().catch(() => ({}));
  const mode: "full" | "incremental" = body.mode === "incremental" ? "incremental" : "full";

  const config = JSON.parse(source.config || "{}");
  const controller = new AbortController();
  const job = { status: "running", startedAt: new Date().toISOString(), progress: undefined as ScanProgress | undefined, mode, controller };
  scanJobs.set(id, job);

  // 扫描在一次性批量子进程里执行(方案3);子进程进度经 IPC 转发:
  //   { stage: "scan", ...ScanProgress } → job.progress
  //   { stage: "scrape-start" | "scrape" | "scrape-done" | "scrape-failed" } → scrapeJobs
  const onProgress = (p: any) => {
    if (!p || typeof p !== "object") return;
    if (p.stage === "scrape-start") {
      const j = { status: "running", startedAt: new Date().toISOString(), progress: { done: 0, total: p.total } as any };
      scrapeJobs.set(SCRAPE_JOB_ID, j);
      return;
    }
    if (p.stage === "scrape-done") {
      const cur = scrapeJobs.get(SCRAPE_JOB_ID);
      if (cur) scrapeJobs.set(SCRAPE_JOB_ID, { status: "done", startedAt: cur.startedAt, finishedAt: new Date().toISOString(), progress: p.progress });
      log.info(`[ARTIST-SCRAPE] done: scraped ${p.progress?.scraped}, skipped ${p.progress?.skipped}, errors ${p.progress?.errors?.length}`);
      return;
    }
    if (p.stage === "scrape-failed") {
      const cur = scrapeJobs.get(SCRAPE_JOB_ID);
      if (cur) scrapeJobs.set(SCRAPE_JOB_ID, { status: "failed", startedAt: cur.startedAt, error: p.error || "刮削失败", progress: cur.progress });
      return;
    }
    if (p.stage === "scrape") {
      const cur = scrapeJobs.get(SCRAPE_JOB_ID);
      if (cur) cur.progress = { ...p };
      return;
    }
    job.progress = { ...p };
  };

  (async () => {
    try {
      const { result, aborted } = await runBatchJob("scan", { sourceId: id, mode }, { signal: controller.signal, onProgress });
      if (aborted || controller.signal.aborted) {
        scanJobs.set(id, { status: "stopped", result: result?.result, startedAt: job.startedAt, progress: job.progress, mode });
      } else {
        scanJobs.set(id, { status: "completed", result: result?.result, startedAt: job.startedAt, progress: job.progress, mode });
      }
    } catch (e: any) {
      log.error("[SCANNER] Scan error", { err: e });
      scanJobs.set(id, { status: "failed", error: e.message || "扫描失败", startedAt: job.startedAt, progress: job.progress, mode });
    }
  })();

  return c.json({ success: true, message: mode === "incremental" ? "增量扫描已开始" : "全库扫描已开始" });
});

// Stop a running scan
apiRoutes.post("/v1/sources/:id/scan-stop", adminMiddleware, (c) => {
  const id = c.req.param("id")!;
  const job = scanJobs.get(id);
  if (!job || job.status !== "running") return c.json(apiError(BusinessErrorCode.CONFLICT, "没有正在运行的扫描"));
  job.controller?.abort();
  return c.json({ success: true, message: "正在停止扫描..." });
});

apiRoutes.get("/v1/sources/:id/scan-status", adminMiddleware, (c) => {
  const id = c.req.param("id")!;
  const job = scanJobs.get(id);
  if (!job) return c.json({ status: "idle" });
  return c.json({ status: job.status, progress: job.progress, result: job.result, error: job.error, startedAt: job.startedAt, mode: job.mode });
});

// ==================== Plugins ====================
// 内置插件 = 随服务端发行的功能:可停用(服务生命周期按插件联动)、不可删除、不可更新。
const BUILTIN_IDS = new Set(BUILTIN_PLUGINS.map((b) => b.manifest.id));
const isBuiltinRow = (r: any): boolean => BUILTIN_IDS.has(r?.id) || BUILTIN_IDS.has(r?.name);

apiRoutes.get("/v1/plugins", adminMiddleware, (c) => {
  const rows = db.select().from(plugins).all() as any[];
  return c.json(rows.map((r) => {
    const builtin = isBuiltinRow(r);
    // manifest/version 以注册表内存为准:DB 可能是升级前的旧快照(缺新增配置项
    // 或版本停留旧值),这里统一覆盖返回;已卸载/不再注册的插件行回退 DB 数据。
    let manifest = r.manifest;
    let version = r.version;
    const m = getPluginManifest(r.name);
    if (m) {
      manifest = JSON.stringify(m);
      version = m.version;
    }
    return { ...r, manifest, version, builtin };
  }));
});
apiRoutes.post("/v1/plugins", adminMiddleware, async (c) => { const body = await c.req.json(); const id = uuidv4(); db.insert(plugins).values({ id, name: body.name, version: body.version || "", description: body.description || "", manifest: JSON.stringify(body.manifest || {}), enabled: body.enabled ? 1 : 0, config: JSON.stringify(body.config || {}) }).run(); return c.json({ id }); });
apiRoutes.put("/v1/plugins/:id", adminMiddleware, async (c) => {
  const p = db.select().from(plugins).where(eq(plugins.id, c.req.param("id")!)).get();
  if (!p) return c.json({ error: "插件不存在" }, 404);
  const body = await c.req.json().catch(() => ({}));
  const builtin = isBuiltinRow(p);
  // 首页位次冲突预检:推荐插件保存 showOnHome/homePosition 时,与其它「显示在首页」
  // 的插件位次重复则拒绝保存(自己占自己位次不算冲突)。
  if (body.config !== undefined) {
    const conflict = homePositionConflictForSave(p.id, body.config);
    if (conflict) return c.json({ error: conflict }, 400);
  }
  db.update(plugins).set({
    config: body.config !== undefined ? JSON.stringify(body.config) : p.config,
    // 内置核心插件强制启用,忽略停用请求(可更新配置/描述,不可停用)。
    enabled: builtin ? 1 : (body.enabled !== undefined ? (body.enabled ? 1 : 0) : p.enabled),
    description: typeof body.description === "string" ? body.description : p.description,
    version: typeof body.version === "string" ? body.version : p.version,
    name: typeof body.name === "string" ? body.name : p.name,
    updatedAt: new Date().toISOString(),
  }).where(eq(plugins.id, p.id)).run();
  return c.json({ success: true });
});
apiRoutes.put("/v1/plugins/:id/toggle", adminMiddleware, (c) => {
  const p = db.select().from(plugins).where(eq(plugins.id, c.req.param("id")!)).get();
  if (!p) return c.json({ error: "插件不存在" }, 404);
  // 启用插件时若其已配置首页显示位次,与其它插件位次冲突则拒绝启用。
  if (!p.enabled) {
    let cfg: any = {};
    try { cfg = p.config ? JSON.parse(p.config) : {}; } catch {}
    const conflict = homePositionConflictForSave(p.id, cfg);
    if (conflict) return c.json({ error: conflict }, 400);
  }
  const nextEnabled = p.enabled ? 0 : 1;
  db.update(plugins).set({ enabled: nextEnabled }).where(eq(plugins.id, p.id)).run();
  // 内置插件的服务生命周期联动:airplay-renderer 开关 → 启动/停止 AirPlay 服务
  // (开启才启动 mDNS discovery;关闭时停全部会话 + 清 peer/player + 释放 socket,零常驻资源)。
  if (p.id === "airplay-renderer" || p.name === "airplay-renderer") {
    if (nextEnabled) startAirPlayService();
    else void stopAirPlayService();
  }
  return c.json({ success: true });
});
// 删除插件(仅外置插件;内置核心插件不可删除)。删除目录 + 释放沙箱 + 反注册 + 删 DB 行。
apiRoutes.delete("/v1/plugins/:id", adminMiddleware, (c) => {
  const id = c.req.param("id")!;
  const p = db.select().from(plugins).where(eq(plugins.id, id)).get() as any;
  if (!p) return c.json({ error: "插件不存在" }, 404);
  if (isBuiltinRow(p)) return c.json({ error: "内置核心插件不可删除" }, 400);
  const sandbox = pluginSandboxes.get(p.id) || pluginSandboxes.get(p.name);
  if (sandbox) {
    try { sandbox.dispose(); } catch { /* ignore */ }
    pluginSandboxes.delete(p.id);
    pluginSandboxes.delete(p.name);
  }
  unregisterPlugin(p.id);
  unregisterPlugin(p.name);
  const dir = path.join(getDataDir(), "plugins", p.id);
  if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
  db.delete(plugins).where(eq(plugins.id, p.id)).run();
  log.info(`[PLUGIN] 已删除插件 ${p.id} (${p.name || ""})`);
  return c.json({ success: true });
});

// Plugin health:主动 ping(实现了 health() 的插件自检,带缓存) + 被动观测记录 + none。
// — see plugins/health.ts.
apiRoutes.get("/v1/plugins/health", adminMiddleware, async (c) => c.json({ health: await pingAllHealth() }));

// Renderer plugins (device-casting capability).
apiRoutes.get("/v1/plugins/renderers", adminMiddleware, (c) => c.json({ renderers: getRendererPlugins() }));
apiRoutes.get("/v1/plugins/renderers/devices", adminMiddleware, async (c) => {
  try { return c.json({ devices: await discoverRenderers() }); }
  catch (e: any) { return c.json({ error: e.message || "发现设备失败" }, 500); }
});

// Scrobbler plugins (playback reporting).
apiRoutes.get("/v1/plugins/scrobblers", adminMiddleware, (c) => c.json({ scrobblers: getScrobblerPlugins() }));

// ==================== Plugin marketplace (distribution registry) ====================
apiRoutes.get("/v1/plugins/registry", adminMiddleware, async (c) => {
  try {
    const [sources, marketplace, groups] = await Promise.all([
      Promise.resolve(listRegistries()),
      listMarketplace(),
      collectRegistryGroups(),
    ]);
    // 注册表来源:把本次拉取的错误状态(enrich)回传给前端,让"加载失败"的注册表显式可见,
    // 而不是像以前那样整组静默消失。前端据此在市场分组里给出网络/可达性提示。
    const regError = new Map(groups.map((g) => [g.registryUrl, g.error]));
    const registries = sources.map((r) => ({ ...r, error: regError.get(r.url) || null }));
    // 市场 = 注册表插件(官方内置核心插件不在此列出,只在「已安装」tab 展示)。
    const installedRows = db.select().from(plugins).all() as any[];
    const stateById = new Map(installedRows.map((p) => [p.id, p]));
    const merged = marketplace.map((m) => {
      const row = stateById.get(m.id);
      return { ...m, installed: !!row, installedVersion: row?.version, enabled: row?.enabled ?? 0 };
    });
    return c.json({ registries, plugins: merged });
  } catch (e: any) {
    return c.json({ error: e.message || "拉取插件市场失败" }, 500);
  }
});
apiRoutes.post("/v1/plugins/registry", adminMiddleware, async (c) => {
  const body = await c.req.json().catch(() => ({}));
  if (!body?.url) return c.json({ error: "需要 registry URL" }, 400);
  try { return c.json({ id: addRegistry(body.url) }); }
  catch (e: any) { return c.json({ error: e.message || "添加失败" }, 400); }
});
apiRoutes.delete("/v1/plugins/registry/:id", adminMiddleware, (c) => {
  removeRegistry(c.req.param("id")!);
  return c.json({ success: true });
});
apiRoutes.post("/v1/plugins/registry/install", adminMiddleware, async (c) => {
  const body = await c.req.json().catch(() => ({}));
  if (!body?.downloadUrl) return c.json({ error: "需要 downloadUrl" }, 400);
  try {
    const r = await installPlugin(body.downloadUrl);
    return c.json({ success: true, ...r });
  } catch (e: any) {
    return c.json({ error: e.message || "安装失败" }, 500);
  }
});

// ==================== Wish ====================
// ==================== Wish (paginated) ====================
apiRoutes.get("/v1/wish", adminMiddleware, (c) => {
  const page = Math.max(1, parseInt(c.req.query("page") || "1") || 1);
  const pageSize = Math.min(100, Math.max(1, parseInt(c.req.query("pageSize") || "20") || 20));
  const query = (c.req.query("query") || "").trim();
  const status = (c.req.query("status") || "").trim();
  let all = db.select().from(wishes).all();
  if (query) {
    const q = query.toLowerCase();
    all = all.filter(w => (w.songTitle || "").toLowerCase().includes(q) || (w.artist || "").toLowerCase().includes(q));
  }
  if (status) all = all.filter(w => w.status === status);
  const total = all.length;
  const items = all.sort((a, b) => (b.createdAt || "").localeCompare(a.createdAt || "")).slice((page - 1) * pageSize, page * pageSize);
  return c.json({ total, page, pageSize, items });
});
apiRoutes.post("/v1/wish", adminMiddleware, async (c) => { const user = c.get("user"); const body = await c.req.json(); const id = uuidv4(); db.insert(wishes).values({ id, userId: user?.id || "", songTitle: body.songTitle, artist: body.artist || "", album: body.album || "", status: "pending" }).run(); return c.json({ id }); });

// Export ALL wishes as "artist songTitle" lines (for copying to import into download tools)
apiRoutes.get("/v1/wish/export", adminMiddleware, (c) => {
  const all = db.select().from(wishes).all()
    .sort((a, b) => (b.createdAt || "").localeCompare(a.createdAt || ""));
  const text = all.map(w => [w.artist, w.songTitle].filter(Boolean).join(" ")).filter(Boolean).join("\n");
  return c.json({ text, count: all.length });
});

// ==================== Stats ====================
apiRoutes.get("/v1/stats", (c) => {
  const songCount = db.select().from(songs).all().length;
  const albumCount = db.select().from(albums).all().length;
  const artistCount = db.select().from(artists).all().length;
  const userCount = db.select().from(users).all().length;
  return c.json({ songCount, albumCount, artistCount, userCount });
});

// ==================== Songs (paginated + searchable) ====================
apiRoutes.get("/v1/songs", (c) => {
  const page = Math.max(1, parseInt(c.req.query("page") || "1") || 1);
  const pageSize = Math.min(200, Math.max(1, parseInt(c.req.query("pageSize") || "50") || 50));
  const query = (c.req.query("query") || "").trim();
  const genre = (c.req.query("genre") || "").trim();
  // sort=recentAdded: 最新添加入库的歌曲（按入库时间倒序，封顶 500 首，新入库自动进入列表）
  const sort = (c.req.query("sort") || "").trim();
  const recentAdded = sort === "recentAdded";
  // SQL-level filtering + pagination (avoids loading the whole table into memory)
  const conds = [];
  if (genre) conds.push(eq(songs.genre, genre));
  if (query) {
    const q = `%${query}%`;
    conds.push(or(like(songs.title, q), like(songs.artist, q), like(songs.album, q)));
  }
  const where = conds.length > 0 ? (conds.length === 1 ? conds[0] : and(...conds)) : undefined;
  // 最近添加模式最多只取 500 首（超出部分不算在总数内）
  const RECENT_ADDED_CAP = 500;
  const start = (page - 1) * pageSize;
  // Fast SQL count for the total
  const totalRow = where
    ? db.select({ n: sql<number>`count(*)` }).from(songs).where(where).get()
    : db.select({ n: sql<number>`count(*)` }).from(songs).get();
  const rawTotal = totalRow?.n ?? 0;
  const total = recentAdded ? Math.min(RECENT_ADDED_CAP, rawTotal) : rawTotal;
  // 最近添加模式的分页不超出 500 首范围
  const safeStart = recentAdded ? Math.min(start, Math.max(0, total - pageSize)) : start;
  // SQL-level pagination
  const pageSongs = recentAdded
    ? (where
        ? db.select().from(songs).where(where).orderBy(desc(songs.createdAt)).limit(pageSize).offset(safeStart).all()
        : db.select().from(songs).orderBy(desc(songs.createdAt)).limit(pageSize).offset(safeStart).all())
    : (where
        ? db.select().from(songs).where(where).orderBy(songs.title).limit(pageSize).offset(start).all()
        : db.select().from(songs).orderBy(songs.title).limit(pageSize).offset(start).all());
  // Batch album cover lookups for songs without their own cover (avoids N+1
  // album queries on every page). Logic identical to idToCoverArt().
  const coverAlbumIds = [...new Set(pageSongs.filter((s) => !s.coverArt && s.albumId).map((s) => s.albumId as string))];
  const coverMap = coverAlbumIds.length
    ? new Map(db.select().from(albums).where(inArray(albums.id, coverAlbumIds)).all().map((a) => [a.id, a.coverArt ? `al-${a.id}` : undefined as string | undefined]))
    : new Map<string, string | undefined>();
  const items = pageSongs.map(s => ({
    id: s.id, title: s.title, artist: s.artist, album: s.album, artistId: s.artistId,
    albumId: s.albumId, duration: s.duration, bitRate: s.bitRate, suffix: s.suffix,
    contentType: s.contentType, size: s.size, playCount: s.playCount, genre: s.genre,
    track: s.track, discNumber: s.discNumber,
    coverArt: s.coverArt ? `so-${s.id}` : (s.albumId ? coverMap.get(s.albumId) : undefined),
  }));
  return c.json({ total, page, pageSize, items });
});

function idToCoverArt(id: string | null, prefix: string): string | undefined {
  if (!id) return undefined;
  const album = db.select().from(albums).where(eq(albums.id, id)).get();
  return album && album.coverArt ? `${prefix}-${album.id}` : undefined;
}

// Web/online-imported albums (go-music-dl etc.) cache artwork on the song rows
// (songs.cover_art), not the album row. Fall back to the first song-with-cover
// so imported albums aren't blank everywhere (grid, detail, artist pages).
function albumCoverRef(a: any): string | undefined {
  if (a?.coverArt) return `al-${a.id}`;
  const song = db.select({ id: songs.id }).from(songs)
    .where(and(eq(songs.albumId, a?.id), isNotNull(songs.coverArt)))
    .limit(1).get();
  return song ? `so-${song.id}` : undefined;
}

// ==================== Genres (with unique ids + song counts) ====================
// 风格 ID 由 genres 表分配(启动时 backfillGenres 回填;此处兜底按需补建)。
function genreIdFor(name: string): string {
  const row = sqlite.prepare("SELECT id FROM genres WHERE name = ?").get(name) as any;
  if (row?.id) return row.id;
  const id = uuidv4();
  const now = new Date().toISOString();
  sqlite.prepare("INSERT OR IGNORE INTO genres (id, name, song_count, created_at, updated_at) VALUES (?, ?, 0, ?, ?)").run(id, name, now, now);
  const re = sqlite.prepare("SELECT id FROM genres WHERE name = ?").get(name) as any;
  return re?.id || id;
}

apiRoutes.get("/v1/genres", (c) => {
  const page = Math.max(1, parseInt(c.req.query("page") || "1") || 1);
  const pageSize = Math.min(200, Math.max(1, parseInt(c.req.query("pageSize") || "50") || 50));
  const query = (c.req.query("query") || "").trim();
  const rows = db.select({
    name: songs.genre,
    songCount: sql<number>`count(*)`,
  }).from(songs)
    .where(sql`genre != ''`)
    .groupBy(songs.genre)
    .orderBy(sql`count(*) DESC`)
    .all();
  const mapped = rows.filter((r) => r.name).map(r => ({ id: genreIdFor(r.name as string), name: r.name, songCount: r.songCount }));
  const filtered = query ? mapped.filter(g => (g.name || "").toLowerCase().includes(query.toLowerCase())) : mapped;
  const total = filtered.length;
  const start = (page - 1) * pageSize;
  return c.json({ total, page, pageSize, items: filtered.slice(start, start + pageSize) });
});

// ==================== Albums (paginated + searchable) ====================
apiRoutes.get("/v1/albums", (c) => {
  const page = Math.max(1, parseInt(c.req.query("page") || "1") || 1);
  const pageSize = Math.min(200, Math.max(1, parseInt(c.req.query("pageSize") || "50") || 50));
  const query = (c.req.query("query") || "").trim();
  // SQL-level filter (name/artist LIKE) + ORDER BY created_at DESC + pagination,
  // so we no longer load the whole albums table into memory on every request.
  const where = query
    ? or(like(albums.name, `%${query}%`), like(albums.artist, `%${query}%`))
    : undefined;
  const totalRow = where
    ? db.select({ n: sql<number>`count(*)` }).from(albums).where(where).get()
    : db.select({ n: sql<number>`count(*)` }).from(albums).get();
  const total = totalRow?.n ?? 0;
  const start = (page - 1) * pageSize;
  const rows = where
    ? db.select().from(albums).where(where).orderBy(desc(albums.createdAt)).limit(pageSize).offset(start).all()
    : db.select().from(albums).orderBy(desc(albums.createdAt)).limit(pageSize).offset(start).all();
  const items = rows.map(a => ({
    id: a.id, name: a.name, artist: a.artist, artistId: a.artistId, year: a.year,
    songCount: a.songCount, duration: a.duration, playCount: a.playCount,
    coverArt: albumCoverRef(a),
  }));
  return c.json({ total, page, pageSize, items });
});

// ==================== Artists (paginated + searchable) ====================
apiRoutes.get("/v1/artists", (c) => {
  const page = Math.max(1, parseInt(c.req.query("page") || "1") || 1);
  const pageSize = Math.min(200, Math.max(1, parseInt(c.req.query("pageSize") || "50") || 50));
  const query = (c.req.query("query") || "").trim();
  // Push the name search to SQL to shrink the working set; the final sort stays
  // in JS (localeCompare) so Chinese/locale ordering is preserved exactly.
  // 无限滚动每块都调此端点:全量取数+排序是每块延迟主因(17k 行实测 ~90ms)。
  // 按 query 缓存「排好序的完整数组」,滚动期间各块直接切片复用;写入后缓存失效。
  const cacheKey = query.toLowerCase();
  const rows = (getArtistList(cacheKey) as typeof artists.$inferSelect[]) || buildArtistList(cacheKey, query);
  const total = rows.length;
  const start = (page - 1) * pageSize;
  const items = rows.slice(start, start + pageSize).map(a => ({
    id: a.id, name: a.name, albumCount: a.albumCount, coverArt: a.coverArt ? `ar-${a.id}` : undefined,
    scrapeMissing: a.scrapeMissing === 1,
  }));
  return c.json({ total, page, pageSize, items });
});

// 取全量/搜索艺术家并做 JS localeCompare 排序(保留中文序),结果按 query 缓存供后续块复用。
function buildArtistList(cacheKey: string, query: string): typeof artists.$inferSelect[] {
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
const scrapeJobs = new Map<string, any>();
const SCRAPE_JOB_ID = "default";

apiRoutes.post("/v1/artists/scrape", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const name = (body.name || "").trim();
  try {
    if (name) {
      const result = await scrapeArtist(name, body.artistId || undefined);
      if (!result) return c.json(apiError(BusinessErrorCode.NOT_FOUND, "未找到歌手信息(QQ 和网易云均无结果)"));
      return c.json({ success: true, name: result.name, platform: result.platform, coverArt: result.coverArt, bio: result.bio || undefined });
    }
    // Full scrape: all artists missing covers, run in background with progress
    if (scrapeJobs.get(SCRAPE_JOB_ID)?.status === "running") {
      return c.json(apiError(BusinessErrorCode.CONFLICT, "刮削正在进行中"));
    }
    const missing = artistsMissingCovers();
    const job = { status: "running", startedAt: new Date().toISOString(), progress: undefined as any };
    scrapeJobs.set(SCRAPE_JOB_ID, job);
    const onProgress = (p: any) => { job.progress = { ...p }; };
    (async () => {
      try {
        const { result } = await runBatchJob("scrape-artists", { artistIds: missing.map(a => a.id) }, { onProgress });
        scrapeJobs.set(SCRAPE_JOB_ID, { status: "done", startedAt: job.startedAt, finishedAt: new Date().toISOString(), progress: result });
      } catch (e: any) {
        scrapeJobs.set(SCRAPE_JOB_ID, { status: "failed", startedAt: job.startedAt, error: e.message || "刮削失败", progress: job.progress });
      }
    })();
    return c.json({ success: true, total: missing.length, message: "开始刮削" });
  } catch (e: any) {
    return c.json(apiError(BusinessErrorCode.UPSTREAM_ERROR, e.message || "刮削失败"));
  }
});

apiRoutes.get("/v1/artists/scrape-status", (c) => {
  const job = scrapeJobs.get(SCRAPE_JOB_ID);
  if (!job) return c.json({ status: "idle", progress: null });
  return c.json({ status: job.status, progress: job.progress || null, error: job.error || null, startedAt: job.startedAt });
});

// Retry scraping ONLY artists marked as missing-info (fallback cover in use).
// If the platform now has the artist, the avatar is replaced with the real one
// and the missing flag is cleared.
apiRoutes.post("/v1/artists/scrape-missing", async (c) => {
  try {
    if (scrapeJobs.get(SCRAPE_JOB_ID)?.status === "running") {
      return c.json(apiError(BusinessErrorCode.CONFLICT, "刮削正在进行中"));
    }
    const missing = artistsMissingInfo();
    if (missing.length === 0) {
      return c.json({ success: true, total: 0, message: "没有缺失歌手信息的歌手" });
    }
    const job = { status: "running", startedAt: new Date().toISOString(), progress: undefined as any };
    scrapeJobs.set(SCRAPE_JOB_ID, job);
    const onProgress = (p: any) => { job.progress = { ...p }; };
    (async () => {
      try {
        const { result } = await runBatchJob("scrape-artists", { artistIds: missing.map(a => a.id) }, { onProgress });
        scrapeJobs.set(SCRAPE_JOB_ID, { status: "done", startedAt: job.startedAt, finishedAt: new Date().toISOString(), progress: result });
      } catch (e: any) {
        scrapeJobs.set(SCRAPE_JOB_ID, { status: "failed", startedAt: job.startedAt, error: e.message || "刮削失败", progress: job.progress });
      }
    })();
    return c.json({ success: true, total: missing.length, message: "开始刮削缺失歌手信息" });
  } catch (e: any) {
    return c.json(apiError(BusinessErrorCode.UPSTREAM_ERROR, e.message || "刮削失败"));
  }
});

// Count of artists marked missing-info (for the frontend badge)
apiRoutes.get("/v1/artists/missing-info-count", (c) => {
  return c.json({ count: artistsMissingInfo().length });
});

// ==================== Settings ====================
apiRoutes.get("/v1/settings", adminMiddleware, (c) => c.json({ writeBackTags: false, fingerprintEnabled: false }));

// 手动触发一轮空闲内存回收(系统设置页「立即回收」按钮)。返回各层回收结果 + 回收前后内存。
apiRoutes.post("/v1/admin/memory/reclaim", adminMiddleware, (c) => {
  const r = reclaimNow("manual");
  return c.json({ success: true, ...r });
});

// 空闲内存自动回收设置:开关 + 空闲阈值(分钟)。存 settings 表,reclaim 运行时读取。
// 附带实时内存快照与回收状态,供发版后一眼确认内存曲线(只读观测)。
apiRoutes.get("/v1/admin/memory-settings", adminMiddleware, (c) => {
  const v = parseInt(getSetting("memory_idle_minutes", "5"), 10);
  const mem = getMemorySnapshot();
  const rs = getReclaimStatus();
  const libIndex = getLibraryIndexStats();
  return c.json({
    success: true,
    enabled: getSettingBool("memory_auto_reclaim", true),
    idleMinutes: Number.isFinite(v) && v > 0 ? v : 5,
    rssMB: mem.rssMB,
    heapUsedMB: mem.heapUsedMB,
    externalMB: mem.externalMB,
    arrayBuffersMB: mem.arrayBuffersMB,
    isIdle: isIdle(),
    isBatchBusy: isBatchBusy(),
    lastReclaimAt: rs.lastReclaimAt,
    lastReclaim: rs.lastReclaim,
    // 可重建缓存明细(全部可被空闲回收清空;pageCacheMB 为 SQLite 页缓存估算)。
    caches: {
      coverRawBytes: getCoverCacheBytes(),
      coverRenderedBytes: getRenderedCoverBytes(),
      lyricsEntries: getLyricsCacheEntries(),
      libraryIndexBuilt: libIndex.built,
      libraryIndexSongs: libIndex.songs,
      pageCacheMB: 10, // cache_size = -10000 KB
    },
  });
});
apiRoutes.put("/v1/admin/memory-settings", adminMiddleware, async (c) => {
  const body = await c.req.json().catch(() => ({}));
  if (typeof body.enabled === "boolean") setSetting("memory_auto_reclaim", String(body.enabled));
  if (Number.isFinite(body.idleMinutes) && (body.idleMinutes as number) >= 1) {
    setSetting("memory_idle_minutes", String(Math.round(body.idleMinutes as number)));
  }
  return c.json({ success: true });
});

// 请求指标:总请求数 / 慢请求数 / 端点调用计数(内存态,重启清零)。
apiRoutes.get("/v1/admin/metrics", adminMiddleware, (c) => {
  return c.json({ success: true, ...getRequestMetrics() });
});

// ==================== Lyrics / covers media-fetch settings + backfill ====================
// A(按需)/B(落库)/C(批量补全) + 独立选源(providerId)。设置存全局 settings 表:
// 行为归核心、UI 按能力挂载(lyricProvider/coverProvider 插件配置页),与具体
// 插件解耦——换插件设置不变,选中插件被禁用/卸载自动回退全部启用 provider。
const setLyricsCoversSettings = async (c: Context, prefix: "lyrics" | "cover") => {
  const body = await c.req.json().catch(() => ({}));
  // providerId: 字符串直接存;清空(el-select clearable → undefined/null)→ 存空串(=自动)。
  if (typeof body.providerId === "string") setSetting(`${prefix}.providerId`, body.providerId);
  else if (body.providerId === undefined || body.providerId === null) setSetting(`${prefix}.providerId`, "");
  if (typeof body.onDemand === "boolean") setSetting(`${prefix}.onDemand`, body.onDemand ? "true" : "false");
  if (typeof body.persist === "boolean") setSetting(`${prefix}.persist`, body.persist ? "true" : "false");
  return c.json({ success: true });
};

apiRoutes.get("/v1/lyrics/settings", adminMiddleware, (c) => c.json({
  providerId: getSetting("lyrics.providerId", ""),
  onDemand: getSettingBool("lyrics.onDemand", true),
  persist: getSettingBool("lyrics.persist", false),
}));
apiRoutes.put("/v1/lyrics/settings", adminMiddleware, (c) => setLyricsCoversSettings(c, "lyrics"));

apiRoutes.get("/v1/covers/settings", adminMiddleware, (c) => c.json({
  providerId: getSetting("cover.providerId", ""),
  onDemand: getSettingBool("cover.onDemand", true),
  persist: getSettingBool("cover.persist", true),
}));
// 注意:封面的全局设置键前缀是 `cover.*`(与 providers.ts / covers.ts / GET 一致),
// 这里必须传 "cover" 而非字面的 "covers",否则写入 covers.* 而无人读取,等同未落库。
apiRoutes.put("/v1/covers/settings", adminMiddleware, (c) => setLyricsCoversSettings(c, "cover"));

// 手动批量补全(节流执行,后台运行;同种任务在跑则返回 running=true)
apiRoutes.post("/v1/lyrics/backfill", adminMiddleware, (c) => c.json(startBackfill("lyrics")));
apiRoutes.get("/v1/lyrics/backfill/status", adminMiddleware, (c) => c.json(backfillStatus("lyrics")));
apiRoutes.post("/v1/covers/backfill", adminMiddleware, (c) => c.json(startBackfill("covers")));
apiRoutes.get("/v1/covers/backfill/status", adminMiddleware, (c) => c.json(backfillStatus("covers")));

// covers-batch:并发批量补封面(≤2 并发,复用 runCoverBackfill,返回立即)。
apiRoutes.post("/v1/covers/backfill-batch", adminMiddleware, (c) => c.json(startBackfill("covers-batch")));
apiRoutes.get("/v1/covers/backfill-batch/status", adminMiddleware, (c) => c.json(backfillStatus("covers-batch")));

// ==================== Daily recommend (combined: remote + pool + local) ====================
//
// These admin endpoints let you inspect / reconfigure / manually trigger the
// daily-recommend system. The actual generation logic lives in
// services/plugin/dailyRecommend.ts; the scheduler that fires it daily lives
// in index.ts.

// Snapshot of the current daily-recommend config + state, for the admin UI.
apiRoutes.get("/v1/daily-recommend", adminMiddleware, (c) => {
  const get = (k: string, def: string) => {
    const r = sqlite.prepare("SELECT value FROM settings WHERE key = ?").get(k) as any;
    return r?.value ?? def;
  };
  const getBool = (k: string, def: boolean) => {
    const v = get(k, def ? "true" : "false");
    return v === "true" || v === "1";
  };
  const candidates = dailyApi()?.loadCandidates() ?? [];
  const picked = dailyApi()?.pickDailyCandidate() ?? null;

  // Only ONE playlist ever exists: 「每日推荐」(combined: remote charts + user
  // pool, all merged into one).
  const today = (() => {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  })();
  const findPl = (name: string, tag: string) =>
    sqlite.prepare("SELECT id, name, song_count, created_at, comment FROM playlists WHERE name = ? AND comment LIKE ?").get(name, `%${tag}%`) as any;

  const todayPl = findPl(dailyRecommendTag() || "每日推荐", dailyRecommendTag() || "每日推荐");

  const plInfo = (row: any) => row ? {
    id: row.id, name: row.name, songCount: row.song_count || 0,
    // The daily generator stamps the generation date into the playlist's
    // comment (created_at is now fixed, since the playlist row is reused), so
    // "generated today" is detected from the comment, not created_at.
    createdToday: (row.comment || "").includes(today),
  } : null;

  return c.json({
    enabled: getBool("daily_recommend_enabled", true),
    hour: parseInt(get("daily_recommend_hour", "3"), 10) || 3,
    candidates,
    pickedToday: picked,
    today,
    playlists: {
      today: plInfo(todayPl),
    },
  });
});

// Update daily-recommend config (master switch, hour).
// Note: retention is no longer used — only one "每日推荐" playlist exists and
// each run rebuilds it in place.
apiRoutes.put("/v1/daily-recommend/config", adminMiddleware, async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const set = (k: string, v: string) =>
    sqlite.prepare("INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES (?, ?, ?)")
      .run(k, v, new Date().toISOString());
  if (typeof body.enabled === "boolean") set("daily_recommend_enabled", body.enabled ? "true" : "false");
  if (body.hour !== undefined) {
    const h = parseInt(body.hour, 10);
    if (Number.isFinite(h) && h >= 0 && h <= 23) set("daily_recommend_hour", String(h));
    else return c.json({ error: "hour 必须是 0-23 的整数" }, 400);
  }
  return c.json({ success: true });
});

// Update the candidate pool. Body: { candidates: [{platform, url, name?}] }
// Charts named "新歌" or "欧美" (and known blocked URLs like QQ toplist/27,
// toplist/60, NetEase playlist 3779629) are filtered out and reported.
apiRoutes.put("/v1/daily-recommend/candidates", adminMiddleware, async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const arr = Array.isArray(body.candidates) ? body.candidates : null;
  if (!arr) return c.json({ error: "candidates 必须是数组" }, 400);
  const raw = arr
    .filter((x: any) => x && typeof x.url === "string" && typeof x.platform === "string" && x.platform.trim().length > 0)
    .map((x: any) => ({ platform: x.platform, url: x.url.trim(), name: typeof x.name === "string" ? x.name : undefined }));
  const blocked = raw.filter((x: any) => dailyApi()?.isCandidateBlocked(x) ?? false);
  const clean = raw.filter((x: any) => !(dailyApi()?.isCandidateBlocked(x) ?? false));
  if (clean.length === 0) return c.json({ error: "候选池不能为空,且每项需要 platform + url" }, 400);
  dailyApi()?.saveCandidates(clean);
  return c.json({ success: true, count: clean.length, blocked: blocked.length, blockedItems: blocked });
});

// Manually trigger today's daily-recommend generation.
// Builds a SINGLE combined "每日推荐" playlist from remote charts + user pool
// + local history mix. Idempotent: if today's playlist already exists, returns
// skipped=true. With { force: true } it bypasses idempotency and re-randomizes.
apiRoutes.post("/v1/daily-recommend/trigger", adminMiddleware, async (c) => {
  if (!dailyApi()) return c.json({ error: "每日推荐插件未启用" }, 503);
  try {
    const body = await c.req.json().catch(() => ({}));
    const opts = { force: body?.force === true, seedSalt: body?.seedSalt };
    const result = await dailyApi().generateDailyPlaylist(new Date(), opts);
    return c.json({ success: true, result }, 200);
  } catch (e: any) {
    const error = e.message || "每日推荐生成失败";
    log.error("[DAILY-RECOMMEND] trigger error", { err: error });
    return c.json({ success: false, error }, 500);
  }
});

// ==================== 推荐手动刷新(每日/本地/今日漫游) ====================
// 一键重新触发随机生成:每日推荐(force+随机盐) → 本地推荐(force+随机盐) →
// 插件任务状态:查询最近一次后台任务(运行中 / 结果,含沙箱限制错误码与修复提示)。
// 前端在发起异步刷新后轮询此端点,直到 running=false。
apiRoutes.get("/v1/plugins/:id/job", adminMiddleware, (c) => {
  const id = c.req.param("id");
  if (!id) return c.json(apiError(BusinessErrorCode.INVALID_PARAM, "缺少插件 id"), 400);
  const state = getPluginJobState(id);
  if (!state) return c.json(apiError(BusinessErrorCode.NOT_FOUND, "该插件尚无任务记录"), 404);
  return c.json({ success: true, pluginId: id, running: state.running, job: state });
});

// 外部音源预探测(播放前):批量检查歌曲是否有可用音源,供播放器在切歌前
// 提前确认下一首可播(含随机播放)。本地歌曲直接 ok(不探测);web 歌曲经
// ensurePlayableStream 探测原源(Range bytes=0-20000,失败自动换源并写回 DB),
// 结果按 songId 内存缓存(playableCache/fallbackCache),短时间内不重复探测。
//   POST /v1/stream/probe  body: { songIds: string[] }(≤5)
//   -> { success, results: [{ songId, ok, local?, fallback?, reason? }] }
apiRoutes.post("/v1/stream/probe", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const songIds = Array.isArray(body.songIds)
    ? body.songIds.filter((s: any) => typeof s === "string").slice(0, 5)
    : [];
  if (!songIds.length) return c.json(apiError(BusinessErrorCode.INVALID_PARAM, "缺少 songIds"));
  const results = await Promise.all(songIds.map(async (id: string) => {
    const song = db.select().from(songs).where(eq(songs.id, id)).get();
    if (!song) return { songId: id, ok: false, local: false, reason: "歌曲不存在" };
    // 本地歌曲(无 url 或已缓存文件):无需探测。
    if (!song.url || song.cachePath) return { songId: id, ok: true, local: true };
    const original = song.url;
    try {
      const url = await ensurePlayableStream(song as any);
      if (url) return { songId: id, ok: true, local: false, fallback: url !== original };
      return { songId: id, ok: false, local: false, reason: "无可用音源" };
    } catch (e: any) {
      return { songId: id, ok: false, local: false, reason: String(e?.message || e).slice(0, 120) };
    }
  }));
  return c.json({ success: true, results });
});

// 今日漫游(combo,合并前两者)。body 可选 { targets: ["daily"|"local"|"roam"] },
// 缺省全刷。**默认路径(不带 pluginId)为异步**:202 + taskId,前端轮询 GET /v1/tasks/:id
// 取 task.result({ success, seedSalt, results })——生成跑在一次性批量子进程里(方案3)。
apiRoutes.post("/v1/recommend/refresh", adminMiddleware, async (c) => {
  touch(); // 标记活动:推荐歌单刷新
  const body = await c.req.json().catch(() => ({}));

  // 单插件手动刷新:任意声明 dailyPlaylist / localPlaylist / comboPlaylist /
  // recommendPlaylist 能力的插件(内置或外置)都可经此入口强制重跑。传 force
  // 绕过插件自身的间隔闸门。**异步任务通道**:任务在后台跑(沙箱用 manifest.longRunning
  // 长预算),立即返回,前端轮询 GET /v1/plugins/:id/job 看结果——不再被沙箱 15s
  // 或前端 axios 15s 卡死。
  const pluginId = body?.pluginId;
  if (pluginId) {
    const reg = getPlugin(pluginId);
    if (!reg) return c.json(apiError(BusinessErrorCode.NOT_FOUND, "插件不存在"), 404);
    const caps: string[] = reg.manifest.capabilities || [];
    const isDaily =
      caps.includes("dailyPlaylist") ||
      caps.includes("localPlaylist") ||
      caps.includes("comboPlaylist") ||
      caps.includes("recommendPlaylist");
    if (!isDaily) {
      return c.json(apiError(BusinessErrorCode.INVALID_PARAM, "该插件不支持手动刷新(无推荐歌单能力)"), 400);
    }
    // 未启用(或尚无 DB 行)视为不可用。
    if (getPluginConfig(pluginId) === null) {
      return c.json(apiError(BusinessErrorCode.CONFLICT, "插件未启用"), 503);
    }
    const impl = reg.impl;
    if (typeof impl?.runDailyJob !== "function") {
      return c.json(apiError(BusinessErrorCode.INTERNAL, "插件未实现 runDailyJob"), 500);
    }
    const { started, alreadyRunning } = runPluginJob(pluginId, "runDailyJob", { force: true });
    if (alreadyRunning) {
      return c.json({ success: true, pluginId, alreadyRunning: true, message: "该插件刷新任务已在后台运行中" }, 200);
    }
    if (!started) {
      return c.json(apiError(BusinessErrorCode.UPSTREAM_ERROR, "任务启动失败"), 500);
    }
    return c.json({ success: true, pluginId, started: true, message: "已开始后台刷新,可通过 GET /v1/plugins/:id/job 查询进度" }, 202);
  }

  const targets = Array.isArray(body?.targets) ? body.targets : ["daily", "local", "roam"];
  // 同步前置校验:能力不存在直接 503(契约保留)。实际生成在一次性批量子进程内跑
  // (recommend-refresh,方案3),峰值内存随子进程退出归还;前端 202 后轮询
  // GET /v1/tasks/:taskId 取结果(task.result = { success, seedSalt, results })。
  if (targets.includes("daily") && !dailyApi()) return c.json({ error: "每日推荐插件未启用" }, 503);
  if (targets.includes("local") && (!localApi() || typeof localApi().generateLocalDailyPlaylist !== "function")) {
    return c.json({ error: "本地推荐插件未启用" }, 503);
  }
  if (targets.includes("roam") && (!comboApi() || typeof comboApi().generateComboPlaylist !== "function")) {
    return c.json({ error: "今日漫游插件未启用" }, 503);
  }
  const seedSalt = Math.floor(Math.random() * 1_000_000);
  const started = startAsyncTask("recommend-refresh", `targets:${targets.join(",")}`, {
    kind: "recommend-refresh",
    args: { targets, seedSalt },
  });
  if (!started.started) {
    return c.json({
      success: true, started: false, alreadyRunning: true, taskId: started.taskId, seedSalt,
      message: "刷新任务已在后台运行中,可通过 GET /v1/tasks/:taskId 查询进度",
    }, 202);
  }
  return c.json({
    success: true, started: true, taskId: started.taskId, seedSalt,
    message: "已开始后台刷新,可通过 GET /v1/tasks/:taskId 查询进度",
  }, 202);
});

// ==================== User recommend pool ====================
// A user can click "加入每日推荐池" on any playlist (or on "我喜欢的音乐")
// to add that source to the pool. Each daily-recommend run picks up to 50
// random playable songs from every pool member and merges them into the
// day's combined "每日推荐" playlist.

// List all pool members (for an admin management page if desired).
apiRoutes.get("/v1/recommend-pool", (c) => {
  const pool = dailyApi()?.listRecommendPool() ?? [];
  return c.json({ pool });
});

// Add a playlist to the pool. Any logged-in user can do this (not admin-only)
// since it's a personalization feature, not a system config.
apiRoutes.post("/v1/recommend-pool/playlist/:playlistId", async (c) => {
  const user = c.get("user");
  const playlistId = c.req.param("playlistId");
  const row = sqlite.prepare("SELECT name FROM playlists WHERE id = ?").get(playlistId) as any;
  if (!row) return c.json(apiError(BusinessErrorCode.NOT_FOUND, "歌单不存在"), 404);
  const added = dailyApi()?.addToRecommendPool("playlist", playlistId, row.name || "", user?.id || "") ?? false;
  return c.json({ success: true, added, message: added ? "已加入每日推荐池" : "该歌单已在推荐池中" });
});

// Remove a playlist from the pool.
apiRoutes.delete("/v1/recommend-pool/playlist/:playlistId", (c) => {
  const playlistId = c.req.param("playlistId");
  const removed = dailyApi()?.removeFromRecommendPool("playlist", playlistId) ?? false;
  return c.json({ success: true, removed });
});

// Check if a playlist is in the pool (for the UI to show toggle state).
apiRoutes.get("/v1/recommend-pool/playlist/:playlistId/status", (c) => {
  const playlistId = c.req.param("playlistId");
  return c.json({ inPool: dailyApi()?.isInRecommendPool("playlist", playlistId) ?? false });
});

// Add the current user's favorites ("我喜欢的音乐") to the pool.
apiRoutes.post("/v1/recommend-pool/favorites", async (c) => {
  const user = c.get("user");
  if (!user?.id) return c.json(apiError(BusinessErrorCode.FORBIDDEN, "未登录"), 401);
  const added = dailyApi()?.addToRecommendPool("favorites", user.id, "我喜欢的音乐", user.id) ?? false;
  return c.json({ success: true, added, message: added ? "已加入每日推荐池" : "我喜欢的音乐已在推荐池中" });
});

// Remove the current user's favorites from the pool.
apiRoutes.delete("/v1/recommend-pool/favorites", (c) => {
  const user = c.get("user");
  if (!user?.id) return c.json(apiError(BusinessErrorCode.FORBIDDEN, "未登录"), 401);
  const removed = dailyApi()?.removeFromRecommendPool("favorites", user.id) ?? false;
  return c.json({ success: true, removed });
});

// Check if the current user's favorites are in the pool.
apiRoutes.get("/v1/recommend-pool/favorites/status", (c) => {
  const user = c.get("user");
  if (!user?.id) return c.json({ inPool: false });
  return c.json({ inPool: dailyApi()?.isInRecommendPool("favorites", user.id) ?? false });
});

// ==================== Playlist import (built-in plugins: QQ / NetEase / MusicFlow native file) ====================
// URL 导入走异步任务(触发即返回 taskId,前端轮询 GET /v1/tasks/:id):网络拉取 + 增量重建
// 可能耗时几秒~几十秒,同步 await 会长时间挂住前端请求;native 文件解析通常量小,保持同步。
apiRoutes.post("/v1/playlists/import", async (c) => {
  const user = c.get("user");
  const body = await c.req.json().catch(() => ({}));
  const url = (body.url || "").trim();
  const native = body.native; // MusicFlow-exported JSON (object) for native files
  if (!url && !native) return c.json(apiError(BusinessErrorCode.INVALID_PARAM, "请输入歌单链接或选择歌单文件"));
  if (native) {
      // Uploaded playlist file — routed to whichever enabled importer plugin
      // recognizes the payload (built-in: MusicFlow export, one or many playlists).
      const nativeList = parsePlaylistFile(native);
      const created: { id: string; name: string }[] = [];
      const totals = { total: 0, matched: 0, unmatched: 0, wishAdded: 0 };
      for (let i = 0; i < nativeList.length; i++) {
        const imp = nativeList[i];
        const name = imp.name.trim() || "导入歌单";
        const id = `pl-${Date.now()}-${i}`;
        db.insert(playlists).values({
          id, name, ownerId: user?.id || "",
          sourceUrl: null, sourcePlatform: imp.platform, externalId: null,
          syncEnabled: 0,
        }).run();
        if (!syncApi()) return c.json(apiError(BusinessErrorCode.CONFLICT, "歌单同步插件未启用"), 503);
        const result = await syncApi().rebuildPlaylistEntries(id, imp, {
          userId: user?.id,
          notes: `从本地歌单文件导入「${name}」`,
        });
        totals.total += result.total;
        totals.matched += result.matched;
        totals.unmatched += result.unmatched;
        totals.wishAdded += result.wishAdded;
        created.push({ id, name });
      }
      clearLibraryIndex(); // 本批本地歌单文件导入结束,立即回收曲库索引缓存
      touch(); // 标记活动:歌单导入
      return c.json({
        success: true,
        playlistId: created[0]?.id,
        name: created[0]?.name || "导入歌单",
        platform: "local",
        trackCount: totals.total,
        matched: totals.matched,
        unmatched: totals.unmatched,
        wishAdded: totals.wishAdded,
        created: created.length,
      });
    }
    if (syncApi()?.checkImportCooldown(user?.id || "", url) ?? false) {
      return c.json(apiError(BusinessErrorCode.CONFLICT, "相同歌单刚导入过,请稍候再试"));
    }
    if (!syncApi()) return c.json(apiError(BusinessErrorCode.CONFLICT, "歌单同步插件未启用"), 503);
    const ownerKey = `${url}:${user?.id || ""}`;
    // URL 导入跑在一次性批量子进程里(方案3):子进程内 importPlaylistFromUrl +
    // 增量重建,进度/结果经 IPC 回传;clearLibraryIndex/touch 由 runBatchJob 收尾。
    const started = startAsyncTask("playlist-import", `url:${ownerKey}`, {
      kind: "playlist-import",
      args: { url, userId: user?.id, name: typeof body.name === "string" ? body.name : undefined, autoSync: !!body.autoSync },
    });
    if (!started.started) return c.json({ success: false, alreadyRunning: true, taskId: started.taskId });
    return c.json({ success: true, taskId: started.taskId });
});

// Export a playlist as a MusicFlow-native JSON file that round-trips back
// through the import endpoint.
apiRoutes.get("/v1/playlists/:id/export", (c) => {
  const user = c.get("user");
  const id = c.req.param("id")!;
  const playlist = db.select().from(playlists).where(eq(playlists.id, id)).get();
  if (!playlist) return c.json({ error: "歌单不存在" }, 404);
  if (playlist.ownerId !== user?.id && !user?.isAdmin) return c.json({ error: "无权导出该歌单" }, 403);
  const exported = syncApi()?.exportPlaylistEntries(id);
  if (!exported) return c.json({ error: "歌单同步插件未启用" }, 503);
  const { name, tracks } = exported;
  const payload = { app: NATIVE_APP, version: 1, exportedAt: new Date().toISOString(), name, tracks };
  const filename = `${(name || "歌单").replace(/[\\/:*?"<>|]/g, "_")}.json`;
  c.header("Content-Disposition", `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`);
  return c.json(payload);
});

// Export ALL of the current user's playlists into a single MusicFlow-native
// file (raw.playlists array). Re-imports through the same /import endpoint,
// which recreates each playlist.
apiRoutes.get("/v1/playlists/export-all", (c) => {
  const user = c.get("user");
  const mine = db.select().from(playlists)
    .where(eq(playlists.ownerId, user?.id || ""))
    .all();
  const playlistsOut = mine.map((p) => {
    const exp = syncApi()?.exportPlaylistEntries(p.id);
    return { name: exp?.name ?? "", tracks: exp?.tracks ?? [] };
  });
  const filename = `MusicFlow全部歌单_${new Date().toISOString().slice(0, 10)}.json`;
  c.header("Content-Disposition", `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`);
  return c.json({ app: NATIVE_APP, version: 1, exportedAt: new Date().toISOString(), exportAll: true, playlists: playlistsOut });
});

// ==================== Playlist sync ====================
// 手动同步走异步任务(触发即返回 taskId,前端轮询):大歌单同步可能耗时,避免 HTTP 长时间挂起。
apiRoutes.post("/v1/playlists/:id/sync", async (c) => {
  const user = c.get("user");
  const id = c.req.param("id")!;
  const playlist = db.select().from(playlists).where(eq(playlists.id, id)).get();
  if (!playlist) return c.json(apiError(BusinessErrorCode.NOT_FOUND, "歌单不存在"));
  // Only owner (or admin) can sync
  if (playlist.ownerId !== user?.id && !user?.isAdmin) return c.json(apiError(BusinessErrorCode.FORBIDDEN, "无权同步该歌单"));
  if (!syncApi()) return c.json(apiError(BusinessErrorCode.CONFLICT, "歌单同步插件未启用"), 503);
  const started = startAsyncTask("playlist-sync", `pl:${id}`, {
    kind: "playlist-sync",
    args: { playlistId: id, userId: user?.id },
  });
  if (!started.started) return c.json({ success: false, alreadyRunning: true, taskId: started.taskId });
  return c.json({ success: true, taskId: started.taskId });
});

// 异步任务状态查询(前端轮询):GET /v1/tasks/:taskId
apiRoutes.get("/v1/tasks/:taskId", (c) => {
  const state = getAsyncTask(c.req.param("taskId")!);
  if (!state) return c.json(apiError(BusinessErrorCode.NOT_FOUND, "任务不存在"), 404);
  return c.json({ success: true, task: state });
});

// 全局 busy 状态(前端横幅提示):批量闸被持有(每日推荐/自动匹配/插件每日任务)或
// 异步任务/插件任务在跑 → busy=true。前端据此显示「后台任务运行中」而非假死。
apiRoutes.get("/v1/system/busy", (c) => {
  const batch = isBatchBusy();
  const tasks = anyTaskRunning();
  const jobs = anyJobRunning();
  return c.json({ success: true, busy: batch || tasks || jobs, detail: { batch, tasks, jobs } });
});

// ==================== Playlist settings (rename / public toggle / auto-sync toggle) ====================
apiRoutes.put("/v1/playlists/:id", async (c) => {
  const user = c.get("user");
  const id = c.req.param("id")!;
  const body = await c.req.json().catch(() => ({}));
  const playlist = db.select().from(playlists).where(eq(playlists.id, id)).get();
  if (!playlist) return c.json(apiError(BusinessErrorCode.NOT_FOUND, "歌单不存在"));
  if (playlist.ownerId !== user?.id && !user?.isAdmin) return c.json(apiError(BusinessErrorCode.FORBIDDEN, "无权修改该歌单"));
  const update: any = { updatedAt: new Date().toISOString() };
  if (body.name !== undefined) update.name = String(body.name).trim() || playlist.name;
  if (body.isPublic !== undefined) update.isPublic = body.isPublic ? 1 : 0;
  if (body.syncEnabled !== undefined) update.syncEnabled = body.syncEnabled ? 1 : 0;
  db.update(playlists).set(update).where(eq(playlists.id, id)).run();
  return c.json({ success: true });
});

// Convert a platform-imported playlist (go-music-dl daily-recommend etc.) into a
// permanent local playlist: detach its source link so the daily rotation neither
// replaces its contents nor deletes it. Entries/cover/name are kept as-is.
apiRoutes.post("/v1/playlists/:id/convert-to-local", async (c) => {
  const user = c.get("user");
  const id = c.req.param("id")!;
  const playlist = db.select().from(playlists).where(eq(playlists.id, id)).get();
  if (!playlist) return c.json(apiError(BusinessErrorCode.NOT_FOUND, "歌单不存在"));
  if (playlist.ownerId !== user?.id && !user?.isAdmin) return c.json(apiError(BusinessErrorCode.FORBIDDEN, "无权修改该歌单"));
  if (!playlist.sourceUrl) return c.json(apiError(BusinessErrorCode.CONFLICT, "该歌单已是本地歌单,无需转换"));
  const update: any = {
    sourceUrl: null,
    externalId: null,
    sourcePlatform: "",
    syncEnabled: 0,
    updatedAt: new Date().toISOString(),
  };
  // Daily-recommend imports carry a "每日推荐歌单·<source>" comment — clear it so
  // the converted playlist isn't mistaken for a rotating daily-recommend playlist.
  if (playlist.comment && playlist.comment.startsWith("每日推荐歌单·")) {
    update.comment = "";
  }
  db.update(playlists).set(update).where(eq(playlists.id, id)).run();
  return c.json({ success: true });
});

// 收藏 / 取消收藏歌单。Body: { favorite: boolean }。
// 收藏平台歌单(sourceUrl 非空):保留来源信息供每天自动同步,置 favorite + syncEnabled=1
// 收藏歌单按用户隔离:任意登录用户都能收藏/取消(不再限 owner/admin),
// 写入 playlist_favorites(user_id × playlist_id)。收藏后的副作用与原先一致:
// 平台歌单收藏后转本地并开启每天自动同步(每天同步默认打开),并脱离每日推荐轮换。
// 取消收藏平台歌单:仅移除当前用户的收藏标记,恢复每日推荐轮换身份(syncAll 重新管理)。
apiRoutes.post("/v1/playlists/:id/favorite", async (c) => {
  const user = c.get("user");
  const id = c.req.param("id")!;
  const body = await c.req.json().catch(() => ({}));
  const favorite = body.favorite === true;
  const playlist = db.select().from(playlists).where(eq(playlists.id, id)).get();
  if (!playlist) return c.json({ error: "歌单不存在" }, 404);

  const now = new Date().toISOString();
  if (favorite) {
    // 收藏:写入当前用户 × 该歌单的多对多关系。
    try {
      db.insert(playlistFavorites).values({ userId: user.id, playlistId: id, createdAt: now }).run();
    } catch {
      // 已收藏过(唯一键冲突)则忽略,幂等。
    }
    const isPlatform = !!playlist.sourceUrl;
    db.update(playlists).set({
      // 兼容旧全局字段:仍置 1(有用户收藏),供每日推荐轮换保护等旧逻辑判断。
      favorite: 1,
      // 平台歌单收藏后每天自动同步(默认打开);本地歌单保持原 syncEnabled 不变。
      syncEnabled: isPlatform ? 1 : playlist.syncEnabled || 0,
      updatedAt: now,
    }).where(eq(playlists.id, id)).run();
  } else {
    // 取消收藏:仅移除当前用户的收藏记录。
    db.delete(playlistFavorites).where(and(
      eq(playlistFavorites.userId, user.id),
      eq(playlistFavorites.playlistId, id),
    )).run();
    // 若无任何用户收藏该歌单,清除全局收藏标记(恢复可被每日推荐轮换的资格)。
    const others = db.select({ c: count() }).from(playlistFavorites).where(eq(playlistFavorites.playlistId, id)).get()?.c ?? 0;
    if (others === 0) {
      db.update(playlists).set({ favorite: 0, updatedAt: now }).where(eq(playlists.id, id)).run();
    }
  }
  return c.json({ success: true, favorite });
});

// ==================== Playlists (paginated) ====================
apiRoutes.get("/v1/playlists", (c) => {
  const page = Math.max(1, parseInt(c.req.query("page") || "1") || 1);
  const pageSize = Math.min(100, Math.max(1, parseInt(c.req.query("pageSize") || "20") || 20));
  const query = (c.req.query("query") || "").trim();
  const platform = (c.req.query("platform") || "").trim();
  const localOnly = (c.req.query("local") || "").trim() === "1";
  const favOnly = (c.req.query("favorite") || "").trim() === "1";
  const sort = (c.req.query("sort") || "").trim();
  const user = c.get("user");
  // 当前用户已收藏的歌单 id 集合:收藏过滤与每项 favorite 状态都按它判断。
  const favIds = new Set(db.select({ pid: playlistFavorites.playlistId })
    .from(playlistFavorites).where(eq(playlistFavorites.userId, user?.id ?? ""))
    .all().map(r => r.pid));
  // Push the ownership/visibility filter + name search + platform/local/favorite
  // filters to SQL. and() skips undefined conditions, so any subset works.
  // 音乐库对所有用户开放:任何登录用户都能看到「自己 + 公开 + 导入/插件歌单
  // (sourceUrl 非空,如 go-music-dl 等导入的曲库内容)」;私人普通歌单仍仅属主可见。
  const where = and(
    user?.isAdmin
      ? undefined
      : or(
          eq(playlists.ownerId, user?.id ?? ""),
          eq(playlists.isPublic, 1),
          isNotNull(playlists.sourceUrl),
        ),
    query ? like(playlists.name, `%${query}%`) : undefined,
    platform ? eq(playlists.sourcePlatform, platform) : undefined,
    localOnly ? isNull(playlists.sourceUrl) : undefined,
    // 收藏过滤改为按当前用户:只显示「我收藏的」歌单(不再是全局 favorite 标记)。
    favOnly ? inArray(playlists.id, [...favIds]) : undefined,
  );
  // Ordering. An explicit sort (by creation time / name) fully overrides the
  // default daily-recommend-first + recency ranking; unknown values fall back
  // to that default. Pushed to SQL with LIMIT/OFFSET so we never load the
  // whole table into JS just to slice it.
  let orderByExpr: any;
  switch (sort) {
    case "created_asc":  orderByExpr = [asc(playlists.createdAt)]; break;
    case "created_desc": orderByExpr = [desc(playlists.createdAt)]; break;
    case "name_asc":     orderByExpr = [asc(playlists.name)]; break;
    case "name_desc":    orderByExpr = [desc(playlists.name)]; break;
    default: {
      const dailyOrder = sql`CASE WHEN ${playlists.comment} LIKE ${`%${dailyRecommendTag() || "每日推荐"}%`} AND ${playlists.name} = ${dailyRecommendTag() || "每日推荐"} THEN 0 ELSE 1 END`;
      const recency = sql`COALESCE(${playlists.updatedAt}, ${playlists.createdAt})`;
      orderByExpr = [dailyOrder, desc(recency)];
    }
  }
  const rows = (where
    ? db.select().from(playlists).where(where)
    : db.select().from(playlists))
    .orderBy(...orderByExpr)
    .limit(pageSize)
    .offset((page - 1) * pageSize)
    .all();
  const total = (where
    ? db.select({ c: count() }).from(playlists).where(where)
    : db.select({ c: count() }).from(playlists))
    .get()?.c ?? 0;
  const items = rows.map(p => ({
    id: p.id, name: p.name, owner: p.ownerId, public: !!p.isPublic,
    songCount: p.songCount || 0, duration: p.duration || 0,
    // Always expose a cover ref; getCoverArt falls back to a 4-grid collage for self-built playlists
    coverArt: `pl-${p.id}`, sourcePlatform: p.sourcePlatform || "",
    isImported: isImportedPlaylist(p), pluginSynced: isPluginSyncPlaylist(p), sourcePluginId: p.sourcePlugin || "", syncEnabled: !!p.syncEnabled,
    // favorite 改为「当前用户是否收藏」(按 playlist_favorites 判断),不再用全局标记。
    favorite: favIds.has(p.id),
    isDaily: isDailyRecommendPlaylist(p),
    created: p.createdAt, changed: p.updatedAt,
  }));
  return c.json({ total, page, pageSize, items });
});

// ==================== Navidrome compatible ====================
apiRoutes.get("/playlist", (c) => {
  const user = c.get("user");
  const all = db.select().from(playlists).all().filter(p => p.ownerId === user?.id || p.isPublic || p.sourceUrl);
  const dailyRank = (p: any) => {
    const c = p.comment || "";
    const tag = dailyRecommendTag() || "每日推荐";
    if (c.includes(tag) && p.name === tag) return 0;
    return 1;
  };
  return c.json(all.sort((a, b) => {
    const ra = dailyRank(a), rb = dailyRank(b);
    if (ra !== rb) return ra - rb;
    return (b.updatedAt || b.createdAt || "").localeCompare(a.updatedAt || a.createdAt || "");
  }));
});
apiRoutes.get("/playlist/:id/tracks", (c) => c.json(db.select().from(playlistSongs).where(eq(playlistSongs.playlistId, c.req.param("id"))).all().filter(e => e.playable && e.songId)));
apiRoutes.delete("/playlist/:id", (c) => { const user = c.get("user"); const id = c.req.param("id")!; if (isFixedRecommendPlaylist(id)) return c.json({ error: "固定推荐歌单(今日/本地/漫游)由插件每日重建,不可删除" }, 400); const pl = db.select().from(playlists).where(eq(playlists.id, id)).get(); if (!pl) return c.json({ error: "Playlist not found" }, 404); if (pl.ownerId !== user?.id && !user?.isAdmin) return c.json({ error: "无权删除该歌单" }, 403); db.delete(playlistSongs).where(eq(playlistSongs.playlistId, id)).run(); db.delete(playlists).where(eq(playlists.id, id)).run(); clearPlaylistCoverCache(id); return c.json({ success: true }); });

// ==================== Playlist tracks (paginated) ====================
apiRoutes.get("/v1/playlists/:id/tracks", (c) => {
  const id = c.req.param("id")!;
  const page = Math.max(1, parseInt(c.req.query("page") || "1") || 1);
  const pageSize = Math.min(200, Math.max(1, parseInt(c.req.query("pageSize") || "50") || 50));
  const playlist = db.select().from(playlists).where(eq(playlists.id, id)).get();
  if (!playlist) return c.json({ error: "Playlist not found" }, 404);
  // 「随机歌曲」固定歌单惰性刷新:客户端(音流随心听)读取曲目列表时若超过
  // 刷新间隔则立即重建,播完一轮再来取时歌单必然已刷新好 → 无空白等待。
  if (playlist.id === RANDOM_PLAYLIST_ID) maybeRefreshRandomSongs();
  // Push total / matched counts + the page slice to SQL instead of pulling
  // every entry and slicing in JS. orderBy(position, id) keeps pagination
  // stable and follows the playlist's intended track order.
  const baseWhere = eq(playlistSongs.playlistId, id);
  const total = (db.select({ c: count() }).from(playlistSongs).where(baseWhere).get()?.c) ?? 0;
  const matchedWhere = and(
    baseWhere,
    eq(playlistSongs.playable, 1),
    sql`${playlistSongs.songId} IS NOT NULL AND ${playlistSongs.songId} != ''`,
  );
  const matched = (db.select({ c: count() }).from(playlistSongs).where(matchedWhere).get()?.c) ?? 0;
  const pageEntries = db.select().from(playlistSongs)
    .where(baseWhere)
    .orderBy(playlistSongs.position, playlistSongs.id)
    .limit(pageSize)
    .offset((page - 1) * pageSize)
    .all();
  // Batch song + album lookups (was N+1: one songs query + one albums query
  // per track). Order is preserved by mapping back through pageEntries.
  const songIds = pageEntries.filter((e) => e.playable && e.songId).map((e) => e.songId as string);
  const songMap = songIds.length
    ? new Map(db.select().from(songs).where(inArray(songs.id, songIds)).all().map((s) => [s.id, s]))
    : new Map<string, any>();
  const albumIds: string[] = [];
  for (const s of songMap.values()) if (s.albumId) albumIds.push(s.albumId as string);
  const albumMap = albumIds.length
    ? new Map(db.select().from(albums).where(inArray(albums.id, albumIds)).all().map((a) => [a.id, a]))
    : new Map<string, any>();
  const items = pageEntries.map((e) => {
    if (e.playable && e.songId) {
      const song = songMap.get(e.songId);
      if (song) {
        const album = song.albumId ? albumMap.get(song.albumId) : undefined;
        return {
          id: song.id, title: song.title, artist: song.artist, album: song.album,
          artistId: song.artistId, albumId: song.albumId, duration: song.duration || 0,
          bitRate: song.bitRate, suffix: song.suffix, contentType: song.contentType,
          coverArt: album?.coverArt ? `al-${album.id}` : (song.coverArt ? `so-${song.id}` : undefined),
          playable: true, isMatched: true,
        };
      }
    }
    return {
      id: e.externalSongId || `ext-${e.id}`, entryId: e.id, title: e.externalTitle || "", artist: e.externalArtist || "",
      album: e.externalAlbum || "", duration: Math.round((e.externalDuration || 0) / 1000),
      playable: false, isMatched: false, unavailableReason: e.unavailableReason || "曲库中未找到",
    };
  });
  return c.json({ total, matched, page, pageSize, items, playlist: { id: playlist.id, name: playlist.name, songCount: playlist.songCount || 0, matched, duration: playlist.duration || 0, coverArt: `pl-${playlist.id}`, sourcePlatform: playlist.sourcePlatform || "", isImported: isImportedPlaylist(playlist), pluginSynced: isPluginSyncPlaylist(playlist), sourcePluginId: playlist.sourcePlugin || "", syncEnabled: !!playlist.syncEnabled, public: !!playlist.isPublic, owner: playlist.ownerId, isDaily: isDailyRecommendPlaylist(playlist) } });
});

// ==================== Play history (paginated) ====================
apiRoutes.get("/v1/history", (c) => {
  const user = c.get("user");
  const page = Math.max(1, parseInt(c.req.query("page") || "1") || 1);
  const pageSize = Math.min(200, Math.max(1, parseInt(c.req.query("pageSize") || "50") || 50));
  if (!user) return c.json({ total: 0, page, pageSize, items: [] });
  // Push the playedAt DESC sort to SQL (covered by idx_play_history_played_at),
  // then batch song + album lookups instead of N+1 per history row.
  const all = db.select().from(playHistory).where(eq(playHistory.userId, user.id)).orderBy(desc(playHistory.playedAt)).all();
  const total = all.length;
  const pageRows = all.slice((page - 1) * pageSize, page * pageSize);
  const songIds = pageRows.map((h) => h.songId).filter((x): x is string => !!x);
  const songMap = songIds.length
    ? new Map(db.select().from(songs).where(inArray(songs.id, songIds)).all().map((s) => [s.id, s]))
    : new Map<string, any>();
  const albumIds: string[] = [];
  for (const s of songMap.values()) if (s.albumId) albumIds.push(s.albumId as string);
  const albumMap = albumIds.length
    ? new Map(db.select().from(albums).where(inArray(albums.id, albumIds)).all().map((a) => [a.id, a]))
    : new Map<string, any>();
  const items = pageRows.map((h) => {
    const song = songMap.get(h.songId);
    if (!song) return null;
    const album = song.albumId ? albumMap.get(song.albumId) : undefined;
    return {
      id: song.id, title: song.title, artist: song.artist, album: song.album,
      artistId: song.artistId, albumId: song.albumId, duration: song.duration || 0,
      bitRate: song.bitRate, suffix: song.suffix, contentType: song.contentType,
      coverArt: album?.coverArt ? `al-${album.id}` : (song.coverArt ? `so-${song.id}` : undefined),
      playedAt: h.playedAt || "",
    };
  }).filter(Boolean);
  return c.json({ total, page, pageSize, items });
});

// Clear the current user's play history. Does not touch playCount on songs
// (that's a historical counter, not a history record).
apiRoutes.delete("/v1/history", (c) => {
  const user = c.get("user");
  if (!user) return c.json({ deleted: 0 });
  const result = db.delete(playHistory).where(eq(playHistory.userId, user.id)).run();
  return c.json({ deleted: result.changes || 0 });
});

// ==================== DLNA cast ====================
const DLNA_MIME: Record<string, string> = {
  mp3: "audio/mpeg", flac: "audio/flac", wav: "audio/wav", aac: "audio/aac",
  ogg: "audio/ogg", m4a: "audio/mp4", wma: "audio/x-ms-wma", ape: "audio/ape",
  aiff: "audio/aiff", opus: "audio/opus",
};

// Derive the LAN base URL the DLNA renderer should use to pull the stream.
// Uses the request Host header's hostname + the backend's actual listening
// port (so it works even when fronted by a dev proxy on a different port).
// Also records it for the internal cast paths (auto-advance / stalled retry)
// so they reuse the same reachable address.
//
// 关键:只信任「局域网可达」的 Host(私有 IP / .local)。通过公网域名访问时,Host 头是
// 公网域名,设备在同一 LAN 内无法解析回连 → 直接回退到自动探测的 LAN IP,确保推给 DLNA
// 设备的永远是局域网地址。DLNA_BASE_URL 环境变量优先级最高,可显式覆盖。
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

// ==================== 播放器管理(仅管理员)====================
// DLNA / AirPlay / 群组是「播放器」功能的全部端点。普通用户只能看到并控制
// 自己的本机播放器(local:<自己的 userId>),播放器管理端点一律对 admin 开放。
// WS 连接同样按用户过滤,非 admin 只收本机 peer 事件(见 services/ws)。
apiRoutes.use("/v1/dlna/*", adminMiddleware);
apiRoutes.use("/v1/airplay/*", adminMiddleware);
apiRoutes.use("/v1/groups*", async (c, next) => { return c.get("user")?.isAdmin ? next() : c.json(apiError(BusinessErrorCode.FORBIDDEN, "无权操作"), 403); });

// List discovered DLNA renderers (refreshes cache if stale).
apiRoutes.get("/v1/dlna/devices", async (c) => {
  if (shouldRefreshDevices() || getCachedDevices().length === 0) {
    await refreshDevices();
  }
  // 返回全部设备(在线 + 离线)。离线设备保留在列表,供「播放器」页管理(改名/删除)。
  const devices = markStaleDevices(getCachedDevices()).map(d => ({
    id: d.id, name: d.name, alias: d.alias || "",
    displayName: d.alias || d.name,
    manufacturer: d.manufacturer, model: d.model,
    hasVolumeControl: !!d.renderingControlUrl,
    available: d.available,
    disabled: !!d.disabled,
  }));
  return c.json({ devices });
});

// Force a fresh SSDP discovery scan.
apiRoutes.post("/v1/dlna/scan", async (c) => {
  const devices = await refreshDevices();
  return c.json({ devices: devices.map(d => ({
    id: d.id, name: d.name, alias: d.alias || "",
    displayName: d.alias || d.name,
    manufacturer: d.manufacturer, model: d.model,
    hasVolumeControl: !!d.renderingControlUrl,
    available: d.available,
    disabled: !!d.disabled,
  })) });
});

// 重命名 DLNA 设备(自定义显示名 alias)。Body: { alias } — 空串恢复原始名。
// alias 会同步到播放控件/HA 卡片显示(peer.name = alias || name)。
apiRoutes.put("/v1/dlna/devices/:deviceId", async (c) => {
  const deviceId = c.req.param("deviceId")!;
  const body = await c.req.json().catch(() => ({}));
  const alias = typeof body.alias === "string" ? body.alias.trim() : "";
  if (alias.length > 50) return c.json({ error: "名称不能超过 50 字符" }, 400);
  const dev = setDeviceAlias(deviceId, alias);
  if (!dev) return c.json({ error: "设备不存在" }, 404);
  // 立即触发 peer reconcile,让播放控件/HA 卡片显示新名字(不等 60s tick)。
  getPeerManager().reconcileDlnaPeers();
  return c.json({
    success: true,
    device: {
      id: dev.id, name: dev.name, alias: dev.alias || "",
      displayName: dev.alias || dev.name,
      manufacturer: dev.manufacturer, model: dev.model,
      hasVolumeControl: !!dev.renderingControlUrl,
      available: dev.available,
    },
  });
});

// 删除 DLNA 设备(通常删除离线的)。同时清理:群组成员、设备队列、peer、DB 记录。
apiRoutes.delete("/v1/dlna/devices/:deviceId", async (c) => {
  const deviceId = c.req.param("deviceId")!;
  // 1. 从所有播放器群组中移除该成员。
  getGroupManager().removeDeviceFromAllGroups(deviceId);
  // 2. 停止并清空设备队列(如果有),并删除持久化队列行。
  try { getQueueController().clear(deviceId); } catch { /* ignore */ }
  db.delete(deviceQueues).where(eq(deviceQueues.deviceId, deviceId)).run();
  // 3. 移除 peer(播放控件/HA 卡片不再出现)。
  getPeerManager().removeDlnaPeer(deviceId);
  // 4. 删除缓存 + runtimes + DB 记录。
  const existed = deleteDeviceRecord(deviceId);
  if (!existed) return c.json({ error: "设备不存在" }, 404);
  // 5. 广播设备列表变化(WS → 卡片/Web 刷新)。
  getEventManager().emitDeviceListChanged(getCachedDevices().length);
  return c.json({ success: true });
});

// 禁用/启用 DLNA 设备。禁用后:从所有选择播放器的地方消失(peer 移除 + WS 不推送)、
// 停止播放并清空队列、从所有播放器群组移除、不可投屏(castToDevice 校验);启用则恢复。
apiRoutes.put("/v1/dlna/devices/:deviceId/disabled", async (c) => {
  const deviceId = c.req.param("deviceId")!;
  const body = await c.req.json().catch(() => ({}));
  const disabled = !!body.disabled;
  if (disabled) {
    // 1. 从所有播放器群组中移除该成员。
    getGroupManager().removeDeviceFromAllGroups(deviceId);
    // 2. 停止并清空设备队列(如果有),并删除持久化队列行。
    try { getQueueController().clear(deviceId); } catch { /* ignore */ }
    db.delete(deviceQueues).where(eq(deviceQueues.deviceId, deviceId)).run();
  }
  const dev = setDeviceDisabled(deviceId, disabled);
  if (!dev) return c.json({ error: "设备不存在" }, 404);
  // 3. 立即同步 peer 列表(禁用→移除 peer 并推 peer_unavailable;启用→重新注册)。
  getPeerManager().reconcileDlnaPeers();
  // 4. 广播设备列表变化(WS → 卡片/Web 刷新)。
  getEventManager().emitDeviceListChanged(getCachedDevices().length);
  return c.json({
    success: true, disabled,
    device: {
      id: dev.id, name: dev.name, alias: dev.alias || "",
      displayName: dev.alias || dev.name,
      manufacturer: dev.manufacturer, model: dev.model,
      hasVolumeControl: !!dev.renderingControlUrl,
      available: dev.available,
      disabled: !!dev.disabled,
    },
  });
});

// Cast a song to a DLNA renderer.
apiRoutes.post("/v1/dlna/cast", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const { songId, deviceId } = body;
  if (!songId || !deviceId) return c.json({ error: "需要 songId 和 deviceId" }, 400);
  const song = db.select().from(songs).where(eq(songs.id, songId)).get();
  if (!song) return c.json({ error: "歌曲不存在" }, 404);
  const mime = DLNA_MIME[song.suffix || ""] || "audio/mpeg";
  try {
    await castToDevice({
      songId, deviceId,
      title: song.title || "未知",
      artist: song.artist || undefined,
      album: song.album || undefined,
      mime,
      baseUrl: getDlnaBaseUrl(c),
      coverArt: song.coverArt || undefined,
    });
    return c.json({ success: true, message: `已投屏到设备` });
  } catch (e: any) {
    return c.json({ error: e.message || "投屏失败" }, 500);
  }
});

// Preload the next track on the device for gapless playback (SetNextAVTransportURI).
// The frontend calls this after a successful cast, and again whenever the
// device finishes a track, so the next song is ready before the current one ends.
apiRoutes.post("/v1/dlna/enqueue", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const { songId, deviceId } = body;
  if (!songId || !deviceId) return c.json({ error: "需要 songId 和 deviceId" }, 400);
  const song = db.select().from(songs).where(eq(songs.id, songId)).get();
  if (!song) return c.json({ error: "歌曲不存在" }, 404);
  const mime = DLNA_MIME[song.suffix || ""] || "audio/mpeg";
  try {
    const supported = await enqueueNextTrack({
      songId, deviceId,
      title: song.title || "未知",
      artist: song.artist || undefined,
      album: song.album || undefined,
      mime,
      baseUrl: getDlnaBaseUrl(c),
      coverArt: song.coverArt || undefined,
    });
    return c.json({ success: true, enqueueSupported: supported });
  } catch (e: any) {
    return c.json({ error: e.message || "预加载失败" }, 500);
  }
});

// Transport controls.
apiRoutes.post("/v1/dlna/devices/:deviceId/play", async (c) => {
  const deviceId = c.req.param("deviceId")!;
  if (isDeviceDisabled(deviceId)) return c.json({ error: "设备已禁用" }, 403);
  try { await playDevice(deviceId); return c.json({ success: true }); }
  catch (e: any) { return c.json({ error: e.message }, 500); }
});

apiRoutes.post("/v1/dlna/devices/:deviceId/pause", async (c) => {
  try { await pauseDevice(c.req.param("deviceId")); return c.json({ success: true }); }
  catch (e: any) { return c.json({ error: e.message }, 500); }
});

apiRoutes.post("/v1/dlna/devices/:deviceId/stop", async (c) => {
  try { await stopDevice(c.req.param("deviceId")); return c.json({ success: true }); }
  catch (e: any) { return c.json({ error: e.message }, 500); }
});

apiRoutes.post("/v1/dlna/devices/:deviceId/seek", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  // Accept either `seconds` (frontend) or `position` (HA integration) for
  // the seek target, in seconds.
  const seconds = typeof body.seconds === "number" ? body.seconds : body.position;
  if (typeof seconds !== "number") return c.json({ error: "需要 seconds 或 position" }, 400);
  try { await seekDevice(c.req.param("deviceId"), seconds); return c.json({ success: true }); }
  catch (e: any) { return c.json({ error: e.message }, 500); }
});

apiRoutes.post("/v1/dlna/devices/:deviceId/volume", async (c) => {
  const { volume } = await c.req.json().catch(() => ({}));
  if (typeof volume !== "number") return c.json({ error: "需要 volume" }, 400);
  try { await setDeviceVolume(c.req.param("deviceId"), volume); return c.json({ success: true }); }
  catch (e: any) { return c.json({ error: e.message }, 500); }
});

apiRoutes.post("/v1/dlna/devices/:deviceId/mute", async (c) => {
  const { muted } = await c.req.json().catch(() => ({}));
  if (typeof muted !== "boolean") return c.json({ error: "需要 muted(boolean)" }, 400);
  try { await setDeviceMute(c.req.param("deviceId"), muted); return c.json({ success: true }); }
  catch (e: any) { return c.json({ error: e.message }, 500); }
});

// Query device status (state / position / duration / volume).
// Merges the freshest GENA event state (if any) with a live SOAP snapshot so
// the frontend gets low-latency updates from event push + a periodic SOAP
// ground-truth to correct any drift.
apiRoutes.get("/v1/dlna/devices/:deviceId/status", async (c) => {
  try {
    const deviceId = c.req.param("deviceId");
    const status = await getDeviceStatus(deviceId);
    const evt = getEventManager().getEventState(deviceId);
    if (evt) {
      // Event state is fresher for the fields it carries; prefer it over SOAP
      // when available, but keep SOAP as the fallback (events may lag).
      if (evt.state) status.state = evt.state;
      if (typeof evt.position === "number" && evt.position > 0) status.position = evt.position;
      if (typeof evt.duration === "number" && evt.duration > 0) status.duration = evt.duration;
      if (typeof evt.volume === "number") status.volume = evt.volume;
      if (typeof evt.muted === "boolean") status.muted = evt.muted;
    }
    return c.json(status);
  } catch (e: any) { return c.json({ error: e.message }, 500); }
});

// ==================== Queue management ====================
// Per-device playback queue. Used by the HA integration's play_media (album /
// playlist) and next/prev track commands. baseUrl is resolved from the
// request host so DLNA renderers can pull the stream back from this server.
apiRoutes.get("/v1/dlna/devices/:deviceId/queue", (c) => {
  const deviceId = c.req.param("deviceId")!;
  // 新 QueueSnapshot 不再带 currentMedia(改为 ended);路由层补回以保持前端/HA 响应形状兼容。
  return c.json({ ...getQueueManager().snapshot(deviceId), currentMedia: getCurrentMedia(deviceId) });
});

// Replace the queue and start playing from `startIndex` (default 0).
// Body: { items: QueueItem[], startIndex?: number }
apiRoutes.post("/v1/dlna/devices/:deviceId/queue/play", async (c) => {
  const deviceId = c.req.param("deviceId")!;
  const { items, startIndex } = await c.req.json().catch(() => ({} as any));
  if (!Array.isArray(items)) return c.json({ error: "需要 items 数组" }, 400);
  try {
    await getQueueManager().playFrom(deviceId, items, startIndex || 0, getDlnaBaseUrl(c));
    return c.json({ success: true });
  } catch (e: any) { return c.json({ error: e.message }, 500); }
});

// Append items to the queue without switching playback.
// Body: { items: QueueItem[] }
apiRoutes.post("/v1/dlna/devices/:deviceId/queue/enqueue", async (c) => {
  const deviceId = c.req.param("deviceId")!;
  const { items } = await c.req.json().catch(() => ({} as any));
  if (!Array.isArray(items)) return c.json({ error: "需要 items 数组" }, 400);
  try {
    await getQueueManager().enqueue(deviceId, items, getDlnaBaseUrl(c));
    return c.json({ success: true });
  } catch (e: any) { return c.json({ error: e.message }, 500); }
});

apiRoutes.post("/v1/dlna/devices/:deviceId/next", async (c) => {
  try {
    await getQueueManager().next(c.req.param("deviceId")!, getDlnaBaseUrl(c));
    return c.json({ success: true });
  } catch (e: any) { return c.json({ error: e.message }, 500); }
});

apiRoutes.post("/v1/dlna/devices/:deviceId/prev", async (c) => {
  try {
    await getQueueManager().prev(c.req.param("deviceId")!, getDlnaBaseUrl(c));
    return c.json({ success: true });
  } catch (e: any) { return c.json({ error: e.message }, 500); }
});

apiRoutes.delete("/v1/dlna/devices/:deviceId/queue", (c) => {
  getQueueManager().clear(c.req.param("deviceId")!);
  return c.json({ success: true });
});

// List all devices that currently have an active queue. The Web frontend
// calls this on load to restore the cast state (which device was playing,
// what queue, what index) after the tab was closed or the backend restarted.
apiRoutes.get("/v1/dlna/active", (c) => {
  // 每个 snapshot 补 currentMedia,保持原响应形状(新 QueueSnapshot 改用 ended)。
  const active = getQueueManager().activeDevices().map((a) => ({
    deviceId: a.deviceId,
    snapshot: { ...a.snapshot, currentMedia: getCurrentMedia(a.deviceId) },
  }));
  return c.json({ active });
});

// ==================== AirPlay (RAOP) renderer ====================
// Discovered via mDNS (_raop._tcp); each device also appears as an
// "airplay:<deviceId>" peer in /v1/peers, so the Web switcher + HA treat them
// exactly like DLNA renderers. These routes mirror the DLNA ones for tooling
// that talks to the renderer kind directly.

// AirPlay 插件未启用(默认关闭)时,全部 airplay 管理端点拒绝(防绕过)。
apiRoutes.use("/v1/airplay/*", async (c, next) => {
  if (!isAirPlayEnabled()) {
    return c.json(apiError(BusinessErrorCode.CONFLICT, "AirPlay 播放器已关闭(插件管理页开启后可用)"), 409);
  }
  await next();
});

apiRoutes.get("/v1/airplay/devices", (c) => {
  return c.json({ devices: listAirPlayDevices() });
});

// 重命名 AirPlay 设备(自定义显示名 alias)。Body: { alias } — 空串恢复原始名。
// alias 会同步到播放控件 / HA 卡片显示(peer.name = alias || name)。
apiRoutes.put("/v1/airplay/devices/:deviceId", async (c) => {
  const deviceId = c.req.param("deviceId")!;
  const body = await c.req.json().catch(() => ({}));
  const alias = typeof body.alias === "string" ? body.alias.trim() : "";
  if (alias.length > 50) return c.json({ error: "名称不能超过 50 字符" }, 400);
  const dev = setAirPlayAlias(deviceId, alias);
  if (!dev) return c.json({ error: "设备不存在" }, 404);
  return c.json({ success: true, device: { id: dev.id, alias: dev.alias || "" } });
});

// 删除 AirPlay 设备(通常删除离线的)。同时清理:设备队列、peer、DB 记录。
apiRoutes.delete("/v1/airplay/devices/:deviceId", async (c) => {
  const deviceId = c.req.param("deviceId")!;
  // 1. 停止并清空设备队列(如果有),并删除持久化队列行。
  try { getQueueController().clear(deviceId); } catch { /* ignore */ }
  db.delete(deviceQueues).where(eq(deviceQueues.deviceId, deviceId)).run();
  // 2. 移除 peer(播放控件 / HA 卡片不再出现)。
  getPeerManager().removeAirPlayPeer(deviceId);
  // 3. 停止活动会话。
  try { await stopAirPlaySession(deviceId); } catch { /* ignore */ }
  // 4. 删除缓存 + DB 记录。
  const existed = deleteAirPlayDeviceRecord(deviceId);
  if (!existed) return c.json({ error: "设备不存在" }, 404);
  return c.json({ success: true });
});

// 禁用/启用 AirPlay 设备。禁用后:从所有选择播放器的地方消失(peer 移除)、
// 停止播放并清空队列、不可投屏;启用则恢复。
apiRoutes.put("/v1/airplay/devices/:deviceId/disabled", async (c) => {
  const deviceId = c.req.param("deviceId")!;
  const body = await c.req.json().catch(() => ({}));
  const disabled = !!body.disabled;
  if (disabled) {
    // 1. 停止并清空设备队列(如果有),并删除持久化队列行。
    try { getQueueController().clear(deviceId); } catch { /* ignore */ }
    db.delete(deviceQueues).where(eq(deviceQueues.deviceId, deviceId)).run();
    // 2. 停止活动会话。
    try { await stopAirPlaySession(deviceId); } catch { /* ignore */ }
  }
  const dev = setAirPlayDisabled(deviceId, disabled);
  if (!dev) return c.json({ error: "设备不存在" }, 404);
  return c.json({ success: true, disabled, device: { id: dev.id, disabled: !!dev.disabled } });
});

apiRoutes.get("/v1/airplay/active", (c) => {
  const active = getQueueManager().activeDevices().map((a) => ({
    deviceId: a.deviceId,
    snapshot: { ...a.snapshot, currentMedia: getAirPlayPeerStatus(a.deviceId).media },
  }));
  return c.json({ active });
});

apiRoutes.post("/v1/airplay/cast", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const { songId, deviceId } = body as any;
  if (!songId || !deviceId) return c.json({ error: "需要 songId 和 deviceId" }, 400);
  try {
    await castToAirPlayDevice({
      songId, deviceId,
      baseUrl: getDlnaBaseUrl(c),
    });
    return c.json({ success: true, message: "已投放到 AirPlay 设备" });
  } catch (e: any) {
    return c.json({ error: e.message || "投放失败" }, 500);
  }
});

// Set the play mode (order | one | all | shuffle) for a device's queue.
// Body: { mode: PlayMode }
apiRoutes.post("/v1/dlna/devices/:deviceId/play-mode", async (c) => {
  const { mode } = await c.req.json().catch(() => ({} as any));
  if (!["order", "one", "all", "shuffle"].includes(mode)) {
    return c.json({ error: "无效的 mode" }, 400);
  }
  getQueueManager().setPlayMode(c.req.param("deviceId")!, mode);
  return c.json({ success: true });
});

// Remove a single item from the queue by index. Playback stays coherent:
// if the removed item was current, the next one starts playing.
apiRoutes.delete("/v1/dlna/devices/:deviceId/queue/:index", async (c) => {
  const deviceId = c.req.param("deviceId")!;
  const index = parseInt(c.req.param("index")!, 10);
  if (Number.isNaN(index)) return c.json({ error: "无效的 index" }, 400);
  getQueueManager().removeAt(deviceId, index, getDlnaBaseUrl(c));
  return c.json({ success: true });
});

// Mark a device's queue inactive without clearing it (used when the user
// stops cast from the Web client — the queue stays in DB for reuse, but the
// device is no longer considered "actively casting" for restore purposes).
apiRoutes.post("/v1/dlna/devices/:deviceId/deactivate", (c) => {
  getQueueManager().deactivate(c.req.param("deviceId")!);
  return c.json({ success: true });
});

// ==================== Unified peer API ====================
//
// One API surface for both local (Web client) and DLNA peers. The peerId
// encodes the kind: "local:<userId>" or "dlna:<deviceId>". The colon in the
// path segment is URL-safe; clients send it encoded (encodeURIComponent) and
// we decode here so handlers always see the canonical form.
//
// For local peers the backend only stores queue metadata (audio runs on the
// Web client). Transport controls (play/pause/next/prev/seek/volume) are
// accepted but are no-ops server-side — the Web client owns Howl and reports
// state changes back via /queue/index and /play-mode.
//
// For dlna peers every call delegates to the existing queue manager + control
// layer, so HA and Web share the exact same queue + auto-advance logic.
const pm = getPeerManager();

function decodePeerId(c: any): string {
  return decodeURIComponent(c.req.param("peerId") || "");
}

// 可投屏/可控制 peer:dlna 设备、播放器群组(group)与 AirPlay 设备(airplay)。
// dlna/group/airplay 队列都归 QueueController 管(内部按裸 id),
// 传输控制 dlna 走 control.ts、group 走组扇出、airplay 走 airplay/control.ts。
function isCastPeer(parsed: { kind: string }): boolean {
  return parsed.kind === "dlna" || parsed.kind === "group" || parsed.kind === "airplay";
}

// List all known peers (local + dlna) with their queue snapshots. The Web
// client calls this to populate the player-switcher popup.
// 权限:管理员看到全部;普通用户只能看到自己的本机播放器(local:<userId>),
// 无法看到其他用户的播放器/DLNA/群组(见需求:播放器仅对 admin 开放)。
apiRoutes.get("/v1/peers", (c) => {
  const user = c.get("user");
  let peers = pm.listWithQueues();
  if (!user?.isAdmin) {
    const ownLocal = `local:${user?.id ?? ""}`;
    peers = peers.filter((p) => p.peerId === ownLocal);
  }
  return c.json({ peers });
});

// 非 admin 只能控制/查询自己的本机播放器(local:<userId>);对其它 peer 一律 403。
// 与 /v1/peers 列表过滤一致,防止普通用户看到或遥控别人的播放器/群组。
apiRoutes.use("/v1/peers/:peerId/*", async (c, next) => {
  const user = c.get("user");
  if (user?.isAdmin) return next();
  const peerId = c.req.param("peerId");
  if (peerId === `local:${user?.id ?? ""}`) return next();
  return c.json(apiError(BusinessErrorCode.FORBIDDEN, "无权操作该播放器"), 403);
});

apiRoutes.use("/v1/peers/:peerId", async (c, next) => {
  if (c.req.method !== "GET") return next(); // 只拦 GET 详情/状态查询;register/heartbeat 等走各自校验
  const user = c.get("user");
  if (user?.isAdmin) return next();
  const peerId = c.req.param("peerId");
  return peerId === `local:${user?.id ?? ""}`
    ? next()
    : c.json(apiError(BusinessErrorCode.FORBIDDEN, "无权操作该播放器"), 403);
});

// Register/refresh the calling user's local peer. Body: { name?: string }.
// name defaults to the username so the switcher shows a friendly label.
apiRoutes.post("/v1/peers/register", (c) => {
  const user = c.get("user")!;
  const body = c.req.json().catch(() => ({})) as any;
  const name = (body && typeof body.name === "string" && body.name) || user.username;
  const peer = pm.registerLocal(user.id, name);
  return c.json({ peer });
});

// Heartbeat: keep a local peer alive. Called periodically by the Web client.
apiRoutes.post("/v1/peers/:peerId/heartbeat", (c) => {
  const peerId = decodePeerId(c);
  const ok = pm.heartbeat(peerId);
  return c.json({ success: ok });
});

// Get a peer's queue snapshot (local: from local_queues; dlna/group: from queue manager).
// offset/size 分页:items 只含当前页,total 为完整队列长度(currentIndex 恒为绝对下标)。
// 缺省 offset/size 返回全量(向后兼容)。
apiRoutes.get("/v1/peers/:peerId/queue", (c) => {
  const peerId = decodePeerId(c);
  const snap = pm.getQueueSnapshot(peerId);
  if (!snap) return c.json({ error: "无效的 peerId" }, 400);
  // dlna peer:补 currentMedia(原 QueueSnapshot 字段,新 snapshot 改用 ended)。
  const parsed = parsePeerId(peerId);
  const currentMedia = parsed
    ? parsed.kind === "dlna"
      ? getCurrentMedia(parsed.id)
      : parsed.kind === "airplay"
        ? getAirPlayPeerStatus(parsed.id).media
        : undefined
    : undefined;
  const items = Array.isArray(snap.items) ? snap.items : [];
  const total = items.length;
  const offset = Math.max(0, parseInt(c.req.query("offset") || "0", 10) || 0);
  const size = parseInt(c.req.query("size") || "0", 10) || 0;
  const pagedItems = size > 0 ? items.slice(offset, offset + size) : items;
  return c.json({ ...snap, items: pagedItems, total, currentMedia });
});

// Replace the queue and (for dlna/group) start playing from startIndex.
// For local peers this just persists the queue; the Web client starts Howl.
// Body: { items: QueueItem[], startIndex?: number }
apiRoutes.post("/v1/peers/:peerId/queue/play", async (c) => {
  const peerId = decodePeerId(c);
  const { items, startIndex } = await c.req.json().catch(() => ({} as any));
  if (!Array.isArray(items)) return c.json({ error: "需要 items 数组" }, 400);
  const start = typeof startIndex === "number" ? startIndex : 0;
  const parsed = parsePeerId(peerId);
  if (!parsed) return c.json({ error: "无效的 peerId" }, 400);
  if (isCastPeer(parsed)) {
    try {
      await getQueueManager().playFrom(parsed.id, items, start, getDlnaBaseUrl(c));
      return c.json({ success: true });
    } catch (e: any) { return c.json({ error: e.message }, 500); }
  }
  // local
  pm.localPlayFrom(peerId, c.get("user")!.id, items, start);
  return c.json({ success: true });
});

// 跳播到指定索引并立即播放。即使随机模式也尊重 index(随机仅作用于后续自动续播)。
// Body: { index: number }
apiRoutes.post("/v1/peers/:peerId/queue/jump", async (c) => {
  const peerId = decodePeerId(c);
  const { index } = await c.req.json().catch(() => ({} as any));
  if (typeof index !== "number" || !Number.isInteger(index)) {
    return c.json({ error: "需要整数 index" }, 400);
  }
  const parsed = parsePeerId(peerId);
  if (!parsed) return c.json({ error: "无效的 peerId" }, 400);
  if (isCastPeer(parsed)) {
    try {
      await getQueueManager().jumpTo(parsed.id, index, getDlnaBaseUrl(c));
      return c.json({ success: true });
    } catch (e: any) { return c.json({ error: e.message }, 500); }
  }
  // local: 直接设当前索引,Web 客户端 Howl 跟进播放
  pm.localSetIndex(peerId, index);
  return c.json({ success: true });
});

// Append items to the queue without switching playback.
// Body: { items: QueueItem[] }
apiRoutes.post("/v1/peers/:peerId/queue/enqueue", async (c) => {
  const peerId = decodePeerId(c);
  const { items } = await c.req.json().catch(() => ({} as any));
  if (!Array.isArray(items)) return c.json({ error: "需要 items 数组" }, 400);
  const parsed = parsePeerId(peerId);
  if (!parsed) return c.json({ error: "无效的 peerId" }, 400);
  if (isCastPeer(parsed)) {
    try {
      await getQueueManager().enqueue(parsed.id, items, getDlnaBaseUrl(c));
      return c.json({ success: true });
    } catch (e: any) { return c.json({ error: e.message }, 500); }
  }
  pm.localEnqueue(peerId, c.get("user")!.id, items);
  return c.json({ success: true });
});

// Clear the queue.
apiRoutes.delete("/v1/peers/:peerId/queue", (c) => {
  const peerId = decodePeerId(c);
  const parsed = parsePeerId(peerId);
  if (!parsed) return c.json({ error: "无效的 peerId" }, 400);
  if (isCastPeer(parsed)) {
    getQueueManager().clear(parsed.id);
  } else {
    pm.localClear(peerId);
  }
  return c.json({ success: true });
});

// Mark a cast peer's queue inactive without clearing it (Web client stops cast:
// playback stops, the queue stays in DB for later reuse / restore skipping).
apiRoutes.post("/v1/peers/:peerId/queue/deactivate", (c) => {
  const peerId = decodePeerId(c);
  const parsed = parsePeerId(peerId);
  if (!parsed) return c.json({ error: "无效的 peerId" }, 400);
  if (isCastPeer(parsed)) getQueueManager().deactivate(parsed.id);
  return c.json({ success: true });
});

// Remove a single item by index.
apiRoutes.delete("/v1/peers/:peerId/queue/:index", async (c) => {
  const peerId = decodePeerId(c);
  const index = parseInt(c.req.param("index")!, 10);
  if (Number.isNaN(index)) return c.json({ error: "无效的 index" }, 400);
  const parsed = parsePeerId(peerId);
  if (!parsed) return c.json({ error: "无效的 peerId" }, 400);
  if (isCastPeer(parsed)) {
    getQueueManager().removeAt(parsed.id, index, getDlnaBaseUrl(c));
  } else {
    pm.localRemoveAt(peerId, index);
  }
  return c.json({ success: true });
});

// Reorder a queue item (drag & drop). Body: { from: number, to: number }
apiRoutes.post("/v1/peers/:peerId/queue/reorder", async (c) => {
  const peerId = decodePeerId(c);
  const body = await c.req.json().catch(() => ({} as any));
  const { from, to } = body;
  if (typeof from !== "number" || typeof to !== "number" || !Number.isInteger(from) || !Number.isInteger(to)) {
    return c.json({ error: "需要整数 from/to" }, 400);
  }
  const parsed = parsePeerId(peerId);
  if (!parsed) return c.json({ error: "无效的 peerId" }, 400);
  if (isCastPeer(parsed)) {
    getQueueManager().reorder(parsed.id, from, to);
  } else {
    pm.localReorder(peerId, from, to);
  }
  return c.json({ success: true });
});

// Set the play mode (order | one | all | shuffle).
// Body: { mode: PlayMode }
apiRoutes.post("/v1/peers/:peerId/play-mode", async (c) => {
  const peerId = decodePeerId(c);
  const { mode } = await c.req.json().catch(() => ({} as any));
  if (!["order", "one", "all", "shuffle"].includes(mode)) {
    return c.json({ error: "无效的 mode" }, 400);
  }
  const parsed = parsePeerId(peerId);
  if (!parsed) return c.json({ error: "无效的 peerId" }, 400);
  if (isCastPeer(parsed)) {
    getQueueManager().setPlayMode(parsed.id, mode);
  } else {
    pm.localSetPlayMode(peerId, mode);
  }
  return c.json({ success: true });
});

// Report the current track index for a local peer (Web client → backend).
// Body: { index: number }
apiRoutes.post("/v1/peers/:peerId/queue/index", async (c) => {
  const peerId = decodePeerId(c);
  const { index } = await c.req.json().catch(() => ({} as any));
  if (typeof index !== "number") return c.json({ error: "需要 index" }, 400);
  const parsed = parsePeerId(peerId);
  if (!parsed || parsed.kind !== "local") return c.json({ error: "仅 local peer 支持" }, 400);
  pm.localSetIndex(peerId, index);
  return c.json({ success: true });
});

// ==================== Peer transport controls ====================
// For dlna peers these command the device. For local peers they are no-ops
// server-side (the Web client owns the audio) — they exist only so HA can use
// a single URL shape; local-peer playback is not controllable from HA.

apiRoutes.post("/v1/peers/:peerId/play", async (c) => {
  const peerId = decodePeerId(c);
  const parsed = parsePeerId(peerId);
  if (!parsed) return c.json({ error: "无效的 peerId" }, 400);
  if (parsed.kind === "dlna") {
    try {
      getQueueController().resumePlayback(parsed.id);
      await playDevice(parsed.id);
      return c.json({ success: true });
    }
    catch (e: any) { return c.json({ error: e.message }, 500); }
  }
  if (parsed.kind === "group") {
    try {
      getQueueController().resumePlayback(parsed.id);
      await getQueueController().transport(parsed.id, "play");
      return c.json({ success: true });
    }
    catch (e: any) { return c.json({ error: e.message }, 500); }
  }
  if (parsed.kind === "airplay") {
    try {
      getQueueController().resumePlayback(parsed.id);
      await getQueueController().transport(parsed.id, "play");
      return c.json({ success: true });
    }
    catch (e: any) { return c.json({ error: e.message }, 500); }
  }
  return c.json({ success: true }); // local: no-op
});

apiRoutes.post("/v1/peers/:peerId/pause", async (c) => {
  const peerId = decodePeerId(c);
  const parsed = parsePeerId(peerId);
  if (!parsed) return c.json({ error: "无效的 peerId" }, 400);
  if (parsed.kind === "dlna") {
    try { await pauseDevice(parsed.id); return c.json({ success: true }); }
    catch (e: any) { return c.json({ error: e.message }, 500); }
  }
  if (parsed.kind === "group") {
    try { await getQueueController().transport(parsed.id, "pause"); return c.json({ success: true }); }
    catch (e: any) { return c.json({ error: e.message }, 500); }
  }
  if (parsed.kind === "airplay") {
    try { await getQueueController().transport(parsed.id, "pause"); return c.json({ success: true }); }
    catch (e: any) { return c.json({ error: e.message }, 500); }
  }
  return c.json({ success: true });
});

apiRoutes.post("/v1/peers/:peerId/stop", async (c) => {
  const peerId = decodePeerId(c);
  const parsed = parsePeerId(peerId);
  if (!parsed) return c.json({ error: "无效的 peerId" }, 400);
  if (parsed.kind === "dlna") {
    try {
      getQueueController().stopPlayback(parsed.id);
      await stopDevice(parsed.id);
      return c.json({ success: true });
    }
    catch (e: any) { return c.json({ error: e.message }, 500); }
  }
  if (parsed.kind === "group") {
    try {
      getQueueController().stopPlayback(parsed.id);
      await getQueueController().transport(parsed.id, "stop");
      return c.json({ success: true });
    }
    catch (e: any) { return c.json({ error: e.message }, 500); }
  }
  if (parsed.kind === "airplay") {
    try {
      getQueueController().stopPlayback(parsed.id);
      await getQueueController().transport(parsed.id, "stop");
      return c.json({ success: true });
    }
    catch (e: any) { return c.json({ error: e.message }, 500); }
  }
  return c.json({ success: true });
});

apiRoutes.post("/v1/peers/:peerId/next", async (c) => {
  const peerId = decodePeerId(c);
  const parsed = parsePeerId(peerId);
  if (!parsed) return c.json({ error: "无效的 peerId" }, 400);
  if (isCastPeer(parsed)) {
    try { await getQueueManager().next(parsed.id, getDlnaBaseUrl(c)); return c.json({ success: true }); }
    catch (e: any) { return c.json({ error: e.message }, 500); }
  }
  return c.json({ success: true });
});

apiRoutes.post("/v1/peers/:peerId/prev", async (c) => {
  const peerId = decodePeerId(c);
  const parsed = parsePeerId(peerId);
  if (!parsed) return c.json({ error: "无效的 peerId" }, 400);
  if (isCastPeer(parsed)) {
    try { await getQueueManager().prev(parsed.id, getDlnaBaseUrl(c)); return c.json({ success: true }); }
    catch (e: any) { return c.json({ error: e.message }, 500); }
  }
  return c.json({ success: true });
});

apiRoutes.post("/v1/peers/:peerId/seek", async (c) => {
  const peerId = decodePeerId(c);
  const parsed = parsePeerId(peerId);
  if (!parsed) return c.json({ error: "无效的 peerId" }, 400);
  if (parsed.kind === "dlna") {
    const body = await c.req.json().catch(() => ({} as any));
    const seconds = typeof body.seconds === "number" ? body.seconds : body.position;
    if (typeof seconds !== "number") return c.json({ error: "需要 seconds 或 position" }, 400);
    try { await seekDevice(parsed.id, seconds); return c.json({ success: true }); }
    catch (e: any) { return c.json({ error: e.message }, 500); }
  }
  if (parsed.kind === "group") {
    const body = await c.req.json().catch(() => ({} as any));
    const seconds = typeof body.seconds === "number" ? body.seconds : body.position;
    if (typeof seconds !== "number") return c.json({ error: "需要 seconds 或 position" }, 400);
    try { await getQueueController().transport(parsed.id, "seek", seconds); return c.json({ success: true }); }
    catch (e: any) { return c.json({ error: e.message }, 500); }
  }
  if (parsed.kind === "airplay") {
    const body = await c.req.json().catch(() => ({} as any));
    const seconds = typeof body.seconds === "number" ? body.seconds : body.position;
    if (typeof seconds !== "number") return c.json({ error: "需要 seconds 或 position" }, 400);
    try { await getQueueController().transport(parsed.id, "seek", seconds); return c.json({ success: true }); }
    catch (e: any) { return c.json({ error: e.message }, 500); }
  }
  return c.json({ success: true });
});

apiRoutes.post("/v1/peers/:peerId/volume", async (c) => {
  const peerId = decodePeerId(c);
  const parsed = parsePeerId(peerId);
  if (!parsed) return c.json({ error: "无效的 peerId" }, 400);
  if (parsed.kind === "dlna") {
    const { volume } = await c.req.json().catch(() => ({} as any));
    if (typeof volume !== "number") return c.json({ error: "需要 volume" }, 400);
    try { await setDeviceVolume(parsed.id, volume); return c.json({ success: true }); }
    catch (e: any) { return c.json({ error: e.message }, 500); }
  }
  if (parsed.kind === "group") {
    const { volume } = await c.req.json().catch(() => ({} as any));
    if (typeof volume !== "number") return c.json({ error: "需要 volume" }, 400);
    try { await getQueueController().transport(parsed.id, "volume", volume); return c.json({ success: true }); }
    catch (e: any) { return c.json({ error: e.message }, 500); }
  }
  if (parsed.kind === "airplay") {
    const { volume } = await c.req.json().catch(() => ({} as any));
    if (typeof volume !== "number") return c.json({ error: "需要 volume" }, 400);
    try { await getQueueController().transport(parsed.id, "volume", volume); return c.json({ success: true }); }
    catch (e: any) { return c.json({ error: e.message }, 500); }
  }
  return c.json({ success: true });
});

// 播报(TTS)。Body: { url: string, volume?: number, blocking?: boolean }
// 打断当前播放放一段外链音频,播完自动回到原曲原进度(详见 dlna/announce.ts)。
// 默认非阻塞:立刻 202 返回,播报在后台跑完 —— HA 的 play_media 调用不该被一段
// 30 秒的语音卡在那里。blocking=true 时才等播报全程结束再响应。
apiRoutes.post("/v1/peers/:peerId/announce", async (c) => {
  const peerId = decodePeerId(c);
  const parsed = parsePeerId(peerId);
  if (!parsed) return c.json({ error: "无效的 peerId" }, 400);
  const body = await c.req.json().catch(() => ({} as any));
  const url = typeof body.url === "string" ? body.url : "";
  if (!url) return c.json({ error: "需要 url" }, 400);
  const volume = typeof body.volume === "number" ? body.volume : undefined;

  if (body.blocking === true) {
    try {
      const r = await announceOnPeer({ peerId, url, volume });
      return c.json({ success: true, ...r });
    } catch (e: any) { return c.json({ error: e.message }, 500); }
  }
  if (isAnnouncing(peerId)) return c.json({ error: "该播放器正在播报中" }, 409);
  announceOnPeer({ peerId, url, volume }).catch((e: any) => {
    log.warn(`[announce] ${peerId}: ${e?.message || e}`);
  });
  return c.json({ success: true, accepted: true }, 202);
});

// 静音开关。Body: { muted: boolean }
// 与音量是两条独立的 RenderingControl 状态量:静音不动 Volume,取消静音后设备
// 自己恢复原音量。因此不能用"音量设 0 / 存旧值再还原"来模拟——那样设备侧物理
// 调音量时会把我们存的旧值弄脏。
apiRoutes.post("/v1/peers/:peerId/mute", async (c) => {
  const peerId = decodePeerId(c);
  const parsed = parsePeerId(peerId);
  if (!parsed) return c.json({ error: "无效的 peerId" }, 400);
  const { muted } = await c.req.json().catch(() => ({} as any));
  if (typeof muted !== "boolean") return c.json({ error: "需要 muted(boolean)" }, 400);
  if (parsed.kind === "dlna") {
    try { await setDeviceMute(parsed.id, muted); return c.json({ success: true }); }
    catch (e: any) { return c.json({ error: e.message }, 500); }
  }
  if (parsed.kind === "group") {
    // 组没有自己的渲染器,静音要逐台成员下发。个别成员不支持静音时不应连累
    // 其余设备,所以全部并发执行后再汇总——只有全员失败才算失败。
    const members = gm.get(parsed.id)?.memberIds || [];
    if (members.length === 0) return c.json({ error: "组内无成员" }, 400);
    const results = await Promise.allSettled(members.map(d => setDeviceMute(d, muted)));
    const ok = results.filter(r => r.status === "fulfilled").length;
    if (ok === 0) {
      const reason = results[0].status === "rejected" ? (results[0] as PromiseRejectedResult).reason : null;
      return c.json({ error: reason?.message || "组内设备均不支持静音" }, 500);
    }
    return c.json({ success: true, applied: ok, total: members.length });
  }
  if (parsed.kind === "airplay") {
    try { await setAirPlayMuted(parsed.id, muted); return c.json({ success: true }); }
    catch (e: any) { return c.json({ error: e.message }, 500); }
  }
  return c.json({ success: true });
});

// Peer status: for dlna returns the device transport state; for groups the
// leader's state (MA 同款:组状态从 leader 派生);for local returns the stored
// queue metadata (HA uses this to read the local peer's queue).
apiRoutes.get("/v1/peers/:peerId", (c) => {
  const peerId = decodePeerId(c);
  const p = getPeerManager().get(peerId);
  if (!p) return c.json({ error: "无效的 peerId" }, 400);
  return c.json({ peer: { ...p, queue: getPeerManager().getQueueSnapshot(peerId) } });
});

apiRoutes.get("/v1/peers/:peerId/status", async (c) => {
  const peerId = decodePeerId(c);
  const parsed = parsePeerId(peerId);
  if (!parsed) return c.json({ error: "无效的 peerId" }, 400);
  if (parsed.kind === "dlna") {
    try {
      const deviceId = parsed.id;
      const status = await getDeviceStatus(deviceId);
      const evt = getEventManager().getEventState(deviceId);
      if (evt) {
        if (evt.state) status.state = evt.state;
        // NOTE: position/duration 一律用 SOAP 实时值(status 已含)。GENA 事件在播放中
        // 不会持续上报 RelTime,evt.position 会停在上次 seek/切歌的旧值;用它覆盖 SOAP 的真实
        // 递增 position 会把前端进度每轮询周期打回旧值,表现为进度不前进。故此处不覆盖 position/duration。
        if (typeof evt.volume === "number") status.volume = evt.volume;
        if (typeof evt.muted === "boolean") status.muted = evt.muted;
        // 事件驱动下 position 是 GENA 推送时的采样,updatedAt(EventState)比 SOAP 轮询时刻更贴近。
        if (typeof evt.updatedAt === "number" && evt.updatedAt > 0) status.updatedAt = evt.updatedAt;
      }
      return c.json(status);
    } catch (e: any) { return c.json({ error: e.message }, 500); }
  }
  if (parsed.kind === "group") {
    try {
      const status = await getGroupStatus(parsed.id);
      const evt = getEventManager().getEventState(getGroupLeaderDeviceId(parsed.id) || "");
      if (evt) {
        if (evt.state) status.state = evt.state;
        // NOTE: position/duration 一律用 SOAP 实时值(status 已含)。GENA 事件在播放中
        // 不会持续上报 RelTime,evt.position 会停在上次 seek/切歌的旧值;用它覆盖 SOAP 的真实
        // 递增 position 会把前端进度每轮询周期打回旧值,表现为进度不前进。故此处不覆盖 position/duration。
        if (typeof evt.volume === "number") status.volume = evt.volume;
        if (typeof evt.muted === "boolean") status.muted = evt.muted;
        if (typeof evt.updatedAt === "number" && evt.updatedAt > 0) status.updatedAt = evt.updatedAt;
      }
      return c.json(status);
    } catch (e: any) { return c.json({ error: e.message }, 500); }
  }
  if (parsed.kind === "airplay") {
    return c.json(getAirPlayPeerStatus(parsed.id));
  }
  // local: return queue snapshot as "status"
  return c.json(pm.getQueueSnapshot(peerId) || {});
});

// ==================== 播放器群组 API ====================
// 一个组聚合多台 DLNA 设备(组持队列、播放时并发向成员 cast 同一首歌,
// 仿 MA Sync Group / Universal Group)。成员勾选提交全量 memberIds(PUT)。
// 组播放控制复用 peer API:peerId = "group:<groupId>"(阶段 2 接入)。
const gm = getGroupManager();

// 列出全部组(含成员设备信息:名称/可用性)。
apiRoutes.get("/v1/groups", (c) => {
  return c.json({ groups: gm.listWithMembers() });
});

// 新建组。Body: { name: string, memberIds?: string[] }
apiRoutes.post("/v1/groups", async (c) => {
  const body = await c.req.json().catch(() => ({} as any));
  const name = typeof body.name === "string" ? body.name : "";
  const memberIds = Array.isArray(body.memberIds) ? body.memberIds : [];
  try {
    const g = gm.createGroup(name, memberIds);
    return c.json({ group: gm.getWithMembers(g.id) }, 201);
  } catch (e: any) {
    return c.json({ error: e.message || "创建组失败" }, 400);
  }
});

// 更新组:改名(name)和/或全量替换成员(memberIds)。Body: { name?, memberIds? }
apiRoutes.put("/v1/groups/:id", async (c) => {
  const id = c.req.param("id")!;
  const body = await c.req.json().catch(() => ({} as any));
  try {
    if (typeof body.name === "string") {
      const renamed = gm.renameGroup(id, body.name);
      if (!renamed) return c.json({ error: "组不存在" }, 404);
    }
    if (Array.isArray(body.memberIds)) {
      const before = gm.get(id)?.memberIds || [];
      const updated = gm.setMembers(id, body.memberIds);
      if (!updated) return c.json({ error: "组不存在" }, 404);
      const after = gm.get(id)?.memberIds || [];
      const added = after.filter(d => !before.includes(d));
      if (added.length > 0) {
        // 成员加入播放中的组:把当前曲 cast 给新成员并 seek 到 leader 进度
        // (仅加入时一次,不做周期漂移校正——纯 MA 忠实策略)。
        getQueueController().rejoinMembers(id, added).catch((e: any) => {
          log.warn(`[group] ${id}: 成员加入对齐失败: ${e?.message || e}`);
        });
      }
    }
    const g = gm.getWithMembers(id);
    if (!g) return c.json({ error: "组不存在" }, 404);
    return c.json({ group: g });
  } catch (e: any) {
    return c.json({ error: e.message || "更新组失败" }, 400);
  }
});

// 删除组(组队列随之删除,成员设备恢复单独控制)。
apiRoutes.delete("/v1/groups/:id", (c) => {
  const ok = gm.deleteGroup(c.req.param("id")!);
  if (!ok) return c.json({ error: "组不存在" }, 404);
  return c.json({ success: true });
});

// ==================== 统一内容点播(webhook / 外部 API) ====================
// POST /v1/play { peerId, type: song|playlist|artist|album|genre, id, startIndex?, playMode?, enqueue? }
// 服务器端把内容 ID 解析成歌曲队列并投递到指定播放器:
//   - dlna / group → 直接开始播放(后端控制音频,无需浏览器)
//   - local → 注入队列(音频仍由 Web 客户端 Howl 驱动)

apiRoutes.post("/v1/play", async (c) => {
  const body = await c.req.json().catch(() => ({} as any));
  const { peerId, type, id, startIndex, playMode, enqueue } = body || {};
  if (typeof peerId !== "string" || typeof type !== "string" || typeof id !== "string") {
    return c.json({ error: "需要 peerId / type / id" }, 400);
  }
  const parsed = parsePeerId(peerId);
  if (!parsed) return c.json({ error: "无效的 peerId" }, 400);
  const resolved = resolveContentSongs(type, id);
  if (!resolved) return c.json({ error: `无效的 ${type} id` }, 404);
  const items = songsToQueueItems(resolved.rows);
  if (items.length === 0) return c.json({ error: `「${resolved.name}」没有可播放的歌曲` }, 422);
  const start = typeof startIndex === "number" && startIndex >= 0 && startIndex < items.length ? Math.floor(startIndex) : 0;
  const baseUrl = getDlnaBaseUrl(c);
  if (isCastPeer(parsed)) {
    try {
      if (enqueue) await getQueueManager().enqueue(parsed.id, items, baseUrl);
      else await getQueueManager().playFrom(parsed.id, items, start, baseUrl);
    } catch (e: any) { return c.json({ error: e.message || "播放失败" }, 500); }
  } else {
    if (enqueue) pm.localEnqueue(peerId, c.get("user")?.id, items);
    else pm.localPlayFrom(peerId, c.get("user")?.id, items, start);
  }
  if (typeof playMode === "string" && ["order", "one", "all", "shuffle"].includes(playMode)) {
    const mode = playMode as "order" | "one" | "all" | "shuffle";
    if (isCastPeer(parsed)) getQueueManager().setPlayMode(parsed.id, mode);
    else pm.localSetPlayMode(peerId, mode);
  }
  return c.json({ success: true, peerId, type, id, name: resolved.name, queued: items.length, startIndex: enqueue ? undefined : start });
});

// ==================== 音流(MusicFlow) ====================
// 每条音流 = 目标设备/组(多选) + 等上线 + 音量 + 播放模式 + 播歌单,
// 通过唯一 token 的公开 webhook 链接(/api/v1/webhooks/flows/:token)异步触发。

const DEFAULT_DEFINITION = {
  targets: [],
  waitTimeoutSec: 0,
  scanIntervalSec: 5,
  volume: { enabled: true, value: 80 },
  playmode: { enabled: true, mode: "shuffle" },
  content: { enabled: true, type: "playlist", id: "", startIndex: 0 },
};

// 对外可复制链接:用局域网可达 base,保证外部 webhook 能命中。/rest、/api 均受鉴权,
// 音流链接悬停在 /webhooks/... 路径上(免鉴权),且必须携带所绑定的「通用播放器控制」渠道 token。
// 绑定 token 缺失或已停用时,flow.webhookUrl 为空(前端提示先到「通用播放器控制」创建/启用 token)。
function flowWithWebhook(flow: any) {
  let webhookUrl = "";
  const tok = flow.tokenId ? getPlayerWebhookTokenById(flow.tokenId) : undefined;
  if (tok && tok.enabled) {
    webhookUrl = `${getEffectiveBaseUrl()}/webhooks/flows/${flow.id}?token=${encodeURIComponent(tok.token)}`;
  }
  return { ...flow, tokenId: flow.tokenId || "", tokenName: tok?.name || "", webhookUrl };
}

// 创建时未指定 tokenId:自动绑定第一个启用渠道 token,让新音流立即可触发。
function resolveDefaultTokenId(): string {
  const t = listPlayerWebhookTokens().find(x => x.enabled);
  return t ? t.id : "";
}

apiRoutes.get("/v1/flows", adminMiddleware, (c) => {
  const items = listFlows().map(flowWithWebhook);
  return c.json({ total: items.length, items });
});

apiRoutes.get("/v1/flows/:id", adminMiddleware, (c) => {
  const flow = getFlow(c.req.param("id")!);
  if (!flow) return c.json({ error: "流程不存在" }, 404);
  return c.json({ flow: flowWithWebhook(flow) });
});

apiRoutes.post("/v1/flows", adminMiddleware, async (c) => {
  const body = await c.req.json().catch(() => ({} as any));
  const name = typeof body.name === "string" ? body.name.trim() : "";
  if (!name) return c.json({ error: "需要 name" }, 400);
  // 绑定渠道 token:校验 body.tokenId 存在;缺省自动绑定第一个启用渠道 token。
  let tokenId = "";
  if (body.tokenId) {
    const t = getPlayerWebhookTokenById(String(body.tokenId));
    if (!t) return c.json({ error: "指定的渠道 token 不存在" }, 400);
    tokenId = t.id;
  } else {
    tokenId = resolveDefaultTokenId();
  }
  const flow = createFlow(name, body.definition || { ...DEFAULT_DEFINITION }, tokenId);
  return c.json({ flow: flowWithWebhook(flow) });
});

apiRoutes.put("/v1/flows/:id", adminMiddleware, async (c) => {
  const body = await c.req.json().catch(() => ({} as any));
  const upd: any = {
    name: typeof body.name === "string" ? body.name : undefined,
    definition: body.definition,
    enabled: body.enabled === undefined ? undefined : !!body.enabled,
  };
  // 音流对外链接可改绑渠道 token。
  if (typeof body.tokenId === "string") {
    if (body.tokenId) {
      const t = getPlayerWebhookTokenById(body.tokenId);
      if (!t) return c.json({ error: "指定的渠道 token 不存在" }, 400);
      upd.tokenId = t.id;
    } else {
      upd.tokenId = "";
    }
  }
  const flow = updateFlow(c.req.param("id")!, upd);
  if (!flow) return c.json({ error: "流程不存在" }, 404);
  return c.json({ flow: flowWithWebhook(flow) });
});

apiRoutes.delete("/v1/flows/:id", adminMiddleware, (c) => {
  const ok = deleteFlow(c.req.param("id")!);
  if (!ok) return c.json({ error: "流程不存在" }, 404);
  return c.json({ success: true });
});

// UI 手动触发(异步执行,返回当前运行状态)。
apiRoutes.post("/v1/flows/:id/run", adminMiddleware, async (c) => {
  const flow = getFlow(c.req.param("id")!);
  if (!flow) return c.json({ error: "流程不存在" }, 404);
  if (!flow.enabled) return c.json({ error: "流程已停用" }, 409);
  const started = await executeFlow(flow.id, getDlnaBaseUrl(c));
  return c.json({ success: true, started: started === "started", running: isFlowRunning(flow.id) });
});

// ==================== 通用播放器控制渠道 token(独立管理,可多条) ====================
// 每条渠道 token 可独立启用/停用/删除;「我喜欢」收藏归属各自 owner(创建者)。
// 免鉴权端点 /webhook/player 凭任一启用的 token 执行。与音流(flow)流程完全解耦。

apiRoutes.get("/v1/player-webhook/tokens", (c) => {
  const items = listPlayerWebhookTokens().map(t => ({
    id: t.id, name: t.name, token: t.token, enabled: t.enabled,
    ownerName: resolvePlayerWebhookOwnerName(t.ownerUserId),
    createdAt: t.createdAt, updatedAt: t.updatedAt,
  }));
  return c.json({ items, templateUrl: `${getEffectiveBaseUrl()}/webhook/player` });
});

apiRoutes.post("/v1/player-webhook/tokens", async (c) => {
  const body = await c.req.json().catch(() => ({} as any));
  const name = (body && typeof body.name === "string" && body.name.trim()) || "渠道 " + (listPlayerWebhookTokens().length + 1);
  const token = createPlayerWebhookToken(c.get("user")!.id, name);
  return c.json({ token, name });
});

apiRoutes.put("/v1/player-webhook/tokens/:id", async (c) => {
  const body = await c.req.json().catch(() => ({} as any));
  const enabled = !!(body && body.enabled);
  const ok = setPlayerWebhookTokenEnabled(c.req.param("id")!, enabled);
  if (!ok) return c.json({ error: "token 不存在" }, 404);
  return c.json({ success: true });
});

apiRoutes.delete("/v1/player-webhook/tokens/:id", (c) => {
  const ok = deletePlayerWebhookToken(c.req.param("id")!);
  if (!ok) return c.json({ error: "token 不存在" }, 404);
  return c.json({ success: true });
});

