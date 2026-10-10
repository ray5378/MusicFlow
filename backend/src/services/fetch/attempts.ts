// ==================== MusicFetch 下载尝试台账（可轮转）====================
//
// PATCH17 产品定调（2026-10-10）：下载任务要能「快速跳过最近试过的歌」——中断重跑、
// 反复触发都不再从头重来。与 fetch_library_attempts（全库专用、song_id 主键、
// INSERT OR IGNORE 只记第一次）不同，本表面向**所有下载模式**：
//   - 稳定键：库内歌用 songId（sourceData.library / sourceData.upgrade），无库行退回 target.id；
//   - 每次终态（done/failed）**UPSERT 覆盖**最新尝试时间 —— 「试过」看最近一次，不是第一次；
//   - 写入时顺手清掉冷却窗口外的旧行（**轮转**）：表大小 = 冷却期内的活跃曲目数，天然有界；
//   - processTarget 入口查表：冷却期内直接 skipped（不取候选、不预探、不下载），秒跳。
//
// 语义边界：中断（cancelled/子进程被杀）**不记** —— 没跑完的项重跑时照常处理；
// 只记「跑完且出了终态」的项。跳过（skipped，如已在库/冷却期内）也不记 —— 它本来就是
// 快速路径，记了反而把「冷却起点」不断往后推。

import { sqlite } from "../../db/index.js";
import type { FetchTarget } from "./candidates.js";
import type { FetchConfig } from "./config.js";

let ensured = false;

/** 幂等建「下载尝试」表（本仓无迁移框架，CREATE TABLE IF NOT EXISTS 即可）。 */
export function ensureDownloadAttemptsTable(): void {
  if (ensured) return;
  sqlite
    .prepare(
      `CREATE TABLE IF NOT EXISTS fetch_download_attempts (
         song_key     TEXT PRIMARY KEY,
         attempted_at TEXT NOT NULL,
         batch_id     TEXT NOT NULL,
         status       TEXT NOT NULL
       )`,
    )
    .run();
  ensured = true;
}

/**
 * 提取 target 的稳定键：优先库行 songId（全库下载 / 洗版元数据），退回 target.id。
 * 同一首歌无论从哪条入口（全库 / 手动 / 搜索导入）进来，键一致才能互相跳过。
 */
export function downloadAttemptKeyOf(t: FetchTarget): string {
  try {
    if (t.sourceData) {
      const sd = JSON.parse(t.sourceData) as {
        library?: { songId?: unknown };
        upgrade?: { oldSongId?: unknown };
      };
      const sid = sd.library?.songId ?? sd.upgrade?.oldSongId;
      if (typeof sid === "string" && sid) return sid;
      if (typeof sid === "number" && Number.isFinite(sid)) return String(sid);
    }
  } catch {
    /* sourceData 不是合法 JSON：退回 target.id */
  }
  return t.id;
}

/**
 * 记录一次尝试（UPSERT 覆盖最近时间），并轮转清理冷却窗口外的旧行。
 * `cooldownDays <= 0` 时只记不清（调用方通常在关闭开关时根本不调，这里兜底）。
 */
export function recordDownloadAttempt(
  songKey: string,
  batchId: string,
  status: "done" | "failed",
  cooldownDays: number,
): void {
  if (!songKey) return;
  ensureDownloadAttemptsTable();
  const now = new Date().toISOString();
  const tx = sqlite.transaction(() => {
    sqlite
      .prepare(
        `INSERT INTO fetch_download_attempts (song_key, attempted_at, batch_id, status)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(song_key) DO UPDATE SET attempted_at = excluded.attempted_at, batch_id = excluded.batch_id, status = excluded.status`,
      )
      .run(songKey, now, batchId, status);
    // 轮转：窗口外旧行即弃（「可轮转库」）。窗口取冷却天数（≥1，0/负数不轮转仅兜底）。
    const days = Math.max(1, Math.floor(cooldownDays));
    sqlite
      .prepare(
        `DELETE FROM fetch_download_attempts WHERE attempted_at < ?`,
      )
      .run(new Date(Date.now() - days * 86_400_000).toISOString());
  });
  tx();
}

/**
 * 冷却判定：该键在冷却窗口内试过 → true（跳过）。表不存在 / 窗口关闭 → false。
 */
export function isRecentlyAttempted(songKey: string, cooldownDays: number): boolean {
  if (!songKey || !(cooldownDays > 0)) return false;
  ensureDownloadAttemptsTable();
  const row = sqlite
    .prepare(`SELECT attempted_at FROM fetch_download_attempts WHERE song_key = ?`)
    .get(songKey) as { attempted_at?: string } | undefined;
  if (!row?.attempted_at) return false;
  const at = Date.parse(row.attempted_at);
  if (!Number.isFinite(at)) return false;
  return Date.now() - at < Math.floor(cooldownDays) * 86_400_000;
}

/** 台账行数（观测/测试用）。 */
export function downloadAttemptCount(): number {
  ensureDownloadAttemptsTable();
  const r = sqlite.prepare(`SELECT COUNT(*) AS n FROM fetch_download_attempts`).get() as {
    n?: number;
  };
  return Number(r?.n ?? 0);
}

/** 冷却跳过时 items 里带的 errorCode（前端/日志可辨识）。 */
export const DOWNLOAD_COOLDOWN_CODE = "COOLDOWN_SKIPPED" as const;

/** 从配置取有效冷却天数（0 = 关闭，>0 且非有限数回落默认 7）。 */
export function effectiveCooldownDays(cfg: FetchConfig): number {
  const n = Math.floor(Number(cfg.downloadCooldownDays));
  if (!Number.isFinite(n) || n < 0) return 7;
  return Math.min(365, n);
}
