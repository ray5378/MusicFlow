// Local daily-recommend playlist generator (Plan B).
//
// 2026-08-13 起恢复独立生成并支持配置化:插件每天独立生成「本地推荐」歌单
// (固定 id `pl-daily-local`),歌曲来源与数量均可配置:
//   - sourcePlaylists(可多选,本地+平台歌单):从选定的歌单池抽取歌曲;
//     留空则按播放口味(play_history + 收藏)从全库推荐。
//   - count:生成的歌单歌曲总数(默认 50)。
//   - excludeRecent:是否排除近期播放过的歌曲(默认开)。
//
// 抽取算法:date-seeded 确定性随机(同一天相同顺序,不同天不同),保证每天内容
// 稳定可复现;无口味数据且未选歌单池时全库随机兜底。
import { sqlite } from "../../db/index.js";
import { todayStr, systemOwnerId } from "./shared.js";
import type { LocalRecommendPlugin, PluginManifest } from "../../plugins/types.js";
import { pickDailyRotatedCover, syncCoverClaim } from "../playlistCover.js";
import { createLogger } from "../../utils/logger.js";

const log = createLogger("LOCAL-RECOMMEND");
export const HISTORY_WINDOW_DAYS = 30;
export const TOP_ARTISTS = 12;
export const TOP_ALBUMS = 8;
export const TOP_GENRES = 6;
// 默认生成的歌曲总数(可经插件配置 count 覆盖,1~500)。
export const DEFAULT_SONG_COUNT = 50;
export const MAX_SONG_COUNT = 500;

export const DAILY_TAG_LOCAL = "[daily-recommend-local]";

/** 读本插件配置:参考歌单池 / 歌曲总数 / 排除近期播放。非法或未配置回落默认。 */
export function getLocalRecommendConfig(): { sourcePlaylists: string[]; count: number; excludeRecent: boolean } {
  try {
    const row = sqlite.prepare("SELECT config FROM plugins WHERE name = ? AND enabled = 1").get(LOCAL_RECOMMEND_PLUGIN_ID) as any;
    const cfg = row?.config ? JSON.parse(row.config) : {};
    const ids = Array.isArray(cfg.sourcePlaylists)
      ? cfg.sourcePlaylists.filter((x: any) => typeof x === "string" && x.length > 0)
      : [];
    const rawCount = parseInt(String(cfg.count), 10);
    const count = Number.isFinite(rawCount) && rawCount >= 1 ? Math.min(rawCount, MAX_SONG_COUNT) : DEFAULT_SONG_COUNT;
    const excludeRecent = cfg.excludeRecent !== false;
    return { sourcePlaylists: ids, count, excludeRecent };
  } catch {
    return { sourcePlaylists: [], count: DEFAULT_SONG_COUNT, excludeRecent: true };
  }
}

export interface LocalRecommendResult {
  date: string;
  playlistId: string;
  name: string;
  total: number;
  sourceUsers: number; // how many users contributed history
  fallback: boolean;   // true if we fell back to library random sample
  skipped: boolean;
}

function dayOfYear(d: Date): number {
  const start = new Date(d.getFullYear(), 0, 0);
  return Math.floor((d.getTime() - start.getTime()) / 86400000);
}

// ===== 手动刷新用的随机盐 =====
// 生成逻辑是「日期种子确定性随机」:同一天默认重跑结果一致(幂等)。
// 手动刷新(force)时,路由会给一个随机 seedSalt,混入所有 PRNG 种子,
// 让同一天也能刷出不同的内容。默认 0 = 保持原有确定性行为。
let activeSeedSalt = 0;
function seedSalt(): number {
  return activeSeedSalt;
}
function dateSeed(d: Date, mult: number, add = 0): number {
  return dayOfYear(d) * mult + add + seedSalt();
}

// Tiny seeded PRNG (mulberry32) so the same day produces the same shuffle,
// but two different days produce visibly different orders.
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Aggregate the taste profile across ALL users (daily mixes are global in this
// self-hosted, usually single-household setup). Returns ranked lists of artist
// ids, album ids, and genres, plus the set of song ids the user recently
// played (so we can exclude them from the daily mix).
interface TasteProfile {
  artists: { id: string; score: number }[];
  albums: { id: string; score: number }[];
  genres: { id: string; score: number }[]; // id is the genre name
  recentSongIds: Set<string>;
  userCount: number;
}

function buildTasteProfile(): TasteProfile {
  const since = new Date(Date.now() - HISTORY_WINDOW_DAYS * 86400000).toISOString();

  // 方案1:play_history 用 rowid 游标分批读取,避免一次把窗口内全部播放记录载入内存
  // (重度使用场景可达几十万行)。聚合(weight 累加)与顺序无关,分批结果与一次性读取等价。
  const userCountRow = sqlite.prepare(`
    SELECT COUNT(DISTINCT user_id) AS n FROM play_history WHERE played_at >= ?
  `).get(since) as { n: number };

  const songScores = new Map<string, number>();
  const recentSongIds = new Set<string>();
  const nowMs = Date.now();
  const PLAY_HISTORY_BATCH = 2000;
  let cursor = 0;
  for (;;) {
    const playRows = sqlite.prepare(`
      SELECT song_id, played_at, rowid AS rid FROM play_history
      WHERE played_at >= ? AND rowid > ?
      ORDER BY rowid ASC LIMIT ?
    `).all(since, cursor, PLAY_HISTORY_BATCH) as { song_id: string; played_at: string; rid: number }[];
    if (playRows.length === 0) break;
    for (const r of playRows) {
      const t = new Date(r.played_at).getTime() || nowMs;
      const ageDays = Math.max(0, (nowMs - t) / 86400000);
      const weight = Math.max(0.05, 1 - ageDays / HISTORY_WINDOW_DAYS);
      songScores.set(r.song_id, (songScores.get(r.song_id) || 0) + weight);
      recentSongIds.add(r.song_id);
    }
    cursor = playRows[playRows.length - 1].rid;
    if (playRows.length < PLAY_HISTORY_BATCH) break;
  }

  // Favorites count as a strong, non-decaying signal.
  const favRows = sqlite.prepare(`SELECT song_id FROM user_favorite_songs`).all() as { song_id: string }[];
  for (const r of favRows) {
    songScores.set(r.song_id, (songScores.get(r.song_id) || 0) + 2.0);
  }

  // Aggregate to artist / album / genre.
  const artistScores = new Map<string, number>();
  const albumScores = new Map<string, number>();
  const genreScores = new Map<string, number>();

  const songIds = Array.from(songScores.keys());
  if (songIds.length > 0) {
    for (let i = 0; i < songIds.length; i += 500) {
      const batch = songIds.slice(i, i + 500);
      const placeholders = batch.map(() => "?").join(",");
      const rows = sqlite.prepare(`
        SELECT id, artist_id, album_id, genre FROM songs WHERE id IN (${placeholders})
      `).all(...batch) as { id: string; artist_id: string | null; album_id: string | null; genre: string | null }[];
      for (const s of rows) {
        const w = songScores.get(s.id) || 0;
        if (s.artist_id) artistScores.set(s.artist_id, (artistScores.get(s.artist_id) || 0) + w);
        if (s.album_id) albumScores.set(s.album_id, (albumScores.get(s.album_id) || 0) + w);
        const g = (s.genre || "").trim();
        if (g) genreScores.set(g, (genreScores.get(g) || 0) + w);
      }
    }
  }

  const top = (m: Map<string, number>, k: number) =>
    Array.from(m.entries()).map(([id, score]) => ({ id, score })).sort((a, b) => b.score - a.score).slice(0, k);

  return {
    artists: top(artistScores, TOP_ARTISTS),
    albums: top(albumScores, TOP_ALBUMS),
    genres: top(genreScores, TOP_GENRES),
    recentSongIds,
    userCount: userCountRow.n || 0,
  };
}

// Pull ALL candidate songs from the local library based on the taste profile,
// excluding recently played ones. No size cap — returns everything that matches.
function pickCandidateSongs(profile: TasteProfile, date: Date): string[] {
  const excludeIds = profile.recentSongIds;
  const seen = new Set<string>();
  const candidates: { id: string; rank: number }[] = [];

  const addFromArtistIds = (artistIds: string[], weight: number) => {
    if (artistIds.length === 0) return;
    const placeholders = artistIds.map(() => "?").join(",");
    const rows = sqlite.prepare(`
      SELECT id FROM songs
      WHERE artist_id IN (${placeholders}) AND suffix IS NOT NULL AND path IS NOT NULL
    `).all(...artistIds) as { id: string }[];
    for (const r of rows) {
      if (excludeIds.has(r.id) || seen.has(r.id)) continue;
      seen.add(r.id);
      candidates.push({ id: r.id, rank: weight });
    }
  };

  const addFromAlbumIds = (albumIds: string[], weight: number) => {
    if (albumIds.length === 0) return;
    const placeholders = albumIds.map(() => "?").join(",");
    const rows = sqlite.prepare(`
      SELECT id FROM songs
      WHERE album_id IN (${placeholders}) AND suffix IS NOT NULL AND path IS NOT NULL
    `).all(...albumIds) as { id: string }[];
    for (const r of rows) {
      if (excludeIds.has(r.id) || seen.has(r.id)) continue;
      seen.add(r.id);
      candidates.push({ id: r.id, rank: weight });
    }
  };

  const addFromGenres = (genres: string[], weight: number) => {
    if (genres.length === 0) return;
    const placeholders = genres.map(() => "?").join(",");
    const rows = sqlite.prepare(`
      SELECT id FROM songs
      WHERE genre IN (${placeholders}) AND suffix IS NOT NULL AND path IS NOT NULL
    `).all(...genres) as { id: string }[];
    for (const r of rows) {
      if (excludeIds.has(r.id) || seen.has(r.id)) continue;
      seen.add(r.id);
      candidates.push({ id: r.id, rank: weight });
    }
  };

  // Tiered weighting: top artists > top albums > top genres
  addFromArtistIds(profile.artists.map(a => a.id), 3);
  addFromAlbumIds(profile.albums.map(a => a.id), 2);
  addFromGenres(profile.genres.map(g => g.id), 1);

  // Deterministic shuffle with date seed: rank weights the probability, but
  // the seed makes the same day reproducible.
  const rng = mulberry32(dateSeed(date, 2654435761));
  for (const c of candidates) {
    (c as any).key = Math.pow(rng(), 1 / Math.max(0.1, c.rank));
  }
  candidates.sort((a, b) => (b as any).key - (a as any).key);

  return candidates.map(c => c.id);
}

// Fallback: when there's no history, pull ALL songs from the library with a
// deterministic shuffle (no size cap).
function pickRandomSample(date: Date): string[] {
  const total = sqlite.prepare("SELECT COUNT(*) AS n FROM songs WHERE suffix IS NOT NULL AND path IS NOT NULL").get() as { n: number };
  if (!total.n) return [];
  // Fetch all song ids and shuffle deterministically by date seed.
  const rows = sqlite.prepare("SELECT id FROM songs WHERE suffix IS NOT NULL AND path IS NOT NULL").all() as { id: string }[];
  const rng = mulberry32(dateSeed(date, 40503, 1));
  // Fisher-Yates shuffle with the seeded RNG.
  for (let i = rows.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [rows[i], rows[j]] = [rows[j], rows[i]];
  }
  return rows.map(r => r.id);
}

// Pick `limit` random song ids from the ENTIRE local library (playable only),
// deterministically seeded by date so the same day yields the same set.
//
// Resource strategy (O(limit) — never loads the whole library):
//   1. One COUNT(*) + one MAX(rowid) to know the rowid range.
//   2. Generate `limit * 2` random rowids in [1, maxRowid] with the date-seeded
//      PRNG (over-sampling absorbs rowid gaps from deletes).
//   3. Fetch by `rowid IN (...)` — uses the rowid primary index, so each batch
//      is ~O(log N) per row, total O(limit log N). No full-table scan.
//   4. If we still don't have `limit` hits (rare, very sparse table), top up
//      with one more over-sampled batch.
// This avoids both `ORDER BY RANDOM()` (full scan + sort) and loading all ids
// into memory.
export function pickRandomLibrarySongs(date: Date, limit: number): string[] {
  const meta = sqlite.prepare("SELECT COUNT(*) AS n, MAX(rowid) AS maxR FROM songs WHERE suffix IS NOT NULL AND path IS NOT NULL").get() as { n: number; maxR: number | null };
  if (!meta.n || !meta.maxR) return [];
  const rng = mulberry32(dateSeed(date, 774631, 7));
  const maxRowid = meta.maxR;

  // Small library: just return everything shuffled (cheap enough).
  if (meta.n <= limit) {
    const rows = sqlite.prepare("SELECT id FROM songs WHERE suffix IS NOT NULL AND path IS NOT NULL").all() as { id: string }[];
    for (let i = rows.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      [rows[i], rows[j]] = [rows[j], rows[i]];
    }
    return rows.map(r => r.id);
  }

  const ids = new Set<string>();
  let attempt = 0;
  while (ids.size < limit && attempt < 4) {
    attempt++;
    // Over-sample 2x to absorb rowid gaps from deletes.
    const want = (limit - ids.size) * 2;
    const rowids = new Set<number>();
    for (let i = 0; i < want; i++) {
      // random rowid in [1, maxRowid]
      rowids.add(1 + Math.floor(rng() * maxRowid));
    }
    if (rowids.size === 0) break;
    const idArr = Array.from(rowids);
    for (let i = 0; i < idArr.length; i += 500) {
      const batch = idArr.slice(i, i + 500);
      const placeholders = batch.map(() => "?").join(",");
      const rows = sqlite.prepare(
        `SELECT id FROM songs WHERE rowid IN (${placeholders}) AND suffix IS NOT NULL AND path IS NOT NULL`
      ).all(...batch) as { id: string }[];
      for (const r of rows) {
        if (ids.size < limit) ids.add(r.id);
      }
      if (ids.size >= limit) break;
    }
  }

  // Deterministic shuffle of the final set.
  const out = Array.from(ids);
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

function getSettingBool(key: string, def: boolean): boolean {
  const row = sqlite.prepare("SELECT value FROM settings WHERE key = ?").get(key) as any;
  const v = row?.value ?? (def ? "true" : "false");
  return v === "true" || v === "1";
}

/** 近期播放过的歌曲 id 集合(「排除近期播放」用)。 */
function recentlyPlayedSongIds(): Set<string> {
  const since = new Date(Date.now() - HISTORY_WINDOW_DAYS * 86400000).toISOString();
  const rows = sqlite.prepare("SELECT DISTINCT song_id FROM play_history WHERE played_at >= ?").all(since) as { song_id: string }[];
  return new Set(rows.map((r) => r.song_id));
}

/** 从用户选定的歌单池抽取 `limit` 首可播放歌曲(date-seeded 确定性随机,多歌单合并去重)。 */
function pickFromPlaylistPool(date: Date, playlistIds: string[], limit: number, excludeRecent: boolean): string[] {
  if (!playlistIds.length) return [];
  const recentIds = excludeRecent ? recentlyPlayedSongIds() : new Set<string>();
  const ph = playlistIds.map(() => "?").join(",");
  const rows = sqlite.prepare(`
    SELECT DISTINCT ps.song_id AS id FROM playlist_songs ps
    JOIN songs s ON ps.song_id = s.id
    WHERE ps.playlist_id IN (${ph}) AND ps.playable = 1 AND ps.song_id IS NOT NULL
  `).all(...playlistIds) as { id: string }[];
  const all = new Set<string>();
  for (const r of rows) {
    if (!recentIds.has(r.id)) all.add(r.id);
  }
  const arr = Array.from(all);
  if (!arr.length) return [];
  const rng = mulberry32(dateSeed(date, 774631, 11));
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr.slice(0, limit);
}

// Pick local-recommend song ids based on play-history taste profile (or a
// user-selected playlist pool — see plugin config). Capped at configured count.
// Returns { songIds, sourceUsers, fallback }.
export function pickLocalRecommendSongs(date: Date): { songIds: string[]; sourceUsers: number; fallback: boolean } {
  if (!getSettingBool("daily_recommend_local_enabled", true)) {
    return { songIds: [], sourceUsers: 0, fallback: false };
  }
  const { sourcePlaylists, count, excludeRecent } = getLocalRecommendConfig();

  // 配置了参考歌单池 → 优先从池抽取(本地+平台歌单均可)
  if (sourcePlaylists.length > 0) {
    const fromPool = pickFromPlaylistPool(date, sourcePlaylists, count, excludeRecent);
    if (fromPool.length) return { songIds: fromPool, sourceUsers: 0, fallback: false };
    // 池内无可播放歌曲 → 回落口味推荐
  }

  const profile = buildTasteProfile();
  let songIds = pickCandidateSongs(profile, date);
  let fallback = false;
  if (songIds.length < 5) {
    songIds = pickRandomSample(date);
    fallback = true;
  }
  // Cap to configured count — candidates are already deterministically
  // shuffled, so slicing keeps the daily mix focused (not the whole library).
  if (songIds.length > count) {
    songIds = songIds.slice(0, count);
  }
  return { songIds, sourceUsers: profile.userCount, fallback };
}

// Build today's local daily playlist.
//
// 2026-08-13 起恢复独立生成:local-recommend 独立生成「本地推荐」歌单
// (固定 id `pl-daily-local`,本地口味/参考歌单池歌曲)。
// 命名/保留:固定 id `pl-daily-local` + 歌单名「本地推荐」,每天重建内容,
// 当天幂等(comment 含日期)。daily-recommend 的「每日推荐」只做在线发现,
// 两歌单内容不重复。
export const LOCAL_FIXED_PLAYLIST_ID = "pl-daily-local";
const NAME_LOCAL = "本地推荐";

export async function generateLocalDailyPlaylist(
  date = new Date(),
  opts?: { force?: boolean; seedSalt?: number }
): Promise<LocalRecommendResult | null> {
  const dateStr = todayStr(date);
  const ownerId = systemOwnerId();
  const now = new Date().toISOString();

  let row = sqlite.prepare("SELECT * FROM playlists WHERE id = ?").get(LOCAL_FIXED_PLAYLIST_ID) as any;
  if (!row) {
    sqlite.prepare(`
      INSERT INTO playlists (id, name, owner_id, is_public, comment, cover_art, source_url, source_platform, external_id, sync_enabled, created_at, updated_at)
      VALUES (?, ?, ?, 1, ?, NULL, NULL, '', NULL, 0, ?, ?)
    `).run(LOCAL_FIXED_PLAYLIST_ID, NAME_LOCAL, ownerId, DAILY_TAG_LOCAL, now, now);
    row = sqlite.prepare("SELECT * FROM playlists WHERE id = ?").get(LOCAL_FIXED_PLAYLIST_ID) as any;
  } else if (row.name !== NAME_LOCAL) {
    // 2026-08-13 歌单名「每日推荐」→「本地推荐」:已存在的固定行同步改名。
    sqlite.prepare("UPDATE playlists SET name = ?, updated_at = ? WHERE id = ?")
      .run(NAME_LOCAL, now, LOCAL_FIXED_PLAYLIST_ID);
    row.name = NAME_LOCAL;
  }
  // 当天幂等:comment 含今天日期 = 今天已生成过(与 daily-recommend 同机制;
  // 不能用 created_at 前缀——行是固定的,created_at 始终是首次创建那天)
  if (!opts?.force && (row.comment || "").includes(dateStr)) {
    // 幂等跳过:把当天实际封面同步进封面源图 id 锁表,保证后续固定歌单正确排除。
    syncCoverClaim(LOCAL_FIXED_PLAYLIST_ID, dateStr, row.cover_art);
    return { date: dateStr, playlistId: LOCAL_FIXED_PLAYLIST_ID, name: NAME_LOCAL, total: 0, sourceUsers: 0, fallback: false, skipped: true };
  }

  // 手动刷新:设置随机盐,结束后恢复(保证默认行为仍是确定性)。
  const prevSalt = activeSeedSalt;
  if (opts?.force) activeSeedSalt = Number.isFinite(opts.seedSalt) ? opts.seedSalt! : Math.floor(Math.random() * 1_000_000);
  try {
    return await doGenerateLocal(date, dateStr, row);
  } finally {
    activeSeedSalt = prevSalt;
  }
}

async function doGenerateLocal(date: Date, dateStr: string, row: any): Promise<LocalRecommendResult | null> {
  const ownerId = systemOwnerId();
  const now = new Date().toISOString();
  const { songIds, sourceUsers, fallback } = pickLocalRecommendSongs(date);
  if (!songIds.length) {
    return { date: dateStr, playlistId: LOCAL_FIXED_PLAYLIST_ID, name: NAME_LOCAL, total: 0, sourceUsers, fallback, skipped: true };
  }

  // 重建内容:清空旧 entries 再插入
  sqlite.prepare("DELETE FROM playlist_songs WHERE playlist_id = ?").run(LOCAL_FIXED_PLAYLIST_ID);
  const insert = sqlite.prepare("INSERT INTO playlist_songs (playlist_id, song_id, position, playable, created_at) VALUES (?, ?, ?, 1, ?)");
  const tx = sqlite.transaction((ids: string[]) => {
    ids.forEach((id, pos) => insert.run(LOCAL_FIXED_PLAYLIST_ID, id, pos, now));
  });
  tx(songIds);

  // 时长合计
  const ph = songIds.map(() => "?").join(",");
  const durRows = sqlite.prepare(`SELECT duration FROM songs WHERE id IN (${ph})`).all(...songIds) as { duration: number }[];
  const totalDuration = durRows.reduce((s, r) => s + (r.duration || 0), 0);

  // 封面:取歌单自身可播条目中某首有封面歌曲的封面 ref(按天轮换;当天已被其它
  // 固定歌单认领的封面自动跳过,保证各固定歌单封面两两不同)。
  let cover: string | null = null;
  if (songIds.length > 0) {
    cover = pickDailyRotatedCover(LOCAL_FIXED_PLAYLIST_ID, { dateStr });
  }

  sqlite.prepare("UPDATE playlists SET song_count = ?, duration = ?, cover_art = ?, comment = ?, updated_at = ? WHERE id = ?")
    .run(songIds.length, totalDuration, cover, `${DAILY_TAG_LOCAL} ${dateStr} 本地口味推荐`, now, LOCAL_FIXED_PLAYLIST_ID);

  return {
    date: dateStr,
    playlistId: LOCAL_FIXED_PLAYLIST_ID,
    name: NAME_LOCAL,
    total: songIds.length,
    sourceUsers,
    fallback,
    skipped: false,
  };
}

// Top-level entry for the scheduler. Never throws.
export async function runLocalDailyRecommendJob(opts?: { force?: boolean; seedSalt?: number }): Promise<LocalRecommendResult | null> {
  try {
    return await generateLocalDailyPlaylist(new Date(), opts);
  } catch (e: any) {
    log.error("error", { err: e?.message || e });
    return null;
  }
}

// ==================== Plugin (recommender, localPlaylist) ====================
//
// Registered as a `recommender` plugin so the daily generator pulls the
// local-library mix through the capability ("localPlaylist") instead of
// importing pickLocalRecommendSongs() directly. When enabled, the taste-
// profile mix replaces the plain full-library random sample in 今日推荐.

export const LOCAL_RECOMMEND_PLUGIN_ID = "local-recommend";

export const localRecommendManifest: PluginManifest = {
  id: LOCAL_RECOMMEND_PLUGIN_ID,
  name: "本地推荐引擎",
  version: "1.0.0",
  type: "recommender",
  description: "基于播放历史与收藏口味,每天独立生成「本地推荐」歌单(本地曲库)",
  capabilities: ["localPlaylist"],
  defaultEnabled: true,
  configSchema: [
    { key: "sourcePlaylists", label: "参考歌单", type: "playlist-multi", help: "从这些歌单中抽取歌曲生成「本地推荐」(支持本地与平台导入歌单,可多选,可搜索)。留空则按播放口味从全库推荐。" },
    { key: "count", label: "歌曲总数", type: "number", default: 50, help: "生成的歌单歌曲总数量(1~500,默认 50)" },
    { key: "excludeRecent", label: "排除近期播放", type: "switch", default: true, help: "从候选中排除近 30 天播放过的歌曲,让每天推荐更新鲜" },
    { key: "showOnHome", label: "在首页显示", type: "switch", default: false, help: "是否把本插件生成的歌单固定在首页顶部展示(按下方位次排序)" },
    { key: "homePosition", label: "首页显示位次", type: "number", default: 0, help: "首页顶部固定展示的第几张(1 起)。0 = 未固定。与其它开了「在首页显示」的插件位次不能重复,保存时会自动校验。" },
  ],
  // 首页展示时对应的固定歌单(核心按此聚合首页固定卡,不写死歌单 id)。
  homePlaylistId: LOCAL_FIXED_PLAYLIST_ID,
  documentation: `### 功能介绍
基于播放历史与收藏口味，每天从本地曲库独立生成「本地推荐」歌单（固定 id：\`pl-daily-local\`），回味你常听的口味。

### 处理逻辑
1. 定时器按 \`localPlaylist\` 能力调用本插件的 \`runDailyJob()\`（每天与每日推荐同步，可改系统时间设置）；
2. 按配置抽取歌曲：
   - 配置了「参考歌单」（本地 / 平台导入歌单，可多选）：从这些歌单的歌曲中确定性随机抽取，生成总数由「歌曲总数」控制；
   - 未配置参考歌单：统计近期播放历史与收藏（\`play_history\` / \`user_favorite_songs\`），给艺术家 / 专辑 / 风格打分，按口味加权抽取；
3. 写入「本地推荐」歌单（覆盖当天旧版）。

### 说明
- **职责边界**：在线发现新歌由 \`daily-recommend\` 的「每日推荐」歌单承担（榜单 + 推荐池），本歌单只做本地口味，两歌单内容不重复；
- 「排除近期播放」开启时，候选会剔除近 30 天播放过的歌曲；
- 无播放历史 / 曲库为空时输出空结果，不报错；
- 停用本插件后「本地推荐」歌单不再更新。`,
};

export const localRecommendPlugin: LocalRecommendPlugin = {
  manifest: localRecommendManifest,
  async pickSongs(date = new Date()) {
    return pickLocalRecommendSongs(date);
  },
  async runDailyJob(opts?: { force?: boolean; seedSalt?: number }): Promise<string | null> {
    const r = await runLocalDailyRecommendJob(opts);
    if (!r || r.skipped) return null;
    return `${r.date}: ${r.total} 首本地推荐 (${r.sourceUsers} 用户, ${r.fallback ? "全库随机兜底" : "口味推荐"})`;
  },
  generateLocalDailyPlaylist(date?: Date, opts?: { force?: boolean; seedSalt?: number }) {
    return generateLocalDailyPlaylist(date, opts);
  },
};
