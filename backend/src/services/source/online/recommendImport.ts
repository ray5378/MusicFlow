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
import { db, sqlite } from "../../../db/index.js";
import { playlists, playlistSongs } from "../../../db/schema.js";
import { eq, inArray } from "drizzle-orm";
import { getConfiguredProvider } from "./index.js";
import { importOnlineSongs } from "./service.js";
import { OnlinePlaylistInfo } from "./types.js";
import { cacheRemoteCover, clearPlaylistCoverCache } from "../../playlistCover.js";
import { refreshPlaylistCounts } from "../../plugin/shared.js";
import { getPluginManifest, listRegistered } from "../../../plugins/registry.js";
import { acquireBatchLock, sleepBetweenBatch } from "../../plugin/batchPacer.js";
import { createLogger } from "../../../utils/logger.js";

const log = createLogger("recommend-sync");
export const DAILY_TAG = "每日推荐";
// The daily-recommend sourceUrl prefix is no longer hardcoded — each source
// plugin declares its own `recommendPrefix` in its manifest, so a second
// aggregator can be added without touching this file.
function recommendPrefix(providerId: string): string {
  return getPluginManifest(providerId)?.recommendPrefix ?? ""; // 无插件声明前缀时返回空(无插件则无推荐源)
}
function allRecommendPrefixes(): string[] {
  return listRegistered()
    .map((p) => p.manifest.recommendPrefix)
    .filter((p): p is string => !!p);
}
const COMMENT_PREFIX = "每日推荐歌单·";
// Keep imported playlist titles short so the inline platform tag stays visible
// in the WebUI playlist cards (names are rendered nowrap with ellipsis).
const MAX_NAME_LEN = 18;
function truncateName(name: string): string {
  const chars = [...(name || "")];
  if (chars.length <= MAX_NAME_LEN) return chars.join("");
  return chars.slice(0, MAX_NAME_LEN).join("") + "…";
}

/** Build the marker sourceUrl for a recommended playlist import (per provider). */
export function recommendSourceUrl(providerId: string, id: string): string {
  return `${recommendPrefix(providerId)}${id}`;
}

export function isDailyRecommendPlaylist(pl: any): boolean {
  return !!pl.sourceUrl && allRecommendPrefixes().some((p) => pl.sourceUrl!.startsWith(p));
}

/** Hard-delete a playlist row plus its entries and cover cache. */
export function removePlaylistRows(playlistId: string): void {
  db.delete(playlistSongs).where(eq(playlistSongs.playlistId, playlistId)).run();
  clearPlaylistCoverCache(playlistId);
  db.delete(playlists).where(eq(playlists.id, playlistId)).run();
}

/** Find the local playlist that already imported this recommended playlist.
 *  Without a providerId it matches any registered source plugin's prefix. */
export function findRecommendPlaylist(id: string, providerId?: string): any | null {
  if (providerId) {
    const rows = db.select().from(playlists).where(eq(playlists.sourceUrl, recommendSourceUrl(providerId, id))).all();
    return rows[0] || null;
  }
  const all = db.select().from(playlists).all();
  return all.find((p) => allRecommendPrefixes().some((pref) => p.sourceUrl === `${pref}${id}`)) || null;
}

/** Update a local playlist's entry set to the given online songs *incrementally*.
 *  Already-present entries (keyed by song id) are reused — only their position is
 *  corrected when it drifted — removed entries are deleted, and genuinely new
 *  ones are inserted. Avoids clearing and re-inserting the whole playlist.
 *
 *  Async: large playlists are written in TX_CHUNK-sized transactions with a
 *  sleepBetweenBatch() pause between chunks, so a few-thousand-row sync no
 *  longer blocks the event loop for one long synchronous transaction. Small
 *  diffs run as a single transaction, exactly like the old path. */
export async function replacePlaylistSongs(playlistId: string, songIds: { id: string; title: string }[]) {
  const existingRows = db.select().from(playlistSongs)
    .where(eq(playlistSongs.playlistId, playlistId)).all();
  const existMap = new Map<string, any>();
  for (const e of existingRows) {
    const key = e.externalSongId || e.songId;
    if (key) existMap.set(key, e);
  }
  const seen = new Set<string>();

  // 一次遍历分出「新增」与「position 漂移需更新」两批,避免逐行 INSERT/UPDATE。
  const inserts: any[] = [];
  const posUpdates: { id: number; position: number }[] = [];
  songIds.forEach((s, gi) => {
    seen.add(s.id);
    const prev = existMap.get(s.id);
    if (prev) {
      if (prev.position !== gi) posUpdates.push({ id: prev.id, position: gi });
    } else {
      inserts.push({
        playlistId,
        songId: s.id,
        position: gi,
        playable: 1,
        externalTitle: s.title,
        externalSongId: s.id,
      });
    }
  });

  const TX_CHUNK = 300;
  // 新增条目:多行 VALUES 一次插入(替代逐行 INSERT)。
  for (let off = 0; off < inserts.length; off += TX_CHUNK) {
    const chunk = inserts.slice(off, off + TX_CHUNK);
    db.transaction(() => {
      if (chunk.length) db.insert(playlistSongs).values(chunk).run();
    });
    if (off + TX_CHUNK < inserts.length) await sleepBetweenBatch();
  }

  // position 漂移的行:单条 CASE 批量更新(替代逐行 UPDATE)。只有 position 一列,
  // 单例 enum-arg 数少,分块上限可放宽到 TX_CHUNK(每行 2 参数,300 行≈600<999)。
  for (let off = 0; off < posUpdates.length; off += TX_CHUNK) {
    const chunk = posUpdates.slice(off, off + TX_CHUNK);
    const ids = chunk.map((u) => u.id);
    const args: any[] = [];
    const cases = chunk.map(() => "WHEN ? THEN ?").join(" ");
    for (const u of chunk) args.push(u.id, u.position);
    const idPh = ids.map(() => "?").join(",");
    db.transaction(() => {
      sqlite
        .prepare(`UPDATE playlist_songs SET position = CASE id ${cases} END WHERE id IN (${idPh})`)
        .run(...args, ...ids);
    });
    if (off + TX_CHUNK < posUpdates.length) await sleepBetweenBatch();
  }

  // Remove entries no longer present in the remote playlist (also chunked).
  const toDelete = existingRows.filter((e) => {
    const key = e.externalSongId || e.songId;
    return key && !seen.has(key);
  });
  // 批量删除:IN 一次删一批(替代逐行 DELETE)。
  for (let off = 0; off < toDelete.length; off += TX_CHUNK) {
    const chunk = toDelete.slice(off, off + TX_CHUNK);
    db.transaction(() => {
      if (chunk.length) {
        db.delete(playlistSongs).where(inArray(playlistSongs.id, chunk.map((e) => e.id))).run();
      }
    });
    if (off + TX_CHUNK < toDelete.length) await sleepBetweenBatch();
  }

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

  // 平台歌单音乐为 0(空歌单)→ 自动删除本地对应歌单,不保留空占位。
  if (imp.songs.length === 0) {
    const existing = findRecommendPlaylist(info.id, providerId);
    if (existing) {
      removePlaylistRows(existing.id);
      log.info(`[recommend-sync] 歌单「${displayName}」音乐为 0,已自动删除`);
    }
    return { success: false, created: false, name: displayName, platform: info.source, trackCount: 0, added: 0, deduped: 0, failed: imp.failed };
  }

  const existing = findRecommendPlaylist(info.id, providerId);
  if (existing) {
    await replacePlaylistSongs(existing.id, imp.songs);
    db.update(playlists).set({
      name: displayName,
      comment: COMMENT_PREFIX + info.source,
      updatedAt: new Date().toISOString(),
    }).where(eq(playlists.id, existing.id)).run();
    // Existing local playlist: still refresh the cached platform cover (the
    // song-list fetch above could have failed early on last import, leaving the
    // local playlist without a cover even though the remote one exists).
    const playlistCover = await cacheRemoteCover(info.cover, `pl-${existing.id}`, true);
    if (playlistCover) db.update(playlists).set({ coverArt: playlistCover, updatedAt: new Date().toISOString() }).where(eq(playlists.id, existing.id)).run();
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
    sourceUrl: recommendSourceUrl(providerId, info.id),
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

  await replacePlaylistSongs(id, imp.songs);
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
 * Safety-first ordering: fetch today's recommendations first, then import them
 * (upsert by remote id — existing playlists are updated in place, new ones are
 * created), and only afterwards delete yesterday's playlists that are no longer
 * in today's set. This way a flaky network that prevents fetching a channel
 * keeps that channel's old playlists untouched instead of deleting them first
 * and then failing to pull replacements. Some providers (e.g. kugou) only
 * return non-empty recommendations after a few warm-up calls, so fetching is
 * retried until every channel returns a non-empty list.
 */
export async function syncAllRecommendPlaylists(
  providerId: string,
  opts?: { userId?: string },
): Promise<SyncRecommendResult> {
  // 全局批量闸:与 Path B(插件 runDailyJob / jobRunner)、后台 auto-match、手动
  // 导入互斥(FIFO 排队)——修复前 Path A 不持锁,与 Path B 并发会叠加抢 CPU/带宽。
  // importRecommendPlaylist → importOnlineSongs 内部不二次取锁,无死锁。
  const release = await acquireBatchLock();
  try {
    return await doSyncAllRecommendPlaylists(providerId, opts);
  } finally {
    release();
  }
}

async function doSyncAllRecommendPlaylists(
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

  // 1. Fetch today's recommendations per channel (retry until non-empty).
  // 注意:{ mode: "sync" } —— 路径 A 必须拿到「真实上游列表」才能入库/清理,
  // 因此显式要求插件走上游抓取,而不是首页展示用的「本地库轮转」(recommend()
  // 仅在未传 mode 时才对非网易平台走本地轮转)。见 go-music-dl 插件 recommend()。
  let channels: { source: string; playlists: OnlinePlaylistInfo[] }[] = [];
  for (let attempt = 0; attempt < 5; attempt++) {
    const res = await configured.provider.recommend(configured.config, { mode: "sync" });
    channels = (res.channels || []).map((ch: any) => ({ source: ch.source, playlists: ch.playlists || [] }));
    const hasAll = channels.every((ch) => ch.playlists.length > 0);
    if (hasAll) break;
    if (channels.some((ch) => ch.playlists.length > 0) && !channels.some((ch) => ch.playlists.length === 0)) break;
    if (attempt < 4) await new Promise((r) => setTimeout(r, 2500));
  }

  // Channels that came back empty this run — their local playlists are NOT
  // touched (avoid deleting old ones we failed to refresh).
  const emptyChannels = new Set<string>(channels.filter((ch) => ch.playlists.length === 0).map((ch) => ch.source));

  // 2. Import every playlist of every channel (upsert: new ones created,
  //    existing ones updated in place).
  // 并发窗口:逐个歌单「拉取歌曲→导入」串行是纯网络密集(每单 1 次上游往返),
  // 走有界并发池(≤3)重叠网络等待。全程在全局批量闸内(P1 串行),不与其他
  // 批量任务叠加;导入本身仍受 importOnlineSongs 内部 batchConcurrency 节流。
  const importedKeys = new Set<{ source: string; id: string }>();
  const work: { ch: { source: string; playlists: OnlinePlaylistInfo[] }; pl: OnlinePlaylistInfo }[] = [];
  for (const ch of channels) {
    if (ch.playlists.length === 0) {
      errors.push(`${ch.source}: 该渠道无推荐歌单,保留原有歌单`);
      continue;
    }
    for (const pl of ch.playlists) work.push({ ch, pl });
  }
  const IMPORT_CONCURRENCY = 3;
  let next = 0;
  const worker = async () => {
    while (next < work.length) {
      const { ch, pl } = work[next++];
      try {
        const r = await importRecommendPlaylist(providerId, pl, opts);
        if (r.success && r.playlistId) {
          created++;
          importedKeys.add({ source: ch.source, id: String(pl.id) });
          out.push({ id: r.playlistId, name: r.name, trackCount: r.trackCount });
        } else if (r.trackCount === 0) {
          // 空歌单(音乐为 0)已在 importRecommendPlaylist 中自动删除,不算失败。
          log.info(`[recommend-sync] [${ch.source}] ${pl.name}: 空歌单,已自动删除`);
        } else {
          errors.push(`[${ch.source}] ${pl.name}: 导入失败`);
        }
      } catch (e: any) {
        errors.push(`[${ch.source}] ${pl.name}: ${e.message || "导入失败"}`);
      }
      // 批间让行:批量循环每批主动睡眠(batchPacer:档位 + ELD + 交互窗口内 ×4 退让),
      // 与 match.ts / importOnlineSongs 的节流保持同一套节奏。
      await sleepBetweenBatch();
    }
  };
  await Promise.all(Array.from({ length: Math.min(IMPORT_CONCURRENCY, work.length) }, () => worker()));

  // 3. Cleanup: delete local daily-recommend playlists that are NOT part of
  //    today's freshly-imported set, per channel. Channels that came back empty
  //    (or that failed to import everything) keep their old playlists.
  //    Additionally, only prune a channel when today's import count >= the old
  //    count — if we imported fewer than we had before (e.g. a flaky fetch
  //    returned a partial list), we keep the old playlists rather than deleting
  //    good playlists we then can't replace.
  const old = db.select().from(playlists).all().filter((p) => isDailyRecommendPlaylist(p));
  const oldByChannel = new Map<string, number>();
  for (const p of old) {
    const src = p.sourcePlatform || "";
    oldByChannel.set(src, (oldByChannel.get(src) || 0) + 1);
  }
  const importedForChannel = (source: string) => new Set(
    [...importedKeys].filter((k) => k.source === source).map((k) => k.id),
  );
  for (const pl of old) {
    // 用户收藏的歌单不参与轮换删除:内容每天仍随同步更新,但不会被清理。
    if (pl.favorite) continue;
    const src = pl.sourcePlatform || "";
    if (emptyChannels.has(src)) continue; // couldn't refresh this channel → keep old
    const current = importedForChannel(src);
    const remoteId = String(pl.externalId || pl.sourceUrl!.replace(recommendPrefix(providerId), ""));
    // Safety: only delete stale playlists when today's import is at least as
    // complete as what we previously had (partial-fetch suspects are kept).
    if (current.size > 0 && current.size >= (oldByChannel.get(src) || 0) && !current.has(remoteId)) {
      try {
        removePlaylistRows(pl.id);
        log.info(`[recommend-sync] 清理旧歌单 ${pl.name} (${src}/${remoteId})`);
      } catch (e: any) {
        errors.push(`删除旧歌单 ${pl.name}: ${e.message || "失败"}`);
      }
    }
  }

  return { synced: out.length, created, failed: errors.length, errors, playlists: out };
}