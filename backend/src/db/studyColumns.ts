import type { Database as DatabaseType } from "better-sqlite3";
import { createLogger } from "../utils/logger.js";

const log = createLogger("db");

/**
 * 学习模块补列（老库升级用）。
 *
 * 项目没有迁移框架：新库由 db/index.ts 的 CREATE TABLE 直接建出 study 相关列与
 * study_progress 表，老库升级时需要补。补列逻辑放在这里而不是 db/index.ts，
 * 是因为群组不变量守卫要求 db/index.ts 保持「CREATE TABLE 为唯一 schema 来源」、
 * 不得出现 ad-hoc 迁移语句（与 db/songCountColumn.ts 同模式）。
 *
 * 幂等：列已存在即跳过；每次启动最多 3 次 PRAGMA table_info。
 */
export function ensureStudyColumns(sqlite: DatabaseType): void {
  ensureColumn(sqlite, "songs", "kind", "TEXT NOT NULL DEFAULT 'music'");
  ensureColumn(sqlite, "songs", "source_id", "TEXT");
  ensureColumn(sqlite, "songs", "rel_dir", "TEXT DEFAULT ''");
  ensureColumn(sqlite, "media_sources", "kind", "TEXT NOT NULL DEFAULT 'music'");
  ensureColumn(sqlite, "playlists", "kind", "TEXT NOT NULL DEFAULT 'music'");
  ensureColumn(sqlite, "playlists", "folder", "TEXT DEFAULT ''");

  // 老库补表:新库由 db/index.ts 的 CREATE TABLE 建出;这里保持同一份 DDL,
  // 让升级后的库也能存「学习歌单续播」进度。
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS study_playlist_progress (
      user_id TEXT NOT NULL,
      playlist_id TEXT NOT NULL,
      song_id TEXT NOT NULL,
      position_sec REAL DEFAULT 0,
      duration_sec INTEGER DEFAULT 0,
      updated_at TEXT DEFAULT '',
      PRIMARY KEY (user_id, playlist_id),
      FOREIGN KEY (user_id) REFERENCES users(id),
      FOREIGN KEY (playlist_id) REFERENCES playlists(id),
      FOREIGN KEY (song_id) REFERENCES songs(id)
    );
    CREATE INDEX IF NOT EXISTS idx_study_playlist_progress_user
      ON study_playlist_progress(user_id, updated_at DESC);
  `);

  // 防御性回填：历史行若被外部工具写成 NULL/空串，统一归入音乐面，
  // 保证「音乐面 = kind='music'」这一过滤假设永远成立。
  const songsFixed = sqlite
    .prepare("UPDATE songs SET kind = 'music' WHERE kind IS NULL OR kind = ''")
    .run().changes;
  const sourcesFixed = sqlite
    .prepare("UPDATE media_sources SET kind = 'music' WHERE kind IS NULL OR kind = ''")
    .run().changes;
  const playlistsFixed = sqlite
    .prepare("UPDATE playlists SET kind = 'music' WHERE kind IS NULL OR kind = ''")
    .run().changes;
  const fixed = songsFixed + sourcesFixed + playlistsFixed;
  if (fixed > 0) log.info(`[DB] kind 回填为 music:${fixed} 行`);
}

function ensureColumn(sqlite: DatabaseType, table: string, column: string, ddlType: string): void {
  const cols = sqlite.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name?: string }>;
  if (cols.some((c) => c.name === column)) return;
  sqlite.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddlType}`);
  log.info(`[DB] ${table} 补列 ${column}`);
}
