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
//   3. From the top-K artists/albums, pull candidate songs from the local
//      library, EXCLUDING songs the user already played recently (so the daily
//      mix feels fresh).
//   4. Deterministically shuffle the candidates with a date seed (same day ->
//      same order; different day -> different order), trim to 30 entries.
//   5. Persist as a "每日推荐(本地) YYYY-MM-DD" playlist.
//
// Falls back gracefully when there is no history at all: pulls a random sample
// spread across the library so the user still gets *something* to listen to.
import { sqlite } from "../../db/index.js";

export const LOCAL_PLAYLIST_SIZE = 30;
export const HISTORY_WINDOW_DAYS = 30;
export const TOP_ARTISTS = 12;
export const TOP_ALBUMS = 8;
export const TOP_GENRES = 6;

export const DAILY_TAG_LOCAL = "[daily-recommend-local]";

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
  // played_at is ISO text, which compares lexicographically correctly.
  const playRows = sqlite.prepare(`
    SELECT song_id, played_at FROM play_history
    WHERE played_at >= ?
  `).all(since) as { song_id: string; played_at: string }[];

  // Count distinct users that contributed history (for reporting).
  const userCountRow = sqlite.prepare(`
    SELECT COUNT(DISTINCT user_id) AS n FROM play_history WHERE played_at >= ?
  `).get(since) as { n: number };

  const songScores = new Map<string, number>();
  const recentSongIds = new Set<string>();
  const nowMs = Date.now();
  for (const r of playRows) {
    const t = new Date(r.played_at).getTime() || nowMs;
    const ageDays = Math.max(0, (nowMs - t) / 86400000);
    // Linear decay: a play today weighs 1.0, a play 30 days ago weighs ~0.
    const weight = Math.max(0.05, 1 - ageDays / HISTORY_WINDOW_DAYS);
    songScores.set(r.song_id, (songScores.get(r.song_id) || 0) + weight);
    recentSongIds.add(r.song_id);
  }

  // Favorites count as a strong, non-decaying signal.
  const favRows = sqlite.prepare(`
    SELECT song_id FROM user_favorite_songs
  `).all() as { song_id: string }[];
  for (const r of favRows) {
    songScores.set(r.song_id, (songScores.get(r.song_id) || 0) + 2.0);
  }

  // Aggregate to artist / album / genre.
  const artistScores = new Map<string, number>();
  const albumScores = new Map<string, number>();
  const genreScores = new Map<string, number>();

  // Join with songs to lift scores up to artist/album/genre.
  // We do it in JS to keep this a single, simple SQL-free pass.
  const songIds = Array.from(songScores.keys());
  if (songIds.length > 0) {
    // Chunk into batches of 500 to avoid SQLite param limits.
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

// Pull candidate songs from the local library based on the taste profile,
// excluding recently played ones. Returns at most `limit` song ids.
function pickCandidateSongs(profile: TasteProfile, date: Date, limit: number): string[] {
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
  // Weighted shuffle: sort by rng()^(1/rank) descending
  for (const c of candidates) {
    (c as any).key = Math.pow(rng(), 1 / Math.max(0.1, c.rank));
  }
  candidates.sort((a, b) => (b as any).key - (a as any).key);

  return candidates.slice(0, limit).map(c => c.id);
}

// Fallback: when there's no history, just pull a deterministic sample spread
// across the library so the user still gets a daily mix.
function pickRandomSample(date: Date, limit: number): string[] {
  const total = sqlite.prepare("SELECT COUNT(*) AS n FROM songs WHERE suffix IS NOT NULL AND path IS NOT NULL").get() as { n: number };
  if (!total.n) return [];
  const rng = mulberry32(dayOfYear(date) * 40503 + 1);
  // Use a deterministic offset-based sampling: pick `limit` rows at evenly
  // spaced offsets through the library, jittered by the day seed.
  const step = Math.max(1, Math.floor(total.n / (limit + 1)));
  const startOffset = Math.floor(rng() * step);
  const ids: string[] = [];
  for (let i = 0; i < limit; i++) {
    const offset = (startOffset + i * step + Math.floor(rng() * step)) % total.n;
    const row = sqlite.prepare("SELECT id FROM songs WHERE suffix IS NOT NULL AND path IS NOT NULL LIMIT 1 OFFSET ?").get(offset) as { id: string } | undefined;
    if (row && !ids.includes(row.id)) ids.push(row.id);
  }
  return ids;
}

function findLocalDailyPlaylist(dateStr: string): any | null {
  const name = `每日推荐(本地) ${dateStr}`;
  const rows = sqlite.prepare("SELECT * FROM playlists WHERE name = ? AND comment LIKE ?").all(name, `%${DAILY_TAG_LOCAL}%`) as any[];
  return rows[0] || null;
}

function getSettingBool(key: string, def: boolean): boolean {
  const row = sqlite.prepare("SELECT value FROM settings WHERE key = ?").get(key) as any;
  const v = row?.value ?? (def ? "true" : "false");
  return v === "true" || v === "1";
}

// Build today's local daily playlist. Idempotent. Returns null when disabled
// or when the library is empty.
export async function generateLocalDailyPlaylist(date = new Date()): Promise<LocalRecommendResult | null> {
  if (!getSettingBool("daily_recommend_local_enabled", true)) return null;

  const dateStr = todayStr(date);
  const existing = findLocalDailyPlaylist(dateStr);
  if (existing) {
    return {
      date: dateStr,
      playlistId: existing.id,
      name: existing.name,
      total: existing.song_count || 0,
      sourceUsers: 0,
      fallback: false,
      skipped: true,
    };
  }

  const profile = buildTasteProfile();
  let songIds = pickCandidateSongs(profile, date, LOCAL_PLAYLIST_SIZE);
  let fallback = false;
  if (songIds.length < 5) {
    // Not enough history (or library is small) — fall back to a deterministic
    // library sample so the user always gets *something* for the day.
    songIds = pickRandomSample(date, LOCAL_PLAYLIST_SIZE);
    fallback = true;
  }
  if (songIds.length === 0) return null;

  const playlistId = `pl-${Date.now()}`;
  const name = `每日推荐(本地) ${dateStr}`;
  const ownerId = pickSystemOwnerId();

  sqlite.prepare(`
    INSERT INTO playlists (id, name, owner_id, is_public, comment, cover_art, source_url, source_platform, external_id, sync_enabled, created_at, updated_at)
    VALUES (?, ?, ?, 1, ?, NULL, NULL, 'local', NULL, 0, ?, ?)
  `).run(
    playlistId, name, ownerId,
    `${DAILY_TAG_LOCAL} 基于本地播放历史${fallback ? "(随机采样)" : ""}`,
    new Date().toISOString(), new Date().toISOString()
  );

  // Insert all entries as playable (they all come from the local library).
  const insertStmt = sqlite.prepare(`
    INSERT INTO playlist_songs (playlist_id, song_id, position, playable, created_at)
    VALUES (?, ?, ?, 1, ?)
  `);
  const now = new Date().toISOString();
  let totalDuration = 0;
  let total = 0;
  const tx = sqlite.transaction((rows: { id: string; duration: number }[]) => {
    rows.forEach((s, i) => {
      insertStmt.run(playlistId, s.id, i, now);
      totalDuration += s.duration || 0;
      total++;
    });
    sqlite.prepare("UPDATE playlists SET song_count = ?, duration = ?, updated_at = ? WHERE id = ?")
      .run(total, totalDuration, now, playlistId);
  });

  // Fetch durations in the same order as songIds.
  const songs: { id: string; duration: number }[] = [];
  const idToSong = new Map<string, { id: string; duration: number }>();
  for (let i = 0; i < songIds.length; i += 500) {
    const batch = songIds.slice(i, i + 500);
    const placeholders = batch.map(() => "?").join(",");
    const rows = sqlite.prepare(`SELECT id, duration FROM songs WHERE id IN (${placeholders})`).all(...batch) as { id: string; duration: number }[];
    for (const r of rows) idToSong.set(r.id, r);
  }
  for (const id of songIds) {
    const s = idToSong.get(id);
    if (s) songs.push(s);
  }
  tx(songs);

  return {
    date: dateStr,
    playlistId,
    name,
    total,
    sourceUsers: profile.userCount,
    fallback,
    skipped: false,
  };
}

// Top-level entry for the scheduler. Never throws.
export async function runLocalDailyRecommendJob(): Promise<LocalRecommendResult | null> {
  try {
    const result = await generateLocalDailyPlaylist();
    if (result && !result.skipped) {
      console.log(`[LOCAL-RECOMMEND] ${result.date}: ${result.total} songs${result.fallback ? " (fallback random sample)" : ` from ${result.sourceUsers} user(s)`}`);
    }
    return result;
  } catch (e: any) {
    console.error("[LOCAL-RECOMMEND] error:", e.message || e);
    return null;
  }
}
