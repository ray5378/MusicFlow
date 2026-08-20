// Temporary demo-data seeder for browser simulation tests.
// Loads existing musicflow.db, inserts playlists/albums/artists/songs, then exits.
import Database from "better-sqlite3";
import path from "path";
import { fileURLToPath } from "url";
import md5 from "md5";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const db = new Database(path.join(__dirname, "data", "musicflow.db"));

db.pragma("journal_mode = WAL");
db.pragma("synchronous = NORMAL");

const now = new Date().toISOString();

// ensure an admin user exists (idempotent)
let user = db.prepare("SELECT id FROM users WHERE username = ?").get("admin");
if (!user) {
  const id = "u_admin";
  db.prepare(
    "INSERT INTO users (id, username, password, salt, subsonic_salt, pass_enc, is_admin, is_active, created_at, updated_at) VALUES (?,?,?,?,?,?,1,1,?,?)"
  ).run(id, "admin", md5("admin" + "demosalt"), "salt", "demosalt", null, now, now);
  user = { id };
}
const ownerId = user.id;

db.transaction(() => {
  // artists
  const insArtist = db.prepare(
    "INSERT OR IGNORE INTO artists (id, name, cover_art, album_count, scrape_missing, created_at, updated_at) VALUES (?,?,?,0,0,?,?)"
  );
  for (let a = 0; a < 400; a++) {
    insArtist.run(`ar${a}`, `Artist ${a}`, null, now, now);
  }

  // albums + songs
  const insAlbum = db.prepare(
    "INSERT OR IGNORE INTO albums (id, name, artist_id, artist, year, genre, cover_art, song_count, duration, play_count, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,0,?,?)"
  );
  const insSong = db.prepare(
    "INSERT OR IGNORE INTO songs (id, title, artist, artist_id, album, album_id, duration, bit_rate, content_type, suffix, path, track, type, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)"
  );
  let songIdx = 0;
  for (let al = 0; al < 400; al++) {
    const aid = `ar${al % 400}`;
    const aname = `Artist ${al % 400}`;
    const albumId = `alb${al}`;
    const perAlbum = 8;
    insAlbum.run(albumId, `Album ${al}`, aid, aname, 2000 + (al % 24), "", null, perAlbum, perAlbum * 220, now, now);
    for (let s = 0; s < perAlbum; s++) {
      const id = `s${songIdx++}`;
      insSong.run(
        id, `Song ${songIdx}`, aname, aid, `Album ${al}`, albumId,
        200 + (songIdx % 60), 320, "audio/mpeg", "mp3",
        `demo://song-${songIdx}.mp3`, s + 1, "local", now, now
      );
    }
  }
  console.log(`seeded ${songIdx} songs, 400 albums, 400 artists`);

  // playlists (local)
  const insPlaylist = db.prepare(
    "INSERT OR IGNORE INTO playlists (id, name, owner_id, is_public, comment, cover_art, song_count, duration, sync_enabled, favorite, created_at, updated_at) VALUES (?,?,?,0,'',null,?,?,0,0,?,?)"
  );
  for (let p = 0; p < 300; p++) {
    const cnt = 5 + (p % 20);
    insPlaylist.run(`pl${p}`, `Playlist ${p}`, ownerId, cnt, cnt * 220, now, now);
  }
  console.log("seeded 300 playlists");
})();

db.close();
console.log("DONE");