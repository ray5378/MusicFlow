import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import * as schema from "./schema.js";
import fs from "fs";
import path from "path";
import crypto from "crypto";
import { v4 as uuidv4 } from "uuid";
import md5 from "md5";

const dataDir = path.resolve(process.cwd(), "data");
if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

const sqlite = new Database(path.join(dataDir, "music-free.db"));
sqlite.pragma("journal_mode = WAL");
sqlite.pragma("foreign_keys = ON");

export const db = drizzle(sqlite, { schema });

const ENC_KEY = crypto.createHash("sha256").update(process.env.JWT_SECRET || "music-free-secret-key").digest();

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
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
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
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
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
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now')),
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
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (artist_id) REFERENCES artists(id),
      FOREIGN KEY (album_id) REFERENCES albums(id)
    );

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
      source_url TEXT,
      source_platform TEXT,
      external_id TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now')),
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
      created_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (playlist_id) REFERENCES playlists(id),
      FOREIGN KEY (song_id) REFERENCES songs(id)
    );

    CREATE TABLE IF NOT EXISTS user_favorite_songs (
      user_id TEXT NOT NULL,
      song_id TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now')),
      PRIMARY KEY (user_id, song_id),
      FOREIGN KEY (user_id) REFERENCES users(id),
      FOREIGN KEY (song_id) REFERENCES songs(id)
    );

    CREATE TABLE IF NOT EXISTS play_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT NOT NULL,
      song_id TEXT NOT NULL,
      played_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (user_id) REFERENCES users(id),
      FOREIGN KEY (song_id) REFERENCES songs(id)
    );

    CREATE TABLE IF NOT EXISTS media_sources (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      type TEXT NOT NULL DEFAULT 'local',
      enabled INTEGER DEFAULT 1,
      config TEXT DEFAULT '{}',
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS plugins (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      version TEXT DEFAULT '',
      description TEXT DEFAULT '',
      manifest TEXT DEFAULT '{}',
      enabled INTEGER DEFAULT 0,
      config TEXT DEFAULT '{}',
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS plugin_registries (
      id TEXT PRIMARY KEY,
      url TEXT NOT NULL,
      enabled INTEGER DEFAULT 1,
      created_at TEXT DEFAULT (datetime('now'))
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
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
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
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (user_id) REFERENCES users(id)
    );

    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_songs_artist ON songs(artist_id);
    CREATE INDEX IF NOT EXISTS idx_songs_album ON songs(album_id);
    CREATE INDEX IF NOT EXISTS idx_albums_artist ON albums(artist_id);
    CREATE INDEX IF NOT EXISTS idx_play_history_user ON play_history(user_id);
    CREATE INDEX IF NOT EXISTS idx_playlist_songs_playlist ON playlist_songs(playlist_id);
  `);

  // Insert default admin if no users exist
  const userCount = sqlite.prepare("SELECT COUNT(*) as count FROM users").get() as any;
  if (userCount.count === 0) {
    const salt = Math.random().toString(36).substring(2, 10);
    const defaultSalt = "b264bbe4";
    const passwordHash = md5("admin" + defaultSalt);
    const id = uuidv4();
    sqlite.prepare(`
      INSERT INTO users (id, username, password, salt, subsonic_salt, is_admin, pass_enc)
      VALUES (?, ?, ?, ?, ?, 1, ?)
    `).run(id, "admin", passwordHash, salt, defaultSalt, encryptPassword("admin"));
    console.log("Default admin user created (admin/admin)");
  }

  // Migration: add pass_enc column to existing users table (older DBs)
  try {
    sqlite.exec("ALTER TABLE users ADD COLUMN pass_enc TEXT");
  } catch {}
  // Migration: add scrape_missing column to artists table (older DBs)
  try {
    sqlite.exec("ALTER TABLE artists ADD COLUMN scrape_missing INTEGER DEFAULT 0");
  } catch {}
  // Backfill pass_enc for the default admin (admin/admin) if missing
  try {
    const adminUser = sqlite.prepare("SELECT id, password, subsonic_salt FROM users WHERE username = 'admin' AND (pass_enc IS NULL OR pass_enc = '')").get() as any;
    if (adminUser && adminUser.password === md5("admin" + adminUser.subsonic_salt)) {
      sqlite.prepare("UPDATE users SET pass_enc = ? WHERE id = ?").run(encryptPassword("admin"), adminUser.id);
    }
  } catch {}

  // Insert default settings
  const settingCount = sqlite.prepare("SELECT COUNT(*) as count FROM settings").get() as any;
  if (settingCount.count === 0) {
    sqlite.prepare("INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)").run("write_back_tags", "false");
    sqlite.prepare("INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)").run("fingerprint_enabled", "false");
  }

  console.log("Database initialized successfully");
}
