// Cover storage:
//   - LOCAL covers (embedded artwork from scanned files, artist avatars from the
//     local album scrape) live in data/covers.
//   - PLATFORM covers (downloaded from online/music-dl providers via
//     cacheRemoteCover: web song covers, imported go-music-dl playlist covers)
//     live in data/online-covers, a separate directory that can be mounted to
//     a different volume in docker-compose without touching the local covers.
// Reads always probe both directories so legacy covers stored under
// data/covers keep working after the split.
import { db, sqlite } from "../db/index.js";
import { songs, albums, playlists, playlistSongs } from "../db/schema.js";
import { eq } from "drizzle-orm";
import fs from "fs";
import path from "path";
import { getDataDir } from "../utils/env.js";

// 数据目录统一走 getDataDir()(DATA_DIR 优先,默认 cwd/data),与 DB/插件/密钥同根:
//   - data/covers        本地刮削封面(扫描内嵌封面、艺术家头像)
//   - data/online-covers 平台/在线封面缓存(web 歌曲、歌单导入、按需获取),可独立挂卷
const COVERS_DIR = path.join(getDataDir(), "covers");
const ONLINE_COVERS_DIR = path.join(getDataDir(), "online-covers");
const CACHE_TTL = 24 * 60 * 60 * 1000; // 24h

// Resolved-path cache: probing both dirs costs a stat syscall per candidate on
// slow storage, and the same cover filename is looked up by every page that
// renders it. Cache the resolved absolute path (or null for a miss) per ref, so
// each ref is probed only once while the server stays up. Invalidated on write
// (cacheRemoteCover / deleteCover) so new downloads are seen immediately.
const resolveCache = new Map<string, string | null>();
const RESOLVE_CACHE_MAX = 2000;

function ensureDir() {
  if (!fs.existsSync(COVERS_DIR)) fs.mkdirSync(COVERS_DIR, { recursive: true });
  if (!fs.existsSync(ONLINE_COVERS_DIR)) fs.mkdirSync(ONLINE_COVERS_DIR, { recursive: true });
}

/** Absolute path of `ref` inside the platform covers dir (if it exists there). */
export function platformCoverPath(ref: string): string {
  return path.join(ONLINE_COVERS_DIR, ref);
}

/**
 * Locate a cover file by its bare filename, probing the platform dir first then
 * the local dir (legacy covers may still be under data/covers). Returns the
 * absolute path, or null if the file exists in neither directory.
 */
export function resolveCoverFile(ref: string): string | null {
  if (!ref) return null;
  const cached = resolveCache.get(ref);
  if (cached !== undefined) return cached;
  let resolved: string | null = null;
  for (const dir of [ONLINE_COVERS_DIR, COVERS_DIR]) {
    const p = path.join(dir, ref);
    try { if (fs.existsSync(p)) { resolved = p; break; } } catch { /* keep probing */ }
  }
  if (resolveCache.size >= RESOLVE_CACHE_MAX) {
    const first = resolveCache.keys().next().value;
    if (first) resolveCache.delete(first);
  }
  resolveCache.set(ref, resolved);
  return resolved;
}

/** Invalidate a cached path resolution (called by cover writes/deletes). */
export function invalidateCoverResolve(ref: string): void {
  resolveCache.delete(ref);
}

// Download a remote (platform) cover image and cache it locally. Returns the
// local file ref or null. Stored under data/online-covers so it can be
// mounted on a separate volume; reads resolve both dirs.
// force=true ignores the TTL and re-downloads (used on manual playlist sync).
export async function cacheRemoteCover(url: string, ref: string, force = false): Promise<string | null> {
  if (!url || !/^https?:\/\//i.test(url)) return null;
  const ext = url.includes(".png") ? "png" : "jpg";
  const fileName = `${ref}.${ext}`;
  const filePath = path.join(ONLINE_COVERS_DIR, fileName);
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
    invalidateCoverResolve(fileName);
    return fileName;
  } catch {
    return null;
  }
}

function mimeFor(name: string): string {
  const ext = path.extname(name).toLowerCase();
  return ext === ".png" ? "image/png" : ext === ".gif" ? "image/gif" : "image/jpeg";
}

// Copy an existing cover file (e.g. an album's cover_art) to a new ref name.
// Used to give a playlist a self-contained cover that is independent of the
// source entity (so it survives rename / source deletion). Returns the dest
// ref on success, or null if the source file is missing.
export function copyCoverToFile(destRef: string, srcCoverRef: string): string | null {
  if (!srcCoverRef) return null;
  const src = resolveCoverFile(srcCoverRef);
  if (!src) return null;
  try {
    ensureDir();
    fs.copyFileSync(src, path.join(COVERS_DIR, destRef));
    invalidateCoverResolve(destRef);
    return destRef;
  } catch {
    return null;
  }
}

// Delete a song's cached cover file(s). Online/web songs cache their remote
// cover under <songId>.jpg (.png), so removing the song must remove its cover
// file too, otherwise orphaned covers accumulate in data/online-covers.
// Returns how many files were actually removed.
export function deleteSongCover(songId: string): number {
  if (!songId) return 0;
  let removed = 0;
  for (const dir of [ONLINE_COVERS_DIR, COVERS_DIR]) {
    for (const name of [`${songId}.jpg`, `${songId}.png`, `${songId}.gif`]) {
      try {
        const filePath = path.join(dir, name);
        if (fs.existsSync(filePath)) { fs.unlinkSync(filePath); invalidateCoverResolve(name); removed++; }
      } catch { /* ignore */ }
    }
  }
  return removed;
}

// Clear the cached cover file for a playlist (called after sync / track changes)
export function clearPlaylistCoverCache(playlistId: string) {
  for (const dir of [ONLINE_COVERS_DIR, COVERS_DIR]) {
    try {
      const filePath = path.join(dir, `pl-${playlistId}.jpg`);
      if (fs.existsSync(filePath)) { fs.unlinkSync(filePath); invalidateCoverResolve(`pl-${playlistId}.jpg`); }
    } catch { /* ignore */ }
  }
  // Remove the stored ref so the cover is regenerated on next request
  try {
    db.update(playlists).set({ coverArt: null }).where(eq(playlists.id, playlistId)).run();
  } catch { /* ignore */ }
}

// 共享:取歌单自身可播条目中「第一首有封面」的歌曲封面**文件名**。
// 优先级:opts.preferSongId 指定歌曲的封面(歌曲封面 > 专辑封面);否则按条目
// position 顺序扫歌单(歌曲封面 > 专辑封面)。返回的文件名确保在封面目录真实
// 存在(resolveCoverFile 校验),文件缺失则继续找下一首;都没有返回 null。
// 单条聚合 SQL + 少量候选,替代旧 N+1 逐条循环。供内置推荐插件(dailyRecommend/
// dailyRoam/localRecommend)与外置歌单宿主(discovery)统一使用。
export function firstPlayableCoverFile(playlistId: string, opts?: { preferSongId?: string | null }): string | null {
  const prefer = opts?.preferSongId;
  if (prefer) {
    const p = sqlite.prepare(`
      SELECT s.cover_art AS songCover, a.cover_art AS albumCover
      FROM songs s LEFT JOIN albums a ON a.id = s.album_id
      WHERE s.id = ?
    `).get(prefer) as { songCover: string | null; albumCover: string | null } | undefined;
    const c = p ? (p.songCover && p.songCover.trim() ? p.songCover : p.albumCover || null) : null;
    if (c && resolveCoverFile(c)) return c;
  }
  const rows = sqlite.prepare(`
    SELECT
      CASE
        WHEN s.cover_art IS NOT NULL AND s.cover_art <> '' THEN s.cover_art
        WHEN a.cover_art IS NOT NULL AND a.cover_art <> '' THEN a.cover_art
        ELSE NULL END AS coverFile
    FROM playlist_songs ps
    JOIN songs s ON ps.song_id = s.id
    LEFT JOIN albums a ON a.id = s.album_id
    WHERE ps.playlist_id = ? AND ps.playable = 1 AND ps.song_id IS NOT NULL
    ORDER BY ps.position ASC
    LIMIT 50
  `).all(playlistId) as { coverFile: string | null }[];
  for (const r of rows) {
    if (r.coverFile && resolveCoverFile(r.coverFile)) return r.coverFile;
  }
  return null;
}

// Resolve playlist cover: serve the cached local image (either downloaded for
// imported playlists, or copied from the first song's album for self-built ones).
// Returns { file, mime } or null (UI falls back to the placeholder).
export function getPlaylistCover(playlistId: string): { file: string; mime: string } | null {
  const playlist = db.select().from(playlists).where(eq(playlists.id, playlistId)).get();
  if (!playlist) return null;

  // 1. A cached local cover image already exists -> serve it (probe both dirs)
  if (playlist.coverArt && /\.(jpg|jpeg|png|gif)$/i.test(playlist.coverArt)) {
    if (resolveCoverFile(playlist.coverArt)) {
      return { file: playlist.coverArt, mime: mimeFor(playlist.coverArt) };
    }
  }

  // 2. No cover yet: self-built (or import cover failed) -> copy the first
  //    playable song's album cover to pl-<playlistId>.jpg and serve it directly
  const srcFile = firstPlayableCoverFile(playlistId);
  if (!srcFile) return null;

  const coverFile = `pl-${playlistId}.jpg`;
  const src = resolveCoverFile(srcFile);
  if (!src) return null;
  try {
    ensureDir();
    fs.copyFileSync(src, path.join(COVERS_DIR, coverFile));
    db.update(playlists).set({ coverArt: coverFile, updatedAt: new Date().toISOString() }).where(eq(playlists.id, playlistId)).run();
    return { file: coverFile, mime: mimeFor(coverFile) };
  } catch {
    return null;
  }
}
