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

import { EventEmitter } from "events";
import { sqlite } from "../../db/index.js";
import { systemOwnerId } from "./shared.js";
import { pickDailyRotatedCover } from "../playlistCover.js";
import { createLogger } from "../../utils/logger.js";
import type { PluginManifest } from "../../plugins/types.js";
import { SCHEDULE_FIELDS } from "./scheduleFields.js";

const log = createLogger("RANDOM-SONGS");

// 轻量事件总线:歌单内容变动时 emit,由 ws 服务(initWebSocketServer)订阅后
// 广播给已连接的客户端。这里**不**直接 import ws —— ws 依赖 peer/dlna/player,
// 若从本插件反向依赖会形成 builtins → randomSongs → ws → player →
// source/online → builtins 的模块循环,导致 registerBuiltinPlugins 未初始化。
export const randomSongsEvents = new EventEmitter();
export const RANDOM_SONGS_CHANGED_EVENT = "random-songs-changed";

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
  genre?: string;
  fromYear?: number;
  toYear?: number;
}

/** 读本插件配置:歌曲总数 / 刷新间隔 / 过滤条件。非法或未配置回落默认。 */
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
    let genre: string | undefined = cfg.genre?.trim();
    if (!genre) genre = undefined;
    let fromYear: number | undefined;
    if (cfg.fromYear != null && cfg.fromYear !== "") {
      const v = parseInt(String(cfg.fromYear), 10);
      if (Number.isFinite(v) && v >= 1900 && v <= new Date().getFullYear()) {
        fromYear = v;
      }
    }
    let toYear: number | undefined;
    if (cfg.toYear != null && cfg.toYear !== "") {
      const v = parseInt(String(cfg.toYear), 10);
      if (Number.isFinite(v) && v >= 1900 && v <= new Date().getFullYear()) {
        toYear = v;
      }
    }
    // 区间容错:起始 > 结束时交换
    if (fromYear != null && toYear != null && fromYear > toYear) {
      [fromYear, toYear] = [toYear, fromYear];
    }
    return { count, refreshMinutes, genre, fromYear, toYear };
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

/** 可播歌曲总数(随机抽取的候选源,含过滤条件)。 */
function playableSongCount(filters?: RandomSongsConfig): number {
  const f = buildFilterClause(filters);
  const row = sqlite
    .prepare(
      `SELECT COUNT(*) AS n FROM songs LEFT JOIN albums ON songs.album_id = albums.id
       WHERE songs.suffix IS NOT NULL AND songs.path IS NOT NULL${f.where}`,
    )
    .get(...f.params) as { n: number };
  return row?.n || 0;
}

/** 把已生效的过滤条件拼成可读描述(用于歌单 comment)。 */
function describeFilters(filters: RandomSongsConfig): string {
  const parts: string[] = [];
  if (filters.genre) parts.push(`流派=${filters.genre}`);
  if (filters.fromYear != null) parts.push(`起始≥${filters.fromYear}`);
  if (filters.toYear != null) parts.push(`截至≤${filters.toYear}`);
  return parts.length ? `[${parts.join(" ")}]` : "";
}

/** 构建过滤条件片段(genre 用 LIKE、年份 JOIN albums.year)。返回 SQL 片段与参数。 */
function buildFilterClause(filters?: {
  genre?: string;
  fromYear?: number;
  toYear?: number;
}): { where: string; params: unknown[] } {
  const conds: string[] = [];
  const params: unknown[] = [];
  if (filters?.genre) {
    // 多标签(如 ;, .)也用部分匹配命中;转义 LIKE 通配符。
    const esc = filters.genre.replace(/[\\%_]/g, (c) => "\\" + c);
    conds.push("songs.genre LIKE ? ESCAPE '\\'");
    params.push("%" + esc + "%");
  }
  if (filters?.fromYear != null) {
    conds.push("albums.year >= ?");
    params.push(filters.fromYear);
  }
  if (filters?.toYear != null) {
    conds.push("albums.year <= ?");
    params.push(filters.toYear);
  }
  return { where: conds.length ? " AND " + conds.join(" AND ") : "", params };
}

/** 从满足过滤条件的可播曲库随机抽取 limit 首(O(limit),不整表加载;非确定性,每次不同)。 */
function pickRandomPlayableSongs(
  limit: number,
  filters?: RandomSongsConfig,
): string[] {
  const f = buildFilterClause(filters);
  const filterParams = f.params;
  const baseFrom =
    `FROM songs LEFT JOIN albums ON songs.album_id = albums.id ` +
    `WHERE songs.suffix IS NOT NULL AND songs.path IS NOT NULL${f.where}`;

  const meta = sqlite
    .prepare(`SELECT COUNT(*) AS n, MAX(songs.rowid) AS maxR ${baseFrom}`)
    .get(...filterParams) as { n: number; maxR: number | null };
  if (!meta.n || !meta.maxR) return [];
  const maxRowid = meta.maxR;

  // 命中数量不超过 limit:直接全量洗牌返回。
  if (meta.n <= limit) {
    const rows = sqlite
      .prepare(`SELECT songs.id ${baseFrom}`)
      .all(...filterParams) as { id: string }[];
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
        .prepare(`SELECT songs.id ${baseFrom} AND songs.rowid IN (${placeholders})`)
        .all(...filterParams, ...batch) as { id: string }[];
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
  const cfg = getRandomSongsConfig();
  const limit = count && count > 0 ? count : cfg.count;

  if (playableSongCount(cfg) === 0) return { total: 0, skipped: true };

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

  const songIds = pickRandomPlayableSongs(limit, cfg);
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
      `${RANDOM_TAG} 全库随机 ${songIds.length} 首${describeFilters(cfg)}`,
      now,
      RANDOM_PLAYLIST_ID,
    );

  // 歌单内容已变动:通过事件总线通知 ws 服务广播「random-songs-changed」信号,
  // 客户端(音流 / 前端)收到后按需重拉歌单,替代「客户端轮询随机歌曲歌单」。
  randomSongsEvents.emit(RANDOM_SONGS_CHANGED_EVENT, RANDOM_PLAYLIST_ID, now);

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
  description: "从全部曲库随机抽取歌曲,维护一个实时更新的「随机歌曲」歌单(客户端随机歌曲 / 前端通用)",
  capabilities: ["recommendPlaylist"],
  defaultEnabled: true,
  configSchema: [
    { key: "count", label: "歌曲总数", type: "number", default: 48, help: "歌单歌曲总数量(1~500,默认 48 = 客户端一轮的两倍,留足缓冲)" },
    { key: "genre", label: "流派过滤", type: "text", default: "", help: "只从该流派抽取(支持部分匹配,如 Pop / 华语)。留空=不限流派" },
    { key: "fromYear", label: "起始年份", type: "number", default: "", help: "只抽取年份 ≥ 该值的歌曲(默认 0)。留空=不限起始" },
    { key: "toYear", label: "截至年份", type: "number", default: "", help: "只抽取年份 ≤ 该值的歌曲(默认 0)。留空=不限截至。起始≥截至自动交换" },
    { key: "refreshMinutes", label: "刷新间隔(分钟)", type: "number", default: 30, help: "每隔多少分钟自动重新随机抽取一次(默认 30;读取歌单时若超过该间隔也会立即重建)" },
    { key: "showOnHome", label: "在首页显示", type: "switch", default: false, help: "是否把「随机歌曲」歌单固定在首页顶部展示(按下方位次排序)" },
    { key: "homePosition", label: "首页显示位次", type: "number", default: 0, help: "首页顶部固定展示的第几张(1 起)。0 = 未固定。与其它开了「在首页显示」的插件位次不能重复,保存时会自动校验。" },
  ],
    ...SCHEDULE_FIELDS,
  // 插件侧 i18n 字典:默认文案即中文,故 zh 省略、只补 en。前端按当前界面语言取用。
  i18n: {
    en: {
      name: "Random Songs",
      description:
        "Pick random songs from the whole library and keep a live-updating 'Random Songs' playlist (for client random playback / frontend)",
      documentation: `### Features
Randomly picks songs from the whole library and maintains a live-updating "Random Songs" playlist (used by the client's random playback / frontend). Refreshes every \`refreshMinutes\`, and lazily rebuilds when read — content changes in real time. Both the client and the main frontend read this playlist / random-songs API directly, with no per-client random implementation.

**The client's "Random Songs" also honors this plugin's filters**: when the client fetches random songs via Subsonic \`getRandomSongs\` without explicit params, the unset filter dimensions default to this plugin's \`Genre filter\` / \`From year\` / \`To year\` presets, so the client's random songs also stay within the preset range.

### Filters (optional)
Besides "song count", three filter dimensions can narrow the candidate set (applied both to playlist generation and client \`getRandomSongs\`):
- \`Genre filter\`: only draws songs from that genre (partial match, can hit multiple tags, e.g. \`Pop\` / \`Chinese\`); empty = no genre limit. Note: a song's genre comes from its own \`genre\` field.
- \`From year\` / \`To year\`: only draws songs whose year (from the owning album's \`year\`) falls in the range; empty = no bound on that side. From > To is swapped automatically on save.
- Random picks are always drawn only from the library satisfying all set conditions.`,
      fields: {
        count: {
          label: "Song count",
          help: "Total number of songs in the playlist (1–500, default 48 = 2x a client round, leaving buffer).",
        },
        genre: {
          label: "Genre filter",
          help: "Only draw from this genre (partial match, e.g. Pop / Chinese). Leave empty = no genre limit.",
        },
        fromYear: {
          label: "From year",
          help: "Only draw songs with year >= this value (default 0). Leave empty = no lower bound.",
        },
        toYear: {
          label: "To year",
          help: "Only draw songs with year <= this value (default 0). Leave empty = no upper bound. From > To is swapped automatically.",
        },
        refreshMinutes: {
          label: "Refresh interval (minutes)",
          help: "Auto re-pick randomly every this many minutes (default 30; if the playlist is read beyond this interval it is rebuilt immediately).",
        },
        showOnHome: {
          label: "Show on home",
          help: "Whether to pin the 'Random Songs' playlist at the top of the home page (ordered by home position).",
        },
        homePosition: {
          label: "Home display position",
          help: "The position (1-based) of this plugin's fixed card at the home top. 0 = not pinned. Cannot duplicate another plugin's position; auto-validated on save.",
        },
        scheduleEnabled: {
          label: "Participate in daily scheduled sync",
          help: "When off, the scheduled daily sync skips this plugin (manual refresh still works).",
        },
        runOnBoot: {
          label: "Run once on container startup",
          help: "When on, MusicFlow runs this plugin's playlist once on every startup/restart to keep it fresh.",
        },
        batchParallel: {
          label: "Allow parallel execution",
          help: "Off (default): this plugin's scheduled/batch jobs always run serially in the global queue; On: allowed to run in parallel with other plugins that enable this switch (uses more CPU but is faster).",
        },
      },
    },
  },
  // 首页展示时对应的固定歌单(核心按此聚合首页固定卡,不写死歌单 id)。
  homePlaylistId: RANDOM_PLAYLIST_ID,
  documentation: `### 功能介绍
从全部曲库随机抽取歌曲,维护一个实时更新的「随机歌曲」歌单(客户端随机歌曲 / 前端通用),按 \`refreshMinutes\` 定时、读取时按需刷新,内容实时变化。客户端与主项目前端都直接读这个歌单 / 走随机歌曲接口,无需各自实现随机。

**客户端的「随机歌曲」同样吃本插件的过滤条件**:客户端通过 Subsonic \`getRandomSongs\` 获取随机歌曲时,未显式传参的过滤维度默认套用本插件预设的 \`流派过滤\` / \`起始年份\` / \`截至年份\`,因此设置过滤后,客户端随机歌曲也只会落在预设范围内。

### 过滤条件(可选)
除「歌曲总数」外,可手动设置三个过滤维度,让随机的候选集收敛到指定范围(歌单生成与客户端 \`getRandomSongs\` 都生效):
- \`流派过滤\`:只从该流派的歌曲中抽取(部分匹配,可命中多标签,如 \`Pop\` / \`华语\`);留空=不限流派。注意:歌曲的流派继承自歌曲自身 \`genre\` 字段。
- \`起始年份\` / \`截至年份\`:只抽取年份落在区间内的歌曲(经所属专辑的 \`year\` 判断);留空即可不留该端。若起始>截至,保存时自动交换。
- 随机结果始终只在「同时满足所有已设条件」的曲库中抽取。

### 处理逻辑
1. 定时器按 \`refreshMinutes\`(默认 30 分钟)后台自动重新随机抽取一次;歌单被读取(getPlaylist)时若已超刷新间隔立即重建,客户端播完一轮再来取时歌单已刷新好;
2. 抽取算法为全库随机 O(limit):COUNT + rowid 采样,不整表加载;每次刷新内容不同;保存过滤条件后立即生效(下次读取/定时自动应用)。

### 说明
- 曲库为空、或过滤条件下无可抽取歌曲时输出空结果,不报错;
- 停用本插件后「随机歌曲」歌单不再自动刷新、客户端随机歌曲过滤随之失效(已有内容保留);
- 「在首页显示」开启后,歌单会固定在主项目前端首页顶部展示(与其它推荐插件共用位次校验)。`,
};

export const randomSongsPlugin: any = {
  manifest: randomSongsManifest,
  async runDailyJob(opts?: { force?: boolean; count?: number }): Promise<string | null> {
    return runRandomSongsJob(opts);
  },
};
