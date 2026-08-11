// Daily-recommend playlist generator — combined edition.
//
// Each day at the configured hour, this builds a SINGLE combined "今日推荐"
// playlist by merging songs from THREE sources (all in ONE playlist):
//
//   1. Remote charts (QQ + NetEase): fetch EVERY candidate in the configured
//      pool (not just one), match against the local library. Matched songs
//      become playable entries; unmatched ones become stubs + wish entries,
//      exactly like a manual playlist import.
//   2. User recommend pool (recommend_pool table): all pool members (every
//      user's favorites + playlists manually added to the pool). Randomly
//      picks 50 PLAYABLE songs (guaranteed in the library).
//   3. Full-library random: picks 50 random playable songs from the entire
//      local library (date-seeded so the same day yields the same set).
//
// Dedup: pool songs and full-library random songs are deduplicated against
// the remote-matched songs already in the playlist (and against each other)
// so the same track never appears twice.
//
// STABLE ID (only ONE playlist ever exists, with a FIXED id):
//   - "今日推荐"  — today's combined playlist (id: pl-daily-today)
//
// The id is FIXED and never changes across days. Each run rebuilds today's
// content fresh into the same fixed "今日推荐" row (rebuildPlaylistEntries
// clears the old entries first); the previous day's content is simply
// discarded — no "昨日推荐" archive is kept anymore.
// This keeps clients (web/app/HA/card) able to reference the playlist by a
// constant id, and avoids the daily CREATE+DELETE of playlist rows and the
// daily create+delete of cover files (the cover file name is now stable too).
//
// Failure safety: remote fetches happen BEFORE any DB mutation, so if all
// networks are down, existing playlists are untouched.
import { sqlite } from "../../db/index.js";
import { importPlaylistFromUrl } from "./playlistImport.js";
import { rebuildPlaylistEntries } from "./playlistSync.js";
import { copyCoverToFile } from "../playlistCover.js";
import { pickRandomLibrarySongs } from "./localRecommend.js";
import { firstEnabledByCapability } from "../../plugins/registry.js";
import type { PluginManifest, RecommenderPlugin } from "../../plugins/types.js";

export interface DailyCandidate {
  platform: "qq" | "netease";
  url: string;
  name?: string;
}

export interface DailyRecommendResult {
  date: string;
  playlistId: string;
  name: string;
  picked: DailyCandidate[];          // all candidates fetched this run
  platform: string;                   // "mixed"
  total: number;                      // total entries (matched + stubs + pool + random)
  matched: number;                    // remote songs matched to local library
  unmatched: number;                  // remote songs that became stubs
  wishAdded: number;
  poolSongsAdded: number;             // songs added from user recommend pool
  poolMembers: number;                // how many pool members contributed
  randomSongsAdded: number;           // songs added from full-library random pick
  skipped: boolean;
}

export const DAILY_TAG = "[daily-recommend]";
export const DAILY_TAG_LOCAL = "[daily-recommend-local]";

// Fixed playlist id — this NEVER changes, so clients can reference the daily
// playlist by a stable id.
export const FIXED_TODAY_ID = "pl-daily-today";

const NAME_TODAY = "今日推荐";

// How many random playable songs to pull from each user-pool member as
// CANDIDATES (before the final pool-wide pick).
const POOL_MEMBER_CANDIDATE_SIZE = 200;
// Final size of the user-recommend-pool contribution to the daily playlist.
// Candidates from all pool members are merged, deduped, then this many are
// picked with a date-seeded shuffle.
const POOL_FINAL_SIZE = 50;
// How many random songs to pull from the entire local library (in addition to
// the user pool).
const RANDOM_LIBRARY_SAMPLE_SIZE = 50;

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

// mulberry32 PRNG — deterministic per (seed, index) so the same day always
// picks the same 50 songs from a given pool member.
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Charts excluded from the candidate pool per user request:
//   - QQ音乐·巅峰榜新歌 (toplist/27)   — name contains "新歌"
//   - QQ音乐·巅峰榜欧美 (toplist/60)   — name contains "欧美"
//   - 网易云·新歌榜     (playlist?id=3779629) — name contains "新歌"
// These are filtered out in loadCandidates() as a safety net so that even if
// someone adds them via the admin API, they will never be fetched.
const BLOCKED_CANDIDATE_URL_PATTERNS: RegExp[] = [
  /toplist\/27\b/i,          // QQ 巅峰榜新歌
  /toplist\/60\b/i,          // QQ 巅峰榜欧美
  /[?&]id=3779629\b/i,       // 网易云 新歌榜
];
const BLOCKED_CANDIDATE_NAME_KEYWORDS: string[] = ["新歌", "欧美"];

export function isCandidateBlocked(c: { platform?: string; url?: string; name?: string }): boolean {
  const url = (c.url || "").trim();
  if (url && BLOCKED_CANDIDATE_URL_PATTERNS.some(re => re.test(url))) return true;
  const name = (c.name || "").trim();
  if (name && BLOCKED_CANDIDATE_NAME_KEYWORDS.some(kw => name.includes(kw))) return true;
  return false;
}

export function loadCandidates(): DailyCandidate[] {
  const row = sqlite.prepare("SELECT value FROM settings WHERE key = ?").get("daily_recommend_candidates") as any;
  if (!row?.value) return [];
  try {
    const arr = JSON.parse(row.value);
    if (!Array.isArray(arr)) return [];
    return arr
      .filter((c: any) => c && typeof c.url === "string" && typeof c.platform === "string")
      .filter((c: any) => !isCandidateBlocked(c))
      .map((c: any) => ({ platform: c.platform, url: c.url, name: c.name }));
  } catch {
    return [];
  }
}

export function saveCandidates(candidates: DailyCandidate[]): void {
  sqlite.prepare("INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES (?, ?, ?)")
    .run("daily_recommend_candidates", JSON.stringify(candidates), new Date().toISOString());
}

function getSetting(key: string, def: string): string {
  const row = sqlite.prepare("SELECT value FROM settings WHERE key = ?").get(key) as any;
  return row?.value ?? def;
}

function getSettingBool(key: string, def: boolean): boolean {
  const v = getSetting(key, def ? "true" : "false");
  return v === "true" || v === "1";
}

// Deterministic pick of today's candidate subset. We fetch ALL candidates but
// rotate the START offset by day, so even if the pool is huge, each day's
// combined mix starts from a different chart. (Kept for API compatibility —
// the admin UI shows what "today's pick" would be.)
export function pickDailyCandidate(date = new Date()): DailyCandidate | null {
  const pool = loadCandidates();
  if (pool.length === 0) return null;
  const seed = dayOfYear(date);
  return pool[seed % pool.length];
}

function findPlaylistByName(name: string, tag: string): any | null {
  const rows = sqlite.prepare("SELECT * FROM playlists WHERE name = ? AND comment LIKE ?").all(name, `%${tag}%`) as any[];
  return rows[0] || null;
}

// True once today's combined playlist has already been (re)generated today.
// We stamp the generation date into the playlist's comment, so idempotency no
// longer depends on created_at (which is now fixed, since the row is reused).
function isGeneratedToday(playlist: any, dateStr: string): boolean {
  return !!(playlist && (playlist.comment || "").includes(dateStr));
}

// Ensure the fixed-id daily playlist exists. On first run (or after an upgrade
// from the old two-playlist scheme) this:
//   - adopts any existing "[daily-recommend]" tagged "今日推荐" playlist into
//     the fixed id (so no content is lost and no duplicate playlists appear), and
//   - creates the fixed row if it's still missing.
//
// Note: existing "昨日推荐" playlists are intentionally NOT deleted here — the
// user may delete them manually. The daily generator simply stops creating or
// updating them.
function ensureDailyPlaylists(): void {
  const todayFixed = sqlite.prepare("SELECT * FROM playlists WHERE id = ?").get(FIXED_TODAY_ID) as any;
  if (!todayFixed) {
    const ownerId = pickSystemOwnerId();
    const now = new Date().toISOString();
    const legacy = findPlaylistByName(NAME_TODAY, DAILY_TAG);
    if (legacy) {
      sqlite.prepare("UPDATE playlists SET id = ?, name = ?, comment = ? WHERE id = ?")
        .run(FIXED_TODAY_ID, NAME_TODAY, `${DAILY_TAG} (migrated)`, legacy.id);
    } else {
      sqlite.prepare(`
        INSERT INTO playlists (id, name, owner_id, is_public, comment, cover_art, source_url, source_platform, external_id, sync_enabled, created_at, updated_at)
        VALUES (?, ?, ?, 1, ?, NULL, NULL, 'mixed', NULL, 0, ?, ?)
      `).run(FIXED_TODAY_ID, NAME_TODAY, ownerId, `${DAILY_TAG}`, now, now);
    }
  }
}

// Pull the local-library contribution for today's daily playlist through the
// `localPlaylist` capability. Falls back to a full-library random sample when
// no local-recommend plugin is enabled (or one throws).
async function pickLocalSongsForDaily(date: Date): Promise<string[]> {
  const lp = firstEnabledByCapability("localPlaylist");
  if (lp && typeof lp.impl?.pickSongs === "function") {
    try {
      const r = await lp.impl.pickSongs(date);
      if (r && r.songIds.length) return r.songIds.slice(0, RANDOM_LIBRARY_SAMPLE_SIZE);
    } catch (e: any) {
      console.error("[DAILY-RECOMMEND] local-recommend plugin failed, using random sample:", e?.message || e);
    }
  }
  return pickRandomLibrarySongs(date, RANDOM_LIBRARY_SAMPLE_SIZE);
}

// Pick a random local-library song's album cover file ref. Used as the daily
// playlist cover so it always reflects real local music (not a remote chart
// cover). Returns null if the library has no songs with album covers yet.
//
// Resource note: uses rowid over-sampling instead of `ORDER BY RANDOM()`, so
// it never sorts the entire songs table (cheap even with a huge library).
function pickRandomLibraryAlbumCoverRef(date: Date): string | null {
  const meta = sqlite.prepare(`
    SELECT COUNT(*) AS n, MAX(rowid) AS maxR
    FROM songs WHERE path IS NOT NULL AND cover_art IS NOT NULL AND cover_art <> ''
  `).get() as { n: number; maxR: number | null };
  if (!meta.n || !meta.maxR) return null;
  const rng = mulberry32(dayOfYear(date) * 91331 + 3);
  for (let attempt = 0; attempt < 6; attempt++) {
    const rowids = new Set<number>();
    for (let i = 0; i < 3; i++) rowids.add(1 + Math.floor(rng() * meta.maxR));
    const arr = Array.from(rowids);
    const ph = arr.map(() => "?").join(",");
    const rows = sqlite.prepare(`
      SELECT cover_art FROM songs
      WHERE rowid IN (${ph}) AND path IS NOT NULL AND cover_art IS NOT NULL AND cover_art <> ''
    `).all(...arr) as { cover_art: string }[];
    if (rows.length) return rows[0].cover_art;
  }
  return null;
}

function pickSystemOwnerId(): string {
  const admin = sqlite.prepare("SELECT id FROM users WHERE is_admin = 1 LIMIT 1").get() as any;
  return admin?.id || "";
}

// ==================== User recommend pool ====================

export interface RecommendPoolEntry {
  id: number;
  source_type: string;
  source_id: string;
  source_name: string;
  user_id: string;
  enabled: number;
}

export function listRecommendPool(): RecommendPoolEntry[] {
  return sqlite.prepare("SELECT * FROM recommend_pool WHERE enabled = 1 ORDER BY created_at").all() as RecommendPoolEntry[];
}

// Add a source to the user recommend pool. Idempotent (unique index on
// source_type + source_id). Returns true if newly added, false if already present.
export function addToRecommendPool(sourceType: string, sourceId: string, sourceName: string, userId: string): boolean {
  const existing = sqlite.prepare("SELECT id FROM recommend_pool WHERE source_type = ? AND source_id = ?").get(sourceType, sourceId) as any;
  if (existing) return false;
  const now = new Date().toISOString();
  sqlite.prepare(`
    INSERT INTO recommend_pool (source_type, source_id, source_name, user_id, enabled, created_at, updated_at)
    VALUES (?, ?, ?, ?, 1, ?, ?)
  `).run(sourceType, sourceId, sourceName, userId, now, now);
  return true;
}

export function removeFromRecommendPool(sourceType: string, sourceId: string): boolean {
  const r = sqlite.prepare("DELETE FROM recommend_pool WHERE source_type = ? AND source_id = ?").run(sourceType, sourceId);
  return r.changes > 0;
}

export function isInRecommendPool(sourceType: string, sourceId: string): boolean {
  const row = sqlite.prepare("SELECT id FROM recommend_pool WHERE source_type = ? AND source_id = ?").get(sourceType, sourceId) as any;
  return !!row;
}

// Pick up to `limit` random playable song ids from a pool member.
// For "playlist": from playlist_songs joined to songs where playable=1.
// For "favorites": from user_favorite_songs joined to songs.
//
// Resource strategy (O(limit) — never loads the whole member playlist):
//   - One COUNT(*) + MAX(rowid) to know the rowid range of qualifying rows.
//   - Over-sample random rowids (bounded by 2x the deficit) and fetch only
//     those, so even a pool member with thousands of songs only ever pulls a
//     few hundred candidate ids into memory.
// Uses a date-seeded PRNG so the same day picks the same set (deterministic).
function pickSongsFromPoolMember(entry: RecommendPoolEntry, date: Date, limit: number): string[] {
  const rng = mulberry32(dayOfYear(date) * 2654435761 + entry.id * 40503);
  let candidateIds: string[] = [];
  if (entry.source_type === "playlist") {
    candidateIds = samplePlayablePlaylistSongIds(entry.source_id, rng, limit);
  } else if (entry.source_type === "favorites") {
    candidateIds = sampleFavoriteSongIds(entry.source_id, rng, limit);
  }
  if (candidateIds.length === 0) return [];
  // Deterministic shuffle of the sampled set (same day -> same order).
  for (let i = candidateIds.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [candidateIds[i], candidateIds[j]] = [candidateIds[j], candidateIds[i]];
  }
  return candidateIds.slice(0, limit);
}

// Bounded sampler over a playlist member's playable songs. Uses rowid
// over-sampling so it never loads the entire (possibly huge) playlist.
function samplePlayablePlaylistSongIds(playlistId: string, rng: () => number, limit: number): string[] {
  const meta = sqlite.prepare(`
    SELECT COUNT(*) AS n, MAX(rowid) AS maxR
    FROM playlist_songs WHERE playlist_id = ? AND playable = 1 AND song_id IS NOT NULL
  `).get(playlistId) as { n: number; maxR: number | null };
  if (!meta.n || !meta.maxR) return [];
  const ids = new Set<string>();
  let attempt = 0;
  while (ids.size < limit && attempt < 6) {
    attempt++;
    const want = (limit - ids.size) * 2 + 1;
    const rowids = new Set<number>();
    for (let i = 0; i < want; i++) rowids.add(1 + Math.floor(rng() * meta.maxR!));
    if (rowids.size === 0) break;
    const arr = Array.from(rowids);
    for (let i = 0; i < arr.length; i += 500) {
      const batch = arr.slice(i, i + 500);
      const ph = batch.map(() => "?").join(",");
      const rows = sqlite.prepare(`
        SELECT song_id FROM playlist_songs
        WHERE rowid IN (${ph}) AND playlist_id = ? AND playable = 1 AND song_id IS NOT NULL
      `).all(...batch, playlistId) as { song_id: string }[];
      for (const r of rows) { if (ids.size < limit) ids.add(r.song_id); }
      if (ids.size >= limit) break;
    }
  }
  return Array.from(ids);
}

// Bounded sampler over a user's favorites. Same rowid over-sampling technique.
function sampleFavoriteSongIds(userId: string, rng: () => number, limit: number): string[] {
  const meta = sqlite.prepare(`
    SELECT COUNT(*) AS n, MAX(uf.rowid) AS maxR
    FROM user_favorite_songs uf JOIN songs s ON uf.song_id = s.id
    WHERE uf.user_id = ? AND s.path IS NOT NULL
  `).get(userId) as { n: number; maxR: number | null };
  if (!meta.n || !meta.maxR) return [];
  const ids = new Set<string>();
  let attempt = 0;
  while (ids.size < limit && attempt < 6) {
    attempt++;
    const want = (limit - ids.size) * 2 + 1;
    const rowids = new Set<number>();
    for (let i = 0; i < want; i++) rowids.add(1 + Math.floor(rng() * meta.maxR!));
    if (rowids.size === 0) break;
    const arr = Array.from(rowids);
    for (let i = 0; i < arr.length; i += 500) {
      const batch = arr.slice(i, i + 500);
      const ph = batch.map(() => "?").join(",");
      const rows = sqlite.prepare(`
        SELECT uf.song_id AS song_id FROM user_favorite_songs uf
        JOIN songs s ON uf.song_id = s.id
        WHERE uf.rowid IN (${ph}) AND uf.user_id = ? AND s.path IS NOT NULL
      `).all(...batch, userId) as { song_id: string }[];
      for (const r of rows) { if (ids.size < limit) ids.add(r.song_id); }
      if (ids.size >= limit) break;
    }
  }
  return Array.from(ids);
}

// Collect playable song ids from every enabled pool member, merge+dedupe, then
// pick POOL_FINAL_SIZE with a date-seeded shuffle so the whole pool contributes
// a fixed number of songs to the daily playlist.
function collectPoolSongs(date: Date): { songIds: string[]; members: number } {
  const pool = listRecommendPool();
  if (pool.length === 0) return { songIds: [], members: 0 };
  const all = new Set<string>();
  for (const entry of pool) {
    // Pull candidates (up to POOL_MEMBER_CANDIDATE_SIZE) from each member.
    const ids = pickSongsFromPoolMember(entry, date, POOL_MEMBER_CANDIDATE_SIZE);
    for (const id of ids) all.add(id);
  }
  if (all.size === 0) return { songIds: [], members: pool.length };
  // Date-seeded shuffle of the merged pool, then take POOL_FINAL_SIZE.
  const arr = Array.from(all);
  const rng = mulberry32(dayOfYear(date) * 2654435761 + 99991);
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return { songIds: arr.slice(0, POOL_FINAL_SIZE), members: pool.length };
}

// ==================== Main generation ====================

export async function generateDailyPlaylist(date = new Date()): Promise<DailyRecommendResult> {
  const dateStr = todayStr(date);
  ensureDailyPlaylists();

  const todayRow = sqlite.prepare("SELECT * FROM playlists WHERE id = ?").get(FIXED_TODAY_ID) as any;
  if (isGeneratedToday(todayRow, dateStr)) {
    return {
      date: dateStr,
      playlistId: FIXED_TODAY_ID,
      name: NAME_TODAY,
      picked: [],
      platform: "mixed",
      total: 0, matched: 0, unmatched: 0, wishAdded: 0,
      poolSongsAdded: 0, poolMembers: 0,
      randomSongsAdded: 0,
      skipped: true,
    };
  }

  const candidates = loadCandidates();
  const ownerId = pickSystemOwnerId();

  // Step 1: fetch ALL remote playlists FIRST (before any DB mutation).
  // Collect tracks from every successful fetch; failures are logged but don't
  // abort the whole run — we still want pool songs + local mix to work.
  const remoteImports: { name: string; platform: string; coverUrl?: string; tracks: any[] }[] = [];
  for (const c of candidates) {
    try {
      const imported = await importPlaylistFromUrl(c.url);
      remoteImports.push(imported);
      console.log(`[DAILY-RECOMMEND] fetched ${c.platform} "${c.name || c.url}": ${imported.tracks.length} tracks`);
    } catch (e: any) {
      console.error(`[DAILY-RECOMMEND] fetch failed for ${c.platform} "${c.name || c.url}": ${e.message || e}`);
    }
  }

  // Step 2: collect user pool songs + a local-library mix.
  const { songIds: poolSongIds, members: poolMembers } = collectPoolSongs(date);
  // Prefer the local-recommend plugin (taste-profile based) when enabled;
  // fall back to a plain full-library random sample otherwise.
  const randomLibraryIds = await pickLocalSongsForDaily(date);

  // If we have nothing at all (no remote, no pool, no random), bail out without
  // touching the existing playlist — better to keep today's previous content
  // than to have an empty one.
  const totalRemoteTracks = remoteImports.reduce((n, imp) => n + imp.tracks.length, 0);
  if (totalRemoteTracks === 0 && poolSongIds.length === 0 && randomLibraryIds.length === 0) {
    throw new Error("今日推荐生成失败:所有远程榜单抓取失败且用户推荐池和曲库随机均为空");
  }

  // ============ Rebuild today's fixed-id playlist ============
  // rebuildPlaylistEntries clears today's existing entries and inserts the new
  // remote-matched tracks. The previous day's content is simply discarded —
  // there is no "昨日推荐" archive anymore.
  const now = new Date().toISOString();
  const playlistId = FIXED_TODAY_ID;

  // Cover = a RANDOM local-library song's album cover (per product要求).
  // Copied to pl-daily-today.jpg so it is self-contained and survives daily
  // regeneration (the playlist id is fixed, so the cover file name is stable).
  let coverRef: string | undefined;
  const albumCoverRef = pickRandomLibraryAlbumCoverRef(date);
  if (albumCoverRef) {
    const copied = copyCoverToFile(`pl-${playlistId}.jpg`, albumCoverRef);
    if (copied) coverRef = copied;
  }

  // Build a merged "ImportedPlaylist" from all remote tracks so we can reuse
  // rebuildPlaylistEntries (which handles matching + stubs + wishes).
  const mergedTracks = remoteImports.flatMap(i => i.tracks);
  // Dedupe merged tracks by externalId+title to avoid double stubs.
  const seenTrackKeys = new Set<string>();
  const dedupedTracks = mergedTracks.filter(t => {
    const key = `${t.externalId}|${t.title}|${t.artist}`;
    if (seenTrackKeys.has(key)) return false;
    seenTrackKeys.add(key);
    return true;
  });

  const sourceLabel = remoteImports.map(i => i.name).filter(Boolean).join(" + ") || "用户推荐池";
  const extraParts: string[] = [];
  if (poolMembers > 0) extraParts.push(`${poolMembers}个用户推荐池`);
  if (randomLibraryIds.length > 0) extraParts.push("曲库随机");

  // Seed remote tracks via rebuildPlaylistEntries (matching + stubs + wishes).
  let matched = 0, unmatched = 0, wishAdded = 0;
  if (dedupedTracks.length > 0) {
    const result = await rebuildPlaylistEntries(playlistId, {
      name: NAME_TODAY,
      platform: "mixed",
      tracks: dedupedTracks,
    }, {
      userId: ownerId,
      autoWish: true,
      notes: `来自今日推荐组合`,
    });
    matched = result.matched;
    unmatched = result.unmatched;
    wishAdded = result.wishAdded;
  }

  // Collect song_ids already in the playlist (from remote matching)
  // so we can dedup pool songs and local songs against them.
  const existingSongIds = new Set<string>(
    sqlite.prepare("SELECT song_id FROM playlist_songs WHERE playlist_id = ?").all(playlistId)
      .map((r: any) => r.song_id as string)
  );

  // Append pool songs as playable entries, DEDUPED against remote-matched songs.
  let poolSongsAdded = 0;
  const dedupedPoolIds = poolSongIds.filter(id => !existingSongIds.has(id));
  if (dedupedPoolIds.length > 0) {
    // Determine next position.
    const maxPosRow = sqlite.prepare("SELECT MAX(position) AS m FROM playlist_songs WHERE playlist_id = ?").get(playlistId) as any;
    let nextPos = (maxPosRow?.m ?? -1) + 1;

    // Fetch durations.
    const idToDuration = new Map<string, number>();
    for (let i = 0; i < dedupedPoolIds.length; i += 500) {
      const batch = dedupedPoolIds.slice(i, i + 500);
      const placeholders = batch.map(() => "?").join(",");
      const rows = sqlite.prepare(`SELECT id, duration FROM songs WHERE id IN (${placeholders})`).all(...batch) as { id: string; duration: number }[];
      for (const r of rows) idToDuration.set(r.id, r.duration || 0);
    }

    const now2 = new Date().toISOString();
    const insertStmt = sqlite.prepare(`
      INSERT INTO playlist_songs (playlist_id, song_id, position, playable, created_at)
      VALUES (?, ?, ?, 1, ?)
    `);
    let addedDuration = 0;
    const tx = sqlite.transaction((ids: string[]) => {
      for (const id of ids) {
        insertStmt.run(playlistId, id, nextPos++, now2);
        addedDuration += idToDuration.get(id) || 0;
        poolSongsAdded++;
        existingSongIds.add(id);
      }
    });
    tx(dedupedPoolIds);

    // Update counts.
    const plRow = sqlite.prepare("SELECT song_count, duration FROM playlists WHERE id = ?").get(playlistId) as any;
    sqlite.prepare("UPDATE playlists SET song_count = ?, duration = ?, updated_at = ? WHERE id = ?")
      .run((plRow?.song_count || 0) + poolSongsAdded, (plRow?.duration || 0) + addedDuration, now2, playlistId);
  }

  // Append full-library random songs, DEDUPED against everything above.
  let randomSongsAdded = 0;
  const dedupedRandomIds = randomLibraryIds.filter(id => !existingSongIds.has(id));
  if (dedupedRandomIds.length > 0) {
    const maxPosRow = sqlite.prepare("SELECT MAX(position) AS m FROM playlist_songs WHERE playlist_id = ?").get(playlistId) as any;
    let nextPos = (maxPosRow?.m ?? -1) + 1;

    const idToDuration = new Map<string, number>();
    for (let i = 0; i < dedupedRandomIds.length; i += 500) {
      const batch = dedupedRandomIds.slice(i, i + 500);
      const placeholders = batch.map(() => "?").join(",");
      const rows = sqlite.prepare(`SELECT id, duration FROM songs WHERE id IN (${placeholders})`).all(...batch) as { id: string; duration: number }[];
      for (const r of rows) idToDuration.set(r.id, r.duration || 0);
    }

    const now2 = new Date().toISOString();
    const insertStmt = sqlite.prepare(`
      INSERT INTO playlist_songs (playlist_id, song_id, position, playable, created_at)
      VALUES (?, ?, ?, 1, ?)
    `);
    let addedDuration = 0;
    const tx = sqlite.transaction((ids: string[]) => {
      for (const id of ids) {
        insertStmt.run(playlistId, id, nextPos++, now2);
        addedDuration += idToDuration.get(id) || 0;
        randomSongsAdded++;
      }
    });
    tx(dedupedRandomIds);

    const plRow = sqlite.prepare("SELECT song_count, duration FROM playlists WHERE id = ?").get(playlistId) as any;
    sqlite.prepare("UPDATE playlists SET song_count = ?, duration = ?, updated_at = ? WHERE id = ?")
      .run((plRow?.song_count || 0) + randomSongsAdded, (plRow?.duration || 0) + addedDuration, now2, playlistId);
  }

  // Finalize the TODAY row: stamp the generation date into the comment (for
  // idempotency), set the new cover, and refresh timestamps.
  sqlite.prepare("UPDATE playlists SET cover_art = ?, comment = ?, updated_at = ? WHERE id = ?")
    .run(
      coverRef || null,
      `${DAILY_TAG} ${dateStr} 组合自「${sourceLabel}」${extraParts.length > 0 ? ` + ${extraParts.join(" + ")}` : ""}`,
      now,
      playlistId
    );

  return {
    date: dateStr,
    playlistId,
    name: NAME_TODAY,
    picked: candidates,
    platform: "mixed",
    total: matched + unmatched + poolSongsAdded + randomSongsAdded,
    matched,
    unmatched,
    wishAdded,
    poolSongsAdded,
    poolMembers,
    randomSongsAdded,
    skipped: false,
  };
}

export async function runDailyRecommendJob(): Promise<DailyRecommendResult | null> {
  if (!getSettingBool("daily_recommend_enabled", true)) return null;
  // Fresh installs have no local library yet; generating "今日推荐" from empty
  // would only create a playlist full of non-playable remote stubs. Skip until
  // the user actually has songs.
  const localCount = sqlite.prepare("SELECT COUNT(*) AS n FROM songs WHERE suffix IS NOT NULL AND path IS NOT NULL").get() as { n: number };
  if (!localCount || localCount.n === 0) {
    console.log("[DAILY-RECOMMEND] local library empty, skipping today's recommendation");
    return null;
  }
  try {
    const result = await generateDailyPlaylist();
    if (!result.skipped) {
      console.log(`[DAILY-RECOMMEND] ${result.date}: ${result.picked.length} charts + ${result.poolMembers} pool members + ${result.randomSongsAdded} random -> ${result.matched} matched, ${result.unmatched} stubs, ${result.wishAdded} wishes, ${result.poolSongsAdded} pool`);
    }
    return result;
  } catch (e: any) {
    console.error("[DAILY-RECOMMEND] error:", e.message || e);
    return null;
  }
}

// Backward-compat no-op (rename mechanism handles retention).
export function purgeOldDailyPlaylists(_retentionDays: number): number {
  return 0;
}

// ==================== Plugin (recommender) ====================
//
// Registered as a `recommender` plugin so the daily scheduler picks it up by
// capability ("dailyPlaylist") instead of importing runDailyRecommendJob
// directly. localRecommend is NOT a separate plugin: its output is merged into
// this playlist (see generateDailyPlaylist), so it stays an internal helper.

export const DAILY_RECOMMEND_PLUGIN_ID = "daily-recommend";

export const dailyRecommendManifest: PluginManifest = {
  id: DAILY_RECOMMEND_PLUGIN_ID,
  name: "每日推荐",
  version: "1.0.0",
  type: "recommender",
  description: "每天生成「今日推荐」歌单:平台榜单候选 + 推荐池成员 + 本地曲库随机补充",
  capabilities: ["dailyPlaylist"],
  defaultEnabled: true,
  configSchema: [],
};

export const dailyRecommendPlugin: RecommenderPlugin = {
  manifest: dailyRecommendManifest,
  async runDailyJob(): Promise<string | null> {
    const r = await runDailyRecommendJob();
    if (!r || r.skipped) return null;
    return `${r.date}: ${r.matched} matched, ${r.unmatched} stubs, ${r.poolSongsAdded} pool, ${r.randomSongsAdded} random`;
  },
};
