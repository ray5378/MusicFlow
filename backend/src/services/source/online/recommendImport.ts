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

/** Build the marker sourceUrl for a recommended playlist import. */
export function recommendSourceUrl(id: string): string {
  return `${RECOMMEND_URL_PREFIX}${id}`;
}

export function isDailyRecommendPlaylist(pl: any): boolean {
  return !!pl.sourceUrl && pl.sourceUrl.startsWith(RECOMMEND_URL_PREFIX);
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

  const existing = findRecommendPlaylist(info.id);
  if (existing) {
    replacePlaylistSongs(existing.id, imp.songs);
    db.update(playlists).set({
      name: info.name,
      comment: COMMENT_PREFIX + info.source,
      updatedAt: new Date().toISOString(),
    }).where(eq(playlists.id, existing.id)).run();
    return {
      success: true, playlistId: existing.id, created: false, name: info.name,
      platform: info.source, trackCount: imp.songs.length, added: imp.added, deduped: imp.deduped, failed: imp.failed,
    };
  }

  const id = `pl-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  const now = new Date().toISOString();
  db.insert(playlists).values({
    id,
    name: info.name || "每日推荐",
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
    success: true, playlistId: id, created: true, name: info.name,
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
 * Re-import every locally-imported daily-recommend playlist (full-replace each).
 *
 * Handles missing-channel seeding: after refreshing whatever is already imported,
 * we also fetch the provider's per-channel recommendations and auto-create a local
 * playlist for any channel that has no imported playlist yet. This makes the whole
 * flow hands-free — a daily automatic run keeps each channel's 每日推荐 in sync
 * without a manual first import.
 */
export async function syncAllRecommendPlaylists(
  providerId: string,
  opts?: { userId?: string },
): Promise<SyncRecommendResult> {
  const out: { id: string; name: string; trackCount: number }[] = [];
  const errors: string[] = [];
  let created = 0;
  const visitedRemoteIds = new Set<string>();

  const all = db.select().from(playlists).all().filter((p) => isDailyRecommendPlaylist(p));
  for (const pl of all) {
    try {
      const result = await importRecommendPlaylist(providerId, {
        id: pl.externalId || pl.sourceUrl!.replace(RECOMMEND_URL_PREFIX, ""),
        source: pl.sourcePlatform || "",
        name: pl.name,
        creator: "",
        cover: "",
        trackCount: "",
        link: "",
      }, opts);
      if (result.success) {
        out.push({ id: pl.id, name: pl.name, trackCount: result.trackCount });
        if (pl.externalId) visitedRemoteIds.add(String(pl.externalId));
      }
      else errors.push(`${pl.name}: 导入失败`);
    } catch (e: any) {
      errors.push(`${pl.name}: ${e.message || "同步失败"}`);
    }
  }

  // Seed channels that have no imported playlist yet (auto-create on first sync).
  const configured = getConfiguredProvider(providerId);
  if (configured?.provider.recommend) {
    try {
      const res = await configured.provider.recommend(configured.config);
      for (const ch of res.channels) {
        const chHasImport = all.some((p) => p.sourcePlatform === ch.source);
        const candidate = ch.playlists.find((p: any) => !visitedRemoteIds.has(String(p.id)));
        if (!chHasImport && candidate) {
          try {
            const r = await importRecommendPlaylist(providerId, candidate, opts);
            if (r.success && r.playlistId) {
              created++;
              out.push({ id: r.playlistId, name: r.name, trackCount: r.trackCount });
              visitedRemoteIds.add(String(candidate.id));
            } else {
              errors.push(`${ch.source}: 自动创建失败`);
            }
          } catch (e: any) {
            errors.push(`${ch.source}: ${e.message || "自动创建失败"}`);
          }
        }
      }
    } catch (e: any) {
      errors.push(`获取渠道推荐失败: ${e.message || e}`);
    }
  }
  return { synced: out.length, created, failed: errors.length, errors, playlists: out };
}