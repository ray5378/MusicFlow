// ==================== 媒体源每日定时增量扫描（产品定调 2026-10-10） ====================
//
// 每源可在 config JSON 里配 scanAutoEnabled / scanAutoTimeOfDay（HH:mm，服务器本地时区）。
// 闸门顺序（对齐 upgradeScheduler / libraryScheduler）：
//   enabled → scanAutoEnabled → 当日未跑过（按日界）→ 到点 → fire-and-forget 增量扫描。
// 触发即落 lastRunAt（每源独立 key）：当天不再重复，即使扫描排队/失败也等明天。
import { sqlite } from "../../db/index.js";
import { createLogger } from "../../utils/logger.js";
import { getSetting, setSetting } from "../settings.js";
import { runBatchJob } from "../../batch/runner.js";
import { todayTriggerMs } from "../fetch/upgradeScheduler.js";

const log = createLogger("scan-scheduler");

const POLL_MS = 60_000;
const BOOT_DELAY_MS = 20_000;

let started = false;
let ticking = false;

/** 判定 + 触发一轮（同步可测；返回本次触发扫描的源 id 列表）。 */
export function runScanSchedulerOnce(nowMs = Date.now()): string[] {
  const triggered: string[] = [];
  const rows = sqlite
    .prepare("SELECT id, name, type, config FROM media_sources WHERE enabled = 1")
    .all() as { id: string; name: string; type: string; config: string | null }[];
  const d = new Date(nowMs);
  const dayStart = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  for (const s of rows) {
    if (s.type !== "local" && s.type !== "webdav") continue;
    let cfg: { scanAutoEnabled?: boolean; scanAutoTimeOfDay?: string } = {};
    try {
      cfg = JSON.parse(s.config || "{}");
    } catch {
      continue;
    }
    if (!cfg.scanAutoEnabled) continue;
    const key = `scan.auto.lastRunAt.${s.id}`;
    const last = Number(getSetting(key, "0")) || 0;
    if (last >= dayStart) continue; // 今天已触发过
    const triggerMs = todayTriggerMs(String(cfg.scanAutoTimeOfDay || "03:00"), d);
    if (triggerMs <= 0 || nowMs < triggerMs) continue;
    setSetting(key, String(nowMs));
    triggered.push(s.id);
    void runBatchJob("scan", { sourceId: s.id, mode: "incremental" })
      .then((r) => {
        const st = (r as { result?: { added?: number; updated?: number; removed?: number; skipped?: number } })?.result ?? {};
        log.info(
          `[SCAN-AUTO] 源「${s.name}」定时增量扫描完成: +${st.added ?? 0} ~${st.updated ?? 0} -${st.removed ?? 0} skip=${st.skipped ?? 0}`,
        );
      })
      .catch((e) => log.warn(`[SCAN-AUTO] 源「${s.name}」定时扫描失败: ${String((e as Error)?.message || e)}`));
  }
  return triggered;
}

/** 挂载调度循环（幂等：重复调用只挂一次）。 */
export function startScanScheduler(): void {
  if (started) return;
  started = true;
  const tick = (): void => {
    if (ticking) return;
    ticking = true;
    try {
      runScanSchedulerOnce();
    } catch (e) {
      log.warn("[SCAN-AUTO] tick failed: " + (e instanceof Error ? e.message : String(e)));
    } finally {
      ticking = false;
    }
  };
  setTimeout(tick, BOOT_DELAY_MS);
  setInterval(tick, POLL_MS);
}
