#!/usr/bin/env node
// ==================== 首页性能优化链路守卫 ====================
//
// 本脚本锁的是 2026-10-18「首页打开耗时」优化四件套的**静默失效契约**。这些改动共同的
// 特点是:坏掉不会报错、不会让任何既有动态用例变红,只会让首页悄悄变慢/退化:
//   R1 冷启动预热:local-recommend 的 provider 结果缓存改由后台定时预热。若预热器没被
//      启动(或没走「共享在途表」的单飞调用),首页首个 /v1/local-recommend 又会退回到
//      raceDeadline 硬等 2500ms(生产实测慢请求 ms=2582/2484/1756/1521/1208)。
//      另:预热只对「声明了 recommendCacheTtlSeconds>0」的插件有意义,漏了 TTL 过滤会把
//      每次都要重洗的内置「本地随机」也一起预热,纯属浪费外呼。
//   R2 聚合预热接口:/rest/api/v1/home/preload 把前端 4 个预热请求合并成 1 个。若前端又
//      退回 4 个独立请求,HTTP/1.1 每域名 6 连接下会与关键 XHR 争用(实测第二批 XHR 排队
//      q=177~689ms);若后端接口没挂权限,则变成无鉴权可访问的隐通道。
//   R3 封面懒加载:首页 130 张同源封面(实测平均 1397ms、最坏 2442ms)靠 IntersectionObserver
//      精确控制发请求时机。若退回原生 loading="lazy"(桌面快网阈值过大,会把视口附近整屏
//      图片一次性预取)或退回默认 size=300,首屏解码/带宽又白白翻倍。
//   R4 收藏在途去重:MainLayout 同一处既直接调 loadFavorites()、又经 preloadHome() 再调一次。
//      旧实现只有 `if (loaded) return` 没有在途去重 → 同一个 getStarred2(151KB)被并发请求
//      两次并互相排队(实测第二次排队 q≈689ms)。
//   R5 首屏外呼分层:首屏实测同时发出 14 条 XHR,其中流转播放初始化(两次全量 /v1/peers,
//      809ms / 329KB)、平台精选(/v1/recommend)、本地随机(/v1/local-recommend,冷启动 3.7s)
//      都在抢 HTTP/1.1 同源的 6 条连接。改为「首屏绘制之后自动延迟拉」后,若被改回
//      「打开即并发」,首屏内容又会被这三个庞然大物挤慢 —— 不报错、不红任何动态用例。
//
// 零依赖 node 脚本(strip-comments 与 check-tag-repair.mjs 同款),挂 ci.yml 的 home-perf-guard 作业。
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { stripComments } from "./lib/strip-comments.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

const RECOMMEND = "backend/src/routes/api/recommend.ts";
const HOMEPRELOAD = "backend/src/routes/api/homePreload.ts";
const LIBRARY = "backend/src/routes/api/library.ts";
const PLAYLISTS = "backend/src/routes/api/playlists.ts";
const PRELOAD = "frontend/src/stores/preload.ts";
const FAVORITES = "frontend/src/stores/favorites.ts";
const MAIN = "frontend/src/main.ts";
const LAZYCOVER = "frontend/src/directives/lazyCover.ts";
const HOME = "frontend/src/views/Home/index.vue";
const MAINLAYOUT = "frontend/src/layouts/MainLayout.vue";

const errors = [];
let checks = 0;

function textOf(rel) {
  const abs = join(root, rel);
  if (!existsSync(abs)) {
    errors.push(`缺少文件：${rel}`);
    return "";
  }
  return readFileSync(abs, "utf8");
}

/** 只取**有效代码行**（剔除注释、去首尾空白、丢空行）—— 注释里提到符号不算接线。 */
function liveLines(text) {
  return stripComments(text)
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
}

/** 断言：某个文件的有效代码行里**至少有一行**匹配 re。 */
function mustMatch(rel, re, why) {
  checks += 1;
  const text = textOf(rel);
  if (!text) return;
  if (!liveLines(text).some((l) => re.test(l))) errors.push(`${rel}: ${why}`);
}

/** 断言：某个文件的有效代码行里**没有任何一行**匹配 re。 */
function mustNotMatch(rel, re, why) {
  checks += 1;
  const text = textOf(rel);
  if (!text) return;
  const hit = liveLines(text).find((l) => re.test(l));
  if (hit) errors.push(`${rel}: ${why} —— 命中: ${hit.slice(0, 120)}`);
}

/** 断言：某个文件里 re 的匹配次数**恰好**为 n（用于防重复定义/防退化回多请求）。 */
function mustCount(rel, re, n, why) {
  checks += 1;
  const text = textOf(rel);
  if (!text) return;
  const g = new RegExp(re.source, re.flags.includes("g") ? re.flags : re.flags + "g");
  const c = (stripComments(text).match(g) || []).length;
  if (c !== n) errors.push(`${rel}: ${why} —— 期望 ${n} 处，实际 ${c} 处`);
}

/** 模板文件（.vue）用**原样文本**计数：模板里没有 TS 注释语义，绕过剥注释更稳。 */
function mustCountRaw(rel, re, n, why) {
  checks += 1;
  const text = textOf(rel);
  if (!text) return;
  const g = new RegExp(re.source, re.flags.includes("g") ? re.flags : re.flags + "g");
  const c = (text.match(g) || []).length;
  if (c < n) errors.push(`${rel}: ${why} —— 期望至少 ${n} 处，实际 ${c} 处`);
}

/** 模板文件（.vue）用**原样文本精确**计数：用于钉「首屏 2 处 eager / 下半屏 2 处 lazy」这类
 *  必须恰好 n 处的接线（多一处少一处都是退化，不能用 >= 放过）。 */
function mustCountRawExact(rel, re, n, why) {
  checks += 1;
  const text = textOf(rel);
  if (!text) return;
  const g = new RegExp(re.source, re.flags.includes("g") ? re.flags : re.flags + "g");
  const c = (text.match(g) || []).length;
  if (c !== n) errors.push(`${rel}: ${why} —— 期望 ${n} 处，实际 ${c} 处`);
}

// ---------- R1 冷启动预热（recommend.ts） ----------
mustMatch(
  RECOMMEND,
  /export function startLocalProviderWarmer\(/,
  "缺少 startLocalProviderWarmer 导出：后台预热器是消除首页冷启动 2500ms 硬等的唯一手段",
);
mustMatch(
  RECOMMEND,
  /startLocalProviderWarmer\(\);/,
  "startLocalProviderWarmer 必须在模块加载期被调用（只在别处定义/导出等于没启动，首页冷启动照旧硬等 2500ms）",
);
mustMatch(
  RECOMMEND,
  /export function __warmLocalProvidersOnceForTest\(/,
  "缺少 __warmLocalProvidersOnceForTest 测试钩子（预热行为将无法被用例覆盖）",
);
mustCount(
  RECOMMEND,
  /function kickProviderInvoke\(/,
  1,
  "kickProviderInvoke 必须**只定义一次**且在模块作用域：预热器与请求路径必须共用同一在途单飞表，重复定义会让同一 provider 被并发外呼",
);
mustMatch(
  RECOMMEND,
  /recommendCacheTtlSeconds/,
  "预热必须按 recommendCacheTtlSeconds(TTL) 判定：漏了 TTL 过滤会把「每次都要重洗」的内置本地随机也一起预热，纯属浪费外呼",
);
mustMatch(
  RECOMMEND,
  /LOCAL_PROVIDER_DEADLINE_MS = 2500/,
  "请求路径的 2500ms 软截止必须保留（预热只是把确定性冷启动成本挪到后台，不能顺手把请求路径改成无界等待）",
);
mustMatch(
  RECOMMEND,
  /providerRecommendCache\.clear\(\);/,
  "__resetRecommendRefreshStateForTest 必须清 providerRecommendCache（否则用例间脏缓存会让预热用例假绿）",
);
mustMatch(
  RECOMMEND,
  /localProviderWarmerTimer\?\.unref\?\.\(\)/,
  "预热定时器必须 unref：否则会无谓地阻止进程退出",
);

// ---------- R2 聚合预热接口（后端） ----------
mustMatch(
  HOMEPRELOAD,
  /app\.get\("\/v1\/home\/preload"/,
  "必须注册 GET /v1/home/preload 聚合预热接口",
);
mustCount(
  HOMEPRELOAD,
  /permMiddleware\(PERM\./,
  3,
  "聚合接口 + 全量歌单池接口必须共挂 3 道权限门（preload 的 LIBRARY_BROWSE + PLAYLIST_VIEW，以及 playlist-pool 的 PLAYLIST_VIEW；少挂即变成无鉴权的隐通道）",
);
for (const [fn, why] of [
  ["buildSongsPage", "歌曲列表预热必须复用 buildSongsPage（重写查询会与服务端真源漂移）"],
  ["buildAlbumsPage", "专辑列表预热必须复用 buildAlbumsPage"],
  ["buildArtistsPage", "艺术家列表预热必须复用 buildArtistsPage"],
  ["buildPlaylistsPage", "歌单列表预热必须复用 buildPlaylistsPage"],
]) {
  mustMatch(HOMEPRELOAD, new RegExp(`${fn}\\(`), why);
}
mustMatch(LIBRARY, /export function buildSongsPage/, "library.ts 必须导出 buildSongsPage（供聚合接口复用）");
mustMatch(LIBRARY, /export function buildAlbumsPage/, "library.ts 必须导出 buildAlbumsPage（供聚合接口复用）");
mustMatch(LIBRARY, /export function buildArtistsPage/, "library.ts 必须导出 buildArtistsPage（供聚合接口复用）");
mustMatch(PLAYLISTS, /export function buildPlaylistsPage/, "playlists.ts 必须导出 buildPlaylistsPage（供聚合接口复用）");

// ---------- R2b 聚合预热接口（前端） ----------
mustMatch(
  PRELOAD,
  /\/rest\/api\/v1\/home\/preload/,
  "preload 店必须改调合并后的 /rest/api/v1/home/preload",
);
for (const p of ["songs", "albums", "artists", "playlists"]) {
  mustNotMatch(
    PRELOAD,
    new RegExp(`/rest/api/v1/${p}\\b`),
    `preload 店不得再逐个请求 /rest/api/v1/${p}（退回 4 个独立请求会与关键 XHR 争用 6 条 HTTP/1.1 连接）`,
  );
}

// ---------- R3 封面懒加载 ----------
mustMatch(
  MAIN,
  /app\.directive\("lazy-cover", lazyCover\)/,
  "v-lazy-cover 指令必须在 main.ts 全局注册（否则首页模板里的 v-lazy-cover 静默不生效，退回全量封面请求）",
);
mustMatch(LAZYCOVER, /IntersectionObserver/, "lazyCover 必须用 IntersectionObserver 精确控制发请求时机");
mustMatch(
  LAZYCOVER,
  /rootMargin: "200px"/,
  "lazyCover 的 rootMargin 必须保留（提前一屏预载；改成 0 会在快速滚动时出现空白）",
);
mustCountRawExact(HOME, /v-lazy-cover=/g, 2, "首页仅下半屏 2 处封面走 v-lazy-cover（首屏顶部 2 处已改 eager 高优先级）");
mustCountRawExact(
  HOME,
  /fetchpriority="high"/g,
  2,
  "首屏顶部两处封面（固定卡 + 并排随机）必须 eager + fetchpriority=\"high\"：若退回低优先级，浏览器会把它们排在页面的 XHR 之后，用户看到「卡片出来了、封面迟迟不显示」",
);
mustCountRawExact(
  HOME,
  /:src="cover\(/g,
  2,
  "首屏顶部两处封面必须直接绑定 :src（走 eager 即时发请求，不再等 IntersectionObserver 回调才赋 src）",
);
mustCountRawExact(HOME, /fetchpriority="low"/g, 2, "下半屏两处封面必须保持低优先级（不得与首屏封面抢同源 6 连接）");
mustNotMatch(
  HOME,
  /loading="lazy"/,
  "首页封面不得退回原生 loading=\"lazy\"（桌面快网阈值过大，会把视口附近整屏图片一次性预取，实测仍一次发出约 130 张）",
);
mustMatch(
  HOME,
  /coverUrl\(id, 150\)/,
  "首页卡片封面必须收紧到 150 尺寸（卡片实际显示约 140~160px；退回默认 300 会让首屏解码/带宽翻倍）",
);

// ---------- R4 收藏在途去重 ----------
mustMatch(
  FAVORITES,
  /if \(inflight\) return inflight;/,
  "loadFavorites 必须保留在途单飞去重：否则 MainLayout 的两处调用会让同一个 getStarred2(151KB) 并发两次并互相排队",
);
mustMatch(FAVORITES, /inflight = null;/, "loadFavorites 的 finally 必须清空 inflight（否则加载一次后再也无法刷新）");

// ---------- R5 首屏外呼分层（2026-10-19） ----------
//
// 首屏实测同时发出 14 条 XHR:上半屏只有 3 路是真关键(歌单 / 首页配置 / 固定推荐卡),
// 而流转播放初始化(两次全量 /v1/peers,单次 809ms / 329KB,之后每 20s 轮询一次)、
// 平台精选(/v1/recommend)、本地随机(/v1/local-recommend,冷启动实测 3.7s)都在首屏
// 抢 HTTP/1.1 同源的 6 条连接,把首屏内容整体往后挤。改动把后三者改为「首屏绘制之后
// 自动延迟拉」(刻意不用视口/滚动触发:用户不滚动就永不加载,且滚动那一刻才付冷启动
// 延迟)。破坏是静默的:改回「打开即并发」不报错、不红任何动态用例,只是首屏又被挤慢。
mustMatch(
  HOME,
  /function scheduleLowerSections\(\): void \{/,
  "Home 必须保留下半屏延迟排期函数 scheduleLowerSections（下半屏两路不得再回到 onMounted 的即时并发）",
);
mustMatch(
  HOME,
  /await Promise\.all\(\[loadPlaylists\(\), loadHomeConfig\(\), loadHomeCards\(\)\]\)/,
  "Home 首屏即时并发只允许上半屏 3 路（歌单 / 首页配置 / 固定推荐卡）",
);
mustNotMatch(
  HOME,
  /Promise\.all\(\[[^\]]*loadLocalRandom\(\)/,
  "loadLocalRandom 不得再进首屏即时并发（冷启动 3.7s 会长期占住 6 条连接之一）",
);
mustNotMatch(
  HOME,
  /const slow = loadRecommend\(\)/,
  "loadRecommend 不得再回到「与上半屏同时发起」的写法",
);
mustMatch(
  HOME,
  /requestAnimationFrame\(\(\) => requestAnimationFrame\(startLowerSections\)\)/,
  "下半屏延迟必须等一次真实绘制（rAF 双帧）后再开跑",
);
mustMatch(
  HOME,
  /setTimeout\(startLowerSections, 1000\)/,
  "下半屏延迟必须有 1s 兜底定时器（后台标签页会暂停 rAF，否则永不加载）",
);
mustMatch(
  MAINLAYOUT,
  /function initPlayerPeers\(\): Promise<void> \{/,
  "MainLayout 必须保留流转播放初始化的延迟入口 initPlayerPeers",
);
mustMatch(
  MAINLAYOUT,
  /requestAnimationFrame\(\(\) => requestAnimationFrame\(\(\) => void initPlayerPeers\(\)\)\)/,
  "流转播放初始化（两次全量 /v1/peers）必须延后到首屏绘制之后，不得再在 onMounted 里直接 await",
);
mustCountRaw(
  MAINLAYOUT,
  /await playerStore\.restoreCast\(\)/g,
  1,
  "restoreCast 只允许出现在延迟入口 initPlayerPeers 里",
);
mustCountRaw(
  MAINLAYOUT,
  /playerStore\.initLocalPeer\(\)/g,
  1,
  "initLocalPeer 只允许出现在延迟入口 initPlayerPeers 里",
);
mustMatch(
  MAINLAYOUT,
  /playerPeersDisposed = true;/,
  "外壳卸载时必须置位 playerPeersDisposed 并清掉延迟定时器（登出后 <1s 卸载,悬挂回调仍会打 /v1/peers）",
);

// ---------- R6 聚合缓存预热提速 + 指数退避 + 冷启动分档（recommend.ts，2026-10-19/20） ----------
//
// 首轮预热原为 TTL/2 = 150s：进程刚启动的那段时间里，首页首开只能走请求路径冷拉，
// 用户恰好在这段窗口打开首页就是「慢」。改为启动后 ~4s 就预热一轮，之后仍按 TTL/2
// 周期续命。失败退避同步从固定 60s 改为指数（3s 起、封顶 60s）：上游故障时既不
// 死等 60s，也不会被前端轮询瞬间打爆。
//
// 2026-10-20 追加「冷启动也预热」并**分档 re-arm**：无缓存时，推荐类插件已就绪 → 直接
// kick 一轮后台聚合（把实测 1.6~16.6s 的沙箱冷启动挪到无人等待窗口）；插件未注册 →
// 绝不预热（否则会把「空频道」当成真值写进缓存并保留整个 TTL=5min，首页空 5 分钟），
// 降到冷档短周期重试。破坏全是静默的（首轮又变回 150s / 退避退回固定 60s / 丢掉冷档
// 判定 都不报错、不红任何动态用例），故一并钉死。
mustMatch(
  RECOMMEND,
  /export const RECOMMEND_WARMER_INITIAL_MS = 4 \* 1000;/,
  "聚合缓存预热首轮必须在启动后数秒内触发（export RECOMMEND_WARMER_INITIAL_MS = 4*1000）：退回 TTL/2(150s) 会让进程启动窗口内的首页首开长期靠冷拉",
);
mustMatch(
  RECOMMEND,
  /let nextDelayMs = RECOMMEND_CACHE_TTL_MS \/ 2;/,
  "首轮之后必须按 TTL/2 周期重新 re-arm 为稳态档（只热一次 = 缓存随后又过期，用户请求命中不到未过期缓存）",
);
mustMatch(
  RECOMMEND,
  /export const RECOMMEND_WARMER_COLD_RETRY_MS = 15 \* 1000;/,
  "冷档重试常量 RECOMMEND_WARMER_COLD_RETRY_MS 必须存在且为秒级（插件就绪前必须短周期重试）",
);
mustMatch(
  RECOMMEND,
  /if \(!warmRecommendCacheOnce\(\)\) nextDelayMs = RECOMMEND_WARMER_COLD_RETRY_MS;/,
  "分档必须由 warmRecommendCacheOnce 的返回值驱动：丢掉它 = 冷启动空频道落库缺陷回归（首页空 5 分钟）",
);
mustMatch(
  RECOMMEND,
  /export function warmRecommendCacheOnce\(/,
  "warmRecommendCacheOnce 必须导出（否则冷启动预热无法被单测/守卫确定性驱动）",
);
mustNotMatch(
  RECOMMEND,
  /\}, RECOMMEND_CACHE_TTL_MS \/ 2\);$/,
  "首轮延迟不得再等于 TTL/2（150s）—— 首轮必须走 RECOMMEND_WARMER_INITIAL_MS 这档短延迟",
);
mustMatch(
  RECOMMEND,
  /export function recommendRefreshBackoffMs\(/,
  "缺少指数退避纯函数 recommendRefreshBackoffMs（退避策略将无法被确定性单测覆盖）",
);
mustMatch(RECOMMEND, /RECOMMEND_REFRESH_BACKOFF_BASE_MS = 3_000;/, "指数退避基准必须为 3s");
mustMatch(RECOMMEND, /RECOMMEND_REFRESH_BACKOFF_MAX_MS = 60_000;/, "指数退避上限必须封顶 60s");
mustNotMatch(
  RECOMMEND,
  /RECOMMEND_REFRESH_BACKOFF_MS\b/,
  "旧的固定 60s 退避常量 RECOMMEND_REFRESH_BACKOFF_MS 必须删除（防止两套退避逻辑并存/误用）",
);

// ---------- R7 首页全量歌单池索引（playlists.ts，2026-10-20） ----------
//
// 首页「并排随机」此前调 /v1/playlists?pageSize=200 拉「全量」，而生产库有 873 个歌单、
// 服务端单页上限 500 —— 随机池实际只覆盖最新约 200 个，其余 673 个**永不出现**（真实
// 缺陷）。改为服务端常驻一份最瘦索引（id+name+songCount）并一次返回全量池。破坏仍是
// 静默的：索引没预热/没挂常驻缓存不报错；可见性过滤写错则会把他人私密歌单泄漏给普通用户。
mustMatch(
  PLAYLISTS,
  /export const PLAYLIST_POOL_TTL_MS = 60 \* 1000;/,
  "歌单池索引必须有短 TTL 常量（60s）：过期即重建，新增歌单最迟一分钟内进池",
);
mustMatch(
  PLAYLISTS,
  /export function buildPlaylistPool\(/,
  "playlists.ts 必须导出 buildPlaylistPool（供 /v1/home/playlist-pool 复用，重写查询会与真源漂移）",
);
mustMatch(
  PLAYLISTS,
  /export function startPlaylistPoolWarmer\(/,
  "缺少 startPlaylistPoolWarmer：启动预热是让首个首页请求免付全表扫描的唯一手段",
);
mustMatch(
  PLAYLISTS,
  /startPlaylistPoolWarmer\(\);/,
  "startPlaylistPoolWarmer 必须在模块加载期被调用（只定义/导出等于没启动，首个首页请求照旧自付冷扫描）",
);
mustMatch(
  PLAYLISTS,
  /e\.owner === \(user\?\.id \?\? ""\) \|\| e\.pub/,
  "普通用户可见性必须按「自己 + 公开 + 导入」过滤：漏掉即向普通用户泄漏他人私密歌单",
);
mustMatch(
  PLAYLISTS,
  /pub: r\.isPublic === 1 \|\| r\.sourceUrl != null,/,
  "pub 判定必须与 buildPlaylistsPage 的 SQL 逐字对齐（eq(isPublic,1) + isNotNull(sourceUrl)）：放宽成 !!r.isPublic 会在 isPublic 出现非 0/1 脏值时向普通用户多放歌单",
);
mustMatch(
  PLAYLISTS,
  /visible\.map\(\(e\) => \(\{ id: e\.id, name: e\.name, songCount: e\.songCount \}\)\)/,
  "响应项必须只投影 id/name/songCount：owner/pub 是内部可见性判定列，外泄会扩大隐私面",
);
mustMatch(
  PLAYLISTS,
  /readPlaylistPoolEntries\(opts\?\.force === true\)/,
  "buildPlaylistPool 必须支持 force 跳过 TTL 缓存：否则「重新生成漫游」后新歌单最迟 60s 才进并排随机池",
);
mustMatch(
  PLAYLISTS,
  /\}, PLAYLIST_POOL_WARMER_INITIAL_MS\);/,
  "启动预热必须是单发定时器（延迟用 PLAYLIST_POOL_WARMER_INITIAL_MS）",
);
mustNotMatch(
  PLAYLISTS,
  /tick\(\)/,
  "启动预热不得做递归 re-arm：索引重建 <2ms，周期预热既无收益又会在每个 import 本模块的测试进程里常驻定时器",
);

// ---------- R8 首页全量歌单池接口与前端接线（homePreload.ts + Home/index.vue，2026-10-20） ----------
mustMatch(
  HOMEPRELOAD,
  /app\.get\("\/v1\/home\/playlist-pool"/,
  "必须注册 GET /v1/home/playlist-pool（首页全量歌单池的唯一来源）",
);
mustMatch(
  HOMEPRELOAD,
  /app\.use\("\/v1\/home\/playlist-pool", permMiddleware\(PERM\.PLAYLIST_VIEW\)\)/,
  "全量歌单池接口必须挂 PLAYLIST_VIEW 权限门（少挂即变成无鉴权的隐通道）",
);
mustMatch(
  HOMEPRELOAD,
  /buildPlaylistPool\(/,
  "歌单池接口必须复用 buildPlaylistPool（另写一份查询会与服务端真源漂移）",
);
mustMatch(
  HOMEPRELOAD,
  /const force = c\.req\.query\("refresh"\) === "1";/,
  "歌单池接口必须支持 ?refresh=1 强制重建（「重新生成漫游」后新歌单需立刻进池）",
);
mustMatch(
  HOMEPRELOAD,
  /buildPlaylistPool\(user, \{ force \}\)/,
  "歌单池接口必须把 refresh 透传给 buildPlaylistPool（传丢了 force 就退化成空转）",
);
mustMatch(
  HOME,
  /\/rest\/api\/v1\/home\/playlist-pool/,
  "Home 并排随机池必须改走轻量全量接口 /rest/api/v1/home/playlist-pool",
);
mustMatch(
  HOME,
  /\?refresh=1/,
  "Home 手动刷新必须带 ?refresh=1 跳过服务端索引 TTL 缓存（否则新歌单最迟 60s 才进并排随机池）",
);
mustMatch(
  HOME,
  /loadPlaylists\(true\)/,
  "「重新生成漫游」必须调用 loadPlaylists(true)（带 force），不能用默认的缓存命中路径",
);
mustNotMatch(
  HOME,
  /\/rest\/api\/v1\/playlists\b/,
  "Home 不得再调分页 /v1/playlists（pageSize=200 会把全量随机池截到最新约 200 个，缺陷回归）",
);
mustNotMatch(
  HOME,
  /pageSize: 200/,
  "Home 不得再出现 pageSize=200 截断",
);
mustMatch(
  HOME,
  /coverArt: `pl-\$\{p\.id\}`/,
  "歌单池响应不含 coverArt，Home 必须按 pl-<id> 派生封面（否则首屏封面整块消失）",
);

if (errors.length) {
  console.error(`✗ 首页性能优化链路守卫失败：${errors.length} 项违规（共 ${checks} 条断言）`);
  for (const e of errors) console.error("  ✗ " + e);
  process.exit(1);
}
console.log(`✅ 首页性能优化链路守卫通过：${checks} 条断言全部成立（冷启动预热 / 聚合预热接口 / 封面懒加载+首屏 eager / 收藏在途去重 / 首屏外呼分层 / 聚合缓存预热提速+指数退避+冷启动分档+冷档不落空缓存 / 全量歌单池索引(单发预热+exact 可见性口径)+轻量接口+?refresh=1 强制重建）。`);
