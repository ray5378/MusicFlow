// 自动生成 —— 由 index.ts 物理拆分而来（settings 域，19 条路由）。零逻辑改动。
import type { Hono } from "hono";
import {
  BusinessErrorCode,
  PLAY_PREFERENCE_PLUGIN_ID,
  adminMiddleware,
  apiError,
  backfillStatus,
  clearStreamFallbackCache,
  createLogger,
  db,
  eq,
  getCoverCacheBytes,
  getLibraryIndexStats,
  getLyricsCacheEntries,
  getMemorySnapshot,
  getReclaimStatus,
  getRenderedCoverBytes,
  getRequestMetrics,
  getSetting,
  getSettingBool,
  getProviderPriority,
  getPrefetchSettings,
  getStreamSourcePriority,
  isBatchBusy,
  isIdle,
  isLogLevel,
  listAvailableStreamSources,
  log,
  logLevelSnapshot,
  PREFETCH_NUM_SPECS,
  plugins,
  preferLocalEnabled,
  reclaimNow,
  saveLogLevel,
  setLyricsCoversSettings,
  setPrefetchSettings,
  setSetting,
  setStreamSourcePriority,
  songs,
  startBackfill,
} from "./shared.js";

export function registerSettings(app: Hono): void {
app.get("/v1/settings", adminMiddleware, (c) => c.json({ writeBackTags: false, fingerprintEnabled: false }));

// 手动触发一轮空闲内存回收(系统设置页「立即回收」按钮)。返回各层回收结果 + 回收前后内存。

app.post("/v1/admin/memory/reclaim", adminMiddleware, (c) => {
  const r = reclaimNow("manual");
  return c.json({ success: true, ...r });
});

// 空闲内存自动回收设置:开关 + 空闲阈值(分钟)。存 settings 表,reclaim 运行时读取。
// 附带实时内存快照与回收状态,供发版后一眼确认内存曲线(只读观测)。

app.get("/v1/admin/memory-settings", adminMiddleware, (c) => {
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

app.put("/v1/admin/memory-settings", adminMiddleware, async (c) => {
  const body = await c.req.json().catch(() => ({}));
  if (typeof body.enabled === "boolean") setSetting("memory_auto_reclaim", String(body.enabled));
  if (Number.isFinite(body.idleMinutes) && (body.idleMinutes as number) >= 1) {
    setSetting("memory_idle_minutes", String(Math.round(body.idleMinutes as number)));
  }
  return c.json({ success: true });
});

// 请求指标:总请求数 / 慢请求数 / 端点调用计数(内存态,重启清零)。

app.get("/v1/admin/metrics", adminMiddleware, (c) => {
  return c.json({ success: true, ...getRequestMetrics() });
});

// ==================== 日志等级(运行时可调) ====================
// 排障时在前端「设置 → 日志等级」切到 debug,**无需重启容器**即可让整条播放链路
// (拖动/seek/投递/解码/推流)的明细落到 stdout(docker logs 可见);用完切回 info。
// 真源 = settings 表 `log.level`;优先级:本设置 > 环境变量 LOG_LEVEL > 默认 info。
// 只影响本进程日志输出,不改任何播放行为。

app.get("/v1/admin/log-settings", adminMiddleware, (c) => {
  return c.json({ success: true, ...logLevelSnapshot() });
});

app.put("/v1/admin/log-settings", adminMiddleware, async (c) => {
  const body = await c.req.json().catch(() => ({} as any));
  const level = typeof body?.level === "string" ? body.level.trim().toLowerCase() : "";
  if (!isLogLevel(level)) {
    return c.json(apiError(BusinessErrorCode.INVALID_PARAM, "errors.common.logLevelFormat"), 400);
  }
  const snap = saveLogLevel(level);
  // 切换本身用 info 记录:这是一次"人主动做的运维动作",任何时候都该看得见。
  createLogger("ADMIN").info(`[log] 日志等级切换为 ${snap.level}`);
  return c.json({ success: true, ...snap });
});

// ==================== Playback settings ====================
// 播放优选(首选 Local)已并入「播放优选」内置插件(core-play-preference):
// 该端点保留仅为兼容旧调用方,读写直接落到插件配置——
// 关闭插件 = preferLocal 失效(按原源播放);插件的 preferLocal 子开关 = 旧版
// 全局设置 playback.preferLocal 的唯一真源。UI 入口在「插件管理」页开关/配置。

app.get("/v1/playback/settings", adminMiddleware, (c) => c.json({
  preferLocal: preferLocalEnabled(),
}));

app.put("/v1/playback/settings", adminMiddleware, async (c) => {
  const body = await c.req.json().catch(() => ({}));
  if (typeof body.preferLocal === "boolean") {
    const p = db.select().from(plugins).where(eq(plugins.id, PLAY_PREFERENCE_PLUGIN_ID)).get();
    if (p) {
      let cfg: any = {};
      try { cfg = p.config ? JSON.parse(p.config) : {}; } catch { /* keep {} */ }
      cfg.preferLocal = body.preferLocal;
      db.update(plugins)
        .set({ config: JSON.stringify(cfg), updatedAt: new Date().toISOString() })
        .where(eq(plugins.id, p.id))
        .run();
    }
  }
  return c.json({ success: true });
});

// ==================== Lyrics / covers media-fetch settings + backfill ====================
// A(按需)/B(落库)/C(批量补全) + 独立选源(providerId)。设置存全局 settings 表:
// 行为归核心、UI 按能力挂载(lyricProvider/coverProvider 插件配置页),与具体
// 插件解耦——换插件设置不变,选中插件被禁用/卸载自动回退全部启用 provider。

app.get("/v1/lyrics/settings", adminMiddleware, (c) => c.json({
  providerId: getSetting("lyrics.providerId", ""),
  // 兼容:providerPriority 为空且旧 providerId 有值时按 [providerId] 返回(旧值视作首项,
  // 前端自动迁移为列表首项);providerId 字段继续返回,不破坏别的消费方。
  providerPriority: getProviderPriority("lyrics"),
  onDemand: getSettingBool("lyrics.onDemand", true),
  persist: getSettingBool("lyrics.persist", false),
}));

app.put("/v1/lyrics/settings", adminMiddleware, (c) => setLyricsCoversSettings(c, "lyrics"));

app.get("/v1/covers/settings", adminMiddleware, (c) => c.json({
  providerId: getSetting("cover.providerId", ""),
  providerPriority: getProviderPriority("cover"),
  onDemand: getSettingBool("cover.onDemand", true),
  persist: getSettingBool("cover.persist", true),
}));
// 注意:封面的全局设置键前缀是 `cover.*`(与 providers.ts / covers.ts / GET 一致),
// 这里必须传 "cover" 而非字面的 "covers",否则写入 covers.* 而无人读取,等同未落库。

app.put("/v1/covers/settings", adminMiddleware, (c) => setLyricsCoversSettings(c, "cover"));

// ==================== 播放来源优先级(playback sources) ====================
// 「插件管理 → 媒体获取」页可调顺序的来源优先级列表:控制**播放平台歌曲**时按什么顺序
// 去各音源找可播的流。与「音乐下载」的 fetch.sourcePriority 完全独立(独立存储键
// stream.sourcePriority)。列表非空 → 换源严格按列表顺序;空 → 保持原行为(本尊优先)。
//
// 路径说明:刻意不用 /v1/stream/settings —— `/v1/stream` 前缀上已挂
// permMiddleware(PERM.LIBRARY_STREAM)(音频流权限门禁,见 routes/api/stream.ts),
// 把 admin 设置端点放进该命名空间会与流播权限语义耦合,故改用独立的
// playback-sources 命名空间,避免与音频流路由/守卫相互干扰。
app.get("/v1/playback-sources/settings", adminMiddleware, (c) => c.json({
  priority: getStreamSourcePriority(),
  available: listAvailableStreamSources(),
}));

app.put("/v1/playback-sources/settings", adminMiddleware, async (c) => {
  const body = await c.req.json().catch(() => ({} as any));
  if (!Array.isArray(body?.priority)) {
    return c.json(apiError(BusinessErrorCode.INVALID_PARAM, "errors.streamSourcePriority.invalidList"), 400);
  }
  const priority = setStreamSourcePriority(body.priority);
  // P2-1:取源顺序是全局决策,改动后必须让**既有换源/可播缓存**全部失效,
  // 否则用户调了顺序、已缓存的正/负结果仍按旧顺序命中,表现为「改了没效果」。
  // 更新前逐出全部缓存即可(下次 findFallbackStream 会按新顺序重新取源)。
  // 复用 streamFallback 已导出的 clearStreamFallbackCache(QueueController/preProbeScheduler
  // 用的是同文件的 evictStreamFallbackCache;这里改的是全局顺序,故清全部而非单曲)。
  clearStreamFallbackCache();
  return c.json({ success: true, priority });
});

// ==================== 预取与判官参数(内存预取 + 完整性判官) ====================
// 「下一首预缓冲」各档参数 + 判官两条判死线存 settings 表(`prefetch.settings`),
// 「插件管理 → 媒体获取」页即存即生效(下一首预取就按新值跑,无需重启)。
// 读优先级 settings>env>默认见 services/source/prefetchConfig.ts;PUT 为**合并**
// 语义(只改带上来的字段);非法/越界值由后端按 specs 钳制(前端同范围校验)。
// 路径沿用 playback-sources 命名空间(与 /v1/stream 前缀的流播权限门禁解耦,
// 理由见上方 playback-sources 注释)。

app.get("/v1/playback-sources/prefetch-settings", adminMiddleware, (c) => c.json({
  success: true,
  ...getPrefetchSettings(),
  specs: PREFETCH_NUM_SPECS,
}));

app.put("/v1/playback-sources/prefetch-settings", adminMiddleware, async (c) => {
  const body = await c.req.json().catch(() => ({} as any));
  const next = setPrefetchSettings(body);
  // 一次「人主动做的运维动作」,任何时候都该看得见(含改动后的全量生效值)。
  createLogger("ADMIN").info(`[prefetch] 预取/判官参数已更新 ${JSON.stringify(next)}`);
  return c.json({ success: true, ...next });
});

// 手动批量补全(节流执行,后台运行;同种任务在跑则返回 running=true)

app.post("/v1/lyrics/backfill", adminMiddleware, (c) => c.json(startBackfill("lyrics")));

app.get("/v1/lyrics/backfill/status", adminMiddleware, (c) => c.json(backfillStatus("lyrics")));

app.post("/v1/covers/backfill", adminMiddleware, (c) => c.json(startBackfill("covers")));

app.get("/v1/covers/backfill/status", adminMiddleware, (c) => c.json(backfillStatus("covers")));

// covers-batch:并发批量补封面(≤2 并发,复用 runCoverBackfill,返回立即)。

app.post("/v1/covers/backfill-batch", adminMiddleware, (c) => c.json(startBackfill("covers-batch")));

app.get("/v1/covers/backfill-batch/status", adminMiddleware, (c) => c.json(backfillStatus("covers-batch")));

// ==================== Daily recommend (combined: remote + pool + local) ====================
//
// These admin endpoints let you inspect / reconfigure / manually trigger the
// daily-recommend system. The actual generation logic lives in
// services/plugin/dailyRecommend.ts; the scheduler that fires it daily lives
// in index.ts.

// Snapshot of the current daily-recommend config + state, for the admin UI.
}
