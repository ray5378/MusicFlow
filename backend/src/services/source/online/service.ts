// ==================== Online song service (import from source providers) ====================
//
// Turns a source-provider search result into a DB `songs` row of type="web":
//   - the stream is served by /rest/stream proxying song.url (built by the
//     provider's streamUrl(), i.e. go-music-dl /music/download?stream=1)
//   - covers are cached locally like imported playlists
//   - artist/album rows are created/updated to match the rest of the library

import { v4 as uuidv4 } from "uuid";
import { db } from "../../../db/index.js";
import { songs, artists, albums } from "../../../db/schema.js";
import { eq, inArray } from "drizzle-orm";
import { cacheRemoteCover } from "../../playlistCover.js";
import { getOnlineProvider, getSourcePluginConfig, OnlineSongResult } from "./index.js";

// Bounded parallelism for cover downloads/network work during a bulk import.
// Keeps resource usage low (a handful of in-flight upstream requests) while
// letting serialized upstream latency overlap slightly — a balance between the
// old one-song-at-a-time loop and a full unbounded Promise.all.
const BULK_IMPORT_CONCURRENCY = 4;

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

// Core import logic (no count refresh). `existingFingerprints` lets a bulk
// caller resolve dedup in one query instead of one SELECT per song; new rows
// insert their fingerprint into the map so duplicate tracks in one list collapse.
async function importOnlineSongCore(
  providerId: string,
  song: OnlineSongResult,
  opts: { playlistId?: string; userId?: string } | undefined,
  existingFingerprints: Map<string, string>,
): Promise<OnlineSongImportCore> {
  const configured = getSourcePluginConfig(providerId);
  const provider = getOnlineProvider(providerId);
  if (!configured || !provider) return { success: false, error: "在线源未启用或未配置" };

  const streamUrl = provider.streamUrl(configured, song);
  const fingerprint = `${providerId}:${song.source}:${song.id}`;
  const existing = existingFingerprints.get(fingerprint);
  if (existing) {
    return { success: true, songId: existing, deduped: true };
  }

  const now = new Date().toISOString();
  const songId = uuidv4();
  const sourcePlatform = song.source || providerId;

  // Resolve artist + album (match scanner.ts findOrCreate* behavior).
  const artistId = findOrCreateArtist(song.artist);
  let albumId: string | null = null;
  if (song.album) albumId = findOrCreateAlbum({ name: song.album, artistId, artist: song.artist });

  // Cache the remote cover locally (like imported playlists). Falls back gracefully.
  let coverArt: string | null | undefined;
  if (song.cover) {
    const cached = await cacheRemoteCover(song.cover, songId);
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
  opts?: { playlistId?: string; userId?: string },
): Promise<{ added: number; deduped: number; failed: number; songs: { id: string; title: string }[] }> {
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

  const insertedAlbums = new Set<string>();
  const insertedArtists = new Set<string>();

  let added = 0, deduped = 0, failed = 0;
  const songsOut: { id: string; title: string }[] = [];

  const results = await workerLimit(songList, BULK_IMPORT_CONCURRENCY, async (s) => {
    try {
      const r = await importOnlineSongCore(providerId, s, opts, existingFingerprints);
      if (r.success && r.songId) {
        if (r.deduped) deduped++; else added++;
        if (r.inserted?.albumId) insertedAlbums.add(r.inserted.albumId);
        if (r.inserted?.artistId) insertedArtists.add(r.inserted.artistId);
        return { id: r.songId, title: s.name };
      }
      failed++;
      return null;
    } catch {
      failed++;
      return null;
    }
  });

  for (const r of results) if (r) songsOut.push(r);

  // Refresh counts as a batch (one scan per touched album/artist) instead of
  // re-scanning the whole album on every single-song insert.
  for (const albumId of insertedAlbums) updateAlbumCounts(albumId);
  for (const artistId of insertedArtists) updateArtistAlbumCount(artistId);

  return { added, deduped, failed, songs: songsOut };
}

// ==================== DB helpers (mirror scanner.ts) ====================

function findOrCreateArtist(name: string): string {
  if (!name) return "";
  const existing = db.select().from(artists).where(eq(artists.name, name)).get();
  if (existing) return existing.id;
  const id = uuidv4();
  db.insert(artists).values({ id, name, albumCount: 0, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }).run();
  return id;
}

function findOrCreateAlbum(p: { name: string; artistId: string; artist: string }): string {
  const existing = db.select().from(albums).where(eq(albums.name, p.name)).get();
  if (existing) return existing.id;
  const id = uuidv4();
  db.insert(albums).values({ id, name: p.name, artistId: p.artistId || null, artist: p.artist, year: 0, songCount: 0, duration: 0, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }).run();
  return id;
}

function updateAlbumCounts(albumId: string) {
  const n = db.select().from(songs).where(eq(songs.albumId, albumId)).all();
  db.update(albums).set({ songCount: n.length, duration: n.reduce((sum, s) => sum + (s.duration || 0), 0), updatedAt: new Date().toISOString() }).where(eq(albums.id, albumId)).run();
}

function updateArtistAlbumCount(artistId: string) {
  const n = db.select().from(albums).where(eq(albums.artistId, artistId)).all();
  db.update(artists).set({ albumCount: n.length, updatedAt: new Date().toISOString() }).where(eq(artists.id, artistId)).run();
}
