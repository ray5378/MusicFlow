// Local daily-recommend playlist generator (Plan B).
//
// Unlike Plan A (which pulls remote playlists from QQ/NetEase and may have lots
// of unmatched stubs because your local library doesn't have those tracks),
// Plan B works ENTIRELY from your local library — every track in the resulting
// playlist is guaranteed playable.
//
// Algorithm:
//   1. Collect each user's "taste profile" from play_history (recent N days)
//      + user_favorite_songs. Weight recent plays higher than old ones.
//   2. Rank artists/albums/genres by aggregated score.
//   3. From the top-K artists/albums, pull ALL candidate songs from the local
//      library, EXCLUDING songs the user already played recently (so the daily
//      mix feels fresh). No artificial size cap — use everything that matches.
//   4. Deterministically shuffle the candidates with a date seed (same day ->
//      same order; different day -> different order).
//   5. Persist as a "今日推荐(本地)" playlist.
//
// Naming / retention model (only TWO playlists ever exist):
//   - "今日推荐(本地)"  — today's local playlist
//   - "昨日推荐(本地)"  — yesterday's local playlist
// Same rename mechanism as Plan A: each day, old "昨日推荐(本地)" is deleted,
// "今日推荐(本地)" is renamed to "昨日推荐(本地)", new "今日推荐(本地)" is created.
//
// Falls back gracefully when there is no history at all: pulls a deterministic
// sample spread across the library so the user still gets *something* to play.
import { sqlite } from "../../db/index.js";
import { clearPlaylistCoverCache } from "../playlistCover.js";

export const HISTORY_WINDOW_DAYS = 30;
export const TOP_ARTISTS = 12;
export const TOP_ALBUMS = 8;
export const TOP_GENRES = 6;

export const DAILY_TAG_LOCAL = "[daily-recommend-local]";

// Fixed playlist names.
const NAME_TODAY = "今日推荐(本地)";
const NAME_YESTERDAY = "昨日推荐(本地)";

export interface LocalRecommendResult {
  date: string;
  playlistId: string;
  name: string;
  total: number;
  sourceUsers: number; // how many users contributed history
  fallback: boolean;   // true if we fell back to library random sample
  skipped: boolean;
}

function todayStr(d = new Date()): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function dayOfYear(d: Date): number {
  const start = new Date(d.getFullYear(), 0, 0);
  return Math.floor((d.getTime() - start.getTime()) / 86400000);
}

// Tiny seeded PRNG (mulberry32) so the same day produces the same shuffle,
// but two different days produce visibly different orders.
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function pickSystemOwnerId(): string {
  const admin = sqlite.prepare("SELECT id FROM users WHERE is_admin = 1 LIMIT 1").get() as any;
  return admin?.id || "";
}

// Find a playlist by its exact name + comment tag.
function findPlaylistByName(name: string, tag: string): any | null {
  const rows = sqlite.prepare("SELECT * FROM playlists WHERE name = ? AND comment LIKE ?").all(name, `%${tag}%`) as any[];
  return rows[0] || null;
}

function isCreatedToday(playlist: any, dateStr: string): boolean {
  const created = playlist.created_at || "";
  return created.startsWith(dateStr);
}

function deletePlaylist(playlistId: string): void {
  sqlite.prepare("DELETE FROM playlist_songs WHERE playlist_id = ?").run(playlistId);
  clearPlaylistCoverCache(playlistId);
  sqlite.prepare("DELETE FROM playlists WHERE id = ?").run(playlistId);
}

function renamePlaylist(playlistId: string, newName: string): void {
  sqlite.prepare("UPDATE playlists SET name = ?, updated_at = ? WHERE id = ?")
    .run(newName, new Date().toISOString(), playlistId);
}

// Aggregate the taste profile across ALL users (daily mixes are global in this
// self-hosted, usually single-household setup). Returns ranked lists of artist
// ids, album ids, and genres, plus the set of song ids the user recently
// played (so we can exclude them from the daily mix).
interface TasteProfile {
  artists: { id: string; score: number }[];
  albums: { id: string; score: number }[];
  genres: { id: string; score: number }[]; // id is the genre name
  recentSongIds: Set<string>;
  userCount: number;
}

function buildTasteProfile(): TasteProfile {
  const since = new Date(Date.now() - HISTORY_WINDOW_DAYS * 86400000).toISOString();

  // Plays per song, with recency weighting (newer = heavier).
  const playRows = sqlite.prepare(`
    SELECT song_id, played_at FROM play_history
    WHERE played_at >= ?
  `).all(since) as { song_id: string; played_at: string }[];

  const userCountRow = sqlite.prepare(`
    SELECT COUNT(DISTINCT user_id) AS n FROM play_history WHERE played_at >= ?
  `).get(since) as { n: number };

  const songScores = new Map<string, number>();
  const recentSongIds = new Set<string>();
  const nowMs = Date.now();
  for (const r of playRows) {
    const t = new Date(r.played_at).getTime() || nowMs;
    const ageDays = Math.max(0, (nowMs - t) / 86400000);
    const weight = Math.max(0.05, 1 - ageDays / HISTORY_WINDOW_DAYS);
    songScores.set(r.song_id, (songScores.get(r.song_id) || 0) + weight);
    recentSongIds.add(r.song_id);
  }

  // Favorites count as a strong, non-decaying signal.
  const favRows = sqlite.prepare(`SELECT song_id FROM user_favorite_songs`).all() as { song_id: string }[];
  for (const r of favRows) {
    songScores.set(r.song_id, (songScores.get(r.song_id) || 0) + 2.0);
  }

  // Aggregate to artist / album / genre.
  const artistScores = new Map<string, number>();
  const albumScores = new Map<string, number>();
  const genreScores = new Map<string, number>();

  const songIds = Array.from(songScores.keys());
  if (songIds.length > 0) {
    for (let i = 0; i < songIds.length; i += 500) {
      const batch = songIds.slice(i, i + 500);
      const placeholders = batch.map(() => "?").join(",");
      const rows = sqlite.prepare(`
        SELECT id, artist_id, album_id, genre FROM songs WHERE id IN (${placeholders})
      `).all(...batch) as { id: string; artist_id: string | null; album_id: string | null; genre: string | null }[];
      for (const s of rows) {
        const w = songScores.get(s.id) || 0;
        if (s.artist_id) artistScores.set(s.artist_id, (artistScores.get(s.artist_id) || 0) + w);
        if (s.album_id) albumScores.set(s.album_id, (albumScores.get(s.album_id) || 0) + w);
        const g = (s.genre || "").trim();
        if (g) genreScores.set(g, (genreScores.get(g) || 0) + w);
      }
    }
  }

  const top = (m: Map<string, number>, k: number) =>
    Array.from(m.entries()).map(([id, score]) => ({ id, score })).sort((a, b) => b.score - a.score).slice(0, k);

  return {
    artists: top(artistScores, TOP_ARTISTS),
    albums: top(albumScores, TOP_ALBUMS),
    genres: top(genreScores, TOP_GENRES),
    recentSongIds,
    userCount: userCountRow.n || 0,
  };
}

// Pull ALL candidate songs from the local library based on the taste profile,
// excluding recently played ones. No size cap — returns everything that matches.
function pickCandidateSongs(profile: TasteProfile, date: Date): string[] {
  const excludeIds = profile.recentSongIds;
  const seen = new Set<string>();
  const candidates: { id: string; rank: number }[] = [];

  const addFromArtistIds = (artistIds: string[], weight: number) => {
    if (artistIds.length === 0) return;
    const placeholders = artistIds.map(() => "?").join(",");
    const rows = sqlite.prepare(`
      SELECT id FROM songs
      WHERE artist_id IN (${placeholders}) AND suffix IS NOT NULL AND path IS NOT NULL
    `).all(...artistIds) as { id: string }[];
    for (const r of rows) {
      if (excludeIds.has(r.id) || seen.has(r.id)) continue;
      seen.add(r.id);
      candidates.push({ id: r.id, rank: weight });
    }
  };

  const addFromAlbumIds = (albumIds: string[], weight: number) => {
    if (albumIds.length === 0) return;
    const placeholders = albumIds.map(() => "?").join(",");
    const rows = sqlite.prepare(`
      SELECT id FROM songs
      WHERE album_id IN (${placeholders}) AND suffix IS NOT NULL AND path IS NOT NULL
    `).all(...albumIds) as { id: string }[];
    for (const r of rows) {
      if (excludeIds.has(r.id) || seen.has(r.id)) continue;
      seen.add(r.id);
      candidates.push({ id: r.id, rank: weight });
    }
  };

  const addFromGenres = (genres: string[], weight: number) => {
    if (genres.length === 0) return;
    const placeholders = genres.map(() => "?").join(",");
    const rows = sqlite.prepare(`
      SELECT id FROM songs
      WHERE genre IN (${placeholders}) AND suffix IS NOT NULL AND path IS NOT NULL
    `).all(...genres) as { id: string }[];
    for (const r of rows) {
      if (excludeIds.has(r.id) || seen.has(r.id)) continue;
      seen.add(r.id);
      candidates.push({ id: r.id, rank: weight });
    }
  };

  // Tiered weighting: top artists > top albums > top genres
  addFromArtistIds(profile.artists.map(a => a.id), 3);
  addFromAlbumIds(profile.albums.map(a => a.id), 2);
  addFromGenres(profile.genres.map(g => g.id), 1);

  // Deterministic shuffle with date seed: rank weights the probability, but
  // the seed makes the same day reproducible.
  const rng = mulberry32(dayOfYear(date) * 2654435761);
  for (const c of candidates) {
    (c as any).key = Math.pow(rng(), 1 / Math.max(0.1, c.rank));
  }
  candidates.sort((a, b) => (b as any).key - (a as any).key);

  return candidates.map(c => c.id);
}

// Fallback: when there's no history, pull ALL songs from the library with a
// deterministic shuffle (no size cap).
function pickRandomSample(date: Date): string[] {
  const total = sqlite.prepare("SELECT COUNT(*) AS n FROM songs WHERE suffix IS NOT NULL AND path IS NOT NULL").get() as { n: number };
  if (!total.n) return [];
  // Fetch all song ids and shuffle deterministically by date seed.
  const rows = sqlite.prepare("SELECT id FROM songs WHERE suffix IS NOT NULL AND path IS NOT NULL").all() as { id: string }[];
  const rng = mulberry32(dayOfYear(date) * 40503 + 1);
  // Fisher-Yates shuffle with the seeded RNG.
  for (let i = rows.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [rows[i], rows[j]] = [rows[j], rows[i]];
  }
  return rows.map(r => r.id);
}

function getSettingBool(key: string, def: boolean): boolean {
  const row = sqlite.prepare("SELECT value FROM settings WHERE key = ?").get(key) as any;
  const v = row?.value ?? (def ? "true" : "false");
  return v === "true" || v === "1";
}

// Pick local-recommend song ids based on play-history taste profile.
// Extracted so the main daily-recommend generator can merge these into the
// SAME "今日推荐" playlist instead of creating a separate "(本地)" one.
// Returns { songIds, sourceUsers, fallback }.
export function pickLocalRecommendSongs(date: Date): { songIds: string[]; sourceUsers: number; fallback: boolean } {
  if (!getSettingBool("daily_recommend_local_enabled", true)) {
    return { songIds: [], sourceUsers: 0, fallback: false };
  }
  const profile = buildTasteProfile();
  let songIds = pickCandidateSongs(profile, date);
  let fallback = false;
  if (songIds.length < 5) {
    songIds = pickRandomSample(date);
    fallback = true;
  }
  return { songIds, sourceUsers: profile.userCount, fallback };
}

// Build today's local daily playlist.
// DEPRECATED: local songs are now merged into the main "今日推荐" playlist by
// generateDailyPlaylist(). This function is kept only for backward compat and
// returns null (no separate "(本地)" playlist is created anymore).
export async function generateLocalDailyPlaylist(date = new Date()): Promise<LocalRecommendResult | null> {
  return null;
}

// Top-level entry for the scheduler. Never throws.
// Now a no-op — local songs are merged into the main daily playlist.
export async function runLocalDailyRecommendJob(): Promise<LocalRecommendResult | null> {
  return null;
}
