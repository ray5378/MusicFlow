import Database from "better-sqlite3";
import type { Database as DatabaseType } from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import * as schema from "./schema.js";
import fs from "fs";
import path from "path";
import crypto from "crypto";
import { v4 as uuidv4 } from "uuid";
import md5 from "md5";
import { JWT_SECRET, getDataDir } from "../utils/env.js";
import { createLogger } from "../utils/logger.js";

const dataDir = getDataDir();
if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

const sqlite: DatabaseType = new Database(path.join(dataDir, "musicflow.db"));
sqlite.pragma("journal_mode = WAL");
sqlite.pragma("foreign_keys = ON");
sqlite.pragma("busy_timeout = 5000");
sqlite.pragma("synchronous = NORMAL");
sqlite.pragma("cache_size = -10000");

const log = createLogger("db");
export const db = drizzle(sqlite, { schema });
// Export the raw sqlite handle so services can run lightweight key/value
// lookups on the `settings` table without going through drizzle each time.
export { sqlite };

// ==================== DB-ready hooks ====================
//
// Modules that need to write rows right after the schema exists (e.g. the
// plugin registry seeding its manifest-driven rows) subscribe here instead of
// being imported by this file. That keeps the dependency one-directional
// (plugins -> db, never db -> plugins) and avoids an ESM load-time cycle.
type DbReadyHook = () => void;
const dbReadyHooks: DbReadyHook[] = [];
let dbReady = false;

/** Run `hook` once the schema is initialized. If the DB is already
 *  initialized, the hook runs immediately (so import order can't lose it). */
export function onDatabaseReady(hook: DbReadyHook): void {
  dbReadyHooks.push(hook);
  if (dbReady) runHook(hook);
}

function runHook(hook: DbReadyHook): void {
  try {
    hook();
  } catch (e: any) {
    log.error("db-ready hook failed", { err: e?.message || e });
  }
}

function seedRegisteredPlugins(): void {
  dbReady = true;
  for (const hook of dbReadyHooks) runHook(hook);
}

const ENC_KEY = crypto.createHash("sha256").update(JWT_SECRET).digest();

// AES-256-GCM encrypt the plaintext password (needed to verify OpenSubsonic token auth:
// token = md5(password + clientSalt) with a client-generated random salt)
export function encryptPassword(plain: string): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", ENC_KEY, iv);
  const enc = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, enc]).toString("base64");
}

export function decryptPassword(enc: string | null | undefined): string | null {
  if (!enc) return null;
  try {
    const buf = Buffer.from(enc, "base64");
    const iv = buf.subarray(0, 12);
    const tag = buf.subarray(12, 28);
    const data = buf.subarray(28);
    const decipher = crypto.createDecipheriv("aes-256-gcm", ENC_KEY, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(data), decipher.final()]).toString("utf8");
  } catch { return null; }
}

export function initDatabase() {
  // Create tables if they don't exist
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      username TEXT UNIQUE NOT NULL,
      password TEXT NOT NULL,
      salt TEXT NOT NULL,
      subsonic_salt TEXT NOT NULL,
      pass_enc TEXT,
      is_admin INTEGER DEFAULT 0,
      is_active INTEGER DEFAULT 1,
      email TEXT DEFAULT '',
      api_key TEXT,
      api_key_hash TEXT,
      api_key_expires_at TEXT,
      must_change_password INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      updated_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    );

    CREATE TABLE IF NOT EXISTS artists (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      cover_art TEXT,
      bio TEXT,
      country TEXT,
      birth_date TEXT,
      album_count INTEGER DEFAULT 0,
      scrape_missing INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      updated_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    );

    CREATE TABLE IF NOT EXISTS albums (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      artist_id TEXT,
      artist TEXT,
      year INTEGER DEFAULT 0,
      genre TEXT DEFAULT '',
      cover_art TEXT,
      song_count INTEGER DEFAULT 0,
      duration INTEGER DEFAULT 0,
      play_count INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      updated_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      FOREIGN KEY (artist_id) REFERENCES artists(id)
    );

    CREATE TABLE IF NOT EXISTS songs (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      artist TEXT DEFAULT '',
      artist_id TEXT,
      album TEXT DEFAULT '',
      album_id TEXT,
      duration INTEGER DEFAULT 0,
      bit_rate INTEGER DEFAULT 0,
      content_type TEXT DEFAULT 'audio/mpeg',
      suffix TEXT DEFAULT 'mp3',
      path TEXT NOT NULL,
      cover_art TEXT,
      play_count INTEGER DEFAULT 0,
      disc_number INTEGER DEFAULT 1,
      track INTEGER DEFAULT 0,
      genre TEXT DEFAULT '',
      size INTEGER DEFAULT 0,
      fingerprint TEXT,
      -- 在线/插件源歌曲列:type('local'|'webdav'|'web')、URL、流请求头、来源平台数据、
      -- 插件入口、缓存路径;lyrics 为落库歌词(歌词补全 B 选项),离线也能显示。
      type TEXT DEFAULT 'local',
      url TEXT,
      stream_headers TEXT,
      source_data TEXT,
      plugin_entry TEXT,
      cache_path TEXT,
      lyrics TEXT,
      -- 同曲多源归组:规范化标题+歌手相同且时长差 ≤3s 的行共享同一 group_id;
      -- 组内优先级 local > webdav > web,播放优选/展示合并基于它。分组只附加列,不删行。
      group_id TEXT,
      group_key TEXT,
      created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      updated_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      FOREIGN KEY (artist_id) REFERENCES artists(id),
      FOREIGN KEY (album_id) REFERENCES albums(id)
    );
    CREATE INDEX IF NOT EXISTS idx_songs_group_key ON songs(group_key);

    CREATE TABLE IF NOT EXISTS album_artists (
      album_id TEXT NOT NULL,
      artist_id TEXT NOT NULL,
      role TEXT DEFAULT 'participant',
      PRIMARY KEY (album_id, artist_id),
      FOREIGN KEY (album_id) REFERENCES albums(id),
      FOREIGN KEY (artist_id) REFERENCES artists(id)
    );

    CREATE TABLE IF NOT EXISTS playlists (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      owner_id TEXT NOT NULL,
      is_public INTEGER DEFAULT 0,
      comment TEXT DEFAULT '',
      cover_art TEXT,
      song_count INTEGER DEFAULT 0,
      duration INTEGER DEFAULT 0,
      sync_enabled INTEGER DEFAULT 0,
      favorite INTEGER DEFAULT 0,
      source_plugin TEXT,
      source_url TEXT,
      source_platform TEXT,
      external_id TEXT,
      created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      updated_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      FOREIGN KEY (owner_id) REFERENCES users(id)
    );

    CREATE TABLE IF NOT EXISTS playlist_songs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      playlist_id TEXT NOT NULL,
      song_id TEXT,
      position INTEGER DEFAULT 0,
      playable INTEGER DEFAULT 1,
      external_song_id TEXT,
      external_title TEXT,
      external_artist TEXT,
      external_album TEXT,
      external_duration INTEGER,
      unavailable_reason TEXT,
      created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      FOREIGN KEY (playlist_id) REFERENCES playlists(id),
      FOREIGN KEY (song_id) REFERENCES songs(id)
    );

    CREATE TABLE IF NOT EXISTS user_favorite_songs (
      user_id TEXT NOT NULL,
      song_id TEXT NOT NULL,
      created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      PRIMARY KEY (user_id, song_id),
      FOREIGN KEY (user_id) REFERENCES users(id),
      FOREIGN KEY (song_id) REFERENCES songs(id)
    );

    -- 专辑/艺人收藏表:与歌曲收藏相互独立,收藏专辑/艺人不再批量写歌曲。
    CREATE TABLE IF NOT EXISTS user_favorite_albums (
      user_id TEXT NOT NULL,
      album_id TEXT NOT NULL,
      created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      PRIMARY KEY (user_id, album_id),
      FOREIGN KEY (user_id) REFERENCES users(id),
      FOREIGN KEY (album_id) REFERENCES albums(id)
    );
    CREATE INDEX IF NOT EXISTS idx_user_fav_albums_album ON user_favorite_albums(album_id);

    CREATE TABLE IF NOT EXISTS user_favorite_artists (
      user_id TEXT NOT NULL,
      artist_id TEXT NOT NULL,
      created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      PRIMARY KEY (user_id, artist_id),
      FOREIGN KEY (user_id) REFERENCES users(id),
      FOREIGN KEY (artist_id) REFERENCES artists(id)
    );
    CREATE INDEX IF NOT EXISTS idx_user_fav_artists_artist ON user_favorite_artists(artist_id);

    -- 歌单收藏按用户隔离:谁收藏归谁。旧的 playlists.favorite 全局布尔列仅作
    -- 迁移前的兼容快照,新收藏一律写这张表;列表接口按当前用户过滤。
    CREATE TABLE IF NOT EXISTS playlist_favorites (
      user_id TEXT NOT NULL,
      playlist_id TEXT NOT NULL,
      created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      PRIMARY KEY (user_id, playlist_id),
      FOREIGN KEY (user_id) REFERENCES users(id),
      FOREIGN KEY (playlist_id) REFERENCES playlists(id)
    );
    CREATE INDEX IF NOT EXISTS idx_playlist_favorites_playlist ON playlist_favorites(playlist_id);

    CREATE TABLE IF NOT EXISTS play_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT NOT NULL,
      song_id TEXT NOT NULL,
      played_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      FOREIGN KEY (user_id) REFERENCES users(id),
      FOREIGN KEY (song_id) REFERENCES songs(id)
    );

    CREATE TABLE IF NOT EXISTS user_ratings (
      user_id TEXT NOT NULL,
      item_type TEXT NOT NULL,
      item_id TEXT NOT NULL,
      rating INTEGER NOT NULL DEFAULT 0,
      created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      updated_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      PRIMARY KEY (user_id, item_type, item_id),
      FOREIGN KEY (user_id) REFERENCES users(id)
    );

    CREATE TABLE IF NOT EXISTS user_play_queues (
      user_id TEXT PRIMARY KEY,
      entry_ids_json TEXT NOT NULL DEFAULT '[]',
      current_id TEXT,
      position INTEGER NOT NULL DEFAULT 0,
      changed_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      changed_by TEXT DEFAULT '',
      FOREIGN KEY (user_id) REFERENCES users(id)
    );

    CREATE TABLE IF NOT EXISTS media_sources (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      type TEXT NOT NULL DEFAULT 'local',
      enabled INTEGER DEFAULT 1,
      config TEXT DEFAULT '{}',
      created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      updated_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    );

    CREATE TABLE IF NOT EXISTS plugins (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      version TEXT DEFAULT '',
      description TEXT DEFAULT '',
      manifest TEXT DEFAULT '{}',
      enabled INTEGER DEFAULT 0,
      config TEXT DEFAULT '{}',
      created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      updated_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    );

    CREATE TABLE IF NOT EXISTS plugin_registries (
      id TEXT PRIMARY KEY,
      url TEXT NOT NULL,
      enabled INTEGER DEFAULT 1,
      created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    );

    CREATE TABLE IF NOT EXISTS cleaning_rules (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      type TEXT NOT NULL,
      obj TEXT NOT NULL,
      enabled INTEGER DEFAULT 1,
      content TEXT DEFAULT '{}',
      sort_order INTEGER DEFAULT 0,
      is_builtin INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      updated_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    );

    CREATE TABLE IF NOT EXISTS wishes (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      song_title TEXT NOT NULL,
      artist TEXT DEFAULT '',
      album TEXT DEFAULT '',
      status TEXT DEFAULT 'pending',
      playlist_song_id INTEGER,
      notes TEXT DEFAULT '',
      created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      updated_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      FOREIGN KEY (user_id) REFERENCES users(id)
    );

    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    );

    CREATE TABLE IF NOT EXISTS recommend_pool (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      source_type TEXT NOT NULL,
      source_id TEXT NOT NULL,
      source_name TEXT DEFAULT '',
      user_id TEXT NOT NULL,
      enabled INTEGER DEFAULT 1,
      created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      updated_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_recommend_pool_unique ON recommend_pool(source_type, source_id);

    CREATE INDEX IF NOT EXISTS idx_songs_artist ON songs(artist_id);
    CREATE INDEX IF NOT EXISTS idx_songs_album ON songs(album_id);
    CREATE INDEX IF NOT EXISTS idx_songs_genre ON songs(genre);
    CREATE INDEX IF NOT EXISTS idx_songs_created_at ON songs(created_at);
    CREATE INDEX IF NOT EXISTS idx_songs_path ON songs(path);
    CREATE INDEX IF NOT EXISTS idx_songs_fingerprint ON songs(fingerprint);
    -- 列表页滚动预取每块都要 ORDER BY 排序:title 无索引时整表排序是块延迟主因
    -- (Music 页 78k 行实测每块 ~95ms),补索引后走索引排序,深 offset 也接近 O(1)。
    CREATE INDEX IF NOT EXISTS idx_songs_title ON songs(title);
    CREATE INDEX IF NOT EXISTS idx_albums_artist ON albums(artist_id);
    CREATE INDEX IF NOT EXISTS idx_artists_name ON artists(name);
    CREATE INDEX IF NOT EXISTS idx_albums_name ON albums(name);
    -- 专辑列表按 created_at 倒序分页,同样需索引避免整表排序(36k 行实测 ~24ms/块)。
    CREATE INDEX IF NOT EXISTS idx_albums_created_at ON albums(created_at);
    CREATE INDEX IF NOT EXISTS idx_play_history_user ON play_history(user_id);
    CREATE INDEX IF NOT EXISTS idx_play_history_played_at ON play_history(played_at);
    CREATE INDEX IF NOT EXISTS idx_playlist_songs_playlist ON playlist_songs(playlist_id);

    CREATE TABLE IF NOT EXISTS dlna_devices (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL DEFAULT '',
      alias TEXT NOT NULL DEFAULT '',
      manufacturer TEXT NOT NULL DEFAULT '',
      model TEXT NOT NULL DEFAULT '',
      first_seen TEXT NOT NULL DEFAULT '',
      last_seen TEXT NOT NULL DEFAULT '',
      available INTEGER NOT NULL DEFAULT 0,
      disabled INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL DEFAULT ''
    );

    CREATE TABLE IF NOT EXISTS airplay_devices (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL DEFAULT '',
      alias TEXT NOT NULL DEFAULT '',
      first_seen TEXT NOT NULL DEFAULT '',
      last_seen TEXT NOT NULL DEFAULT '',
      available INTEGER NOT NULL DEFAULT 0,
      disabled INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL DEFAULT ''
    );

    CREATE TABLE IF NOT EXISTS device_queues (
      device_id TEXT PRIMARY KEY,
      items_json TEXT NOT NULL DEFAULT '[]',
      current_index INTEGER NOT NULL DEFAULT -1,
      play_mode TEXT NOT NULL DEFAULT 'order',
      is_active INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    );

    CREATE TABLE IF NOT EXISTS local_queues (
      peer_id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      items_json TEXT NOT NULL DEFAULT '[]',
      current_index INTEGER NOT NULL DEFAULT -1,
      play_mode TEXT NOT NULL DEFAULT 'order',
      is_active INTEGER NOT NULL DEFAULT 0,
      last_active_at TEXT NOT NULL,
      updated_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      FOREIGN KEY (user_id) REFERENCES users(id)
    );
    CREATE INDEX IF NOT EXISTS idx_local_queues_user ON local_queues(user_id);

    CREATE TABLE IF NOT EXISTS player_groups (
      id TEXT PRIMARY KEY,
      owner_user_id TEXT NOT NULL DEFAULT '',
      name TEXT NOT NULL,
      member_ids TEXT NOT NULL DEFAULT '[]',
      created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      updated_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    );

    CREATE TABLE IF NOT EXISTS group_queues (
      group_id TEXT PRIMARY KEY,
      items_json TEXT NOT NULL DEFAULT '[]',
      current_index INTEGER NOT NULL DEFAULT -1,
      play_mode TEXT NOT NULL DEFAULT 'order',
      is_active INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    );

    CREATE TABLE IF NOT EXISTS genres (
      id TEXT PRIMARY KEY,
      name TEXT UNIQUE NOT NULL,
      song_count INTEGER NOT NULL DEFAULT 0,
      created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      updated_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    );

    CREATE TABLE IF NOT EXISTS flows (
      id TEXT PRIMARY KEY,
      token TEXT UNIQUE NOT NULL,
      token_id TEXT DEFAULT '',
      owner_user_id TEXT DEFAULT '',
      name TEXT NOT NULL,
      definition_json TEXT NOT NULL DEFAULT '{}',
      enabled INTEGER NOT NULL DEFAULT 1,
      last_run_at TEXT DEFAULT '',
      last_run_status TEXT DEFAULT '',
      last_run_error TEXT DEFAULT '',
      created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      updated_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    );

    CREATE TABLE IF NOT EXISTS player_webhook_tokens (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL DEFAULT '',
      token TEXT UNIQUE NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1,
      owner_user_id TEXT DEFAULT '',
      created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      updated_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    );

    -- 细粒度权限:功能权限显式覆盖 + 播放器授权(管理员在前端逐项勾选)。
    CREATE TABLE IF NOT EXISTS user_permissions (
      user_id TEXT NOT NULL,
      perm_key TEXT NOT NULL,
      granted INTEGER NOT NULL DEFAULT 1,
      updated_at TEXT DEFAULT '',
      PRIMARY KEY (user_id, perm_key),
      FOREIGN KEY (user_id) REFERENCES users(id)
    );
    CREATE INDEX IF NOT EXISTS idx_user_permissions_user ON user_permissions(user_id);

    CREATE TABLE IF NOT EXISTS user_renderer_grants (
      user_id TEXT NOT NULL,
      device_key TEXT NOT NULL,
      created_at TEXT DEFAULT '',
      PRIMARY KEY (user_id, device_key),
      FOREIGN KEY (user_id) REFERENCES users(id)
    );
    CREATE INDEX IF NOT EXISTS idx_user_renderer_grants_user ON user_renderer_grants(user_id);

    -- 播放器「按用户级隐藏」偏好:用户在自己切换弹窗里不显示某些设备/群组
    -- (peer_id = "dlna:<id>" | "airplay:<id>" | "group:<id>")。仅影响本人,不禁用设备。
    CREATE TABLE IF NOT EXISTS player_prefs (
      owner_user_id TEXT NOT NULL,
      peer_id TEXT NOT NULL,
      hidden INTEGER NOT NULL DEFAULT 1,
      updated_at TEXT DEFAULT '',
      PRIMARY KEY (owner_user_id, peer_id),
      FOREIGN KEY (owner_user_id) REFERENCES users(id)
    );
    CREATE INDEX IF NOT EXISTS idx_player_prefs_owner ON player_prefs(owner_user_id);

    -- 播放器「按用户级」显示名覆盖:用户给自己视角下的设备/群组起名,只影响本人。
    CREATE TABLE IF NOT EXISTS player_name_overrides (
      owner_user_id TEXT NOT NULL,
      peer_id TEXT NOT NULL,
      display_name TEXT NOT NULL DEFAULT '',
      updated_at TEXT DEFAULT '',
      PRIMARY KEY (owner_user_id, peer_id),
      FOREIGN KEY (owner_user_id) REFERENCES users(id)
    );
    CREATE INDEX IF NOT EXISTS idx_player_name_overrides_owner ON player_name_overrides(owner_user_id);
  `);

  // Plugins (built-in and external drop-ins) are seeded from the unified catalog
  // at boot via registerBuiltinPlugins() — see plugins/registry.ts.
  // No hardcoded plugin names live here.

  // Insert default admin if no users exist
  const userCount = sqlite.prepare("SELECT COUNT(*) as count FROM users").get() as any;
  if (userCount.count === 0) {
    const salt = Math.random().toString(36).substring(2, 10);
    const defaultSalt = "b264bbe4";
    const passwordHash = md5("admin" + defaultSalt);
    const id = uuidv4();
    sqlite.prepare(`
      INSERT INTO users (id, username, password, salt, subsonic_salt, is_admin, pass_enc, must_change_password)
      VALUES (?, ?, ?, ?, ?, 1, ?, 1)
    `).run(id, "admin", passwordHash, salt, defaultSalt, encryptPassword("admin"));
    log.info("Default admin user created (admin/admin) — 请尽快登录并修改密码");
  }

  // Insert default settings
  const settingCount = sqlite.prepare("SELECT COUNT(*) as count FROM settings").get() as any;
  if (settingCount.count === 0) {
    sqlite.prepare("INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)").run("write_back_tags", "false");
    sqlite.prepare("INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)").run("fingerprint_enabled", "false");
  }
  // Daily-recommend default config (idempotent — only fills keys that don't exist)
  // daily_recommend_enabled: master switch ("true"/"false")
  // daily_recommend_hour:    local hour (0-23) to run, default 3 (off-peak)
  // daily_recommend_retention: how many days of past daily playlists to keep
  // daily_recommend_candidates: JSON array of {platform, url, name} pool to rotate
  // daily_recommend_local_enabled: also build a local-history-based playlist ("true"/"false")
  sqlite.prepare("INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)").run("daily_recommend_enabled", "true");
  sqlite.prepare("INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)").run("daily_recommend_hour", "3");
  sqlite.prepare("INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)").run("daily_recommend_retention", "7");
  sqlite.prepare("INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)").run("daily_recommend_local_enabled", "true");
  // Default candidate pool: a mix of NetEase editorial charts + QQ Music
  // official toplists. Each day the scheduler picks one via
  // `dayOfYear(today) % pool.length`, so the daily mix rotates across charts.
  // Replace via the admin API (PUT /rest/api/v1/daily-recommend/candidates).
  // QQ toplist URLs use the form https://y.qq.com/n/ryqq/toplist/<id> and are
  // routed to a dedicated toplist fetcher (different API from QQ playlists).

  // Seed DB rows for every registered plugin (manifest-driven, idempotent).
  // Deferred require-style import: the registry imports `db` from this module,
  // so a static import here would create a load-time cycle. Doing it *inside*
  // initDatabase() guarantees the schema already exists.
  seedRegisteredPlugins();

  log.info("Database initialized successfully");
}

// 风格表回填:从 songs.genre 全量同步(幂等,启动时调用)。
// 每个风格名只分配一次 uuid,之后保持不变;同步最新计数。
export function backfillGenres(): void {
  const rows = sqlite.prepare("SELECT genre AS name, COUNT(*) AS n FROM songs WHERE genre != '' GROUP BY genre").all() as any[];
  const now = new Date().toISOString();
  const insert = sqlite.prepare("INSERT OR IGNORE INTO genres (id, name, song_count, created_at, updated_at) VALUES (?, ?, ?, ?, ?)");
  const update = sqlite.prepare("UPDATE genres SET song_count = ?, updated_at = ? WHERE name = ?");
  for (const r of rows) {
    insert.run(uuidv4(), r.name, r.n, now, now);
    update.run(r.n, now, r.name);
  }
}

// Delete play history rows older than the retention window (ISO comparison is
// lexicographically correct because all timestamps are stored in ISO 8601 UTC).
export function cleanupPlayHistory(retentionDays: number): number {
  if (retentionDays <= 0) return 0;
  const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000).toISOString();
  const result = sqlite.prepare("DELETE FROM play_history WHERE played_at < ?").run(cutoff);
  if (result.changes > 0) {
    log.info(`[PLAY-HISTORY] cleaned ${result.changes} rows older than ${retentionDays} days`);
  }
  return result.changes;
}
