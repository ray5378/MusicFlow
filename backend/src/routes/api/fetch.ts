// ==================== MusicFetch HTTP 路由（/v1/fetch/*）====================
//
// 门禁：全部 adminMiddleware（与 sources 域一致）。前端只经这些端点驱动下载任务：
//   - 配置读写（GET/PUT /v1/fetch/config）：覆盖项落 settings 表 `fetch.config`（JSON 串）
//   - 可用音源列表（GET /v1/fetch/sources）
//   - 建任务（POST /v1/fetch/tasks）：登记 fetch_jobs 行 + 后台分片跑批量子进程
//   - 任务查询/取消/完全停止/重试（GET jobs / GET jobs/:id / POST cancel / POST force-stop / POST retry）
//     · POST cancel      = 排空式取消（停止准入，在途 + 缓存待转码走完并落地）
//     · POST force-stop  = 完全停止（硬终止，立刻中断在途下载与转码）
//
// 分片循环的关键：每一片都是一次**独立**的 runBatchJob（不在一片里循环所有片），
// 这样每片结束即释放全局批量闸，不会把 scan/backfill/每日推荐堵住几十分钟。
import type { Hono } from "hono";
import {
  BusinessErrorCode,
  adminMiddleware,
  apiError,
  apiErrorStatus,
  log,
} from "./shared.js";
import { startFetchJob, abortFetchJob, drainFetchJob } from "../../services/fetch/jobRunner.js";
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
  type TagRepairScope,
} from "../../services/fetch/config.js";
import { listCandidateSources, type FetchTarget } from "../../services/fetch/candidates.js";
import { ensureDownloadSource } from "../../services/fetch/source.js";
import {
  buildUpgradeJobConfig,
  buildUpgradePlan,
  buildUpgradeQuality,
  buildUpgradeTargets,
  recordUpgradeAttempts,
  resetUpgradeAttempts,
} from "../../services/fetch/upgrade.js";
import { setAutoSession } from "../../services/fetch/autoSession.js";
import {
  buildLibraryJobConfig,
  buildLibraryPlan,
  buildLibraryTargets,
  resetLibraryAttempts,
} from "../../services/fetch/library.js";
import {
  clearFetchJobRows,
  createFetchJob,
  deleteFetchJobRow,
  getFetchJob,
  listFetchJobSummaries,
  updateFetchJobStatus,
  type FetchJobSummaryRecord,
} from "../../services/fetch/jobStore.js";
import { ensureBaseBatchLimit } from "../../services/plugin/batchPacer.js";
import type { TaskStatus } from "../../services/fetch/types.js";
import {
  getTagRepairLastResult,
  getTagRepairLastResults,
  getTagRepairProgress,
  getTagRepairQueueSize,
  getTagRepairStats,
  isTagRepairRunning,
  runTagRepairOnce,
  type TagRepairMode,
} from "../../services/fetch/tagRepair.js";

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
function summarize(job: FetchJobSummaryRecord): Record<string, unknown> {
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
    // ssrfTrustedHosts：字符串数组（trim + 去空 + 去重）；坏类型一律置空数组。
    if ("ssrfTrustedHosts" in override) {
      const raw = (override as Record<string, unknown>).ssrfTrustedHosts;
      (override as Record<string, unknown>).ssrfTrustedHosts = Array.isArray(raw)
        ? Array.from(new Set(raw.map((x) => String(x).trim()).filter(Boolean)))
        : [];
    }
    // 转码目标只留 FLAC（产品定调 2026-10-10）：历史遗留 alac/wav 覆盖项一律归一。
    if ("transcodeTarget" in override) {
      (override as Record<string, unknown>).transcodeTarget = "flac";
    }
    // libraryAutoContinue：布尔归一（非布尔回默认 true，删键即可）。
    if (
      "libraryAutoContinue" in override &&
      typeof (override as Record<string, unknown>).libraryAutoContinue !== "boolean"
    ) {
      delete (override as Record<string, unknown>).libraryAutoContinue;
    }
    // 全库下载冷却/定时四件套（产品定调 2026-10-10，对齐洗版）。
    if ("libraryCooldownDays" in override) {
      const n = Number((override as Record<string, unknown>).libraryCooldownDays);
      (override as Record<string, unknown>).libraryCooldownDays = Number.isFinite(n)
        ? Math.min(365, Math.max(1, Math.floor(n)))
        : DEFAULT_FETCH_CONFIG.libraryCooldownDays;
    }
    // PATCH19 任务级并行数：1..16（与批量闸硬上限一致；resolveFetchConfig 再夹一层）。
    if ("maxConcurrentJobs" in override) {
      const n = Number((override as Record<string, unknown>).maxConcurrentJobs);
      (override as Record<string, unknown>).maxConcurrentJobs = Number.isFinite(n)
        ? Math.min(16, Math.max(1, Math.floor(n)))
        : DEFAULT_FETCH_CONFIG.maxConcurrentJobs;
    }
    // PATCH20 单任务并发歌曲数：1..64（目标级并行）。全库下载 / 洗版都是单任务，这个值
    // 才是它们真正的并发上限；小于「最大并发下载数」时后者永远吃不满 —— 故必须可配。
    if ("maxConcurrentTargets" in override) {
      const n = Number((override as Record<string, unknown>).maxConcurrentTargets);
      (override as Record<string, unknown>).maxConcurrentTargets = Number.isFinite(n)
        ? Math.min(64, Math.max(1, Math.floor(n)))
        : DEFAULT_FETCH_CONFIG.maxConcurrentTargets;
    }
    // PATCH22 转码总闸：1..16。同时跑 ffmpeg 转码的歌数上限，下载/洗版共用。
    if ("maxConcurrentTranscodes" in override) {
      const n = Number((override as Record<string, unknown>).maxConcurrentTranscodes);
      (override as Record<string, unknown>).maxConcurrentTranscodes = Number.isFinite(n)
        ? Math.min(16, Math.max(1, Math.floor(n)))
        : DEFAULT_FETCH_CONFIG.maxConcurrentTranscodes;
    }
    if (
      "libraryAutoEnabled" in override &&
      typeof (override as Record<string, unknown>).libraryAutoEnabled !== "boolean"
    ) {
      delete (override as Record<string, unknown>).libraryAutoEnabled;
    }
    // 关闭全库下载自动总开关 = 停链：清续批会话标记，防调度器把链复活。
    if ((override as Record<string, unknown>).libraryAutoEnabled === false) setAutoSession("library", false);
    // 关闭全库下载「自动续批」总闸 = 停链：清续批会话标记，防调度器在让渡空窗期把链复活
    // （2026-10-16 修正：此前只清 libraryAutoEnabled===false，把续批总闸关掉后链仍会被接续）。
    if ((override as Record<string, unknown>).libraryAutoContinue === false) setAutoSession("library", false);
    if ("libraryAutoIntervalDays" in override) {
      const n = Number((override as Record<string, unknown>).libraryAutoIntervalDays);
      (override as Record<string, unknown>).libraryAutoIntervalDays = Number.isFinite(n)
        ? Math.min(365, Math.max(1, Math.floor(n)))
        : DEFAULT_FETCH_CONFIG.libraryAutoIntervalDays;
    }
    if (
      "libraryAutoTimeOfDay" in override &&
      (typeof (override as Record<string, unknown>).libraryAutoTimeOfDay !== "string" ||
        !/^([01]?\d|2[0-3]):([0-5]\d)$/.test(String((override as Record<string, unknown>).libraryAutoTimeOfDay).trim()))
    ) {
      delete (override as Record<string, unknown>).libraryAutoTimeOfDay;
    }
    // 下载尝试冷却天数（PATCH17，产品定调 2026-10-10）：整数 0-365（0 = 关闭）。
    if ("downloadCooldownDays" in override) {
      const n = Number((override as Record<string, unknown>).downloadCooldownDays);
      (override as Record<string, unknown>).downloadCooldownDays = Number.isFinite(n)
        ? Math.min(365, Math.max(0, Math.floor(n)))
        : DEFAULT_FETCH_CONFIG.downloadCooldownDays;
    }
    // 死链清理阈值（PATCH21，产品定调 2026-10-11）：整数 0-20（0 = 关闭清理）。
    if ("deadSongPurgeThreshold" in override) {
      const n = Number((override as Record<string, unknown>).deadSongPurgeThreshold);
      (override as Record<string, unknown>).deadSongPurgeThreshold = Number.isFinite(n)
        ? Math.min(20, Math.max(0, Math.floor(n)))
        : DEFAULT_FETCH_CONFIG.deadSongPurgeThreshold;
    }
    // jobRetentionDays：整数 0-3650（0 = 关闭自动清理）。
    if ("jobRetentionDays" in override) {
      const n = Number((override as Record<string, unknown>).jobRetentionDays);
      (override as Record<string, unknown>).jobRetentionDays = Number.isFinite(n)
        ? Math.min(3650, Math.max(0, Math.floor(n)))
        : DEFAULT_FETCH_CONFIG.jobRetentionDays;
    }
    // 中文文本字形（产品定调 2026-10-16）：只接受 simplified / traditional 两个白名单值，
    // 其余一律丢弃（回落默认 simplified，见 resolveFetchConfig 的同名校验）。
    if (
      "chineseVariant" in override &&
      (override as Record<string, unknown>).chineseVariant !== "simplified" &&
      (override as Record<string, unknown>).chineseVariant !== "traditional"
    ) {
      delete (override as Record<string, unknown>).chineseVariant;
    }
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
    // PATCH19：任务并行数改动**即时生效**（不等下一个任务启动）——立刻刷新全局批量闸保底。
    ensureBaseBatchLimit(merged.maxConcurrentJobs);
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

  // ---------------- 建任务 + 后台分片 ----------------
  app.post("/v1/fetch/tasks", adminMiddleware, async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const targets = normalizeTargets(body?.targets);
    if (targets.length === 0) {
      const code = BusinessErrorCode.INVALID_PARAM;
      return c.json(apiError(code, "targets 为空"), apiErrorStatus(code));
    }
    const cfg = currentFetchConfig();
    const job = createFetchJob({
      kind: "search",
      targets: { targets },
      config: { ...cfg } as Record<string, any>,
    });
    startFetchJob(job.id);
    return c.json({ success: true, jobId: job.id });
  });

  // ---------------- 任务查询 ----------------
  app.get("/v1/fetch/jobs", adminMiddleware, (c) => {
    const limitRaw = Number(c.req.query("limit"));
    const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.floor(limitRaw) : 20;
    const status = c.req.query("status") as TaskStatus | undefined;
    // 按任务类型分栏（前端「下载任务 / 洗版任务」是两个独立 tab）：search / library / upgrade / retry。
    // - kind：精确匹配单个类型；
    // - kinds（逗号分隔）：类型白名单（IN）。「下载任务」面板一次拉全部非洗版 kind，
    //   用白名单而不是「排除 upgrade」，是为了以后新增类型时显式决定它归哪一栏。
    const kind = c.req.query("kind")?.trim() || undefined;
    // kinds 三种形态全收，避免任何客户端/序列化器差异把过滤条件静默丢掉：
    //   ?kinds=a,b        （逗号串）
    //   ?kinds=a&kinds=b  （重复键）
    //   ?kinds[]=a&kinds[]=b （axios 对数组的默认序列化）
    const qs = new URL(c.req.url).searchParams;
    const kinds = Array.from(
      new Set(
        [...qs.getAll("kinds"), ...qs.getAll("kinds[]")]
          .flatMap((v) => String(v).split(","))
          .map((x) => x.trim())
          .filter((x) => x.length > 0),
      ),
    );
    const opts: { limit: number; status?: TaskStatus; kind?: string; kinds?: string[] } = { limit };
    if (status) opts.status = status;
    if (kinds.length > 0) opts.kinds = kinds;
    else if (kind) opts.kind = kind;
    // 列表页只取摘要列（不解析 items/targets/imports/config 大 JSON），显著降低列表接口同步开销。
    const jobs = listFetchJobSummaries(opts);
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

  /**
   * 取消即停自动续批链：清对应流的会话标记（在跑任务的终态钩子也会清，幂等）。
   * ⚠️ 点名批次（`__upgrade.noAutoContinue` / `__library.noAutoContinue`）不参与续批链，
   * 取消它**不得**误清全库链的会话标记——否则用户点名重试后取消，会把正在跑的全库/洗版链一起掐断。
   */
  function stopAutoSessionForJob(job: { kind: string; config?: Record<string, any> }): void {
    const noAuto = !!job?.config?.__upgrade?.noAutoContinue || !!job?.config?.__library?.noAutoContinue;
    if (noAuto) return;
    if (job?.kind === "library") setAutoSession("library", false);
    else if (job?.kind === "upgrade") setAutoSession("upgrade", false);
  }

  /**
   * 取消 / 完全停止共用的收尾：把「停止函数」与「僵尸行兜底」收敛到一处。
   *
   * `stop` 返回 false 表示进程内没有该 job 的 controller（跑批循环是进程内的，服务重启即
   * 消亡）——此时若行仍处 pending/running，就是重启遗留的僵尸行，直接落 cancelled 终态，
   * 否则 UI 的取消/完全停止永远无效；僵尸行没有终态钩子，这里补清自动续批会话（停链）。
   * `stop` 返回 true（有在跑 controller）：终态钩子（maybeContinue*Job）也会清会话，这里
   * 兜底同清（幂等）。
   */
  function finishStop(
    id: string,
    job: { kind: string; status: TaskStatus; config?: Record<string, any> },
    stop: (jobId: string) => boolean,
  ): Record<string, unknown> {
    if (!stop(id)) {
      if (job.status === "pending" || job.status === "running") {
        updateFetchJobStatus(id, "cancelled", { error: "手动取消（无运行中的进程内任务）" });
        stopAutoSessionForJob(job);
        return { success: true, cancelled: "zombie" };
      }
      return { success: true, message: "任务未在运行" };
    }
    stopAutoSessionForJob(job);
    return { success: true };
  }

  // ---------------- 取消（排空式停止） ----------------
  // 停止准入新条目、不再开新片/新任务；在途下载与缓存中待转码的歌走完并落地；
  // 未开始的条目落 cancelled；任务终态 cancelled；自动续批链终止。
  app.post("/v1/fetch/jobs/:id/cancel", adminMiddleware, (c) => {
    const id = c.req.param("id")!;
    const job = getFetchJob(id);
    if (!job) {
      const code = BusinessErrorCode.NOT_FOUND;
      return c.json(apiError(code, "errors.fetch.jobNotFound"), apiErrorStatus(code));
    }
    return c.json(finishStop(id, job, drainFetchJob));
  });

  // ---------------- 完全停止（硬终止，等价于原 abort 行为） ----------------
  // 立刻中断在途下载与转码（含排队中的）；30s 宽限后 SIGKILL；终态 cancelled。
  app.post("/v1/fetch/jobs/:id/force-stop", adminMiddleware, (c) => {
    const id = c.req.param("id")!;
    const job = getFetchJob(id);
    if (!job) {
      const code = BusinessErrorCode.NOT_FOUND;
      return c.json(apiError(code, "errors.fetch.jobNotFound"), apiErrorStatus(code));
    }
    return c.json(finishStop(id, job, abortFetchJob));
  });

  // ---------------- 删除 / 清空任务记录（只动终态任务） ----------------
  app.delete("/v1/fetch/jobs/:id", adminMiddleware, (c) => {
    const id = c.req.param("id")!;
    const job = getFetchJob(id);
    if (!job) {
      const code = BusinessErrorCode.NOT_FOUND;
      return c.json(apiError(code, "errors.fetch.jobNotFound"), apiErrorStatus(code));
    }
    if (job.status === "pending" || job.status === "running") {
      const code = BusinessErrorCode.INVALID_PARAM;
      return c.json(apiError(code, "先取消运行中的任务再删除记录"), apiErrorStatus(code));
    }
    return c.json({ success: true, deleted: deleteFetchJobRow(id) });
  });

  app.post("/v1/fetch/jobs/clear", adminMiddleware, (c) => {
    return c.json({ success: true, cleared: clearFetchJobRows() });
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
      return [...new Set(cfg.upgradeSourceIds)];
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

  /**
   * GET/PUT /upgrade/config 的对外视图。
   * `compressedMinKbps` / `uncompressedMinKbps` 是**洗版目标门槛**（取自 buildUpgradeQuality 硬钉的
   * 700 / 1400）——它决定洗版取链要求什么音质，**不是**「哪些歌要洗」的筛选条件。
   * 前端这两个值目前仅为展示（PUT 不接收，改了不落库）。
   */
  function upgradeConfigView(cfg: FetchConfig): Record<string, unknown> {
    const upQ = buildUpgradeQuality(cfg.quality);
    return {
      sourceIds: cfg.upgradeSourceIds,
      batchLimit: cfg.upgradeBatchLimit,
      losslessRoot: cfg.losslessRoot,
      compressedMinKbps: upQ.fakeLosslessMinEffBitrate,
      uncompressedMinKbps: upQ.uncompressedMinKbps,
      upgradeCooldownDays: cfg.upgradeCooldownDays,
      upgradeAutoEnabled: cfg.upgradeAutoEnabled,
      upgradeAutoIntervalDays: cfg.upgradeAutoIntervalDays,
      upgradeAutoTimeOfDay: cfg.upgradeAutoTimeOfDay,
      upgradeAutoContinue: cfg.upgradeAutoContinue,
    };
  }

  app.get("/v1/fetch/upgrade/plan", adminMiddleware, (c) => {
    const cfg = currentFetchConfig();
    const sourceIds = resolveUpgradeSourceIds(c.req.query("sourceId"));
    const limitRaw = Number(c.req.query("limit"));
    const offsetRaw = Number(c.req.query("offset"));
    const hasLimit = Number.isFinite(limitRaw) && limitRaw > 0;
    const plan = buildUpgradePlan(sourceIds, cfg, {
      ...(hasLimit ? { limit: Math.floor(limitRaw) } : {}),
      ...(Number.isFinite(offsetRaw) && offsetRaw > 0 ? { offset: Math.floor(offsetRaw) } : {}),
      // UI 只读统计（洗版预览已下线）→ 未带 limit 时走 COUNT 快路径，
      // 不把目标目录全部行 materialize 成 JS 对象（同步 SQLite 会阻塞整个事件循环）。
      ...(hasLimit ? {} : { statsOnly: true }),
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
    // 点名 songIds = 一次性批次（不接续）；全库范围触发才进自动续批链。
    const namedOnly = Array.isArray(songIds) && songIds.length > 0;

    // 点名批次不按 upgradeBatchLimit 截断（用户明确点名要洗这些歌）：未显式给 limit 时
    // 取 songIds.length；显式给 limit 则尊重之（2026-10-16 修正此前静默截断到默认 20）。
    const limitForPlan = Number.isFinite(limitRaw) && limitRaw > 0
      ? Math.floor(limitRaw)
      : (namedOnly ? songIds!.length : 0);
    const plan = buildUpgradePlan(sourceIds, cfg, {
      ...(namedOnly ? { songIds } : {}),
      ...(limitForPlan > 0 ? { limit: limitForPlan } : {}),
    });
    const targets = normalizeTargets(buildUpgradeTargets(plan.items));
    const job = createFetchJob({
      kind: "upgrade",
      targets: { targets },
      // sourceId 留空：批量子进程会按 downloadRootOverride(=/MUSIC/LOSSLESS) 自建洗版源。
      config: buildUpgradeJobConfig(cfg, namedOnly ? { noAutoContinue: true } : undefined),
    });
    if (targets.length === 0) {
      // 没有可洗的 → 立刻终态，避免 0 目标任务卡在 pending。
      updateFetchJobStatus(job.id, "done");
      return c.json({ success: true, job: summarize(getFetchJob(job.id)!) });
    }
    // 落冷却记录（失败也记——产品定调 2026-10-10：失败短期内也好不了，不该天天白扫）。
    recordUpgradeAttempts(job.id, plan.items.map((i) => i.songId));
    startFetchJob(job.id);
    // 全库范围触发 → 标记续批会话（一批完自动开下一批，重启/让渡也不断）。
    if (!namedOnly) setAutoSession("upgrade", true);
    return c.json({ success: true, job: summarize(getFetchJob(job.id)!) });
  });

  app.get("/v1/fetch/upgrade/config", adminMiddleware, (c) =>
    c.json({ success: true, config: upgradeConfigView(currentFetchConfig()) }),
  );

  app.put("/v1/fetch/upgrade/config", adminMiddleware, async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const patch: Partial<FetchConfig> = {};
    const deleteKeys: string[] = []; // 非布尔归一失败 → 删键回默认（对齐 libraryAutoContinue 纪律）
    // 源去重：重复 sourceId 会让「逐源相加」的统计口径把同一目录重复计数（2026-10-16 修正）。
    if (Array.isArray(body?.sourceIds)) {
      patch.upgradeSourceIds = [...new Set((body.sourceIds as unknown[]).map((v) => String(v)).filter(Boolean))];
    }
    if (typeof body?.batchLimit === "number" && Number.isFinite(body.batchLimit) && body.batchLimit > 0) {
      patch.upgradeBatchLimit = Math.floor(body.batchLimit);
    }
    if (typeof body?.losslessRoot === "string" && body.losslessRoot.trim()) {
      patch.losslessRoot = body.losslessRoot.trim();
    }
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

    // 自动续批总闸（对齐全库下载 libraryAutoContinue）：布尔入库；非布尔 → 删键回默认 true。
    if (typeof body?.upgradeAutoContinue === "boolean") {
      patch.upgradeAutoContinue = body.upgradeAutoContinue;
    } else if ("upgradeAutoContinue" in body) {
      deleteKeys.push("upgradeAutoContinue");
    }
    // 关闭定时自动洗版 / 关闭自动续批 = 停链：清续批会话标记，防调度器把链复活
    // （2026-10-16 修正：此前只清 `upgradeAutoEnabled===false`，把总闸关掉但链已在空窗期
    //  仍会被 resumeUpgradeSession 接续 → 停不下来）。
    if (patch.upgradeAutoEnabled === false || patch.upgradeAutoContinue === false) {
      setAutoSession("upgrade", false);
    }

    // 只增量写覆盖项（与 PUT /config 同一套「逐项提交」纪律）。
    const mergedOverride = { ...readFetchConfigOverride(), ...patch } as Record<string, unknown>;
    for (const k of deleteKeys) delete mergedOverride[k];
    setSetting(FETCH_CONFIG_KEY, JSON.stringify(mergedOverride));
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
    const songIds = Array.isArray(body?.songIds)
      ? (body.songIds as unknown[]).map((v) => String(v))
      : undefined;
    const namedOnly = Array.isArray(songIds) && songIds.length > 0;
    // 硬上限 libraryBatchLimit（产品定 500/次，防误点把平台接口打爆）：**全库范围**请求只能往下调。
    // 点名批次（songIds）不截断——用户明确点名要下这些歌，未显式给 limit 时取 songIds.length
    // （2026-10-16 修正此前与洗版 A4 同根的静默截断）。
    const cap = Math.max(1, Math.floor(cfg.libraryBatchLimit || 500));
    const reqRaw = Number(body?.limit);
    const explicit = Number.isFinite(reqRaw) && reqRaw > 0 ? Math.floor(reqRaw) : 0;
    const limit = namedOnly
      ? (explicit > 0 ? Math.min(explicit, songIds!.length) : songIds!.length)
      : Math.min(explicit > 0 ? explicit : cap, cap);

    const plan = buildLibraryPlan(cfg, {
      limit,
      ...(namedOnly ? { songIds } : {}),
    });
    const targets = normalizeTargets(buildLibraryTargets(plan.items));
    const job = createFetchJob({
      kind: "library",
      targets: { targets },
      // 点名批次 = 一次性（不接续），对齐洗版 namedOnly 语义。
      config: buildLibraryJobConfig(cfg, namedOnly ? { noAutoContinue: true } : undefined),
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
    // PATCH19：记账移到条目终态时（fetchHandler onItem），创建时不再整批预记——
    // 否则中断后未处理的歌被冷却锁死。
    startFetchJob(job.id);
    // 标记续批会话：一批完自动开下一批，重启容器也会接上（对齐洗版 upgradeAutoContinue）。
    // 点名批次不接续（一次性）。
    if (!namedOnly) setAutoSession("library", true);
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

  // ==================== 标签缺失修复（歌词/封面/专辑，方案 B 2026-10-11） ====================
  // 状态查询：开关 / 队列规模 / 上次结果（供前端按钮展示）+ 分挡位上次结果（两块卡片各显各的）。
  app.get("/v1/fetch/tag-repair", adminMiddleware, (c) => {
    const cfg = currentFetchConfig();
    return c.json({
      enabled: cfg.tagRepairEnabled,
      intervalHours: cfg.tagRepairIntervalHours,
      // 扫描目录范围：download=仅下载根 / lossless=仅无损根 / both=两者。
      scope: cfg.tagRepairScope,
      queueSize: getTagRepairQueueSize(),
      running: isTagRepairRunning(),
      lastResult: getTagRepairLastResult(),
      lastResults: getTagRepairLastResults(),
      // 实时统计（已修复/待修复/全部）与运行中进度（空闲时 progress=null）。
      stats: getTagRepairStats(),
      progress: getTagRepairProgress(),
    });
  });
  // 手动触发一轮：body { mode?: TagRepairMode; full?: boolean; scope?: TagRepairScope }。
  //   mode="queue"=只清到期队列；"media"=第一档常规（仅 DB 预筛，不读文件头，便宜）；
  //   "all"=第二档全量（逐首精探文件头，跑完再清一轮队列）。
  //   scope=本次扫描目录范围（download/lossless/both），缺省沿用已保存的 cfg.tagRepairScope；
  //   非法值回落 "both"（宽容归一化）。
  //   兼容旧入参：full=true → "all"，full=false/缺省 → "queue"；非法值一律回落 "queue"（宽容归一化）。
  // 异步执行（全量可能数分钟），立即返回 busy/started；结果经 GET 轮询 lastResult/lastResults。
  app.post("/v1/fetch/tag-repair/run", adminMiddleware, async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as {
      mode?: TagRepairMode;
      full?: boolean;
      scope?: TagRepairScope;
    };
    const requested = body.mode;
    const mode: TagRepairMode =
      requested === "queue" || requested === "media" || requested === "all"
        ? requested
        : body.full === true
          ? "all"
          : "queue";
    const scope: TagRepairScope =
      body.scope === "download" || body.scope === "lossless" || body.scope === "both" ? body.scope : "both";
    if (isTagRepairRunning()) return c.json({ success: false, busy: true }, 409);
    // 不 await：后台跑，前端轮询状态。
    void runTagRepairOnce(mode, undefined, scope);
    return c.json({ success: true, started: true, mode, scope });
  });
}

// 供测试/自省：默认配置常量再导出（避免测试直接依赖 services/fetch/config）。
export { DEFAULT_FETCH_CONFIG };
