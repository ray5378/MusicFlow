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

// 全角拉丁/数字 → 半角(如 ＬＩＶＥ → LIVE)。
function halfWidth(s: string): string {
  return s.replace(/[\uFF01-\uFF5E]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0)).replace(/\u3000/g, " ");
}

/**
 * 换源/匹配使用的严格歌曲名归一化:全角转半角 → 小写 → 只保留中文字与英文字母
 * 数字下划线([a-z0-9_\u4e00-\u9fa5]),其余符号、空格、括号全部丢弃。
 *
 * 与 go-music-dl 插件 matchInPool 的 norm 规则一致。由于 "Live / 演唱会 / 版 /
 * 伴奏 / (Taylor's Version)" 等后缀全由中英文字母构成,归一后必然保留——因此
 * 「有后缀的名字只能匹配带相同后缀的名字,无后缀的名字只能匹配无后缀的名字」,
 * 仅大小写、符号、空白、全角/半角差异被放宽。用作播放换源(streamFallback)与
 * auto-match(在线匹配)的「歌名严格对齐」判定;库内索引继续走 normalizeKey。
 */
export function normalizeTitleStrict(title: string): string {
  return halfWidth(String(title || "")).toLowerCase().replace(/[^a-z0-9_\u4e00-\u9fa5]/g, "");
}

/**
 * 规范化相等比较(带原文回退)。normalizeTitleStrict 只保留英数字与汉字,
 * 假名/谚文等文字会被剥离,直接比较会产生三类事故:
 * ①两侧都剥空 → 任意两个非中英文标题被判「相等」(误匹配);
 * ②一侧空一侧非空 → 永远不等(误拒,门禁放行不了合法的假名歌);
 * ③混合文字剥不空但丢信息 → 「サントラ盤」与「ベスト盤」都只剩「盤」被判相等。
 *
 * 规则:原文(trim+lowercase)相等 → 等;否则若任一侧含「会被归一化剥离的有意义
 * 字符」(假名/谚文/西里尔等非中英文字母数字)→ 归一化有损,不等(宁可拒,不可错);
 * 无有损字符时才用归一化比较(容忍空白/符号/全半角差异)。
 */
export function strictNormEquals(a: string, b: string): boolean {
  const ra = halfWidth(String(a || "")).trim().toLowerCase();
  const rb = halfWidth(String(b || "")).trim().toLowerCase();
  if (!ra || !rb) return false;
  if (ra === rb) return true;
  if (hasStrippedLetters(ra) || hasStrippedLetters(rb)) return false;
  const na = normalizeTitleStrict(ra);
  const nb = normalizeTitleStrict(rb);
  return na.length > 0 && na === nb;
}

/** 检测字符串是否含「会被 normalizeTitleStrict 剥离的字母/数字」
 *  (假名/谚文/西里尔/希腊等):先移除英数字与汉字,再看剩下的是否还有字母数字。 */
function hasStrippedLetters(s: string): boolean {
  return /[\p{L}\p{N}]/u.test(s.replace(/[a-z0-9\u4e00-\u9fa5]/g, ""));
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
