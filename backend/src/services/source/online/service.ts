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
import { eq } from "drizzle-orm";
import { cacheRemoteCover } from "../../playlistCover.js";
import { getOnlineProvider, getSourcePluginConfig, OnlineSongResult } from "./index.js";

/** Import a provider search result as an online DB song. Skips if already present. */
export async function importOnlineSong(
  providerId: string,
  song: OnlineSongResult,
  opts?: { playlistId?: string; userId?: string },
): Promise<{ success: boolean; songId?: string; deduped?: boolean; error?: string; cover?: string }> {
  const configured = getSourcePluginConfig(providerId);
  const provider = getOnlineProvider(providerId);
  if (!configured || !provider) return { success: false, error: "在线源未启用或未配置" };

  const streamUrl = provider.streamUrl(configured, song);

  // Dedup: same (provider, source, id) -> reuse the existing online row.
  const fingerprint = `${providerId}:${song.source}:${song.id}`;
  const existing = db.select().from(songs).where(eq(songs.fingerprint, fingerprint)).get();
  if (existing) {
    return { success: true, songId: existing.id, deduped: true, cover: existing.coverArt || undefined };
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

  if (albumId) updateAlbumCounts(albumId);
  if (artistId) updateArtistAlbumCount(artistId);

  return { success: true, songId, deduped: false, cover: coverArt || undefined };
}

export async function importOnlineSongs(
  providerId: string,
  songList: OnlineSongResult[],
  opts?: { playlistId?: string; userId?: string },
): Promise<{ added: number; deduped: number; failed: number; songs: { id: string; title: string }[] }> {
  let added = 0, deduped = 0, failed = 0;
  const songsOut: { id: string; title: string }[] = [];
  for (const s of songList) {
    try {
      const r = await importOnlineSong(providerId, s, opts);
      if (r.success && r.songId) {
        if (r.deduped) deduped++; else added++;
        songsOut.push({ id: r.songId, title: s.name });
      } else {
        failed++;
      }
    } catch {
      failed++;
    }
  }
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
