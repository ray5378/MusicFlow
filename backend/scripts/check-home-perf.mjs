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
  2,
  "聚合接口必须同时挂 LIBRARY_BROWSE 与 PLAYLIST_VIEW 两道权限门（少挂即变成无鉴权的隐通道）",
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
mustCountRaw(HOME, /v-lazy-cover=/g, 4, "首页 4 处封面必须走 v-lazy-cover");
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

if (errors.length) {
  console.error(`✗ 首页性能优化链路守卫失败：${errors.length} 项违规（共 ${checks} 条断言）`);
  for (const e of errors) console.error("  ✗ " + e);
  process.exit(1);
}
console.log(`✅ 首页性能优化链路守卫通过：${checks} 条断言全部成立（冷启动预热 / 聚合预热接口 / 封面懒加载 / 收藏在途去重）。`);
