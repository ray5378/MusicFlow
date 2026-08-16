// Incremental replacePlaylistSongs tests (每日推荐/私人歌单导入路径).
//
// Verifies replacePlaylistSongs() is incremental: already-present entries are
// reused (only position corrected when drifted), removed entries deleted, new
// ones inserted — no full clear+reinsert.
import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { db, initDatabase, sqlite } from "../../src/db/index.js";
import { playlistSongs } from "../../src/db/schema.js";
import { eq } from "drizzle-orm";
import { registerBuiltinPlugins } from "../../src/plugins/builtins.js";
import { replacePlaylistSongs } from "../../src/services/source/online/recommendImport.js";

const PL_ID = "pl-rec-incremental";

function seedUser() {
  sqlite.prepare(
    "INSERT OR IGNORE INTO users (id, username, password, salt, subsonic_salt) VALUES (?,?,?,?,?)",
  ).run("u1", "u1", "x", "x", "x");
}
function seedOnlineSongs() {
  // replacePlaylistSongs links playlist_songs.song_id -> songs(id); the online
  // song rows must exist (as the real flow creates them via importOnlineSongs).
  for (const id of ["w1", "w2", "w3", "w4"]) {
    sqlite.prepare(
      "INSERT OR IGNORE INTO songs (id, title, artist, album, duration, path, suffix, type, created_at) VALUES (?,?,?,?,?,?,?,?,?)",
    ).run(id, id, "WA", "Album", 200, `web:src:/tmp/${id}`, "mp3", "web", new Date().toISOString());
  }
}
function makePlaylist() {
  seedUser();
  seedOnlineSongs();
  sqlite.prepare("DELETE FROM playlist_songs WHERE playlist_id = ?").run(PL_ID);
  sqlite.prepare("DELETE FROM playlists WHERE id = ?").run(PL_ID);
  sqlite.prepare(
    "INSERT INTO playlists (id, name, owner_id, source_url, source_platform, song_count, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)",
  ).run(PL_ID, "rec", "u1", "gmdl://recommend/x", "qq", 0, new Date().toISOString(), new Date().toISOString());
}
function entryIds(): number[] {
  return db.select().from(playlistSongs).where(eq(playlistSongs.playlistId, PL_ID))
    .orderBy(playlistSongs.position).all().map((e: any) => e.id);
}
function songIds(): (string | null)[] {
  return db.select().from(playlistSongs).where(eq(playlistSongs.playlistId, PL_ID))
    .orderBy(playlistSongs.position).all().map((e: any) => e.songId);
}

beforeAll(() => {
  if (!process.env.APP_VERSION) process.env.APP_VERSION = "1.0.0";
  registerBuiltinPlugins();
  initDatabase();
});
beforeEach(() => makePlaylist());

describe("replacePlaylistSongs (incremental)", () => {
  it("first call inserts all songs", async () => {
    await replacePlaylistSongs(PL_ID, [
      { id: "w1", title: "W1" },
      { id: "w2", title: "W2" },
      { id: "w3", title: "W3" },
    ]);
    expect(songIds()).toEqual(["w1", "w2", "w3"]);
    expect(entryIds().length).toBe(3);
  });

  it("identical call reuses rows (no full rewrite)", async () => {
    await replacePlaylistSongs(PL_ID, [
      { id: "w1", title: "W1" },
      { id: "w2", title: "W2" },
      { id: "w3", title: "W3" },
    ]);
    const idsBefore = entryIds();
    await replacePlaylistSongs(PL_ID, [
      { id: "w1", title: "W1" },
      { id: "w2", title: "W2" },
      { id: "w3", title: "W3" },
    ]);
    expect(entryIds()).toEqual(idsBefore);
  });

  it("adding one song only inserts the new entry", async () => {
    await replacePlaylistSongs(PL_ID, [
      { id: "w1", title: "W1" },
      { id: "w2", title: "W2" },
      { id: "w3", title: "W3" },
    ]);
    const idsBefore = entryIds();
    await replacePlaylistSongs(PL_ID, [
      { id: "w1", title: "W1" },
      { id: "w2", title: "W2" },
      { id: "w3", title: "W3" },
      { id: "w4", title: "W4" },
    ]);
    const idsAfter = entryIds();
    expect(idsAfter.slice(0, 3)).toEqual(idsBefore);
    expect(idsAfter.length).toBe(4);
    expect(new Set(idsAfter).size).toBe(4);
  });

  it("removing one song only deletes that entry", async () => {
    await replacePlaylistSongs(PL_ID, [
      { id: "w1", title: "W1" },
      { id: "w2", title: "W2" },
      { id: "w3", title: "W3" },
    ]);
    const idsBefore = entryIds(); // [id(w1), id(w2), id(w3)]
    await replacePlaylistSongs(PL_ID, [
      { id: "w1", title: "W1" },
      { id: "w3", title: "W3" },
    ]);
    const idsAfter = entryIds();
    expect(idsAfter).toEqual([idsBefore[0], idsBefore[2]]);
    expect(idsAfter.length).toBe(2);
  });
});
