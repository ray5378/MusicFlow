import { db, sqlite } from "../../db/index.js";
import { songs, albums, artists, mediaSources, albumArtists } from "../../db/schema.js";
import { eq, inArray } from "drizzle-orm";
import { v4 as uuidv4 } from "uuid";
import fs from "fs";
import path from "path";
import { parseBuffer } from "music-metadata";
import { getDataDir } from "../../utils/env.js";
import { deleteSongLyric } from "../lyricsStore.js";
import { deleteAnalysisMany } from "../audio/analysisStore.js";
import { invalidateArtistList } from "../../utils/artistListCache.js";
import { createLogger } from "../../utils/logger.js";
import { songGroupEnabled, groupKeyForConfig, findGroupForSongConfig } from "../plugin/core/songGroup.js";
import { newGroupId, normalizeGroupText } from "../../utils/songGroup.js";

const AUDIO_EXTENSIONS = new Set([".mp3", ".flac", ".wav", ".aac", ".ogg", ".m4a", ".wma", ".ape", ".aiff", ".opus"]);
const HEADER_SIZE = 4 * 1024 * 1024; // 4MB - enough for ID3v2 + embedded cover art
/** WebDAV 分级取头:FLAC 的元数据块(STREAMINFO/VORBIS_COMMENT/PICTURE)紧跟文件头,
 *  实测 25/25 首 256KB 就解析完整;只有超大内嵌封面或异常 PADDING 才需升档。
 *  逐级重试把全库取头流量从固定 4MB/首 降到约 1/16。 */
const HEADER_LADDER = [256 * 1024, 1024 * 1024, 4 * 1024 * 1024];
/** 歌词标签字段名白名单(大小写不敏感):Vorbis Comment 与 ID3 的常见写法。
 *  实测本库只用 LYRICS,但别的抓轨/转码工具可能写 UNSYNCEDLYRICS/SYNCEDLYRICS/LYRIC。 */
const LYRIC_TAG_RE = /^(LYRICS|UNSYNCEDLYRICS|UNSYNCED_?LYRICS|LYRIC|SYNCEDLYRICS|SYNCED_?LYRICS|USLT|SYLT)$/i;
/** 二进制型标签:进 tags JSON 时只留格式/长度,不把 base64 图或整篇歌词塞两遍。 */
const BINARY_TAG_RE = /^(METADATA_BLOCK_PICTURE|COVERART|APIC)$/i;
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
  /** 多值标签折叠成单列的形态(以 "; " 连接),供 songs.album_artist / composer / comment 使用。 */
  albumArtist: string; composer: string; comment: string;
  picture?: { format: string; data: Buffer };
  /** 内嵌歌词标签(ID3 USLT / Vorbis LYRICS 等)的纯文本。
   *  扫描时 metadata 已在内存里被完整解析,取用零额外 IO/网络成本。 */
  lyrics?: string;
  /** 全部原始标签的 JSON(二进制字段只留 format/size);文件头能拿到的标签一个不丢。 */
  tags?: string;
  /** 仅解析失败(回落到文件名推断)时为 true —— WebDAV 据此升档重取更多字节。 */
  incomplete?: boolean;
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
      log.info(`[SCANNER] Scan complete: +${added} ~${updated} -${skipped} (mode=${mode})`);
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
    log.info(`[SCANNER] Scan aborted: +${added} ~${updated} -${skipped} (mode=${mode})`);
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
      // 分级取头:先 256KB,解析不完整(回落到文件名推断)再升 1MB / 4MB。实测 FLAC 的
      // 元数据块全在最前面,256KB 已覆盖 25/25,全库取头流量因此降到固定 4MB 方案的 ~1/16。
      let meta: MusicMetadata | null = null;
      for (let i = 0; i < HEADER_LADDER.length && !meta; i++) {
        const res = await fetchWithRetry(downloadUrl, {
          headers: {
            ...(auth ? { Authorization: auth } : {}),
            Range: `bytes=0-${HEADER_LADDER[i] - 1}`,
          },
        });
        if (!res.ok && res.status !== 206) { skipped++; return; }
        const arrayBuf = await res.arrayBuffer();
        const headerBuf = Buffer.from(arrayBuf);
        const parsed = await extractMetadataHeader(headerBuf, path.basename(href), entry.size);
        // 只有真正解析失败才升档;WAV 这类天生无标签的格式解析本身是成功的,不会白升。
        if (!parsed.incomplete || i === HEADER_LADDER.length - 1) meta = parsed;
      }
      if (!meta) { skipped++; return; }
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
  const removedIds: string[] = [];
  for (const s of existingSongs) {
    if (!seenPaths.has(s.path)) {
      removedIds.push(s.id);
      removed++;
    }
  }
  if (removedIds.length > 0) {
    // P0-6:行删了回写跟删。但仅在源可达时执行 —— 至少一个目录列举成功才说明
    // 这次看到的是"源的真实全貌"而非"源挂了所以啥也没列出来";否则一次源抖动
    // 就会把整库测量值抹掉。探测失败时跳过并记 warning,回写原样保留。
    // 顺序:先回写后歌曲行(audio_analysis.row_id 有 FK 无 CASCADE)。
    if (visited.size > 0) {
      deleteAnalysisMany(removedIds);
      for (const id of removedIds) {
        db.delete(songs).where(eq(songs.id, id)).run();
      }
    } else {
      log.warn(`[SCANNER] WebDAV ${mode} scan: 源 ${sourceId} 本次零目录可达,回写保留(仅删歌曲行)`);
      for (const id of removedIds) {
        db.delete(songs).where(eq(songs.id, id)).run();
      }
    }
  }
  if (removed > 0) cleanupOrphans();

  log.info(`[SCANNER] WebDAV ${mode} scan: +${added} ~${updated} -${removed} skip=${skipped}`);
  return { added, updated, removed, skipped };
}

// Extract metadata from header chunk using music-metadata
export async function extractMetadataHeader(headerBuf: Buffer, fileName: string, fileSize: number): Promise<MusicMetadata> {
  const ext = path.extname(fileName).toLowerCase();
  const nameWithoutExt = path.basename(fileName, ext);
  const fallback = (): MusicMetadata => {
    const parts = nameWithoutExt.split(" - ");
    return {
      title: parts.length > 1 ? parts[1].trim() : nameWithoutExt,
      artist: parts.length > 1 ? parts[0].trim() : "Unknown Artist",
      album: "Unknown Album", duration: 0, bitRate: 0, genre: "", year: 0,
      track: 0, discNumber: 1, contentType: mimeFromExt(ext), suffix: ext.replace(".", ""), size: fileSize,
      albumArtist: "", composer: "", comment: "",
      // 解析失败(头部字节不够 / 结构异常):标记不完整,WebDAV 侧据此升档重取
      incomplete: true,
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

    return {
      title, artist, album, duration, bitRate, genre, year, track, discNumber,
      contentType: mime, suffix: ext.replace(".", ""), size: fileSize,
      albumArtist: joinTags((common as any).albumartist ?? (common as any).albumArtist),
      composer: joinTags(common.composer),
      comment: joinTags(common.comment),
      picture: extractPicture(common),
      lyrics: extractLyricsText(common, metadata.native),
      tags: buildTagsJson(common, metadata.native),
    };
  } catch {
    return fallback();
  }
}

/** 多值标签折叠成单串(以 "; " 连接),供 songs.album_artist / composer / comment 这类单列存储。 */
function joinTags(v: unknown): string {
  if (v == null) return "";
  const arr = Array.isArray(v) ? v : [v];
  return arr
    .map((x) => (typeof x === "string" ? x : String((x as any)?.text ?? "")))
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .join("; ");
}

/** 内嵌歌词提取(纯文本 / 带时间轴文本)。两条来源并用:
 *  ① music-metadata 规范化后的 common.lyrics(ILyricsTag[]{text} 或旧版 string[]);
 *  ② native 原始标签兜底 —— Vorbis Comment 的 LYRICS / UNSYNCEDLYRICS / SYNCEDLYRICS / LYRIC、
 *     ID3 的 USLT / SYLT,凡是规范化没映射到的字段名都能捞回来。
 *  去重后**带 [mm:ss] 时间轴的优先**,否则用纯文本;全空返回 undefined(保持 NULL 语义)。 */
function extractLyricsText(common: any, native?: any): string | undefined {
  const parts: string[] = [];
  const raw = common?.lyrics;
  for (const item of Array.isArray(raw) ? raw : raw ? [raw] : []) {
    const t = typeof item === "string" ? item : item?.text;
    if (typeof t === "string" && t.trim().length > 0) parts.push(t);
  }
  for (const list of Object.values((native || {}) as Record<string, any[]>)) {
    for (const t of list || []) {
      if (!LYRIC_TAG_RE.test(String(t?.id ?? ""))) continue;
      const v = t?.value;
      const text = typeof v === "string" ? v : (v?.text ?? "");
      if (typeof text === "string" && text.trim().length > 0) parts.push(text);
    }
  }
  if (parts.length === 0) return undefined;
  const uniq = [...new Set(parts.map((p) => p.trim()))];
  const timed = uniq.filter((p) => /\[\d{1,2}:\d{2}/.test(p));
  return (timed.length > 0 ? timed : uniq).join("\n\n");
}

/** 全部原始标签 -> JSON:common 的规范化结果与 native 的原始字段名都保留,冷门标签不再丢。
 *  二进制类(内嵌封面 base64、歌词正文)与超长值只留长度,避免与 songs.cover_art / lyrics 双份存储。 */
function buildTagsJson(common: any, native?: any): string | undefined {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries((common || {}) as Record<string, any>)) {
    if (v == null || v === "" || (Array.isArray(v) && v.length === 0)) continue;
    if (k === "picture") {
      out.picture = (v as any[]).map((p) => ({ format: p?.format, size: p?.data?.length ?? 0 }));
    } else if (k === "lyrics") {
      out.lyrics = (v as any[]).map((l) =>
        typeof l === "string"
          ? { textLength: l.length }
          : { contentType: l?.contentType, language: l?.language, descriptor: l?.descriptor, textLength: String(l?.text ?? "").length });
    } else {
      out[k] = v;
    }
  }
  const nat: Record<string, unknown> = {};
  for (const [tagType, list] of Object.entries((native || {}) as Record<string, any[]>)) {
    for (const t of list || []) {
      const id = String(t?.id ?? "");
      if (!id) continue;
      const rawValue = t?.value;
      const asText = typeof rawValue === "string" ? rawValue : JSON.stringify(rawValue ?? null);
      // Vorbis 的字段名本身已大写且唯一,直接用作 key;其它格式加前缀避免同名覆盖。
      const key = tagType === "vorbis" ? id : `${tagType}:${id}`;
      if (BINARY_TAG_RE.test(id)) nat[key] = `[binary ${asText.length}]`;
      else if (LYRIC_TAG_RE.test(id)) nat[key] = `[lyrics ${asText.length}]`;
      else nat[key] = asText.length > 1000 ? `[${asText.length} chars]` : rawValue;
    }
  }
  if (Object.keys(nat).length > 0) out.native = nat;
  return Object.keys(out).length > 0 ? JSON.stringify(out) : undefined;
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
      albumArtist: joinTags((common as any).albumartist ?? (common as any).albumArtist),
      composer: joinTags(common.composer),
      comment: joinTags(common.comment),
      picture: extractPicture(common),
      lyrics: extractLyricsText(common, metadata.native),
      tags: buildTagsJson(common, metadata.native),
    };
  } catch {
    const parts = nameWithoutExt.split(" - ");
    return {
      title: parts.length > 1 ? parts[1].trim() : nameWithoutExt,
      artist: parts.length > 1 ? parts[0].trim() : "Unknown Artist",
      album: "Unknown Album", duration: 0, bitRate: 0, genre: "", year: 0,
      track: 0, discNumber: 1, contentType: mimeFromExt(ext), suffix: ext.replace(".", ""), size: stat.size,
      albumArtist: "", composer: "", comment: "", incomplete: true,
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
  invalidateArtistList();
  return id;
}

function findOrCreateAlbum(name: string, artistId: string, artistName: string, year: number, picture?: { format: string; data: Buffer }, genre?: string): string {
  if (!name || name === "Unknown Album") return "";
  const existing = db.select().from(albums).where(eq(albums.name, name)).get();
  if (existing) {
    // 存量专辑补写:封面(老库里没有封面抽取的年代建的)与流派(albums.genre 此前从未被写过)。
    const patch: Partial<{ coverArt: string; genre: string; updatedAt: string }> = {};
    if (!existing.coverArt && picture) {
      const coverRef = saveCoverArt(existing.id, picture);
      if (coverRef) patch.coverArt = coverRef;
    }
    if (!existing.genre && genre) patch.genre = genre;
    if (Object.keys(patch).length > 0) {
      db.update(albums).set({ ...patch, updatedAt: new Date().toISOString() }).where(eq(albums.id, existing.id)).run();
    }
    return existing.id;
  }
  const id = uuidv4();
  const coverRef = saveCoverArt(id, picture);
  db.insert(albums).values({ id, name, artistId, artist: artistName, year, genre: genre || "", coverArt: coverRef, songCount: 0, duration: 0, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }).run();
  return id;
}

/**
 * 本地/WebDAV 歌曲归组(与 web 导入同规则,来源无关):按插件配置计算分组 key
 * (规范化标题+歌手+专辑,albumRequired 可关),查全库候选,时长命中
 * (durationTolerance,默认 ±1s)并入已有组,否则新建组。
 * 插件关闭或标题歌手皆空时不归组(NULL)。
 */
export function resolveLocalGroup(meta: MusicMetadata): { groupId: string; groupKey: string } | null {
  const nt = normalizeGroupText(meta.title);
  const na = normalizeGroupText(meta.artist || "");
  if (!nt && !na) return null;
  const groupKey = groupKeyForConfig(meta.title, meta.artist, meta.album);
  try {
    const candidates = sqlite.prepare(
      "SELECT id, group_id, duration FROM songs WHERE group_key = ?"
    ).all(groupKey) as { id: string; groupId: string | null; duration: number | null }[];
    const groupId = findGroupForSongConfig(candidates, meta.duration || null) ?? newGroupId();
    return { groupId, groupKey };
  } catch {
    return { groupId: newGroupId(), groupKey };
  }
}

export function upsertSong(songPath: string, meta: MusicMetadata, sourceId: string, fingerprint?: string): "added" | "updated" | "skip" {
  const existing = db.select().from(songs).where(eq(songs.path, songPath)).get();
  const artistId = findOrCreateArtist(meta.artist) || null;
  const albumId = findOrCreateAlbum(meta.album, artistId || "", meta.artist, meta.year, meta.picture, meta.genre) || null;
  if (existing) {
    // 同曲多源归组:已分组行保持组不变;历史 NULL 组行(归组启用前/插件关闭期
    // 扫入的存量)在元数据更新时顺带补组,与 web 导入同规则。
    const backfill = !existing.groupId && songGroupEnabled() ? resolveLocalGroup(meta) : null;
    db.update(songs).set({
      title: meta.title, artist: meta.artist, artistId, album: meta.album, albumId,
      duration: meta.duration, bitRate: meta.bitRate, contentType: meta.contentType,
      suffix: meta.suffix, size: meta.size, genre: meta.genre,
      discNumber: meta.discNumber, track: meta.track,
      // 文件头标签以文件为权威源,扫描即刷新。
      year: meta.year || 0, albumArtist: meta.albumArtist || "", composer: meta.composer || "",
      comment: meta.comment || "",
      ...(meta.tags ? { tags: meta.tags } : {}),
      // 内嵌歌词是唯一例外:只在库内尚无歌词时补写 —— 已有歌词(在线回填的时间轴 LRC /
      // 之前扫描写入)不被覆盖,避免用纯文本标签顶掉带时间轴的 LRC。
      ...(meta.lyrics && !existing.lyrics ? { lyrics: meta.lyrics } : {}),
      updatedAt: new Date().toISOString(),
      ...(backfill ? { groupId: backfill.groupId, groupKey: backfill.groupKey } : {}),
      ...(fingerprint ? { fingerprint } : {}),
    }).where(eq(songs.id, existing.id)).run();
    return "updated";
  }
  // 同曲多源归组(与 web 导入一致,受 core-song-group 插件开关门控):命中已有组
  // 并入,否则新建;插件关闭时 NULL 平铺。
  const group = songGroupEnabled() ? resolveLocalGroup(meta) : null;
  const songId = uuidv4();
  db.insert(songs).values({
    id: songId, title: meta.title, artist: meta.artist, artistId, album: meta.album, albumId,
    duration: meta.duration, bitRate: meta.bitRate, contentType: meta.contentType,
    suffix: meta.suffix, path: songPath, size: meta.size, genre: meta.genre,
    discNumber: meta.discNumber, track: meta.track, playCount: 0,
    // 文件头能拿到的标签全部入库:歌词直接落列(纯文本或带时间轴),
    // 冷门标签进 tags JSON;入库后这首歌的批量回填(lyrics IS NULL)会自动跳过。
    lyrics: meta.lyrics ?? null,
    year: meta.year || 0, albumArtist: meta.albumArtist || "", composer: meta.composer || "",
    comment: meta.comment || "", tags: meta.tags ?? null,
    ...(group ? { groupId: group.groupId, groupKey: group.groupKey } : {}),
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
    invalidateArtistList();
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
    invalidateArtistList();
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
  const removedIds: string[] = [];
  const deleteStmt = sqlite.prepare("DELETE FROM songs WHERE id = ?");
  for (const s of existingSongs) {
    if (!seenPaths.has(s.path)) {
      removedIds.push(s.id);
      removed++;
    }
  }
  // P0-6:本地源走到这里=目录存在且完整遍历过(缺目录早抛错、中断早返回),
  // 源可达成立,回写跟删。顺序:先回写后歌曲行(FK 无 CASCADE)。
  if (removedIds.length > 0) {
    deleteAnalysisMany(removedIds);
    for (const s of existingSongs) {
      if (!seenPaths.has(s.path)) {
        deleteStmt.run(s.id);
        deleteSongLyric(s.id);
      }
    }
  }
  if (removed > 0) cleanupOrphans();
  progress.phase = "done";
  progress.currentTrack = "";
  if (onProgress) onProgress(progress);
  log.info(`[Local] ${mode} scan complete: +${added} ~${updated} -${removed} skip=${skipped}`);
  return { added, updated, removed, skipped };
}
