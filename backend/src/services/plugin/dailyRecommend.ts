// Daily-recommend playlist generator (Plan A) — combined edition.
//
// Each day at the configured hour, this builds a SINGLE combined "今日推荐"
// playlist by merging songs from THREE sources:
//
//   1. Remote charts (QQ + NetEase): fetch EVERY candidate in the configured
//      pool (not just one), match against the local library. Matched songs
//      become playable entries; unmatched ones become stubs + wish entries,
//      exactly like a manual playlist import.
//   2. User recommend pool (recommend_pool table): for each pool member
//      (a user playlist or the user's favorites), randomly pick up to 50
//      PLAYABLE songs (so they're guaranteed to be in the library).
//   3. Local history mix (Plan B, in localRecommend.ts): optional, handled
//      separately and written to its own "今日推荐(本地)" playlist.
//
// Naming / retention (only TWO per kind ever exist):
//   - "今日推荐"    / "昨日推荐"     (this file)
//   - "今日推荐(本地)" / "昨日推荐(本地)"  (localRecommend.ts)
// On each run: old "昨日推荐" is deleted, "今日推荐" is renamed to "昨日推荐",
// new "今日推荐" is created.
//
// Failure safety: remote fetches happen BEFORE any DB mutation, so if all
// networks are down, existing playlists are untouched.
import { sqlite } from "../../db/index.js";
import { importPlaylistFromUrl } from "./playlistImport.js";
import { rebuildPlaylistEntries } from "./playlistSync.js";
import { cacheRemoteCover, clearPlaylistCoverCache } from "../playlistCover.js";

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
  total: number;                      // total entries (matched + stubs + pool)
  matched: number;                    // remote songs matched to local library
  unmatched: number;                  // remote songs that became stubs
  wishAdded: number;
  poolSongsAdded: number;             // songs added from user recommend pool
  poolMembers: number;                // how many pool members contributed
  skipped: boolean;
}

export const DAILY_TAG = "[daily-recommend]";
export const DAILY_TAG_LOCAL = "[daily-recommend-local]";

const NAME_TODAY = "今日推荐";
const NAME_YESTERDAY = "昨日推荐";

// How many random playable songs to pull from each user-pool member.
const POOL_SAMPLE_SIZE = 50;

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

function isCreatedToday(playlist: any, dateStr: string): boolean {
  return (playlist.created_at || "").startsWith(dateStr);
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
// Uses a date-seeded PRNG so the same day picks the same set (deterministic).
function pickSongsFromPoolMember(entry: RecommendPoolEntry, date: Date, limit: number): string[] {
  const rng = mulberry32(dayOfYear(date) * 2654435761 + entry.id * 40503);
  let rows: { id: string }[] = [];
  if (entry.source_type === "playlist") {
    rows = sqlite.prepare(`
      SELECT s.id FROM playlist_songs ps
      JOIN songs s ON ps.song_id = s.id
      WHERE ps.playlist_id = ? AND ps.playable = 1 AND s.path IS NOT NULL
    `).all(entry.source_id) as { id: string }[];
  } else if (entry.source_type === "favorites") {
    rows = sqlite.prepare(`
      SELECT s.id FROM user_favorite_songs uf
      JOIN songs s ON uf.song_id = s.id
      WHERE uf.user_id = ? AND s.path IS NOT NULL
    `).all(entry.source_id) as { id: string }[];
  }
  if (rows.length === 0) return [];
  // Fisher-Yates shuffle with the seeded RNG, then take first `limit`.
  for (let i = rows.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [rows[i], rows[j]] = [rows[j], rows[i]];
  }
  return rows.slice(0, limit).map(r => r.id);
}

// Collect all playable song ids from every enabled pool member (deduped).
function collectPoolSongs(date: Date): { songIds: string[]; members: number } {
  const pool = listRecommendPool();
  if (pool.length === 0) return { songIds: [], members: 0 };
  const all = new Set<string>();
  for (const entry of pool) {
    const ids = pickSongsFromPoolMember(entry, date, POOL_SAMPLE_SIZE);
    for (const id of ids) all.add(id);
  }
  return { songIds: Array.from(all), members: pool.length };
}

// ==================== Main generation ====================

export async function generateDailyPlaylist(date = new Date()): Promise<DailyRecommendResult> {
  const dateStr = todayStr(date);

  // Step 1: idempotency check.
  const todayPl = findPlaylistByName(NAME_TODAY, DAILY_TAG);
  if (todayPl && isCreatedToday(todayPl, dateStr)) {
    return {
      date: dateStr,
      playlistId: todayPl.id,
      name: NAME_TODAY,
      picked: [],
      platform: "mixed",
      total: 0, matched: 0, unmatched: 0, wishAdded: 0,
      poolSongsAdded: 0, poolMembers: 0,
      skipped: true,
    };
  }

  const candidates = loadCandidates();

  // Step 2: fetch ALL remote playlists FIRST (before any DB mutation).
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

  // Step 3: collect user pool songs.
  const { songIds: poolSongIds, members: poolMembers } = collectPoolSongs(date);

  // If we have nothing at all (no remote, no pool), bail out without touching
  // existing playlists — better to keep yesterday's than to have an empty today.
  const totalRemoteTracks = remoteImports.reduce((n, imp) => n + imp.tracks.length, 0);
  if (totalRemoteTracks === 0 && poolSongIds.length === 0) {
    throw new Error("今日推荐生成失败:所有远程榜单抓取失败且用户推荐池为空");
  }

  // Step 4: rename/delete.
  const oldYesterday = findPlaylistByName(NAME_YESTERDAY, DAILY_TAG);
  if (oldYesterday) deletePlaylist(oldYesterday.id);
  if (todayPl) renamePlaylist(todayPl.id, NAME_YESTERDAY);

  // Step 5: create new "今日推荐".
  const playlistId = `pl-${Date.now()}`;
  const ownerId = pickSystemOwnerId();

  // Use the first successful remote cover (or fallback to collage later).
  let coverRef: string | undefined;
  const firstCover = remoteImports.find(i => i.coverUrl)?.coverUrl;
  if (firstCover) {
    const cached = await cacheRemoteCover(firstCover, `pl-${playlistId}`);
    if (cached) coverRef = cached;
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
  sqlite.prepare(`
    INSERT INTO playlists (id, name, owner_id, is_public, comment, cover_art, source_url, source_platform, external_id, sync_enabled, created_at, updated_at)
    VALUES (?, ?, ?, 1, ?, ?, NULL, 'mixed', NULL, 0, ?, ?)
  `).run(
    playlistId, NAME_TODAY, ownerId,
    `${DAILY_TAG} ${dateStr} 组合自「${sourceLabel}」${poolMembers > 0 ? ` + ${poolMembers}个用户推荐池` : ""}`,
    coverRef || null,
    new Date().toISOString(), new Date().toISOString()
  );

  // Step 5a: insert remote tracks via rebuildPlaylistEntries (matching + stubs + wishes).
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

  // Step 5b: append pool songs as playable entries (after remote tracks).
  // Pool songs are added UNCONDITIONALLY (no dedup against remote-matched
  // songs) — the user explicitly added these sources to the pool, so their
  // songs should appear even if a chart already happened to contain the same
  // track. The player UI is responsible for any display-level dedup.
  let poolSongsAdded = 0;
  if (poolSongIds.length > 0) {
    // Determine next position.
    const maxPosRow = sqlite.prepare("SELECT MAX(position) AS m FROM playlist_songs WHERE playlist_id = ?").get(playlistId) as any;
    let nextPos = (maxPosRow?.m ?? -1) + 1;

    // Fetch durations.
    const idToDuration = new Map<string, number>();
    for (let i = 0; i < poolSongIds.length; i += 500) {
      const batch = poolSongIds.slice(i, i + 500);
      const placeholders = batch.map(() => "?").join(",");
      const rows = sqlite.prepare(`SELECT id, duration FROM songs WHERE id IN (${placeholders})`).all(...batch) as { id: string; duration: number }[];
      for (const r of rows) idToDuration.set(r.id, r.duration || 0);
    }

    const now = new Date().toISOString();
    const insertStmt = sqlite.prepare(`
      INSERT INTO playlist_songs (playlist_id, song_id, position, playable, created_at)
      VALUES (?, ?, ?, 1, ?)
    `);
    let addedDuration = 0;
    const tx = sqlite.transaction((ids: string[]) => {
      for (const id of ids) {
        insertStmt.run(playlistId, id, nextPos++, now);
        addedDuration += idToDuration.get(id) || 0;
        poolSongsAdded++;
      }
    });
    tx(poolSongIds);

    // Update counts.
    const plRow = sqlite.prepare("SELECT song_count, duration FROM playlists WHERE id = ?").get(playlistId) as any;
    sqlite.prepare("UPDATE playlists SET song_count = ?, duration = ?, updated_at = ? WHERE id = ?")
      .run((plRow?.song_count || 0) + poolSongsAdded, (plRow?.duration || 0) + addedDuration, now, playlistId);
  }

  return {
    date: dateStr,
    playlistId,
    name: NAME_TODAY,
    picked: candidates,
    platform: "mixed",
    total: matched + unmatched + poolSongsAdded,
    matched,
    unmatched,
    wishAdded,
    poolSongsAdded,
    poolMembers,
    skipped: false,
  };
}

export async function runDailyRecommendJob(): Promise<DailyRecommendResult | null> {
  if (!getSettingBool("daily_recommend_enabled", true)) return null;
  try {
    const result = await generateDailyPlaylist();
    if (!result.skipped) {
      console.log(`[DAILY-RECOMMEND] ${result.date}: ${result.picked.length} charts + ${result.poolMembers} pool members -> ${result.matched} matched, ${result.unmatched} stubs, ${result.wishAdded} wishes, ${result.poolSongsAdded} pool songs`);
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
