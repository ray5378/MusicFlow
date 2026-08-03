// Playlist sync service: re-fetch remote playlist, rebuild entries with library matching
import { db } from "../../db/index.js";
import { songs, playlists, playlistSongs, wishes } from "../../db/schema.js";
import { eq, and } from "drizzle-orm";
import { v4 as uuidv4 } from "uuid";
import { importPlaylistFromUrl, ImportedPlaylist, ImportedTrack } from "./playlistImport.js";
import { cacheRemoteCover, clearPlaylistCoverCache } from "../playlistCover.js";

export interface SyncResult {
  total: number;
  matched: number;
  unmatched: number;
  wishAdded: number;
  platform?: string;
}

// Per-playlist sync lock to prevent concurrent duplicate requests
const syncLocks = new Set<string>();
// Per-user+url cooldown for duplicate imports (10s)
const importCooldowns = new Map<string, number>();

export function isSyncing(playlistId: string): boolean {
  return syncLocks.has(playlistId);
}

export function checkImportCooldown(userId: string, url: string): boolean {
  const key = `${userId}|${url}`;
  const last = importCooldowns.get(key);
  const now = Date.now();
  if (last && now - last < 10000) return true;
  importCooldowns.set(key, now);
  if (importCooldowns.size > 500) importCooldowns.clear();
  return false;
}

// Normalize title/artist for fuzzy matching (lowercase, trim, strip separators/parens)
export function normalizeKey(title: string, artist: string): string {
  const norm = (s: string) => s.toLowerCase().replace(/[（(].*?[)）]/g, "").replace(/[~～·\-—_\s]+/g, "").trim();
  return `${norm(title)}|${norm(artist)}`;
}

// Build a library index (title|artist -> songs) for matching
export function buildLibraryIndex(): Map<string, any[]> {
  const librarySongs = db.select().from(songs).all();
  const index = new Map<string, any[]>();
  for (const s of librarySongs) {
    const key = normalizeKey(s.title, s.artist || "");
    if (!index.has(key)) index.set(key, []);
    index.get(key)!.push(s);
  }
  return index;
}

// Match a single remote track against the library index
export function matchTrack(track: ImportedTrack, index: Map<string, any[]>): any | null {
  const candidates = index.get(normalizeKey(track.title, track.artist)) || [];
  return candidates.find(s => s.suffix && s.path) || candidates[0] || null;
}

export interface RebuildOptions {
  userId?: string;
  autoWish?: boolean; // add unmatched tracks to wish list
  notes?: string; // note for wish entries
}

// Rebuild a playlist's entries from a remote playlist (clear old, then insert all)
// Returns { total, matched, unmatched, wishAdded }
export async function rebuildPlaylistEntries(
  playlistId: string,
  imported: ImportedPlaylist,
  opts: RebuildOptions = {}
): Promise<SyncResult> {
  // Clear old entries, then rebuild in platform order
  db.delete(playlistSongs).where(eq(playlistSongs.playlistId, playlistId)).run();

  const index = buildLibraryIndex();
  let matched = 0, unmatched = 0, wishAdded = 0;

  imported.tracks.forEach((t, i) => {
    const match = matchTrack(t, index);
    if (match) {
      db.insert(playlistSongs).values({
        playlistId, songId: match.id, position: i, playable: 1,
        externalSongId: t.externalId, externalTitle: t.title, externalArtist: t.artist,
        externalAlbum: t.album, externalDuration: t.duration,
      }).run();
      matched++;
    } else {
      db.insert(playlistSongs).values({
        playlistId, songId: null, position: i, playable: 0,
        externalSongId: t.externalId, externalTitle: t.title, externalArtist: t.artist,
        externalAlbum: t.album, externalDuration: t.duration,
        unavailableReason: "曲库中未找到",
      }).run();
      unmatched++;
      // Auto-add to wish list (dedupe: skip if an identical pending wish already exists)
      if (opts.autoWish !== false) {
        const existingWish = db.select().from(wishes)
          .where(and(eq(wishes.songTitle, t.title), eq(wishes.artist, t.artist || "")))
          .all().find(w => w.status === "pending");
        if (!existingWish) {
          const wid = uuidv4();
          db.insert(wishes).values({
            id: wid, userId: opts.userId || "", songTitle: t.title, artist: t.artist || "",
            album: t.album || "", status: "pending",
            notes: opts.notes || "来自歌单导入",
            createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
          }).run();
          wishAdded++;
        }
      }
    }
  });

  refreshPlaylistCounts(playlistId);
  return { total: imported.tracks.length, matched, unmatched, wishAdded, platform: imported.platform };
}

// Sync a playlist: re-fetch remote data and rebuild entries.
// Returns null if the playlist is not remote-imported, or throws on error.
export async function syncPlaylist(playlistId: string, opts: RebuildOptions = {}): Promise<SyncResult> {
  const playlist = db.select().from(playlists).where(eq(playlists.id, playlistId)).get();
  if (!playlist) throw new Error("歌单不存在");
  if (!playlist.sourceUrl || !playlist.sourcePlatform) throw new Error("该歌单不是导入歌单,无法同步");

  if (syncLocks.has(playlistId)) throw new Error("该歌单正在同步中,请稍候");
  syncLocks.add(playlistId);
  try {
    const imported = await importPlaylistFromUrl(playlist.sourceUrl);
    const result = await rebuildPlaylistEntries(playlistId, imported, {
      ...opts,
      notes: `来自歌单「${playlist.name}」同步`,
    });
    // Refresh remote cover: force re-download on manual sync so platform cover updates apply
    let coverRef = playlist.coverArt;
    if (imported.coverUrl) {
      const cached = await cacheRemoteCover(imported.coverUrl, `pl-${playlistId}`, true);
      if (cached) coverRef = cached;
    }
    // Playlist entries changed -> clear the collage cache so it regenerates with new covers
    clearPlaylistCoverCache(playlistId);
    // Keep playlist name in sync with the platform if user hasn't renamed it
    db.update(playlists).set({
      updatedAt: new Date().toISOString(),
      coverArt: coverRef,
      sourcePlatform: imported.platform || playlist.sourcePlatform,
    }).where(eq(playlists.id, playlistId)).run();
    return result;
  } finally {
    syncLocks.delete(playlistId);
  }
}

// Sync all playlists with syncEnabled=1 (used by the scheduled task)
export async function syncAllEnabledPlaylists(opts: RebuildOptions = {}): Promise<{ synced: number; results: SyncResult[]; errors: string[] }> {
  const enabled = db.select().from(playlists).where(eq(playlists.syncEnabled, 1)).all();
  const results: SyncResult[] = [];
  const errors: string[] = [];
  let synced = 0;
  for (const pl of enabled) {
    if (syncLocks.has(pl.id)) continue;
    try {
      results.push(await syncPlaylist(pl.id, opts));
      synced++;
    } catch (e: any) {
      errors.push(`${pl.name}: ${e.message || "同步失败"}`);
    }
  }
  return { synced, results, errors };
}

// Recompute a playlist's songCount and duration
export function refreshPlaylistCounts(playlistId: string) {
  const entries = db.select().from(playlistSongs).where(eq(playlistSongs.playlistId, playlistId)).all();
  let duration = 0, count = 0;
  for (const e of entries) {
    if (e.playable && e.songId) {
      const song = db.select().from(songs).where(eq(songs.id, e.songId)).get();
      if (song) { duration += song.duration || 0; count++; }
    } else if (e.externalTitle) {
      duration += (e.externalDuration || 0) / 1000;
      count++;
    }
  }
  db.update(playlists).set({ songCount: count, duration, updatedAt: new Date().toISOString() }).where(eq(playlists.id, playlistId)).run();
}
