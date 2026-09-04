import { getRequestListener } from "@hono/node-server";
import { createServer } from "http";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { compress } from "hono/compress";
import { metricsMiddleware } from "./middleware/metrics.js";
import { createLogger } from "./utils/logger.js";

const log = createLogger("INDEX");

import fs from "fs";
import path from "path";
import { serveStatic } from "@hono/node-server/serve-static";
import { authRoutes } from "./routes/auth/index.js";
import { restRoutes } from "./routes/rest/index.js";
import { apiRoutes, getDlnaBaseUrl } from "./routes/api/index.js";
import { navidromeRoutes } from "./routes/navidrome/index.js";
import { getFlow, executeFlow, isFlowRunning } from "./services/flows/index.js";
import {
  validatePlayerWebhookToken, listPlayerWebhookTokens, getPlayerWebhookTokenById,
  resolvePlayerDevicePeers, handlePlayerWebhook,
} from "./services/player/playerWebhook.js";
import { initDatabase, cleanupPlayHistory, sqlite, backfillGenres } from "./db/index.js";
import { authMiddleware } from "./middleware/auth.js";
import { registerBuiltinPlugins } from "./plugins/builtins.js";
import { discoverExternalPlugins } from "./plugins/discovery.js";
import { startPluginHotReload } from "./plugins/hotReload.js";
import { seedDefaultRegistry } from "./plugins/registryCatalog.js";
import { refreshDevices, getEffectiveBaseUrl, wireSsdpRealtime, loadPersistedDevices } from "./services/dlna/control.js";
import { startRandomSongsAutoRefresh } from "./services/plugin/randomSongs.js";
import { runBatchJob } from "./batch/runner.js";
import {
  setDailyRunner, startDailyScheduler, getDailyMasterEnabled, formatDailyTime,
} from "./services/dailyScheduler.js";
import { getCorsOrigins, getPlayHistoryRetentionDays } from "./utils/env.js";
import { runWithLocale, parseLocale, translate } from "./i18n.js";

const app = new Hono();

// i18n:每个请求进来先按请求头(前端口语)确定语言,写入请求级上下文。之后
// apiError/translate 会自动用该语言渲染错误文案;默认 zh-CN(缺头视为 zh)。
app.use("*", async (c, next) => {
  const locale = parseLocale(c.req.header("x-mf-lang") ?? c.req.header("accept-language"));
  return runWithLocale(locale, () => next());
});

// Log only what's useful: auth failures get a readable Chinese hint, real
// server errors (5xx) keep a bare record; everything else stays quiet.
app.use("*", async (c, next) => {
  await next();
  const status = c.res.status;
  const ts = new Date().toLocaleString("zh-CN", { hour12: false });
  if (status === 401) {
    log.info(`[${ts}] 认证失败,请检查账号密码: ${c.req.method} ${c.req.path}`);
  } else if (status >= 500) {
    log.info(`[${ts}] ${c.req.method} ${c.req.path} -> ${status}`);
  }
});

// Same-origin requests (the frontend proxies /api and /rest through Vite) never
// trigger CORS, so the default allowlist only needs to cover localhost. Direct
// cross-origin callers must be whitelisted via CORS_ORIGINS (comma separated),
// or set CORS_ORIGINS=* to allow all origins (previous behavior).
const allowedOrigins = getCorsOrigins();
// 默认(白名单为空)即"反射请求方 Origin"——恢复 previous behavior,让浏览器侧
// 的跨域客户端(如 Home Assistant Lovelace 卡片,其源与后端不同)能直接调用 REST/WS。
// 鉴权是 token-in-URL 而非 cookie,因此 CORS 在此并非安全边界。如需锁死到具体
// 来源,显式设置 CORS_ORIGINS(逗号分隔)即可。
const reflectAllOrigins = allowedOrigins.length === 0 || allowedOrigins.includes("*");
app.use("*", cors({
  origin: (origin) => {
    if (!origin) return origin;
    if (reflectAllOrigins) return origin;
    return allowedOrigins.includes(origin) ? origin : undefined;
  },
}));

// Compress JSON/HTML responses (gzip) so list payloads over a phone's mobile
// link are much smaller. Pure transport-layer win — response bytes are
// identical after decompression, so behaviour is unchanged.
app.use("*", compress());

// 请求级 metrics:慢请求(≥1s)告警 + 端点调用计数(供 GET /v1/admin/metrics 查看)。
app.use("*", metricsMiddleware);

app.route("/rest", authRoutes);
// Baked in at image build time (Dockerfile ARG APP_VERSION / APP_COMMIT, fed by
// CI from the git tag / commit). "dev" / "" means a local/unversioned build.
const APP_VERSION = process.env.APP_VERSION || "dev";
const APP_COMMIT = process.env.APP_COMMIT || "";

app.get("/rest/ping", (c) => c.json({ "subsonic-response": { status: "ok", version: "1.16.1", serverVersion: APP_VERSION, openSubsonic: true, type: "MusicFlow" } }));

app.use("/rest/*", async (c, next) => {
  // Public endpoints under /rest/* that cannot send auth headers:
  //  - dlna/stream/:token: pulled by DLNA renderers (TVs, speakers) which
  //    have no way to authenticate; access is gated by a short-lived cast
  //    token that maps to a songId inside the route handler itself.
  // getCoverArt 曾在此放行(封面 <img> 带不上请求头),但 OpenSubsonic 规范要求
  // 其鉴权,前端已在封面 URL 上附加 ?token= 查询参数,故改走 authMiddleware。
  const p = c.req.path;
  // c.req.path 是完整路径(含 /rest 前缀),所以用 includes/endsWith 匹配
  if (p.includes("/dlna/stream/")) return next();
  return authMiddleware(c, next);
});
app.route("/rest", restRoutes);
app.use("/rest/api/*", authMiddleware);
app.route("/rest/api", apiRoutes);
app.use("/api/*", authMiddleware);
app.route("/api", navidromeRoutes);
app.get("/ping", (c) => c.json({ status: "ok", version: APP_VERSION, commit: APP_COMMIT }));

// ==================== 音流 Webhook(免鉴权,凭「通用播放器控制」渠道 token 触发) ====================
// 注册在 /rest、/api 鉴权中间件之外,外部工具(GET 或 POST)直接打开链接即可触发:
//   Base/webhooks/flows/{flowId}?token={渠道token}
// 后台异步持续扫描 DLNA → 任一目标设备/组上线后依次 设音量 → 播放模式 → 播歌单。
// 该 token 必须存在、启用,且是该音流所绑定的那一个(在新建音流时选择)。
app.all("/webhooks/flows/:id", async (c) => {
  const id = c.req.param("id") || "";
  const flow = getFlow(id);
  if (!flow) return c.json({ success: false, error: translate("errors.flow.notFound") }, 404);

  const q = c.req.queries();
  const flat: Record<string, string> = {};
  for (const [k, v] of Object.entries(q)) {
    if (v && v[0] !== undefined) flat[k] = String(v[0]);
  }
  if (!flat.token) return c.json({ success: false, error: translate("errors.token.required") }, 401);

  // ① 令牌本身须存在且启用(与 /webhook/player 一致)。
  const auth = validatePlayerWebhookToken(flat.token);
  if (!auth) {
    const t = listPlayerWebhookTokens();
    if (t.some(x => x.token === flat.token)) return c.json({ success: false, error: translate("errors.token.disabled") }, 403);
    return c.json({ success: false, error: translate("errors.token.invalid") }, 401);
  }
  // ② 令牌必须是对该音流绑定的那一个(新建音流时选择)。
  const bound = flow.tokenId ? getPlayerWebhookTokenById(flow.tokenId) : undefined;
  if (!bound || bound.token !== flat.token || !bound.enabled) {
    return c.json({ success: false, error: translate("errors.flow.tokenMismatch") }, 403);
  }
  if (!flow.enabled) return c.json({ success: false, error: translate("errors.flow.disabled") }, 409);

  const started = await executeFlow(flow.id, getDlnaBaseUrl(c));
  return c.json({
    success: true,
    flowId: flow.id,
    name: flow.name,
    started: started === "started",
    running: isFlowRunning(flow.id),
  });
});

// ==================== 通用播放器控制 Webhook(免鉴权,凭 token 执行) ====================
// 与音流(flow)流程解耦:URL 参数即配置,不依赖内部流程。
// 例:
//   /webhook/player?token=xxx&device=meet&mode=order&next=1&favorite=1&volume=59
//   on执行顺序:mode → play/pause/stop/next/prev → volume(0-100 或 +N/-N)→ favorite(收藏当前曲)。
app.all("/webhook/player", async (c) => {
  const q = c.req.queries();
  const flat: Record<string, string> = {};
  for (const [k, v] of Object.entries(q)) {
    if (v && v[0] !== undefined) flat[k] = String(v[0]);
  }
  if (!flat.token) {
    return c.json({ success: false, error: translate("errors.token.required") }, 401);
  }
  const auth = validatePlayerWebhookToken(flat.token);
  if (!auth) {
    const t = listPlayerWebhookTokens();
    if (t.some(x => x.token === flat.token)) return c.json({ success: false, error: translate("errors.token.disabled") }, 403);
    return c.json({ success: false, error: translate("errors.token.invalid") }, 401);
  }
  let peers: string[];
  try {
    peers = resolvePlayerDevicePeers(flat.device || "");
  } catch (e: any) {
    return c.json({ success: false, error: e?.message || String(e) }, 400);
  }
  const baseUrl = getDlnaBaseUrl(c);
  const allResults: any[] = [];
  const songs: any[] = [];
  let anyFailed = false;
  for (const peerId of peers) {
    try {
      const r = await handlePlayerWebhook(peerId, flat, baseUrl, auth.ownerUserId);
      allResults.push(...r.results);
      if (r.song?.songId) songs.push(r.song);
      if (!r.success) anyFailed = true;
    } catch (e: any) {
      anyFailed = true;
      allResults.push({ device: peerId, op: "device", ok: false, detail: e?.message || String(e) });
    }
  }
  return c.json({
    success: !anyFailed,
    devices: peers,
    count: allResults.length,
    failed: allResults.filter((r) => !r.ok).length,
    results: allResults,
    songs,
  });
});

// ==================== Static frontend (production build) ====================
// In production the built frontend lives in ./public next to the backend;
// API paths below are already registered, so the SPA fallback only serves
// index.html for unknown non-API routes.
const staticDir = process.env.STATIC_DIR ? path.resolve(process.env.STATIC_DIR) : path.resolve(process.cwd(), "public");
app.use("/assets/*", async (c, next) => {
  await next();
  c.header("Cache-Control", "public, max-age=31536000, immutable");
});
app.get("/assets/*", serveStatic({ root: staticDir }));
// The SPA shell must always be revalidated. Without an explicit header the
// browser applies heuristic caching and keeps serving a stale index.html after
// an image upgrade — it then references asset hashes that no longer exist
// (blank page), or silently renders the previous build (e.g. an outdated
// version string on the settings page). Hashed assets above stay immutable.
app.use("*", async (c, next) => {
  await next();
  if ((c.res.headers.get("Content-Type") || "").includes("text/html")) {
    c.header("Cache-Control", "no-cache, must-revalidate");
  }
});
app.get("*", async (c, next) => {
  if (c.req.path.startsWith("/rest") || c.req.path.startsWith("/api") || c.req.path === "/ping") return next();
  // A missing hashed asset means the client is running a stale index.html.
  // Falling through to the SPA shell would answer a .js request with HTML and
  // surface as an opaque MIME error, so fail loudly with a 404 instead.
  if (c.req.path.startsWith("/assets/")) return c.notFound();
  // Serve real static files first (e.g. /favicon.svg), then fall back to the
  // SPA shell so client-side routes like /songs still render index.html.
  // (Pre-check with fs: serveStatic's own "not found" path calls next(), which
  // finalizes a 404 response that the subsequent fallback can no longer override.)
  const rel = decodeURIComponent(c.req.path).replace(/^\/+/, "");
  const filePath = path.resolve(staticDir, rel);
  const inside = filePath === staticDir || filePath.startsWith(staticDir + path.sep);
  if (rel && inside && fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
    return serveStatic({ root: staticDir })(c, next);
  }
  return serveStatic({ path: "index.html", root: staticDir })(c, next);
});

// Plugins first (pure, in-memory), then the schema. initDatabase() fires the
// db-ready hook that seeds a `plugins` row for anything registered above, so the
// order here is what makes built-ins show up in the admin Plugins page.
registerBuiltinPlugins();
initDatabase();
backfillGenres();

// Seed the official plugin registry once, so a fresh install has a working
// marketplace without an admin pasting the URL by hand. Called here (not via the
// db-ready hook in builtins.ts) because builtins -> registryCatalog would close
// the cycle builtins -> registryCatalog -> discovery -> builtins.
seedDefaultRegistry();

// Phase 3: scan data/plugins for drop-in plugins, validate + register them, and
// seed their rows (DB is already ready, so the re-seed only adds the new ids).
await discoverExternalPlugins(APP_VERSION);

// Phase 6: watch data/plugins for file changes and hot-reload external plugins
// (no restart needed when an admin edits a drop-in plugin).
startPluginHotReload();

// Retention cleanup for play history (play_history grows with every play).
cleanupPlayHistory(getPlayHistoryRetentionDays());

// ==================== Daily sync scheduler ====================
// 每天在**可配置的具体时刻**触发一次全量同步管线(settings.daily_recommend_time
// = "HH:MM",默认 03:00;旧版整点配置 daily_recommend_hour 仍兼容)。
// 调度实现(setTimeout 递归 + 改配置即时 re-arm)见 services/dailyScheduler.ts。
//
// 到点跑什么:runBatchJob("daily-jobs")——内置/外置推荐插件的 runDailyJob +
// 组合歌单 + 平台推荐同步 + 网页歌清理(见 batch/jobs.ts)。**每个插件是否参与
// 由它自己的配置决定**(scheduleEnabled,默认开),不再是全局一把梭。
setDailyRunner(async () => {
  try {
    await runBatchJob("daily-jobs", {});
  } catch (e: any) {
    log.error("[DAILY-SCHEDULER] daily job error", { err: e.message || e });
  }
  // 原 6h 维护循环取消:歌单同步+歌手刮削+历史清理改为「每天定点任务完成后」执行一次。
  await runMaintenanceOnce();
});
startDailyScheduler();
log.info(`[DAILY-SCHEDULER] 每日同步时刻: ${formatDailyTime()}`);

// 启动补拉:原先「只要总开关开就无条件全量跑一次」,改为 boot-sync——
// 只跑把「容器启动时拉取一次」(runOnBoot)显式打开的插件,**默认一个都不跑**。
if (getDailyMasterEnabled()) {
  (async () => {
    try {
      const r: any = await runBatchJob("boot-sync", {});
      log.info(`[BOOT-SYNC] ${r?.ran ?? 0} 个插件已补拉,${r?.skipped ?? 0} 个按配置跳过`);
    } catch (e: any) {
      log.error("[BOOT-SYNC] boot sync error", { err: e?.message || e });
    }
  })();
}

// 「随机歌曲」固定歌单后台自动刷新:按插件配置 refreshMinutes(默认 30 分钟)
// 自适应循环触发;配合 getPlaylist 的惰性刷新,保证客户端/前端随时取到已备好的歌单。
startRandomSongsAutoRefresh();

// ==================== Maintenance (按每天定点任务后执行一次) ====================
// 原 6h 独立定时循环取消:歌单自动同步(playlistSync.runSyncJob)+ 新歌手刮削 + 播放历史
// 清理,统一放在每天定点任务完成后执行一次。playlistSync 等跑在一次性批量子进程里
// (方案3),全局批量闸由 runBatchJob 持有,不阻塞主进程事件循环/内存。
async function runMaintenanceOnce() {
  // play_history 保留期清理留在主进程(单条 DELETE,不构成内存峰)。
  // 单独 try/catch:任何异常都不能中断定时器 re-arm 链(见 services/dailyScheduler.ts)。
  try {
    cleanupPlayHistory(getPlayHistoryRetentionDays());
  } catch (e: any) {
    log.error("[AUTO-SYNC] history cleanup error", { err: e?.message || e });
  }
  try {
    await runBatchJob("maintenance", {});
  } catch (e: any) {
    log.error("[AUTO-SYNC] maintenance error", { err: e.message || e });
  }
}

// ==================== DLNA background discovery ====================
// Keep the device cache warm so the cast dialog can show devices instantly
// without making the user wait for a fresh SSDP sweep every time. Runs once
// shortly after boot (give the network stack a moment) then every 5 min.
// After each refresh, register newly discovered devices with QueueController
// so they have a UniversalPlayer + DLNA ProtocolPlayer bound for playback.
const DLNA_SCAN_INTERVAL = 5 * 60 * 1000;
async function refreshAndRegisterDevices(): Promise<void> {
  try {
    await refreshDevices();
    for (const d of getCachedDevices()) {
      // 只给在线设备注册播放器;离线设备仅展示(不绑定 UniversalPlayer)。
      if (d.available) getQueueController().registerDlnaDevice(d.id, d.name);
    }
  } catch { /* discovery failures are non-fatal */ }
}
// 先恢复持久化的设备记录(离线设备也在列表,用户可手动管理),再启动发现扫描。
loadPersistedDevices();
setTimeout(() => {
  refreshAndRegisterDevices();
  setInterval(() => { refreshAndRegisterDevices(); }, DLNA_SCAN_INTERVAL);
}, 8000);

// 实时 SSDP:设备一上线/下线立即更新缓存并广播 device_list_changed
// (-> peer reconcile -> WS peer_registered/available 推送),卡片/Web 即时看到。
wireSsdpRealtime();
// 新发现的设备即时注册 QueueController(幂等),上线即可播,不必等下一轮扫描。
getEventManager().on("device_list_changed", () => {
  for (const d of getCachedDevices()) {
    if (d.available) getQueueController().registerDlnaDevice(d.id, d.name);
  }
});

// ==================== AirPlay (RAOP) renderer ====================
// Built-in -> mDNS discovery of _raop._tcp receivers + real-time queue registration.
// AirPlay devices register as "airplay:<id>" players in QueueController exactly
// like DLNA devices, so queue/transport/restore all flow through the unified
// controller; the DLNA chain is untouched (we only read DLNA's exported
// createCastSession for stream URLs).
import { startAirPlayService, wireAirPlayPersistence, loadPersistedAirPlayDevices, isAirPlayDeviceDisabled, isAirPlayEnabled } from "./services/airplay/control.js";
import { getAirPlayDevices, onAirPlayEvent } from "./services/airplay/discovery.js";
// AirPlay 渲染器插件默认关闭(插件管理页开关):开启才启动 mDNS 服务与设备注册,
// 关闭时零常驻资源(无网络监听/定时器/会话/peer/player)。
if (isAirPlayEnabled()) {
  startAirPlayService();
  wireAirPlayPersistence();
  loadPersistedAirPlayDevices();
  onAirPlayEvent((e) => {
    if (e.type === "alive" && !isAirPlayDeviceDisabled(e.device.id)) {
      getQueueController().registerAirPlayDevice(e.device.id, (e.device.alias || e.device.name).trim());
    }
  });
  // 启动时把已发现的设备注册上(等侦测到 mDNS 结果后即可播)。
  for (const d of getAirPlayDevices()) {
    if (d.available) getQueueController().registerAirPlayDevice(d.id, (d.alias || d.name).trim());
  }
}

const port = parseInt(process.env.PORT || "46400", 10);

// ==================== HA integration: WebSocket + mDNS + queue auto-next ====================
// We run Hono on a manually-created http.Server (instead of serve()'s built-in
// one) so we can attach a WebSocket upgrade handler. @hono/node-server's
// `serve()` doesn't expose the underlying server in a stable way, but it
// accepts an `override.fetch` hook — here we just bypass it and use the
// adaptor's request handler directly.
import { initWebSocketServer } from "./services/ws/index.js";
import { startMdnsBroadcast, stopMdnsBroadcast } from "./services/discovery/mdns.js";
import { getQueueController, wirePlayerQueueControllers } from "./services/player/index.js";
import { getCachedDevices } from "./services/dlna/control.js";
import { getEventManager } from "./services/dlna/eventing.js";
import { getPeerManager } from "./services/peer.js";
import { getGroupManager } from "./services/group/index.js";
import { startGroupWatchdog } from "./services/group/watchdog.js";
import { startIdleReclaimer } from "./services/memory/reclaim.js";
import { startOrphanPruner } from "./services/memory/pruneOrphans.js";

const server = createServer(getRequestListener(app.fetch));

initWebSocketServer(server);

// Load persisted device queues from DB so cast state survives backend restart.
getQueueController().loadFromDb();

// Load persisted player groups (SyncGroup) from DB. Group queue restore +
// playback fan-out land in phase 2 together with the group protocol player.
getGroupManager().loadFromDb();
// Register group players (QueueController) + group peers (PeerManager) so the
// UI can switch to a group and its queue can resume playback after restart.
for (const g of getGroupManager().list()) {
  getQueueController().registerGroupPlayer(g.id, g.name);
}
getPeerManager().reconcileGroupPeers();
// 组创建/改名/删除 → 注册组 player + 刷新组 peer 列表(前端经 WS group_changed 刷新)。
getGroupManager().on("group_created", (g) => {
  getQueueController().registerGroupPlayer(g.id, g.name);
  getPeerManager().reconcileGroupPeers();
});
getGroupManager().on("group_updated", () => {
  getPeerManager().reconcileGroupPeers();
});
getGroupManager().on("group_deleted", (id) => {
  getPeerManager().removeGroup(id);
});

// 组离线 watchdog:全部成员离线时保留队列,成员回归后自动恢复播放(10s 巡检)。
startGroupWatchdog();

// Start the unified peer manager: registers DLNA peers from discovery, runs
// the 10-min inactivity cleanup for stale local + offline dlna peers.
getPeerManager().startCleanup();

// 接线:PlayerController 决策 → QueueController 切歌。对照 MA 上层控制器链路。
// GENA 事件(plying→stopped)上报给 PlayerController,经双层去抖 + 状态迁移判断后,
// 由 QueueController 决定是否切歌(替代原 track_ended 直推)。
wirePlayerQueueControllers();

// Fallback poll:对照 MA force_poll,GENA 不可用时主动 poll 设备状态上报 PlayerController。
// 由 QueueController 持有轮询,间隔 5s(MA 是 30s,本地设备事件支持差,用 5s 平衡)。
getQueueController().startPollLoop(() => getEffectiveBaseUrl());

// 空闲内存自动回收:无播放活动且无批量任务(导入/同步/扫描等)时,自动清理
// 可重建缓存 + 主动 GC + SQLite WAL checkpoint。60s 检查一轮,幂等启动。
startIdleReclaimer();

// 定期孤儿清理:以设备表+组表+用户表为合法集合,清理各模块「只增不删」Map 的
// 残留 key(asyncTasks/eventing/QueueController/PlayerController/proxy/scrobblers)。
// 10 分钟一轮,启动 1 分钟后先跑首轮。与空闲回收互补(不依赖空闲)。
startOrphanPruner();

server.listen(port, "0.0.0.0", () => {
  log.info(`MusicFlow backend listening on http://0.0.0.0:${port}`);
  // Broadcast via mDNS so the HA integration can auto-discover this instance.
  startMdnsBroadcast(port);
  // Resume active queues after a short delay so SSDP discovery has time to
  // populate the device cache — resumeActive() needs the device to be known.
  // Best-effort: if the device is offline, the resume silently no-ops.
  setTimeout(() => {
    const baseUrl = getEffectiveBaseUrl();
    // Register any devices already in the cache (discovery may have run
    // before this callback fires) so resumeActive can find their player.
    for (const d of getCachedDevices()) {
      getQueueController().registerDlnaDevice(d.id, d.name);
    }
    const active = getQueueController().activeDevices();
    if (active.length === 0) return;
    log.info(`[queue] resuming ${active.length} active device queue(s) after restart`);
    for (const { deviceId } of active) {
      getQueueController().resumeActive(deviceId, baseUrl).catch((e) => {
        console.warn(`[queue] resume failed for ${deviceId}:`, e?.message || e);
      });
    }
  }, 10000);
});

// Clean shutdown: stop mDNS so the service record disappears promptly.
process.on("SIGTERM", () => { stopMdnsBroadcast(); server.close(); });
process.on("SIGINT", () => { stopMdnsBroadcast(); server.close(); });
