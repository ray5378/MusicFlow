// ==================== 音源异步删除(断点续删) ====================
//
// 为什么不是同步 DELETE:一个 SMB 源动辄两万多首,同步删除会把 HTTP 请求挂几十秒,
// 前端超时、用户以为失败;更糟的是旧实现把整张 songs 表读进 JS 堆(17 万行),
// 160MB 堆直接 FATAL OOM,进程重启后删到一半的数据留在库里。
//
// 这里的约定:
//   - 进度落库(source_delete_jobs),前端轮询能看到「正在删除 x/y」;
//   - 每批 400 首,单事务删依赖行 + 歌曲行,内存恒定;
//   - 进程重启后 boot 调 resumePendingSourceDeletes(),按剩余的 LIKE 前缀继续删,
//     不重算、不重复(删过的行已经不在了,查询天然幂等);
//   - 全部删完才删 media_sources 行 —— 源在删完前仍存在,但接口把它标成 deleting。
import { eq } from "drizzle-orm";
import { db, sqlite } from "../../db/index.js";
import { mediaSources } from "../../db/schema.js";
import { createLogger } from "../../utils/logger.js";
import { cleanupOrphans } from "./scanner.js";
import { closeSmbSource } from "./smbClient.js";

const log = createLogger("SRC-DEL");

/** 每批删除条数:400 个绑定参数远低于 SQLite 变量上限,事务也不会过大。 */
const BATCH = 400;
/** 依赖 songs 的表(都靠 song_id/row_id 外键,先删)。 */
const DEP_TABLES = ["playlist_songs", "user_favorite_songs", "play_history"] as const;
const WHERE = "path LIKE ? OR path LIKE ? OR path LIKE ?";

/** 正在跑的源(防重复启动:轮询/重复点击/重启恢复都可能命中同一条)。 */
const running = new Set<string>();

export interface DeleteJob {
  source_id: string;
  total: number;
  removed: number;
  status: "running" | "failed";
  error: string | null;
  updated_at: number;
}

function prefixes(id: string): string[] {
  return [`w:${id}:%`, `s:${id}:%`, `l:${id}:%`];
}

/** 该源名下歌曲数(区间走 path 索引,不做全表扫)。 */
export function countSourceSongsFast(id: string): number {
  const row = sqlite.prepare(`SELECT count(*) AS n FROM songs WHERE ${WHERE}`).get(...prefixes(id)) as any;
  return Number(row?.n || 0);
}

function upsertJob(id: string, total: number): void {
  const now = Date.now();
  sqlite
    .prepare(
      `INSERT INTO source_delete_jobs (source_id, total, removed, status, error, created_at, updated_at)
       VALUES (?, ?, 0, 'running', NULL, ?, ?)
       ON CONFLICT(source_id) DO UPDATE SET total = excluded.total, status = 'running', error = NULL, updated_at = excluded.updated_at`,
    )
    .run(id, total, now, now);
}

function bumpRemoved(id: string, n: number): void {
  sqlite
    .prepare("UPDATE source_delete_jobs SET removed = removed + ?, updated_at = ? WHERE source_id = ?")
    .run(n, Date.now(), id);
}

/**
 * 启动删除(立即返回,后台跑)。重复调用只会返回当前进度,不会开第二个 worker。
 * 返回已存在的任务进度,便于接口直接回给前端。
 */
export function startSourceDelete(id: string): { total: number; removed: number } {
  const existing = sqlite
    .prepare("SELECT total, removed FROM source_delete_jobs WHERE source_id = ? AND status = 'running'")
    .get(id) as any;
  if (existing) {
    if (!running.has(id)) void drain(id);
    return { total: Number(existing.total || 0), removed: Number(existing.removed || 0) };
  }
  const total = countSourceSongsFast(id);
  upsertJob(id, total);
  void drain(id);
  return { total, removed: 0 };
}

/** 后台删除循环:一批一个事务,让出事件循环,进度落库。 */
async function drain(id: string): Promise<void> {
  if (running.has(id)) return;
  running.add(id);
  try {
    for (;;) {
      const ids = (sqlite.prepare(`SELECT id FROM songs WHERE ${WHERE} LIMIT ${BATCH}`).all(...prefixes(id)) as any[])
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
      bumpRemoved(id, ids.length);
      // 让出事件循环:删除期间首页/播放请求不能被憋住。
      await new Promise((r) => setImmediate(r));
    }
    // 源下歌曲清空了,顺手收掉没人用的专辑/艺人,再删源行本身。
    cleanupOrphans();
    db.delete(mediaSources).where(eq(mediaSources.id, id)).run();
    closeSmbSource(id);
    sqlite.prepare("DELETE FROM source_delete_jobs WHERE source_id = ?").run(id);
    log.info("音源删除完成", { sourceId: id });
  } catch (e: any) {
    const msg = String(e?.message || e);
    sqlite
      .prepare("UPDATE source_delete_jobs SET status = 'failed', error = ?, updated_at = ? WHERE source_id = ?")
      .run(msg, Date.now(), id);
    log.error("音源删除失败(已保留进度,可重试)", { sourceId: id, err: msg });
  } finally {
    running.delete(id);
  }
}

/** boot 恢复:进程重启前没删完的任务继续删(查询天然幂等)。 */
export function resumePendingSourceDeletes(): number {
  let rows: any[] = [];
  try {
    rows = sqlite.prepare("SELECT source_id FROM source_delete_jobs WHERE status = 'running'").all() as any[];
  } catch {
    return 0;
  }
  for (const r of rows) {
    const id = String(r.source_id);
    if (!running.has(id)) void drain(id);
  }
  return rows.length;
}

/** 进度快照(供 /delete-status):只回正在跑或失败的,失败的可重试。 */
export function listSourceDeleteJobs(): Record<string, Omit<DeleteJob, "source_id">> {
  const rows = sqlite.prepare("SELECT * FROM source_delete_jobs").all() as DeleteJob[];
  const out: Record<string, Omit<DeleteJob, "source_id">> = {};
  for (const r of rows) {
    out[r.source_id] = {
      total: Number(r.total || 0),
      removed: Number(r.removed || 0),
      status: r.status,
      error: r.error,
      updated_at: Number(r.updated_at || 0),
    };
  }
  return out;
}
