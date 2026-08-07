// ==================== Daily-recommend playlist import ====================
//
// Imports go-music-dl's 每日推荐歌单 (from /music/recommend) into MusicFlow as
// local playlists — one local playlist per recommended playlist. Imported
// playlists are tagged with sourceUrl="gmdl://recommend/<id>" and re-importing
// the same recommendation full-replaces its contents (so a fixed daily run keeps
// each local playlist as "today's recommendation").
//
// Because recommended songs are online (type="web"), each track is imported
// through importOnlineSong so it streams via the provider; the playlist entry
// links the online song directly (playable=1) instead of leaving a stub.

import { v4 as uuidv4 } from "uuid";
import { db } from "../../../db/index.js";
import { playlists, playlistSongs } from "../../../db/schema.js";
import { eq } from "drizzle-orm";
import { getConfiguredProvider } from "./index.js";
import { importOnlineSongs } from "./service.js";
import { OnlinePlaylistInfo } from "./types.js";
import { cacheRemoteCover, clearPlaylistCoverCache } from "../../playlistCover.js";
import { refreshPlaylistCounts } from "../../plugin/playlistSync.js";

export const DAILY_TAG = "每日推荐";
const RECOMMEND_URL_PREFIX = "gmdl://recommend/";
const COMMENT_PREFIX = "每日推荐歌单·";
// Keep imported playlist titles short so the inline platform tag stays visible
// in the WebUI playlist cards (names are rendered nowrap with ellipsis).
const MAX_NAME_LEN = 18;
function truncateName(name: string): string {
  const chars = [...(name || "")];
  if (chars.length <= MAX_NAME_LEN) return chars.join("");
  return chars.slice(0, MAX_NAME_LEN).join("") + "…";
}

/** Build the marker sourceUrl for a recommended playlist import. */
export function recommendSourceUrl(id: string): string {
  return `${RECOMMEND_URL_PREFIX}${id}`;
}

export function isDailyRecommendPlaylist(pl: any): boolean {
  return !!pl.sourceUrl && pl.sourceUrl.startsWith(RECOMMEND_URL_PREFIX);
}

/** Hard-delete a playlist row plus its entries and cover cache. */
export function removePlaylistRows(playlistId: string): void {
  db.delete(playlistSongs).where(eq(playlistSongs.playlistId, playlistId)).run();
  clearPlaylistCoverCache(playlistId);
  db.delete(playlists).where(eq(playlists.id, playlistId)).run();
}

/** Find the local playlist that already imported this recommended playlist. */
export function findRecommendPlaylist(id: string): any | null {
  const rows = db.select().from(playlists).where(eq(playlists.sourceUrl, recommendSourceUrl(id))).all();
  return rows[0] || null;
}

/** Update a local playlist's entry set to the given online songs (full replace). */
export function replacePlaylistSongs(playlistId: string, songIds: { id: string; title: string }[]) {
  db.delete(playlistSongs).where(eq(playlistSongs.playlistId, playlistId)).run();
  songIds.forEach((s, i) => {
    db.insert(playlistSongs).values({
      playlistId,
      songId: s.id,
      position: i,
      playable: 1,
      externalTitle: s.title,
      externalSongId: s.id,
    }).run();
  });
  refreshPlaylistCounts(playlistId);
  clearPlaylistCoverCache(playlistId);
}

export interface ImportRecommendResult {
  success: boolean;
  playlistId?: string;
  created: boolean;
  name: string;
  platform: string;
  trackCount: number;
  added: number;
  deduped: number;
  failed: number;
}

/**
 * Import (or fully replace) one recommended playlist as a local playlist.
 * If a local playlist already imported this same remote playlist, its songs are
 * replaced (full-replace "today's recommendation").
 */
export async function importRecommendPlaylist(
  providerId: string,
  info: OnlinePlaylistInfo,
  opts?: { userId?: string },
): Promise<ImportRecommendResult> {
  const configured = getConfiguredProvider(providerId);
  if (!configured?.provider.playlistSongs) {
    return { success: false, created: false, name: info.name, platform: info.source, trackCount: 0, added: 0, deduped: 0, failed: 0 };
  }

  const { songs: list } = await configured.provider.playlistSongs(configured.config, info.source, info.id);
  const imp = await importOnlineSongs(providerId, list, { userId: opts?.userId });
  const displayName = truncateName(info.name);

  const existing = findRecommendPlaylist(info.id);
  if (existing) {
    replacePlaylistSongs(existing.id, imp.songs);
    db.update(playlists).set({
      name: displayName,
      comment: COMMENT_PREFIX + info.source,
      updatedAt: new Date().toISOString(),
    }).where(eq(playlists.id, existing.id)).run();
    return {
      success: true, playlistId: existing.id, created: false, name: displayName,
      platform: info.source, trackCount: imp.songs.length, added: imp.added, deduped: imp.deduped, failed: imp.failed,
    };
  }

  const id = `pl-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  const now = new Date().toISOString();
  db.insert(playlists).values({
    id,
    name: displayName || "每日推荐",
    ownerId: opts?.userId || "",
    isPublic: 0,
    comment: COMMENT_PREFIX + info.source,
    coverArt: null,
    songCount: 0,
    duration: 0,
    syncEnabled: 0,
    sourceUrl: recommendSourceUrl(info.id),
    sourcePlatform: info.source,
    externalId: info.id,
    createdAt: now,
    updatedAt: now,
  }).run();

  // Cache the platform cover into the playlist collage slot.
  if (info.cover) {
    const cached = await cacheRemoteCover(info.cover, `pl-${id}`);
    if (cached) db.update(playlists).set({ coverArt: cached }).where(eq(playlists.id, id)).run();
  }

  replacePlaylistSongs(id, imp.songs);
  return {
    success: true, playlistId: id, created: true, name: displayName,
    platform: info.source, trackCount: imp.songs.length, added: imp.added, deduped: imp.deduped, failed: imp.failed,
  };
}

export interface SyncRecommendResult {
  synced: number;
  created: number;
  failed: number;
  errors: string[];
  playlists: { id: string; name: string; trackCount: number }[];
}

/**
 * Daily full-sync of go-music-dl 每日推荐歌单.
 *
 * Every scheduled run: deletes yesterday's imported channel playlists, then
 * re-imports ALL of today's recommended playlists from every channel
 * (netease/qq/kugou/kuwo). This keeps the local daily-recommend set identical
 * to go-music-dl's current recommendations — old ones from the previous run are
 * always removed, today's full set is always imported. Some providers (e.g.
 * kugou) only return non-empty recommendations after a few warm-up calls, so we
 * retry fetching per channel until a non-empty list arrives.
 */
export async function syncAllRecommendPlaylists(
  providerId: string,
  opts?: { userId?: string },
): Promise<SyncRecommendResult> {
  const out: { id: string; name: string; trackCount: number }[] = [];
  const errors: string[] = [];
  let created = 0;

  const configured = getConfiguredProvider(providerId);
  if (!configured?.provider.recommend || !configured?.provider.playlistSongs) {
    return { synced: 0, created: 0, failed: 1, errors: ["在线源未启用或缺少 recommend/playlistSongs"], playlists: [] };
  }

  // 1. Drop yesterday's imported channel playlists (full rebuild each run).
  const old = db.select().from(playlists).all().filter((p) => isDailyRecommendPlaylist(p));
  for (const pl of old) {
    try {
      removePlaylistRows(pl.id);
    } catch (e: any) {
      errors.push(`删除旧歌单 ${pl.name}: ${e.message || "失败"}`);
    }
  }

  // 2. Fetch today's recommendations per channel (retry until non-empty).
  let channels: { source: string; playlists: OnlinePlaylistInfo[] }[] = [];
  for (let attempt = 0; attempt < 5; attempt++) {
    const res = await configured.provider.recommend(configured.config);
    channels = (res.channels || []).map((ch: any) => ({ source: ch.source, playlists: ch.playlists || [] }));
    const hasAll = channels.every((ch) => ch.playlists.length > 0);
    if (hasAll) break;
    if (channels.some((ch) => ch.playlists.length > 0) && !channels.some((ch) => ch.playlists.length === 0)) break;
    if (attempt < 4) await new Promise((r) => setTimeout(r, 2500));
  }

  // 3. Import every playlist of every channel.
  for (const ch of channels) {
    if (ch.playlists.length === 0) {
      errors.push(`${ch.source}: 该渠道无推荐歌单`);
      continue;
    }
    for (const pl of ch.playlists) {
      try {
        const r = await importRecommendPlaylist(providerId, pl, opts);
        if (r.success && r.playlistId) {
          created++;
          out.push({ id: r.playlistId, name: r.name, trackCount: r.trackCount });
        } else {
          errors.push(`[${ch.source}] ${pl.name}: 导入失败`);
        }
      } catch (e: any) {
        errors.push(`[${ch.source}] ${pl.name}: ${e.message || "导入失败"}`);
      }
    }
  }

  return { synced: out.length, created, failed: errors.length, errors, playlists: out };
}