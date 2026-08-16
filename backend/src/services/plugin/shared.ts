// ==================== 插件宿主共享工具 ====================
//
// 内置推荐插件(daily-recommend / local-recommend / daily-roam)、导入/匹配/
// 同步等宿主层反复使用的同构工具,收敛于此,避免多份逐字相同的实现漂移。
//
// 注意:本文件是「宿主中性共享模块」,不是任何内置插件的实现文件。核心路由
// (routes/*)只可经此门面引用共享能力,不得直接 import services/plugin/ 下某个
// 具体插件实现(如 playlistSync.js),否则会越过插件化边界被 check-core 规则 B 拦截。

import { db, sqlite } from "../../db/index.js";
import { playlists } from "../../db/schema.js";
import { eq } from "drizzle-orm";
import { firstEnabledByCapability, getPluginConfig } from "../../plugins/registry.js";

/** 当天日期字符串(YYYY-MM-DD),用于歌单当天幂等标记。 */
export function todayStr(d = new Date()): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/** 系统归属用户 id(首个 admin):插件歌单 / 系统任务写入的 owner。 */
export function systemOwnerId(): string {
  const admin = sqlite.prepare("SELECT id FROM users WHERE is_admin = 1 LIMIT 1").get() as any;
  return admin?.id || "";
}

// ==================== 歌单匹配 / 计数共享工具 ====================
//
// 这些工具同时被「导入歌单重建」「外置插件歌单写入」「每日/本地推荐自动补匹配」
// 以及核心 REST 路由(计数刷新)使用,属于宿主通用能力,而非某内置插件私有的实现,
// 因此收敛在共享模块,避免把核心代码逼到直接 import playlistSync 等插件实现文件。

// Normalize title/artist for fuzzy matching (lowercase, trim, strip separators/parens)
export function normalizeKey(title: string, artist: string): string {
  const norm = (s: string) => s.toLowerCase().replace(/[（(].*?[)）]/g, "").replace(/[~～·\-—_\s]+/g, "").trim();
  return `${norm(title)}|${norm(artist)}`;
}

// Per-playlist auto-match guard: only one background match at a time per playlist.
const autoMatchLocks = new Set<string>();

/** 后台自动匹配一张歌单的未匹配条目(playable=0 且 external_title 非空)。
 *
 *  共享宿主服务:导入歌单(rebuildPlaylistEntries 后)与外置插件歌单
 *  (discovery.upsertPluginPlaylist 写入后)都经此触发,避免两份近似逻辑漂移。
 *  能力驱动:autoMatch 能力优先,否则任意 search 能力插件兜底;每歌单内存锁防并发;
 *  失败不抛(调用方 fire-and-forget)。 */
export async function matchPlaylistInBackground(playlistId: string): Promise<void> {
  if (autoMatchLocks.has(playlistId)) return;
  autoMatchLocks.add(playlistId);
  // 全局批量闸:与插件任务(jobRunner)共用,全进程同时只跑 1 个批量任务,防叠加。
  // 动态 import 避免顶层环(shared → batchPacer → settings,settings 无回环,静态亦可;
  // 保持动态以稳妥)。
  const { acquireBatchLock } = await import("./batchPacer.js");
  const release = await acquireBatchLock();
  // P2:排队时间不计入匹配耗时——started 在拿到全局批量闸之后才记录,
  // 日志里的 in Xs 只反映真实匹配开销,不含等待队列的时长。
  const started = Date.now();
  try {
    const matcher = firstEnabledByCapability("autoMatch") ?? firstEnabledByCapability("search");
    if (!matcher) return; // no capable plugin enabled -> nothing to do
    const config = getPluginConfig(matcher.manifest.id);
    if (!config) return; // plugin disabled between lookup and read
    if (typeof matcher.impl?.search !== "function") return; // can't actually match

    // P1:匹配进度经 WS 广播(限频 1s),前端可显示「后台匹配中 x/y」而非"卡死"。
    // 动态 import 解环:shared → ws → dlna → online → builtins → shared 会成环。
    let lastBcast = 0;
    const ws = await import("../ws/index.js");
    const { matchUnmatchedPlaylistEntries } = await import("../source/online/match.js");
    const result = await matchUnmatchedPlaylistEntries(
      matcher.manifest.id,
      config,
      matcher.impl,
      playlistId,
      (done, total) => {
        if (total <= 0) return;
        const now = Date.now();
        if (done < total && now - lastBcast < 1000) return; // 限频:每秒最多广播一次
        lastBcast = now;
        ws.broadcastToClients({ type: "match_progress", playlistId, done, total });
      },
    );
    if (result.total > 0) {
      console.log(
        `[auto-match] ${playlistId}: ${result.matched} matched, ${result.noMatch} no-match, ${result.error} errors in ${((Date.now() - started) / 1000).toFixed(1)}s`,
      );
    }
  } finally {
    autoMatchLocks.delete(playlistId);
    release(); // 释放全局批量闸
  }
}

// Recompute a playlist's songCount and duration
export function refreshPlaylistCounts(playlistId: string) {
  // Single aggregate query (LEFT JOIN song durations) instead of one SELECT per
  // entry. Mirrors the old per-entry logic:
  //   - playable+linked entry counts when its song exists → contributes s.duration
  //   - loose external entry counts when it has an external title → ext duration / 1000
  const row = sqlite.prepare(`
    SELECT
      SUM(CASE
        WHEN e.playable = 1 AND e.song_id IS NOT NULL THEN CASE WHEN s.id IS NOT NULL THEN 1 ELSE 0 END
        WHEN e.external_title IS NOT NULL AND e.external_title != '' THEN 1
        ELSE 0 END) AS cnt,
      COALESCE(SUM(
        CASE WHEN e.playable = 1 AND e.song_id IS NOT NULL THEN CASE WHEN s.id IS NOT NULL THEN s.duration ELSE 0 END
             WHEN e.external_title IS NOT NULL AND e.external_title != '' THEN e.external_duration / 1000.0
             ELSE 0 END
      ), 0) AS duration
    FROM playlist_songs e
    LEFT JOIN songs s ON s.id = e.song_id
    WHERE e.playlist_id = ?
  `).get(playlistId) as any;
  const count = Number(row?.cnt || 0);
  const duration = Math.round(Number(row?.duration || 0));
  db.update(playlists).set({ songCount: count, duration, updatedAt: new Date().toISOString() }).where(eq(playlists.id, playlistId)).run();
}
