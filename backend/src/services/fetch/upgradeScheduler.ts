// ==================== 定时自动洗版调度器 ====================
//
// 产品语义（2026-10-10 确认）：
//   - 默认**关闭**（upgradeAutoEnabled=false）；开启后每 upgradeAutoIntervalDays 天、
//     在当日 upgradeAutoTimeOfDay（服务器本地时区）之后的第一个轮询点触发一次。
//   - 失败也进冷却（与手动触发同一张 fetch_upgrade_attempts 表），触发是「尽力而为」：
//     有可洗目标就建任务，没有就空跑落 lastRunAt（别每分钟重扫全库）。
//   - 防重入：模块级锁 + 已有 pending/running 的 fetch 任务时跳过本轮。
//   - lastRunAt 落 settings（fetch.upgrade.auto.lastRunAt）：重启按持久化时间判断，
//     不会在重启风暴里重复触发；到点时若没开机，开机后的第一轮补跑。

import { sqlite } from "../../db/index.js";
import { createLogger } from "../../utils/logger.js";
import { getSetting, setSetting } from "../settings.js";
import { DEFAULT_DOWNLOAD_ROOT, type FetchConfig } from "./config.js";
import { currentFetchConfig } from "./configStore.js";
import { ensureDownloadSource } from "./source.js";
import { buildUpgradeJobConfig, buildUpgradePlan, buildUpgradeTargets, recordUpgradeAttempts } from "./upgrade.js";
import { createFetchJob, updateFetchJobStatus } from "./jobStore.js";
import { startFetchJob } from "./jobRunner.js";
import { cleanExpiredFetchJobs } from "./jobStore.js";

const log = createLogger("upgrade-scheduler");

const LAST_RUN_KEY = "fetch.upgrade.auto.lastRunAt";
const POLL_MS = 60_000;
const BOOT_DELAY_MS = 15_000;

let started = false;
let ticking = false;
let lastJobCleanAt = 0;

/** "HH:mm" → 今天该时刻的本地时间戳；非法格式返回 0（视为永不触发）。 */
export function todayTriggerMs(timeOfDay: string, now = new Date()): number {
  const m = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(String(timeOfDay ?? "").trim());
  if (!m) return 0;
  return new Date(now.getFullYear(), now.getMonth(), now.getDate(), Number(m[1]), Number(m[2]), 0, 0).getTime();
}

function hasActiveFetchJobs(): boolean {
  try {
    const row = sqlite
      .prepare("SELECT COUNT(*) AS n FROM fetch_jobs WHERE status IN ('pending','running')")
      .get() as { n?: number };
    return Number(row?.n ?? 0) > 0;
  } catch {
    return true; // 查不动就当有任务在跑，宁可少触发
  }
}

/** 判定 + 执行一轮自动洗版（同步可测，不做任何 sleep；供调度循环与测试调用）。 */
export function runAutoUpgradeOnce(
  cfg: FetchConfig,
  nowMs = Date.now(),
): { triggered: boolean; reason: string; enqueued?: number; jobId?: string } {
  const last = Number(getSetting(LAST_RUN_KEY, "0")) || 0;
  const days = Math.min(365, Math.max(1, Math.floor(cfg.upgradeAutoIntervalDays > 0 ? cfg.upgradeAutoIntervalDays : 30)));
  if (nowMs - last < days * 86_400_000) return { triggered: false, reason: "interval" };
  const triggerMs = todayTriggerMs(cfg.upgradeAutoTimeOfDay, new Date(nowMs));
  if (triggerMs <= 0 || nowMs < triggerMs) return { triggered: false, reason: "time-of-day" };
  if (hasActiveFetchJobs()) return { triggered: false, reason: "busy" };

  // 无论有没有可洗目标，评估完都落 lastRunAt：空跑也别每分钟重扫。
  setSetting(LAST_RUN_KEY, String(nowMs));

  // 洗版范围：显式 sourceIds > 回落「/MUSIC/DOWNLOAD 对应的源」（与路由同口径）。
  const sourceIds =
    Array.isArray(cfg.upgradeSourceIds) && cfg.upgradeSourceIds.length > 0
      ? [...cfg.upgradeSourceIds]
      : [ensureDownloadSource(DEFAULT_DOWNLOAD_ROOT).sourceId];
  const plan = buildUpgradePlan(sourceIds, cfg, {});
  const targets = buildUpgradeTargets(plan.items); // 结构即 FetchTarget，无需 normalize
  const job = createFetchJob({ kind: "manual", targets: { targets }, config: buildUpgradeJobConfig(cfg, false) });
  if (plan.items.length > 0) recordUpgradeAttempts(job.id, plan.items.map((i) => i.songId));
  if (targets.length === 0) {
    updateFetchJobStatus(job.id, "done");
    return { triggered: true, reason: "empty", enqueued: 0, jobId: job.id };
  }
  startFetchJob(job.id);
  log.info("[UPGRADE-AUTO] triggered: " + targets.length + " song(s), job=" + job.id);
  return { triggered: true, reason: "started", enqueued: targets.length, jobId: job.id };
}

/** 挂载调度循环（幂等：重复调用只挂一次）。 */
export function startUpgradeScheduler(): void {
  if (started) return;
  started = true;
  const tick = (): void => {
    if (ticking) return;
    ticking = true;
    try {
      const cfg = currentFetchConfig();
      // 任务记录自动清理：每小时最多一次（retentionDays<=0 = 关闭）；挂在调度
      // tick 上而非独立定时器，避免多一个常驻 interval。
      if (Date.now() - lastJobCleanAt > 3_600_000) {
        lastJobCleanAt = Date.now();
        try {
          const cleaned = cleanExpiredFetchJobs(cfg.jobRetentionDays);
          if (cleaned > 0) log.info(`[JOB-CLEAN] 已清理 ${cleaned} 条过期任务记录（保留 ${cfg.jobRetentionDays} 天）`);
        } catch {
          /* 清理失败不影响调度 */
        }
      }
      if (!cfg.upgradeAutoEnabled) return;
      runAutoUpgradeOnce(cfg);
    } catch (e) {
      log.warn("[UPGRADE-AUTO] tick failed: " + (e instanceof Error ? e.message : String(e)));
    } finally {
      ticking = false;
    }
  };
  setTimeout(tick, BOOT_DELAY_MS);
  setInterval(tick, POLL_MS);
}
