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
//
// PATCH21 死链判定（2026-10-11）：本表再加两列承载「永久失效」证据——
//   - error_code：最近一次终态的错误码（判定与观测用）；
//   - fail_count：连续「资源不存在类」失败的累计次数（成功归零，可恢复类失败不动）；
//   连续达到阈值（config.deadSongPurgeThreshold）即交由 deadSongPurge.ts 从曲库移除，
//   并把引用它的歌单条目转成未匹配。
//
//   纪律：**只有 PERMANENT_FAILURE_CODES 才计数**。把网络抖动（TIMEOUT / STALL /
//   HTTP_5XX）、传输残缺（HTTP_4XX 里的 408/429/416）、配置问题（TOO_LARGE /
//   SSRF_BLOCKED / DISK_FULL）或质量不达标（BELOW_BAR / FAKE_LOSSLESS）也算进来，
//   会把「重试一次就能下成功」的歌误删，且删掉后连在线播放都没了。
//
// 【2026-10-11 定调 B】冷却口径补一条：**永久失效类不进冷却**（见 shouldSkipByCooldown）。
//   资源不存在类不会自愈 —— 等冷却期满再试，结果只会一模一样。而 `downloadCooldownDays`
//   默认 30 天 > 全库自动任务间隔（默认 15 天）时，同一首歌**永远只失败一次**，
//   fail_count 停在 1 → 死链清理（阈值 2）永远达不到 → 清理功能形同关闭
//   （240 生产实测：`fail_count>=2` 条数恒为 0）。所以永久失效类每轮照常重试，
//   可恢复类仍按窗口冷却（避免网络抖动被反复重试打爆源）。

import { sqlite } from "../../db/index.js";
import { createLogger } from "../../utils/logger.js";
import type { FetchTarget } from "./candidates.js";
import type { FetchConfig } from "./config.js";
import type { FetchErrorCode } from "./types.js";

const log = createLogger("fetch-attempts");

let ensured = false;

const CREATE_SQL = `CREATE TABLE IF NOT EXISTS fetch_download_attempts (
   song_key     TEXT PRIMARY KEY,
   attempted_at TEXT NOT NULL,
   batch_id     TEXT NOT NULL,
   status       TEXT NOT NULL,
   error_code   TEXT,
   fail_count   INTEGER NOT NULL DEFAULT 0
 )`;

/** 幂等建「下载尝试」表；旧结构（缺 error_code / fail_count）就地重建。 */
export function ensureDownloadAttemptsTable(): void {
  if (ensured) return;
  try {
    sqlite.prepare(CREATE_SQL).run();
    // 结构升级：PATCH21 之前的旧表只有 4 列。本表是「可轮转」临时表（窗口外即弃），
    // 重建代价 = 最多重试一次，故直接 DROP 重建，不写逐列幂等搬迁。
    const cols = (
      sqlite.prepare(`PRAGMA table_info(fetch_download_attempts)`).all() as { name?: unknown }[]
    ).map((c) => String(c?.name ?? ""));
    if (!cols.includes("error_code") || !cols.includes("fail_count")) {
      sqlite.prepare(`DROP TABLE fetch_download_attempts`).run();
      sqlite.prepare(CREATE_SQL).run();
      log.warn("fetch_download_attempts 旧结构已重建（新增 error_code / fail_count）");
    }
  } catch (e) {
    log.warn(`下载尝试台账建表/升级失败（降级为无台账）: ${e instanceof Error ? e.message : e}`);
  }
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
 * 「资源不存在类」白名单——只有这些错误码才累计永久失效计数。
 *
 * 判定依据：资源在源站确实不存在，或源站持续返回残缺内容，重试/换链都无法解决。
 *   - NO_CANDIDATE    所有源都搜不到候选（连续多次才是证据，见 orchestrator 的源故障保护）
 *   - HTTP_404/410/451 不存在 / 已下架 / 法律原因不可用
 *   - INTEGRITY_FAILED 字节残缺 / 文件头不对 / 拿不到时长（用户明确要求一并处理）
 *
 * **绝不加入**：BELOW_BAR / FAKE_LOSSLESS（歌存在，只是不满足下载质量门槛，删了就
 * 连在线播放都没了）、TIMEOUT / STALL / HTTP_5XX / FETCH_FAILED / TOO_LARGE /
 * SSRF_BLOCKED / DISK_FULL / MOVE_FAILED / TAG_FAILED / TRANSCODE_FAILED /
 * SCAN_FAILED / UNKNOWN（全部可恢复，且多为环境/配置问题）。
 */
export const PERMANENT_FAILURE_CODES: readonly FetchErrorCode[] = [
  "NO_CANDIDATE",
  "HTTP_404",
  "HTTP_410",
  "HTTP_451",
  "INTEGRITY_FAILED",
];

const PERMANENT_CODE_SET = new Set<string>(PERMANENT_FAILURE_CODES);

/** 该错误码是否属于「资源不存在类」（命中才累计永久失效计数）。 */
export function isPermanentFailureCode(code: string | undefined | null): boolean {
  return !!code && PERMANENT_CODE_SET.has(code);
}

/**
 * 记录一次尝试（UPSERT 覆盖最近时间），并轮转清理冷却窗口外的旧行。
 * `cooldownDays <= 0` 时只记不清（调用方通常在关闭开关时根本不调，这里兜底）。
 *
 * `opts.permanent === true`（且 status 为 failed）才把 fail_count +1；done 归零；
 * 其余（可恢复失败）保持不变 —— 「连续」按「没被成功打断」理解。
 */
export function recordDownloadAttempt(
  songKey: string,
  batchId: string,
  status: "done" | "failed",
  cooldownDays: number,
  opts?: { errorCode?: string; permanent?: boolean },
): void {
  if (!songKey) return;
  ensureDownloadAttemptsTable();
  const now = new Date().toISOString();
  const permanentHit = status === "failed" && opts?.permanent === true ? 1 : 0;
  const errorCode = status === "done" ? null : (opts?.errorCode ?? null);
  const tx = sqlite.transaction(() => {
    sqlite
      .prepare(
        `INSERT INTO fetch_download_attempts (song_key, attempted_at, batch_id, status, error_code, fail_count)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(song_key) DO UPDATE SET
           attempted_at = excluded.attempted_at,
           batch_id     = excluded.batch_id,
           status       = excluded.status,
           error_code   = excluded.error_code,
           fail_count   = CASE
                            WHEN excluded.status = 'done' THEN 0
                            WHEN excluded.fail_count = 1
                              THEN fetch_download_attempts.fail_count + 1
                            ELSE fetch_download_attempts.fail_count
                          END`,
      )
      .run(songKey, now, batchId, status, errorCode, permanentHit);
    // 轮转：窗口外旧行即弃（「可轮转库」）。窗口取冷却天数（≥1，0/负数不轮转仅兜底）。
    const days = Math.max(1, Math.floor(cooldownDays));
    sqlite
      .prepare(`DELETE FROM fetch_download_attempts WHERE attempted_at < ?`)
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

/**
 * 冷却判定（2026-10-11 定调 B）：**永久失效类不进冷却**。
 *
 * `isRecentlyAttempted` 是无差别的「最近试过就跳过」。但 `PERMANENT_FAILURE_CODES`
 * （NO_CANDIDATE / HTTP_404 / HTTP_410 / HTTP_451 / INTEGRITY_FAILED）表征「资源在源站
 * 确实不存在」，冷却期满也不会自愈 —— 等下去只会让 `fail_count` 永远停在 1，
 * `deadSongPurge` 的 `fail_count >= 阈值（默认 2）` 永远达不到，**死链清理形同关闭**。
 *
 * 生产实证（240，2026-10-11）：`downloadCooldownDays=30` > 全库自动任务间隔 15 天，
 * 同一首歌永远只失败一次 → 台账 `fail_count>0 = 126 条` 而 `fail_count>=2 = 0 条`。
 *
 * 所以本函数是「窗口内试过 **且** 最近一次终态不是永久失效类」才返回 true（跳过）。
 * 可恢复失败（TIMEOUT / STALL / HTTP_5XX / TOO_LARGE / BELOW_BAR …）仍照常冷却。
 */
export function shouldSkipByCooldown(songKey: string, cooldownDays: number): boolean {
  if (!songKey || !(cooldownDays > 0)) return false;
  ensureDownloadAttemptsTable();
  const row = sqlite
    .prepare(`SELECT attempted_at, error_code FROM fetch_download_attempts WHERE song_key = ?`)
    .get(songKey) as { attempted_at?: string; error_code?: string | null } | undefined;
  if (!row?.attempted_at) return false;
  const at = Date.parse(row.attempted_at);
  if (!Number.isFinite(at)) return false;
  if (Date.now() - at >= Math.floor(cooldownDays) * 86_400_000) return false;
  // 永久失效类不冷却：必须每轮重试才能把 fail_count 累积到清理阈值。
  if (isPermanentFailureCode(row.error_code)) return false;
  return true;
}

/** 台账行数（观测/测试用）。 */
export function downloadAttemptCount(): number {
  ensureDownloadAttemptsTable();
  const r = sqlite.prepare(`SELECT COUNT(*) AS n FROM fetch_download_attempts`).get() as {
    n?: number;
  };
  return Number(r?.n ?? 0);
}

/** 单键的失败计数（测试/观测用）。 */
export function downloadFailCount(songKey: string): number {
  ensureDownloadAttemptsTable();
  const r = sqlite
    .prepare(`SELECT fail_count FROM fetch_download_attempts WHERE song_key = ?`)
    .get(songKey) as { fail_count?: unknown } | undefined;
  const n = Number(r?.fail_count ?? 0);
  return Number.isFinite(n) ? n : 0;
}

/** 达到永久失效阈值的键（供 deadSongPurge 消费）。阈值 < 1 时返回空。 */
export function listPermanentFailureKeys(
  threshold: number,
): { songKey: string; errorCode: string | null; failCount: number }[] {
  const t = Math.floor(Number(threshold));
  if (!Number.isFinite(t) || t < 1) return [];
  ensureDownloadAttemptsTable();
  const rows = sqlite
    .prepare(
      `SELECT song_key, error_code, fail_count FROM fetch_download_attempts
        WHERE fail_count >= ? ORDER BY fail_count DESC, attempted_at ASC`,
    )
    .all(t) as { song_key?: unknown; error_code?: unknown; fail_count?: unknown }[];
  return rows.map((r) => ({
    songKey: String(r.song_key ?? ""),
    errorCode: r.error_code == null ? null : String(r.error_code),
    failCount: Number(r.fail_count ?? 0),
  }));
}

/**
 * 回滚一次永久失败计数（下限 0）。
 * 用途：源的**整体故障保护** —— 某轮任务里 NO_CANDIDATE 占比过高说明「源集体挂了」
 * 而不是「这批歌都死了」，此时把本轮误加的计数退回去，避免一次插件故障清空曲库。
 */
export function rollbackPermanentFailure(songKey: string): void {
  if (!songKey) return;
  ensureDownloadAttemptsTable();
  sqlite
    .prepare(
      `UPDATE fetch_download_attempts
          SET fail_count = CASE WHEN fail_count > 0 THEN fail_count - 1 ELSE 0 END
        WHERE song_key = ?`,
    )
    .run(songKey);
}

/** 删除某键的台账行（死链清理完成后调用，避免重复清理同一首歌）。 */
export function clearDownloadAttempt(songKey: string): void {
  if (!songKey) return;
  ensureDownloadAttemptsTable();
  sqlite.prepare(`DELETE FROM fetch_download_attempts WHERE song_key = ?`).run(songKey);
}

/** 冷却跳过时 items 里带的 errorCode（前端/日志可辨识）。 */
export const DOWNLOAD_COOLDOWN_CODE = "COOLDOWN_SKIPPED" as const;

/** 从配置取有效冷却天数（0 = 关闭，>0 且非有限数回落默认 7）。 */
export function effectiveCooldownDays(cfg: FetchConfig): number {
  const n = Math.floor(Number(cfg.downloadCooldownDays));
  if (!Number.isFinite(n) || n < 0) return 7;
  return Math.min(365, n);
}

/**
 * 默认「连续 N 次永久失败即移除」的阈值。
 *
 * 产品定调（2026-10-11）：**默认 2** —— 连续两次确认为「资源不存在类」失败即判死链。
 * 之所以敢这么激进，是因为移除是**可逆的**：歌单条目转未匹配时用 COALESCE 保留了
 * external_title/artist/album/duration 快照，之后点「一键在线匹配」就能重新挂回
 * （match.ts 的候选集正是 `!playable && !songId && externalTitle 非空`）。
 * 用户可以按需要调大（更保守），配置项 deadSongPurgeThreshold。
 */
export const DEFAULT_DEAD_SONG_PURGE_THRESHOLD = 2;

/** 从配置取有效死链清理阈值（0 = 关闭清理，非有限数回落默认 3，上限 20）。 */
export function effectiveDeadSongPurgeThreshold(cfg: FetchConfig): number {
  const n = Math.floor(Number(cfg.deadSongPurgeThreshold));
  if (!Number.isFinite(n) || n < 0) return DEFAULT_DEAD_SONG_PURGE_THRESHOLD;
  return Math.min(20, n);
}
