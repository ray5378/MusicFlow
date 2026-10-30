import { getRequestListener } from "@hono/node-server";
import { createServer } from "http";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { compress } from "hono/compress";
import { metricsMiddleware } from "./middleware/metrics.js";
import { createLogger, runWithTrace } from "./utils/logger.js";
import { randomBytes } from "node:crypto";

const log = createLogger("INDEX");

import fs from "fs";
import path from "path";
import { serveStatic } from "@hono/node-server/serve-static";
import { authRoutes } from "./routes/auth/index.js";
import { restRoutes, startFfmpegReconciler } from "./routes/rest/index.js";
import { apiRoutes, getDlnaBaseUrl } from "./routes/api/index.js";
import { navidromeRoutes } from "./routes/navidrome/index.js";
import { getFlow, executeFlow, isFlowRunning } from "./services/flows/index.js";
import {
  validatePlayerWebhookToken, listPlayerWebhookTokens, getPlayerWebhookTokenById,
  resolvePlayerDevicePeers, handlePlayerWebhook,
} from "./services/player/playerWebhook.js";
import { initDatabase, cleanupPlayHistory, sqlite, backfillGenres } from "./db/index.js";
import { applyLogLevelFromSettings } from "./services/logSettings.js";
import { authMiddleware } from "./middleware/auth.js";
import { isRestAuthExemptPath } from "./middleware/restExempt.js";
import { registerBuiltinPlugins } from "./plugins/builtins.js";
import { discoverExternalPlugins } from "./plugins/discovery.js";
import { startPluginHotReload } from "./plugins/hotReload.js";
import { seedDefaultRegistry } from "./plugins/registryCatalog.js";
import { refreshDevices, getEffectiveBaseUrl, wireSsdpRealtime, loadPersistedDevices, setRuntimePort } from "./services/dlna/control.js";
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

// 请求级追踪 id:API/webhook 请求生成一个短 id 放进 AsyncLocalStorage,
// debug 日志自动附加 `tid=`(见 utils/logger.ts)。排查「一次拖动进度条」这类
// 多层级联问题时,HTTP 入口 / QueueController / DLNA SOAP / sendspin 各层的
// 日志能被同一个 tid 串起来。静态资源不生成(无排障价值,纯噪音)。
app.use("*", async (c, next) => {
  const p = c.req.path;
  const traced = p.startsWith("/rest") || p.startsWith("/api")
    || p.startsWith("/webhooks/") || p === "/webhook/player";
  if (!traced) return next();
  return runWithTrace(randomBytes(4).toString("hex"), () => next());
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
  //  - airplay/stream/:token(2026-10-20 修复):由**本机 ffmpeg 解码器**回环
  //    拉取(services/airplay/control.ts 经 resolvePipelineInput 包装),同样带不上
  //    鉴权头;信任模型与 dlna/stream/:token 完全一致 —— 短时效会话 token 由
  //    /rest/airplay/stream/:token 的 handler 自校验(失败 403)。此前清单漏了这一项,
  //    内部取流被自家鉴权拦成 401 → ffmpeg 拿 0 字节 → 设备全程收不到 RTP,
  //    用户可见症状就是「AirPlay1 连不上设备」(实测 HiVi H5MKII)。
  //  - membuf/:token(batch44):整曲内存缓冲的回环取流端,16 字节随机 token,
  //    信任模型与 dlna/stream/:token 相同(仅本机回环消费,token 即凭证)。
  // getCoverArt 曾在此放行(封面 <img> 带不上请求头),但 OpenSubsonic 规范要求
  // 其鉴权,前端已在封面 URL 上附加 ?token= 查询参数,故改走 authMiddleware。
  // 判定口径与清单见 middleware/restExempt.ts(c.req.path 是完整路径,含 /rest 前缀)。
  if (isRestAuthExemptPath(c.req.path)) return next();
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
// 日志等级:设置表里的 log.level 覆盖 env/默认(库就绪后立刻应用,后续保存即时生效)。
// 排障时前端「设置 → 日志等级」切 debug,无需重启容器。
applyLogLevelFromSettings();
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

import { DLNA_SCAN_INTERVAL_MS } from "./services/dlna/scanPolicy.js";
import { startUpgradeScheduler } from "./services/fetch/upgradeScheduler.js";
import { startLibraryScheduler } from "./services/fetch/libraryScheduler.js";
import { registerFetchImportTrigger } from "./services/fetch/importTrigger.js";
import { startTagRepairScheduler, resumeInterruptedTagRepair, TAG_REPAIR_RESUME_DELAY_MS } from "./services/fetch/tagRepair.js";
import { startScanScheduler } from "./services/source/scanScheduler.js";
import { startStreamProbeScheduler } from "./services/source/streamProbe.js";
import { ensureDownloadSource } from "./services/fetch/source.js";
import { resumeInterruptedFetchJobs, BOOT_RESUME_DELAY_MS } from "./services/fetch/jobRunner.js";
import { currentFetchConfig } from "./services/fetch/configStore.js";
import { cleanCacheRootContents, ensureWritableDir } from "./services/fetch/writable.js";

// ==================== DLNA background discovery ====================
// Keep the device cache warm so the cast dialog can show devices instantly
// without making the user wait for a fresh SSDP sweep every time. Runs once
// shortly after boot (give the network stack a moment) then every 90s.
// After each refresh, register newly discovered devices with QueueController
// so they have a UniversalPlayer + DLNA ProtocolPlayer bound for playback.
//
// 90s（原 5 分钟）：主动扫描是「设备不发 SSDP 通告」时的唯一兜底 —— 典型场景是第三方
// App（音流等）把**已开机**的 DLNA 设备直接拉起来播放，设备自身不会再广播 ssdp:alive，
// 只能靠扫描发现。旧的 5 分钟间隔让用户「歌都放半天了，列表里还没有这台设备」。
// 家宽 LAN 上一轮 M-SEARCH + 每设备一次 description 抓取的代价可以忽略。
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
  setInterval(() => { refreshAndRegisterDevices(); }, DLNA_SCAN_INTERVAL_MS);
}, 8000);

// 实时 SSDP:设备一上线/下线立即更新缓存并广播 device_list_changed
// (-> peer reconcile -> WS peer_registered/available 推送),卡片/Web 即时看到。
wireSsdpRealtime();

// 定时自动洗版（默认关闭；开启后按 upgradeAutoIntervalDays / upgradeAutoTimeOfDay 触发）。
startUpgradeScheduler();
startLibraryScheduler();
startScanScheduler();
// 起播 TTFB 金丝雀探针调度(默认关;用户在「媒体获取」页开启后才按间隔探,
// 见 services/source/streamProbe.ts 头部)。tick 本身极轻(一次 settings 读),
// 未开启时零开销。
startStreamProbeScheduler();
// 标签缺失修复调度（2026-10-11）：事件队列（下载终态入队、退避重试）+ 每周全量兜底扫。
startTagRepairScheduler();
// 入库即入队（产品定调 2026-10-11，最根本的一条）：**任何**入库的网络歌曲都必须过一轮
// 下载流程。钩子挂在唯一的平台歌曲落库收口点 importOnlineSongs 上（注册制，见
// services/source/online/importTriggerHook.ts）。本挂载点必须保留 ——
// CI 守卫 scripts/check-import-trigger.mjs 会钉死它，防重构时静默拆掉。
registerFetchImportTrigger();
// 两个下载源显示名归一（产品定调 2026-10-10）+ 目录自动生成：
//   downloadRoot → 已下载流媒体音质；losslessRoot（洗版成品根）→ 已下载无损音质。
try {
  const bootCfg = currentFetchConfig();
  ensureDownloadSource(bootCfg.downloadRoot, "已下载流媒体音质");
  ensureDownloadSource(bootCfg.losslessRoot, "已下载无损音质");
} catch { /* 目录不可达时忽略——首次扫描/下载会再 ensure */ }

// 启动恢复（PATCH19）：上一进程遗留的 pending/running fetch 任务**自动续跑**（不再落
// failed 作废）。断点续跑让重跑只处理未完成项；全终态任务首片自然落终态。
//
// 但**不在启动瞬间**跑（2026-10-15 起）：容器刚起来时 entrypoint 收尾、外置插件装配、
// 首批请求都在抢宿主 CPU，而一次续批会立刻拉起批量子进程 + 4 路 ffmpeg 转码（生产实测
// 容器 CPU 419%~534%、宿主 8 核 load 15，转码闸排队最长 64.7s），表现为「刚启动就卡」。
// 延后 BOOT_RESUME_DELAY_MS 让启动路径先走完；期间遗留任务行保持 pending/running 不动，
// libraryScheduler 的 busy 判定会照常跳过，不会重复起批。
setTimeout(() => {
  try {
    const resumed = resumeInterruptedFetchJobs();
    if (resumed > 0) log.info(`[FETCH] boot 恢复：${resumed} 个中断任务已重新入队续跑`);
  } catch (e: any) {
    log.error(`[FETCH] boot 恢复失败: ${e?.message || e}`);
  }
}, BOOT_RESUME_DELAY_MS);

// 标签修复启动恢复（2026-10-18）：上一进程遗留的「进行中一轮标签修复」按快照断点续跑
// （全量扫动辄数千首、单轮可跑数小时；进程被杀/重启时半轮的 pendingIds 与计数已随
// checkpoint 落盘，这里从断点接着跑，不重头再扫一遍）。同样延后 TAG_REPAIR_RESUME_DELAY_MS
// 避开启动瞬间的 CPU 抢跑；被用户主动停止（stopped=true）的快照不复活。
setTimeout(() => {
  try {
    const r = resumeInterruptedTagRepair();
    if (r.resumed) log.info(`[TAG-REPAIR] boot 恢复：续跑进行中的${r.mode}一轮标签修复`);
  } catch (e: any) { log.error(`[TAG-REPAIR] boot 恢复失败: ${e?.message || e}`); }
}, TAG_REPAIR_RESUME_DELAY_MS);

// 写目录启动探针 + 缓存清空：挂载权限配错第一时间在日志给出修复指引；
// 缓存目录内容（上次进程遗留的下载子目录 / .part 半成品）整目录清空（不碰成品目录）。
try {
  const fetchCfg = currentFetchConfig();
  const cleanedCache = cleanCacheRootContents(fetchCfg.cacheRoot, fetchCfg.downloadRoot);
  if (cleanedCache > 0) log.info(`[FETCH] boot：已清空缓存目录 ${fetchCfg.cacheRoot} 内容（${cleanedCache} 项）`);
  // boot 预检覆盖全部配置根（PATCH14）：losslessRoot（洗版落盘根）一并探，
  // 挂载属主配错第一时间在启动日志给出修复指引（自适应修复这里就会顺手修好）。
  for (const dir of [fetchCfg.downloadRoot, fetchCfg.cacheRoot, fetchCfg.losslessRoot]) {
    ensureWritableDir(dir, { fresh: true });
  }
} catch (e: any) {
  log.error(`[FETCH-WRITABLE] ${e?.message || e}`);
}
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
import { getAirPlayDevices, getAirPlayDevice, onAirPlayEvent } from "./services/airplay/discovery.js";
import { splitGroupMembers, startBridgeRouteReconciler } from "./services/group/protocolPlayer.js";
import { scheduleBootClearProbes } from "./services/airplay/raopProbe.js";
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
  // S3(2026-10-30 全屋 HiVi 无声事故):容器重启后 MUZO 固件保留对旧容器的半开
  // RTSP 会话,新握手 ANNOUNCE 即 ECONNRESET,唯一救法曾是人工 stop→等 10s→play。
  // boot 后 12s 对每台已知 AirPlay 设备各发一次 blind TEARDOWN 探测(持久化清单
  // 启动即恢复,不等 mDNS;45s 兜底轮覆盖 mDNS 迟到的设备),把僵死态在用户起播前
  // 清掉。探测幂等,454 无害。
  scheduleBootClearProbes();
}

// ==================== Sendspin (server role) renderer ====================
// Sendspin 渲染器插件默认关闭:开启才实例化 SendspinServer 并注册客户端播放器;
// 关闭时零常驻资源。与 DLNA/AirPlay 同为服务器权威播放器(QueueController 统一队列)。
import { startSendspinService, stopSendspinService, isSendspinEnabled } from "./services/sendspin/index.js";
if (isSendspinEnabled()) {
  startSendspinService().catch((e) =>
    log.error("[sendspin] start failed", { err: (e as Error)?.message || e }),
  );
}
// 进程退出时收敛(测试/前端宿主进程优雅关闭),避免残留连接与组。
process.once("beforeExit", () => {
  if (isSendspinEnabled()) void stopSendspinService();
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
import { getPlayerController, getQueueController, wirePlayerQueueControllers } from "./services/player/index.js";
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

// PLAYING 期本地节拍:对照 MA _poll_players 的 0.5s 推送。设备采样(上面 5s)只负责
// 纠偏,结束判定不该被采样粒度拖慢 —— 否则"唱完还停着"要等 ~10s 才切歌。
getPlayerController().startOverrunTicker();

// 空闲内存自动回收:无播放活动且无批量任务(导入/同步/扫描等)时,自动清理
// 可重建缓存 + 主动 GC + SQLite WAL checkpoint。60s 检查一轮,幂等启动。
startIdleReclaimer();

// 定期孤儿清理:以设备表+组表+用户表为合法集合,清理各模块「只增不删」Map 的
// 残留 key(asyncTasks/eventing/QueueController/PlayerController/proxy/scrobblers)。
// 10 分钟一轮,启动 1 分钟后先跑首轮。与空闲回收互补(不依赖空闲)。
startOrphanPruner();

// ffmpeg 出流看门狗:周期对账在途转码进程,回收「既不产字节也不退出」的僵死 ffmpeg
// (先于 kill 联动失效的场景,如上游源卡住)。30s 一轮,幂等启动,不做启动对账。

startFfmpegReconciler();

// 桥路由对账(改法4):60s 周期「检测+摘除+warn」,收敛单侧孤儿(泵侧句柄/会话侧
// token 与主进程路由登记不符)。幂等启动;第一版不做 rebuild 自动重建(触发条件单独评审)。
startBridgeRouteReconciler();

/** 解析队列 key(裸设备 id 或裸组 id)所落物理接收端的 host(IP/主机名)。
 *  仅供重启恢复的 per-host 互斥使用。
 *
 *  粒度论证(为何取 host 而非 device id):同一物理接收端可能以多个 profile 同时
 *  暴露 —— 同一主机可双栈注册 AirPlay+DLNA(两个不同 deviceId),甚至同协议多
 *  profile;按 device id 互斥时,两把僵尸队列可各占一个 profile id,继续争抢同一
 *  台物理设备的音频输出管线(互抢正是本闸要断的病灶),互斥形同虚设。音频输出
 *  的争用单元是物理 host,故互斥粒度取 host。
 *
 *  Fail-open 约定:无法稳定定位物理 host 一律返回 null(sendspin 前端无稳定
 *  物理 host;发现/缓存表未命中),该队列不参与互斥、按原路径恢复 —— 宁可
 *  漏拦,不可误杀唯一恢复路径。 */
function receiverHostOf(deviceId: string): string | null {
  try {
    // 组队列:成员按 kind 拆分(三类全空 = 非组 id),取第一个可解析成员的 host
    const gm = splitGroupMembers(deviceId);
    if (gm.dlna.length || gm.airplay.length || gm.spin.length) {
      for (const mid of gm.airplay) {
        const ap = getAirPlayDevice(mid);
        if (ap?.host) return ap.host;
      }
      for (const mid of gm.dlna) {
        const dd = getCachedDevices().find((x) => x.id === mid);
        if (dd?.location) {
          try { return new URL(dd.location).hostname; } catch { /* 尝试下一成员 */ }
        }
      }
      return null; // 纯 sendspin 组 / 成员 host 全不可解析 → fail-open
    }
  } catch { /* 组表不可用或 id 异常 → 按单设备路径继续尝试 */ }
  // 单设备队列:AirPlay 优先(host 字段最直接),DLNA 取 description.xml 主机名
  const ap = getAirPlayDevice(deviceId);
  if (ap?.host) return ap.host;
  const dd = getCachedDevices().find((x) => x.id === deviceId);
  if (dd?.location) {
    try { return new URL(dd.location).hostname; } catch { return null; }
  }
  return null;
}

server.listen(port, "0.0.0.0", () => {
  log.info(`MusicFlow backend listening on http://0.0.0.0:${port}`);
  setRuntimePort(port); // 回环取流(loopbackBase)按实际端口打
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
    // per-host 恢复互斥:先统计各 host 的 active 队列总数(warn 行可见性不依赖
    // 迭代顺序),再按序认领 —— 同一物理 host 只放行第一把队列,其余挂起。
    // 这是重启后「僵尸队列互相抢占」病灶的入口闸:旧脏队列与当前合法队列同
    // host 并存时,只放行一把继续恢复。挂起 ≠ 删除:用户显式恢复走正常路径。
    const hostCount = new Map<string, number>();
    for (const { deviceId } of active) {
      const rHost = receiverHostOf(deviceId);
      if (rHost) hostCount.set(rHost, (hostCount.get(rHost) ?? 0) + 1);
    }
    const claimed = new Set<string>();
    for (const { deviceId } of active) {
      const rHost = receiverHostOf(deviceId);
      if (rHost) {
        if (claimed.has(rHost)) {
          log.warn(`[queue] zombie queue suspended: host=${rHost} queue=${deviceId} activeQueuesOnHost=${hostCount.get(rHost)} (per-host resume mutex;显式恢复走正常路径)`);
          continue;
        }
        claimed.add(rHost);
      }
      // host 不可解析(sendspin 前端/缓存未命中)→ fail-open,按原路径恢复
      getQueueController().resumeActive(deviceId, baseUrl).catch((e) => {
        console.warn(`[queue] resume failed for ${deviceId}:`, e?.message || e);
      });
    }
  }, 10000);
});

// Clean shutdown: stop mDNS so the service record disappears promptly.
//
// v4.10.0(根因):**退出前必须先把 RAOP/桥会话 TEARDOWN 掉**。设备(MUZO)对
// 「服务器突然消失」不做清理,接收端会挂在死会话上;新进程起来后 ANNOUNCE/
// SETUP/RECORD 虽返回 200,但设备不切会话 ⇒ 不出声、不发 timing,只能靠显式
// TEARDOWN 才重置(2026-10-29 12:12 实证,静音 10 分钟、服务端照推 3 条流)。
let shuttingDown = false;
async function gracefulShutdown(sig: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  try { console.log(`[boot] ${sig}: stop mDNS + TEARDOWN all airplay sessions`); } catch { /* ignore */ }
  try { stopMdnsBroadcast(); } catch { /* ignore */ }
  // ⚠️ v4.10.0 实测修正(2026-10-29 20:54 抓包实证):调 stopAirPlayService() **发不出 TEARDOWN**。
  //    tcpdump tcp/4515 显示重启时只有 ANNOUNCE/SETUP/RECORD,TEARDOWN = 0。原因链:
  //      supervisor.stop() → rpc("stop") → 子进程 dispatch 无 "stop" 分支 ⇒ 未知 op 抛错
  //      ⇒ 捕获后直接 killChild("SIGKILL");而真正停桥会话的 onStop() 在 ChildRpcHost 里
  //      **从未被调用**(handleMessage 只处理 t==="req")。于是桥会话随进程一起被砍,没有 TEARDOWN。
  //    改为走「组/端级 transport stop」——这是真机上被反复验证会下发 TEARDOWN 的同一条路
  //    (用户点停止 / 组级 stop 后设备立刻能重新接管)。
  try {
    const { getPeerManager } = await import("./services/peer.js");
    const { getQueueController } = await import("./services/player/index.js");
    const qc = getQueueController();
    const cast = getPeerManager()
      .list()
      .filter((p) => /^(group|airplay|dlna|sendspin):/.test(String(p.peerId)));
    for (const p of cast) {
      try {
        qc.stopPlayback(String(p.peerId));
      } catch { /* 单端失败不影响其它端 */ }
    }
    await Promise.race([
      Promise.allSettled(cast.map((p) => qc.transport(String(p.peerId), "stop"))),
      new Promise((r) => setTimeout(r, 4000)),
    ]);
  } catch { /* 停传输失败也要继续退出 */ }
  try { server.close(); } catch { /* ignore */ }
  setTimeout(() => process.exit(0), 800).unref?.();
}
process.on("SIGTERM", () => { void gracefulShutdown("SIGTERM"); });
process.on("SIGINT", () => { void gracefulShutdown("SIGINT"); });
