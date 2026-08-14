// Daily-roam「今日漫游」组合歌单生成器。
//
// 职责:把其他 recommender 插件生成的歌单(默认:每日推荐 pl-daily-today +
// 本地推荐 pl-daily-local)合并、去重,重建为固定 id 的「今日漫游」组合歌单
// (pl-daily-roam)。首页顶部固定展示的就是这个组合歌单。
//
// 关键设计:
//   - 按 capability("comboPlaylist")注册,调度器在 dailyPlaylist / localPlaylist
//     之后跑,保证先有源歌单、再有组合歌单。
//   - 源歌单列表可配置(sourcePlaylists,playlist-multi),默认取两张固定推荐;
//     用户可增删,但至少保留 1 个。
//   - 只合并「可播放」条目(playable=1 且 song_id 非空),按源歌单 position 顺序,
//     跨源去重(song_id 唯一)。
//   - 固定 id pl-daily-roam,当天幂等(comment 含日期),force 可强制重建。
import { sqlite } from "../../db/index.js";
import { getPluginConfig } from "../../plugins/registry.js";
import type { ComboPlaylistPlugin, PluginManifest } from "../../plugins/types.js";
import { FIXED_TODAY_ID } from "./dailyRecommend.js";
import { LOCAL_FIXED_PLAYLIST_ID } from "./localRecommend.js";

export const DAILY_ROAM_PLUGIN_ID = "daily-roam";
export const ROAM_PLAYLIST_ID = "pl-daily-roam";
export const ROAM_TAG = "[daily-recommend-roam]";
const NAME_ROAM = "今日漫游";

// 默认组合来源:每日推荐 + 本地推荐(固定 id 是内置插件间的稳定契约,不写死插件名)。
const DEFAULT_SOURCES = [FIXED_TODAY_ID, LOCAL_FIXED_PLAYLIST_ID];

export interface RoamResult {
  date: string;
  playlistId: string;
  name: string;
  total: number;
  sources: string[];
  skipped: boolean;
}

function todayStr(d = new Date()): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function pickSystemOwnerId(): string {
  const admin = sqlite.prepare("SELECT id FROM users WHERE is_admin = 1 LIMIT 1").get() as any;
  return admin?.id || "";
}

/** 读配置的源歌单 id 列表(playlist-multi);非法/为空时回落默认两张固定推荐。 */
function loadSources(): string[] {
  try {
    const cfg = getPluginConfig(DAILY_ROAM_PLUGIN_ID) || {};
    const ids = Array.isArray(cfg.sourcePlaylists)
      ? cfg.sourcePlaylists.filter((x: any) => typeof x === "string" && x.length > 0)
      : [];
    return ids.length > 0 ? ids : DEFAULT_SOURCES;
  } catch {
    return DEFAULT_SOURCES;
  }
}

// 确保固定 id 的「今日漫游」歌单行存在(首次创建)。
function ensureRoamPlaylist(): any {
  let row = sqlite.prepare("SELECT * FROM playlists WHERE id = ?").get(ROAM_PLAYLIST_ID) as any;
  if (!row) {
    const now = new Date().toISOString();
    sqlite.prepare(`
      INSERT INTO playlists (id, name, owner_id, is_public, comment, cover_art, source_url, source_platform, external_id, sync_enabled, created_at, updated_at)
      VALUES (?, ?, ?, 1, ?, NULL, NULL, 'mixed', NULL, 0, ?, ?)
    `).run(ROAM_PLAYLIST_ID, NAME_ROAM, pickSystemOwnerId(), ROAM_TAG, now, now);
    row = sqlite.prepare("SELECT * FROM playlists WHERE id = ?").get(ROAM_PLAYLIST_ID) as any;
  } else if (row.name !== NAME_ROAM) {
    sqlite.prepare("UPDATE playlists SET name = ?, updated_at = ? WHERE id = ?")
      .run(NAME_ROAM, new Date().toISOString(), ROAM_PLAYLIST_ID);
    row.name = NAME_ROAM;
  }
  return row;
}

// 收集单个源歌单的可播放条目(按 position 顺序)。返回 {songId, duration} 列表。
function collectSourceEntries(playlistId: string): { songId: string; duration: number }[] {
  const rows = sqlite.prepare(`
    SELECT ps.song_id AS songId, COALESCE(s.duration, 0) AS duration
    FROM playlist_songs ps
    LEFT JOIN songs s ON ps.song_id = s.id
    WHERE ps.playlist_id = ? AND ps.playable = 1 AND ps.song_id IS NOT NULL AND s.path IS NOT NULL
    ORDER BY ps.position ASC
  `).all(playlistId) as { songId: string; duration: number }[];
  return rows;
}

/** 重建「今日漫游」组合歌单(默认当天幂等;opts.force=true 强制重建)。 */
export function generateRoamPlaylist(opts?: { force?: boolean }): RoamResult {
  const dateStr = todayStr();
  const row = ensureRoamPlaylist();
  // 当天幂等:comment 含今天日期 = 今天已生成过(force 跳过)。
  if (!opts?.force && (row.comment || "").includes(dateStr)) {
    return { date: dateStr, playlistId: ROAM_PLAYLIST_ID, name: NAME_ROAM, total: 0, sources: [], skipped: true };
  }

  const sources = loadSources();
  // 跨源合并 + 去重(保留先出现源的顺序)。
  const seen = new Set<string>();
  const merged: { songId: string; duration: number }[] = [];
  const sourceNames: string[] = [];
  for (const src of sources) {
    const pl = sqlite.prepare("SELECT name FROM playlists WHERE id = ?").get(src) as any;
    if (!pl) continue;
    sourceNames.push(pl.name || src);
    for (const e of collectSourceEntries(src)) {
      if (seen.has(e.songId)) continue;
      seen.add(e.songId);
      merged.push(e);
    }
  }

  // 没有任何可播放内容:保留旧歌单,不报错(等源歌单生成后再重建)。
  if (merged.length === 0) {
    return { date: dateStr, playlistId: ROAM_PLAYLIST_ID, name: NAME_ROAM, total: 0, sources, skipped: true };
  }

  // 重建内容。
  sqlite.prepare("DELETE FROM playlist_songs WHERE playlist_id = ?").run(ROAM_PLAYLIST_ID);
  const insert = sqlite.prepare("INSERT INTO playlist_songs (playlist_id, song_id, position, playable, created_at) VALUES (?, ?, ?, 1, ?)");
  const now = new Date().toISOString();
  const tx = sqlite.transaction((items: { songId: string }[]) => {
    items.forEach((it, pos) => insert.run(ROAM_PLAYLIST_ID, it.songId, pos, now));
  });
  tx(merged);

  const totalDuration = merged.reduce((s, e) => s + (e.duration || 0), 0);

  // 封面:取第一个有封面的源歌单封面;都没有则留空(前端回落占位图)。
  let cover: string | null = null;
  for (const src of sources) {
    const pl = sqlite.prepare("SELECT cover_art FROM playlists WHERE id = ?").get(src) as any;
    if (pl?.cover_art) { cover = pl.cover_art; break; }
  }

  sqlite.prepare("UPDATE playlists SET song_count = ?, duration = ?, cover_art = ?, comment = ?, updated_at = ? WHERE id = ?")
    .run(merged.length, totalDuration, cover, `${ROAM_TAG} ${dateStr} 合并自「${sourceNames.join(" + ")}」`, now, ROAM_PLAYLIST_ID);

  return { date: dateStr, playlistId: ROAM_PLAYLIST_ID, name: NAME_ROAM, total: merged.length, sources, skipped: false };
}

// ==================== Plugin (recommender, comboPlaylist) ====================

export const dailyRoamManifest: PluginManifest = {
  id: DAILY_ROAM_PLUGIN_ID,
  name: "今日漫游",
  version: "1.0.0",
  type: "recommender",
  description: "合并「每日推荐」与「本地推荐」生成「今日漫游」组合歌单(去重)",
  capabilities: ["comboPlaylist"],
  defaultEnabled: true,
  configSchema: [
    {
      key: "sourcePlaylists",
      label: "组合来源歌单",
      type: "playlist-multi",
      help: "从这些歌单合并生成「今日漫游」(默认:每日推荐 + 本地推荐,可多选、可搜索)。至少保留 1 个。",
      default: DEFAULT_SOURCES,
    },
    { key: "showOnHome", label: "在首页显示", type: "switch", default: true, help: "是否把本插件生成的歌单固定在首页顶部展示(按下方位次排序)" },
    { key: "homePosition", label: "首页显示位次", type: "number", default: 1, help: "首页顶部固定展示的第几张(1 起)。0 = 未固定。与其它开了「在首页显示」的插件位次不能重复,保存时会自动校验。" },
  ],
  // 首页展示时对应的固定歌单(核心按此聚合首页固定卡,不写死歌单 id)。
  homePlaylistId: ROAM_PLAYLIST_ID,
  documentation: `### 功能介绍
合并其他推荐歌单生成「今日漫游」组合歌单（固定 id：\`pl-daily-roam\`），首页顶部固定展示的就是它。

### 处理逻辑
1. 调度器在每日推荐 / 本地推荐生成之后,按 \`comboPlaylist\` 能力调用本插件的 \`runDailyJob()\`;
2. 读取配置的「组合来源歌单」(默认:每日推荐 + 本地推荐),合并所有**可播放**条目并按歌曲去重;
3. 重建「今日漫游」歌单(覆盖当天旧版)。

### 说明
- **组合来源可配置**:在插件设置页可增删来源歌单(默认两张固定推荐);
- 来源歌单全部为空时保留旧内容,不报错;
- 停用本插件后「今日漫游」不再更新,但两个源歌单照常生成。`,
};

export const dailyRoamPlugin: ComboPlaylistPlugin = {
  manifest: dailyRoamManifest,
  async runDailyJob(): Promise<string | null> {
    const r = generateRoamPlaylist();
    if (!r || r.skipped) return null;
    return `${r.date}: ${r.total} 首今日漫游 (${r.sources.length} 个来源)`;
  },
  async generateComboPlaylist(opts?: { force?: boolean }) {
    return generateRoamPlaylist(opts);
  },
};
