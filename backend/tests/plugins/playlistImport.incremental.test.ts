// Incremental playlist import tests.
//
// Verifies that rebuildPlaylistEntries() (used by /import, /sync, recommend-sync
// and daily-recommend) is *incremental*: already-matched entries are reused
// (no full delete+reinsert, no library re-match), only added/removed/changed
// rows are written, and unmatched tracks don't create duplicate wishes.
import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { db, initDatabase, sqlite } from "../../src/db/index.js";
import { playlistSongs, wishes } from "../../src/db/schema.js";
import { eq } from "drizzle-orm";
import { registerBuiltinPlugins } from "../../src/plugins/builtins.js";
import { rebuildPlaylistEntries } from "../../src/services/plugin/playlistSync.js";
import { clearLibraryIndex } from "../../src/services/plugin/libraryIndex.js";
import type { ImportedTrackShape, ImportedPlaylistShape } from "../../src/plugins/types.js";

const PL_ID = "pl-incremental-test";

function seedSong(id: string, title: string, artist: string) {
  sqlite.prepare(
    "INSERT OR IGNORE INTO songs (id, title, artist, album, duration, path, suffix, type, created_at) VALUES (?,?,?,?,?,?,?,?,?)",
  ).run(id, title, artist, "Album", 200, `l:src:/tmp/${id}.mp3`, "mp3", "local", new Date().toISOString());
}

function seedUser() {
  // playlists.owner_id has a FK to users; create the owner before inserting.
  sqlite.prepare(
    "INSERT OR IGNORE INTO users (id, username, password, salt, subsonic_salt) VALUES (?,?,?,?,?)",
  ).run("u1", "u1", "x", "x", "x");
}

function makePlaylist() {
  seedUser();
  sqlite.prepare("DELETE FROM playlist_songs WHERE playlist_id = ?").run(PL_ID);
  sqlite.prepare("DELETE FROM playlists WHERE id = ?").run(PL_ID);
  sqlite.prepare(
    "INSERT INTO playlists (id, name, owner_id, source_url, source_platform, song_count, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)",
  ).run(PL_ID, "inc", "u1", "https://test/pl", "qq", 0, new Date().toISOString(), new Date().toISOString());
}

function entryIds(): number[] {
  return db.select().from(playlistSongs).where(eq(playlistSongs.playlistId, PL_ID))
    .orderBy(playlistSongs.position).all().map((e: any) => e.id);
}
function songIds(): (string | null)[] {
  return db.select().from(playlistSongs).where(eq(playlistSongs.playlistId, PL_ID))
    .orderBy(playlistSongs.position).all().map((e: any) => e.songId);
}
function track(extId: string, title: string, artist: string): ImportedTrackShape {
  return { externalId: extId, title, artist };
}
function pl(tracks: ImportedTrackShape[]): ImportedPlaylistShape {
  return { name: "inc", platform: "qq", tracks };
}

beforeAll(() => {
  if (!process.env.APP_VERSION) process.env.APP_VERSION = "1.0.0";
  registerBuiltinPlugins();
  initDatabase();
});

beforeEach(() => {
  // Seed three library songs the importer's tracks can match against.
  seedSong("s1", "Song One", "Artist A");
  seedSong("s2", "Song Two", "Artist B");
  seedSong("s3", "Song Three", "Artist C");
  makePlaylist();
  // Clean any leftover wishes from a prior case.
  sqlite.prepare("DELETE FROM wishes WHERE notes = '来自歌单导入'").run();
});

describe("rebuildPlaylistEntries (incremental)", () => {
  it("first build inserts all matched tracks", async () => {
    const r = await rebuildPlaylistEntries(PL_ID, pl([
      track("e1", "Song One", "Artist A"),
      track("e2", "Song Two", "Artist B"),
      track("e3", "Song Three", "Artist C"),
    ]), { userId: "u1" });
    expect(r.total).toBe(3);
    expect(r.matched).toBe(3);
    expect(r.unmatched).toBe(0);
    expect(songIds()).toEqual(["s1", "s2", "s3"]);
    expect(entryIds().length).toBe(3);
  });

  it("rebuild with identical list reuses rows (no full rewrite)", async () => {
    await rebuildPlaylistEntries(PL_ID, pl([
      track("e1", "Song One", "Artist A"),
      track("e2", "Song Two", "Artist B"),
      track("e3", "Song Three", "Artist C"),
    ]), { userId: "u1" });
    const idsBefore = entryIds();
    const r = await rebuildPlaylistEntries(PL_ID, pl([
      track("e1", "Song One", "Artist A"),
      track("e2", "Song Two", "Artist B"),
      track("e3", "Song Three", "Artist C"),
    ]), { userId: "u1" });
    expect(r.matched).toBe(3);
    // The exact same entry-row primary keys are preserved => no delete+reinsert.
    expect(entryIds()).toEqual(idsBefore);
    expect(songIds()).toEqual(["s1", "s2", "s3"]);
  });

  it("adding one new track only inserts the new entry", async () => {
    await rebuildPlaylistEntries(PL_ID, pl([
      track("e1", "Song One", "Artist A"),
      track("e2", "Song Two", "Artist B"),
      track("e3", "Song Three", "Artist C"),
    ]), { userId: "u1" });
    const idsBefore = entryIds();
    const r = await rebuildPlaylistEntries(PL_ID, pl([
      track("e1", "Song One", "Artist A"),
      track("e2", "Song Two", "Artist B"),
      track("e3", "Song Three", "Artist C"),
      track("e4", "Song Four", "Artist D"), // new, matched against s4
    ]), { userId: "u1" });
    // 模拟生产:曲库新增歌曲后导入子系统会失效共享索引(reclaim/导入路径都会
    // clearLibraryIndex)。这里直接 SQL 种子,必须手动失效,否则 rebuild 会复用
    // 旧索引(无 s4),e4 永远匹配不上 → 偶发 matched=3(CI 全新库必现)。
    seedSong("s4", "Song Four", "Artist D");
    clearLibraryIndex();
    const r2 = await rebuildPlaylistEntries(PL_ID, pl([
      track("e1", "Song One", "Artist A"),
      track("e2", "Song Two", "Artist B"),
      track("e3", "Song Three", "Artist C"),
      track("e4", "Song Four", "Artist D"),
    ]), { userId: "u1" });
    expect(r2.total).toBe(4);
    expect(r2.matched).toBe(4);
    const idsAfter = entryIds();
    // 3 original ids preserved, exactly one new id appended.
    expect(idsAfter.slice(0, 3)).toEqual(idsBefore);
    expect(idsAfter.length).toBe(4);
    expect(new Set(idsAfter).size).toBe(4);
  });

  it("removing one track only deletes that entry", async () => {
    await rebuildPlaylistEntries(PL_ID, pl([
      track("e1", "Song One", "Artist A"),
      track("e2", "Song Two", "Artist B"),
      track("e3", "Song Three", "Artist C"),
    ]), { userId: "u1" });
    const idsBefore = entryIds(); // [id(e1), id(e2), id(e3)]
    const r = await rebuildPlaylistEntries(PL_ID, pl([
      track("e1", "Song One", "Artist A"),
      track("e3", "Song Three", "Artist C"), // e2 dropped
    ]), { userId: "u1" });
    expect(r.total).toBe(2);
    expect(r.matched).toBe(2);
    const idsAfter = entryIds();
    expect(idsAfter).toEqual([idsBefore[0], idsBefore[2]]);
    expect(idsAfter.length).toBe(2);
  });

  it("reordering reuses rows and only updates positions", async () => {
    await rebuildPlaylistEntries(PL_ID, pl([
      track("e1", "Song One", "Artist A"),
      track("e2", "Song Two", "Artist B"),
      track("e3", "Song Three", "Artist C"),
    ]), { userId: "u1" });
    const idsBefore = entryIds();
    const r = await rebuildPlaylistEntries(PL_ID, pl([
      track("e3", "Song Three", "Artist C"),
      track("e1", "Song One", "Artist A"),
      track("e2", "Song Two", "Artist B"),
    ]), { userId: "u1" });
    expect(r.matched).toBe(3);
    // Same set of entry rows is reused (reordered, not re-created).
    expect(new Set(entryIds())).toEqual(new Set(idsBefore));
    expect(songIds()).toEqual(["s3", "s1", "s2"]);
  });

  it("unmatched track creates a wish only once (no duplicate across rebuilds)", async () => {
    const r1 = await rebuildPlaylistEntries(PL_ID, pl([
      track("e1", "Song One", "Artist A"),
      track("eX", "Ghost Song", "Nobody"), // not in library
    ]), { userId: "u1" });
    expect(r1.matched).toBe(1);
    expect(r1.unmatched).toBe(1);
    expect(r1.wishAdded).toBe(1);
    const wishesAfterFirst = db.select().from(wishes).all().length;

    const r2 = await rebuildPlaylistEntries(PL_ID, pl([
      track("e1", "Song One", "Artist A"),
      track("eX", "Ghost Song", "Nobody"),
    ]), { userId: "u1" });
    expect(r2.unmatched).toBe(1);
    expect(r2.wishAdded).toBe(0); // dedupe: no second wish
    expect(db.select().from(wishes).all().length).toBe(wishesAfterFirst);
  });
});
