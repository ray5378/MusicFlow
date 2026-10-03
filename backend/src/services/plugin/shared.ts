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
import { firstEnabledByCapability, getEnabledByCapability, getPluginConfig } from "../../plugins/registry.js";

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

/** 一次后台自动匹配的战果统计(全部为 0 表示「无事可做」)。 */
export interface AutoMatchStats {
  total: number;
  matched: number;
  noMatch: number;
  error: number;
  /** true = 本歌单上一轮还在跑,本轮被每歌单并发锁直接挡下(什么都没做)。
   *  调用方据此判断这是「空跑」,不应消耗任何节流额度/记录。 */
  concurrencySkipped?: boolean;
}

const EMPTY_MATCH_STATS: AutoMatchStats = { total: 0, matched: 0, noMatch: 0, error: 0 };

/** 自动匹配(歌单导入 / 播放补齐)的在线搜索候选链。
 *  与 match.ts 的 MatchProviderCandidate 结构类型兼容,这里不 import 那个类型:
 *  match.ts 反向 import 本模块的 refreshPlaylistCounts,静态互引会成环(ESM 下
 *  可能出现求值期 undefined),故用结构类型 + 动态 import 取配置。 */
export interface PluginMatchCandidate {
  providerId: string;
  config: any;
  provider: any;
}

/** 拼出「首选插件 + 其它已启用 search 插件」的候选链(排除本尊)。
 *
 *  修的是什么:matchPlaylistInBackground 原先只挑一个 matcher
 *  (firstEnabledByCapability("autoMatch") ?? firstEnabledByCapability("search")),
 *  而 firstEnabledByCapability 只取 [0]——首选插件搜索空/报错时,后面那些明明
 *  装好的插件根本不会被碰到(实测内置插件没人声明 autoMatch,所以永远走 search 分支)。
 *
 *  开关语义:兜底整体由 core-search-fallback 的 enabled 控制;
 *  fallbackOnEmpty / fallbackOnError 分别决定「空结果」和「抛错」是否换下一个候选;
 *  maxCandidates 既算首选也算兜底(默认 2 = 首选 1 + 兜底 1)。
 *  开关全关时候选链退化为「只有首选」,等价于改动前的行为。 */
export async function buildMatchCandidates(
  primaryId: string,
  primaryConfig: any,
  primaryImpl: any,
): Promise<PluginMatchCandidate[]> {
  const head: PluginMatchCandidate[] = [
    { providerId: primaryId, config: primaryConfig, provider: primaryImpl },
  ];
  // 动态 import:searchFallback.ts 反向 import 本模块的 runSourceFallback,静态引会成环。
  const { getSearchFallbackConfig } = await import("../source/online/searchFallback.js");
  const cfg = await getSearchFallbackConfig();
  const fallbackWanted = cfg.enabled && (cfg.fallbackOnEmpty || cfg.fallbackOnError);
  const maxRaw = Math.floor(Number(cfg.maxCandidates));
  if (!fallbackWanted || !Number.isFinite(maxRaw) || maxRaw <= 1) return head;
  const others: PluginMatchCandidate[] = [];
  for (const p of getEnabledByCapability("search")) {
    if (others.length >= maxRaw - 1) break;
    if (p.manifest.id === primaryId) continue; // 排除本尊
    const cfgOther = getPluginConfig(p.manifest.id);
    if (!cfgOther || typeof p.impl?.search !== "function") continue; // 中途被禁用 / 不支持搜索
    others.push({ providerId: p.manifest.id, config: cfgOther, provider: p.impl });
  }
  return [...head, ...others];
}


/** 后台自动匹配一张歌单的未匹配条目(playable=0 且 external_title 非空)。
 *
 *  共享宿主服务:导入歌单(rebuildPlaylistEntries 后)与外置插件歌单
 *  (discovery.upsertPluginPlaylist 写入后)都经此触发,避免两份近似逻辑漂移。
 *  另有一路调用方:**播放触发的自动补齐**(services/playlist/autoMatch.ts,用户点
 *  「播放全部」/ 投屏起播后 fire-and-forget),二者共用这里的能力挑选 / 锁 / 批量闸。
 *  能力驱动:autoMatch 能力优先,否则任意 search 能力插件兜底;每歌单内存锁防并发;
 *  失败不抛(调用方 fire-and-forget)。
 *
 *  @returns 本轮战果;调用方(播放补齐链路)据此决定追加多少首到队尾。
 *  @param onFinished 战果回调(在锁与批量闸释放**之后**触发),用于需要"跑完再说"的调用方。 */
export async function matchPlaylistInBackground(
  playlistId: string,
  onFinished?: (stats: AutoMatchStats) => void,
): Promise<AutoMatchStats> {
  // 上一轮还在跑 —— 直接返回空战果,但标记为「并发空跑」,让调用方能区别于
  // 「真的跑完但一首都没匹配上」这两种 totally 不同的语义。
  if (autoMatchLocks.has(playlistId)) return { ...EMPTY_MATCH_STATS, concurrencySkipped: true };
  autoMatchLocks.add(playlistId);
  // 全局批量闸:与插件任务(jobRunner)共用,全进程同时只跑 1 个批量任务,防叠加。
  // 动态 import 避免顶层环(shared → batchPacer → settings,settings 无回环,静态亦可;
  // 保持动态以稳妥)。
  const { acquireBatchLock } = await import("./batchPacer.js");
  const release = await acquireBatchLock();
  // P2:排队时间不计入匹配耗时——started 在拿到全局批量闸之后才记录,
  // 日志里的 in Xs 只反映真实匹配开销,不含等待队列的时长。
  const started = Date.now();
  let stats: AutoMatchStats = EMPTY_MATCH_STATS;
  try {
    const matcher = firstEnabledByCapability("autoMatch") ?? firstEnabledByCapability("search");
    if (!matcher) return stats; // no capable plugin enabled -> nothing to do
    const config = getPluginConfig(matcher.manifest.id);
    if (!config) return stats; // plugin disabled between lookup and read
    if (typeof matcher.impl?.search !== "function") return stats; // can't actually match
    // 候选链:首选插件 + 其它已启用且声明 search 的插件(排除本尊,受 maxCandidates 约束)。
    const candidates = await buildMatchCandidates(matcher.manifest.id, config, matcher.impl);
    if (candidates.length > 1) {
      console.log(
        `[auto-match] ${playlistId}: 匹配候选链 ${candidates.map((c) => c.providerId).join(" -> ")}`,
      );
    }

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
      candidates,
    );
    stats = {
      total: result.total,
      matched: result.matched,
      noMatch: result.noMatch,
      error: result.error,
    };
    if (result.total > 0) {
      console.log(
        `[auto-match] ${playlistId}: ${result.matched} matched, ${result.noMatch} no-match, ${result.error} errors in ${((Date.now() - started) / 1000).toFixed(1)}s`,
      );
    }
    return stats;
  } finally {
    autoMatchLocks.delete(playlistId);
    release(); // 释放全局批量闸
    onFinished?.(stats);
  }
}

// ==================== 通用跨源兜底 runner ====================
//
// 「逐个候选试、第一个可用的就返回、全耗尽回传轨迹」这件事在换源/搜索两处都要用,
// 且各自都带「总预算 + 最多试几个」双闸门(防某个慢源把播放/搜索请求拖死)。
// 与其复制两份,不如把闸门与轨迹语义收敛成一个与业务无关的纯 runner:
//
//   runSourceFallback({ candidates, isUsable, budgetMs, maxTries, ... })
//     → { ok, value, trace, exhausted }
//
// 设计要点:
//   - **候选与业务解耦**:调用方决定候选从哪来(其它插件 / 其它音源 / 其它候选行),
//     runner 只管「试 → 判可用 → 记轨迹 → 换下一个」;
//   - **不吞错**:候选抛错记进 trace 后继续下一个,最终把整条 trace 交还调用方,
//     所以「全耗尽」时调用方能拼出人类可读的原因(不是一句笼统的「搜索失败」);
//   - **预算是硬闸门**:单次候选也受总预算余量约束(超时即放弃该候选并停手),
//     避免一个卡住的源吃掉整个预算导致后续候选根本没机会试;
//   - **可注入时间源**(opts.now)便于测试确定性推进时钟。
//
// 与 streamFallback.ts 的关系:那是既有实现(带负缓存/TTL/三态探测语义),代码里
// findFallbackStream 已有一套既有测试与「网络异常不写负缓存」的约定,本 runner 不
// 复用它、也不改它(正确性优先,见交付说明);本 runner 服务于搜索层的跨插件兜底。

/** 一个待尝试的兜底候选(与业务无关,由调用方填充)。 */
export interface FallbackCandidate<T> {
  /** 轨迹段标识(插件 id / 音源名 / 候选行标识),进 trace 形如 `netease(403)`。 */
  label: string;
  /** 执行一次尝试;抛错由 runner 捕获并记入 trace(不向上抛)。 */
  run: () => Promise<T>;
}

export interface RunSourceFallbackOptions<T> {
  /** 候选列表(按优先级从前往后)。 */
  candidates: FallbackCandidate<T>[];
  /** 判定该次结果是否可用(可用即直接返回,不再尝试后续候选)。 */
  isUsable: (value: T) => boolean;
  /** 总预算(毫秒),默认 6000。余量耗尽即停手(已发出的尝试不中断)。 */
  budgetMs?: number;
  /** 最多尝试几个候选(不含调用方自己已试过的主候选),默认 2。 */
  maxTries?: number;
  /** 候选抛错时额外记一笔(返回 null 表示不记)。默认 `${label}(${错误前 80 字})`。 */
  onError?: (label: string, err: unknown) => string | null;
  /** 结果不可用时额外记一笔(返回 null 表示不记)。默认 `${label}(空结果)`。 */
  onEmpty?: (label: string) => string | null;
  /** 时间源(默认 Date.now),便于测试。 */
  now?: () => number;
}

export interface SourceFallbackOutcome<T> {
  /** 是否命中可用结果。 */
  ok: boolean;
  /** 命中结果(未命中为 null)。 */
  value: T | null;
  /** 逐个候选的轨迹段(形如 ["netease(空结果)", "lx-source(403)"])。 */
  trace: string[];
  /** true = 候选全部用尽/被闸门掐掉且无可用结果(调用方据此决定兜底提示文案)。 */
  exhausted: boolean;
}

/** 默认总预算(毫秒)。与 core-search-fallback.budgetMs 默认值保持一致。 */
export const FALLBACK_BUDGET_MS_DEFAULT = 6000;
/** 默认最多尝试的候选数(不含主候选)。与 core-search-fallback.maxCandidates 一致。 */
export const FALLBACK_MAX_TRIES_DEFAULT = 2;

/** 错误摘要:超长截断到前 80 字(根因通常在开头:状态码/异常类型/URL 前缀)。 */
export function summarizeError(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err ?? "");
  return msg.length > 80 ? msg.slice(0, 79) + "…" : msg;
}

/** 把一段尝试限制在给定毫秒内;超时抛错(由 runner 记 trace 后换下一个候选)。 */
export function withinBudget<T>(p: Promise<T>, ms: number): Promise<T> {
  if (!Number.isFinite(ms) || ms <= 0) return Promise.reject(new Error(`超过兜底预算 ${ms}ms`));
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`超过兜底预算 ${Math.round(ms)}ms`)), ms);
    Promise.resolve(p).then(
      (v) => { clearTimeout(timer); resolve(v); },
      (e) => { clearTimeout(timer); reject(e instanceof Error ? e : new Error(String(e ?? ""))); },
    );
  });
}

/**
 * 通用跨源兜底:逐候选尝试,第一个「isUsable」的结果直接返回;全耗尽回传整条 trace。
 *
 * 双闸门:
 *   - `budgetMs` 总预算(默认 6000ms):每试一个候选前先算剩余预算,<=0 立即停手并
 *     记 `${label}(超预算)`;单个候选也被同一预算约束(超时即放弃该候选);
 *   - `maxTries` 最多尝试数(默认 2):防止在插件数量多时把一次搜索拖成遍历。
 *
 * 抛错**不**向上抛:每个候选的失败都记进 trace 后继续下一个 —— 兜底的价值就在于
 * 「一个源挂了还有下一个」,而「全部挂了」的原因要靠 trace 回传给调用方/前端。
 *
 * @returns { ok, value, trace, exhausted } —— ok=false 时 value 恒 null。
 */
export async function runSourceFallback<T>(opts: RunSourceFallbackOptions<T>): Promise<SourceFallbackOutcome<T>> {
  const budgetMs =
    Number.isFinite(opts.budgetMs) && (opts.budgetMs as number) > 0
      ? (opts.budgetMs as number)
      : FALLBACK_BUDGET_MS_DEFAULT;
  const maxTriesRaw = Number(opts.maxTries);
  const maxTries = Number.isFinite(maxTriesRaw) && maxTriesRaw >= 0 ? Math.floor(maxTriesRaw) : FALLBACK_MAX_TRIES_DEFAULT;
  const isUsable = typeof opts.isUsable === "function" ? opts.isUsable : ((v: T) => !!v);
  const now = typeof opts.now === "function" ? opts.now : () => Date.now();
  const startedAt = now();
  const trace: string[] = [];
  const list: FallbackCandidate<T>[] = Array.isArray(opts.candidates) ? opts.candidates : [];
  const limit = Math.min(maxTries, list.length);

  for (let i = 0; i < limit; i++) {
    const cand = list[i];
    if (!cand || typeof cand.run !== "function") continue;
    const remain = budgetMs - (now() - startedAt);
    if (remain <= 0) {
      trace.push(`${cand.label}(超预算)`);
      break;
    }
    try {
      const value = await withinBudget(cand.run(), remain);
      if (isUsable(value)) return { ok: true, value, trace, exhausted: false };
      const seg = opts.onEmpty ? opts.onEmpty(cand.label) : `${cand.label}(空结果)`;
      if (seg) trace.push(seg);
    } catch (e) {
      const seg = opts.onError ? opts.onError(cand.label, e) : `${cand.label}(${summarizeError(e)})`;
      if (seg) trace.push(seg);
    }
  }
  return { ok: false, value: null, trace, exhausted: true };
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
