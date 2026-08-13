// Unit tests for expired web-song purge (services/source/online/purge.ts).
// Pure app logic (no server), so we init the real schema via initDatabase().
import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import fs from "fs";
import path from "path";
import { eq } from "drizzle-orm";
import { initDatabase, db, sqlite } from "../../../src/db/index.js";
import { songs, playlists, playlistSongs, users, userFavoriteSongs, playHistory } from "../../../src/db/schema.js";
import { purgeExpiredWebSongs } from "../../../src/services/source/online/purge.js";
import { getDataDir } from "../../../src/utils/env.js";

// 封面目录与实现一致地走 getDataDir()(测试进程 DATA_DIR 指向隔离临时目录)。
const ONLINE_COVERS_DIR = path.join(getDataDir(), "online-covers");
const COVERS_DIR = path.join(getDataDir(), "covers");

const OLD = "2026-01-01T00:00:00.000Z"; // far older than the 7-day retention
// One minute in the future: always after any purge cutoff ("now").
const FRESH = () => new Date(Date.now() + 60_000).toISOString();

const IDS = {
  user: "purg-test-user",
  playlist: "purg-test-playlist",
  old: "purg-test-old",        // web, old, unreferenced -> purged
  ref: "purg-test-ref",        // web, old, referenced by playlist -> kept
  fav: "purg-test-fav",        // web, old, in favorites -> kept
  fresh: "purg-test-fresh",    // web, fresh -> kept
  local: "purg-test-local",    // local type -> never touched
};

const createdFiles: string[] = [];

function resetRows() {
  sqlite.prepare("DELETE FROM play_history WHERE user_id = ?").run(IDS.user);
  sqlite.prepare("DELETE FROM user_favorite_songs WHERE user_id = ?").run(IDS.user);
  sqlite.prepare("DELETE FROM playlist_songs WHERE playlist_id = ?").run(IDS.playlist);
  sqlite.prepare("DELETE FROM playlists WHERE id = ?").run(IDS.playlist);
  sqlite.prepare("DELETE FROM songs WHERE id IN (?, ?, ?, ?, ?)").run(IDS.old, IDS.ref, IDS.fav, IDS.fresh, IDS.local);
  sqlite.prepare("DELETE FROM users WHERE id = ?").run(IDS.user);
}

function setPluginConfig(cfg: Record<string, unknown>, enabled = 1) {
  sqlite.prepare(`
    INSERT INTO plugins (id, name, version, description, manifest, enabled, config, created_at, updated_at)
    VALUES ('go-music-dl', 'go-music-dl', 'test', '', '{}', ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET enabled = excluded.enabled, config = excluded.config
  `).run(enabled, JSON.stringify(cfg), FRESH(), FRESH());
}

function insertWebSong(id: string, createdAt: string) {
  db.insert(songs).values({
    id,
    title: id,
    artist: "Tester",
    album: "Album",
    path: `web:go-music-dl:netease:${id}`,
    type: "web",
    pluginEntry: "go-music-dl",
    fingerprint: `go-music-dl:netease:${id}`,
    createdAt,
    updatedAt: createdAt,
    coverArt: `${id}.jpg`,
  }).run();
}

beforeAll(() => {
  initDatabase();
});

afterEach(() => {
  resetRows();
  for (const f of createdFiles) {
    try { fs.rmSync(f, { force: true }); } catch { /* ignore */ }
  }
  createdFiles.length = 0;
});

afterAll(() => {
  resetRows();
  setPluginConfig({ webSongsMode: "keep" });
});

function seed() {
  db.insert(users).values({ id: IDS.user, username: "purge-test", password: "x", salt: "x", subsonicSalt: "x" }).run();

  insertWebSong(IDS.old, OLD);
  insertWebSong(IDS.ref, OLD);
  insertWebSong(IDS.fav, OLD);
  insertWebSong(IDS.fresh, FRESH());
  db.insert(songs).values({ id: IDS.local, title: IDS.local, path: `l:src:${IDS.local}`, type: "local", createdAt: OLD }).run();

  db.insert(playlists).values({ id: IDS.playlist, name: "test", ownerId: IDS.user, createdAt: OLD }).run();
  db.insert(playlistSongs).values({ playlistId: IDS.playlist, songId: IDS.ref, position: 0, playable: 1 }).run();
  db.insert(userFavoriteSongs).values({ userId: IDS.user, songId: IDS.fav }).run();
  db.insert(playHistory).values({ userId: IDS.user, songId: IDS.old, playedAt: OLD }).run();

  // Cover files for one that will be purged (old) and one that must stay (fav).
  for (const name of [`${IDS.old}.jpg`, `${IDS.fav}.jpg`]) {
    for (const dir of [ONLINE_COVERS_DIR, COVERS_DIR]) {
      const fp = path.join(dir, name);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(fp, "fake-cover");
      createdFiles.push(fp);
    }
  }
}

describe("purgeExpiredWebSongs", () => {
  it("keeps everything when rotation is not enabled (default keep)", () => {
    setPluginConfig({ webSongsMode: "keep" });
    seed();
    const result = purgeExpiredWebSongs("go-music-dl");
    expect(result.mode).toBe("keep");
    expect(result.purged).toBe(0);
    for (const id of [IDS.old, IDS.ref, IDS.fav, IDS.fresh, IDS.local]) {
      expect(db.select().from(songs).where(eq(songs.id, id)).get()).toBeTruthy();
    }
  });

  it("deletes only expired unreferenced web songs and their covers", () => {
    setPluginConfig({ webSongsMode: "rotate", webSongsRetentionDays: 7 });
    seed();

    const result = purgeExpiredWebSongs("go-music-dl");
    expect(result.mode).toBe("rotate");
    expect(result.retentionDays).toBe(7);
    expect(result.purged).toBe(1);
    expect(result.covers).toBe(2); // 2 cover dirs x 1 file per purged song

    // Old unreferenced web song + its history row + cover are gone.
    expect(db.select().from(songs).where(eq(songs.id, IDS.old)).get()).toBeUndefined();
    expect(db.select().from(playHistory).where(eq(playHistory.songId, IDS.old)).get()).toBeUndefined();
    for (const dir of [ONLINE_COVERS_DIR, COVERS_DIR]) {
      expect(fs.existsSync(path.join(dir, `${IDS.old}.jpg`))).toBe(false);
    }

    // Old but referenced / favorited songs, fresh song and local song survive.
    for (const id of [IDS.ref, IDS.fav, IDS.fresh, IDS.local]) {
      expect(db.select().from(songs).where(eq(songs.id, id)).get()).toBeTruthy();
    }
    expect(fs.existsSync(path.join(ONLINE_COVERS_DIR, `${IDS.fav}.jpg`))).toBe(true);
  });

  it("is idempotent: a second run removes nothing", () => {
    setPluginConfig({ webSongsMode: "rotate", webSongsRetentionDays: 7 });
    seed();
    const first = purgeExpiredWebSongs("go-music-dl");
    const second = purgeExpiredWebSongs("go-music-dl");
    expect(first.purged).toBeGreaterThan(0);
    expect(second.purged).toBe(0);
  });

  it("honors a zero retention day count", () => {
    setPluginConfig({ webSongsMode: "rotate", webSongsRetentionDays: 0 });
    seed();
    // retention 0 -> cutoff "now"; only the unreferenced old song qualifies.
    const result = purgeExpiredWebSongs("go-music-dl");
    expect(result.purged).toBe(1);
  });
});