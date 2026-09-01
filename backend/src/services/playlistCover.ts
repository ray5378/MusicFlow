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
import { songs, albums, playlists } from "../db/schema.js";
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
    try {
      // 目录内校验:归一化(ref 可能含 ../ 或绝对路径)后,解析结果必须落在封面目录
      // 内,否则拒绝——堵死经 getCoverArt 裸 id 等入口的路径穿越(任意文件读取)。
      const p = path.resolve(dir, ref);
      if (p !== dir && !p.startsWith(dir + path.sep)) continue;
      if (fs.existsSync(p)) { resolved = p; break; }
    } catch { /* 非法 ref(如空字节)→ 跳过该目录 */ }
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

/**
 * 复制一份已缓存的平台封面到新 ref(`<destSongId>` + 与源同扩展名)。
 * 供导入批量去重:同一远程封面 URL 被歌单里多首歌引用时,只下载一次到首个
 * ref,后续歌曲据此本地复制字节,避免重复网络拉取 + 重复落盘。失败返回 null
 * (调用方回落 cacheRemoteCover 正常下载)。写入平台封面目录,保持在线封面可独立挂卷。
 */
export function copyOnlineCoverToRef(srcFileName: string, destSongId: string): string | null {
  const src = resolveCoverFile(srcFileName);
  if (!src) return null;
  const ext = path.extname(src).toLowerCase() || ".jpg";
  const destFileName = `${destSongId}${ext}`;
  const destPath = path.join(ONLINE_COVERS_DIR, destFileName);
  try {
    ensureDir();
    fs.copyFileSync(src, destPath);
    invalidateCoverResolve(destFileName);
    return destFileName;
  } catch {
    return null;
  }
}

/** 清空封面路径解析缓存(文件不动,仅内存条目;供空闲内存回收)。 */
export function clearCoverResolveCache(): void {
  resolveCache.clear();
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

// 共享:取歌单自身可播条目中所有「有封面」歌曲的封面**文件名**列表
// (按 position 顺序、去重、且确保在封面目录真实存在,resolveCoverFile 校验)。
// 优先级:opts.preferSongId 指定歌曲的封面(歌曲封面 > 专辑封面)排最前;随后按
// 条目 position 顺序扫歌单(歌曲封面 > 专辑封面)。opts.excludeRefs 提供要排挤
// 掉的封面 ref 集合(供多张固定推荐卡封面互不重复)。单条聚合 SQL + 少量候选,
// 替代旧 N+1 逐条循环。供内置推荐插件(dailyRecommend/dailyRoam/localRecommend)
// 与外置歌单宿主(discovery)统一使用。
export interface CoverPickOptions {
  preferSongId?: string | null;
  /** 需要忽略的封面 ref(返回列表中将完全排除,用于多歌单封面互斥)。 */
  excludeRefs?: string[];
}

export function listPlayableCoverRefs(playlistId: string, opts?: CoverPickOptions): string[] {
  const exclude = new Set<string>(opts?.excludeRefs ?? []);
  const result: string[] = [];
  const seen = new Set<string>();

  const pushRef = (ref: string | null | undefined) => {
    if (!ref) return;
    if (exclude.has(ref) || seen.has(ref)) return;
    if (!resolveCoverFile(ref)) return;
    seen.add(ref);
    result.push(ref);
  };

  const prefer = opts?.preferSongId;
  if (prefer) {
    const p = sqlite.prepare(`
      SELECT s.cover_art AS songCover, a.cover_art AS albumCover
      FROM songs s LEFT JOIN albums a ON a.id = s.album_id
      WHERE s.id = ?
    `).get(prefer) as { songCover: string | null; albumCover: string | null } | undefined;
    const c = p ? (p.songCover && p.songCover.trim() ? p.songCover : p.albumCover || null) : null;
    pushRef(c);
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
  for (const r of rows) pushRef(r.coverFile);
  return result;
}

/** 取歌单自身可播条目中「第一首有封面」的歌曲封面**文件名**(列表首项)。 */
export function firstPlayableCoverFile(playlistId: string, opts?: CoverPickOptions): string | null {
  return listPlayableCoverRefs(playlistId, opts)[0] ?? null;
}

/**
 * 按天轮换取歌单封面:列表按 position 去重排序后,用「距 epoch 的天数」对列表
 * 长度取模 —— 同一天确定(内容不变则封面固定),跨天自动轮换一张(内容不变也换)。
 *
 * 封面源图 id 锁(数据库级互斥,取代旧的进程内认领表):固定推荐歌单的封面互斥
 * 记录持久化在 playlist_cover_claims(date_key, playlist_id, cover_ref)——
 *   - 锁单元 = 封面源图 ref(源歌曲/专辑封面文件名,封面直接引用源图 id,无独立拷贝);
 *   - 任何进程(batch 子进程 / 主进程 / 手动刷新)与任何执行时序都共享同一把锁,
 *     重启后依然有效,从根本杜绝「内存认领表跨进程失效」类问题;
 *   - DB UNIQUE(date_key, cover_ref) 强约束:同一天一个源图 ref 至多被一个歌单占用;
 *   - 候选全部被其它歌单占用时返回 null(该歌单当天无封面),绝不回退撞车。
 * opts.excludeRefs 可额外指定禁用的 ref(供手动指定封面等场景)。
 * opts.dateStr 供调用方注入当日 YYYY-MM-DD(默认取系统当天,与 todayStr 同源)。
 */
const CLAIMS_TTL_DAYS = 7; // 锁只保留最近 7 天,防止表无界增长

/** 测试/重跑用:清空全部封面源图 id 锁(仅清锁表,不动歌单封面)。 */
export function resetDailyCoverClaims(): void {
  sqlite.prepare("DELETE FROM playlist_cover_claims").run();
}

/**
 * 幂等 skip 路径用:把歌单当天的实际封面同步进锁表(先删己再插,抢占式)。
 * 保证「当天已生成、直接跳过」时锁表仍反映歌单真实封面,后续歌单生成时正确排除。
 */
export function syncCoverClaim(playlistId: string, dateKey: string, coverRef: string | null | undefined): void {
  if (!dateKey) return;
  sqlite.prepare("DELETE FROM playlist_cover_claims WHERE date_key = ? AND playlist_id = ?").run(dateKey, playlistId);
  if (coverRef) {
    sqlite.prepare(
      "INSERT OR IGNORE INTO playlist_cover_claims (date_key, playlist_id, cover_ref, updated_at) VALUES (?, ?, ?, ?)"
    ).run(dateKey, playlistId, coverRef, new Date().toISOString());
  }
}

export function pickDailyRotatedCover(playlistId: string, opts?: CoverPickOptions & { dateStr?: string }): string | null {
  const s = opts?.dateStr;
  const d = s ? new Date(`${s}T00:00:00Z`) : new Date();
  const dateKey = s ?? `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  const dayIndex = Math.floor(Date.parse(`${dateKey}T00:00:00Z`) / 86400000);

  // 顺带清理过期锁(量小,每次调用一次 DELETE)。按「本次 dateKey 往前推 TTL」清理,
  // 而非按当前时间 —— 回退日期生成 / 跨时区场景下本次使用的 dateKey 不会被误删,
  // 该天的互斥锁始终完整保留。
  const cutoffTs = Date.parse(`${dateKey}T00:00:00Z`) - CLAIMS_TTL_DAYS * 86400000;
  const cutoff = new Date(cutoffTs);
  const cutoffKey = `${cutoff.getUTCFullYear()}-${String(cutoff.getUTCMonth() + 1).padStart(2, "0")}-${String(cutoff.getUTCDate()).padStart(2, "0")}`;
  sqlite.prepare("DELETE FROM playlist_cover_claims WHERE date_key < ?").run(cutoffKey);

  const extra = opts?.excludeRefs ?? [];
  // 最多重试 3 次:极端并发下 INSERT OR IGNORE 可能被其它进程抢先认领同一 ref,
  // 重读当前锁表重选(事务内读-选-删-插,SQLite 单写者串行化,竞态窗口极小)。
  for (let attempt = 0; attempt < 3; attempt++) {
    const picked = sqlite.transaction((): string | null | "RETRY" => {
      const others = (sqlite.prepare(
        "SELECT cover_ref FROM playlist_cover_claims WHERE date_key = ? AND playlist_id <> ?"
      ).all(dateKey, playlistId) as { cover_ref: string }[]).map((r) => r.cover_ref);
      const exclude = new Set<string>([...others, ...extra]);

      const refs = listPlayableCoverRefs(playlistId, { preferSongId: opts?.preferSongId, excludeRefs: [...exclude] });
      let pick: string | null;
      if (refs.length === 0) {
        // 候选全部被其它固定歌单占用 → 当天无可用封面。返回 null 而非回退撞车,
        // 从根本保证任意两张固定卡不会共用同一张源图。
        pick = null;
      } else {
        pick = refs[dayIndex % refs.length];
      }
      if (!pick) return null;

      // 先删自己的当天认领(允许更新自己的锁定 ref),再 INSERT OR IGNORE:
      // 同歌单重复调用 → 正常覆盖;与其它歌单并发抢同一 ref → UNIQUE 冲突被忽略。
      sqlite.prepare("DELETE FROM playlist_cover_claims WHERE date_key = ? AND playlist_id = ?").run(dateKey, playlistId);
      const r = sqlite.prepare(
        "INSERT OR IGNORE INTO playlist_cover_claims (date_key, playlist_id, cover_ref, updated_at) VALUES (?, ?, ?, ?)"
      ).run(dateKey, playlistId, pick, new Date().toISOString());
      if (r.changes === 0) return "RETRY"; // 同一天该 ref 已被其它歌单占用
      return pick;
    })();
    if (picked !== "RETRY") return picked;
  }
  return null;
}

// Resolve playlist cover: serve the local cover image if it exists on disk.
// Returns { file, mime } or null (UI falls back to the placeholder).
// Do NOT create a permanent pl-<playlistId>.jpg cache here — that would freeze
// the cover to the first song's artwork and prevent daily rotation for fixed
// recommend playlists. The coverArt is set by the daily generation job or by
// import processes; if the file doesn't exist on disk, just return null.
export function getPlaylistCover(playlistId: string): { file: string; mime: string } | null {
  const playlist = db.select().from(playlists).where(eq(playlists.id, playlistId)).get();
  if (!playlist) return null;

  // Serve the coverArt file if it exists on disk (probe both dirs).
  if (playlist.coverArt && /\.(jpg|jpeg|png|gif)$/i.test(playlist.coverArt)) {
    if (resolveCoverFile(playlist.coverArt)) {
      return { file: playlist.coverArt, mime: mimeFor(playlist.coverArt) };
    }
  }

  return null;
}
