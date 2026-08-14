// Playlist sync service: re-fetch remote playlist, rebuild entries with library matching
import { db, sqlite } from "../../db/index.js";
import { songs, playlists, playlistSongs, wishes } from "../../db/schema.js";
import { eq, and } from "drizzle-orm";
import { v4 as uuidv4 } from "uuid";
import { importPlaylistFromUrl, findUrlImporter, ImportedPlaylist, ImportedTrack } from "./playlistImport.js";
import { cacheRemoteCover, clearPlaylistCoverCache } from "../playlistCover.js";
import { firstEnabledByCapability, getPluginConfig } from "../../plugins/registry.js";
import type { PluginManifest, SyncPlugin } from "../../plugins/types.js";

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
  // Clear old entries, then rebuild in platform order. 清空+插入+计数包在事务里:
  // 中途失败整体回滚,避免「条目被清空但 song_count 留旧值」导致首页卡片有数量、
  // 点开却是空歌单。
  const index = buildLibraryIndex();
  const { matched, unmatched, wishAdded } = db.transaction(() => {
    db.delete(playlistSongs).where(eq(playlistSongs.playlistId, playlistId)).run();
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
    return { matched, unmatched, wishAdded };
  });

  // Any entries that couldn't be matched to the local library are auto-matched
  // against whichever enabled source plugin can do it, in the background, so
  // these playlists become playable even without the track being in the local
  // library. Fire-and-forget: the match runs off this request's hot path.
  if (unmatched > 0) {
    matchPlaylistInBackground(playlistId).catch((e) => {
      console.error(`[auto-match] playlist ${playlistId} 自动匹配失败:`, e?.message || e);
    });
  }

  return { total: imported.tracks.length, matched, unmatched, wishAdded, platform: imported.platform };
}

// Per-playlist auto-match guard: only one background match at a time per playlist.
const autoMatchLocks = new Set<string>();

/** 后台自动匹配一张歌单的未匹配条目(playable=0 且 external_title 非空)。
 *
 *  共享宿主服务:导入歌单(rebuildPlaylistEntries 后)与外置插件歌单
 *  (discovery.upsertPluginPlaylist 写入后)都经此触发,避免两份近似逻辑漂移。
 *  能力驱动:autoMatch 能力优先,否则任意 search 能力插件兜底;每歌单内存锁防并发;
 *  失败不抛(调用方 fire-and-forget)。 */
export async function matchPlaylistInBackground(playlistId: string): Promise<void> {
  if (autoMatchLocks.has(playlistId)) return;
  autoMatchLocks.add(playlistId);
  const started = Date.now();
  try {
    const matcher = firstEnabledByCapability("autoMatch") ?? firstEnabledByCapability("search");
    if (!matcher) return; // no capable plugin enabled -> nothing to do
    const config = getPluginConfig(matcher.manifest.id);
    if (!config) return; // plugin disabled between lookup and read
    if (typeof matcher.impl?.search !== "function") return; // can't actually match

    const { matchUnmatchedPlaylistEntries } = await import("../source/online/match.js");
    const result = await matchUnmatchedPlaylistEntries(
      matcher.manifest.id,
      config,
      matcher.impl,
      playlistId,
    );
    if (result.total > 0) {
      console.log(
        `[auto-match] ${playlistId}: ${result.matched} matched, ${result.noMatch} no-match, ${result.error} errors in ${((Date.now() - started) / 1000).toFixed(1)}s`,
      );
    }
  } finally {
    autoMatchLocks.delete(playlistId);
  }
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
    // Playlists whose sourceUrl no importer plugin claims are owned by someone
    // else — e.g. a source plugin's own recommend playlists (its manifest
    // `recommendPrefix` ref), refreshed by syncAllRecommendPlaylists instead.
    // Capability-driven skip: no hardcoded URL scheme.
    if (!pl.sourceUrl || !findUrlImporter(pl.sourceUrl)) continue;
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
  // Single aggregate query (LEFT JOIN song durations) instead of one SELECT per
  // entry. Mirrors the old per-entry logic:
  //   - playable+linked entry counts when its song exists → contributes s.duration
  //   - loose external entry counts when it has an external title → ext duration / 1000
  const row = sqlite.prepare(`
    SELECT
      SUM(CASE
        WHEN e.playable = 1 AND e.song_id IS NOT NULL THEN CASE WHEN s.id IS NOT NULL THEN 1 ELSE 0 END
        WHEN e.external_title IS NOT NULL AND e.external_title != '' THEN 1
        ELSE 0 END) AS cnt,
      COALESCE(SUM(
        CASE WHEN e.playable = 1 AND e.song_id IS NOT NULL THEN CASE WHEN s.id IS NOT NULL THEN s.duration ELSE 0 END
             WHEN e.external_title IS NOT NULL AND e.external_title != '' THEN e.external_duration / 1000.0
             ELSE 0 END
      ), 0) AS duration
    FROM playlist_songs e
    LEFT JOIN songs s ON s.id = e.song_id
    WHERE e.playlist_id = ?
  `).get(playlistId) as any;
  const count = Number(row?.cnt || 0);
  const duration = Math.round(Number(row?.duration || 0));
  db.update(playlists).set({ songCount: count, duration, updatedAt: new Date().toISOString() }).where(eq(playlists.id, playlistId)).run();
}

// Export a playlist's ordered tracks as MusicFlow-native ImportedTrack[], so
// the resulting JSON can be imported back (into this or another instance) via
// parseNativePlaylist + rebuildPlaylistEntries. Prefers external track metadata
// (kept from a platform import) for the richest re-match, else falls back to the
// matched local song's fields.
export function exportPlaylistEntries(playlistId: string): { name: string; tracks: ImportedTrack[] } {
  const playlist = db.select().from(playlists).where(eq(playlists.id, playlistId)).get();
  if (!playlist) throw new Error("歌单不存在");
  const entries = db.select().from(playlistSongs).where(eq(playlistSongs.playlistId, playlistId)).all()
    .sort((a, b) => (a.position ?? 0) - (b.position ?? 0));
  const tracks: ImportedTrack[] = [];
  for (const e of entries) {
    let title = e.externalTitle || "";
    let artist = e.externalArtist || "";
    let album = e.externalAlbum || undefined;
    let duration = e.externalDuration || undefined;
    let extId = e.externalSongId || "";
    if (!title && e.songId) {
      const s = db.select().from(songs).where(eq(songs.id, e.songId)).get();
      if (s) {
        title = s.title || "";
        artist = s.artist || "";
        album = s.album || undefined;
        duration = (s.duration || 0) * 1000;
        extId = s.id;
      }
    }
    if (title) tracks.push({ externalId: extId, title, artist, album, duration });
  }
  return { name: playlist.name, tracks };
}

// ==================== Plugin (sync) ====================
//
// Registered as a `sync` plugin so the maintenance loop schedules it by
// capability instead of importing syncAllEnabledPlaylists directly. Disabling
// this plugin in the admin UI turns automatic playlist re-sync off; manual
// per-playlist sync (POST /v1/playlists/:id/sync) keeps working.

export const PLAYLIST_SYNC_PLUGIN_ID = "playlist-sync";

export const playlistSyncManifest: PluginManifest = {
  id: PLAYLIST_SYNC_PLUGIN_ID,
  name: "歌单自动同步",
  version: "1.0.0",
  type: "sync",
  description: "定期重新拉取已开启同步的导入歌单,按曲库重建条目并自动匹配在线源",
  capabilities: ["playlistSync"],
  defaultEnabled: true,
  configSchema: [],
  documentation: `### 功能介绍
定期重新拉取「已开启同步」的导入歌单（QQ / 网易等），按当前曲库重建条目，并自动匹配可播放的在线源。

### 处理逻辑
1. 维护定时器按 \`playlistSync\` 能力调用 \`runSyncJob()\`（周期见系统设置）；
2. 遍历所有带 \`sourceUrl\` 且开启同步的歌单，用 \`findUrlImporter(url)\` 反查该链接归属哪个 importer 插件；
3. 交给对应 importer 拉取最新曲目，重建本地条目（保留已收藏 / 已匹配的歌曲，尽量不丢）；
4. 源站失效或没有 importer 认领的歌单跳过，不中断整轮同步。

### 说明
- 只同步「导入」的歌单；手动新建 / 本地歌单不受影响；
- 自动匹配优先用具备 \`autoMatch\` 能力的插件，退而求其次用 \`search\` 能力做匹配。`,
};

export const playlistSyncPlugin: SyncPlugin = {
  manifest: playlistSyncManifest,
  async runSyncJob(): Promise<string | null> {
    const r = await syncAllEnabledPlaylists();
    if (r.synced === 0 && r.errors.length === 0) return null;
    return `synced ${r.synced} playlists, errors: ${r.errors.length}`;
  },
  // 参数化同步能力:路由经 registry 门面调用,核心不直连本文件。
  async syncPlaylist(playlistId: string, opts?: RebuildOptions): Promise<SyncResult> {
    return syncPlaylist(playlistId, opts);
  },
  async rebuildPlaylistEntries(playlistId: string, imported: any, opts?: RebuildOptions): Promise<any> {
    return rebuildPlaylistEntries(playlistId, imported, opts);
  },
  refreshPlaylistCounts(playlistId: string): void {
    refreshPlaylistCounts(playlistId);
  },
  exportPlaylistEntries(playlistId: string): { name: string; tracks: ImportedTrack[] } {
    return exportPlaylistEntries(playlistId);
  },
  checkImportCooldown(userId: string, url: string): boolean {
    return checkImportCooldown(userId, url);
  },
};
