// ==================== 学习模块 API(P0 服务端) ====================
//
// 全部接口只在 kind='study' 的源/歌曲上工作,与音乐面互不可见:
//   浏览:  GET  /v1/study/sources            学习源列表
//          GET  /v1/study/dir?id=dir:<源id>:<相对目录>   实时列目录
//   播放:  POST /v1/study/resolve            点播即入库,返回 songId(之后走 /rest/stream)
//          PUT  /v1/study/progress           上报学习进度(不写音乐播放历史)
//          DELETE /v1/study/progress          清空全部学习记录
//          DELETE /v1/study/progress/:songId  删除一条学习记录
//          PUT  /v1/study/playlists/:id/progress  记录学习歌单播放位置(整单续播)
//          GET  /v1/study/continue           继续学习
//          GET  /v1/study/recent             最近添加
//          GET  /v1/study/search             学习内容搜索
//   歌单:  GET/POST/DELETE /v1/study/playlists..., 曲目增删
import type { Hono } from "hono";
import { and, desc, eq, inArray, notInArray, or, sql, like } from "drizzle-orm";
import { db } from "../../db/index.js";
import { playlists, playlistSongs, songs, studyProgress, mediaSources, studyPlaylistFolders, studyPlaylistProgress } from "../../db/schema.js";
import { PERM, permMiddleware } from "./shared.js";
import { apiError, apiErrorStatus, BusinessErrorCode } from "../../utils/errors.js";
import { serializeSongRow } from "../../utils/songSource.js";
import { refreshPlaylistCounts } from "../../services/plugin/shared.js";
import {
  StudyError,
  attachStudyState,
  ensureStudySong,
  getStudySource,
  listStudyDir,
  listStudySources,
  normalizeRelDir,
  invalidateStudyDirCache,
  studyRelPathOf,
  type StudySourceRow,
} from "../../services/study/browse.js";

/** 每个用户保留的学习记录上限(按 updatedAt 取最新)。 */
const STUDY_PROGRESS_LIMIT = 50;
/** 每个用户保留的学习歌单续播条目上限。 */
const STUDY_PLAYLIST_PROGRESS_LIMIT = 50;

function fail(c: any, e: unknown) {
  if (e instanceof StudyError) {
    const code =
      e.status === 400 ? BusinessErrorCode.INVALID_PARAM :
      e.status === 401 ? BusinessErrorCode.UNAUTHORIZED :
      e.status === 403 ? BusinessErrorCode.FORBIDDEN :
      e.status === 404 ? BusinessErrorCode.NOT_FOUND :
      e.status === 409 ? BusinessErrorCode.CONFLICT :
      BusinessErrorCode.UPSTREAM_ERROR;
    return c.json(apiError(code, e.message), apiErrorStatus(code));
  }
  return c.json(apiError(BusinessErrorCode.INTERNAL, (e as any)?.message || "学习模块请求失败"), apiErrorStatus(BusinessErrorCode.INTERNAL));
}

function parseDirId(raw: string): { sourceId: string; relDir: string } {
  if (!raw.startsWith("dir:")) throw new StudyError(400, "缺少目录 id");
  const rest = raw.slice(4);
  const i = rest.indexOf(":");
  return i >= 0
    ? { sourceId: rest.slice(0, i), relDir: normalizeRelDir(rest.slice(i + 1)) }
    : { sourceId: rest, relDir: "" };
}

/** 源文件名(含扩展名):学习列表按「和原文件一致的文件名」展示,不依赖元数据标题。 */
function studyFileNameOf(s: any): string {
  const raw = String(s?.path || "").replace(/\\/g, "/");
  const tail = raw.replace(/^[lsw]:[^:]+:/, "");
  const base = tail.slice(tail.lastIndexOf("/") + 1);
  try { return decodeURIComponent(base); } catch { return base; }
}

function studySongPayload(s: any, extra: Record<string, any> = {}) {
  return {
    ...serializeSongRow(s),
    // Web/客户端据此把「学习音频」与音乐区分开(不写音乐播放历史、启用学习进度与倍速)。
    kind: "study",
    sourceId: s.sourceId,
    relDir: s.relDir || "",
    fileName: studyFileNameOf(s),
    ...extra,
  };
}

/** 学习歌单的访问权限:本人可见始终成立,管理员沿用既有放行规则。 */
function canAccessStudyPlaylist(pl: any, user: any): boolean {
  return !!pl && pl.kind === "study" && (pl.ownerId === user?.id || !!user?.isAdmin);
}

/** 裁剪某用户的学习歌单续播记录,只保留最新 N 条。 */
function pruneStudyPlaylistProgress(userId: string): void {
  const keep = db.select({ playlistId: studyPlaylistProgress.playlistId })
    .from(studyPlaylistProgress)
    .where(eq(studyPlaylistProgress.userId, userId))
    .orderBy(desc(studyPlaylistProgress.updatedAt))
    .limit(STUDY_PLAYLIST_PROGRESS_LIMIT)
    .all()
    .map((r) => r.playlistId);
  if (keep.length >= STUDY_PLAYLIST_PROGRESS_LIMIT) {
    db.delete(studyPlaylistProgress)
      .where(and(eq(studyPlaylistProgress.userId, userId), notInArray(studyPlaylistProgress.playlistId, keep)))
      .run();
  }
}

/** 同一用户的学习歌单名称唯一(忽略首尾空格与大小写);重名抛 409。 */
function assertStudyPlaylistNameFree(ownerId: string, name: string, excludeId = ""): void {
  const target = name.trim().toLocaleLowerCase();
  if (!ownerId || !target) return;
  const rows = db.select({ id: playlists.id, name: playlists.name }).from(playlists)
    .where(and(eq(playlists.kind, "study"), eq(playlists.ownerId, ownerId))).all();
  const hit = rows.find((r) =>
    r.id !== excludeId && String(r.name || "").trim().toLocaleLowerCase() === target);
  if (hit) throw new StudyError(409, "已存在同名学习歌单");
}

// ==================== 歌单导出 / 导入 ====================

/** 导出文件标识;导入时只校验结构,不强制 app 字段(兼容手工编辑的文件)。 */
const STUDY_EXPORT_APP = "MusicFlow-StudyPlaylists";
const STUDY_IMPORT_MAX_PLAYLISTS = 200;
const STUDY_IMPORT_MAX_TRACKS = 5000;

function sourceForExport(sourceId: string, cache: Map<string, StudySourceRow | null>): StudySourceRow | null {
  if (!sourceId) return null;
  if (!cache.has(sourceId)) {
    let source: StudySourceRow | null = null;
    try { source = getStudySource(sourceId); } catch { source = null; }
    cache.set(sourceId, source);
  }
  return cache.get(sourceId) || null;
}

/** 单个学习歌单 → 导出结构。曲目同时带 songId(同库秒恢复)与 relPath(换库可重入库)。 */
function buildStudyPlaylistExport(playlistId: string) {
  const pl = db.select().from(playlists).where(eq(playlists.id, playlistId)).get();
  if (!pl || pl.kind !== "study") throw new StudyError(404, "学习歌单不存在");
  const rows = db.select({ s: songs })
    .from(playlistSongs)
    .innerJoin(songs, eq(playlistSongs.songId, songs.id))
    .where(and(eq(playlistSongs.playlistId, playlistId), eq(songs.kind, "study")))
    .orderBy(playlistSongs.position, playlistSongs.id).all();
  const sources = new Map<string, StudySourceRow | null>();
  const tracks = rows.map(({ s }) => {
    const source = sourceForExport(s.sourceId || "", sources);
    return {
      songId: s.id,
      title: s.title || "",
      artist: s.artist || "",
      album: s.album || "",
      relDir: s.relDir || "",
      relPath: source ? studyRelPathOf(source, s.path || "") : "",
      sourceId: s.sourceId || "",
      sourceName: source?.name || "",
      duration: s.duration || 0,
    };
  });
  return { name: pl.name, comment: pl.comment || "", tracks };
}

/** 并发受限的 map:导入时批量重入库需要读远程文件头,不能无限并发。 */
async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let cursor = 0;
  const worker = async () => {
    while (true) {
      const idx = cursor++;
      if (idx >= items.length) return;
      out[idx] = await fn(items[idx]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

function findStudySourceByName(name: string): StudySourceRow | null {
  if (!name) return null;
  const row = db.select().from(mediaSources)
    .where(and(eq(mediaSources.kind, "study"), eq(mediaSources.name, name))).get();
  if (!row) return null;
  let config: any = {};
  try { config = JSON.parse(row.config || "{}"); } catch { config = {}; }
  return { id: row.id, name: row.name, type: row.type, config };
}

/**
 * 导入曲目 → 本库 songId。解析顺序:
 *   1) songId 同库命中(导出后再导入最快);
 *   2) sourceId/sourceName + relPath 重入库(换库/换源 id 后仍能恢复);
 *   3) 源 + 标题 + 目录兜底(源不可达但歌曲已在库)。
 */
async function resolveImportTrack(track: any): Promise<string> {
  const songId = String(track?.songId || "").trim();
  if (songId) {
    const found = db.select({ id: songs.id }).from(songs)
      .where(and(eq(songs.id, songId), eq(songs.kind, "study"))).get();
    if (found) return found.id;
  }
  const relPath = String(track?.relPath || "").trim();
  const sourceId = String(track?.sourceId || "").trim();
  if (relPath) {
    let source: StudySourceRow | null = null;
    if (sourceId) {
      try { source = getStudySource(sourceId); } catch { source = null; }
    }
    if (!source) source = findStudySourceByName(String(track?.sourceName || "").trim());
    if (source) {
      try {
        const song = await ensureStudySong(source, relPath);
        return song.id;
      } catch { /* 源不可达/文件已删:继续走标题兜底 */ }
    }
  }
  const title = String(track?.title || "").trim();
  if (!title) return "";
  const relDir = String(track?.relDir || (relPath.includes("/") ? relPath.slice(0, relPath.lastIndexOf("/")) : "")).trim();
  const conds: any[] = [eq(songs.kind, "study"), eq(songs.title, title)];
  if (sourceId) conds.push(eq(songs.sourceId, sourceId));
  if (relDir) conds.push(eq(songs.relDir, relDir));
  const row = db.select({ id: songs.id }).from(songs).where(and(...conds)).get();
  return row?.id || "";
}

// ==================== 学习歌单文件夹 ====================

const FOLDER_NAME_MAX = 60;

function normalizeFolderName(raw: unknown): string {
  return String(raw ?? "").trim().slice(0, FOLDER_NAME_MAX);
}

/** 文件夹路径:用 / 分隔多级目录,空段与首尾斜杠会被清理。 */
function normalizeFolderPath(raw: unknown): string {
  return String(raw ?? "")
    .split("/")
    .map((s) => s.trim().slice(0, FOLDER_NAME_MAX))
    .filter(Boolean)
    .slice(0, 12)
    .join("/");
}
function folderParentOf(path: string): string {
  const i = path.lastIndexOf("/");
  return i >= 0 ? path.slice(0, i) : "";
}
function folderBaseNameOf(path: string): string {
  const i = path.lastIndexOf("/");
  return i >= 0 ? path.slice(i + 1) : path;
}

/** 文件夹按 owner 隔离;支持 a/b 多级路径,逐级补齐父目录,存在即幂等。 */
function ensureStudyFolder(ownerId: string, rawName: unknown): string {
  const path = normalizeFolderPath(rawName);
  if (!path || !ownerId) return path;
  let acc = "";
  for (const seg of path.split("/")) {
    acc = acc ? `${acc}/${seg}` : seg;
    const found = db.select().from(studyPlaylistFolders)
      .where(and(eq(studyPlaylistFolders.ownerId, ownerId), eq(studyPlaylistFolders.name, acc))).get();
    if (!found) {
      const now = new Date().toISOString();
      db.insert(studyPlaylistFolders).values({ ownerId, name: acc, createdAt: now, updatedAt: now }).run();
    }
  }
  return path;
}

/** 当前用户自己的文件夹名:仅本人可见,管理员的列表也不混入他人文件夹。 */
function listStudyFolderNames(userId: string, rows: Array<{ ownerId?: string; folder?: string | null }>): string[] {
  const names = new Set<string>();
  const own = userId
    ? db.select().from(studyPlaylistFolders)
        .where(eq(studyPlaylistFolders.ownerId, userId)).all()
    : [];
  for (const f of own) if (f.name) names.add(f.name);
  // 防御历史数据:歌单上出现过、但文件夹行缺失时也补上(仍限本人)。
  for (const row of rows) if (row.ownerId === userId && row.folder) names.add(row.folder);
  return [...names].sort((a, b) => a.localeCompare(b, "zh-CN"));
}

export function registerStudy(app: Hono): void {
  // ==================== 浏览 ====================

  app.get("/v1/study/sources", permMiddleware(PERM.STUDY_BROWSE), (c) => {
    return c.json({ items: listStudySources() });
  });

  app.get("/v1/study/dir", permMiddleware(PERM.STUDY_BROWSE), async (c) => {
    try {
      const raw = c.req.query("id") || "";
      const { sourceId, relDir } = raw
        ? parseDirId(raw)
        : {
            sourceId: String(c.req.query("sourceId") || ""),
            relDir: normalizeRelDir(c.req.query("path") || ""),
          };
      if (!sourceId) throw new StudyError(400, "缺少源 id");
      const source = getStudySource(sourceId);
      const entries = await listStudyDir(source, relDir);
      // 章节列表要直接显示进度列:给已入库文件补 songId/时长/进度(未入库的为 0)。
      const items = attachStudyState(source, entries, c.get("user")?.id || "");
      return c.json({ sourceId, sourceName: source.name, relDir, items });
    } catch (e) {
      return fail(c, e);
    }
  });

  // ==================== 播放 / 进度 ====================

  app.post("/v1/study/resolve", permMiddleware(PERM.STUDY_STREAM), async (c) => {
    try {
      const body = await c.req.json().catch(() => ({}));
      const source = getStudySource(String(body?.sourceId || ""));
      const song = await ensureStudySong(source, body?.path);
      return c.json({ song: studySongPayload(song) });
    } catch (e) {
      return fail(c, e);
    }
  });

  // 「播放全部」/点某一章:一次把整个目录的音频入库并返回有序歌曲列表,
  // 避免前端 N 次串行请求(每次都可能要读远程文件头)。并发 4,单条失败不影响其余。
  app.post("/v1/study/resolve-batch", permMiddleware(PERM.STUDY_STREAM), async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const source = getStudySource(String(body?.sourceId || ""));
    const rawPaths = body?.paths;
    const paths: string[] = Array.isArray(rawPaths)
      ? [...new Set(rawPaths.map(String))].slice(0, 500)
      : [];
    if (paths.length === 0) return fail(c, new StudyError(400, "缺少文件路径"));
    const out: Array<{ path: string; song?: any; error?: string }> = new Array(paths.length);
    let cursor = 0;
    const worker = async () => {
      while (true) {
        const idx = cursor++;
        if (idx >= paths.length) return;
        try {
          const song = await ensureStudySong(source, paths[idx]);
          out[idx] = { path: paths[idx], song: studySongPayload(song) };
        } catch (e: any) {
          out[idx] = { path: paths[idx], error: e?.message || "入库失败" };
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(4, paths.length) }, worker));
    return c.json({ items: out.filter(Boolean) });
  });

  app.put("/v1/study/progress", permMiddleware(PERM.STUDY_STREAM), async (c) => {
    const user = c.get("user");
    if (!user) return fail(c, new StudyError(401, "未登录"));
    const body = await c.req.json().catch(() => ({}));
    const songId = String(body?.songId || "");
    const row = songId ? db.select().from(songs).where(eq(songs.id, songId)).get() : null;
    if (!row || row.kind !== "study") return fail(c, new StudyError(404, "学习音频不存在"));
    const duration = Math.max(0, Number(body?.durationSec) || row.duration || 0);
    const position = Math.max(0, Number(body?.positionSec) || 0);
    const finished = body?.finished === true || (duration > 0 && position >= duration * 0.95) ? 1 : 0;
    const now = new Date().toISOString();
    db.insert(studyProgress).values({
      userId: user.id, songId, positionSec: position, durationSec: duration,
      finished, updatedAt: now,
    }).onConflictDoUpdate({
      target: [studyProgress.userId, studyProgress.songId],
      set: { positionSec: position, durationSec: duration, finished, updatedAt: now },
    }).run();
    // 学习记录只保留最新 50 条:超出部分按 updatedAt 从旧到新清理。
    const keepSongIds = db.select({ songId: studyProgress.songId })
      .from(studyProgress)
      .where(eq(studyProgress.userId, user.id))
      .orderBy(desc(studyProgress.updatedAt))
      .limit(STUDY_PROGRESS_LIMIT)
      .all()
      .map((r) => r.songId);
    if (keepSongIds.length >= STUDY_PROGRESS_LIMIT) {
      db.delete(studyProgress)
        .where(and(eq(studyProgress.userId, user.id), notInArray(studyProgress.songId, keepSongIds)))
        .run();
    }
    return c.json({ success: true, finished: !!finished });
  });

  // 记录「学习歌单」播放位置:继续学习页据此提供整单续播入口。
  app.put("/v1/study/playlists/:id/progress", permMiddleware(PERM.STUDY_STREAM), async (c) => {
    const user = c.get("user");
    if (!user) return fail(c, new StudyError(401, "未登录"));
    const id = c.req.param("id")!;
    const pl = db.select().from(playlists).where(eq(playlists.id, id)).get();
    if (!pl || pl.kind !== "study") return fail(c, new StudyError(404, "学习歌单不存在"));
    if (!canAccessStudyPlaylist(pl, user)) return fail(c, new StudyError(403, "无权访问该歌单"));
    const body = await c.req.json().catch(() => ({}));
    const songId = String(body?.songId || "");
    if (!songId) return fail(c, new StudyError(400, "缺少歌曲 id"));
    const inPlaylist = db.select({ id: playlistSongs.id })
      .from(playlistSongs)
      .where(and(eq(playlistSongs.playlistId, id), eq(playlistSongs.songId, songId))).get();
    if (!inPlaylist) return fail(c, new StudyError(400, "该曲目不在歌单内"));
    const song = db.select().from(songs).where(eq(songs.id, songId)).get();
    if (!song || song.kind !== "study") return fail(c, new StudyError(404, "学习音频不存在"));
    const duration = Math.max(0, Number(body?.durationSec) || song.duration || 0);
    const position = Math.max(0, Number(body?.positionSec) || 0);
    const now = new Date().toISOString();
    db.insert(studyPlaylistProgress).values({
      userId: user.id, playlistId: id, songId, positionSec: position,
      durationSec: duration, updatedAt: now,
    }).onConflictDoUpdate({
      target: [studyPlaylistProgress.userId, studyPlaylistProgress.playlistId],
      set: { songId, positionSec: position, durationSec: duration, updatedAt: now },
    }).run();
    pruneStudyPlaylistProgress(user.id);
    return c.json({ success: true });
  });

  // 清空当前用户全部学习记录(只影响「继续学习」,不删除音频文件)。
  app.delete("/v1/study/progress", permMiddleware(PERM.STUDY_STREAM), (c) => {
    const user = c.get("user");
    if (!user) return fail(c, new StudyError(401, "未登录"));
    db.delete(studyProgress).where(eq(studyProgress.userId, user.id)).run();
    // 歌单续播与单条记录同属「学习记录」,一并清空。
    db.delete(studyPlaylistProgress).where(eq(studyPlaylistProgress.userId, user.id)).run();
    return c.json({ success: true });
  });

  app.delete("/v1/study/progress/:songId", permMiddleware(PERM.STUDY_STREAM), (c) => {
    const user = c.get("user");
    if (!user) return fail(c, new StudyError(401, "未登录"));
    const songId = String(c.req.param("songId") || "");
    if (!songId) return fail(c, new StudyError(400, "缺少歌曲 id"));
    db.delete(studyProgress)
      .where(and(eq(studyProgress.userId, user.id), eq(studyProgress.songId, songId)))
      .run();
    // 该曲目若正是某个歌单的续播位置,也一并移除,避免「删了又出现」。
    db.delete(studyPlaylistProgress)
      .where(and(eq(studyPlaylistProgress.userId, user.id), eq(studyPlaylistProgress.songId, songId)))
      .run();
    return c.json({ success: true });
  });

  app.get("/v1/study/continue", permMiddleware(PERM.STUDY_BROWSE), (c) => {
    const user = c.get("user");
    if (!user) return c.json({ items: [], playlistItems: [] });
    const limit = Math.min(100, Math.max(1, parseInt(c.req.query("limit") || "20") || 20));
    const rows = db.select({ p: studyProgress, s: songs })
      .from(studyProgress)
      .innerJoin(songs, eq(studyProgress.songId, songs.id))
      .where(and(
        eq(studyProgress.userId, user.id),
        eq(studyProgress.finished, 0),
        eq(songs.kind, "study"),
      ))
      .orderBy(desc(studyProgress.updatedAt))
      .limit(limit).all();
    // 学习歌单续播:「继续学习」不只续单条音频,还能整单续播(从上次那一首的位置继续)。
    const playlistRows = db.select({ p: studyPlaylistProgress, s: songs, pl: playlists })
      .from(studyPlaylistProgress)
      .innerJoin(songs, eq(studyPlaylistProgress.songId, songs.id))
      .innerJoin(playlists, eq(studyPlaylistProgress.playlistId, playlists.id))
      .where(and(
        eq(studyPlaylistProgress.userId, user.id),
        eq(songs.kind, "study"),
        eq(playlists.kind, "study"),
        or(eq(playlists.ownerId, user.id), eq(playlists.isPublic, 1)),
      ))
      .orderBy(desc(studyPlaylistProgress.updatedAt))
      .limit(limit).all();
    return c.json({
      items: rows.map((r) => studySongPayload(r.s, {
        positionSec: r.p.positionSec || 0,
        durationSec: r.p.durationSec || r.s.duration || 0,
        progress: r.p.durationSec ? Math.min(1, (r.p.positionSec || 0) / r.p.durationSec) : 0,
        updatedAt: r.p.updatedAt || "",
      })),
      playlistItems: playlistRows.map((r) => studySongPayload(r.s, {
        playlistId: r.pl.id,
        playlistName: r.pl.name,
        positionSec: r.p.positionSec || 0,
        durationSec: r.p.durationSec || r.s.duration || 0,
        progress: r.p.durationSec ? Math.min(1, (r.p.positionSec || 0) / r.p.durationSec) : 0,
        updatedAt: r.p.updatedAt || "",
      })),
    });
  });

  app.get("/v1/study/recent", permMiddleware(PERM.STUDY_BROWSE), (c) => {
    const limit = Math.min(200, Math.max(1, parseInt(c.req.query("limit") || "50") || 50));
    const sourceId = (c.req.query("sourceId") || "").trim();
    const where = sourceId
      ? and(eq(songs.kind, "study"), eq(songs.sourceId, sourceId))
      : eq(songs.kind, "study");
    const rows = db.select().from(songs).where(where).orderBy(desc(songs.createdAt)).limit(limit).all();
    return c.json({ items: rows.map((s) => studySongPayload(s)) });
  });

  app.get("/v1/study/search", permMiddleware(PERM.STUDY_BROWSE), (c) => {
    const q = (c.req.query("q") || c.req.query("query") || "").trim();
    const limit = Math.min(200, Math.max(1, parseInt(c.req.query("limit") || "50") || 50));
    const conds: any[] = [eq(songs.kind, "study")];
    if (q) {
      const kw = `%${q}%`;
      conds.push(or(like(songs.title, kw), like(songs.album, kw), like(songs.relDir, kw)));
    }
    const rows = db.select().from(songs).where(and(...conds)).orderBy(desc(songs.createdAt)).limit(limit).all();
    return c.json({ total: rows.length, items: rows.map((s) => studySongPayload(s)) });
  });

  // ==================== 学习歌单导出 / 导入 ====================

  // 导出单个歌单(format 与音乐歌单一致:app + version + tracks,可回导)。
  app.get("/v1/study/playlists/:id/export", permMiddleware(PERM.STUDY_BROWSE), (c) => {
    const user = c.get("user");
    const id = c.req.param("id")!;
    const pl = db.select().from(playlists).where(eq(playlists.id, id)).get();
    if (!pl || pl.kind !== "study") return fail(c, new StudyError(404, "学习歌单不存在"));
    if (pl.ownerId !== user?.id && !user?.isAdmin) return fail(c, new StudyError(403, "无权导出该歌单"));
    try {
      const payload = buildStudyPlaylistExport(id);
      const filename = `${(payload.name || "学习歌单").replace(/[\\/:*?"<>|]/g, "_")}.json`;
      c.header("Content-Disposition", `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`);
      return c.json({ app: STUDY_EXPORT_APP, version: 1, exportedAt: new Date().toISOString(), ...payload });
    } catch (e) {
      return fail(c, e);
    }
  });

  // 导出当前账号可见的全部学习歌单(管理员导出全部,普通用户导出自己的 + 公开的)。
  app.get("/v1/study/playlists/export-all", permMiddleware(PERM.STUDY_BROWSE), (c) => {
    const user = c.get("user");
    const where = user?.isAdmin
      ? eq(playlists.kind, "study")
      : and(
          eq(playlists.kind, "study"),
          or(eq(playlists.ownerId, user?.id ?? ""), eq(playlists.isPublic, 1)),
        );
    const rows = db.select().from(playlists).where(where).orderBy(desc(playlists.updatedAt)).all();
    const playlistsOut = rows.map((p) => buildStudyPlaylistExport(p.id));
    const filename = `学习歌单_${new Date().toISOString().slice(0, 10)}.json`;
    c.header("Content-Disposition", `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`);
    return c.json({
      app: STUDY_EXPORT_APP,
      version: 1,
      exportedAt: new Date().toISOString(),
      exportAll: true,
      playlists: playlistsOut,
    });
  });

  // 导入学习歌单:同名(同账号)歌单合并,其余新建;曲目先按 songId,再按 relPath 重入库。
  // 重入库可能要读远程文件头,与 /resolve-batch 一样限制并发 4。
  app.post("/v1/study/playlists/import", permMiddleware(PERM.STUDY_STREAM), async (c) => {
    const user = c.get("user");
    if (!user) return fail(c, new StudyError(401, "未登录"));
    const body = await c.req.json().catch(() => ({} as any));
    const raw = body?.native && typeof body.native === "object" ? body.native : body;
    const list: any[] = Array.isArray(raw?.playlists)
      ? raw.playlists
      : (Array.isArray(raw?.tracks) ? [raw] : []);
    if (list.length === 0) return fail(c, new StudyError(400, "不是有效的学习歌单文件"));
    if (list.length > STUDY_IMPORT_MAX_PLAYLISTS) {
      return fail(c, new StudyError(400, `单次最多导入 ${STUDY_IMPORT_MAX_PLAYLISTS} 个学习歌单`));
    }
    // 在子目录(文件夹)内发起导入时,歌单直接归入该文件夹;根目录导入不改变已有歌单归属。
    const targetFolder = ensureStudyFolder(user.id, body?.folder);

    let created = 0;
    let merged = 0;
    let totalTracks = 0;
    let matched = 0;
    let unmatched = 0;
    const results: Array<{ id: string; name: string; added: number; unmatched: number }> = [];

    for (let i = 0; i < list.length; i++) {
      const rawPl = list[i] || {};
      const name = (String(rawPl?.name || "").trim() || `导入的学习歌单 ${i + 1}`).slice(0, 120);
      const tracks: any[] = Array.isArray(rawPl?.tracks) ? rawPl.tracks.slice(0, STUDY_IMPORT_MAX_TRACKS) : [];
      totalTracks += tracks.length;

      // 同名合并按「忽略大小写」匹配,与创建/重命名的唯一性口径一致,避免导入造出重名歌单。
      const nameKey = name.toLocaleLowerCase();
      let pl = db.select().from(playlists)
        .where(and(eq(playlists.kind, "study"), eq(playlists.ownerId, user.id))).all()
        .find((p) => String(p.name || "").trim().toLocaleLowerCase() === nameKey);
      let isNew = false;
      if (!pl) {
        const id = `pl-${Date.now()}-${i}-${Math.random().toString(36).slice(2, 6)}`;
        db.insert(playlists).values({
          id, name, ownerId: user.id, kind: "study",
          isPublic: 0, comment: String(rawPl?.comment || ""), folder: targetFolder,
        }).run();
        pl = db.select().from(playlists).where(eq(playlists.id, id)).get()!;
        isNew = true;
      } else if (targetFolder && (pl.folder || "") !== targetFolder) {
        // 同名歌单已存在时,跟随本次导入位置移入目标文件夹。
        db.update(playlists).set({ folder: targetFolder, updatedAt: new Date().toISOString() })
          .where(eq(playlists.id, pl.id)).run();
      }
      const existing = new Set(
        db.select({ sid: playlistSongs.songId }).from(playlistSongs)
          .where(eq(playlistSongs.playlistId, pl.id)).all().map((r) => r.sid).filter(Boolean) as string[],
      );
      let pos = db.select({ n: sql<number>`count(*)` }).from(playlistSongs)
        .where(eq(playlistSongs.playlistId, pl.id)).get()?.n ?? 0;

      const resolved = await mapLimit(tracks, 4, (t) => resolveImportTrack(t));
      let added = 0;
      let missed = 0;
      for (const songId of resolved) {
        if (!songId) { missed++; continue; }
        matched++;
        if (existing.has(songId)) continue;
        db.insert(playlistSongs).values({ playlistId: pl.id, songId, position: pos++, playable: 1 }).run();
        existing.add(songId);
        added++;
      }
      unmatched += missed;
      refreshPlaylistCounts(pl.id);
      if (isNew) created++; else merged++;
      results.push({ id: pl.id, name: pl.name, added, unmatched: missed });
    }

    return c.json({
      success: true,
      created,
      merged,
      trackCount: totalTracks,
      matched,
      unmatched,
      playlists: results,
    });
  });

  // ==================== 学习歌单 ====================

  app.get("/v1/study/playlists", permMiddleware(PERM.STUDY_BROWSE), (c) => {
    const user = c.get("user");
    const q = (c.req.query("q") || "").trim();
    const conds: any[] = [
      eq(playlists.kind, "study"),
      // 学习歌单属于个人空间:管理员也只看到自己的歌单(与公开歌单),
      // 不再把其他用户创建的学习歌单混进管理员列表。
      or(eq(playlists.ownerId, user?.id ?? ""), eq(playlists.isPublic, 1)),
    ];
    if (q) conds.push(like(playlists.name, `%${q}%`));
    const rows = db.select().from(playlists).where(and(...conds)).orderBy(desc(playlists.updatedAt)).all();
    return c.json({
      items: rows.map((p) => ({
        id: p.id, name: p.name, owner: p.ownerId, public: !!p.isPublic,
        songCount: p.songCount || 0, duration: p.duration || 0,
        coverArt: `pl-${p.id}`, comment: p.comment || "",
        // 文件夹按用户隔离:非本人歌单即使管理员可见,也不暴露其文件夹归属。
        folder: p.ownerId === user?.id ? (p.folder || "") : "",
        created: p.createdAt, changed: p.updatedAt,
      })),
      folders: listStudyFolderNames(user?.id || "", rows),
    });
  });

  app.post("/v1/study/playlists", permMiddleware(PERM.STUDY_BROWSE), async (c) => {
    const user = c.get("user");
    const body = await c.req.json().catch(() => ({}));
    const name = String(body?.name || "").trim();
    if (!name) return fail(c, new StudyError(400, "缺少歌单名称"));
    try {
      assertStudyPlaylistNameFree(user?.id || "", name);
      const folder = ensureStudyFolder(user?.id || "", body?.folder);
      const id = `pl-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
      db.insert(playlists).values({
        id, name, ownerId: user?.id || "", kind: "study", folder,
        isPublic: body?.public ? 1 : 0, comment: String(body?.comment || ""),
      }).run();
      return c.json({ id });
    } catch (e) {
      return fail(c, e);
    }
  });

  // ==================== 歌单文件夹 ====================

  app.get("/v1/study/playlist-folders", permMiddleware(PERM.STUDY_BROWSE), (c) => {
    const user = c.get("user");
    const rows = db.select().from(studyPlaylistFolders)
      .where(eq(studyPlaylistFolders.ownerId, user?.id || "")).all();
    return c.json({ items: rows.map((f) => f.name).sort((a, b) => a.localeCompare(b, "zh-CN")) });
  });

  app.post("/v1/study/playlist-folders", permMiddleware(PERM.STUDY_BROWSE), async (c) => {
    const user = c.get("user");
    if (!user) return fail(c, new StudyError(401, "未登录"));
    const body = await c.req.json().catch(() => ({}));
    const name = normalizeFolderName(body?.name);
    if (!name) return fail(c, new StudyError(400, "缺少文件夹名称"));
    // parent 为空表示根目录;落在某个文件夹内时创建多级子目录。
    const parent = normalizeFolderPath(body?.parent);
    const path = ensureStudyFolder(user.id, parent ? `${parent}/${name}` : name);
    return c.json({ success: true, name: path });
  });

  /** 重命名(或移动)文件夹:旧路径及其所有子目录、歌单归属一起改到新路径。 */
  app.post("/v1/study/playlist-folders/rename", permMiddleware(PERM.STUDY_BROWSE), async (c) => {
    const user = c.get("user");
    if (!user) return fail(c, new StudyError(401, "未登录"));
    const body = await c.req.json().catch(() => ({}));
    const path = normalizeFolderPath(body?.path);
    const nextBase = folderBaseNameOf(normalizeFolderPath(body?.name));
    if (!path) return fail(c, new StudyError(400, "缺少文件夹路径"));
    if (!nextBase) return fail(c, new StudyError(400, "缺少新文件夹名称"));
    const rows = db.select().from(studyPlaylistFolders)
      .where(eq(studyPlaylistFolders.ownerId, user.id)).all();
    if (!rows.some((f) => f.name === path)) return fail(c, new StudyError(404, "文件夹不存在"));
    const newPath = folderParentOf(path) ? `${folderParentOf(path)}/${nextBase}` : nextBase;
    if (newPath === path) return c.json({ success: true, name: newPath });
    if (rows.some((f) => f.name === newPath)) return fail(c, new StudyError(409, "同级已存在同名文件夹"));
    const now = new Date().toISOString();
    for (const f of rows) {
      if (f.name !== path && !f.name.startsWith(path + "/")) continue;
      db.update(studyPlaylistFolders)
        .set({ name: newPath + f.name.slice(path.length), updatedAt: now })
        .where(and(eq(studyPlaylistFolders.ownerId, user.id), eq(studyPlaylistFolders.name, f.name))).run();
    }
    for (const pl of db.select().from(playlists)
      .where(and(eq(playlists.kind, "study"), eq(playlists.ownerId, user.id))).all()) {
      const folder = pl.folder || "";
      if (folder !== path && !folder.startsWith(path + "/")) continue;
      db.update(playlists).set({ folder: newPath + folder.slice(path.length), updatedAt: now })
        .where(eq(playlists.id, pl.id)).run();
    }
    return c.json({ success: true, name: newPath });
  });

  /** 删除文件夹:连同子目录一起解散,里面的歌单回到被删文件夹的上一级。 */
  app.post("/v1/study/playlist-folders/delete", permMiddleware(PERM.STUDY_BROWSE), async (c) => {
    const user = c.get("user");
    if (!user) return fail(c, new StudyError(401, "未登录"));
    const body = await c.req.json().catch(() => ({}));
    const path = normalizeFolderPath(body?.path);
    if (!path) return fail(c, new StudyError(400, "缺少文件夹路径"));
    const parent = folderParentOf(path);
    const rows = db.select().from(studyPlaylistFolders)
      .where(eq(studyPlaylistFolders.ownerId, user.id)).all();
    const targets = rows.map((f) => f.name)
      .filter((name) => name === path || name.startsWith(path + "/"));
    if (targets.length === 0) return c.json({ success: true });
    const now = new Date().toISOString();
    for (const name of targets) {
      db.update(playlists).set({ folder: parent, updatedAt: now })
        .where(and(eq(playlists.kind, "study"), eq(playlists.ownerId, user.id), eq(playlists.folder, name))).run();
      db.delete(studyPlaylistFolders)
        .where(and(eq(studyPlaylistFolders.ownerId, user.id), eq(studyPlaylistFolders.name, name))).run();
    }
    return c.json({ success: true });
  });

  app.put("/v1/study/playlist-folders/:name", permMiddleware(PERM.STUDY_BROWSE), async (c) => {
    const user = c.get("user");
    if (!user) return fail(c, new StudyError(401, "未登录"));
    const oldName = normalizeFolderName(c.req.param("name"));
    const body = await c.req.json().catch(() => ({}));
    const newName = normalizeFolderName(body?.name);
    if (!oldName) return fail(c, new StudyError(400, "缺少文件夹名称"));
    if (!newName) return fail(c, new StudyError(400, "缺少新文件夹名称"));
    const found = db.select().from(studyPlaylistFolders)
      .where(and(eq(studyPlaylistFolders.ownerId, user.id), eq(studyPlaylistFolders.name, oldName))).get();
    if (!found) return fail(c, new StudyError(404, "文件夹不存在"));
    const now = new Date().toISOString();
    db.update(playlists).set({ folder: newName, updatedAt: now })
      .where(and(eq(playlists.kind, "study"), eq(playlists.ownerId, user.id), eq(playlists.folder, oldName))).run();
    db.delete(studyPlaylistFolders)
      .where(and(eq(studyPlaylistFolders.ownerId, user.id), eq(studyPlaylistFolders.name, oldName))).run();
    ensureStudyFolder(user.id, newName);
    return c.json({ success: true, name: newName });
  });

  app.delete("/v1/study/playlist-folders/:name", permMiddleware(PERM.STUDY_BROWSE), (c) => {
    const user = c.get("user");
    if (!user) return fail(c, new StudyError(401, "未登录"));
    const name = normalizeFolderName(c.req.param("name"));
    if (!name) return fail(c, new StudyError(400, "缺少文件夹名称"));
    // 删除文件夹只解散分组:歌单回到根目录,不删歌单本身。
    db.update(playlists).set({ folder: "", updatedAt: new Date().toISOString() })
      .where(and(eq(playlists.kind, "study"), eq(playlists.ownerId, user.id), eq(playlists.folder, name))).run();
    db.delete(studyPlaylistFolders)
      .where(and(eq(studyPlaylistFolders.ownerId, user.id), eq(studyPlaylistFolders.name, name))).run();
    return c.json({ success: true });
  });

  app.delete("/v1/study/playlists/:id", permMiddleware(PERM.STUDY_BROWSE), (c) => {
    const user = c.get("user");
    const id = c.req.param("id")!;
    const pl = db.select().from(playlists).where(eq(playlists.id, id)).get();
    if (!pl || pl.kind !== "study") return fail(c, new StudyError(404, "学习歌单不存在"));
    if (pl.ownerId !== user?.id && !user?.isAdmin) return fail(c, new StudyError(403, "无权删除该歌单"));
    db.delete(playlistSongs).where(eq(playlistSongs.playlistId, id)).run();
    // 歌单删除后其续播记录失去意义,一并清理(所有用户的该歌单进度)。
    db.delete(studyPlaylistProgress).where(eq(studyPlaylistProgress.playlistId, id)).run();
    db.delete(playlists).where(eq(playlists.id, id)).run();
    return c.json({ success: true });
  });

  app.put("/v1/study/playlists/:id", permMiddleware(PERM.STUDY_BROWSE), async (c) => {
    const user = c.get("user");
    const id = c.req.param("id")!;
    const pl = db.select().from(playlists).where(eq(playlists.id, id)).get();
    if (!pl || pl.kind !== "study") return fail(c, new StudyError(404, "学习歌单不存在"));
    if (pl.ownerId !== user?.id && !user?.isAdmin) return fail(c, new StudyError(403, "无权修改该歌单"));
    const body = await c.req.json().catch(() => ({}));
    let nextName: string | undefined;
    if (body?.name !== undefined) {
      nextName = String(body.name || "").trim();
      if (!nextName) return fail(c, new StudyError(400, "缺少歌单名称"));
      try {
        assertStudyPlaylistNameFree(pl.ownerId, nextName, id);
      } catch (e) {
        return fail(c, e);
      }
    }
    db.update(playlists).set({
      ...(nextName !== undefined ? { name: nextName } : {}),
      ...(body?.comment !== undefined ? { comment: String(body.comment) } : {}),
      ...(body?.public !== undefined ? { isPublic: body.public ? 1 : 0 } : {}),
      // folder 传空串 = 移回根目录;非空会自动补建文件夹(按歌单拥有者隔离)。
      ...(body?.folder !== undefined ? { folder: ensureStudyFolder(pl.ownerId, body.folder) } : {}),
      updatedAt: new Date().toISOString(),
    }).where(eq(playlists.id, id)).run();
    return c.json({ success: true });
  });

  app.get("/v1/study/playlists/:id/tracks", permMiddleware(PERM.STUDY_BROWSE), (c) => {
    const user = c.get("user");
    const id = c.req.param("id")!;
    const pl = db.select().from(playlists).where(eq(playlists.id, id)).get();
    if (!pl || pl.kind !== "study") return fail(c, new StudyError(404, "学习歌单不存在"));
    if (!pl.isPublic && pl.ownerId !== user?.id && !user?.isAdmin) return fail(c, new StudyError(403, "无权查看该歌单"));
    const entries = db.select().from(playlistSongs)
      .where(eq(playlistSongs.playlistId, id))
      .orderBy(playlistSongs.position, playlistSongs.id).all();
    const songIds = entries.map((e) => e.songId).filter((x): x is string => !!x);
    const map = songIds.length
      ? new Map(db.select().from(songs).where(and(inArray(songs.id, songIds), eq(songs.kind, "study"))).all().map((s) => [s.id, s]))
      : new Map<string, any>();
    const items = entries.map((e) => {
      const s = e.songId ? map.get(e.songId) : null;
      // 带上所属歌单:Web/客户端播放学习歌单时据此上报「整单续播」位置。
      return s ? { ...studySongPayload(s, { playlistId: id, playlistName: pl.name }), entryId: e.id } : null;
    }).filter(Boolean);
    return c.json({ id, name: pl.name, items, total: items.length });
  });

  // 曲目增删:body { add?: string[], remove?: string[](entryId 或 songId) }
  app.post("/v1/study/playlists/:id/tracks", permMiddleware(PERM.STUDY_BROWSE), async (c) => {
    const user = c.get("user");
    const id = c.req.param("id")!;
    const pl = db.select().from(playlists).where(eq(playlists.id, id)).get();
    if (!pl || pl.kind !== "study") return fail(c, new StudyError(404, "学习歌单不存在"));
    if (pl.ownerId !== user?.id && !user?.isAdmin) return fail(c, new StudyError(403, "无权修改该歌单"));
    const body = await c.req.json().catch(() => ({}));
    const add: string[] = Array.isArray(body?.add) ? body.add.map(String) : [];
    const remove: string[] = Array.isArray(body?.remove) ? body.remove.map(String) : [];
    if (remove.length) {
      for (const key of remove) {
        db.delete(playlistSongs).where(and(eq(playlistSongs.playlistId, id), eq(playlistSongs.songId, key))).run();
      }
    }
    if (add.length) {
      const valid = new Set(
        db.select({ id: songs.id }).from(songs)
          .where(and(inArray(songs.id, add), eq(songs.kind, "study"))).all().map((r) => r.id),
      );
      const existing = new Set(
        db.select({ sid: playlistSongs.songId }).from(playlistSongs)
          .where(eq(playlistSongs.playlistId, id)).all().map((r) => r.sid).filter(Boolean),
      );
      let pos = db.select({ n: sql<number>`count(*)` }).from(playlistSongs).where(eq(playlistSongs.playlistId, id)).get()?.n ?? 0;
      for (const songId of add) {
        if (!valid.has(songId) || existing.has(songId)) continue;
        db.insert(playlistSongs).values({ playlistId: id, songId, position: pos++, playable: 1 }).run();
        existing.add(songId);
      }
    }
    refreshPlaylistCounts(id);
    return c.json({ success: true });
  });

  // 源配置(路径/账号)变更后清目录缓存,避免旧目录继续返回。
  app.post("/v1/study/refresh", permMiddleware(PERM.STUDY_BROWSE), (c) => {
    const sourceId = (c.req.query("sourceId") || "").trim();
    invalidateStudyDirCache(sourceId || undefined);
    return c.json({ success: true });
  });
}
