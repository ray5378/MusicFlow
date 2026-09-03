// ==================== 每日定时任务调度器 ====================
//
// 每天在**可配置的具体时刻**(HH:MM)触发一次全量同步管线。相比原先写死的
// 「整点 hour」三点改进:
//   1. 时间粒度到分钟:`daily_recommend_time` = "HH:MM"(默认 "03:00");
//   2. 兼容旧设置:没有 time 时回退读 `daily_recommend_hour`(整点);
//   3. 配置改动可立即生效:对外暴露 rearmDailyScheduler(),设置接口保存后调用,
//      清掉旧的 setTimeout 重排下一次(原来改完要等下一次循环才生效)。
//
// 用 setTimeout 递归而非 setInterval:重启/改时间都能重算目标时刻,不累积漂移。
// re-arm 放在 finally:任何异常都不能让定时器链断掉(历史上曾因抛错导致多天停更)。

import { sqlite } from "../db/index.js";
import { createLogger } from "../utils/logger.js";

const log = createLogger("daily-scheduler");

/** 未在 settings 里配置时的默认执行时刻。 */
export const DEFAULT_DAILY_TIME = "03:00";

type DailyRunner = () => Promise<void>;

let pendingTimer: ReturnType<typeof setTimeout> | null = null;
let runner: DailyRunner | null = null;

/** 注册「到点要跑什么」(由 index.ts 注入,避免本模块反向依赖启动流程)。 */
export function setDailyRunner(fn: DailyRunner): void {
  runner = fn;
}

/** 每日任务总开关(settings.daily_recommend_enabled,默认开)。 */
export function getDailyMasterEnabled(): boolean {
  const row = sqlite.prepare("SELECT value FROM settings WHERE key = ?").get("daily_recommend_enabled") as any;
  const v = row?.value ?? "true";
  return v === "true" || v === "1";
}

/**
 * 读取配置的每日执行时刻,返回 { hour, minute }。
 * 优先 `daily_recommend_time`("HH:MM"),缺失/非法时回退 `daily_recommend_hour`(整点)。
 */
export function getDailyTime(): { hour: number; minute: number } {
  const row = sqlite.prepare("SELECT value FROM settings WHERE key = ?").get("daily_recommend_time") as any;
  const raw = typeof row?.value === "string" ? row.value.trim() : "";
  const m = /^(\d{1,2}):(\d{1,2})$/.exec(raw);
  if (m) {
    const hour = parseInt(m[1], 10);
    const minute = parseInt(m[2], 10);
    if (hour >= 0 && hour <= 23 && minute >= 0 && minute <= 59) return { hour, minute };
  }
  // 回退:旧版只支持整点
  const hourRow = sqlite.prepare("SELECT value FROM settings WHERE key = ?").get("daily_recommend_hour") as any;
  const hour = parseInt(hourRow?.value ?? "3", 10);
  return { hour: Number.isFinite(hour) && hour >= 0 && hour <= 23 ? hour : 3, minute: 0 };
}

/** 格式化成 "HH:MM"(供日志与接口回显)。 */
export function formatDailyTime(): string {
  const { hour, minute } = getDailyTime();
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

/** 计算下一次目标时刻(今天该时刻已过则顺延到明天)。 */
export function nextDailyRunAt(now: Date = new Date()): Date {
  const { hour, minute } = getDailyTime();
  const next = new Date(now);
  next.setHours(hour, minute, 0, 0);
  if (next <= now) next.setDate(next.getDate() + 1);
  return next;
}

function clearPendingTimer(): void {
  if (pendingTimer) {
    clearTimeout(pendingTimer);
    pendingTimer = null;
  }
}

function schedule(): void {
  clearPendingTimer();
  const next = nextDailyRunAt();
  const delay = next.getTime() - Date.now();
  pendingTimer = setTimeout(async () => {
    try {
      if (getDailyMasterEnabled() && runner) await runner();
    } catch (e: any) {
      log.error("daily run error", { err: e?.message || e });
    } finally {
      schedule(); // re-arm(在 finally,异常也不能断链)
    }
  }, delay);
  log.info(`next daily run at ${next.toLocaleString("zh-CN", { hour12: false })} (in ${Math.round(delay / 60000)} min)`);
}

/** 启动调度器(进程启动时调用一次)。 */
export function startDailyScheduler(): void {
  schedule();
}

/**
 * 配置变更后立即重排下一次执行时刻。
 * 由 PUT /v1/daily-recommend/config 调用,避免改完时间要等 24h 才生效。
 */
export function rearmDailyScheduler(): void {
  schedule();
}
