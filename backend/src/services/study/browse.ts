// ==================== 学习模块:实时目录浏览 + 点播即入库 ====================
//
// 设计约束(方案已锁定):
//   - 文件夹浏览走**实时列远程目录**(WebDAV PROPFIND Depth:1 / SMB readdir / 本地
//     readdir),不依赖扫描是否跑过;
//   - 播放某文件时若尚未入库,先取文件头解析元数据再复用 scanner.upsertSong 入库
//     (点播即入库),因此播放链路完全复用现有 /rest/stream;
//   - 学习源整源标记 kind='study',音乐面所有入口按 kind='music' 过滤。
//
// 目录结果带 30s 进程内缓存(同一目录连点不反复打远程),单次远程调用 8s 超时;
// 同 key 的并发请求合并为一次(单飞),避免前端预取把 NAS 连接打满。
import fs from "node:fs";
import path from "node:path";
import { and, eq, inArray, sql } from "drizzle-orm";
import { db } from "../../db/index.js";
import { mediaSources, songs, studyProgress } from "../../db/schema.js";
import { buildSmbConfig, normalizeSmbPath, smbReaddir, smbReadRange, smbStat, type SmbConfig } from "../source/smbClient.js";
import { extractMetadataHeader, extractMetadataLocal, upsertSong } from "../source/scanner.js";
import { createLogger } from "../../utils/logger.js";

const log = createLogger("STUDY");

const AUDIO_EXTENSIONS = new Set([".mp3", ".flac", ".wav", ".aac", ".ogg", ".m4a", ".wma", ".ape", ".aiff", ".opus"]);
/** 目录缓存 TTL:远程目录变化不频繁,30s 足够挡掉连续点击与返回上级的重复请求。 */
const DIR_CACHE_TTL_MS = 30_000;
/** 单次远程列目录超时。 */
const DIR_TIMEOUT_MS = 8_000;
/** 点播入库时读取的文件头上限(与扫描器取头上限一致,覆盖绝大多数内嵌封面)。 */
const HEADER_MAX_BYTES = 4 * 1024 * 1024;

export class StudyError extends Error {
  constructor(public readonly status: 400 | 401 | 403 | 404 | 409 | 504, message: string) {
    super(message);
  }
}

export interface StudySourceRow {
  id: string;
  name: string;
  type: string;
  config: any;
}

export interface StudyDirEntry {
  name: string;
  /** 相对源根的路径(统一 '/' 分隔,无首尾斜杠)。 */
  relPath: string;
  isDir: boolean;
  size?: number;
  mtimeMs?: number;
}

const dirCache = new Map<string, { at: number; items: StudyDirEntry[] }>();
const inflight = new Map<string, Promise<StudyDirEntry[]>>();

/** 取学习源(必须是 kind='study'),不存在或不是学习源一律 404。 */
export function getStudySource(id: string): StudySourceRow {
  const row = db.select().from(mediaSources).where(eq(mediaSources.id, id)).get();
  if (!row || row.kind !== "study") throw new StudyError(404, "学习源不存在");
  let config: any = {};
  try { config = JSON.parse(row.config || "{}"); } catch { config = {}; }
  return { id: row.id, name: row.name, type: row.type, config };
}

/** 学习源列表(含已入库曲目数)。 */
export function listStudySources(): Array<{ id: string; name: string; type: string; enabled: boolean; songCount: number }> {
  const rows = db.select().from(mediaSources).where(eq(mediaSources.kind, "study")).all();
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    type: r.type,
    enabled: r.enabled === 1,
    songCount: db.select({ n: sql<number>`count(*)` }).from(songs).where(eq(songs.sourceId, r.id)).get()?.n ?? 0,
  }));
}

/** 相对路径归一 + 防穿越。拒绝 .. / 绝对路径 / NUL。 */
export function normalizeRelDir(input: unknown): string {
  const raw = String(input ?? "").replace(/\\/g, "/").trim();
  if (!raw) return "";
  if (raw.includes("\0")) throw new StudyError(400, "非法路径");
  const segs = raw.replace(/^\/+|\/+$/g, "").split("/").filter(Boolean);
  if (segs.some((s) => s === "." || s === "..")) throw new StudyError(400, "非法路径");
  return segs.join("/");
}

/** 相对路径归一(文件或目录),额外校验音频后缀。 */
export function normalizeStudyFilePath(input: unknown): string {
  const rel = normalizeRelDir(input);
  if (!rel) throw new StudyError(400, "缺少文件路径");
  const ext = path.extname(rel).toLowerCase();
  if (!AUDIO_EXTENSIONS.has(ext)) throw new StudyError(400, "不支持的音频格式");
  return rel;
}

export function relDirOf(relPath: string): string {
  const i = relPath.lastIndexOf("/");
  return i > 0 ? relPath.slice(0, i) : "";
}

function posixJoin(...parts: string[]): string {
  return parts.filter(Boolean).join("/").replace(/\/{2,}/g, "/").replace(/^\/+|\/+$/g, "");
}

function isUnder(root: string, full: string): boolean {
  const r = path.resolve(root);
  const f = path.resolve(full);
  return f === r || f.startsWith(r + path.sep);
}

/** 实时列目录(带 30s 缓存 + 同 key 单飞)。 */
export async function listStudyDir(source: StudySourceRow, relDirInput: unknown): Promise<StudyDirEntry[]> {
  const relDir = normalizeRelDir(relDirInput);
  const key = `${source.id}\u0000${relDir}`;
  const cached = dirCache.get(key);
  if (cached && Date.now() - cached.at < DIR_CACHE_TTL_MS) return cached.items;
  const running = inflight.get(key);
  if (running) return running;
  const task = (async () => {
    let items: StudyDirEntry[];
    try {
      items = await listDirRemote(source, relDir);
    } finally {
      inflight.delete(key);
    }
    // 自然排序:课名去掉数字前缀后,必须按数字大小排,否则 Lesson 10 会排在 Lesson 2 前面
    items.sort((a, b) => (a.isDir === b.isDir ? a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" }) : a.isDir ? -1 : 1));
    dirCache.set(key, { at: Date.now(), items });
    return items;
  })();
  inflight.set(key, task);
  return task;
}

async function listDirRemote(source: StudySourceRow, relDir: string): Promise<StudyDirEntry[]> {
  switch (source.type) {
    case "local": return listLocalDir(source, relDir);
    case "smb": return listSmbDir(source, relDir);
    case "webdav": return listWebdavDir(source, relDir);
    default: throw new StudyError(400, "不支持的学习源类型");
  }
}

function listLocalDir(source: StudySourceRow, relDir: string): StudyDirEntry[] {
  const root = path.resolve(String(source.config?.path || ""));
  if (!root || !fs.existsSync(root)) throw new StudyError(404, "本地目录不存在");
  const full = path.resolve(root, relDir);
  if (!isUnder(root, full)) throw new StudyError(400, "非法路径");
  let dirents: fs.Dirent[];
  try {
    dirents = fs.readdirSync(full, { withFileTypes: true });
  } catch {
    throw new StudyError(404, "目录不存在或无法读取");
  }
  const out: StudyDirEntry[] = [];
  for (const d of dirents) {
    if (d.name.startsWith(".")) continue;
    const childRel = posixJoin(relDir, d.name);
    if (d.isDirectory()) {
      out.push({ name: d.name, relPath: childRel, isDir: true });
    } else if (AUDIO_EXTENSIONS.has(path.extname(d.name).toLowerCase())) {
      const st = fs.statSync(path.join(full, d.name));
      out.push({ name: d.name, relPath: childRel, isDir: false, size: st.size, mtimeMs: st.mtimeMs });
    }
  }
  return out;
}

async function listSmbDir(source: StudySourceRow, relDir: string): Promise<StudyDirEntry[]> {
  const cfg = buildSmbConfig(source.config);
  if (!cfg) throw new StudyError(400, "SMB 配置不完整");
  const dir = normalizeSmbPath(posixJoin(cfg.root_path, relDir));
  const entries = await withTimeout(smbReaddir(source.id, cfg, dir), "SMB 目录读取超时");
  const out: StudyDirEntry[] = [];
  for (const e of entries) {
    if (e.name.startsWith(".")) continue;
    const childRel = posixJoin(relDir, e.name);
    if (e.isDirectory) out.push({ name: e.name, relPath: childRel, isDir: true });
    else if (AUDIO_EXTENSIONS.has(path.extname(e.name).toLowerCase())) {
      out.push({ name: e.name, relPath: childRel, isDir: false, size: e.size, mtimeMs: e.mtimeMs });
    }
  }
  return out;
}

function webdavBase(cfg: any): string {
  let base = String(cfg?.url || "").trim().replace(/\/+$/, "");
  const rootPath = String(cfg?.root_path || "").trim().replace(/^\/+|\/+$/g, "");
  if (rootPath) base += "/" + rootPath;
  return base;
}

function webdavAuth(cfg: any): string | null {
  const u = String(cfg?.username || "");
  const p = String(cfg?.password || "");
  return u && p ? "Basic " + Buffer.from(`${u}:${p}`).toString("base64") : null;
}

function encodeRel(rel: string): string {
  return rel.split("/").filter(Boolean).map(encodeURIComponent).join("/");
}

async function listWebdavDir(source: StudySourceRow, relDir: string): Promise<StudyDirEntry[]> {
  const cfg = source.config || {};
  const base = webdavBase(cfg);
  if (!base) throw new StudyError(400, "WebDAV 配置不完整");
  const basePath = decodeURIComponent(new URL(base).pathname).replace(/\/+$/, "");
  const targetUrl = `${base}/${encodeRel(relDir)}${relDir ? "/" : ""}`;
  const auth = webdavAuth(cfg);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DIR_TIMEOUT_MS);
  let xml: string;
  try {
    const res = await fetch(targetUrl, {
      method: "PROPFIND",
      headers: {
        Depth: "1",
        "Content-Type": "application/xml",
        Accept: "application/xml, text/xml",
        ...(auth ? { Authorization: auth } : {}),
      },
      body: `<?xml version="1.0" encoding="utf-8"?><D:propfind xmlns:D="DAV:"><D:prop><D:resourcetype/><D:getcontentlength/><D:getlastmodified/></D:prop></D:propfind>`,
      signal: controller.signal,
    });
    if (!res.ok && res.status !== 207) throw new StudyError(404, `WebDAV 返回 HTTP ${res.status}`);
    xml = await res.text();
  } catch (e: any) {
    if (e instanceof StudyError) throw e;
    if (e?.name === "AbortError") throw new StudyError(504, "WebDAV 目录读取超时");
    throw new StudyError(504, "WebDAV 目录读取失败");
  } finally {
    clearTimeout(timer);
  }

  const out: StudyDirEntry[] = [];
  for (const block of xml.split(/<[dD]:response>/).slice(1)) {
    const hrefMatch = block.match(/<[dD]:href>([^<]+)<\/[dD]:href>/);
    if (!hrefMatch) continue;
    const href = safeDecode(hrefMatch[1]);
    // WebDAV 的 collection href 带尾斜杠(子目录自身会返回 `<当前目录>/`),
    // 不归一的话 `rel !== relDir` 判断失效,当前目录会作为一张「同名子目录」卡片出现。
    const rawRel = stripRoot(basePath, href);
    if (rawRel == null) continue;
    const rel = rawRel.replace(/\/+$/, "");
    // 跳过目录自身(D:collection 且 rel 为空 / 等于当前目录)
    if (!rel) continue;
    const name = rel.split("/").filter(Boolean).pop() || "";
    if (!name || name.startsWith(".")) continue;
    if (block.includes(":collection")) {
      if (rel !== relDir) out.push({ name, relPath: rel, isDir: true });
      continue;
    }
    if (!AUDIO_EXTENSIONS.has(path.extname(name).toLowerCase())) continue;
    const sizeMatch = block.match(/<[dD]:getcontentlength>(\d+)<\/[dD]:getcontentlength>/);
    out.push({ name, relPath: rel, isDir: false, size: sizeMatch ? parseInt(sizeMatch[1], 10) : 0 });
  }
  return out;
}

function safeDecode(v: string): string {
  try { return decodeURIComponent(v); } catch { return v; }
}

function stripRoot(prefix: string, full: string): string | null {
  const root = prefix.replace(/\/+$/, "");
  if (full === root) return "";
  return full.startsWith(root + "/") ? full.slice(root.length + 1) : null;
}

function withTimeout<T>(p: Promise<T>, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new StudyError(504, message)), DIR_TIMEOUT_MS);
    p.then((v) => { clearTimeout(timer); resolve(v); }, (e) => { clearTimeout(timer); reject(e); });
  });
}

// ==================== 点播即入库 ====================

/** 学习歌曲的入库 path 形态必须与扫描器一致(w: / s: / l:),否则会入库两条。 */
function songPathOf(source: StudySourceRow, relPath: string): string {
  const relDir = relDirOf(relPath);
  switch (source.type) {
    case "local": {
      const root = path.resolve(String(source.config?.path || ""));
      return `l:${source.id}:${path.resolve(root, relPath)}`;
    }
    case "smb": {
      const cfg = buildSmbConfig(source.config);
      if (!cfg) throw new StudyError(400, "SMB 配置不完整");
      return `s:${source.id}:${normalizeSmbPath(posixJoin(cfg.root_path, relPath))}`;
    }
    case "webdav": {
      const cfg = source.config || {};
      const base = webdavBase(cfg);
      if (!base) throw new StudyError(400, "WebDAV 配置不完整");
      const basePath = decodeURIComponent(new URL(base).pathname).replace(/\/+$/, "");
      return `w:${source.id}:${basePath}/${relPath}`;
    }
    default:
      throw new StudyError(400, "不支持的学习源类型");
  }
}

/** 目录条目上附带「已入库曲目 + 当前用户学习进度」,供 Web 章节列表直接渲染进度列。
 *  未入库的文件没有 songId(第一次点播才入库),进度记为 0。 */
export interface StudyDirEntryState {
  songId?: string;
  durationSec?: number;
  positionSec?: number;
  finished?: boolean;
  progress?: number;
}

/** 相对路径 → 库内 path(l:/s:/w:),与扫描器/点播入库同源,保证能按目录反查歌曲行。 */
export function studySongPathOf(source: StudySourceRow, relPath: string): string {
  return songPathOf(source, relPath);
}

/**
 * 库内 path(l:/s:/w:) → 相对源根的路径(导出学习歌单时写入文件,换库导入可据此重新入库)。
 * 源配置变更/路径不在源根下/非音频后缀时返回空串,不抛错(导出不应因单条异常中断)。
 */
export function studyRelPathOf(source: StudySourceRow, storedPath: string): string {
  const prefix = `${source.type === "local" ? "l" : source.type === "smb" ? "s" : "w"}:${source.id}:`;
  const full = String(storedPath || "").replace(/\\/g, "/");
  if (!full.startsWith(prefix)) return "";
  const rest = full.slice(prefix.length);
  let root = "";
  try {
    if (source.type === "local") {
      root = path.resolve(String(source.config?.path || "")).replace(/\\/g, "/");
    } else if (source.type === "smb") {
      const cfg = buildSmbConfig(source.config);
      root = cfg ? normalizeSmbPath(cfg.root_path) : "";
    } else {
      const base = webdavBase(source.config);
      root = base ? decodeURIComponent(new URL(base).pathname) : "";
    }
  } catch {
    return "";
  }
  root = root.replace(/\/+$/, "");
  const rel = root === "/"
    ? rest.replace(/^\/+/, "")
    : (root ? stripRoot(root, rest) : rest.replace(/^\/+/, ""));
  if (rel === null) return "";
  try {
    return normalizeStudyFilePath(rel);
  } catch {
    return "";
  }
}

/**
 * 给一目录的文件条目补 songId/时长/进度。
 * 一次查询按 path 批量取歌曲行,再批量取当前用户的 study_progress;不做 N+1。
 */
export function attachStudyState<T extends StudyDirEntry>(
  source: StudySourceRow,
  items: T[],
  userId: string,
): Array<T & StudyDirEntryState> {
  const files = items.filter((e) => !e.isDir);
  if (files.length === 0) return items as any;
  const pathOf = new Map<string, string>();
  for (const f of files) {
    try { pathOf.set(f.relPath, songPathOf(source, f.relPath)); } catch { /* 单条路径异常不影响整目录 */ }
  }
  const paths = [...pathOf.values()];
  const rows = paths.length
    ? db.select({ id: songs.id, path: songs.path, duration: songs.duration })
        .from(songs)
        .where(and(eq(songs.kind, "study"), inArray(songs.path, paths))).all()
    : [];
  const byPath = new Map(rows.map((r) => [r.path, r]));
  const ids = rows.map((r) => r.id);
  const progressRows = userId && ids.length
    ? db.select().from(studyProgress)
        .where(and(eq(studyProgress.userId, userId), inArray(studyProgress.songId, ids))).all()
    : [];
  const bySong = new Map(progressRows.map((p) => [p.songId, p]));
  return items.map((e) => {
    if (e.isDir) return e as any;
    const row = byPath.get(pathOf.get(e.relPath) || "");
    if (!row) return { ...e, progress: 0 };
    const p = bySong.get(row.id);
    const durationSec = p?.durationSec || row.duration || 0;
    const positionSec = p?.positionSec || 0;
    return {
      ...e,
      songId: row.id,
      durationSec,
      positionSec,
      finished: !!p?.finished,
      progress: durationSec > 0 ? Math.min(1, positionSec / durationSec) : 0,
    };
  });
}

/** 点播即入库:未入库时解析文件头 → 复用 upsertSong(kind='study') → 返回歌曲行。
 * 已入库(含扫描已收录)直接返回,不重复取头。
 */
export async function ensureStudySong(source: StudySourceRow, relPathInput: unknown): Promise<any> {
  const relPath = normalizeStudyFilePath(relPathInput);
  const relDir = relDirOf(relPath);
  const songPath = songPathOf(source, relPath);
  const existing = db.select().from(songs).where(eq(songs.path, songPath)).get();
  if (existing) {
    if (existing.kind !== "study") throw new StudyError(409, "该文件已被音乐库收录");
    return existing;
  }

  let meta;
  switch (source.type) {
    case "local": {
      const full = path.resolve(String(source.config?.path || ""), relPath);
      if (!isUnder(String(source.config?.path || ""), full)) throw new StudyError(400, "非法路径");
      if (!fs.existsSync(full)) throw new StudyError(404, "文件不存在");
      meta = await extractMetadataLocal(full);
      break;
    }
    case "smb": {
      const cfg = buildSmbConfig(source.config) as SmbConfig;
      const full = normalizeSmbPath(posixJoin(cfg.root_path, relPath));
      let stat;
      try { stat = await withTimeout(smbStat(source.id, cfg, full), "SMB 文件读取超时"); } catch {
        throw new StudyError(404, "文件不存在或无法读取");
      }
      if (stat.isDirectory) throw new StudyError(400, "目标不是音频文件");
      const end = Math.min(HEADER_MAX_BYTES, stat.size) - 1;
      const buf = await withTimeout(smbReadRange(source.id, cfg, full, 0, Math.max(0, end)), "SMB 文件读取超时");
      meta = await extractMetadataHeader(buf, path.basename(relPath), stat.size);
      break;
    }
    case "webdav": {
      const cfg = source.config || {};
      const base = webdavBase(cfg);
      const auth = webdavAuth(cfg);
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), DIR_TIMEOUT_MS);
      try {
        const res = await fetch(`${base}/${encodeRel(relPath)}`, {
          headers: { ...(auth ? { Authorization: auth } : {}), Range: `bytes=0-${HEADER_MAX_BYTES - 1}` },
          signal: controller.signal,
        });
        if (!res.ok && res.status !== 206) throw new StudyError(404, `WebDAV 返回 HTTP ${res.status}`);
        const buf = Buffer.from(await res.arrayBuffer());
        meta = await extractMetadataHeader(buf, path.basename(relPath), buf.length);
      } catch (e: any) {
        if (e instanceof StudyError) throw e;
        if (e?.name === "AbortError") throw new StudyError(504, "WebDAV 文件读取超时");
        throw new StudyError(504, "WebDAV 文件读取失败");
      } finally {
        clearTimeout(timer);
      }
      break;
    }
    default:
      throw new StudyError(400, "不支持的学习源类型");
  }

  upsertSong(songPath, meta, source.id, undefined, { kind: "study", relDir });
  const row = db.select().from(songs).where(eq(songs.path, songPath)).get();
  if (!row) throw new StudyError(504, "入库失败");
  log.info(`[STUDY] 点播入库 ${source.name}/${relPath}`);
  return row;
}

/** 目录缓存失效(源配置变更/手动刷新时调用)。 */
export function invalidateStudyDirCache(sourceId?: string): void {
  if (!sourceId) { dirCache.clear(); return; }
  for (const key of dirCache.keys()) if (key.startsWith(`${sourceId}\u0000`)) dirCache.delete(key);
}
