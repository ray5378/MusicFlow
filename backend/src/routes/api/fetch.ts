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
import { startFetchJob, abortFetchJob } from "../../services/fetch/jobRunner.js";
import { setSetting } from "../../services/settings.js";
import {
  FETCH_CONFIG_KEY,
  currentFetchConfig,
  readFetchConfigOverride,
} from "../../services/fetch/configStore.js";
import { db } from "../../db/index.js";
import { mediaSources } from "../../db/schema.js";
import {
  DEFAULT_DOWNLOAD_ROOT,
  DEFAULT_FETCH_CONFIG,
  resolveFetchConfig,
  validateFetchPaths,
  type FetchConfig,
} from "../../services/fetch/config.js";
import { listCandidateSources, type FetchTarget } from "../../services/fetch/candidates.js";
import { ensureDownloadSource, findDownloadSource } from "../../services/fetch/source.js";
import { runFetchPipeline } from "../../services/fetch/orchestrator.js";
import {
  buildUpgradeJobConfig,
  buildUpgradePlan,
  buildUpgradeQuality,
  buildUpgradeTargets,
  recordUpgradeAttempts,
  resetUpgradeAttempts,
} from "../../services/fetch/upgrade.js";
import {
  buildLibraryJobConfig,
  buildLibraryPlan,
  buildLibraryTargets,
  recordLibraryAttempts,
  resetLibraryAttempts,
} from "../../services/fetch/library.js";
import {
  createFetchJob,
  getFetchJob,
  listFetchJobs,
  updateFetchJobStatus,
  type FetchJobRecord,
} from "../../services/fetch/jobStore.js";
import type { TaskStatus } from "../../services/fetch/types.js";

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

export function registerFetch(app: Hono): void {
  // ---------------- 配置 ----------------
  app.get("/v1/fetch/config", adminMiddleware, (c) =>
    c.json({ success: true, config: currentFetchConfig() }),
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
    setSetting(FETCH_CONFIG_KEY, JSON.stringify(override));
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
    const cfg = currentFetchConfig();
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
    const cfg = currentFetchConfig();
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
    // 详情弹窗要显示歌名/歌手：items 自身不冗余这两个字段，
    // 故在读取时从 targets 快照 join（key = targetId）。
    const tgts: any[] = Array.isArray((job as any)?.targets?.targets)
      ? (job as any).targets.targets
      : [];
    const meta = new Map(
      tgts.map((t) => [
        String(t?.id),
        { title: String(t?.title ?? ""), artist: String(t?.artist ?? "") },
      ]),
    );
    const items = job.items.map((it) => ({
      ...it,
      title: meta.get(it.targetId)?.title ?? "",
      artist: meta.get(it.targetId)?.artist ?? "",
    }));
    return c.json({ success: true, job: { ...job, items } });
  });

  // ---------------- 取消 ----------------
  app.post("/v1/fetch/jobs/:id/cancel", adminMiddleware, (c) => {
    const id = c.req.param("id")!;
    const job = getFetchJob(id);
    if (!job) {
      const code = BusinessErrorCode.NOT_FOUND;
      return c.json(apiError(code, "errors.fetch.jobNotFound"), apiErrorStatus(code));
    }
    if (!abortFetchJob(id)) return c.json({ success: true, message: "任务未在运行" });
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
    // 显式 targetIds（前端逐曲重试）优先；未给则按 onlyFailed 挑选未完成项。
    const rawIds = Array.isArray(body?.targetIds) ? (body.targetIds as unknown[]) : null;

    // 从旧 items 里挑出待重试项的 targetId。
    const retryIds = new Set<string>();
    if (rawIds && rawIds.length > 0) {
      // 白名单与 job.items 求交：只保留真实存在且未完成的 targetId（此时忽略 onlyFailed）。
      const wanted = new Set(rawIds.map((v) => String(v)));
      for (const it of job.items) {
        if (wanted.has(it.targetId) && it.status !== "done") retryIds.add(it.targetId);
      }
    } else {
      for (const it of job.items) {
        const failedLike = it.status === "failed" || it.status === "cancelled";
        const notDone = it.status !== "done";
        if (onlyFailed ? failedLike : notDone) retryIds.add(it.targetId);
      }
    }
    const origTargets: any[] = Array.isArray(job.targets?.targets) ? job.targets.targets : [];
    const targets = origTargets.filter((t) => retryIds.has(String(t?.id)));
    if (targets.length === 0) {
      return c.json({ success: true, jobId: null, message: "没有需要重试的条目" });
    }

    const cfg = currentFetchConfig();
    const newJob = createFetchJob({
      kind: "retry",
      targets: { targets },
      config: cfg as Record<string, any>,
      sourceId: job.sourceId ?? null,
    });
    startFetchJob(newJob.id);
    return c.json({ success: true, jobId: newJob.id });
  });

  // ---------------- 洗版（无损替换低码率） ----------------

  /** 洗版范围解析：显式 sourceId > cfg.upgradeSourceIds > 回落「/MUSIC/DOWNLOAD 对应的源」。 */
  function resolveUpgradeSourceIds(explicit?: string | null): string[] {
    if (explicit && String(explicit).trim()) return [String(explicit).trim()];
    const cfg = currentFetchConfig();
    if (Array.isArray(cfg.upgradeSourceIds) && cfg.upgradeSourceIds.length > 0) {
      return [...cfg.upgradeSourceIds];
    }
    return [ensureDownloadSource(DEFAULT_DOWNLOAD_ROOT).sourceId];
  }

  /** sourceId → 源名（仅供 UI 展示；查询失败返回空表，不抛）。 */
  function sourceNamesOf(ids: string[]): Record<string, string> {
    const out: Record<string, string> = {};
    try {
      for (const r of db.select().from(mediaSources).all()) {
        if (ids.includes(r.id)) out[r.id] = r.name ?? "";
      }
    } catch {
      /* 忽略 */
    }
    return out;
  }

  /** GET/PUT /upgrade/config 的对外视图（压缩/未压缩下限直接取自洗版档，避免重复硬编码）。 */
  function upgradeConfigView(cfg: FetchConfig): Record<string, unknown> {
    const upQ = buildUpgradeQuality(cfg.quality);
    return {
      sourceIds: cfg.upgradeSourceIds,
      batchLimit: cfg.upgradeBatchLimit,
      originalAction: cfg.upgradeOriginalAction,
      losslessRoot: cfg.losslessRoot,
      compressedMinKbps: upQ.fakeLosslessMinEffBitrate,
      uncompressedMinKbps: upQ.uncompressedMinKbps,
      inspectCandidates: cfg.inspectCandidates,
      upgradeCooldownDays: cfg.upgradeCooldownDays,
      upgradeAutoEnabled: cfg.upgradeAutoEnabled,
      upgradeAutoIntervalDays: cfg.upgradeAutoIntervalDays,
      upgradeAutoTimeOfDay: cfg.upgradeAutoTimeOfDay,
    };
  }

  app.get("/v1/fetch/upgrade/plan", adminMiddleware, (c) => {
    const cfg = currentFetchConfig();
    const sourceIds = resolveUpgradeSourceIds(c.req.query("sourceId"));
    const limitRaw = Number(c.req.query("limit"));
    const offsetRaw = Number(c.req.query("offset"));
    const plan = buildUpgradePlan(sourceIds, cfg, {
      ...(Number.isFinite(limitRaw) && limitRaw > 0 ? { limit: Math.floor(limitRaw) } : {}),
      ...(Number.isFinite(offsetRaw) && offsetRaw > 0 ? { offset: Math.floor(offsetRaw) } : {}),
    });
    return c.json({
      success: true,
      plan: { ...plan, sourceNames: sourceNamesOf(plan.sourceIds) },
    });
  });

  app.post("/v1/fetch/upgrade/tasks", adminMiddleware, async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const cfg = currentFetchConfig();
    const sourceIds = resolveUpgradeSourceIds(typeof body?.sourceId === "string" ? body.sourceId : null);
    const songIds = Array.isArray(body?.songIds) ? (body.songIds as unknown[]).map((v) => String(v)) : undefined;
    const limitRaw = Number(body?.limit);
    const dryRun = !!body?.dryRun;

    const plan = buildUpgradePlan(sourceIds, cfg, {
      ...(songIds && songIds.length > 0 ? { songIds } : {}),
      ...(Number.isFinite(limitRaw) && limitRaw > 0 ? { limit: Math.floor(limitRaw) } : {}),
    });
    const targets = normalizeTargets(buildUpgradeTargets(plan.items));

    const job = createFetchJob({
      kind: "manual",
      targets: { targets },
      // sourceId 留空：批量子进程会按 downloadRootOverride(=/MUSIC/LOSSLESS) 自建洗版源。
      config: buildUpgradeJobConfig(cfg, dryRun),
    });
    if (targets.length === 0) {
      // 没有可洗的 → 立刻终态，避免 0 目标任务卡在 pending。
      updateFetchJobStatus(job.id, "done");
      return c.json({ success: true, job: summarize(getFetchJob(job.id)!) });
    }
    // 落冷却记录（失败也记——产品定调 2026-10-10：失败短期内也好不了，不该天天白扫）。
    recordUpgradeAttempts(job.id, plan.items.map((i) => i.songId));
    startFetchJob(job.id);
    return c.json({ success: true, job: summarize(getFetchJob(job.id)!) });
  });

  app.get("/v1/fetch/upgrade/config", adminMiddleware, (c) =>
    c.json({ success: true, config: upgradeConfigView(currentFetchConfig()) }),
  );

  app.put("/v1/fetch/upgrade/config", adminMiddleware, async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const patch: Partial<FetchConfig> = {};
    if (Array.isArray(body?.sourceIds)) patch.upgradeSourceIds = (body.sourceIds as unknown[]).map((v) => String(v));
    if (typeof body?.batchLimit === "number" && Number.isFinite(body.batchLimit) && body.batchLimit > 0) {
      patch.upgradeBatchLimit = Math.floor(body.batchLimit);
    }
    if (body?.originalAction === "keep" || body?.originalAction === "move" || body?.originalAction === "delete") {
      patch.upgradeOriginalAction = body.originalAction;
    }
    if (typeof body?.losslessRoot === "string" && body.losslessRoot.trim()) {
      patch.losslessRoot = body.losslessRoot.trim();
    }
    if (typeof body?.inspectCandidates === "boolean") patch.inspectCandidates = body.inspectCandidates;
    // 冷却/定时四件套：整数 1-365 钳制 + 时刻格式校验（产品定调 2026-10-10）。
    if (typeof body?.upgradeCooldownDays === "number" && Number.isFinite(body.upgradeCooldownDays)) {
      patch.upgradeCooldownDays = Math.min(365, Math.max(1, Math.floor(body.upgradeCooldownDays)));
    }
    if (typeof body?.upgradeAutoEnabled === "boolean") patch.upgradeAutoEnabled = body.upgradeAutoEnabled;
    if (typeof body?.upgradeAutoIntervalDays === "number" && Number.isFinite(body.upgradeAutoIntervalDays)) {
      patch.upgradeAutoIntervalDays = Math.min(365, Math.max(1, Math.floor(body.upgradeAutoIntervalDays)));
    }
    if (typeof body?.upgradeAutoTimeOfDay === "string" && /^([01]?\d|2[0-3]):([0-5]\d)$/.test(body.upgradeAutoTimeOfDay.trim())) {
      const parts = body.upgradeAutoTimeOfDay.trim().split(":");
      patch.upgradeAutoTimeOfDay = String(parts[0]).padStart(2, "0") + ":" + parts[1];
    }

    // 只增量写覆盖项（与 PUT /config 同一套「逐项提交」纪律）。
    setSetting(FETCH_CONFIG_KEY, JSON.stringify({ ...readFetchConfigOverride(), ...patch }));
    return c.json({ success: true, config: upgradeConfigView(currentFetchConfig()) });
  });

  // 清空洗版冷却记录（下一次所有歌都可重新触发洗版）。
  app.post("/v1/fetch/upgrade/reset", adminMiddleware, (c) => {
    const cleared = resetUpgradeAttempts();
    return c.json({ success: true, cleared });
  });

  // ---------------- 全库下载（手动按钮：库里本地没有实体文件的歌） ----------------
  app.get("/v1/fetch/library/plan", adminMiddleware, (c) => {
    const cfg = currentFetchConfig();
    const limitRaw = Number(c.req.query("limit"));
    const songIdsRaw = c.req.query("songIds");
    const plan = buildLibraryPlan(cfg, {
      ...(Number.isFinite(limitRaw) && limitRaw > 0 ? { limit: Math.floor(limitRaw) } : {}),
      ...(songIdsRaw
        ? { songIds: songIdsRaw.split(",").map((v) => v.trim()).filter(Boolean) }
        : {}),
    });
    return c.json({ success: true, plan });
  });

  app.post("/v1/fetch/library/tasks", adminMiddleware, async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const cfg = currentFetchConfig();
    const dryRun = !!body?.dryRun;
    const songIds = Array.isArray(body?.songIds)
      ? (body.songIds as unknown[]).map((v) => String(v))
      : undefined;
    // 硬上限 libraryBatchLimit（产品定 500/次，防误点把平台接口打爆），请求只能往下调。
    const cap = Math.max(1, Math.floor(cfg.libraryBatchLimit || 500));
    const reqRaw = Number(body?.limit);
    const reqLimit = Number.isFinite(reqRaw) && reqRaw > 0 ? Math.floor(reqRaw) : cap;
    const limit = Math.min(reqLimit, cap);

    const plan = buildLibraryPlan(cfg, {
      limit,
      ...(songIds && songIds.length > 0 ? { songIds } : {}),
    });
    const targets = normalizeTargets(buildLibraryTargets(plan.items));
    const job = createFetchJob({
      kind: "manual",
      targets: { targets },
      config: buildLibraryJobConfig(cfg, dryRun),
    });
    if (targets.length === 0) {
      // 没有可下的 → 立刻终态，避免 0 目标任务卡 pending。
      updateFetchJobStatus(job.id, "done");
      return c.json({
        success: true,
        job: summarize(getFetchJob(job.id)!),
        enqueued: 0,
        remaining: plan.pending,
      });
    }
    // 先落「已尝试」，再开跑：这样失败的歌下一批也不会被重复选中（可 reset 重跑）。
    recordLibraryAttempts(job.id, plan.items.map((i) => i.songId));
    startFetchJob(job.id);
    return c.json({
      success: true,
      job: summarize(getFetchJob(job.id)!),
      enqueued: targets.length,
      remaining: Math.max(0, plan.pending - targets.length),
    });
  });

  app.post("/v1/fetch/library/reset", adminMiddleware, (c) =>
    c.json({ success: true, cleared: resetLibraryAttempts() }),
  );
}

// 供测试/自省：默认配置常量再导出（避免测试直接依赖 services/fetch/config）。
export { DEFAULT_FETCH_CONFIG };
