import { db, sqlite } from "../../db/index.js";
import { songs, albums, artists, mediaSources, albumArtists } from "../../db/schema.js";
import { eq, inArray } from "drizzle-orm";
import { v4 as uuidv4 } from "uuid";
import fs from "fs";
import path from "path";
import { parseBuffer } from "music-metadata";
import { getDataDir } from "../../utils/env.js";
import { deleteSongLyric } from "../lyricsStore.js";
import { createLogger } from "../../utils/logger.js";

const AUDIO_EXTENSIONS = new Set([".mp3", ".flac", ".wav", ".aac", ".ogg", ".m4a", ".wma", ".ape", ".aiff", ".opus"]);
const HEADER_SIZE = 4 * 1024 * 1024; // 4MB - enough for ID3v2 + embedded cover art
const TRAVERSE_CONCURRENCY = 10; // 目录遍历并发
const DOWNLOAD_CONCURRENCY = 8; // 音频头部下载并发
const MAX_RETRIES = 3; // 网络请求重试次数

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

// Fetch with retry + exponential backoff (handles 429 / 5xx / network flakiness)
async function fetchWithRetry(url: string, options: RequestInit = {}, retries: number = MAX_RETRIES): Promise<Response> {
  let lastError: any;
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (attempt > 0) await sleep(500 * attempt + Math.floor(Math.random() * 300));
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);
    try {
      const res = await fetch(url, { ...options, signal: controller.signal });
      const status = res.status;
      clearTimeout(timeout);
      if (status === 429 || status >= 500) {
        lastError = new Error(`HTTP ${status}`);
        continue;
      }
      // 401/403 等一般性错误不重试（避免影响认证失败场景）
      return res;
    } catch (e: any) {
      clearTimeout(timeout);
      lastError = e;
    }
  }
  throw lastError || new Error("network error");
}

interface MusicMetadata {
  title: string; artist: string; album: string; duration: number; bitRate: number;
  genre: string; year: number; track: number; discNumber: number;
  contentType: string; suffix: string; size: number;
  picture?: { format: string; data: Buffer };
}

const log = createLogger("SCANNER");
export interface ScanProgress {
  phase: "traverse" | "scanning" | "done";
  totalDirs: number;
  processedDirs: number;
  totalFiles: number;
  processedFiles: number;
  added: number;
  updated: number;
  skipped: number;
  currentTrack: string;
  mode: "full" | "incremental";
}

export type ScanMode = "full" | "incremental";

// ==================== WebDAV ====================

export async function testWebDAVConnection(url: string, username?: string, password?: string, rootPath?: string) {
  const targetUrl = normalizeUrl(url, rootPath);
  const headers: Record<string, string> = { Depth: "0" };
  if (username && password) headers["Authorization"] = "Basic " + Buffer.from(`${username}:${password}`).toString("base64");
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000);
  try {
    const res = await fetch(targetUrl, { method: "PROPFIND", headers, signal: controller.signal });
    clearTimeout(timeout);
    if (res.ok || res.status === 207) return { success: true, message: `连接成功 (HTTP ${res.status})` };
    return { success: false, error: `服务器返回 HTTP ${res.status}` };
  } catch (e: any) {
    clearTimeout(timeout);
    return { success: false, error: e.name === "AbortError" ? "连接超时（10秒）" : e.message || "无法连接" };
  }
}

function normalizeUrl(url: string, rootPath?: string): string {
  let u = url.replace(/\/+$/, "");
  if (rootPath) u += rootPath.replace(/\/+$/, "");
  return u;
}

function buildAuthHeader(username?: string, password?: string): string | null {
  if (username && password) return "Basic " + Buffer.from(`${username}:${password}`).toString("base64");
  return null;
}

interface PropfindEntry {
  href: string;
  size: number;
  lastModified?: string;
  etag?: string;
}

async function webdavPropfind(url: string, auth: string | null, depth: string = "1"): Promise<{ collections: string[]; entries: PropfindEntry[] }> {
  const headers: Record<string, string> = {
    Depth: depth, "Content-Type": "application/xml", Accept: "application/xml, text/xml",
  };
  if (auth) headers["Authorization"] = auth;
  const body = `<?xml version="1.0" encoding="utf-8"?><D:propfind xmlns:D="DAV:"><D:prop><D:resourcetype/><D:getcontentlength/><D:getlastmodified/><D:getetag/></D:prop></D:propfind>`;
  const res = await fetchWithRetry(url, { method: "PROPFIND", headers, body });
  if (!res.ok && res.status !== 207) throw new Error(`PROPFIND ${res.status}`);
  const xml = await res.text();
  const collections: string[] = [];
  const entries: PropfindEntry[] = [];
  const blocks = xml.split("<D:response>").slice(1);
  for (const block of blocks) {
    const hrefMatch = block.match(/<D:href>([^<]+)<\/D:href>/);
    if (!hrefMatch) continue;
    const href = decodeURIComponent(hrefMatch[1]);
    if (block.includes("<D:collection")) {
      collections.push(href);
    } else {
      const lengthMatch = block.match(/<D:getcontentlength>(\d+)<\/D:getcontentlength>/);
      const mtimeMatch = block.match(/<D:getlastmodified>([^<]+)<\/D:getlastmodified>/);
      const etagMatch = block.match(/<D:getetag>([^<]+)<\/D:getetag>/);
      entries.push({ href, size: lengthMatch ? parseInt(lengthMatch[1]) : 0, lastModified: mtimeMatch?.[1], etag: etagMatch?.[1] });
    }
  }
  return { collections, entries };
}

// Streaming scan: directories and file scraping run concurrently.
// As soon as a directory is listed, its audio files are enqueued for scraping.
export async function scanWebDAVSource(sourceId: string, config: any, mode: ScanMode, onProgress?: (p: ScanProgress) => void, signal?: AbortSignal) {
  const { url, username, password, root_path } = config;
  const auth = buildAuthHeader(username, password);
  const baseUrl = normalizeUrl(url, root_path);
  const baseUrlPath = decodeURIComponent(new URL(baseUrl).pathname);

  const progress: ScanProgress = {
    phase: "traverse", totalDirs: 0, processedDirs: 0,
    totalFiles: 0, processedFiles: 0, added: 0, updated: 0, skipped: 0, currentTrack: "", mode,
  };
  if (onProgress) onProgress(progress);

  const dirQueue: { url: string; attempts: number }[] = [{ url: baseUrl + "/", attempts: 0 }];
  const fileQueue: PropfindEntry[] = [];
  const visited = new Set<string>();
  const seenPaths = new Set<string>();
  const MAX_DIR_ATTEMPTS = 4;

  let added = 0, updated = 0, skipped = 0;
  let activeDirs = 0, activeFiles = 0;
  let discoveredFiles = 0;
  let doneResolve: () => void;
  const done = new Promise<void>(r => doneResolve = r);
  let finished = false;

  const emitProgress = () => { if (onProgress) onProgress({ ...progress }); };

  const maybeDone = () => {
    if (finished) return;
    if (dirQueue.length === 0 && fileQueue.length === 0 && activeDirs === 0 && activeFiles === 0) {
      finished = true;
      progress.phase = "done";
      progress.currentTrack = "";
      progress.totalFiles = discoveredFiles;
      emitProgress();
      console.log(`[SCANNER] Scan complete: +${added} ~${updated} -${skipped} (mode=${mode})`);
      doneResolve();
    }
  };

  // Abort: stop scheduling new work and finish as soon as in-flight tasks settle
  const abortScan = () => {
    if (finished) return;
    finished = true;
    progress.phase = "done";
    progress.currentTrack = "";
    progress.totalFiles = discoveredFiles;
    emitProgress();
    console.log(`[SCANNER] Scan aborted: +${added} ~${updated} -${skipped} (mode=${mode})`);
    doneResolve();
  };
  if (signal) {
    if (signal.aborted) { abortScan(); return { added: 0, updated: 0, removed: 0, skipped: 0, aborted: true }; }
    signal.addEventListener("abort", abortScan, { once: true });
  }

  // File worker: download header, extract metadata, upsert
  const processFile = async (entry: PropfindEntry) => {
    const href = entry.href;
    const songPath = `w:${sourceId}:${href}`;
    seenPaths.add(songPath);

    // Incremental: skip if fingerprint unchanged (size + mtime + etag)
    if (mode === "incremental") {
      const existing = db.select().from(songs).where(eq(songs.path, songPath)).get();
      if (existing) {
        const fp = buildFingerprint(entry);
        const storedFp = existing.fingerprint || "";
        const matches = storedFp ? storedFp === fp : (existing.size || 0) === entry.size;
        if (matches) { skipped++; return; }
      }
    }

    const host = new URL(baseUrl).host;
    const downloadUrl = `http://${host}${href}`;
    progress.currentTrack = path.basename(href);
    emitProgress();
    try {
      const res = await fetchWithRetry(downloadUrl, {
        headers: {
          ...(auth ? { Authorization: auth } : {}),
          Range: `bytes=0-${HEADER_SIZE - 1}`,
        },
      });
      if (!res.ok && res.status !== 206) { skipped++; return; }
      const arrayBuf = await res.arrayBuffer();
      const headerBuf = Buffer.from(arrayBuf);
      const meta = await extractMetadataHeader(headerBuf, path.basename(href), entry.size);
      const result = upsertSong(songPath, meta, sourceId, mode === "incremental" ? buildFingerprint(entry) : undefined);
      if (result === "added") added++;
      else if (result === "updated") updated++;
      else skipped++;
    } catch { skipped++; }
  };

  // Directory worker: PROPFIND a dir, enqueue files + child dirs.
  // Only mark dir as visited on SUCCESS so retries actually re-run.
  const processDir = async (item: { url: string; attempts: number }) => {
    const dirPath = decodeURIComponent(new URL(item.url).pathname);
    if (visited.has(dirPath)) return;
    try {
      const { collections, entries } = await webdavPropfind(item.url, auth, "1");
      visited.add(dirPath);
      for (const e of entries) {
        const ext = path.extname(e.href).toLowerCase();
        if (AUDIO_EXTENSIONS.has(ext)) { fileQueue.push(e); discoveredFiles++; }
      }
      for (const coll of collections) {
        const decoded = decodeURIComponent(coll);
        if (decoded === dirPath || decoded === dirPath + "/") continue;
        if (!decoded.startsWith(baseUrlPath)) continue;
        const host = new URL(item.url).host;
        const childUrl = coll.startsWith("http") ? coll : `http://${host}${coll}`;
        if (!visited.has(decoded)) dirQueue.push({ url: childUrl, attempts: 0 });
      }
    } catch {
      if (item.attempts < MAX_DIR_ATTEMPTS) {
        await sleep(300 * (item.attempts + 1) + Math.floor(Math.random() * 200));
        dirQueue.push({ url: item.url, attempts: item.attempts + 1 });
      }
    }
  };

  const pumpDirs = () => {
    while (activeDirs < TRAVERSE_CONCURRENCY && dirQueue.length > 0) {
      if (signal?.aborted) break;
      const item = dirQueue.shift()!;
      const dirPath = decodeURIComponent(new URL(item.url).pathname);
      if (visited.has(dirPath)) continue;
      activeDirs++;
      processDir(item).finally(() => {
        activeDirs--;
        progress.processedDirs = visited.size;
        progress.totalDirs = visited.size + dirQueue.length;
        progress.totalFiles = discoveredFiles;
        emitProgress();
        pumpDirs();
        pumpFiles();
        maybeDone();
      });
    }
  };

  const pumpFiles = () => {
    while (activeFiles < DOWNLOAD_CONCURRENCY && fileQueue.length > 0) {
      if (signal?.aborted) break;
      const entry = fileQueue.shift()!;
      activeFiles++;
      processFile(entry).finally(() => {
        activeFiles--;
        progress.processedFiles++;
        progress.added = added;
        progress.updated = updated;
        progress.skipped = skipped;
        if (progress.phase === "traverse") progress.phase = "scanning";
        emitProgress();
        pumpFiles();
        maybeDone();
      });
    }
  };

  pumpDirs();
  pumpFiles();
  await done;

  // Cleanup: remove songs that no longer exist in the source (both modes).
  // Skipped when aborted to avoid deleting songs from an incomplete traversal.
  if (signal?.aborted) return { added, updated, removed: 0, skipped, aborted: true };
  const existingSongs = db.select().from(songs).all().filter(s => s.path.startsWith(`w:${sourceId}:`));
  let removed = 0;
  for (const s of existingSongs) {
    if (!seenPaths.has(s.path)) {
      db.delete(songs).where(eq(songs.id, s.id)).run();
      removed++;
    }
  }
  if (removed > 0) cleanupOrphans();

  console.log(`[SCANNER] WebDAV ${mode} scan: +${added} ~${updated} -${removed} skip=${skipped}`);
  return { added, updated, removed, skipped };
}

// Extract metadata from header chunk using music-metadata
async function extractMetadataHeader(headerBuf: Buffer, fileName: string, fileSize: number): Promise<MusicMetadata> {
  const ext = path.extname(fileName).toLowerCase();
  const nameWithoutExt = path.basename(fileName, ext);
  const fallback = (): MusicMetadata => {
    const parts = nameWithoutExt.split(" - ");
    return {
      title: parts.length > 1 ? parts[1].trim() : nameWithoutExt,
      artist: parts.length > 1 ? parts[0].trim() : "Unknown Artist",
      album: "Unknown Album", duration: 0, bitRate: 0, genre: "", year: 0,
      track: 0, discNumber: 1, contentType: mimeFromExt(ext), suffix: ext.replace(".", ""), size: fileSize,
    };
  };

  try {
    const mime = mimeFromExt(ext);
    const metadata = await parseBuffer(headerBuf, { mimeType: mime, size: fileSize });
    const format = metadata.format || {};
    const common = metadata.common || {};

    let title = common.title || nameWithoutExt;
    let artist = common.artist || "Unknown Artist";
    let album = common.album || "Unknown Album";
    let duration = Math.round(format.duration || 0);
    let bitRate = Math.round((format.bitrate || 0) / 1000);
    let genre = common.genre?.[0] || "";
    let year = common.year || 0;
    let track = common.track?.no || 0;
    let discNumber = common.disk?.no || 1;

    // For MP3: estimate duration from file size and bitrate if not parsed
    if (ext === ".mp3" && duration === 0 && bitRate > 0) {
      duration = Math.round(((fileSize) * 8) / (bitRate * 1000));
    }

    return { title, artist, album, duration, bitRate, genre, year, track, discNumber, contentType: mime, suffix: ext.replace(".", ""), size: fileSize, picture: extractPicture(common) };
  } catch {
    return fallback();
  }
}

function extractPicture(common: any): { format: string; data: Buffer } | undefined {
  const pics = common.picture;
  if (!pics || pics.length === 0) return undefined;
  const pic = pics[0];
  if (!pic || !pic.data || pic.data.length === 0) return undefined;
  return { format: pic.format || "image/jpeg", data: pic.data };
}

// Save cover art image to disk and return its file reference
function saveCoverArt(albumId: string, pic: { format: string; data: Buffer } | undefined): string | null {
  if (!pic) return null;
  try {
    const ext = pic.format === "image/png" ? "png" : pic.format === "image/gif" ? "gif" : "jpg";
    const dir = path.join(getDataDir(), "covers");
    fs.mkdirSync(dir, { recursive: true });
    const filePath = path.join(dir, `${albumId}.${ext}`);
    fs.writeFileSync(filePath, pic.data);
    return `${albumId}.${ext}`;
  } catch (e) {
    log.error("Save cover error", { err: e });
    return null;
  }
}


// ==================== Local ====================

function scanLocalDir(dirPath: string): string[] {
  const files: string[] = [];
  if (!fs.existsSync(dirPath)) return files;
  const entries = fs.readdirSync(dirPath, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dirPath, entry.name);
    if (entry.isDirectory()) files.push(...scanLocalDir(fullPath));
    else if (entry.isFile() && AUDIO_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) files.push(fullPath);
  }
  return files;
}

async function extractMetadataLocal(filePath: string): Promise<MusicMetadata> {
  const ext = path.extname(filePath).toLowerCase();
  const nameWithoutExt = path.basename(filePath, ext);
  const stat = fs.statSync(filePath);
  try {
    const buf = Buffer.alloc(Math.min(HEADER_SIZE, stat.size));
    const fd = fs.openSync(filePath, "r");
    fs.readSync(fd, buf, 0, buf.length, 0);
    fs.closeSync(fd);
    const metadata = await parseBuffer(buf, { mimeType: mimeFromExt(ext), size: stat.size });
    const format = metadata.format || {};
    const common = metadata.common || {};
    let duration = Math.round(format.duration || 0);
    let bitRate = Math.round((format.bitrate || 0) / 1000);
    if (ext === ".mp3" && duration === 0 && bitRate > 0) {
      duration = Math.round((stat.size * 8) / (bitRate * 1000));
    }
    return {
      title: common.title || nameWithoutExt, artist: common.artist || "Unknown Artist",
      album: common.album || "Unknown Album", duration, bitRate,
      genre: common.genre?.[0] || "", year: common.year || 0,
      track: common.track?.no || 0, discNumber: common.disk?.no || 1,
      contentType: mimeFromExt(ext), suffix: ext.replace(".", ""), size: stat.size,
      picture: extractPicture(common),
    };
  } catch {
    const parts = nameWithoutExt.split(" - ");
    return {
      title: parts.length > 1 ? parts[1].trim() : nameWithoutExt,
      artist: parts.length > 1 ? parts[0].trim() : "Unknown Artist",
      album: "Unknown Album", duration: 0, bitRate: 0, genre: "", year: 0,
      track: 0, discNumber: 1, contentType: mimeFromExt(ext), suffix: ext.replace(".", ""), size: stat.size,
    };
  }
}

function mimeFromExt(ext: string): string {
  const map: Record<string, string> = {
    ".mp3": "audio/mpeg", ".flac": "audio/flac", ".wav": "audio/wav",
    ".aac": "audio/aac", ".ogg": "audio/ogg", ".m4a": "audio/mp4",
    ".wma": "audio/x-ms-wma", ".ape": "audio/ape", ".aiff": "audio/aiff", ".opus": "audio/opus",
  };
  return map[ext] || "audio/mpeg";
}

// ==================== DB Helpers ====================

function findOrCreateArtist(name: string): string {
  if (!name || name === "Unknown Artist") return "";
  const existing = db.select().from(artists).where(eq(artists.name, name)).get();
  if (existing) return existing.id;
  const id = uuidv4();
  db.insert(artists).values({ id, name, albumCount: 0, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }).run();
  return id;
}

function findOrCreateAlbum(name: string, artistId: string, artistName: string, year: number, picture?: { format: string; data: Buffer }): string {
  if (!name || name === "Unknown Album") return "";
  const existing = db.select().from(albums).where(eq(albums.name, name)).get();
  if (existing) {
    // Backfill cover art for albums created before cover extraction existed
    if (!existing.coverArt && picture) {
      const coverRef = saveCoverArt(existing.id, picture);
      if (coverRef) {
        db.update(albums).set({ coverArt: coverRef, updatedAt: new Date().toISOString() }).where(eq(albums.id, existing.id)).run();
      }
    }
    return existing.id;
  }
  const id = uuidv4();
  const coverRef = saveCoverArt(id, picture);
  db.insert(albums).values({ id, name, artistId, artist: artistName, year, coverArt: coverRef, songCount: 0, duration: 0, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }).run();
  return id;
}

function upsertSong(songPath: string, meta: MusicMetadata, sourceId: string, fingerprint?: string): "added" | "updated" | "skip" {
  const existing = db.select().from(songs).where(eq(songs.path, songPath)).get();
  const artistId = findOrCreateArtist(meta.artist) || null;
  const albumId = findOrCreateAlbum(meta.album, artistId || "", meta.artist, meta.year, meta.picture) || null;
  if (existing) {
    db.update(songs).set({
      title: meta.title, artist: meta.artist, artistId, album: meta.album, albumId,
      duration: meta.duration, bitRate: meta.bitRate, contentType: meta.contentType,
      suffix: meta.suffix, size: meta.size, genre: meta.genre,
      discNumber: meta.discNumber, track: meta.track, updatedAt: new Date().toISOString(),
      ...(fingerprint ? { fingerprint } : {}),
    }).where(eq(songs.id, existing.id)).run();
    return "updated";
  }
  const songId = uuidv4();
  db.insert(songs).values({
    id: songId, title: meta.title, artist: meta.artist, artistId, album: meta.album, albumId,
    duration: meta.duration, bitRate: meta.bitRate, contentType: meta.contentType,
    suffix: meta.suffix, path: songPath, size: meta.size, genre: meta.genre,
    discNumber: meta.discNumber, track: meta.track, playCount: 0,
    ...(fingerprint ? { fingerprint } : {}),
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
  }).run();
  if (albumId) {
    const agg = sqlite.prepare("SELECT COUNT(*) AS cnt, COALESCE(SUM(duration), 0) AS dur FROM songs WHERE album_id = ?").get(albumId) as any;
    db.update(albums).set({ songCount: agg?.cnt ?? 0, duration: agg?.dur ?? 0 }).where(eq(albums.id, albumId)).run();
  }
  if (artistId) {
    const agg = sqlite.prepare("SELECT COUNT(*) AS cnt FROM albums WHERE artist_id = ?").get(artistId) as any;
    db.update(artists).set({ albumCount: agg?.cnt ?? 0 }).where(eq(artists.id, artistId)).run();
  }
  return "added";
}

// Build a change fingerprint from WebDAV props (size + last-modified + etag)
function buildFingerprint(entry: { size: number; lastModified?: string; etag?: string }): string {
  return `${entry.size}|${entry.lastModified || ""}|${entry.etag || ""}`;
}

// Remove albums/artists that no longer have any songs
export function cleanupOrphans() {
  // Albums with no songs (single NOT EXISTS pass instead of one count query per album)
  const deadAlbums = sqlite.prepare(
    "SELECT id FROM albums a WHERE NOT EXISTS (SELECT 1 FROM songs s WHERE s.album_id = a.id)"
  ).all() as { id: string }[];
  if (deadAlbums.length > 0) {
    const ids = deadAlbums.map(a => a.id);
    db.delete(albumArtists).where(inArray(albumArtists.albumId, ids)).run();
    db.delete(albums).where(inArray(albums.id, ids)).run();
  }
  // Artists with no albums (excluding the empty-name placeholder used by online songs)
  const deadArtists = sqlite.prepare(
    "SELECT id FROM artists a WHERE NOT EXISTS (SELECT 1 FROM albums al WHERE al.artist_id = a.id)"
  ).all() as { id: string }[];
  if (deadArtists.length > 0) {
    const ids = deadArtists.map(a => a.id);
    // Songs may still reference the artist (artists are shared across sources) — clear those refs first
    db.update(songs).set({ artistId: null }).where(inArray(songs.artistId, ids)).run();
    db.delete(albumArtists).where(inArray(albumArtists.artistId, ids)).run();
    db.delete(artists).where(inArray(artists.id, ids)).run();
  }
}

export async function scanLocalSource(sourceId: string, config: any, mode: ScanMode, onProgress?: (p: ScanProgress) => void, signal?: AbortSignal) {
  const { path: dirPath } = config;
  if (!fs.existsSync(dirPath)) throw new Error(`路径 ${dirPath} 不存在`);
  const allFiles = scanLocalDir(dirPath);
  const progress: ScanProgress = {
    phase: "scanning", totalDirs: 0, processedDirs: 0,
    totalFiles: allFiles.length, processedFiles: 0, added: 0, updated: 0, skipped: 0, currentTrack: "", mode,
  };
  if (onProgress) onProgress(progress);

  let added = 0, updated = 0, skipped = 0;
  const seenPaths = new Set<string>();
  // Incremental mode: load existing l:<sourceId>:* paths once, then check in memory
  // instead of running one SELECT per file.
  const existingByPath = mode === "incremental"
    ? new Map((sqlite.prepare("SELECT path, fingerprint, size, id FROM songs WHERE path LIKE ?").all(`l:${sourceId}:%`) as any[]).map(s => [s.path, s]))
    : new Map<string, any>();
  for (let i = 0; i < allFiles.length; i++) {
    if (signal?.aborted) break;
    const filePath = allFiles[i];
    const songKey = `l:${sourceId}:${filePath}`;
    seenPaths.add(songKey);
    progress.currentTrack = path.basename(filePath);
    try {
      const stat = fs.statSync(filePath);
      const fp = `${stat.size}|${stat.mtimeMs}`;
      // Incremental: skip if unchanged
      if (mode === "incremental") {
        const existing = existingByPath.get(songKey);
        if (existing) {
          const matches = existing.fingerprint ? existing.fingerprint === fp : (existing.size || 0) === stat.size;
          if (matches) { skipped++; continue; }
        }
      }
      const meta = await extractMetadataLocal(filePath);
      const result = upsertSong(songKey, meta, sourceId, fp);
      if (result === "added") added++;
      else if (result === "updated") updated++;
      else skipped++;
    } catch { skipped++; }
    progress.processedFiles = i + 1;
    progress.added = added;
    progress.updated = updated;
    progress.skipped = skipped;
    if (onProgress) onProgress({ ...progress });
  }

  // Cleanup skipped when aborted (incomplete traversal would delete valid songs)
  if (signal?.aborted) {
    progress.phase = "done";
    progress.currentTrack = "";
    if (onProgress) onProgress({ ...progress });
    return { added, updated, removed: 0, skipped, aborted: true };
  }
  // Fetch only this source's songs via LIKE (instead of loading the whole library)
  const existingSongs = sqlite.prepare("SELECT id, path FROM songs WHERE path LIKE ?").all(`l:${sourceId}:%`) as { id: string; path: string }[];
  let removed = 0;
  const deleteStmt = sqlite.prepare("DELETE FROM songs WHERE id = ?");
  for (const s of existingSongs) {
    if (!seenPaths.has(s.path)) {
      deleteStmt.run(s.id);
      deleteSongLyric(s.id);
      removed++;
    }
  }
  if (removed > 0) cleanupOrphans();
  progress.phase = "done";
  progress.currentTrack = "";
  if (onProgress) onProgress(progress);
  console.log(`[Local] ${mode} scan complete: +${added} ~${updated} -${removed} skip=${skipped}`);
  return { added, updated, removed, skipped };
}
