import type { Database as DatabaseType } from "better-sqlite3";
import { createLogger } from "../utils/logger.js";

const log = createLogger("db");

/**
 * media_sources.song_count：每源已入库曲目数（扫描结束后重算写回，见
 * services/source/songCount.ts）。
 *
 * 项目没有迁移框架：新库由 db/index.ts 的 CREATE TABLE 直接建好该列，老库升级时
 * 需要补列。补列逻辑放在这里而不是 db/index.ts，是因为群组不变量守卫要求
 * db/index.ts 保持「CREATE TABLE 为唯一 schema 来源」、不得出现 ad-hoc 迁移语句
 * （历史上 player_groups 的双源漂移就是那么来的）。与 services/fetch/attempts.ts
 * 的做法一致：谁的表，谁的幂等补列自己管。
 */
export function ensureSongCountColumn(sqlite: DatabaseType): void {
  const cols = sqlite.prepare("PRAGMA table_info(media_sources)").all() as Array<{ name?: string }>;
  if (cols.some((c) => c.name === "song_count")) return;
  sqlite.exec("ALTER TABLE media_sources ADD COLUMN song_count INTEGER");
  log.info("[DB] media_sources 补列 song_count");
}
