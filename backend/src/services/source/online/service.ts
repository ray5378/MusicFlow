// ==================== Online song service (import from source providers) ====================
//
// Turns a source-provider search result into a DB `songs` row of type="web":
//   - the stream is served by /rest/stream proxying song.url (built by the
//     provider's streamUrl(), i.e. go-music-dl /music/download?stream=1)
//   - covers are cached locally like imported playlists
//   - artist/album rows are created/updated to match the rest of the library
//
// Write path is split into PLAN + FLUSH so a whole batch of DB writes (new
// artist/album rows, song rows, count refreshes) commits as chunked
// transactions with multi-row VALUES inserts instead of one autocommit per
// song — cuts SQLite statement-compile and commit overhead on large
// go-music-dl 歌单/私人歌单导入 significantly. Behavior is unchanged.

import { v4 as uuidv4 } from "uuid";
import { db, sqlite } from "../../../db/index.js";
import { songs, artists, albums } from "../../../db/schema.js";
import { eq, inArray } from "drizzle-orm";
import { cacheRemoteCover, copyOnlineCoverToRef } from "../../playlistCover.js";
import { getOnlineProvider, getSourcePluginConfig, OnlineSongResult } from "./index.js";
import { batchConcurrency, interactiveConcurrency, sleepBetweenBatch } from "../../plugin/batchPacer.js";
import { runCoverBackfill, withCoverLimit } from "../../covers.js";
import { createLogger } from "../../../utils/logger.js";

const log = createLogger("online-import");

// 封面下载全局限流(≤2 并发)与封面后台回填见 covers.ts。
// 批量写放分块事务,chunk 间也让行,兼容交互路径在主进程跑的场景。

// ---------------------------------------------------------------------------
// Batch-scoped artist/album planning.
// Instead of a SELECT + INSERT per song (N round-trips over songs/albums/
// artists), a bulk caller preloads the referenced artist/album names into
// name->id maps so repeated songs become pure cache hits. `planArtist`/
// `planAlbum` NEVER write: an existing name is looked up (cache, then DB on a
// miss when the preload was skipped), and a genuinely-new name gets a fresh id
// and a place-holder pushed into the `pending` collector — the actual INSERT
// happens once, in the transaction flush. Maps/collectors are scoped to a
// single import call (bounded by list size) and thrown away after, so no
// persistent cache leaks out of the batches.
// ---------------------------------------------------------------------------
function planArtist(name: string, artistIds: Map<string, string>, pending: { id: string; name: string }[]): string {
  if (!name) return "";
  if (artistIds.has(name)) return artistIds.get(name)!;
  const existing = db.select().from(artists).where(eq(artists.name, name)).get();
  if (existing) {
    artistIds.set(name, existing.id);
    return existing.id;
  }
  const id = uuidv4();
  artistIds.set(name, id);
  pending.push({ id, name });
  return id;
}

function planAlbum(
  name: string | undefined,
  artistId: string,
  artist: string,
  albumIds: Map<string, string>,
  pending: { id: string; name: string; artistId: string | null; artist: string }[],
): string | null {
  if (!name) return null;
  if (albumIds.has(name)) return albumIds.get(name)!;
  const existing = db.select().from(albums).where(eq(albums.name, name)).get();
  if (existing) {
    albumIds.set(name, existing.id);
    return existing.id;
  }
  const id = uuidv4();
  albumIds.set(name, id);
  pending.push({ id, name, artistId: artistId || null, artist });
  return id;
}

// ---------------------------------------------------------------------------
// PLAN stage — figures out everything needed for one song without writing.
// Returns a dedup marker, or the fully-resolved insert params for a brand-new
// song. Async only for the cover download (network); DB is not written here.
// ---------------------------------------------------------------------------
interface PlannedSong {
  id: string;
  params: Record<string, any>;
  albumId?: string | null;
  artistId?: string;
}

interface PlanResult {
  success: boolean;
  deduped?: boolean;
  songId?: string;
  cover?: string;
  error?: string;
  planned?: PlannedSong;
}

async function planSongInsert(
  providerId: string,
  song: OnlineSongResult,
  existingFingerprints: Map<string, string>,
  artistsPending: { id: string; name: string }[],
  albumsPending: { id: string; name: string; artistId: string | null; artist: string }[],
  artistIds: Map<string, string>,
  albumIds: Map<string, string>,
  coverUrls: Map<string, string>,
): Promise<PlanResult> {
  const configured = getSourcePluginConfig(providerId);
  const provider = getOnlineProvider(providerId);
  if (!configured || !provider) return { success: false, error: "在线源未启用或未配置" };

  const fingerprint = `${providerId}:${song.source}:${song.id}`;
  let existing = existingFingerprints.get(fingerprint);
  if (!existing) {
    // Single-song call sites (e.g. match.ts) may not preload; look the
    // fingerprint up in the DB so repeated matches return the SAME song row.
    const row = db.select().from(songs).where(eq(songs.fingerprint, fingerprint)).get();
    if (row) existing = row.id;
  }
  if (existing) {
    existingFingerprints.set(fingerprint, existing);
    return { success: true, songId: existing, deduped: true };
  }

  const now = new Date().toISOString();
  const songId = uuidv4();
  // Reserve the fingerprint BEFORE any await so concurrent duplicates in the
  // same list collapse onto this id (no double-insert), even while covers load.
  existingFingerprints.set(fingerprint, songId);

  const artistId = planArtist(song.artist, artistIds, artistsPending);
  const albumId = planAlbum(song.album, artistId, song.artist, albumIds, albumsPending);

  // Cache the remote cover locally (like imported playlists). A whole playlist
  // often shares one cover URL — memoize the first downloaded ref per URL in
  // this call and reuse its bytes (local file copy) for later songs, so the
  // same image isn't re-fetched over the network once per song. Map is scoped
  // to a single import call (bounded by distinct covers) and discarded after.
  let coverArt: string | null | undefined;
  if (song.cover) {
    const memoRef = coverUrls.get(song.cover);
    if (memoRef) coverArt = copyOnlineCoverToRef(memoRef, songId);
    if (!coverArt) {
      const cached = await withCoverLimit(() => cacheRemoteCover(song.cover, songId));
      if (cached) {
        coverArt = cached;
        coverUrls.set(song.cover, cached);
      }
      // 封面下载走全局限流(≤2 并发),避免批量匹配时网络洪峰挤占前台请求。
    }
  }

  const streamHeaders: Record<string, string> = {};
  if (song.source === "bilibili") streamHeaders["Referer"] = "https://www.bilibili.com/";

  return {
    success: true,
    songId,
    cover: coverArt || undefined,
    planned: {
      id: songId,
      albumId,
      artistId,
      params: {
        id: songId,
        title: song.name || "Unknown",
        artist: song.artist || "",
        artistId: artistId || null,
        album: song.album || "",
        albumId,
        duration: song.duration || 0,
        contentType: "audio/mpeg",
        suffix: "mp3",
        path: `web:${providerId}:${song.source || providerId}`,
        coverArt: coverArt || null,
        playCount: 0,
        discNumber: 1,
        track: 0,
        genre: "",
        size: 0,
        fingerprint,
        type: "web",
        url: provider.streamUrl(configured, song),
        streamHeaders: JSON.stringify(streamHeaders),
        sourceData: JSON.stringify({
          provider: providerId,
          source: song.source,
          remoteId: song.id,
          extra: song.extra || null,
          cover: song.cover || "",
        }),
        pluginEntry: providerId,
        createdAt: now,
        updatedAt: now,
      },
    },
  };
}

// Run async workers over a list, bounding the number in flight at once. The
// loop is pull-based (shared index counter) so workers stay busy without
// launching all promises upfront.
async function workerLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<(R | null)[]> {
  const results = new Array(items.length).fill(null) as (R | null)[];
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i]);
    }
  });
  await Promise.all(workers);
  return results;
}

// ---------------------------------------------------------------------------
// FLUSH stage — commit all planned DB writes as chunked transactions with
// multi-row VALUES inserts (artists/albums first, then songs, then the
// aggregate count refreshes), sleeping between chunks so an interactive
// main-process import never blocks the event loop for the whole batch.
// ---------------------------------------------------------------------------
const TX_CHUNK = 500;
const nowIso = () => new Date().toISOString();

function flushArtistsAlbums(pendingArtists: { id: string; name: string }[], pendingAlbums: { id: string; name: string; artistId: string | null; artist: string }[]) {
  const t = nowIso();
  for (let off = 0; off < pendingArtists.length; off += TX_CHUNK) {
    const chunk = pendingArtists.slice(off, off + TX_CHUNK);
    db.transaction(() => {
      if (chunk.length) {
        db.insert(artists).values(chunk.map((c) => ({ id: c.id, name: c.name, albumCount: 0, createdAt: t, updatedAt: t }))).run();
      }
    });
  }
  for (let off = 0; off < pendingAlbums.length; off += TX_CHUNK) {
    const chunk = pendingAlbums.slice(off, off + TX_CHUNK);
    db.transaction(() => {
      if (chunk.length) {
        db.insert(albums).values(chunk.map((c) => ({ id: c.id, name: c.name, artistId: c.artistId, artist: c.artist, year: 0, songCount: 0, duration: 0, createdAt: t, updatedAt: t }))).run();
      }
    });
  }
}

export async function importOnlineSong(
  providerId: string,
  song: OnlineSongResult,
  opts?: { playlistId?: string; userId?: string },
): Promise<{ success: boolean; songId?: string; deduped?: boolean; error?: string; cover?: string }> {
  const existingFingerprints = new Map<string, string>();
  const artistIds = new Map<string, string>();
  const albumIds = new Map<string, string>();
  const artistsPending: { id: string; name: string }[] = [];
  const albumsPending: { id: string; name: string; artistId: string | null; artist: string }[] = [];

  const plan = await planSongInsert(providerId, song, existingFingerprints, artistsPending, albumsPending, artistIds, albumIds, new Map<string, string>());
  if (!plan.success) return { success: false, error: plan.error };
  if (plan.deduped) return { success: true, songId: plan.songId, deduped: true };

  const insertedAlbums = new Set<string>();
  const insertedArtists = new Set<string>();
  if (plan.planned?.albumId) insertedAlbums.add(plan.planned.albumId);
  if (plan.planned?.artistId) insertedArtists.add(plan.planned.artistId);

  flushArtistsAlbums(artistsPending, albumsPending);
  if (plan.planned) await flushSongs([plan.planned]);
  await refreshCounts(insertedAlbums, insertedArtists);

  return { success: true, songId: plan.songId, deduped: false, cover: plan.cover };
}

export async function importOnlineSongs(
  providerId: string,
  songList: OnlineSongResult[],
  opts?: { playlistId?: string; userId?: string; interactive?: boolean },
): Promise<{ added: number; deduped: number; failed: number; songs: { id: string; title: string; fingerprint: string }[] }> {
  // One batched dedup query instead of one SELECT per song.
  const existingFingerprints = new Map<string, string>();
  try {
    const fingerprints = songList.map(s => `${providerId}:${s.source}:${s.id}`);
    for (const row of db.select().from(songs).where(inArray(songs.fingerprint, fingerprints)).all()) {
      if (row.fingerprint) existingFingerprints.set(row.fingerprint, row.id);
    }
  } catch (e) {
    // 超限/引擎不支持 inArray 时优雅降级:去重退回逐 plan 兜底,仍正确。
    log.error("fingerprint 预载失败,退回逐条去重", { providerId, stage: "dedup-preload", err: (e as Error)?.message || e });
  }

  // Preload the artist/album names actually referenced by this list into
  // name->id maps (one batched scan instead of a SELECT/INSERT per song).
  // Falls back gracefully: planArtist/planAlbum re-check the DB on a miss, so
  // even if this preload is skipped correctness (and dedup) is preserved.
  const artistIds = new Map<string, string>();
  const albumIds = new Map<string, string>();
  try {
    const wantArtists = [...new Set(songList.map((s) => (s.artist || "").trim()).filter(Boolean))];
    if (wantArtists.length) {
      for (const r of db.select({ id: artists.id, name: artists.name }).from(artists).where(inArray(artists.name, wantArtists)).all()) {
        if (r.name) artistIds.set(r.name, r.id);
      }
    }
    const wantAlbums = [...new Set(songList.map((s) => (s.album || "").trim()).filter(Boolean))];
    if (wantAlbums.length) {
      for (const r of db.select({ id: albums.id, name: albums.name }).from(albums).where(inArray(albums.name, wantAlbums)).all()) {
        if (r.name) albumIds.set(r.name, r.id);
      }
    }
  } catch (e) {
    // 超限/引擎不支持 inArray 时优雅降级:planArtist/Album 逐 miss 回查 DB,仍正确。
    log.error("歌手/专辑预载失败,退回逐条解析", { providerId, stage: "entity-preload", err: (e as Error)?.message || e });
  }

  const artistsPending: { id: string; name: string }[] = [];
  const albumsPending: { id: string; name: string; artistId: string | null; artist: string }[] = [];
  const pendingSongs: PlannedSong[] = [];
  const insertedAlbums = new Set<string>();
  const insertedArtists = new Set<string>();
  // 批内封面去重:URL→已下载 ref,同一封面只网络拉取一次,其余本地复制字节。
  const coverUrls = new Map<string, string>();

  let added = 0, deduped = 0, failed = 0;
  const songsOut: { id: string; title: string; fingerprint: string }[] = [];

  // 交互操作(用户前端导入)用档位基础并发全速跑,不受 interactive 退让影响;
  // 后台批量(每日推荐同步/自动匹配)用 batchConcurrency()——交互窗口内自动压到 1。
  const conc = opts?.interactive ? interactiveConcurrency() : batchConcurrency();
  const results = await workerLimit(songList, conc, async (s) => {
    try {
      const plan = await planSongInsert(providerId, s, existingFingerprints, artistsPending, albumsPending, artistIds, albumIds, coverUrls);
      if (plan.success && plan.songId) {
        if (plan.deduped) deduped++; else added++;
        if (plan.planned) {
          pendingSongs.push(plan.planned);
          if (plan.planned.albumId) insertedAlbums.add(plan.planned.albumId);
          if (plan.planned.artistId) insertedArtists.add(plan.planned.artistId);
        }
        return { id: plan.songId, title: s.name, fingerprint: `${providerId}:${s.source}:${s.id}` };
      }
      failed++;
      return null;
    } catch (e) {
      failed++;
      log.error("在线歌曲导入失败", { providerId, songId: s.id, source: s.source, name: s.name, err: (e as Error)?.message || e });
      return null;
    }
  });

  for (const r of results) if (r) songsOut.push(r);

  // 拿完歌曲后:若有导入的歌曲缺封面,后台限量补全(≤2 并发,不阻塞本流程)。
  // P0 直通导入(onlineSongFromExternalId)构造的歌曲恒无封面,靠这里自动补齐。
  if (songsOut.length > 0) {
    void runCoverBackfill(songsOut.map((r) => r.id)).catch((e: unknown) =>
      log.error("封面后台回填失败", { providerId, count: songsOut.length, err: (e as Error)?.message || e }),
    );
  }

  // PLAN→FLUSH:所有写入走分块事务 + 多行批量插入(先歌手/专辑再歌曲),计数用聚合 SQL。
  flushArtistsAlbums(artistsPending, albumsPending);
  await flushSongs(pendingSongs);
  await refreshCounts(insertedAlbums, insertedArtists);

  return { added, deduped, failed, songs: songsOut };
}

// Chunked flush with a chance to yield between chunks (async wrapper).
async function flushSongs(pendingSongs: PlannedSong[]): Promise<void> {
  for (let off = 0; off < pendingSongs.length; off += TX_CHUNK) {
    const chunk = pendingSongs.slice(off, off + TX_CHUNK);
    db.transaction(() => {
      if (chunk.length) db.insert(songs).values(chunk.map((c) => c.params) as any).run();
    });
    if (off + TX_CHUNK < pendingSongs.length) await sleepBetweenBatch();
  }
}

// Count refreshes are few (one per distinct album/artist touched) — batch them
// as a chunked transaction with an idle gap between chunks.
async function refreshCounts(albumIds: Set<string>, artistIds: Set<string>): Promise<void> {
  const albumsList = [...albumIds];
  const artistsList = [...artistIds];
  for (let off = 0; off < albumsList.length; off += TX_CHUNK) {
    const chunk = albumsList.slice(off, off + TX_CHUNK);
    db.transaction(() => { for (const a of chunk) updateAlbumCounts(a); });
    if (off + TX_CHUNK < albumsList.length) await sleepBetweenBatch();
  }
  for (let off = 0; off < artistsList.length; off += TX_CHUNK) {
    const chunk = artistsList.slice(off, off + TX_CHUNK);
    db.transaction(() => { for (const a of chunk) updateArtistAlbumCount(a); });
    if (off + TX_CHUNK < artistsList.length) await sleepBetweenBatch();
  }
}

// ==================== DB helpers (mirror scanner.ts) ====================
//
// Per-song findOrCreate is gone — replaced by planArtist/planAlbum (one
// SELECT/INSERT per unique name, reused across the whole list, committed in
// the flush) and multi-row song inserts. Count refresh below uses a single
// aggregate query per album/artist instead of loading every child row into JS.

function updateAlbumCounts(albumId: string) {
  const row = sqlite.prepare("SELECT COUNT(*) AS cnt, COALESCE(SUM(duration), 0) AS dur FROM songs WHERE album_id = ?").get(albumId) as { cnt: number; dur: number };
  const count = Number(row?.cnt || 0);
  const duration = Math.round(Number(row?.dur || 0));
  db.update(albums).set({ songCount: count, duration, updatedAt: new Date().toISOString() }).where(eq(albums.id, albumId)).run();
}

function updateArtistAlbumCount(artistId: string) {
  const row = sqlite.prepare("SELECT COUNT(*) AS cnt FROM albums WHERE artist_id = ?").get(artistId) as { cnt: number };
  const count = Number(row?.cnt || 0);
  db.update(artists).set({ albumCount: count, updatedAt: new Date().toISOString() }).where(eq(artists.id, artistId)).run();
}