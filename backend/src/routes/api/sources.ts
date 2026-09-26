// 自动生成 —— 由 index.ts 物理拆分而来（sources 域，8 条路由）。零逻辑改动。
import type { Hono } from "hono";
import {
  BusinessErrorCode,
  SCRAPE_JOB_ID,
  ScanProgress,
  adminMiddleware,
  apiError,
  cleanupOrphans,
  db,
  deleteAnalysisMany,
  eq,
  fs,
  inArray,
  log,
  mediaSources,
  path,
  playHistory,
  playlistSongs,
  runBatchJob,
  scanJobs,
  scrapeJobs,
  songs,
  testWebDAVConnection,
  touch,
  translate,
  userFavoriteSongs,
  uuidv4,
} from "./shared.js";

export function registerSources(app: Hono): void {
app.get("/v1/sources", adminMiddleware, (c) => c.json(db.select().from(mediaSources).all().map(s => ({ ...s, config: JSON.parse(s.config || "{}") }))));

app.post("/v1/sources", adminMiddleware, async (c) => {
  const body = await c.req.json();
  const id = uuidv4();
  db.insert(mediaSources).values({ id, name: body.name, type: body.type || "webdav", enabled: body.enabled !== false ? 1 : 0, config: JSON.stringify(body.config || {}) }).run();
  return c.json({ id });
});

app.put("/v1/sources/:id", adminMiddleware, async (c) => {
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

app.delete("/v1/sources/:id", adminMiddleware, (c) => {
  const id = c.req.param("id")!;
  // Find all songs belonging to this source (webdav: w:<id>:, local: l:<id>:)
  const sourceSongs = db.select().from(songs).all().filter(s => s.path.startsWith(`w:${id}:`) || s.path.startsWith(`l:${id}:`));
  const songIds = sourceSongs.map(s => s.id);
  if (songIds.length > 0) {
    // Delete dependent rows first (FK constraints)
    db.delete(playlistSongs).where(inArray(playlistSongs.songId, songIds)).run();
    db.delete(userFavoriteSongs).where(inArray(userFavoriteSongs.songId, songIds)).run();
    db.delete(playHistory).where(inArray(playHistory.songId, songIds)).run();
    // P0-6:源整个删掉,回写跟删(行永久消失,不存在"源抖动误删",无需可达门)。
    // 顺序:先回写后歌曲行(FK 无 CASCADE,反了抛错)。
    deleteAnalysisMany(songIds);
    db.delete(songs).where(inArray(songs.id, songIds)).run();
    cleanupOrphans();
  }
  db.delete(mediaSources).where(eq(mediaSources.id, id)).run();
  return c.json({ success: true, removedSongs: songIds.length });
});

// Test connection

app.post("/v1/sources/:id/test", adminMiddleware, async (c) => {
  const id = c.req.param("id")!;
  const source = db.select().from(mediaSources).where(eq(mediaSources.id, id)).get();
  if (!source) return c.json(apiError(BusinessErrorCode.NOT_FOUND, "errors.source.notFound"));

  const config = JSON.parse(source.config || "{}");

  if (source.type === "webdav") {
    try {
      console.log("[TEST] URL:", config.url, "root_path:", config.root_path, "user:", config.username);
      const result = await testWebDAVConnection(config.url, config.username, config.password, config.root_path);
      console.log("[TEST] Result:", JSON.stringify(result));
      return c.json(result);
    } catch (e: any) {
      console.log("[TEST] Error:", e.message);
      return c.json(apiError(BusinessErrorCode.UPSTREAM_ERROR, e.message || "errors.source.connectFailed"));
    }
  } else if (source.type === "local") {
    const fs = await import("fs");
    if (fs.existsSync(config.path)) {
      return c.json({ success: true, message: `路径 ${config.path} 存在` });
    } else {
      return c.json(apiError(BusinessErrorCode.INVALID_PARAM, "errors.source.pathMissing", { path: config.path }));
    }
  }
  return c.json(apiError(BusinessErrorCode.INVALID_PARAM, "errors.source.unsupportedType"));
});

// Scan source

app.post("/v1/sources/:id/scan", adminMiddleware, async (c) => {
  touch(); // 标记活动:媒体源扫描
  const id = c.req.param("id")!;
  const source = db.select().from(mediaSources).where(eq(mediaSources.id, id)).get();
  if (!source) return c.json(apiError(BusinessErrorCode.NOT_FOUND, "errors.source.notFound"));
  if (!source.enabled) return c.json(apiError(BusinessErrorCode.CONFLICT, "errors.source.disabled"));
  if (scanJobs.has(id) && scanJobs.get(id)!.status === "running") {
    return c.json(apiError(BusinessErrorCode.CONFLICT, "errors.scanner.busy"));
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
      if (cur) scrapeJobs.set(SCRAPE_JOB_ID, { status: "failed", startedAt: cur.startedAt, error: p.error || translate("errors.scraper.failed"), progress: cur.progress });
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
      scanJobs.set(id, { status: "failed", error: e.message || translate("errors.scanner.failed"), startedAt: job.startedAt, progress: job.progress, mode });
    }
  })();

  return c.json({ success: true, message: mode === "incremental" ? "增量扫描已开始" : "全库扫描已开始" });
});

// Stop a running scan

app.post("/v1/sources/:id/scan-stop", adminMiddleware, (c) => {
  const id = c.req.param("id")!;
  const job = scanJobs.get(id);
  if (!job || job.status !== "running") return c.json(apiError(BusinessErrorCode.CONFLICT, "errors.scanner.notRunning"));
  job.controller?.abort();
  return c.json({ success: true, message: "正在停止扫描..." });
});

app.get("/v1/sources/:id/scan-status", adminMiddleware, (c) => {
  const id = c.req.param("id")!;
  const job = scanJobs.get(id);
  if (!job) return c.json({ status: "idle" });
  return c.json({ status: job.status, progress: job.progress, result: job.result, error: job.error, startedAt: job.startedAt, mode: job.mode });
});

// ==================== Plugins ====================
// 内置插件 = 随服务端发行的功能:可停用(服务生命周期按插件联动)、不可删除、不可更新。
}
