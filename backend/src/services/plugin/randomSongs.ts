// ==================== 随机歌曲插件(recommender / recommendPlaylist) ====================
//
// 从全部曲库随机抽取歌曲,维护一个「实时更新」的固定歌单 pl-random-songs:
//   - 客户端(音流)「随心听」与主项目前端直接读这个歌单,走现有歌单接口,零新增接口;
//   - 惰性刷新:歌单被读取(getPlaylist)时若距上次生成超过 refreshMinutes,立即重建,
//     客户端播完一轮再来取时歌单必然已刷新好 → 消除「现场生成导致的空白等待」;
//   - 定时刷新:refreshMinutes(默认 30 分钟)后台自动重抽兜底;
//   - 容量默认 count=48(客户端一轮 24 首的两倍,留足缓冲),可配置;
//   - showOnHome 控制是否在主项目前端首页展示「随机歌曲」卡片(复用首页固定卡机制)。
//
// 抽取算法:全库随机 O(limit) 方案(COUNT + rowid 采样,不整表加载),每次刷新
// 用 Math.random() 非确定性抽样,保证每次内容不同(区别于 daily/local 的日期确定性)。

import { sqlite } from "../../db/index.js";
import { systemOwnerId } from "./shared.js";
import { pickDailyRotatedCover } from "../playlistCover.js";
import { createLogger } from "../../utils/logger.js";
import type { PluginManifest } from "../../plugins/types.js";

const log = createLogger("RANDOM-SONGS");

export const RANDOM_PLAYLIST_ID = "pl-random-songs";
export const RANDOM_PLUGIN_ID = "random-songs";
const RANDOM_TAG = "[random-songs]";
const PLAYLIST_NAME = "随机歌曲";

export const DEFAULT_SONG_COUNT = 48;
export const MAX_SONG_COUNT = 500;
export const DEFAULT_REFRESH_MINUTES = 30;

export interface RandomSongsConfig {
  count: number;
  refreshMinutes: number;
}

/** 读本插件配置:歌曲总数 / 刷新间隔。非法或未配置回落默认。 */
export function getRandomSongsConfig(): RandomSongsConfig {
  try {
    const row = sqlite
      .prepare("SELECT config FROM plugins WHERE name = ? AND enabled = 1")
      .get(RANDOM_PLUGIN_ID) as any;
    const cfg = row?.config ? JSON.parse(row.config) : {};
    const rawCount = parseInt(String(cfg.count), 10);
    const count =
      Number.isFinite(rawCount) && rawCount >= 1
        ? Math.min(rawCount, MAX_SONG_COUNT)
        : DEFAULT_SONG_COUNT;
    const rawRefresh = parseInt(String(cfg.refreshMinutes), 10);
    const refreshMinutes =
      Number.isFinite(rawRefresh) && rawRefresh >= 1
        ? Math.min(rawRefresh, 1440)
        : DEFAULT_REFRESH_MINUTES;
    return { count, refreshMinutes };
  } catch {
    return { count: DEFAULT_SONG_COUNT, refreshMinutes: DEFAULT_REFRESH_MINUTES };
  }
}

/** 上次生成时间(歌单 updated_at)。歌单不存在返回 0。 */
function lastRefreshMs(): number {
  const row = sqlite
    .prepare("SELECT updated_at FROM playlists WHERE id = ?")
    .get(RANDOM_PLAYLIST_ID) as any;
  if (!row?.updated_at) return 0;
  return new Date(row.updated_at).getTime() || 0;
}

/** 可播歌曲总数(随机抽取的候选源)。 */
function playableSongCount(): number {
  const row = sqlite
    .prepare("SELECT COUNT(*) AS n FROM songs WHERE suffix IS NOT NULL AND path IS NOT NULL")
    .get() as { n: number };
  return row?.n || 0;
}

/** 从全部可播曲库随机抽取 limit 首(O(limit),不整表加载;非确定性,每次不同)。 */
function pickRandomPlayableSongs(limit: number): string[] {
  const meta = sqlite
    .prepare("SELECT COUNT(*) AS n, MAX(rowid) AS maxR FROM songs WHERE suffix IS NOT NULL AND path IS NOT NULL")
    .get() as { n: number; maxR: number | null };
  if (!meta.n || !meta.maxR) return [];
  const maxRowid = meta.maxR;

  // 小曲库:直接全量洗牌返回。
  if (meta.n <= limit) {
    const rows = sqlite
      .prepare("SELECT id FROM songs WHERE suffix IS NOT NULL AND path IS NOT NULL")
      .all() as { id: string }[];
    for (let i = rows.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [rows[i], rows[j]] = [rows[j], rows[i]];
    }
    return rows.map((r) => r.id);
  }

  // 大曲库:在 rowid 范围内过采样随机取样(rowid 主键索引,每批 O(log N)),
  // 过采样 2 倍吸收删除产生的空洞,不足再补一批。
  const ids = new Set<string>();
  let attempt = 0;
  while (ids.size < limit && attempt < 4) {
    attempt++;
    const want = (limit - ids.size) * 2;
    const rowids = new Set<number>();
    for (let i = 0; i < want; i++) {
      rowids.add(1 + Math.floor(Math.random() * maxRowid));
    }
    if (rowids.size === 0) break;
    const idArr = Array.from(rowids);
    for (let i = 0; i < idArr.length; i += 500) {
      const batch = idArr.slice(i, i + 500);
      const placeholders = batch.map(() => "?").join(",");
      const rows = sqlite
        .prepare(
          `SELECT id FROM songs WHERE rowid IN (${placeholders}) AND suffix IS NOT NULL AND path IS NOT NULL`,
        )
        .all(...batch) as { id: string }[];
      for (const r of rows) {
        if (ids.size < limit) ids.add(r.id);
      }
      if (ids.size >= limit) break;
    }
  }

  const out = Array.from(ids);
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/** 重建「随机歌曲」歌单(覆盖旧内容)。返回 null 表示曲库为空/无可抽取歌曲。 */
export function generateRandomSongsPlaylist(
  count?: number,
): { total: number; skipped: boolean } | null {
  const ownerId = systemOwnerId();
  const now = new Date().toISOString();
  const { count: cfgCount } = getRandomSongsConfig();
  const limit = count && count > 0 ? count : cfgCount;

  if (playableSongCount() === 0) return { total: 0, skipped: true };

  // 保证歌单行存在。
  let row = sqlite.prepare("SELECT * FROM playlists WHERE id = ?").get(RANDOM_PLAYLIST_ID) as any;
  if (!row) {
    sqlite
      .prepare(
        `INSERT INTO playlists (id, name, owner_id, is_public, comment, cover_art, source_url, source_platform, external_id, sync_enabled, created_at, updated_at)
         VALUES (?, ?, ?, 1, ?, NULL, NULL, '', NULL, 0, ?, ?)`,
      )
      .run(RANDOM_PLAYLIST_ID, PLAYLIST_NAME, ownerId, RANDOM_TAG, now, now);
    row = sqlite.prepare("SELECT * FROM playlists WHERE id = ?").get(RANDOM_PLAYLIST_ID) as any;
  } else if (row.name !== PLAYLIST_NAME) {
    sqlite
      .prepare("UPDATE playlists SET name = ?, updated_at = ? WHERE id = ?")
      .run(PLAYLIST_NAME, now, RANDOM_PLAYLIST_ID);
  }

  const songIds = pickRandomPlayableSongs(limit);
  if (!songIds.length) return { total: 0, skipped: true };

  // 重建内容:清空旧 entries 再插入。
  sqlite.prepare("DELETE FROM playlist_songs WHERE playlist_id = ?").run(RANDOM_PLAYLIST_ID);
  const insert = sqlite.prepare(
    "INSERT INTO playlist_songs (playlist_id, song_id, position, playable, created_at) VALUES (?, ?, ?, 1, ?)",
  );
  const tx = sqlite.transaction((ids: string[]) => {
    ids.forEach((id, pos) => insert.run(RANDOM_PLAYLIST_ID, id, pos, now));
  });
  tx(songIds);

  // 时长合计。
  const ph = songIds.map(() => "?").join(",");
  const durRows = sqlite
    .prepare(`SELECT duration FROM songs WHERE id IN (${ph})`)
    .all(...songIds) as { duration: number }[];
  const totalDuration = durRows.reduce((s, r) => s + (r.duration || 0), 0);

  // 封面:取歌单自身某首有封面歌曲的封面 ref(被其它固定歌单认领的自动跳过)。
  let cover: string | null = null;
  if (songIds.length > 0) cover = pickDailyRotatedCover(RANDOM_PLAYLIST_ID, {});

  sqlite
    .prepare("UPDATE playlists SET song_count = ?, duration = ?, cover_art = ?, comment = ?, updated_at = ? WHERE id = ?")
    .run(
      songIds.length,
      totalDuration,
      cover,
      `${RANDOM_TAG} 全库随机 ${songIds.length} 首`,
      now,
      RANDOM_PLAYLIST_ID,
    );

  return { total: songIds.length, skipped: false };
}

/**
 * 惰性刷新:距上次生成超过 refreshMinutes 时立即重建(同步、轻量,毫秒级)。
 * 供 OpenSubsonic getPlaylist 读取钩子 + 定时器调用。返回是否触发了重建。
 */
export function maybeRefreshRandomSongs(): boolean {
  const { refreshMinutes } = getRandomSongsConfig();
  const now = Date.now();
  const last = lastRefreshMs();
  if (last > 0 && now - last < refreshMinutes * 60_000) return false;
  const r = generateRandomSongsPlaylist();
  return r !== null && !r.skipped;
}

/** 插件 runDailyJob 入口(定时/手动刷新,永不抛错)。 */
export function runRandomSongsJob(opts?: { force?: boolean; count?: number }): string | null {
  try {
    const r = generateRandomSongsPlaylist(opts?.count);
    if (!r || r.skipped) return null;
    return `全库随机 ${r.total} 首`;
  } catch (e: any) {
    log.error("error", { err: e?.message || e });
    return null;
  }
}

/** 后台定时刷新:按 refreshMinutes 自适应间隔循环触发(配置变更自动生效)。 */
let refreshTimer: ReturnType<typeof setTimeout> | null = null;
export function startRandomSongsAutoRefresh(): void {
  if (refreshTimer) clearTimeout(refreshTimer);
  const { refreshMinutes } = getRandomSongsConfig();
  refreshTimer = setTimeout(() => {
    try {
      maybeRefreshRandomSongs();
    } catch (e: any) {
      log.error("auto refresh error", { err: e?.message || e });
    }
    startRandomSongsAutoRefresh();
  }, refreshMinutes * 60_000);
}

// ==================== Plugin (recommender, recommendPlaylist) ====================
//
// Registered as a `recommender` plugin so the scheduler picks it up by
// capability ("recommendPlaylist"), and listHomeCardPlugins() aggregates it
// into the home fixed cards via showOnHome / homePlaylistId — no core change.

export const randomSongsManifest: PluginManifest = {
  id: RANDOM_PLUGIN_ID,
  name: PLAYLIST_NAME,
  version: "1.0.0",
  type: "recommender",
  description: "从全部曲库随机抽取歌曲,维护一个实时更新的「随机歌曲」歌单(客户端随心听 / 前端通用)",
  capabilities: ["recommendPlaylist"],
  defaultEnabled: true,
  configSchema: [
    { key: "count", label: "歌曲总数", type: "number", default: 48, help: "歌单歌曲总数量(1~500,默认 48 = 客户端一轮的两倍,留足缓冲)" },
    { key: "refreshMinutes", label: "刷新间隔(分钟)", type: "number", default: 30, help: "每隔多少分钟自动重新随机抽取一次(默认 30;读取歌单时若超过该间隔也会立即重建)" },
    { key: "showOnHome", label: "在首页显示", type: "switch", default: false, help: "是否把「随机歌曲」歌单固定在首页顶部展示(按下方位次排序)" },
    { key: "homePosition", label: "首页显示位次", type: "number", default: 0, help: "首页顶部固定展示的第几张(1 起)。0 = 未固定。与其它开了「在首页显示」的插件位次不能重复,保存时会自动校验。" },
  ],
  // 首页展示时对应的固定歌单(核心按此聚合首页固定卡,不写死歌单 id)。
  homePlaylistId: RANDOM_PLAYLIST_ID,
  documentation: `### 功能介绍
从全部曲库随机抽取歌曲,维护一个固定 id 为 \`pl-random-songs\` 的「随机歌曲」歌单(默认 48 首,可配置)。客户端「随心听」与主项目前端都直接读这个歌单,走现有歌单接口,无需新增接口。

### 处理逻辑
1. 定时器按 \`refreshMinutes\`(默认 30 分钟)后台自动重新随机抽取一次;
2. 歌单被读取(getPlaylist)时,若距上次生成已超过刷新间隔,立即重建——客户端播完一轮再来取时歌单必然已刷新好,不会出现「现场生成导致的空白等待」;
3. 抽取算法为全库随机 O(limit):COUNT + rowid 采样,不整表加载;每次刷新内容不同。

### 说明
- 曲库为空时输出空结果,不报错;
- 停用本插件后「随机歌曲」歌单不再自动刷新(已有内容保留);
- 「在首页显示」开启后,歌单会固定在主项目前端首页顶部展示(与其它推荐插件共用位次校验)。`,
};

export const randomSongsPlugin: any = {
  manifest: randomSongsManifest,
  async runDailyJob(opts?: { force?: boolean; count?: number }): Promise<string | null> {
    return runRandomSongsJob(opts);
  },
};
