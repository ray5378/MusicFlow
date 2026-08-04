// Daily-recommend playlist generator (Plan A).
//
// Every day at the configured hour, pick ONE candidate from the configured pool
// using a date-based seed (so the same day always picks the same one, and the
// pick rotates across days), import it via the existing playlist importer, and
// persist it as a "每日推荐 YYYY-MM-DD" playlist.
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

// Mark used to recognize daily playlists so we can clean them up later without
// touching user-created ones. Stored in the playlists.comment field to avoid a
// schema migration.
export const DAILY_TAG = "[daily-recommend]";
export const DAILY_TAG_LOCAL = "[daily-recommend-local]";

function todayStr(d = new Date()): string {
  // Use local date (server TZ) — daily rotation is a local-time concept.
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

// Read & parse the candidate pool from settings. Returns [] on any error so a
// corrupted config can't crash the scheduler.
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

// Find a daily playlist for a given date by its naming convention.
function findDailyPlaylist(dateStr: string, tag: string = DAILY_TAG): any | null {
  const name = `每日推荐 ${dateStr}`;
  const rows = sqlite.prepare("SELECT * FROM playlists WHERE name = ? AND comment LIKE ?").all(name, `%${tag}%`) as any[];
  return rows[0] || null;
}

// Delete playlists whose name matches "每日推荐 YYYY-MM-DD" and whose date is
// older than `retentionDays`. We tag daily playlists in `comment` so this can
// never delete a user-created playlist that happens to share the prefix.
export function purgeOldDailyPlaylists(retentionDays: number): number {
  if (retentionDays <= 0) return 0;
  const cutoff = new Date(Date.now() - retentionDays * 86400000);
  const cutoffStr = todayStr(cutoff);
  const all = sqlite.prepare("SELECT id, name, comment FROM playlists WHERE comment LIKE ? OR comment LIKE ?")
    .all(`%${DAILY_TAG}%`, `%${DAILY_TAG_LOCAL}%`) as any[];
  let deleted = 0;
  for (const p of all) {
    const m = p.name?.match(/每日推荐\s+(\d{4}-\d{2}-\d{2})/);
    if (!m) continue;
    if (m[1] < cutoffStr) {
      sqlite.prepare("DELETE FROM playlist_songs WHERE playlist_id = ?").run(p.id);
      clearPlaylistCoverCache(p.id);
      sqlite.prepare("DELETE FROM playlists WHERE id = ?").run(p.id);
      deleted++;
    }
  }
  return deleted;
}

// Pick a system owner for auto-generated playlists. We use the first admin so
// foreign-key constraints hold; daily playlists are isPublic=1 so everyone sees them.
function pickSystemOwnerId(): string {
  const admin = sqlite.prepare("SELECT id FROM users WHERE is_admin = 1 LIMIT 1").get() as any;
  return admin?.id || "";
}

// Build today's daily playlist. Idempotent: if today's playlist already exists,
// returns immediately with skipped=true. Throws on fetch errors.
export async function generateDailyPlaylist(date = new Date()): Promise<DailyRecommendResult> {
  const dateStr = todayStr(date);
  const existing = findDailyPlaylist(dateStr, DAILY_TAG);
  if (existing) {
    return {
      date: dateStr,
      playlistId: existing.id,
      name: existing.name,
      picked: { platform: existing.source_platform || "", url: existing.source_url || "" },
      platform: existing.source_platform || "",
      total: 0, matched: 0, unmatched: 0, wishAdded: 0,
      skipped: true,
    };
  }

  const picked = pickDailyCandidate(date);
  if (!picked) throw new Error("每日推荐候选池为空,请在设置中配置 daily_recommend_candidates");

  const imported = await importPlaylistFromUrl(picked.url);
  const playlistId = `pl-${Date.now()}`;
  const name = `每日推荐 ${dateStr}`;

  // Cache the remote cover locally (best-effort; falls back to collage later).
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
    playlistId, name, ownerId,
    `${DAILY_TAG} 来自「${picked.name || picked.url}」`,
    coverRef || null,
    picked.url, imported.platform, picked.url,
    new Date().toISOString(), new Date().toISOString()
  );

  // Reuse the exact same matching/stub/wish pipeline as a manual import.
  // Matched -> playable=1 + songId; unmatched -> playable=0 stub + wish entry.
  const result = await rebuildPlaylistEntries(playlistId, imported, {
    userId: ownerId,
    autoWish: true,
    notes: `来自每日推荐「${name}」`,
  });

  return {
    date: dateStr,
    playlistId,
    name,
    picked,
    platform: imported.platform,
    total: result.total,
    matched: result.matched,
    unmatched: result.unmatched,
    wishAdded: result.wishAdded,
    skipped: false,
  };
}

// Top-level entry for the scheduler: respects the master switch, runs the
// generator, purges old daily playlists, and never throws (logs errors instead).
export async function runDailyRecommendJob(): Promise<DailyRecommendResult | null> {
  if (!getSettingBool("daily_recommend_enabled", true)) return null;
  try {
    const retention = parseInt(getSetting("daily_recommend_retention", "7"), 10) || 7;
    const result = await generateDailyPlaylist();
    if (!result.skipped) {
      console.log(`[DAILY-RECOMMEND] ${result.date}: picked ${result.picked.platform} "${result.picked.name || result.picked.url}" -> ${result.matched}/${result.total} matched, ${result.unmatched} stubs, ${result.wishAdded} wishes`);
    }
    const purged = purgeOldDailyPlaylists(retention);
    if (purged > 0) console.log(`[DAILY-RECOMMEND] purged ${purged} old daily playlists (retention ${retention}d)`);
    return result;
  } catch (e: any) {
    console.error("[DAILY-RECOMMEND] error:", e.message || e);
    return null;
  }
}
