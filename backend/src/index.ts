import { getRequestListener } from "@hono/node-server";
import { createServer } from "http";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { compress } from "hono/compress";
import fs from "fs";
import path from "path";
import { serveStatic } from "@hono/node-server/serve-static";
import { authRoutes } from "./routes/auth/index.js";
import { restRoutes } from "./routes/rest/index.js";
import { apiRoutes, getDlnaBaseUrl } from "./routes/api/index.js";
import { navidromeRoutes } from "./routes/navidrome/index.js";
import { getFlowByToken, executeFlow, isFlowRunning } from "./services/flows/index.js";
import {
  validatePlayerWebhookToken, listPlayerWebhookTokens,
  resolvePlayerDevicePeers, handlePlayerWebhook,
} from "./services/player/playerWebhook.js";
import { initDatabase, cleanupPlayHistory, sqlite, backfillGenres } from "./db/index.js";
import { authMiddleware } from "./middleware/auth.js";
import { syncAllRecommendPlaylists } from "./services/source/online/recommendImport.js";
import { purgeExpiredWebSongs } from "./services/source/online/purge.js";
import { getEnabledSourcePlugins, getEnabledByCapability } from "./plugins/registry.js";
import { registerBuiltinPlugins } from "./plugins/builtins.js";
import { discoverExternalPlugins } from "./plugins/discovery.js";
import { scrapeArtistList } from "./services/scraper/artist.js";
import { refreshDevices, getEffectiveBaseUrl, wireSsdpRealtime, loadPersistedDevices } from "./services/dlna/control.js";
import { db } from "./db/index.js";
import { artists } from "./db/schema.js";
import { getCorsOrigins, getPlayHistoryRetentionDays } from "./utils/env.js";

const app = new Hono();

// Log only what's useful: auth failures get a readable Chinese hint, real
// server errors (5xx) keep a bare record; everything else stays quiet.
app.use("*", async (c, next) => {
  await next();
  const status = c.res.status;
  const ts = new Date().toLocaleString("zh-CN", { hour12: false });
  if (status === 401) {
    console.log(`[${ts}] 认证失败,请检查账号密码: ${c.req.method} ${c.req.path}`);
  } else if (status >= 500) {
    console.log(`[${ts}] ${c.req.method} ${c.req.path} -> ${status}`);
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

app.route("/rest", authRoutes);
// Baked in at image build time (Dockerfile ARG APP_VERSION / APP_COMMIT, fed by
// CI from the git tag / commit). "dev" / "" means a local/unversioned build.
const APP_VERSION = process.env.APP_VERSION || "dev";
const APP_COMMIT = process.env.APP_COMMIT || "";

app.get("/rest/ping", (c) => c.json({ "subsonic-response": { status: "ok", version: "1.16.1", serverVersion: APP_VERSION, openSubsonic: true, type: "MusicFlow" } }));

app.use("/rest/*", async (c, next) => {
  // Public endpoints under /rest/* that cannot send auth headers:
  //  - getCoverArt: loaded via <img> tags
  //  - dlna/stream/:token: pulled by DLNA renderers (TVs, speakers) which
  //    have no way to authenticate; access is gated by a short-lived cast
  //    token that maps to a songId inside the route handler itself.
  const p = c.req.path;
  // c.req.path 是完整路径(含 /rest 前缀),所以用 includes/endsWith 匹配
  if (p === "/getCoverArt" || p.endsWith("/getCoverArt")) return next();
  if (p.includes("/dlna/stream/")) return next();
  return authMiddleware(c, next);
});
app.route("/rest", restRoutes);
app.use("/rest/api/*", authMiddleware);
app.route("/rest/api", apiRoutes);
app.use("/api/*", authMiddleware);
app.route("/api", navidromeRoutes);
app.get("/ping", (c) => c.json({ status: "ok", version: APP_VERSION, commit: APP_COMMIT }));

// ==================== 音流 Webhook(免鉴权,凭 token 触发) ====================
// 注册在 /rest、/api 鉴权中间件之外,外部工具(GET 或 POST)直接打开链接即可触发:
// 后台异步持续扫描 DLNA → 任一目标设备/组上线后依次 设音量 → 播放模式 → 播歌单。
app.all("/webhooks/flows/:token", async (c) => {
  const token = c.req.param("token") || "";
  const flow = getFlowByToken(token);
  if (!flow) return c.json({ success: false, error: "无效的 webhook token" }, 404);
  if (!flow.enabled) return c.json({ success: false, error: "该音流已停用" }, 409);
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
    return c.json({ success: false, error: "缺少 token 参数" }, 401);
  }
  const auth = validatePlayerWebhookToken(flat.token);
  if (!auth) {
    const t = listPlayerWebhookTokens();
    if (t.some(x => x.token === flat.token)) return c.json({ success: false, error: "该渠道 token 已停用" }, 403);
    return c.json({ success: false, error: "无效的 token" }, 401);
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

// Phase 3: scan data/plugins for drop-in plugins, validate + register them, and
// seed their rows (DB is already ready, so the re-seed only adds the new ids).
await discoverExternalPlugins(APP_VERSION);

// Retention cleanup for play history (play_history grows with every play).
cleanupPlayHistory(getPlayHistoryRetentionDays());

// ==================== Daily-recommend scheduler (Plan A + Plan B) ====================
// Runs at a fixed local hour every day (configurable via the `daily_recommend_hour`
// setting). Uses setTimeout-recursive scheduling (not setInterval) so:
//   - restarts recompute the next target time correctly (no drift accumulation)
//   - it can hit a precise wall-clock hour instead of "every N ms"
// On boot we also run a one-shot check: if today's daily playlist is missing
// (e.g. the server was off at the scheduled time), generate it now.
function getDailyHour(): number {
  const row = sqlite.prepare("SELECT value FROM settings WHERE key = ?").get("daily_recommend_hour") as any;
  const h = parseInt(row?.value ?? "3", 10);
  return Number.isFinite(h) && h >= 0 && h <= 23 ? h : 3;
}

function getDailyMasterEnabled(): boolean {
  const row = sqlite.prepare("SELECT value FROM settings WHERE key = ?").get("daily_recommend_enabled") as any;
  const v = row?.value ?? "true";
  return v === "true" || v === "1";
}

async function runDailyJobs() {
  // Master switch gates the combined daily-recommend job (remote + pool + local).
  if (!getDailyMasterEnabled()) return;
  // Every enabled `recommender` plugin builds its own playlist. Core iterates by
  // capability — it doesn't know that "每日推荐" exists, let alone import it.
  for (const { manifest, impl } of getEnabledByCapability("dailyPlaylist")) {
    if (typeof impl?.runDailyJob !== "function") continue;
    try {
      const summary = await impl.runDailyJob();
      if (summary) console.log(`[DAILY-SCHEDULER] ${manifest.id}: ${summary}`);
    } catch (e: any) {
      console.error(`[DAILY-SCHEDULER] ${manifest.id} daily job error:`, e.message || e);
    }
  }
  // Refresh every enabled source plugin that supports daily-recommend playlists
  // and/or web-song rotation. Core iterates by *capability* — no hardcoded
  // provider name.
  for (const { manifest } of getEnabledSourcePlugins()) {
    const caps = manifest.capabilities;
    if (caps.includes("recommend")) {
      try {
        const r = await syncAllRecommendPlaylists(manifest.id, {});
        if (r.synced > 0 || r.failed > 0) {
          console.log(`[DAILY-SCHEDULER] refreshed ${r.synced} ${manifest.id} daily-recommend playlists, errors: ${r.failed}`);
        }
      } catch (e: any) {
        console.error(`[DAILY-SCHEDULER] ${manifest.id} recommend sync error:`, e.message || e);
      }
    }
    if (caps.includes("webRotation")) {
      try {
        const r = purgeExpiredWebSongs(manifest.id);
        if (r.purged > 0 || r.errors > 0) {
          console.log(`[DAILY-SCHEDULER] ${manifest.id} web-song purge: ${r.purged} removed, ${r.covers} covers, errors: ${r.errors}`);
        }
      } catch (e: any) {
        console.error(`[DAILY-SCHEDULER] ${manifest.id} web-song purge error:`, e.message || e);
      }
    }
  }
}

function scheduleNextDailyRun() {
  const hour = getDailyHour();
  const now = new Date();
  const next = new Date(now);
  next.setHours(hour, 0, 0, 0);
  if (next <= now) next.setDate(next.getDate() + 1); // already past today's slot -> tomorrow
  const delay = next.getTime() - now.getTime();
  setTimeout(async () => {
    await runDailyJobs();
    scheduleNextDailyRun(); // re-arm for the next day
  }, delay);
  console.log(`[DAILY-SCHEDULER] next daily-recommend run at ${next.toLocaleString("zh-CN", { hour12: false })} (in ${Math.round(delay / 60000)} min)`);
}

// Boot-time catch-up: if today's daily playlist is missing (server was off at
// the scheduled hour), generate it now. Idempotent — generate*() also checks
// internally, so this is safe to call every boot.
(async () => {
  try {
    await runDailyJobs();
  } catch (e: any) {
    console.error("[DAILY-SCHEDULER] boot catch-up error:", e.message || e);
  }
  scheduleNextDailyRun();
})();

// ==================== Regular maintenance loop (every 6h) ====================
// Re-fetch imported playlists with syncEnabled=true, scrape recent uncovered
// artists, and trim play history. Kept as setInterval because these are not
// time-of-day sensitive and benefit from running shortly after boot too.
const AUTO_SYNC_INTERVAL = 6 * 60 * 60 * 1000; // 6h
setInterval(async () => {
  cleanupPlayHistory(getPlayHistoryRetentionDays());
  // Every enabled `sync` plugin re-syncs what it owns (imported playlists today).
  for (const { manifest, impl } of getEnabledByCapability("playlistSync")) {
    if (typeof impl?.runSyncJob !== "function") continue;
    try {
      const summary = await impl.runSyncJob();
      if (summary) console.log(`[AUTO-SYNC] ${manifest.id}: ${summary}`);
    } catch (e: any) {
      console.error(`[AUTO-SYNC] ${manifest.id} error:`, e.message || e);
    }
  }
  // Auto-scrape artist info for artists added in the last 7 days that still
  // have no cover (QQ first, NetEase fallback). Older artists are left alone
  // unless the user triggers a manual full scrape.
  try {
    const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
    const recent = db.select().from(artists).all()
      .filter(a => !a.coverArt && (a.createdAt || "") >= since);
    if (recent.length > 0) {
      const r = await scrapeArtistList(recent.map(a => a.id));
      console.log(`[ARTIST-SCRAPE] scheduled run: scraped ${r.scraped}, skipped ${r.skipped}, errors ${r.errors.length}`);
    }
  } catch (e: any) {
    console.error("[ARTIST-SCRAPE] error:", e.message);
  }
}, AUTO_SYNC_INTERVAL);

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

server.listen(port, "0.0.0.0", () => {
  console.log(`MusicFree backend listening on http://0.0.0.0:${port}`);
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
    console.log(`[queue] resuming ${active.length} active device queue(s) after restart`);
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
