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
import { recoverUnknownTags, isUnknownAlbum } from "./tagRecovery.js";
import { songGroupEnabled, groupKeyForConfig, findGroupForSongConfig } from "../plugin/core/songGroup.js";
import { newGroupId, normalizeGroupText } from "../../utils/songGroup.js";
import { buildSmbConfig, normalizeSmbPath, smbReaddir, smbReadRange, type SmbEntry } from "./smbClient.js";

const AUDIO_EXTENSIONS = new Set([".mp3", ".flac", ".wav", ".aac", ".ogg", ".m4a", ".wma", ".ape", ".aiff", ".opus"]);
const HEADER_SIZE = 4 * 1024 * 1024; // 4MB - enough for ID3v2 + embedded cover art
/** WebDAV 分级取头:FLAC 的元数据块(STREAMINFO/VORBIS_COMMENT/PICTURE)紧跟文件头,
 *  实测 25/25 首 256KB 就解析完整;只有超大内嵌封面或异常 PADDING 才需升档。
 *  逐级重试把全库取头流量从固定 4MB/首 降到约 1/16。 */
// 分级取头:先 256KB,判不完整再升 1MB / 4MB。上限是「流量」与「覆盖」的折中。
//
// ⚠️ 这里只是**第一道**手段,不是万能:FLAC 的元数据块顺序是
//    STREAMINFO → (PICTURE 封面,实测 4~8MB) → VORBIS_COMMENT(真正的标签)。
// 封面一旦超过上限,标签就永远落在取头区间之外 —— 2026-11 的线上事故正是如此:
// SMB 源 1257 首落成 Unknown Artist / Unknown Album,而同一个文件在本地(走
// parseFile 随机读)完全正常。所以「取头到顶仍不完整」时必须再走
// readFlacTagsByBlocks() 按块头跳读,**不要靠继续加大这个固定上限**:
// 4MB→16MB 只会把每个文件的取头流量放大 4 倍,而且下次遇到更大的封面照样失效。
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
  /** 仅「无需变更」——增量指纹未变 / upsert 判定无需改动。 */
  skipped: number;
  /** 真正失败:下载非 2xx、解析或入库抛异常。与 skipped 分开,避免「跳过」掩盖故障。 */
  failed: number;
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
    totalFiles: 0, processedFiles: 0, added: 0, updated: 0, skipped: 0, failed: 0, currentTrack: "", mode,
  };
  if (onProgress) onProgress(progress);

  const dirQueue: { url: string; attempts: number }[] = [{ url: baseUrl + "/", attempts: 0 }];
  const fileQueue: PropfindEntry[] = [];
  const visited = new Set<string>();
  const seenPaths = new Set<string>();
  const MAX_DIR_ATTEMPTS = 4;

  let added = 0, updated = 0, skipped = 0, failed = 0;
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
      log.info(`[SCANNER] Scan complete: +${added} ~${updated} -${skipped} fail=${failed} (mode=${mode})`);
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
    log.info(`[SCANNER] Scan aborted: +${added} ~${updated} -${skipped} fail=${failed} (mode=${mode})`);
    doneResolve();
  };
  if (signal) {
    if (signal.aborted) { abortScan(); return { added: 0, updated: 0, removed: 0, skipped: 0, failed: 0, aborted: true }; }
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
        if (!res.ok && res.status !== 206) {
          // 下载失败是「异常」不是「无需变更」——分开计数并留一条可检索的 debug。
          failed++;
          log.debug(`[SCANNER] 取头失败 HTTP ${res.status}: ${href}`);
          return;
        }
        const arrayBuf = await res.arrayBuffer();
        const headerBuf = Buffer.from(arrayBuf);
        const parsed = await extractMetadataHeader(headerBuf, path.basename(href), entry.size);
        // 只有真正解析失败才升档;WAV 这类天生无标签的格式解析本身是成功的,不会白升。
        if (!parsed.incomplete || i === HEADER_LADDER.length - 1) meta = parsed;
      }
      // 分级取头到顶仍判不完整且是 FLAC:大概率是「大封面 + 标签在后」,按块跳读精确取。
      if (meta?.incomplete && path.extname(href).toLowerCase() === ".flac") {
        const synth = await readFlacTagsByBlocks(async (start, end) => {
          const res = await fetchWithRetry(downloadUrl, {
            headers: { ...(auth ? { Authorization: auth } : {}), Range: `bytes=${start}-${end}` },
          });
          return res.ok || res.status === 206 ? Buffer.from(await res.arrayBuffer()) : Buffer.alloc(0);
        }, entry.size);
        if (synth) {
          const precise = await extractMetadataHeader(synth, path.basename(href), entry.size);
          if (!precise.incomplete) meta = precise;
        }
      }
      if (!meta) { skipped++; return; }
      if (meta.incomplete) {
        // 升到顶(4MB)仍解析不出标签 —— 此前完全静默,现在留一条可检索的 warn。
        log.warn(`[SCANNER] ${path.basename(href)} 取头升到 ${HEADER_LADDER[HEADER_LADDER.length - 1] / 1024 / 1024}MB 仍解析不出标签,元数据回落文件名推断`);
      }
      const result = upsertSong(songPath, meta, sourceId, mode === "incremental" ? buildFingerprint(entry) : undefined);
      if (result === "added") added++;
      else updated++;
    } catch (e: any) {
      // 解析 / 入库抛异常属缺陷面:计入 failed 并带路径与原因告警,不再静默吞掉。
      failed++;
      log.warn(`[SCANNER] 入库失败 ${href}`, { err: e?.message || String(e) });
    }
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
        progress.failed = failed;
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
  if (signal?.aborted) return { added, updated, removed: 0, skipped, failed, aborted: true };
  const existingSongs = db.select().from(songs).all().filter(s => s.path.startsWith(`w:${sourceId}:`));
  let removed = 0;
  const removedIds: string[] = [];
  for (const s of existingSongs) {
    if (!seenPaths.has(s.path)) removedIds.push(s.id);
  }
  if (removedIds.length > 0) {
    // 第二道安全阀:一次扫描要删掉半数以上曲目,几乎一定是「遍历提前结束 /
    // 部分目录没列到」,而不是用户真的删了一半文件。宁可留下旧行等下次核对,
    // 也不能把曲库清空(实测一次中断的增量为「-16360」)。
    if (existingSongs.length > 50 && removedIds.length > existingSongs.length * 0.5) {
      log.warn(`[SCANNER] WebDAV ${mode} scan: 待删 ${removedIds.length}/${existingSongs.length} 超过半数,疑似遍历不完整,本次不删除`);
      return { added, updated, removed: 0, skipped, failed };
    }
    // P0-6:只有「至少一个目录列举成功」才说明这次看到的是源的真实全貌。
    // 零目录可达 = 源整体不可达(网络抖动 / 远端重启)的最强信号,此时既不能抹
    // 测量回写,更不能删歌曲行 —— 否则一次瞬断就把整个 WebDAV 源从曲库抹掉,
    // 用户立刻看到歌单变空、封面 404、群组队列失效。整体跳过删除,等下一次
    // 成功扫描自然校正;removed 如实报 0,不谎报"已回收"。
    // 顺序(可达分支):先回写后歌曲行(audio_analysis.row_id 有 FK 无 CASCADE)。
    if (visited.size > 0) {
      deleteAnalysisMany(removedIds);
      for (const id of removedIds) {
        db.delete(songs).where(eq(songs.id, id)).run();
      }
      removed = removedIds.length;
    } else {
      log.warn(`[SCANNER] WebDAV ${mode} scan: 源 ${sourceId} 本次零目录可达 -> 判定源整体不可达,不删除任何行(保留 ${removedIds.length} 首待下次成功扫描核对)`);
    }
  }
  if (removed > 0) cleanupOrphans();

  log.info(`[SCANNER] WebDAV ${mode} scan: +${added} ~${updated} -${removed} skip=${skipped} fail=${failed}`);
  return { added, updated, removed, skipped, failed };
}

// ==================== SMB ====================
//
// 与 WebDAV 完全同构(目录队列 + 文件队列 + 分级取头 + 增量指纹 + 清理消失行)，
// 差别只在“怎么读”：
//   - 列目录用 SMB readdir(stats) 一次拿到 size/mtime/是否目录(WebDAV 要解析 XML)；
//   - 取头用 SMB 文件流读区间(WebDAV 用 HTTP Range)；
//   - 没有 etag，增量指纹用 size|mtime。
// 并发刻意压低(SMB 服务器常限制同账号并发连接/句柄，不能照抄 WebDAV 的 10/8)。
const SMB_DIR_CONCURRENCY = 4;
const SMB_FILE_CONCURRENCY = 3;

export async function scanSmbSource(
  sourceId: string,
  config: any,
  mode: ScanMode,
  onProgress?: (p: ScanProgress) => void,
  signal?: AbortSignal,
) {
  const cfg = buildSmbConfig(config);
  if (!cfg) throw new Error("SMB 配置不完整(缺少 host/share)");

  const progress: ScanProgress = {
    phase: "traverse", totalDirs: 0, processedDirs: 0,
    totalFiles: 0, processedFiles: 0, added: 0, updated: 0, skipped: 0, failed: 0, currentTrack: "", mode,
  };
  if (onProgress) onProgress(progress);

  const dirQueue: { path: string; attempts: number }[] = [{ path: normalizeSmbPath(cfg.root_path), attempts: 0 }];
  const fileQueue: SmbEntry[] = [];
  const visited = new Set<string>();
  const seenPaths = new Set<string>();
  const MAX_DIR_ATTEMPTS = 3;

  let added = 0, updated = 0, skipped = 0, failed = 0;
  let activeDirs = 0, activeFiles = 0;
  let discoveredFiles = 0;
  let doneResolve: () => void;
  const done = new Promise<void>((r) => (doneResolve = r));
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
      log.info(`[SCANNER] SMB scan complete: +${added} ~${updated} -${skipped} fail=${failed} (mode=${mode})`);
      doneResolve();
    }
  };

  const abortScan = () => {
    if (finished) return;
    finished = true;
    progress.phase = "done";
    progress.currentTrack = "";
    progress.totalFiles = discoveredFiles;
    emitProgress();
    log.info(`[SCANNER] SMB scan aborted: +${added} ~${updated} -${skipped} fail=${failed} (mode=${mode})`);
    doneResolve();
  };
  if (signal) {
    if (signal.aborted) { abortScan(); return { added: 0, updated: 0, removed: 0, skipped: 0, failed: 0, aborted: true }; }
    signal.addEventListener("abort", abortScan, { once: true });
  }

  const processFile = async (entry: SmbEntry) => {
    const songPath = `s:${sourceId}:${entry.path}`;
    seenPaths.add(songPath);

    // 增量：size+mtime 未变就跳过(SMB 没有 etag)。
    const fp = `${entry.size}|${entry.mtimeMs}`;
    if (mode === "incremental") {
      const existing = db.select().from(songs).where(eq(songs.path, songPath)).get();
      if (existing) {
        const storedFp = existing.fingerprint || "";
        const matches = storedFp ? storedFp === fp : (existing.size || 0) === entry.size;
        // 指纹一致但标签是空的(Unknown Artist/空 artist):历史上有过取头读到空 buffer
        // 的版本,把这类行落成了文件名推断。坑已经修好,但指纹没变会被永久跳过,
        // 所以这里对「标签缺失」的行强制重解析一次。文件本身没变,重读很便宜。
        const tagsMissing = !existing.artist || existing.artist === "Unknown Artist";
        // 曾经被坏标签写进来的行,group_key 里还留着 unknown artist/album ——
        // 歌手已修正但分组没跟上的,也要再解析一次,让 upsert 重算并并入正确的组。
        const staleGroupKey = !!existing.groupKey && existing.groupKey.includes("unknown artist");
        if (matches && !tagsMissing && !staleGroupKey) { skipped++; return; }
      }
    }

    progress.currentTrack = entry.name;
    emitProgress();
    try {
      if (entry.size <= 0) { skipped++; return; }
      let meta: MusicMetadata | null = null;
      for (let i = 0; i < HEADER_LADDER.length && !meta; i++) {
        const end = Math.min(HEADER_LADDER[i], entry.size) - 1;
        if (end < 0) break;
        const headerBuf = await smbReadRange(sourceId, cfg, entry.path, 0, end);
        const parsed = await extractMetadataHeader(headerBuf, entry.name, entry.size);
        if (!parsed.incomplete || i === HEADER_LADDER.length - 1) meta = parsed;
      }
      // 同 WebDAV:大封面把标签顶到 4MB 之后时,按 FLAC 块头跳读精确取标签。
      if (meta?.incomplete && path.extname(entry.name).toLowerCase() === ".flac") {
        const synth = await readFlacTagsByBlocks(
          (start, end) => smbReadRange(sourceId, cfg, entry.path, start, end),
          entry.size,
        );
        if (synth) {
          const precise = await extractMetadataHeader(synth, entry.name, entry.size);
          if (!precise.incomplete) meta = precise;
        }
      }
      if (!meta) { skipped++; return; }
      if (meta.incomplete) {
        log.warn(`[SCANNER] ${entry.name} 取头升到 ${HEADER_LADDER[HEADER_LADDER.length - 1] / 1024 / 1024}MB 仍解析不出标签,元数据回落文件名推断`);
      }
      const result = upsertSong(songPath, meta, sourceId, mode === "incremental" ? fp : undefined);
      if (result === "added") added++;
      else updated++;
    } catch (e: any) {
      failed++;
      log.warn(`[SCANNER] SMB 入库失败 ${entry.path}`, { err: e?.message || String(e) });
    }
  };

  const processDir = async (item: { path: string; attempts: number }) => {
    const dirPath = normalizeSmbPath(item.path);
    if (visited.has(dirPath)) return;
    try {
      const list = await smbReaddir(sourceId, cfg, dirPath);
      visited.add(dirPath);
      for (const e of list) {
        if (e.isDirectory) {
          if (!visited.has(e.path)) dirQueue.push({ path: e.path, attempts: 0 });
        } else if (AUDIO_EXTENSIONS.has(path.extname(e.name).toLowerCase())) {
          fileQueue.push(e);
          discoveredFiles++;
        }
      }
    } catch (e: any) {
      if (item.attempts < MAX_DIR_ATTEMPTS) {
        await sleep(400 * (item.attempts + 1) + Math.floor(Math.random() * 200));
        dirQueue.push({ path: item.path, attempts: item.attempts + 1 });
      } else {
        log.warn(`[SCANNER] SMB 列目录失败 ${item.path}`, { err: e?.message || String(e) });
      }
    }
  };

  const pumpDirs = () => {
    while (activeDirs < SMB_DIR_CONCURRENCY && dirQueue.length > 0) {
      if (signal?.aborted) break;
      const item = dirQueue.shift()!;
      if (visited.has(normalizeSmbPath(item.path))) continue;
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
    while (activeFiles < SMB_FILE_CONCURRENCY && fileQueue.length > 0) {
      if (signal?.aborted) break;
      const entry = fileQueue.shift()!;
      activeFiles++;
      processFile(entry).finally(() => {
        activeFiles--;
        progress.processedFiles++;
        progress.added = added;
        progress.updated = updated;
        progress.skipped = skipped;
        progress.failed = failed;
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

  if (signal?.aborted) return { added, updated, removed: 0, skipped, failed, aborted: true };

  // 清理：本次没再出现的行 = 源里已删。零目录可达时判定源整体不可达，不删(与 WebDAV 同口径)。
  const existingSongs = db.select().from(songs).all().filter((s) => s.path.startsWith(`s:${sourceId}:`));
  const removedIds: string[] = [];
  for (const s of existingSongs) {
    if (!seenPaths.has(s.path)) removedIds.push(s.id);
  }
  let removed = 0;
  if (removedIds.length > 0) {
    // 与 WebDAV 同口径的防误删:一次删掉半数以上 = 遍历不完整,不是用户删了歌。
    if (existingSongs.length > 50 && removedIds.length > existingSongs.length * 0.5) {
      log.warn(`[SCANNER] SMB ${mode} scan: 待删 ${removedIds.length}/${existingSongs.length} 超过半数,疑似遍历不完整,本次不删除`);
      return { added, updated, removed: 0, skipped, failed };
    }
    if (visited.size > 0) {
      deleteAnalysisMany(removedIds);
      for (const id of removedIds) db.delete(songs).where(eq(songs.id, id)).run();
      removed = removedIds.length;
    } else {
      log.warn(`[SCANNER] SMB ${mode} scan: 源 ${sourceId} 本次零目录可达 -> 判定源整体不可达,不删除任何行(保留 ${removedIds.length} 首待下次成功扫描核对)`);
    }
  }
  if (removed > 0) cleanupOrphans();

  log.info(`[SCANNER] SMB ${mode} scan: +${added} ~${updated} -${removed} skip=${skipped} fail=${failed}`);
  return { added, updated, removed, skipped, failed };
}

// Extract metadata from header chunk using music-metadata
/**
 * 无损容器的码率不信任 format.bitrate：music-metadata 对「截断头部 buffer」解析出的
 * bitrate 是按**到手字节/时长**估算的（WebDAV 分级取头 256KB 头 ÷ 4 分钟 flac ≈ 8kbps 级
 * 垃圾值；240 实测 49,358 首 flac 库值平均只有真实值 1/202）。这些容器的真实码率应由
 * size*8/duration 现场换算（与 fetch/upgrade.ts 的 upgradeBaselineKbps 同口径）。
 */
const LOSSLESS_SIZE_BITRATE_EXTS = new Set([".flac", ".wav", ".ape", ".aiff", ".aif", ".wv"]);

/**
 * 从「文件头部字节」解析标签(WebDAV / SMB 共用;本地源走 parseFile 随机读,不用这里)。
 *
 * ── 接入新源 / 新格式时必读(踩过的坑)────────────────────────────────
 * 1) 「解析出 duration」≠「标签完整」。
 *    FLAC 的 STREAMINFO 在文件最前 34 字节,任何 256KB 的头都能算出时长;
 *    但 VORBIS_COMMENT 可能排在 4~8MB 的 PICTURE 之后。若把 hasAudioInfo 当作
 *    「完整」判据,分级取头会在第一档就停,结果 title=文件名、artist=Unknown Artist,
 *    且日志只有一条「仍解析不出标签」的 warn,极易被忽略。
 *    → 判据必须按容器区分:FLAC 以「有没有标签」为准(见下方 tagsMayFollowAudio)。
 *
 * 2) 到顶仍不完整时,按块头跳读,而不是加大固定上限。
 *    readFlacTagsByBlocks() 只读 4 字节块头逐块跳过 PICTURE,再精确取 STREAMINFO /
 *    VORBIS_COMMENT,拼成元数据块合成体交给解析器:流量几 KB、与封面大小无关。
 *    新增容器(如 APE / WV)出现同类问题时,照这个模式加跳读,不要改 HEADER_LADDER。
 *
 * 3) 三处调用要保持同一口径:
 *    · WebDAV(scanWebdavSource) 与 SMB(scanSmbSource) 共用本函数与 HEADER_LADDER;
 *    · 本地源(localSourceProbe / parseFile)有随机访问能力,不受头部长度的限制;
 *    · 因此修这类问题要同时检查 webdav/smb 两条链路,只改一侧会留下同源缺陷。
 *
 * 4) 判定「不完整」后,调用方必须真的升档或跳读;直接把 incomplete 结果入库,
 *    就会得到一条「有正确时长、但歌手/专辑是 Unknown」的脏数据。
 * ────────────────────────────────────────────────────────────────
 */
export async function extractMetadataHeader(headerBuf: Buffer, fileName: string, fileSize: number): Promise<MusicMetadata> {
  const ext = path.extname(fileName).toLowerCase();
  const nameWithoutExt = path.basename(fileName, ext);
  // .wav 天生只有 PCM 头、没有标签块 —— 任何「升档重取更大区间」都不可能拿到标签,
  // 所以它既不该被判不完整,也不该触发升档(否则每个 WAV 白取 3 次头)。
  // 判据只在这里定义一次,宽容解析路径与 fallback 路径共用。
  const inherentlyTagless = ext === ".wav";
  const fallback = (): MusicMetadata => {
    const parts = nameWithoutExt.split(" - ");
    return {
      title: parts.length > 1 ? parts[1].trim() : nameWithoutExt,
      artist: parts.length > 1 ? parts[0].trim() : "Unknown Artist",
      album: "Unknown Album", duration: 0, bitRate: 0, genre: "", year: 0,
      track: 0, discNumber: 1, contentType: mimeFromExt(ext), suffix: ext.replace(".", ""), size: fileSize,
      albumArtist: "", composer: "", comment: "",
      // 解析失败(头部字节不够 / 结构异常):标记不完整,WebDAV 侧据此升档重取。
      // 天生无标签的格式除外 —— 升档也拿不到标签,白费流量。
      ...(inherentlyTagless ? {} : { incomplete: true as const }),
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
    // 无损容器：截断头解析出的 format.bitrate 是「到手字节/时长」的估算垃圾值，
    // duration 来自 STREAMINFO 等结构头、fileSize 是真实大小，两者可信 → 现场换算。
    if (LOSSLESS_SIZE_BITRATE_EXTS.has(ext) && duration > 0) {
      bitRate = Math.round((fileSize * 8) / duration / 1000);
    }

    const tags = buildTagsJson(common, metadata.native);
    const lyrics = extractLyricsText(common, metadata.native);
    // 第二重完整性判据:解析「没抛错」不等于「拿到了东西」。music-metadata 对
    // 截断 / 垃圾字节是宽容的 —— 不抛错,而是 resolve 一个**占位**结果
    // (实测 v11.14.0:common 里连 track/disk/movementIndex 这种全 null 的壳都会给,
    //  format 只有 {"tagTypes":[],"trackInfo":[],"hasAudio":false})。
    // 所以既不能只看「有没有抛错」,也不能只看 common 是否为空 —— 后者会让
    // buildTagsJson 吐出一串全 null 的壳,判据恒假,256KB→1MB→4MB 分级取头永不升档,
    // 带大标签块 / 大封面的文件的元数据会静默退化成文件名推断。
    // 看「到底拿到了什么」:
    //   · 有标签(或 title/artist/album)⇒ 完整;
    //   · 读出了音频结构(duration / bitRate)⇒ 也完整 —— 只是天生没打标签,
    //     再取多大区间都不会有标签,升档纯属浪费流量;
    //   · 两者皆无 ⇒ 头部区间不够,判为不完整,交调用方升档重取。
    // (tags 已由 buildTagsJson 滤掉全 null 的占位壳,故 !!tags 是可信的「有标签」信号)
    const hasTags = !!tags || !!common.title || !!common.artist || !!common.album;
    const hasAudioInfo = duration > 0 || bitRate > 0;
    // FLAC 的 STREAMINFO 在最前面,解析出时长只能证明「读到了音频结构」——
    // VORBIS_COMMENT 却可能排在几 MB 的封面块之后。实测库里的
    // `Adventure of a Lifetime - Coldplay.flac`(封面 1.59MB):256KB 头已能拿到
    // dur=251,但 artist 仍是 Unknown;旧判据因此认为「完整」不再升档,
    // 全库约 4.6% 的歌就这样落成了 Unknown Artist / Unknown Album。
    // 所以 FLAC 必须以「有没有标签」为唯一判据,没标签就继续升档(256KB→1MB→4MB)。
    const tagsMayFollowAudio = ext === ".flac";
    const incomplete = !inherentlyTagless && !hasTags && (tagsMayFollowAudio || !hasAudioInfo);
    return {
      title, artist, album, duration, bitRate, genre, year, track, discNumber,
      contentType: mime, suffix: ext.replace(".", ""), size: fileSize,
      albumArtist: joinTags((common as any).albumartist ?? (common as any).albumArtist),
      composer: joinTags(common.composer),
      comment: joinTags(common.comment),
      picture: extractPicture(common),
      lyrics,
      tags,
      ...(incomplete ? { incomplete: true as const } : {}),
    };
  } catch {
    return fallback();
  }
}


/**
 * FLAC 大封面场景的精确取标签：标签块(VORBIS_COMMENT)排在几 MB 的 PICTURE 之后时,
 * 固定上限的头部读取永远够不到(实测封面 4~8MB,库里 1257 首因此落成 Unknown)。
 * 这里只读 4 字节块头逐块跳读,定位 STREAMINFO / VORBIS_COMMENT,再精确取这两块,
 * 拼成一个「只有元数据块」的合法 FLAC 交给解析器 —— 流量几 KB,与封面大小无关。
 *
 * 说明:合成流不含 PICTURE,所以这类歌的封面不会入库(相对 4~8MB 的正文体积,这是
 * 有意的取舍);时长/码率仍由 STREAMINFO 正常给出。
 */
async function readFlacTagsByBlocks(
  readRange: (start: number, end: number) => Promise<Buffer>,
  fileSize: number,
): Promise<Buffer | null> {
  const magic = await readRange(0, 3);
  if (magic.length < 4 || magic.toString("latin1") !== "fLaC") return null;
  let off = 4;
  let streamInfo: Buffer | null = null;
  let vorbis: Buffer | null = null;
  let guard = 0;
  while (off + 4 <= fileSize && guard++ < 64) {
    const h = await readRange(off, off + 3);
    if (h.length < 4) break;
    const last = (h[0] & 0x80) !== 0;
    const type = h[0] & 0x7f;
    const len = (h[1] << 16) | (h[2] << 8) | h[3];
    if (len < 0 || off + 4 + len > fileSize) break;
    if (type === 0) {
      streamInfo = await readRange(off + 4, off + 4 + len - 1);
    } else if (type === 4) {
      vorbis = await readRange(off + 4, off + 4 + len - 1);
      break;
    }
    if (last) break;
    off += 4 + len; // 关键:跳过 PICTURE 等大块,不读正文
  }
  if (!streamInfo || !vorbis) return null;
  const hdr = (last: number, len: number) =>
    Buffer.from([(last ? 0x80 : 0) | 0, (len >> 16) & 0xff, (len >> 8) & 0xff, len & 0xff]);
  return Buffer.concat([
    Buffer.from("fLaC", "latin1"),
    hdr(0, streamInfo.length),
    streamInfo,
    Buffer.from([0x84, (vorbis.length >> 16) & 0xff, (vorbis.length >> 8) & 0xff, vorbis.length & 0xff]),
    vorbis,
  ]);
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
/**
 * 该标签值是否「什么都没承载」。
 * music-metadata 即便一个标签都没解析出来,也会给 track / disk / movementIndex
 * 这类字段全为 null 的结构占位对象 —— 它们不是标签,不该进 songs.tags,更不该被
 * 当作「拿到了标签」而使扫描器的升档判据失效。
 */
function isValuelessTag(v: unknown): boolean {
  if (v == null || v === "") return true;
  if (Array.isArray(v)) return v.length === 0;
  if (typeof v === "object") {
    const vals = Object.values(v as Record<string, unknown>);
    return vals.length === 0 || vals.every(isValuelessTag);
  }
  return false;
}

function buildTagsJson(common: any, native?: any): string | undefined {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries((common || {}) as Record<string, any>)) {
    if (isValuelessTag(v)) continue;
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

// 导出原因:scanLocalFiles(按指定文件增量入库)复用同一套「文件 -> 库条目」转换,
// 避免与全量扫描产生字段口径不一致。仅加 export,实现零改动。
export async function extractMetadataLocal(filePath: string): Promise<MusicMetadata> {
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
    // 无损容器：码率不信任截断头解析出的 format.bitrate，按 size*8/duration 现场换算。
    if (LOSSLESS_SIZE_BITRATE_EXTS.has(ext) && duration > 0) {
      bitRate = Math.round((stat.size * 8) / duration / 1000);
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

function findOrCreateAlbum(name: string, artistId: string | null, artistName: string, year: number, picture?: { format: string; data: Buffer }, genre?: string): string {
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
  // 🔴 artist_id 必须写 NULL 而不是空串:歌手是 Unknown(artistId=null)时,
    // 空串会去外键表 artists(id='')找父行 → FOREIGN KEY constraint failed,
    // 整首歌入库失败(2026-11 实测:未知歌手 + 专辑=歌名 的扫描全挂在这里)。
    db.insert(albums).values({ id, name, artistId: artistId || null, artist: artistName, year, genre: genre || "", coverArt: coverRef, songCount: 0, duration: 0, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }).run();
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


export function upsertSong(songPath: string, meta: MusicMetadata, sourceId: string, fingerprint?: string): "added" | "updated" {
  // 三条扫描链路(webdav/smb/local)的唯一入库入口:Unknown 标签在这里统一兜底。
  recoverUnknownTags(meta, songPath);
  // 专辑被清成空(Unknown/网址/广告/GBK 乱码)时用歌名当专辑,与下载/洗版口径一致:
  // 宁可让专辑=歌名,也不要把「空」「www.xxx.com」「ÔÚÏß...」这类脏值写进库里。
  if (isUnknownAlbum(meta.album) && meta.title && !/^unknown(\s*title)?$/i.test(meta.title.trim())) {
    meta.album = meta.title.trim();
  }
  // 行类型以路径前缀为唯一真相:WebDAV 扫描写 `w:<sourceId>:<href>`,本地写
  // `l:<sourceId>:<绝对路径>`,SMB 写 `s:<sourceId>:<共享内路径>`。此前 insert/update
  // 都不写 type,WebDAV 行全落建表默认 'local' —— 前端来源列因此把两类都显示成
  // 「本地」,播放优选的 local 优先排序也退化成并列(谁先入库谁在前)。
  const rowType = songPath.startsWith("w:") ? "webdav" : songPath.startsWith("s:") ? "smb" : "local";
  const existing = db.select().from(songs).where(eq(songs.path, songPath)).get();
  const artistId = findOrCreateArtist(meta.artist) || null;
  const albumId = findOrCreateAlbum(meta.album, artistId, meta.artist, meta.year, meta.picture, meta.genre) || null;
  if (existing) {
    // 同曲多源归组:已分组行保持组不变;历史 NULL 组行(归组启用前/插件关闭期
    // 扫入的存量)在元数据更新时顺带补组,与 web 导入同规则。
    //
    // 但「分组键变了」必须重算:标签从 Unknown Artist 修正为真实歌手后,旧 key
    // 仍指向旧组,这行就永远进不了同曲组(实测 SMB 的 Coldplay 一条歌手已修正,
    // group_key 仍是 `...\x01unknown artist\x01unknown album`)。同 key 命中已有组
    // 时 resolveLocalGroup 会并入,不会另开新组。
    const resolvedGroup = songGroupEnabled() ? resolveLocalGroup(meta) : null;
    const groupKeyChanged = !!resolvedGroup && existing.groupKey !== resolvedGroup.groupKey;
    const backfill = (!existing.groupId || groupKeyChanged) ? resolvedGroup : null;
    db.update(songs).set({
      title: meta.title, artist: meta.artist, artistId, album: meta.album, albumId,
      duration: meta.duration, bitRate: meta.bitRate, contentType: meta.contentType,
      suffix: meta.suffix, size: meta.size, genre: meta.genre,
      discNumber: meta.discNumber, track: meta.track,
      // 文件头标签以文件为权威源,扫描即刷新。
      year: meta.year || 0, albumArtist: meta.albumArtist || "", composer: meta.composer || "",
      comment: meta.comment || "",
      ...(meta.tags ? { tags: meta.tags } : {}),
      // 歌词只标注「有没有」,不存正文(DB 不承载歌词文本):1=有 / 0=检测过无。
      // 文件里没有歌词时不把已有的 1 降级(在线歌词文件可能已落盘),NULL 视为未检测。
      hasLyrics: meta.lyrics ? 1 : (existing.hasLyrics ?? 0),
      type: rowType,
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
    type: rowType,
    discNumber: meta.discNumber, track: meta.track, playCount: 0,
    // 文件头能拿到的标签全部入库;歌词只标注存在性(正文不落库),
    // 冷门标签进 tags JSON;入库后这首歌的批量回填(has_lyrics 已有值)会自动跳过。
    hasLyrics: meta.lyrics ? 1 : 0,
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

/** 取本地源的根目录,仅供「指定文件是否越界」校验;查不到(源未登记/配置缺 path/
 *  配置不是合法 JSON)时返回 null,降级为不校验 —— 不让一次查表失败挡住已下载成功的文件。 */
function resolveSourceRoot(sourceId: string): string | null {
  try {
    const row = db.select().from(mediaSources).where(eq(mediaSources.id, sourceId)).get();
    const cfg = row?.config ? JSON.parse(row.config) : null;
    const p = cfg?.path;
    return typeof p === "string" && p.length > 0 ? path.resolve(p) : null;
  } catch {
    return null;
  }
}

function isUnderRoot(absPath: string, rootPath: string): boolean {
  const rel = path.relative(rootPath, absPath);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

/**
 * 只扫**指定文件列表**的增量入库入口(MusicFetch 落盘后要立刻可搜可播,不能等全库重扫)。
 *
 * 与 scanLocalSource 的差异只有两处,都是刻意为之:
 *  1. 输入是调用方点名的具体文件路径,不做目录遍历(scanLocalDir);
 *  2. 🔴 **不执行收尾对账删除** —— 即 scanLocalSource 里那段
 *     `SELECT id, path ... WHERE path LIKE 'l:<sourceId>:%'` → `!seenPaths.has()` →
 *     DELETE + deleteAnalysisMany + deleteSongLyric + cleanupOrphans(本改动前位于
 *     scanner.ts:835-856,插入本函数后行号下移,请以函数名定位)。
 *     那段逻辑的语义是「本次没扫到 = 文件已删除」,**成立前提是整个 source 根已被完整
 *     遍历过**。本函数只看了列表里的几个文件,一旦走对账,库里其余几万首都会被判定为
 *     消失而被误删。故:全量对账只属于显式 full 扫描,本函数**永不构造 seenPaths、
 *     永不 DELETE、不调用 cleanupOrphans**,对曲库的影响恒为「新增 / 更新」。
 *
 * 其它一律与全量扫描同口径:songKey = `l:<sourceId>:<绝对路径>`、指纹 `size|mtimeMs`、
 * 元信息走 extractMetadataLocal、入库走 upsertSong(命中即更新,不产生重复行)。
 *
 * @returns added/updated/failed/skipped 计数。skipped = 被拒(空项/越界),
 *          failed = 读取或入库抛异常(含文件不存在)。
 */
export async function scanLocalFiles(
  sourceId: string,
  filePaths: string[],
  onProgress?: (p: ScanProgress) => void,
  signal?: AbortSignal,
): Promise<{ added: number; updated: number; failed: number; skipped: number }> {
  const list = Array.isArray(filePaths) ? filePaths : [];
  const progress: ScanProgress = {
    phase: "scanning", totalDirs: 0, processedDirs: 0,
    totalFiles: list.length, processedFiles: 0,
    added: 0, updated: 0, skipped: 0, failed: 0, currentTrack: "",
    // 不做删除对账,语义上不是一次完整 sweep,按增量口径上报。
    mode: "incremental",
  };
  const emit = () => { if (onProgress) onProgress({ ...progress }); };
  emit();

  let added = 0, updated = 0, skipped = 0, failed = 0;
  const rootPath = resolveSourceRoot(sourceId);

  for (let i = 0; i < list.length; i++) {
    if (signal?.aborted) break;
    const raw = list[i];
    // 空项/非字符串:不计入成功,也不算故障(调用方可能拼出了空槽位)。
    if (!raw || typeof raw !== "string") { skipped++; continue; }
    // 统一解析成绝对路径:songKey 必须与全量扫描(path.join(root, ...))的形态一致,
    // 否则同一首歌会被记成两个条目。
    const filePath = path.resolve(raw);
    progress.currentTrack = path.basename(filePath);
    try {
      // 越界防护:只认该 source 根之下的文件(拒绝/跳过并记日志,绝不静默入库)。
      if (rootPath && !isUnderRoot(filePath, rootPath)) {
        skipped++;
        log.warn(`[SCANNER] 跳过不在源根下的文件 ${filePath}(源 ${sourceId} 根 ${rootPath})`);
        continue;
      }
      const stat = fs.statSync(filePath);
      const fp = `${stat.size}|${stat.mtimeMs}`;
      const meta = await extractMetadataLocal(filePath);
      const result = upsertSong(`l:${sourceId}:${filePath}`, meta, sourceId, fp);
      if (result === "added") added++;
      else updated++;
    } catch (e: any) {
      // 与全量扫描同口径:文件不存在 / 无权限 / 解析或入库失败,计入 failed 并带路径告警。
      failed++;
      log.warn(`[SCANNER] 指定文件入库失败 ${filePath}`, { err: e?.message || String(e) });
    }
    progress.processedFiles = i + 1;
    progress.added = added;
    progress.updated = updated;
    progress.skipped = skipped;
    progress.failed = failed;
    emit();
  }

  progress.phase = "done";
  progress.currentTrack = "";
  emit();
  log.info(`[Local] file scan complete: +${added} ~${updated} skip=${skipped} fail=${failed}`);
  return { added, updated, failed, skipped };
}

export async function scanLocalSource(sourceId: string, config: any, mode: ScanMode, onProgress?: (p: ScanProgress) => void, signal?: AbortSignal) {
  const { path: dirPath } = config;
  if (!fs.existsSync(dirPath)) throw new Error(`路径 ${dirPath} 不存在`);
  const allFiles = scanLocalDir(dirPath);
  const progress: ScanProgress = {
    phase: "scanning", totalDirs: 0, processedDirs: 0,
    totalFiles: allFiles.length, processedFiles: 0, added: 0, updated: 0, skipped: 0, failed: 0, currentTrack: "", mode,
  };
  if (onProgress) onProgress(progress);

  let added = 0, updated = 0, skipped = 0, failed = 0;
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
      else updated++;
    } catch (e: any) {
      // 与 WebDAV 同口径:解析 / 入库失败属异常,计入 failed 并带路径告警。
      failed++;
      log.warn(`[SCANNER] 本地入库失败 ${filePath}`, { err: e?.message || String(e) });
    }
    progress.processedFiles = i + 1;
    progress.added = added;
    progress.updated = updated;
    progress.skipped = skipped;
    progress.failed = failed;
    if (onProgress) onProgress({ ...progress });
  }

  // Cleanup skipped when aborted (incomplete traversal would delete valid songs)
  if (signal?.aborted) {
    progress.phase = "done";
    progress.currentTrack = "";
    if (onProgress) onProgress({ ...progress });
    return { added, updated, removed: 0, skipped, failed, aborted: true };
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
  log.info(`[Local] ${mode} scan complete: +${added} ~${updated} -${removed} skip=${skipped} fail=${failed}`);
  return { added, updated, removed, skipped, failed };
}
