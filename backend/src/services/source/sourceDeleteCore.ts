// ==================== 音源删除的批处理内核 ====================
//
// 为什么单独抽出来:删一个两万首的源要几十个批次、每批一个同步事务。better-sqlite3
// 是同步的,放在主进程会把事件循环按住,前端请求全部排队(2026-11 实测用户看到「卡住」)。
// 所以正式运行由**独立子进程**执行本内核(sourceDeleteWorker.ts),主进程只落进度;
// VITEST 下不拉子进程(测试进程没有构建产物),在主进程跑同一份内核,两条路径行为一致。
//
// 取批 SQL 用「范围比较」而不是 LIKE:
//   `path LIKE 's:id:%'` 走不了 idx_songs_path(LIKE 默认大小写不敏感,索引是 BINARY),
//   实测 EXPLAIN=SCAN songs —— 每批全表扫 15 万行 ×3 前缀。改成 `path >= 's:id:' AND
//   path < 's:id;'`(';' 是 ':' 的下一个 ASCII)后实测 SEARCH USING INDEX idx_songs_path。
import type { Database } from "better-sqlite3";
import { cleanupOrphans } from "./scanner.js";

/** 每批删除条数:400 个绑定参数远低于 SQLite 变量上限,事务也不会过大。 */
export const BATCH = 400;
/** 依赖 songs 的表(都靠 song_id/row_id 外键,先删)。 */
const DEP_TABLES = ["playlist_songs", "user_favorite_songs", "play_history", "study_progress", "study_playlist_progress"] as const;
const WHERE = "(path >= ? AND path < ?) OR (path >= ? AND path < ?) OR (path >= ? AND path < ?)";

/** LIKE 前缀 → 范围区间 [lo, hi);hi 用 ';' 是因为 ':' 的下一个 ASCII 就是 ';'。 */
export function deleteRanges(id: string): string[] {
  return ["w", "s", "l"].flatMap((k) => [`${k}:${id}:`, `${k}:${id};`]);
}

/** 该源名下歌曲数(区间走 path 索引,不做全表扫)。 */
export function countSourceSongs(sqlite: Database, id: string): number {
  const row = sqlite.prepare(`SELECT count(*) AS n FROM songs WHERE ${WHERE}`).get(...deleteRanges(id)) as any;
  return Number(row?.n || 0);
}

export function upsertDeleteJob(sqlite: Database, id: string, total: number): void {
  const now = Date.now();
  sqlite
    .prepare(
      `INSERT INTO source_delete_jobs (source_id, total, removed, status, error, created_at, updated_at)
       VALUES (?, ?, 0, 'running', NULL, ?, ?)
       ON CONFLICT(source_id) DO UPDATE SET total = excluded.total, status = 'running', error = NULL, updated_at = excluded.updated_at`,
    )
    .run(id, total, now, now);
}

function bumpDeleteJob(sqlite: Database, id: string, n: number): void {
  sqlite
    .prepare("UPDATE source_delete_jobs SET removed = removed + ?, updated_at = ? WHERE source_id = ?")
    .run(n, Date.now(), id);
}

export function markDeleteJobFailed(sqlite: Database, id: string, err: unknown): void {
  const msg = String((err as any)?.message || err);
  sqlite
    .prepare("UPDATE source_delete_jobs SET status = 'failed', error = ?, updated_at = ? WHERE source_id = ?")
    .run(msg, Date.now(), id);
}

/**
 * 批删循环。返回已删除条数。
 * shouldStop 用于子进程发现父进程已退出时提前收手(任务留在库里,下次启动续删)。
 */
export async function runSourceDelete(
  sqlite: Database,
  id: string,
  opts: { shouldStop?: () => boolean } = {},
): Promise<number> {
  let removed = 0;
  for (;;) {
    if (opts.shouldStop?.()) return removed;
    const ids = (sqlite.prepare(`SELECT id FROM songs WHERE ${WHERE} LIMIT ${BATCH}`).all(...deleteRanges(id)) as any[])
      .map((r) => String(r.id))
      .filter(Boolean);
    if (ids.length === 0) break;
    const ph = ids.map(() => "?").join(",");
    const del = sqlite.transaction(() => {
      for (const table of DEP_TABLES) {
        sqlite.prepare(`DELETE FROM ${table} WHERE song_id IN (${ph})`).run(...ids);
      }
      sqlite.prepare(`DELETE FROM audio_analysis WHERE row_id IN (${ph})`).run(...ids);
      sqlite.prepare(`DELETE FROM songs WHERE id IN (${ph})`).run(...ids);
    });
    del();
    removed += ids.length;
    bumpDeleteJob(sqlite, id, ids.length);
    // 让出事件循环:即使是主进程回退路径,首页/播放请求也不能被憋住。
    await new Promise((r) => setImmediate(r));
  }
  return removed;
}

/** 收尾:清孤儿专辑/艺人 → 删源行 → 删任务行(顺序不可换,源行是任务的外键锚点)。 */
export function finalizeSourceDelete(sqlite: Database, id: string): void {
  cleanupOrphans();
  sqlite.prepare("DELETE FROM media_sources WHERE id = ?").run(id);
  sqlite.prepare("DELETE FROM source_delete_jobs WHERE source_id = ?").run(id);
}
