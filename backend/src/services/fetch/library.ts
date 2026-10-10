// ==================== MusicFetch 全库平台音乐下载（手动按钮）====================
//
// 语义：一键把「库里本地没有实体文件」的歌逐首交给平台音源下载到本地。
//   - 范围（产品已确认 2026-10-10）：`songs.path NOT LIKE 'l:%' AND path NOT LIKE 'w:%'`
//     —— 即「本地磁盘源」与「WebDAV 源」都没有实体文件的行（240 生产 134,500 行中占 82,256）。
//     已有实体文件的歌会被 `skipIfInLibrary`（existing.ts 只认 l:/w: 物理行）自动挡掉，不重复下载。
//   - 触发：**直接开始**（无预览确认），单批上限 `libraryBatchLimit`（默认 500），可反复点。
//   - 成功后：把原 `web` 行「迁移」成指向新本地文件的行（保住旧行 id，歌单/收藏不失效），
//     由 orchestrator 的 `migrateRowOnly` 模式驱动 —— **只迁移库行，绝不删任何文件**。
//
// 🔴 为什么必须落一张「已尝试」表：任务 items 只存在 `fetch_jobs.items_json`
// （jobStore.ts 顶部注释明确「不做拆表」），无法反查「这首歌试过没有」。若只靠上面的
// path 过滤，**下载失败的歌（无候选 / BELOW_BAR）会每次都被重新选中**，按钮会永远卡在
// 同一批 500 首。`fetch_library_attempts` 用 `song_id` 主键 + `INSERT OR IGNORE` 天然幂等；
// `resetLibraryAttempts()` 供「重跑失败项」用。

import { sqlite } from "../../db/index.js";
import type { FetchTarget } from "./candidates.js";
import type { FetchConfig } from "./config.js";

/** 全库下载 target id 前缀（orchestrator 据此 + `sourceData.library` 定位旧行）。 */
export const LIBRARY_TARGET_PREFIX = "library:";

/** 单曲计划项（`path` 是原库行路径，仅作审计；migrateRowOnly 下不参与删文件）。 */
export interface LibraryPlanItem {
  songId: string;
  path: string;
  title: string;
  artist: string;
  album: string;
  durationSec: number;
  suffix: string;
  bitRate: number;
}

export interface LibraryPlan {
  /** 库里「本地无实体文件」的行总数（含已尝试的）。 */
  total: number;
  /** 已尝试过的行数。 */
  attempted: number;
  /** 待尝试行数（应用 songIds 白名单过滤后）。 */
  pending: number;
  /** 本次将排入的数量。 */
  willEnqueue: number;
  /** 是否因 limit 截断（还有更多待尝试）。 */
  truncated: boolean;
  items: LibraryPlanItem[];
}

let ensured = false;

/** 幂等建「已尝试」表（本仓无迁移框架，CREATE TABLE IF NOT EXISTS 即可）。 */
export function ensureLibraryAttemptsTable(): void {
  if (ensured) return;
  sqlite
    .prepare(
      `CREATE TABLE IF NOT EXISTS fetch_library_attempts (
         song_id      TEXT PRIMARY KEY,
         attempted_at TEXT NOT NULL,
         batch_id     TEXT NOT NULL,
         status       TEXT NOT NULL DEFAULT 'queued'
       )`,
    )
    .run();
  ensured = true;
}

/**
 * 收集「本地无实体文件」的行，**按 `rowid` 升序**（稳定顺序，保证「下一批」可持续推进）。
 * 单查询失败抛错由调用方兜（与 `collectUpgradeSongs` 的容错层级一致）。
 */
export function collectLibrarySongs(): LibraryPlanItem[] {
  ensureLibraryAttemptsTable();
  const rows = sqlite
    .prepare(
      `SELECT id, path, title, COALESCE(artist,'') AS artist, COALESCE(album,'') AS album,
              COALESCE(duration,0) AS duration, COALESCE(suffix,'') AS suffix, COALESCE(bit_rate,0) AS bit_rate
         FROM songs
        WHERE path NOT LIKE 'l:%' AND path NOT LIKE 'w:%'
        ORDER BY rowid ASC`,
    )
    .all() as Array<Record<string, unknown>>;
  return rows.map((r) => ({
    songId: String(r.id ?? ""),
    path: String(r.path ?? ""),
    title: String(r.title ?? ""),
    artist: String(r.artist ?? ""),
    album: String(r.album ?? ""),
    durationSec: Number(r.duration ?? 0) || 0,
    suffix: String(r.suffix ?? ""),
    bitRate: Number(r.bit_rate ?? 0) || 0,
  }));
}

/** 已尝试过的 songId 集合。 */
export function collectAttemptedSongIds(): Set<string> {
  ensureLibraryAttemptsTable();
  const rows = sqlite.prepare("SELECT song_id FROM fetch_library_attempts").all() as Array<{
    song_id: string;
  }>;
  return new Set(rows.map((r) => String(r.song_id ?? "")));
}

/** 记录「这一批已尝试」（`INSERT OR IGNORE` 幂等，重复点不会膨胀）。 */
export function recordLibraryAttempts(batchId: string, songIds: string[]): void {
  ensureLibraryAttemptsTable();
  const now = new Date().toISOString();
  const stmt = sqlite.prepare(
    "INSERT OR IGNORE INTO fetch_library_attempts (song_id, attempted_at, batch_id, status) VALUES (?, ?, ?, 'queued')",
  );
  const tx = sqlite.transaction((ids: string[]) => {
    for (const id of ids) if (id) stmt.run(id, now, batchId);
  });
  tx(songIds);
}

/** 清空尝试记录（重跑失败项用），返回清除行数。 */
export function resetLibraryAttempts(): number {
  ensureLibraryAttemptsTable();
  const res = sqlite.prepare("DELETE FROM fetch_library_attempts").run();
  return Number(res?.changes ?? 0);
}

/**
 * 生成计划：全量 → 剔除已尝试 → （可选）按 songIds 白名单收窄 → 按 limit 截断。
 * `limit` 缺省 / 0 → 只回统计、`items` 为空。
 */
export function buildLibraryPlan(
  _cfg: FetchConfig,
  opts?: { limit?: number; songIds?: string[] },
): LibraryPlan {
  const all = collectLibrarySongs();
  const done = collectAttemptedSongIds();
  const total = all.length;

  const wanted =
    Array.isArray(opts?.songIds) && opts!.songIds!.length > 0
      ? new Set(opts!.songIds!.map((v) => String(v)))
      : null;
  const pool = all.filter((r) => !done.has(r.songId) && (!wanted || wanted.has(r.songId)));

  const capRaw =
    typeof opts?.limit === "number" && Number.isFinite(opts.limit) ? Math.floor(opts.limit) : 0;
  const items = capRaw > 0 ? pool.slice(0, capRaw) : [];
  return {
    total,
    attempted: total - all.filter((r) => !done.has(r.songId)).length,
    pending: pool.length,
    willEnqueue: items.length,
    truncated: capRaw > 0 && pool.length > items.length,
    items,
  };
}

/**
 * 组装 targets。**`sourceData` 必须包一层 `library` 字段**（与洗版的 `upgrade` 同一手法），
 * 否则会被当成平台歌曲 id 触发无意义的取链预解析。
 */
export function buildLibraryTargets(items: LibraryPlanItem[]): FetchTarget[] {
  return items.map((it) => ({
    id: `${LIBRARY_TARGET_PREFIX}${it.songId}`,
    title: it.title,
    ...(it.artist ? { artist: it.artist } : {}),
    ...(it.album ? { album: it.album } : {}),
    ...(it.durationSec > 0 ? { durationSec: it.durationSec } : {}),
    sourceData: JSON.stringify({
      library: {
        songId: it.songId,
        path: it.path,
        suffix: it.suffix,
        bitRate: it.bitRate,
      },
    }),
  }));
}

/** 全库下载任务的 config_json：只加 `__library` 开关，其余沿用普通下载配置。 */
export function buildLibraryJobConfig(cfg: FetchConfig, dryRun?: boolean): Record<string, unknown> {
  return {
    ...cfg,
    ...(dryRun ? { dryRun: true } : {}),
    __library: { migrateRowOnly: true },
  };
}
