// Playlist cover generation:
//   - imported playlists: download the platform cover and cache it as a local image
//   - self-built playlists: copy the FIRST playable song's album cover to a local
//     image file (pl-<playlistId>.jpg) and serve it directly
// Both paths produce a plain image file served by /rest/getCoverArt — identical
// behavior, no SVG wrappers, works in every client (MA, Feishin, browsers...).
import { db } from "../db/index.js";
import { songs, albums, playlists, playlistSongs } from "../db/schema.js";
import { eq } from "drizzle-orm";
import fs from "fs";
import path from "path";

const COVERS_DIR = path.join(process.cwd(), "data", "covers");
const CACHE_TTL = 24 * 60 * 60 * 1000; // 24h

function ensureDir() {
  if (!fs.existsSync(COVERS_DIR)) fs.mkdirSync(COVERS_DIR, { recursive: true });
}

// Download a remote cover image and cache it locally. Returns the local file ref or null.
// force=true ignores the TTL and re-downloads (used on manual playlist sync).
export async function cacheRemoteCover(url: string, ref: string, force = false): Promise<string | null> {
  if (!url || !/^https?:\/\//i.test(url)) return null;
  const ext = url.includes(".png") ? "png" : "jpg";
  const fileName = `${ref}.${ext}`;
  const filePath = path.join(COVERS_DIR, fileName);
  if (!force && fs.existsSync(filePath)) {
    const stat = fs.statSync(filePath);
    if (Date.now() - stat.mtimeMs < CACHE_TTL) return fileName;
  }
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);
    const res = await fetch(url, { signal: controller.signal, headers: { "User-Agent": "Mozilla/5.0" } });
    clearTimeout(timeout);
    if (!res.ok) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length < 100) return null;
    ensureDir();
    fs.writeFileSync(filePath, buf);
    return fileName;
  } catch {
    return null;
  }
}

function mimeFor(name: string): string {
  const ext = path.extname(name).toLowerCase();
  return ext === ".png" ? "image/png" : ext === ".gif" ? "image/gif" : "image/jpeg";
}

// Clear the cached cover file for a playlist (called after sync / track changes)
export function clearPlaylistCoverCache(playlistId: string) {
  try {
    const filePath = path.join(COVERS_DIR, `pl-${playlistId}.jpg`);
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
  } catch { /* ignore */ }
  // Remove the stored ref so the cover is regenerated on next request
  try {
    db.update(playlists).set({ coverArt: null }).where(eq(playlists.id, playlistId)).run();
  } catch { /* ignore */ }
}

// Find the first playable song's album cover file name (albums.cover_art), or null
function firstAlbumCoverFile(playlistId: string): string | null {
  const entries = db.select().from(playlistSongs).where(eq(playlistSongs.playlistId, playlistId)).all();
  for (const e of entries) {
    if (!e.playable || !e.songId) continue;
    const song = db.select().from(songs).where(eq(songs.id, e.songId)).get();
    if (!song?.albumId) continue;
    const album = db.select().from(albums).where(eq(albums.id, song.albumId)).get();
    if (!album?.coverArt) continue;
    const src = path.join(COVERS_DIR, album.coverArt);
    if (fs.existsSync(src)) return album.coverArt;
  }
  return null;
}

// Resolve playlist cover: serve the cached local image (either downloaded for
// imported playlists, or copied from the first song's album for self-built ones).
// Returns { file, mime } or null (UI falls back to the placeholder).
export function getPlaylistCover(playlistId: string): { file: string; mime: string } | null {
  const playlist = db.select().from(playlists).where(eq(playlists.id, playlistId)).get();
  if (!playlist) return null;

  // 1. A cached local cover image already exists -> serve it
  if (playlist.coverArt && /\.(jpg|jpeg|png|gif)$/i.test(playlist.coverArt)) {
    const cached = path.join(COVERS_DIR, playlist.coverArt);
    if (fs.existsSync(cached)) {
      return { file: playlist.coverArt, mime: mimeFor(playlist.coverArt) };
    }
  }

  // 2. No cover yet: self-built (or import cover failed) -> copy the first
  //    playable song's album cover to pl-<playlistId>.jpg and serve it directly
  const srcFile = firstAlbumCoverFile(playlistId);
  if (!srcFile) return null;

  const coverFile = `pl-${playlistId}.jpg`;
  try {
    ensureDir();
    fs.copyFileSync(path.join(COVERS_DIR, srcFile), path.join(COVERS_DIR, coverFile));
    db.update(playlists).set({ coverArt: coverFile, updatedAt: new Date().toISOString() }).where(eq(playlists.id, playlistId)).run();
    return { file: coverFile, mime: mimeFor(coverFile) };
  } catch {
    return null;
  }
}
