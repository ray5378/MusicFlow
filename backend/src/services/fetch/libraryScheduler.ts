// ==================== 全库下载定时自动调度（对齐 upgradeScheduler） ====================
//
// 产品定调 2026-10-10：定时把库里新增的 web 源歌自动下载到本地。
// 闸门顺序：interval（距上次成功评估 ≥ N 天）→ time-of-day（到点）→ busy（无活动任务）
// → 落 lastRunAt（空跑也落，防每分钟重扫）→ buildLibraryPlan → 建任务 → startFetchJob。
// 自动任务续批交给 jobRunner 的 libraryAutoContinue 钩子（本调度器只负责开第一批）。
import { sqlite } from "../../db/index.js";
import { createLogger } from "../../utils/logger.js";
import { getSetting, setSetting } from "../settings.js";
import { type FetchConfig } from "./config.js";
import { currentFetchConfig } from "./configStore.js";
import { buildLibraryJobConfig, buildLibraryPlan, buildLibraryTargets, recordLibraryAttempts } from "./library.js";
import { createFetchJob, updateFetchJobStatus } from "./jobStore.js";
import { startFetchJob } from "./jobRunner.js";
import { todayTriggerMs } from "./upgradeScheduler.js";

const log = createLogger("library-scheduler");

const LAST_RUN_KEY = "fetch.library.auto.lastRunAt";
const POLL_MS = 60_000;
const BOOT_DELAY_MS = 20_000;

let started = false;
let ticking = false;

/** 判定 + 执行一轮自动全库下载（同步可测，不做任何 sleep）。 */
export function runAutoLibraryOnce(
  cfg: FetchConfig,
  nowMs = Date.now(),
): { triggered: boolean; reason: string; enqueued?: number; jobId?: string } {
  const last = Number(getSetting(LAST_RUN_KEY, "0")) || 0;
  const days = Math.min(365, Math.max(1, Math.floor(cfg.libraryAutoIntervalDays > 0 ? cfg.libraryAutoIntervalDays : 1)));
  if (nowMs - last < days * 86_400_000) return { triggered: false, reason: "interval" };
  const triggerMs = todayTriggerMs(cfg.libraryAutoTimeOfDay, new Date(nowMs));
  if (triggerMs <= 0 || nowMs < triggerMs) return { triggered: false, reason: "time-of-day" };
  const busy = sqlite
    .prepare("SELECT COUNT(*) AS n FROM fetch_jobs WHERE status IN ('pending','running')")
    .get() as { n?: number };
  if (Number(busy?.n ?? 0) > 0) return { triggered: false, reason: "busy" };

  // 无论有没有可下目标，评估完都落 lastRunAt：空跑也别每分钟重扫。
  setSetting(LAST_RUN_KEY, String(nowMs));

  // 第一批取 libraryBatchLimit（后续批次由 jobRunner 的 libraryAutoContinue 续上）。
  const batchLimit = Math.max(1, Math.floor(cfg.libraryBatchLimit || 500));
  const plan = buildLibraryPlan(cfg, { limit: batchLimit });
  const targets = buildLibraryTargets(plan.items);
  const job = createFetchJob({ kind: "manual", targets: { targets }, config: buildLibraryJobConfig(cfg, false) });
  if (plan.items.length > 0) recordLibraryAttempts(job.id, plan.items.map((i) => i.songId));
  if (targets.length === 0) {
    updateFetchJobStatus(job.id, "done");
    return { triggered: true, reason: "empty", enqueued: 0, jobId: job.id };
  }
  startFetchJob(job.id);
  log.info(`[LIBRARY-AUTO-SCHED] triggered: ${targets.length} song(s), job=${job.id}`);
  return { triggered: true, reason: "started", enqueued: targets.length, jobId: job.id };
}

/** 挂载调度循环（幂等：重复调用只挂一次）。 */
export function startLibraryScheduler(): void {
  if (started) return;
  started = true;
  const tick = (): void => {
    if (ticking) return;
    ticking = true;
    try {
      const cfg = currentFetchConfig();
      if (!cfg.libraryAutoEnabled) return;
      runAutoLibraryOnce(cfg);
    } catch (e) {
      log.warn("[LIBRARY-AUTO-SCHED] tick failed: " + (e instanceof Error ? e.message : String(e)));
    } finally {
      ticking = false;
    }
  };
  setTimeout(tick, BOOT_DELAY_MS);
  setInterval(tick, POLL_MS);
}
