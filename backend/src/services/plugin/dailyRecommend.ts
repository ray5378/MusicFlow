// Daily-recommend playlist generator (Plan A).
//
// Every day at the configured hour, pick ONE candidate from the configured pool
// using a date-based seed (so the same day always picks the same one, and the
// pick rotates across days), import it via the existing playlist importer, and
// persist it as a "今日推荐" playlist.
//
// Naming / retention model (only TWO playlists ever exist):
//   - "今日推荐"  — today's playlist
//   - "昨日推荐"  — yesterday's playlist
// On each generation:
//   1. If "今日推荐" was already created today → skip (idempotent).
//   2. Delete the old "昨日推荐" (it's now 2 days old).
//   3. Rename "今日推荐" → "昨日推荐".
//   4. Generate a new "今日推荐".
//
// Crucially, we reuse `rebuildPlaylistEntries` from playlistSync — that's the
// routine that already knows how to deal with the local library not matching
// the remote catalog: matched tracks become playable entries, unmatched tracks
// become stubs (playable=0, externalTitle/Artist preserved) and optionally get
// written to the wish list. So a daily playlist behaves EXACTLY like a manually
// imported one: you see what's in your library, you see what's missing, and the
// missing ones show up in the wish list for later.
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
  picked: DailyCandidate;
  platform: string;
  total: number;
  matched: number;
  unmatched: number;
  wishAdded: number;
  skipped: boolean; // true if today's playlist already existed
}

// Mark stored in playlists.comment so we can find daily-recommend playlists
// without touching user-created ones that happen to share the name.
export const DAILY_TAG = "[daily-recommend]";
export const DAILY_TAG_LOCAL = "[daily-recommend-local]";

// Fixed playlist names.
const NAME_TODAY = "今日推荐";
const NAME_YESTERDAY = "昨日推荐";

function todayStr(d = new Date()): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

// day-of-year (1..366) — used as the rotation seed so the same day always
// resolves to the same candidate and the pick shifts by one each day.
function dayOfYear(d: Date): number {
  const start = new Date(d.getFullYear(), 0, 0);
  return Math.floor((d.getTime() - start.getTime()) / 86400000);
}

// Read & parse the candidate pool from settings. Returns [] on any error.
export function loadCandidates(): DailyCandidate[] {
  const row = sqlite.prepare("SELECT value FROM settings WHERE key = ?").get("daily_recommend_candidates") as any;
  if (!row?.value) return [];
  try {
    const arr = JSON.parse(row.value);
    if (!Array.isArray(arr)) return [];
    return arr
      .filter((c: any) => c && typeof c.url === "string" && typeof c.platform === "string")
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

// Deterministically pick today's candidate from the pool.
export function pickDailyCandidate(date = new Date()): DailyCandidate | null {
  const pool = loadCandidates();
  if (pool.length === 0) return null;
  const seed = dayOfYear(date);
  return pool[seed % pool.length];
}

// Find a playlist by its exact name + comment tag.
function findPlaylistByName(name: string, tag: string): any | null {
  const rows = sqlite.prepare("SELECT * FROM playlists WHERE name = ? AND comment LIKE ?").all(name, `%${tag}%`) as any[];
  return rows[0] || null;
}

// Check if a playlist's created_at date matches today's date string.
function isCreatedToday(playlist: any, dateStr: string): boolean {
  const created = playlist.created_at || "";
  return created.startsWith(dateStr);
}

// Delete a playlist and all its entries + cover cache.
function deletePlaylist(playlistId: string): void {
  sqlite.prepare("DELETE FROM playlist_songs WHERE playlist_id = ?").run(playlistId);
  clearPlaylistCoverCache(playlistId);
  sqlite.prepare("DELETE FROM playlists WHERE id = ?").run(playlistId);
}

// Rename a playlist (just the name field; keep everything else).
function renamePlaylist(playlistId: string, newName: string): void {
  sqlite.prepare("UPDATE playlists SET name = ?, updated_at = ? WHERE id = ?")
    .run(newName, new Date().toISOString(), playlistId);
}

// Pick a system owner for auto-generated playlists. We use the first admin so
// foreign-key constraints hold; daily playlists are isPublic=1 so everyone sees them.
function pickSystemOwnerId(): string {
  const admin = sqlite.prepare("SELECT id FROM users WHERE is_admin = 1 LIMIT 1").get() as any;
  return admin?.id || "";
}

// Build today's daily playlist.
//
// Idempotent: if "今日推荐" was already created today, returns skipped=true.
// Otherwise: delete old "昨日推荐" → rename "今日推荐" to "昨日推荐" → create new "今日推荐".
// Throws on fetch errors (caller should catch).
export async function generateDailyPlaylist(date = new Date()): Promise<DailyRecommendResult> {
  const dateStr = todayStr(date);

  // Step 1: idempotency check — if "今日推荐" exists and was created today, skip.
  const todayPl = findPlaylistByName(NAME_TODAY, DAILY_TAG);
  if (todayPl && isCreatedToday(todayPl, dateStr)) {
    return {
      date: dateStr,
      playlistId: todayPl.id,
      name: NAME_TODAY,
      picked: { platform: todayPl.source_platform || "", url: todayPl.source_url || "" },
      platform: todayPl.source_platform || "",
      total: 0, matched: 0, unmatched: 0, wishAdded: 0,
      skipped: true,
    };
  }

  const picked = pickDailyCandidate(date);
  if (!picked) throw new Error("每日推荐候选池为空,请在设置中配置 daily_recommend_candidates");

  // Step 2: fetch the remote playlist FIRST (before any DB mutation), so that
  // if the network fails we don't end up with a missing "今日推荐" and a lost
  // "昨日推荐".
  const imported = await importPlaylistFromUrl(picked.url);

  // Step 3: delete old "昨日推荐" (it's now 2 days old).
  const oldYesterday = findPlaylistByName(NAME_YESTERDAY, DAILY_TAG);
  if (oldYesterday) {
    deletePlaylist(oldYesterday.id);
  }

  // Step 4: rename existing "今日推荐" → "昨日推荐" (it becomes yesterday's).
  if (todayPl) {
    renamePlaylist(todayPl.id, NAME_YESTERDAY);
  }

  // Step 5: create new "今日推荐".
  const playlistId = `pl-${Date.now()}`;
  let coverRef: string | undefined;
  if (imported.coverUrl) {
    const cached = await cacheRemoteCover(imported.coverUrl, `pl-${playlistId}`);
    if (cached) coverRef = cached;
  }

  const ownerId = pickSystemOwnerId();
  sqlite.prepare(`
    INSERT INTO playlists (id, name, owner_id, is_public, comment, cover_art, source_url, source_platform, external_id, sync_enabled, created_at, updated_at)
    VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?, 0, ?, ?)
  `).run(
    playlistId, NAME_TODAY, ownerId,
    `${DAILY_TAG} ${dateStr} 来自「${picked.name || picked.url}」`,
    coverRef || null,
    picked.url, imported.platform, picked.url,
    new Date().toISOString(), new Date().toISOString()
  );

  // Reuse the exact same matching/stub/wish pipeline as a manual import.
  const result = await rebuildPlaylistEntries(playlistId, imported, {
    userId: ownerId,
    autoWish: true,
    notes: `来自今日推荐「${picked.name || picked.url}」`,
  });

  return {
    date: dateStr,
    playlistId,
    name: NAME_TODAY,
    picked,
    platform: imported.platform,
    total: result.total,
    matched: result.matched,
    unmatched: result.unmatched,
    wishAdded: result.wishAdded,
    skipped: false,
  };
}

// Top-level entry for the scheduler: respects the master switch, never throws.
export async function runDailyRecommendJob(): Promise<DailyRecommendResult | null> {
  if (!getSettingBool("daily_recommend_enabled", true)) return null;
  try {
    const result = await generateDailyPlaylist();
    if (!result.skipped) {
      console.log(`[DAILY-RECOMMEND] ${result.date}: picked ${result.picked.platform} "${result.picked.name || result.picked.url}" -> ${result.matched}/${result.total} matched, ${result.unmatched} stubs, ${result.wishAdded} wishes`);
    }
    return result;
  } catch (e: any) {
    console.error("[DAILY-RECOMMEND] error:", e.message || e);
    return null;
  }
}

// --- Backward-compat: purgeOldDailyPlaylists is kept as a no-op stub so the
// --- admin API (which still calls it) doesn't break. The rename mechanism
// --- above already guarantees only "今日推荐" + "昨日推荐" exist, so there's
// --- nothing to purge by date anymore.
export function purgeOldDailyPlaylists(_retentionDays: number): number {
  return 0;
}
