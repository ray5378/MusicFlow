// ==================== MusicFetch HTTP 路由（/v1/fetch/*）====================
//
// 门禁：全部 adminMiddleware（与 sources 域一致）。前端只经这些端点驱动下载任务：
//   - 配置读写（GET/PUT /v1/fetch/config）：覆盖项落 settings 表 `fetch.config`（JSON 串）
//   - 可用音源列表（GET /v1/fetch/sources）
//   - 预览（POST /v1/fetch/preview）：dryRun 同步跑流水线，只报告「将会下载什么」
//   - 建任务（POST /v1/fetch/tasks）：登记 fetch_jobs 行 + 后台分片跑批量子进程
//   - 任务查询/取消/重试（GET jobs / GET jobs/:id / POST cancel / POST retry）
//
// 分片循环的关键：每一片都是一次**独立**的 runBatchJob（不在一片里循环所有片），
// 这样每片结束即释放全局批量闸，不会把 scan/backfill/每日推荐堵住几十分钟。
import type { Hono } from "hono";
import {
  BusinessErrorCode,
  adminMiddleware,
  apiError,
  apiErrorStatus,
  apiInternalError,
  log,
} from "./shared.js";
import { runBatchJob } from "../../batch/runner.js";
import { sleepBetweenBatch } from "../../services/plugin/batchPacer.js";
import { getSetting, setSetting } from "../../services/settings.js";
import {
  DEFAULT_FETCH_CONFIG,
  resolveFetchConfig,
  validateFetchPaths,
  type FetchConfig,
} from "../../services/fetch/config.js";
import { listCandidateSources, type FetchTarget } from "../../services/fetch/candidates.js";
import { findDownloadSource } from "../../services/fetch/source.js";
import { runFetchPipeline } from "../../services/fetch/orchestrator.js";
import {
  createFetchJob,
  getFetchJob,
  listFetchJobs,
  updateFetchJobStatus,
  type FetchJobRecord,
} from "../../services/fetch/jobStore.js";
import type { TaskStatus } from "../../services/fetch/types.js";

const CONFIG_KEY = "fetch.config";

/** 读取已存配置覆盖项（坏 JSON / 非对象一律视作无覆盖，不抛）。 */
function readStoredOverride(): Partial<FetchConfig> {
  const raw = getSetting(CONFIG_KEY, "");
  if (!raw) return {};
  try {
    const obj = JSON.parse(raw);
    return obj && typeof obj === "object" && !Array.isArray(obj) ? (obj as Partial<FetchConfig>) : {};
  } catch {
    return {};
  }
}

/** 当前生效配置 = 默认值与已存覆盖项合并。 */
function currentConfig(): FetchConfig {
  return resolveFetchConfig(readStoredOverride());
}

/** 客户端入参 → FetchTarget[]（宽容归一化：缺 id 补位、缺 title 置空）。 */
function normalizeTargets(input: unknown): FetchTarget[] {
  if (!Array.isArray(input)) return [];
  const out: FetchTarget[] = [];
  input.forEach((raw, i) => {
    if (!raw || typeof raw !== "object") return;
    const t = raw as Record<string, unknown>;
    const target: FetchTarget = {
      id: String(t.id ?? `target-${i}`),
      title: String(t.title ?? "").trim(),
    };
    if (typeof t.artist === "string") target.artist = t.artist;
    if (typeof t.album === "string") target.album = t.album;
    if (typeof t.durationSec === "number") target.durationSec = t.durationSec;
    if (typeof t.sourceData === "string" || t.sourceData === null) {
      target.sourceData = t.sourceData as string | null;
    }
    if (typeof t.pluginEntry === "string" || t.pluginEntry === null) {
      target.pluginEntry = t.pluginEntry as string | null;
    }
    out.push(target);
  });
  return out;
}

/** 任务列表页需要的摘要（**不含 items**）。 */
function summarize(job: FetchJobRecord): Record<string, unknown> {
  return {
    id: job.id,
    kind: job.kind,
    status: job.status,
    sourceId: job.sourceId,
    counts: job.counts,
    error: job.error,
    createdAt: job.createdAt,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt,
    updatedAt: job.updatedAt,
  };
}

/** 运行中任务的 AbortController（jobId → controller），任务结束即移除。 */
const controllers = new Map<string, AbortController>();

/**
 * 后台分片循环：逐片 runBatchJob("fetch")，片间 sleepBetweenBatch 让位；
 * handler 每片结束返回 hasMore，据此决定是否继续。整批失败/取消在 catch 里落终态。
 */
function startFetchJob(jobId: string): void {
  const controller = new AbortController();
  controllers.set(jobId, controller);
  void (async () => {
    try {
      let chunk = 0;
      for (;;) {
        if (controller.signal.aborted) break;
        const r = await runBatchJob("fetch", { jobId, chunk }, { signal: controller.signal });
        if (!r?.result?.hasMore) break;
        chunk++;
        await sleepBetweenBatch();
      }
    } catch (e: any) {
      updateFetchJobStatus(jobId, controller.signal.aborted ? "cancelled" : "failed", {
        error: String(e?.message || e),
      });
      log.error("fetch 任务失败", { jobId, err: String(e?.message || e) });
    } finally {
      controllers.delete(jobId);
    }
  })();
}

export function registerFetch(app: Hono): void {
  // ---------------- 配置 ----------------
  app.get("/v1/fetch/config", adminMiddleware, (c) =>
    c.json({ success: true, config: currentConfig() }),
  );

  app.put("/v1/fetch/config", adminMiddleware, async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const override = body && typeof body === "object" && !Array.isArray(body) ? body : {};
    const merged = resolveFetchConfig(override as Partial<FetchConfig>);
    const v = validateFetchPaths(merged);
    if (!v.ok) {
      // 非法路径（如 cacheRoot 落在 downloadRoot 之内）→ 400 且不改库。
      const code = BusinessErrorCode.INVALID_PARAM;
      return c.json(
        { ...apiError(code, v.errors.join("; ")), errors: v.errors, warnings: v.warnings },
        apiErrorStatus(code),
      );
    }
    setSetting(CONFIG_KEY, JSON.stringify(override));
    return c.json({ success: true, config: merged, warnings: v.warnings });
  });

  // ---------------- 可用音源 ----------------
  app.get("/v1/fetch/sources", adminMiddleware, (c) => {
    const sources = listCandidateSources().map((s) => ({
      pluginId: s.pluginId,
      // 音源可能服务多平台，宿主侧拿不到单一 platform，留空串由前端展示插件名。
      platform: "",
      capabilities: s.capabilities,
    }));
    return c.json({ success: true, sources });
  });

  // ---------------- 预览（同步 dryRun） ----------------
  app.post("/v1/fetch/preview", adminMiddleware, async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const targets = normalizeTargets(body?.targets);
    const cfg = currentConfig();
    try {
      const result = await runFetchPipeline({
        targets,
        config: cfg,
        dryRun: true,
        sourceId: findDownloadSource(cfg.downloadRoot) ?? undefined,
      });
      const byId = new Map(targets.map((t) => [t.id, t]));
      const items = result.items.map((o) => {
        const t = byId.get(o.targetId);
        return {
          targetId: o.targetId,
          title: t?.title ?? "",
          artist: t?.artist ?? "",
          status: o.status,
          tier: o.targetTier,
          reason: o.errorMsg ?? o.errorCode,
        };
      });
      const summary = {
        total: targets.length,
        downloadable: result.items.filter((o) => o.status === "queued").length,
        belowBar: result.items.filter((o) => o.errorCode === "BELOW_BAR").length,
        noCandidate: result.items.filter((o) => o.errorCode === "NO_CANDIDATE").length,
      };
      return c.json({ success: true, summary, items });
    } catch (e) {
      return c.json(apiInternalError(e), 500);
    }
  });

  // ---------------- 建任务 + 后台分片 ----------------
  app.post("/v1/fetch/tasks", adminMiddleware, async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const targets = normalizeTargets(body?.targets);
    if (targets.length === 0) {
      const code = BusinessErrorCode.INVALID_PARAM;
      return c.json(apiError(code, "targets 为空"), apiErrorStatus(code));
    }
    const cfg = currentConfig();
    const dryRun = !!body?.dryRun;
    const job = createFetchJob({
      kind: "manual",
      targets: { targets },
      // dryRun 一并快照进 config_json，供子进程 handler 还原（FetchConfig 无该键）。
      config: { ...cfg, dryRun } as Record<string, any>,
    });
    startFetchJob(job.id);
    return c.json({ success: true, jobId: job.id });
  });

  // ---------------- 任务查询 ----------------
  app.get("/v1/fetch/jobs", adminMiddleware, (c) => {
    const limitRaw = Number(c.req.query("limit"));
    const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.floor(limitRaw) : 20;
    const status = c.req.query("status") as TaskStatus | undefined;
    const jobs = listFetchJobs(status ? { limit, status } : { limit });
    return c.json({ success: true, jobs: jobs.map(summarize) });
  });

  app.get("/v1/fetch/jobs/:id", adminMiddleware, (c) => {
    const id = c.req.param("id")!;
    const job = getFetchJob(id);
    if (!job) {
      const code = BusinessErrorCode.NOT_FOUND;
      return c.json(apiError(code, "errors.fetch.jobNotFound"), apiErrorStatus(code));
    }
    return c.json({ success: true, job });
  });

  // ---------------- 取消 ----------------
  app.post("/v1/fetch/jobs/:id/cancel", adminMiddleware, (c) => {
    const id = c.req.param("id")!;
    const job = getFetchJob(id);
    if (!job) {
      const code = BusinessErrorCode.NOT_FOUND;
      return c.json(apiError(code, "errors.fetch.jobNotFound"), apiErrorStatus(code));
    }
    const ctrl = controllers.get(id);
    if (!ctrl) return c.json({ success: true, message: "任务未在运行" });
    ctrl.abort();
    return c.json({ success: true });
  });

  // ---------------- 重试（从原任务挑出未完成项，新建一个 retry 任务） ----------------
  app.post("/v1/fetch/jobs/:id/retry", adminMiddleware, async (c) => {
    const id = c.req.param("id")!;
    const job = getFetchJob(id);
    if (!job) {
      const code = BusinessErrorCode.NOT_FOUND;
      return c.json(apiError(code, "errors.fetch.jobNotFound"), apiErrorStatus(code));
    }
    const body = await c.req.json().catch(() => ({}));
    const onlyFailed = !!body?.onlyFailed;

    // 从旧 items 里挑出待重试项的 targetId。
    const retryIds = new Set<string>();
    for (const it of job.items) {
      const failedLike = it.status === "failed" || it.status === "cancelled";
      const notDone = it.status !== "done";
      if (onlyFailed ? failedLike : notDone) retryIds.add(it.targetId);
    }
    const origTargets: any[] = Array.isArray(job.targets?.targets) ? job.targets.targets : [];
    const targets = origTargets.filter((t) => retryIds.has(String(t?.id)));
    if (targets.length === 0) {
      return c.json({ success: true, jobId: null, message: "没有需要重试的条目" });
    }

    const cfg = currentConfig();
    const newJob = createFetchJob({
      kind: "retry",
      targets: { targets },
      config: cfg as Record<string, any>,
      sourceId: job.sourceId ?? null,
    });
    startFetchJob(newJob.id);
    return c.json({ success: true, jobId: newJob.id });
  });
}

// 供测试/自省：默认配置常量再导出（避免测试直接依赖 services/fetch/config）。
export { DEFAULT_FETCH_CONFIG };
