// ==================== Online song service (import from source providers) ====================
//
// Turns a source-provider search result into a DB `songs` row of type="web":
//   - the stream is served by /rest/stream proxying song.url (built by the
//     provider's streamUrl(), i.e. go-music-dl /music/download?stream=1)
//   - covers are cached locally like imported playlists
//   - artist/album rows are created/updated to match the rest of the library

import { v4 as uuidv4 } from "uuid";
import { db, sqlite } from "../../../db/index.js";
import { songs, artists, albums } from "../../../db/schema.js";
import { eq, inArray } from "drizzle-orm";
import { cacheRemoteCover } from "../../playlistCover.js";
import { getOnlineProvider, getSourcePluginConfig, OnlineSongResult } from "./index.js";
import { batchConcurrency, interactiveConcurrency } from "../../plugin/batchPacer.js";
import { runCoverBackfill, withCoverLimit } from "../../covers.js";

// 封面下载全局限流(≤2 并发)与封面后台回填见 covers.ts。

/** Import a provider search result as an online DB song. Skips if already present. */
export async function importOnlineSong(
  providerId: string,
  song: OnlineSongResult,
  opts?: { playlistId?: string; userId?: string },
): Promise<{ success: boolean; songId?: string; deduped?: boolean; error?: string; cover?: string }> {
  const core = await importOnlineSongCore(providerId, song, opts, new Map());
  if (core.success && core.songId) {
    // Single-song call site: refresh counts immediately (importOnlineSongs
    // batches them instead for cheaper bulk imports).
    const inserted = core.inserted;
    if (inserted?.albumId) updateAlbumCounts(inserted.albumId);
    if (inserted?.artistId) updateArtistAlbumCount(inserted.artistId);
  }
  return core;
}

interface OnlineSongImportCore {
  success: boolean;
  songId?: string;
  deduped?: boolean;
  error?: string;
  cover?: string;
  inserted?: { albumId?: string | null; artistId?: string };
}

// ---------------------------------------------------------------------------
// Batch-scoped artist/album resolver.
// Instead of a SELECT + possible INSERT per song (N round-trips over songs/
// albums/artists), a bulk caller preloads the referenced artist/album names
// into name->id maps, so repeated songs within one list become pure cache hits.
// Each map additionally caches the result of a first miss (existing rows reused,
// genuinely-new rows inserted once and remembered), so correctness holds even
// when the preload is skipped/falls back — no duplicate artist/album rows.
// Maps are scoped to a single importOnlineSongs call (bounded by list size) and
// thrown away after, so the batches never leak into a persistent cache.
// ---------------------------------------------------------------------------
function resolveArtist(name: string, artistIds: Map<string, string>): string {
  if (!name) return "";
  if (artistIds.has(name)) return artistIds.get(name)!;
  const existing = db.select().from(artists).where(eq(artists.name, name)).get();
  if (existing) {
    artistIds.set(name, existing.id);
    return existing.id;
  }
  const id = uuidv4();
  db.insert(artists).values({ id, name, albumCount: 0, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }).run();
  artistIds.set(name, id);
  return id;
}

function resolveAlbum(name: string | undefined, artistId: string, artist: string, albumIds: Map<string, string>): string | null {
  if (!name) return null;
  if (albumIds.has(name)) return albumIds.get(name)!;
  const existing = db.select().from(albums).where(eq(albums.name, name)).get();
  if (existing) {
    albumIds.set(name, existing.id);
    return existing.id;
  }
  const id = uuidv4();
  db.insert(albums).values({ id, name, artistId: artistId || null, artist, year: 0, songCount: 0, duration: 0, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }).run();
  albumIds.set(name, id);
  return id;
}

// Core import logic (no count refresh). `existingFingerprints` lets a bulk
// caller resolve dedup in one query instead of one SELECT per song; new rows
// insert their fingerprint into the map so duplicate tracks in one list collapse.
// `resolvers` lets a bulk caller reuse a shared artist/album id map instead of
// resolving (SELECT, possibly INSERT) every single song's artist/album.
async function importOnlineSongCore(
  providerId: string,
  song: OnlineSongResult,
  opts: { playlistId?: string; userId?: string } | undefined,
  existingFingerprints: Map<string, string>,
  resolvers?: { artistIds: Map<string, string>; albumIds: Map<string, string> },
): Promise<OnlineSongImportCore> {
  const configured = getSourcePluginConfig(providerId);
  const provider = getOnlineProvider(providerId);
  if (!configured || !provider) return { success: false, error: "在线源未启用或未配置" };

  const streamUrl = provider.streamUrl(configured, song);
  const fingerprint = `${providerId}:${song.source}:${song.id}`;
  let existing = existingFingerprints.get(fingerprint);
  if (!existing) {
    // Single-song call sites (e.g. match.ts) pass an empty map. Look the
    // fingerprint up in the DB so repeated matches return the SAME song row
    // instead of inserting a duplicate web song every time.
    const row = db.select().from(songs).where(eq(songs.fingerprint, fingerprint)).get();
    if (row) existing = row.id;
  }
  if (existing) {
    existingFingerprints.set(fingerprint, existing);
    return { success: true, songId: existing, deduped: true };
  }

  const now = new Date().toISOString();
  const songId = uuidv4();
  const sourcePlatform = song.source || providerId;

  // Resolve artist + album (match scanner.ts findOrCreate* behavior) — reuse
  // the batch-scoped resolvers so a bulk import doesn't SELECT/INSERT per song.
  const r = resolvers ?? { artistIds: new Map<string, string>(), albumIds: new Map<string, string>() };
  const artistId = resolveArtist(song.artist, r.artistIds);
  let albumId: string | null = resolveAlbum(song.album, artistId, song.artist, r.albumIds);

  // Cache the remote cover locally (like imported playlists). Falls back gracefully.
  // 封面下载走全局限流(≤2 并发),避免批量匹配时网络洪峰挤占前台请求。
  let coverArt: string | null | undefined;
  if (song.cover) {
    const cached = await withCoverLimit(() => cacheRemoteCover(song.cover, songId));
    if (cached) coverArt = cached;
  }

  const streamHeaders: Record<string, string> = {};
  if (song.source === "bilibili") streamHeaders["Referer"] = "https://www.bilibili.com/";

  db.insert(songs).values({
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
    url: streamUrl,
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
  }).run();

  existingFingerprints.set(fingerprint, songId);
  return { success: true, songId, deduped: false, cover: coverArt || undefined, inserted: { albumId, artistId } };
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
  } catch {
    // fall through (e.g. over-parameterized); dedup still works per-core.
  }

  // Preload the artist/album names actually referenced by this list into
  // name->id maps (one batched scan instead of a SELECT/INSERT per song).
  // Falls back gracefully: resolveArtist/resolveAlbum re-check the DB on a miss,
  // so even if this preload is skipped correctness (and dedup) is preserved.
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
  } catch {
    // over-parameterized / unsupported → empty maps; resolveArtist/Album re-check per miss.
  }

  const insertedAlbums = new Set<string>();
  const insertedArtists = new Set<string>();

  let added = 0, deduped = 0, failed = 0;
  const songsOut: { id: string; title: string; fingerprint: string }[] = [];

  // 交互操作(用户前端导入)用档位基础并发全速跑,不受 interactive 退让影响;
  // 后台批量(每日推荐同步/自动匹配)用 batchConcurrency()——交互窗口内自动压到 1。
  const conc = opts?.interactive ? interactiveConcurrency() : batchConcurrency();
  const results = await workerLimit(songList, conc, async (s) => {
    try {
      const r = await importOnlineSongCore(providerId, s, opts, existingFingerprints, { artistIds, albumIds });
      if (r.success && r.songId) {
        if (r.deduped) deduped++; else added++;
        if (r.inserted?.albumId) insertedAlbums.add(r.inserted.albumId);
        if (r.inserted?.artistId) insertedArtists.add(r.inserted.artistId);
        return { id: r.songId, title: s.name, fingerprint: `${providerId}:${s.source}:${s.id}` };
      }
      failed++;
      return null;
    } catch {
      failed++;
      return null;
    }
  });

  for (const r of results) if (r) songsOut.push(r);

  // 拿完歌曲后:若有导入的歌曲缺封面,后台限量补全(≤2 并发,不阻塞本流程)。
  // P0 直通导入(onlineSongFromExternalId)构造的歌曲恒无封面,靠这里自动补齐。
  if (songsOut.length > 0) {
    void runCoverBackfill(songsOut.map((r) => r.id)).catch(() => {});
  }

  // Refresh counts as a batch (one scan per touched album/artist) instead of
  // re-scanning the whole album on every single-song insert.
  for (const albumId of insertedAlbums) updateAlbumCounts(albumId);
  for (const artistId of insertedArtists) updateArtistAlbumCount(artistId);

  return { added, deduped, failed, songs: songsOut };
}

// ==================== DB helpers (mirror scanner.ts) ====================
//
// findOrCreateArtist/findOrCreateAlbum are gone — replaced by the batch-scoped
// resolveArtist/resolveAlbum above (one SELECT/INSERT per unique name, reused
// across the whole list). Count refresh below uses a single aggregate query per
// album/artist instead of loading every child row into JS to count it.

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
