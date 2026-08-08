import { eq, or, inArray } from "drizzle-orm";
import { db } from "../db/index.js";
import { songs, albums, artists, playlists, playlistSongs, genres } from "../db/schema.js";
import { suffixToMime } from "./dlna/queue.js";

// Convert song rows into QueueItem objects (shared by the album/playlist play
// endpoints and the flow runner).
export function songsToQueueItems(rows: any[]): any[] {
  return rows.map((s) => {
    const coverArt = s.coverArt || (s.albumId ? `al-${s.albumId}` : undefined);
    return {
      songId: s.id,
      title: s.title || "未知",
      artist: s.artist || undefined,
      album: s.album || undefined,
      albumId: s.albumId || undefined,
      mime: suffixToMime(s.suffix || ""),
      coverArt,
      duration: typeof s.duration === "number" ? s.duration : undefined,
    };
  });
}

// Resolve a content reference (playlist / artist / album / genre) into song
// rows + a display name. Mirrors the frontend usePlayContent behavior.
export function resolveContentSongs(type: string, id: string): { rows: any[]; name: string } | null {
  if (type === "playlist") {
    const pl = db.select().from(playlists).where(eq(playlists.id, id)).get();
    if (!pl) return null;
    // Batch-load the playlist's songs in one query instead of N+1 (was one
    // songs query per entry). Order preserved via the id->row Map.
    const entries = db.select().from(playlistSongs).where(eq(playlistSongs.playlistId, id)).all()
      .filter(e => e.playable && e.songId);
    const songIds = entries.map(e => e.songId!);
    const songMap = songIds.length
      ? new Map(db.select().from(songs).where(inArray(songs.id, songIds)).all().map((s) => [s.id, s]))
      : new Map();
    const rows = entries.map(e => songMap.get(e.songId!)).filter(Boolean);
    return { rows, name: pl.name };
  }
  if (type === "album") {
    const al = db.select().from(albums).where(eq(albums.id, id)).get();
    if (!al) return null;
    const rows = db.select().from(songs).where(eq(songs.albumId, id)).orderBy(songs.discNumber, songs.track).all();
    return { rows, name: al.name };
  }
  if (type === "artist") {
    const ar = db.select().from(artists).where(eq(artists.id, id)).get();
    if (!ar) return null;
    const albumIds = db.select({ id: albums.id }).from(albums).where(eq(albums.artistId, id)).all().map(a => a.id);
    const rows = albumIds.length > 0
      ? db.select().from(songs).where(or(eq(songs.artistId, id), inArray(songs.albumId, albumIds))).orderBy(songs.albumId, songs.discNumber, songs.track).all()
      : db.select().from(songs).where(eq(songs.artistId, id)).orderBy(songs.discNumber, songs.track).all();
    return { rows, name: ar.name };
  }
  if (type === "genre") {
    const g = db.select().from(genres).where(eq(genres.id, id)).get();
    if (!g) return null;
    const rows = db.select().from(songs).where(eq(songs.genre, g.name)).orderBy(songs.albumId, songs.discNumber, songs.track).all();
    return { rows, name: g.name };
  }
  return null;
}