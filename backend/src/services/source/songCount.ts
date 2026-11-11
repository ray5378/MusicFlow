// ==================== 每源已入库曲目数(存字段 + 整批变更后重算) ====================
//
// 为什么不每次列表现算：GET /v1/sources 每次打开音源页都会触发，现算 = 每个源一条
// COUNT。实测 `path LIKE 'l:id:%'` 的执行计划是
// `SCAN songs USING COVERING INDEX idx_songs_path`（扫全索引，随曲库线性增长）；
// 换成本文件的区间谓词 `path >= 'l:id:' AND path < 'l:id;'` 才走
// `SEARCH ... (path>? AND path<?)` 索引区间。
//
// 维护策略刻意**不做 ±1 增量**：songs 表的写入点有 8 处（三种扫描器的入库/清理、
// 单曲删除、删源批量删、洗版换源、插件批量入库、直播链回写、测试音），逐处增减漏
// 一处就永久偏差且无人发现。这里只在「整批变更结束」时重算一次写回，幂等、天然
// 不会漂移：
//   - 扫描结束（含 stopped / failed）：services/source/scanRunner.ts finalize
//   - 单曲删除：routes/api/shared.ts deleteSongDb
//   - 洗版换源（一行从一个源迁到另一个源）：services/fetch/upgrade.ts
// 老库升级 / 新建源的 song_count 为 NULL，列表接口惰性算一次并回填。
import { sqlite } from "../../db/index.js";
import { createLogger } from "../../utils/logger.js";

const log = createLogger("SOURCE-COUNT");

/** 源在 songs.path 里的三种前缀：本地 / SMB / WebDAV。 */
const PATH_PREFIXES = ["l", "s", "w"] as const;

/**
 * 单前缀的区间计数。
 * 上界取 `:` 的下一个字符 `;`：任何以 `l:<id>:` 开头的路径都小于 `l:<id>;`，
 * 所以区间谓词与前缀匹配等价，且能走 idx_songs_path（LIKE 前缀默认不走索引）。
 */
function countByPrefix(prefix: string): number {
  const upper = prefix.slice(0, -1) + ";";
  const row = sqlite
    .prepare("SELECT COUNT(*) AS n FROM songs WHERE path >= ? AND path < ?")
    .get(prefix, upper) as { n?: number } | undefined;
  return Number(row?.n ?? 0);
}

/** 某源已入库曲目数（纯本地库统计，不连 SMB/WebDAV）。 */
export function countSourceSongs(id: string): number {
  let n = 0;
  for (const p of PATH_PREFIXES) n += countByPrefix(`${p}:${id}:`);
  return n;
}

/** 重算并写回 media_sources.song_count（幂等）。返回最新值。 */
export function recomputeSourceSongCount(id: string): number {
  const n = countSourceSongs(id);
  try {
    sqlite.prepare("UPDATE media_sources SET song_count = ? WHERE id = ?").run(n, id);
  } catch (e: any) {
    log.warn("[SOURCE-COUNT] 写回失败", { sourceId: id, err: e?.message || String(e) });
  }
  return n;
}

/** 从歌曲 path 反解源 id（`l:/s:/w:<id>:<path>`）；非源行返回 null。 */
export function sourceIdOfSongPath(songPath?: string | null): string | null {
  if (!songPath) return null;
  const m = /^[lsw]:([^:]+):/.exec(songPath);
  return m ? m[1] : null;
}
