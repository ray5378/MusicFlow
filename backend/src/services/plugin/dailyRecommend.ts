// Daily-recommend playlist generator — online discovery edition.
//
// Each day at the configured hour, this builds a SINGLE combined「每日推荐」
// playlist from TWO sources (all in ONE playlist):
//
//   1. Remote charts (QQ + NetEase): fetch EVERY candidate in the configured
//      pool (not just one), match against the local library. Matched songs
//      become playable entries; unmatched ones become stubs + wish entries,
//      exactly like a manual playlist import.
//   2. User recommend pool (recommend_pool table): all pool members (every
//      user's favorites + playlists manually added to the pool). Randomly
//      picks 50 PLAYABLE songs (guaranteed in the library).
//
// 2026-08-13 职责收敛:不再做「本地曲库随机补充」——本地口味推荐由
// local-recommend 插件独立生成「本地推荐」歌单(pl-daily-local),两歌单不重复。
//
// Dedup: pool songs are deduplicated against the remote-matched songs already
// in the playlist so the same track never appears twice.
//
// STABLE ID (only ONE playlist ever exists, with a FIXED id):
//   - "每日推荐"  — today's combined playlist (id: pl-daily-today)
//
// The id is FIXED and never changes across days. Each run rebuilds today's
// content fresh into the same fixed「每日推荐」row (rebuildPlaylistEntries
// clears the old entries first); the previous day's content is simply
// discarded — no "昨日推荐" archive is kept anymore.
// This keeps clients (web/app/HA/card) able to reference the playlist by a
// constant id, and avoids the daily CREATE+DELETE of playlist rows and the
// daily create+delete of cover files (the cover file name is now stable too).
//
// Failure safety: remote fetches happen BEFORE any DB mutation, so if all
// networks are down, existing playlists are untouched.
import { sqlite } from "../../db/index.js";
import { importPlaylistFromUrl } from "./playlistImport.js";
import { rebuildPlaylistEntries } from "./playlistSync.js";
import { clearLibraryIndex } from "./libraryIndex.js";
import { clearPlaylistCoverCache, pickDailyRotatedCover } from "../playlistCover.js";
import { getPluginConfig } from "../../plugins/registry.js";
import { todayStr, systemOwnerId } from "./shared.js";
import type { PluginManifest, RecommenderPlugin } from "../../plugins/types.js";
import { createLogger } from "../../utils/logger.js";

const log = createLogger("DAILY-RECOMMEND");
export interface DailyCandidate {
  platform: "qq" | "netease";
  url: string;
  name?: string;
}

export interface DailyRecommendResult {
  date: string;
  playlistId: string;
  name: string;
  picked: DailyCandidate[];          // all candidates fetched this run
  platform: string;                   // "mixed"
  total: number;                      // total entries (matched + stubs + pool + random)
  matched: number;                    // remote songs matched to local library
  unmatched: number;                  // remote songs that became stubs
  wishAdded: number;
  poolSongsAdded: number;             // songs added from user recommend pool
  poolMembers: number;                // how many pool members contributed
  randomSongsAdded: number;           // songs added from full-library random pick
  skipped: boolean;
}

export const DAILY_TAG = "[daily-recommend]";
export const DAILY_TAG_LOCAL = "[daily-recommend-local]";

// Fixed playlist id — this NEVER changes, so clients can reference the daily
// playlist by a stable id.
export const FIXED_TODAY_ID = "pl-daily-today";

// 歌单名:「每日推荐」(与插件名 daily-recommend「每日推荐」一致)。
// 本地曲库口味推荐由 local-recommend「本地推荐」歌单独立承担,不再混入本歌单。
const NAME_TODAY = "每日推荐";

// 首页顶部「今日推荐 + 随机歌单」展示张数(含今日推荐),由本插件配置 homeCount 控制。
export const DEFAULT_HOME_COUNT = 8;
export const MAX_HOME_COUNT = 24;

/** 读本插件配置里的首页随机歌单数(1~24,默认 8)。非法/未配置时回落默认值。 */
export function getDailyHomeCount(): number {
  try {
    const row = sqlite.prepare("SELECT config FROM plugins WHERE name = ? AND enabled = 1").get(DAILY_RECOMMEND_PLUGIN_ID) as any;
    const cfg = row?.config ? JSON.parse(row.config) : {};
    const raw = parseInt(String(cfg.homeCount), 10);
    if (Number.isFinite(raw) && raw >= 1) return Math.min(raw, MAX_HOME_COUNT);
    return DEFAULT_HOME_COUNT;
  } catch {
    return DEFAULT_HOME_COUNT;
  }
}

// How many random playable songs to pull from each user-pool member as
// CANDIDATES (before the final pool-wide pick).
const POOL_MEMBER_CANDIDATE_SIZE = 200;
// Final size of the user-recommend-pool contribution to the daily playlist.
// Candidates from all pool members are merged, deduped, then this many are
// picked with a date-seeded shuffle.
const POOL_FINAL_SIZE = 50;

function dayOfYear(d: Date): number {
  const start = new Date(d.getFullYear(), 0, 0);
  return Math.floor((d.getTime() - start.getTime()) / 86400000);
}

// ===== 手动刷新用的随机盐 =====
// 生成逻辑是「日期种子确定性随机」:同一天默认重跑结果一致(幂等)。
// 手动刷新(force)时,路由会给一个随机 seedSalt,混入所有 PRNG 种子,
// 让同一天也能刷出不同的内容。默认 0 = 保持原有确定性行为。
let activeSeedSalt = 0;

/** 当前生效的随机盐(供各种子计算混入)。 */
function seedSalt(): number {
  return activeSeedSalt;
}

/** 日期种子 + 随机盐:同一天(同盐)确定性,不同盐结果不同。 */
function dateSeed(d: Date, mult: number, add = 0): number {
  return dayOfYear(d) * mult + add + seedSalt();
}

// mulberry32 PRNG — deterministic per (seed, index) so the same day always
// picks the same 50 songs from a given pool member.
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Charts excluded from the candidate pool per user request:
//   - QQ音乐·巅峰榜新歌 (toplist/27)   — name contains "新歌"
//   - QQ音乐·巅峰榜欧美 (toplist/60)   — name contains "欧美"
//   - 网易云·新歌榜     (playlist?id=3779629) — name contains "新歌"
// These are filtered out in loadCandidates() as a safety net so that even if
// someone adds them via the admin API, they will never be fetched.
const BLOCKED_CANDIDATE_URL_PATTERNS: RegExp[] = [
  /toplist\/27\b/i,          // QQ 巅峰榜新歌
  /toplist\/60\b/i,          // QQ 巅峰榜欧美
  /[?&]id=3779629\b/i,       // 网易云 新歌榜
];
const BLOCKED_CANDIDATE_NAME_KEYWORDS: string[] = ["新歌", "欧美"];

export function isCandidateBlocked(c: { platform?: string; url?: string; name?: string }): boolean {
  const url = (c.url || "").trim();
  if (url && BLOCKED_CANDIDATE_URL_PATTERNS.some(re => re.test(url))) return true;
  const name = (c.name || "").trim();
  if (name && BLOCKED_CANDIDATE_NAME_KEYWORDS.some(kw => name.includes(kw))) return true;
  return false;
}

// 默认候选榜单(admin 未配置时使用):网易云编辑榜 + QQ 音乐官方榜混合。
// 从 db/index.ts 的初始化种子迁移而来——候选数据属于「每日推荐」能力,由插件内部声明,
// 核心不再写任何平台榜单 URL。
const DEFAULT_CANDIDATES: DailyCandidate[] = [
  { platform: "netease", url: "https://music.163.com/playlist?id=6723173524", name: "网易云·网络热歌榜" },
  { platform: "qq", url: "https://y.qq.com/n/ryqq/toplist/26", name: "QQ音乐·巅峰榜热歌" },
  { platform: "netease", url: "https://music.163.com/playlist?id=19723756", name: "网易云·飙升榜" },
  { platform: "qq", url: "https://y.qq.com/n/ryqq/toplist/62", name: "QQ音乐·飙升榜" },
  { platform: "netease", url: "https://music.163.com/playlist?id=3778678", name: "网易云·热歌榜" },
  { platform: "qq", url: "https://y.qq.com/n/ryqq/toplist/4", name: "QQ音乐·巅峰榜流行指数" },
  { platform: "netease", url: "https://music.163.com/playlist?id=2884035", name: "网易云·原创榜" },
];

// 读取候选榜单的优先级(UI 配置的权威来源是插件 config JSON 的 candidates 字段):
//   1) 插件配置(plugin config 的 candidates)——用户在插件设置页手动配置/替换;
//   2) 旧的 settings 表(daily_recommend_candidates)——向后兼容旧 admin API;
//   3) 内置 DEFAULT_CANDIDATES——全新安装,且从未手动配置过。
// 任意一层都会被 isCandidateBlocked 过滤(新歌/欧美等始终排除)。
export function loadCandidates(): DailyCandidate[] {
  const fromConfig = loadCandidatesFromPluginConfig();
  if (fromConfig) return fromConfig;
  const fromSettings = loadCandidatesFromSettings();
  if (fromSettings) return fromSettings;
  return DEFAULT_CANDIDATES.filter((c) => !isCandidateBlocked(c));
}

function loadCandidatesFromPluginConfig(): DailyCandidate[] | null {
  const cfg = getPluginConfig(DAILY_RECOMMEND_PLUGIN_ID);
  if (!cfg || !Array.isArray(cfg.candidates)) return null;
  const clean = cleanCandidates(cfg.candidates);
  return clean.length > 0 ? clean : null;
}

function loadCandidatesFromSettings(): DailyCandidate[] | null {
  const row = sqlite.prepare("SELECT value FROM settings WHERE key = ?").get("daily_recommend_candidates") as any;
  if (!row?.value) return null;
  try {
    const arr = JSON.parse(row.value);
    if (!Array.isArray(arr)) return null;
    const clean = cleanCandidates(arr);
    return clean.length > 0 ? clean : null;
  } catch {
    return null;
  }
}

// 仅保留合法项(platform + url 必填)、排除黑名单(新歌/欧美等)、统一字段形状。
function cleanCandidates(arr: any[]): DailyCandidate[] {
  return arr
    .filter((c: any) => c && typeof c.url === "string" && typeof c.platform === "string" && c.platform.trim().length > 0)
    .filter((c: any) => !isCandidateBlocked(c))
    .map((c: any) => ({ platform: c.platform, url: c.url.trim(), name: typeof c.name === "string" ? c.name : undefined }));
}

export function saveCandidates(candidates: DailyCandidate[]): void {
  const clean = cleanCandidates(candidates);
  // 写入插件配置(UI 权威来源)与旧 settings 表(向后兼容)两处,保持一致。
  setPluginConfigCandidates(clean);
  sqlite.prepare("INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES (?, ?, ?)")
    .run("daily_recommend_candidates", JSON.stringify(clean), new Date().toISOString());
}

// 把候选榜单写回插件 config JSON(candidates 字段),其余配置项保持不变。
function setPluginConfigCandidates(candidates: DailyCandidate[]): void {
  const row = sqlite.prepare("SELECT config FROM plugins WHERE name = ?").get(DAILY_RECOMMEND_PLUGIN_ID) as any;
  let cfg: any = {};
  try { cfg = row?.config ? JSON.parse(row.config) : {}; } catch {}
  if (!cfg || typeof cfg !== "object") cfg = {};
  cfg.candidates = candidates;
  sqlite.prepare("UPDATE plugins SET config = ?, updated_at = ? WHERE name = ?")
    .run(JSON.stringify(cfg), new Date().toISOString(), DAILY_RECOMMEND_PLUGIN_ID);
}

function getSetting(key: string, def: string): string {
  const row = sqlite.prepare("SELECT value FROM settings WHERE key = ?").get(key) as any;
  return row?.value ?? def;
}

function getSettingBool(key: string, def: boolean): boolean {
  const v = getSetting(key, def ? "true" : "false");
  return v === "true" || v === "1";
}

// Deterministic pick of today's candidate subset. We fetch ALL candidates but
// rotate the START offset by day, so even if the pool is huge, each day's
// combined mix starts from a different chart. (Kept for API compatibility —
// the admin UI shows what "today's pick" would be.)
export function pickDailyCandidate(date = new Date()): DailyCandidate | null {
  const pool = loadCandidates();
  if (pool.length === 0) return null;
  const seed = dayOfYear(date);
  return pool[seed % pool.length];
}

function findPlaylistByName(name: string, tag: string): any | null {
  const rows = sqlite.prepare("SELECT * FROM playlists WHERE name = ? AND comment LIKE ?").all(name, `%${tag}%`) as any[];
  return rows[0] || null;
}

// True once today's combined playlist has already been (re)generated today.
// We stamp the generation date into the playlist's comment, so idempotency no
// longer depends on created_at (which is now fixed, since the row is reused).
function isGeneratedToday(playlist: any, dateStr: string): boolean {
  return !!(playlist && (playlist.comment || "").includes(dateStr));
}

// Ensure the fixed-id daily playlist exists. On first run (or after an upgrade
// from the old two-playlist scheme) this:
//   - adopts any existing "[daily-recommend]" tagged "今日推荐" playlist into
//     the fixed id (so no content is lost and no duplicate playlists appear), and
//   - creates the fixed row if it's still missing.
//
// Note: existing "昨日推荐" playlists are intentionally NOT deleted here — the
// user may delete them manually. The daily generator simply stops creating or
// updating them.
function ensureDailyPlaylists(): void {
  const todayFixed = sqlite.prepare("SELECT * FROM playlists WHERE id = ?").get(FIXED_TODAY_ID) as any;
  if (!todayFixed) {
    const ownerId = systemOwnerId();
    const now = new Date().toISOString();
    const legacy = findPlaylistByName(NAME_TODAY, DAILY_TAG);
    if (legacy) {
      sqlite.prepare("UPDATE playlists SET id = ?, name = ?, comment = ? WHERE id = ?")
        .run(FIXED_TODAY_ID, NAME_TODAY, `${DAILY_TAG} (migrated)`, legacy.id);
    } else {
      sqlite.prepare(`
        INSERT INTO playlists (id, name, owner_id, is_public, comment, cover_art, source_url, source_platform, external_id, sync_enabled, created_at, updated_at)
        VALUES (?, ?, ?, 1, ?, NULL, NULL, 'mixed', NULL, 0, ?, ?)
      `).run(FIXED_TODAY_ID, NAME_TODAY, ownerId, `${DAILY_TAG}`, now, now);
    }
  } else if (todayFixed.name !== NAME_TODAY) {
    // 2026-08-13 歌单名「今日推荐」→「每日推荐」:升级用户已存在的固定行同步改名。
    sqlite.prepare("UPDATE playlists SET name = ?, updated_at = ? WHERE id = ?")
      .run(NAME_TODAY, new Date().toISOString(), FIXED_TODAY_ID);
  }
}

// Pick the FIRST covered song from a playlist's OWN playable entries (by
// position order) — deterministic, so the cover only changes when the content
// changes (manual refresh re-randomizes content, cover follows it). Song cover
// wins over album cover. Returns the cover file ref, or null if none.
// ==================== User recommend pool ====================

export interface RecommendPoolEntry {
  id: number;
  source_type: string;
  source_id: string;
  source_name: string;
  user_id: string;
  enabled: number;
}

export function listRecommendPool(): RecommendPoolEntry[] {
  return sqlite.prepare("SELECT * FROM recommend_pool WHERE enabled = 1 ORDER BY created_at").all() as RecommendPoolEntry[];
}

// Add a source to the user recommend pool. Idempotent (unique index on
// source_type + source_id). Returns true if newly added, false if already present.
export function addToRecommendPool(sourceType: string, sourceId: string, sourceName: string, userId: string): boolean {
  const existing = sqlite.prepare("SELECT id FROM recommend_pool WHERE source_type = ? AND source_id = ?").get(sourceType, sourceId) as any;
  if (existing) return false;
  const now = new Date().toISOString();
  sqlite.prepare(`
    INSERT INTO recommend_pool (source_type, source_id, source_name, user_id, enabled, created_at, updated_at)
    VALUES (?, ?, ?, ?, 1, ?, ?)
  `).run(sourceType, sourceId, sourceName, userId, now, now);
  return true;
}

export function removeFromRecommendPool(sourceType: string, sourceId: string): boolean {
  const r = sqlite.prepare("DELETE FROM recommend_pool WHERE source_type = ? AND source_id = ?").run(sourceType, sourceId);
  return r.changes > 0;
}

export function isInRecommendPool(sourceType: string, sourceId: string): boolean {
  const row = sqlite.prepare("SELECT id FROM recommend_pool WHERE source_type = ? AND source_id = ?").get(sourceType, sourceId) as any;
  return !!row;
}

// Pick up to `limit` random playable song ids from a pool member.
// For "playlist": from playlist_songs joined to songs where playable=1.
// For "favorites": from user_favorite_songs joined to songs.
//
// Resource strategy (O(limit) — never loads the whole member playlist):
//   - One COUNT(*) + MAX(rowid) to know the rowid range of qualifying rows.
//   - Over-sample random rowids (bounded by 2x the deficit) and fetch only
//     those, so even a pool member with thousands of songs only ever pulls a
//     few hundred candidate ids into memory.
// Uses a date-seeded PRNG so the same day picks the same set (deterministic).
function pickSongsFromPoolMember(entry: RecommendPoolEntry, date: Date, limit: number): string[] {
  const rng = mulberry32(dateSeed(date, 2654435761, entry.id * 40503));
  let candidateIds: string[] = [];
  if (entry.source_type === "playlist") {
    candidateIds = samplePlayablePlaylistSongIds(entry.source_id, rng, limit);
  } else if (entry.source_type === "favorites") {
    candidateIds = sampleFavoriteSongIds(entry.source_id, rng, limit);
  }
  if (candidateIds.length === 0) return [];
  // Deterministic shuffle of the sampled set (same day -> same order).
  for (let i = candidateIds.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [candidateIds[i], candidateIds[j]] = [candidateIds[j], candidateIds[i]];
  }
  return candidateIds.slice(0, limit);
}

// Bounded sampler over a playlist member's playable songs. Uses rowid
// over-sampling so it never loads the entire (possibly huge) playlist.
function samplePlayablePlaylistSongIds(playlistId: string, rng: () => number, limit: number): string[] {
  const meta = sqlite.prepare(`
    SELECT COUNT(*) AS n, MAX(rowid) AS maxR
    FROM playlist_songs WHERE playlist_id = ? AND playable = 1 AND song_id IS NOT NULL
  `).get(playlistId) as { n: number; maxR: number | null };
  if (!meta.n || !meta.maxR) return [];
  const ids = new Set<string>();
  let attempt = 0;
  while (ids.size < limit && attempt < 6) {
    attempt++;
    const want = (limit - ids.size) * 2 + 1;
    const rowids = new Set<number>();
    for (let i = 0; i < want; i++) rowids.add(1 + Math.floor(rng() * meta.maxR!));
    if (rowids.size === 0) break;
    const arr = Array.from(rowids);
    for (let i = 0; i < arr.length; i += 500) {
      const batch = arr.slice(i, i + 500);
      const ph = batch.map(() => "?").join(",");
      const rows = sqlite.prepare(`
        SELECT song_id FROM playlist_songs
        WHERE rowid IN (${ph}) AND playlist_id = ? AND playable = 1 AND song_id IS NOT NULL
      `).all(...batch, playlistId) as { song_id: string }[];
      for (const r of rows) { if (ids.size < limit) ids.add(r.song_id); }
      if (ids.size >= limit) break;
    }
  }
  return Array.from(ids);
}

// Bounded sampler over a user's favorites. Same rowid over-sampling technique.
function sampleFavoriteSongIds(userId: string, rng: () => number, limit: number): string[] {
  const meta = sqlite.prepare(`
    SELECT COUNT(*) AS n, MAX(uf.rowid) AS maxR
    FROM user_favorite_songs uf JOIN songs s ON uf.song_id = s.id
    WHERE uf.user_id = ? AND s.path IS NOT NULL
  `).get(userId) as { n: number; maxR: number | null };
  if (!meta.n || !meta.maxR) return [];
  const ids = new Set<string>();
  let attempt = 0;
  while (ids.size < limit && attempt < 6) {
    attempt++;
    const want = (limit - ids.size) * 2 + 1;
    const rowids = new Set<number>();
    for (let i = 0; i < want; i++) rowids.add(1 + Math.floor(rng() * meta.maxR!));
    if (rowids.size === 0) break;
    const arr = Array.from(rowids);
    for (let i = 0; i < arr.length; i += 500) {
      const batch = arr.slice(i, i + 500);
      const ph = batch.map(() => "?").join(",");
      const rows = sqlite.prepare(`
        SELECT uf.song_id AS song_id FROM user_favorite_songs uf
        JOIN songs s ON uf.song_id = s.id
        WHERE uf.rowid IN (${ph}) AND uf.user_id = ? AND s.path IS NOT NULL
      `).all(...batch, userId) as { song_id: string }[];
      for (const r of rows) { if (ids.size < limit) ids.add(r.song_id); }
      if (ids.size >= limit) break;
    }
  }
  return Array.from(ids);
}

// Collect playable song ids from every enabled pool member, merge+dedupe, then
// pick POOL_FINAL_SIZE with a date-seeded shuffle so the whole pool contributes
// a fixed number of songs to the daily playlist.
function collectPoolSongs(date: Date): { songIds: string[]; members: number } {
  const pool = listRecommendPool();
  if (pool.length === 0) return { songIds: [], members: 0 };
  const all = new Set<string>();
  for (const entry of pool) {
    // Pull candidates (up to POOL_MEMBER_CANDIDATE_SIZE) from each member.
    const ids = pickSongsFromPoolMember(entry, date, POOL_MEMBER_CANDIDATE_SIZE);
    for (const id of ids) all.add(id);
  }
  if (all.size === 0) return { songIds: [], members: pool.length };
  // Date-seeded shuffle of the merged pool, then take POOL_FINAL_SIZE.
  const arr = Array.from(all);
  const rng = mulberry32(dateSeed(date, 2654435761, 99991));
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return { songIds: arr.slice(0, POOL_FINAL_SIZE), members: pool.length };
}

// ==================== Main generation ====================

export async function generateDailyPlaylist(
  date = new Date(),
  opts?: { force?: boolean; seedSalt?: number }
): Promise<DailyRecommendResult> {
  const dateStr = todayStr(date);
  ensureDailyPlaylists();

  const todayRow = sqlite.prepare("SELECT * FROM playlists WHERE id = ?").get(FIXED_TODAY_ID) as any;
  // force=true 时跳过当天幂等,重新触发随机生成;seedSalt 混入随机种子让内容不同。
  if (!opts?.force && isGeneratedToday(todayRow, dateStr)) {
    return {
      date: dateStr,
      playlistId: FIXED_TODAY_ID,
      name: NAME_TODAY,
      picked: [],
      platform: "mixed",
      total: 0, matched: 0, unmatched: 0, wishAdded: 0,
      poolSongsAdded: 0, poolMembers: 0,
      randomSongsAdded: 0,
      skipped: true,
    };
  }

  // 手动刷新:设置随机盐,结束后恢复(保证默认行为仍是确定性)。
  const prevSalt = activeSeedSalt;
  if (opts?.force) activeSeedSalt = Number.isFinite(opts.seedSalt) ? opts.seedSalt! : Math.floor(Math.random() * 1_000_000);
  try {
    return await doGenerate(date, dateStr, todayRow);
  } finally {
    activeSeedSalt = prevSalt;
  }
}

async function doGenerate(date: Date, dateStr: string, todayRow: any): Promise<DailyRecommendResult> {
  const candidates = loadCandidates();
  const ownerId = systemOwnerId();

  // Step 1: fetch ALL remote playlists, but merge + dedupe INCREMENTALLY — a
  // single seenTrackKeys set and one combined array, each playlist's track
  // array dropped the moment it's folded in. (Old code kept every fetched
  // playlist's full `tracks` array in remoteImports AND a separate flatMap +
  // filter copy until after the rebuild — 3x the track objects held at once.)
  // Failures are logged but don't abort the run — we still want pool songs +
  // local mix to work.
  const dedupedTracks: any[] = [];
  const seenTrackKeys = new Set<string>();
  const sourceNames: string[] = [];
  let totalRemoteTracks = 0;
  for (const c of candidates) {
    try {
      const imported = await importPlaylistFromUrl(c.url);
      totalRemoteTracks += imported.tracks.length;
      if (imported.name) sourceNames.push(imported.name);
      for (const t of imported.tracks) {
        const key = `${t.externalId}|${t.title}|${t.artist}`;
        if (seenTrackKeys.has(key)) continue;
        seenTrackKeys.add(key);
        dedupedTracks.push(t);
      }
      log.info(`[DAILY-RECOMMEND] fetched ${c.platform} "${c.name || c.url}": ${imported.tracks.length} tracks`);
    } catch (e: any) {
      log.error(`fetch failed for ${c.platform} "${c.name || c.url}": ${e.message || e}`);
    }
  }

  // Step 2: collect user pool songs.
  const { songIds: poolSongIds, members: poolMembers } = collectPoolSongs(date);

  // If we have nothing at all (no remote, no pool), bail out without touching
  // the existing playlist — better to keep today's previous content than to
  // have an empty one. (本地曲库推荐已由 local-recommend「本地推荐」歌单独立承担,
  // 每日推荐只做在线发现:榜单候选 + 用户推荐池。)
  if (totalRemoteTracks === 0 && poolSongIds.length === 0) {
    throw new Error("每日推荐生成失败:所有远程榜单抓取失败且用户推荐池为空");
  }

  // ============ Rebuild today's fixed-id playlist ============
  // rebuildPlaylistEntries clears today's existing entries and inserts the new
  // remote-matched tracks. The previous day's content is simply discarded —
  // there is no "昨日推荐" archive anymore.
  const now = new Date().toISOString();
  const playlistId = FIXED_TODAY_ID;

  const sourceLabel = sourceNames.join(" + ") || "用户推荐池";
  const extraParts: string[] = [];
  if (poolMembers > 0) extraParts.push(`${poolMembers}个用户推荐池`);

  // Seed remote tracks via rebuildPlaylistEntries (matching + stubs + wishes).
  let matched = 0, unmatched = 0, wishAdded = 0;
  if (dedupedTracks.length > 0) {
    const result = await rebuildPlaylistEntries(playlistId, {
      name: NAME_TODAY,
      platform: "mixed",
      tracks: dedupedTracks,
    }, {
      userId: ownerId,
      autoWish: true,
      notes: `来自今日推荐组合`,
    });
    matched = result.matched;
    unmatched = result.unmatched;
    wishAdded = result.wishAdded;
    // rebuild 完成后立即释放远程轨道引用 + 曲库索引,进入 pool/local 阶段前
    // 把峰值压下来(大候选集时最占内存的两个结构)。
    dedupedTracks.length = 0;
    seenTrackKeys.clear();
    clearLibraryIndex(); // 今日推荐生成结束,立即回收曲库索引缓存
  }

  // Collect song_ids already in the playlist (from remote matching)
  // so we can dedup pool songs and local songs against them.
  const existingSongIds = new Set<string>(
    sqlite.prepare("SELECT song_id FROM playlist_songs WHERE playlist_id = ?").all(playlistId)
      .map((r: any) => r.song_id as string)
  );

  // Append pool songs as playable entries, DEDUPED against remote-matched songs.
  let poolSongsAdded = 0;
  const dedupedPoolIds = poolSongIds.filter(id => !existingSongIds.has(id));
  if (dedupedPoolIds.length > 0) {
    // Determine next position.
    const maxPosRow = sqlite.prepare("SELECT MAX(position) AS m FROM playlist_songs WHERE playlist_id = ?").get(playlistId) as any;
    let nextPos = (maxPosRow?.m ?? -1) + 1;

    // Fetch durations.
    const idToDuration = new Map<string, number>();
    for (let i = 0; i < dedupedPoolIds.length; i += 500) {
      const batch = dedupedPoolIds.slice(i, i + 500);
      const placeholders = batch.map(() => "?").join(",");
      const rows = sqlite.prepare(`SELECT id, duration FROM songs WHERE id IN (${placeholders})`).all(...batch) as { id: string; duration: number }[];
      for (const r of rows) idToDuration.set(r.id, r.duration || 0);
    }

    const now2 = new Date().toISOString();
    const insertStmt = sqlite.prepare(`
      INSERT INTO playlist_songs (playlist_id, song_id, position, playable, created_at)
      VALUES (?, ?, ?, 1, ?)
    `);
    let addedDuration = 0;
    const tx = sqlite.transaction((ids: string[]) => {
      for (const id of ids) {
        insertStmt.run(playlistId, id, nextPos++, now2);
        addedDuration += idToDuration.get(id) || 0;
        poolSongsAdded++;
        existingSongIds.add(id);
      }
    });
    tx(dedupedPoolIds);

    // Update counts.
    const plRow = sqlite.prepare("SELECT song_count, duration FROM playlists WHERE id = ?").get(playlistId) as any;
    sqlite.prepare("UPDATE playlists SET song_count = ?, duration = ?, updated_at = ? WHERE id = ?")
      .run((plRow?.song_count || 0) + poolSongsAdded, (plRow?.duration || 0) + addedDuration, now2, playlistId);
  }

  // 封面:取歌单自身可播条目中某首有封面歌曲的封面 ref(同一首封面每天固定,
  // 跨天自动轮换成另一首的封面;被其它固定推荐歌单占用的 ref 自动跳过,保证各
  // 固定歌单封面两两不同)。无封面时清掉旧缓存文件。
  let coverRef: string | null = null;
  const ownCover = pickDailyRotatedCover(playlistId, { dateStr });
  if (ownCover) {
    coverRef = ownCover;
  } else {
    clearPlaylistCoverCache(playlistId);
  }

  // Finalize the TODAY row: stamp the generation date into the comment (for
  // idempotency), set the new cover, and refresh timestamps.
  sqlite.prepare("UPDATE playlists SET cover_art = ?, comment = ?, updated_at = ? WHERE id = ?")
    .run(
      coverRef,
      `${DAILY_TAG} ${dateStr} 组合自「${sourceLabel}」${extraParts.length > 0 ? ` + ${extraParts.join(" + ")}` : ""}`,
      now,
      playlistId
    );

  return {
    date: dateStr,
    playlistId,
    name: NAME_TODAY,
    picked: candidates,
    platform: "mixed",
    total: matched + unmatched + poolSongsAdded,
    matched,
    unmatched,
    wishAdded,
    poolSongsAdded,
    poolMembers,
    randomSongsAdded: 0,
    skipped: false,
  };
}

export async function runDailyRecommendJob(opts?: { force?: boolean; seedSalt?: number }): Promise<DailyRecommendResult | null> {
  if (!getSettingBool("daily_recommend_enabled", true)) return null;
  // Fresh installs have no local library yet; generating "今日推荐" from empty
  // would only create a playlist full of non-playable remote stubs. Skip until
  // the user actually has songs.
  const localCount = sqlite.prepare("SELECT COUNT(*) AS n FROM songs WHERE suffix IS NOT NULL AND path IS NOT NULL").get() as { n: number };
  if (!localCount || localCount.n === 0) {
    log.info("[DAILY-RECOMMEND] local library empty, skipping today's recommendation");
    return null;
  }
  try {
    const result = await generateDailyPlaylist(new Date(), opts);
    if (!result.skipped) {
      log.info(`[DAILY-RECOMMEND] ${result.date}: ${result.picked.length} charts + ${result.poolMembers} pool members -> ${result.matched} matched, ${result.unmatched} stubs, ${result.wishAdded} wishes, ${result.poolSongsAdded} pool`);
    }
    return result;
  } catch (e: any) {
    log.error("error", { err: e.message || e });
    return null;
  }
}

// Backward-compat no-op (rename mechanism handles retention).
export function purgeOldDailyPlaylists(_retentionDays: number): number {
  return 0;
}

// ==================== Plugin (recommender) ====================
//
// Registered as a `recommender` plugin so the daily scheduler picks it up by
// capability ("dailyPlaylist") instead of importing runDailyRecommendJob
// directly. localRecommend is a SEPARATE plugin (localPlaylist) generating its
// own「本地推荐」歌单 — see localRecommend.ts.

export const DAILY_RECOMMEND_PLUGIN_ID = "daily-recommend";

export const dailyRecommendManifest: PluginManifest = {
  id: DAILY_RECOMMEND_PLUGIN_ID,
  name: "每日推荐",
  version: "1.0.0",
  type: "recommender",
  description: "每天生成「每日推荐」歌单:平台榜单候选 + 用户推荐池成员(在线发现新歌)",
  capabilities: ["dailyPlaylist"],
  defaultEnabled: true,
  configSchema: [
    {
      key: "candidates",
      label: "推荐榜单",
      type: "candidate-list",
      help: "每日推荐从哪些平台榜单抓取候选歌曲(每项一个榜单 URL)。已预填常用榜单,可手动替换 / 增删;至少保留 1 个。",
      default: DEFAULT_CANDIDATES,
    },
    { key: "homeCount", label: "首页随机歌单数", type: "number", help: "首页顶部「今日漫游 + 随机歌单」共展示的歌单张数(含今日漫游固定卡,1~24,默认 8)" },
    { key: "showOnHome", label: "在首页显示", type: "switch", default: false, help: "是否把本插件生成的歌单固定在首页顶部展示(按下方位次排序)" },
    { key: "homePosition", label: "首页显示位次", type: "number", default: 0, help: "首页顶部固定展示的第几张(1 起)。0 = 未固定。与其它开了「在首页显示」的插件位次不能重复,保存时会自动校验。" },
  ],
  // 每日推荐歌单标识:OpenSubsonic 等核心侧据此识别「每日推荐」(原直连 DAILY_TAG 常量,现已声明化)。
  dailyTag: "每日推荐",
  // 首页展示时对应的固定歌单(核心按此聚合首页固定卡,不写死歌单 id)。
  homePlaylistId: FIXED_TODAY_ID,
  documentation: `### 功能介绍
每天自动生成「每日推荐」歌单（id：\`pl-daily-today\`），聚焦**在线发现新歌**：平台榜单候选 + 用户推荐池成员。

### 处理逻辑
1. 定时器按 \`dailyPlaylist\` 能力调用本插件的 \`runDailyJob()\`（默认每天 03:00，可改系统时间设置）；
2. 收集曲目：\`recommend_pool\` 表里的推荐池成员（用户在歌单或「我喜欢的音乐」上点「加入每日推荐池」写入）+ 平台榜单候选；
3. 合并去重后写入 \`pl-daily-today\`（覆盖当天旧版）。

### 说明
- **职责边界**：本地曲库口味推荐由 \`local-recommend\` 插件独立生成「本地推荐」歌单，本歌单不做本地随机补充，两歌单内容不重复；
- 远程榜单全部抓取失败且推荐池为空时保留旧歌单，不报错（等网络恢复后自动重建）；
- 配置项 \`推荐榜单\`：在插件设置页可直接编辑「每日推荐」抓取哪些平台榜单（已预填网易云/QQ 常用榜单，可手动替换、增删，至少保留 1 个）；修改后次日生成或手动触发即生效；
- 配置项 \`homeCount\`：首页顶部「今日漫游 + 随机歌单」共展示张数（含今日漫游固定卡，1~24，默认 8）；
- 停用本插件即不再更新「每日推荐」歌单。`,
};

export const dailyRecommendPlugin: RecommenderPlugin = {
  manifest: dailyRecommendManifest,
  async runDailyJob(opts?: { force?: boolean; seedSalt?: number }): Promise<string | null> {
    const r = await runDailyRecommendJob(opts);
    if (!r || r.skipped) return null;
    return `${r.date}: ${r.matched} matched, ${r.unmatched} stubs, ${r.poolSongsAdded} pool`;
  },
  // 参数化能力:路由经 registry 门面调用,核心不直连本文件。
  loadCandidates(): DailyCandidate[] { return loadCandidates(); },
  saveCandidates(candidates: DailyCandidate[]): void { saveCandidates(candidates); },
  pickDailyCandidate(date?: Date) { return pickDailyCandidate(date); },
  generateDailyPlaylist(date?: Date, opts?: { force?: boolean; seedSalt?: number }) {
    return generateDailyPlaylist(date, opts);
  },
  isCandidateBlocked(c: { platform?: string; url?: string; name?: string }): boolean { return isCandidateBlocked(c); },
  listRecommendPool(): RecommendPoolEntry[] { return listRecommendPool(); },
  addToRecommendPool(sourceType: string, sourceId: string, sourceName: string, userId: string): boolean {
    return addToRecommendPool(sourceType, sourceId, sourceName, userId);
  },
  removeFromRecommendPool(sourceType: string, sourceId: string): boolean {
    return removeFromRecommendPool(sourceType, sourceId);
  },
  isInRecommendPool(sourceType: string, sourceId: string): boolean {
    return isInRecommendPool(sourceType, sourceId);
  },
  getHomeCount(): number { return getDailyHomeCount(); },
};
