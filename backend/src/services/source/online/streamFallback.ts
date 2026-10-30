// ==================== Stream fallback (multi-source replay) ====================
//
// go-music-dl's platform parsers fail for some songs (e.g. an original QQ/kugou
// version may resolve to 404 while the same song exists and streams fine on
// netease). When /rest/stream proxies a web song and the original upstream URL
// fails, we search the same provider for an alternative version on another
// platform and stream that instead — so the track still plays.
//
// Fallbacks are memoized per song id (in memory) to avoid re-searching on every
// Range / next-play request.
//
// 2026-09-11 修复「永久拉黑」：两个缓存此前都没有 TTL，负结果一旦写入就永久有效
// （只靠 FIFO 上限 / 进程重启 / 内存回收清），而 ensurePlayableStream 里负缓存判断
// 又排在 probe(song.url) 之前 → 命中负缓存连原链都不再探。投屏场景下该曲被摘出队列
// 后设备不会拉流，/rest/stream 的「上游失败即逐出」自愈路径也不触发 ⇒
// **一次网络抖动就能让一首歌在本进程内永久播不出**。现改为：
//   ① 每条缓存带时间戳；② 正/负结果都有 TTL；
//   ③ probe 区分「明确不存在(403/404/410)」与「网络异常/超时」—— 后者不写负缓存。

import { getConfiguredProvider } from "./index.js";
import { OnlineSongResult } from "./types.js";
import { db } from "../../../db/index.js";
import { songs } from "../../../db/schema.js";
import { eq } from "drizzle-orm";
import { getEnabledSourcePlugins, getPluginManifest, getPluginConfig } from "../../../plugins/registry.js";
import type { PluginManifest } from "../../../plugins/types.js";
import { passesImportGate, getImportGateConfig, type ImportGateConfig } from "./importGate.js";
import { STREAM_FALLBACK_PLUGIN_ID } from "../../plugin/core/streamFallbackPlugin.js";
import { resolvePreferredSong } from "../preferredSource.js";
import { getEffectiveBaseUrl } from "../../dlna/control.js";
import { getStreamSourcePriority } from "./streamSourcePriority.js";
import { createLogger } from "../../../utils/logger.js";

const log = createLogger("StreamFallback");

/** 进程标识:同一份代码在主进程与 sendspin 子进程各跑一份,负缓存也是各一份。
 *  排障时必须能区分是哪一侧写的,否则跨进程问题会被误读成「随机」。 */
function who(): string {
  try {
    return process.env.MUSICFLOW_SENDSPIN_CHILD === "1" ? "sendspin-child" : "main";
  } catch {
    return "?";
  }
}

/** 读取换源兜底配置(core-stream-fallback 内置插件):enabled 总开关 + 时长容差覆写。 */
function getFallbackConfig(): { enabled: boolean; durationTolerance: number } {
  const cfg = (getPluginConfig(STREAM_FALLBACK_PLUGIN_ID) || {}) as Record<string, unknown>;
  const tol = Number(cfg.durationTolerance);
  return {
    enabled: cfg.enabled !== false,
    durationTolerance: Number.isFinite(tol) && tol > 0 ? tol : 0,
  };
}

// Bounded in-memory caches. Both grow with every web song played, so enforce a
// FIFO cap to keep memory usage bounded on long-running servers.
const FALLBACK_CACHE_MAX = 2000;
const PLAYABLE_CACHE_MAX = 5000;

// ==================== 缓存 TTL(2026-09-11)====================
//
// 三档有效期，负结果/退避可由 core-pre-probe 插件配置覆写(configureStreamFallbackCache):
//   - 正结果:确认可播 → **1 小时**(ray 2026-09-11 定)。
//     注意它**不刷新 URL**,只避免重复探测:平台直链(实测约 20 分钟)失效后,
//     首次拉流会失败一次,由 /rest/stream 的「上游失败即 evictStreamFallbackCache」
//     自愈并重新换源 —— 所以正 TTL 取长只会**减少上游探测次数**,代价是"直到有人播
//     才发现链过期"这一次失败。此前是裸 Set 永不失效(比 1 小时更差),现改为带 TTL。
//   - 负结果:所有平台都没有可播候选 → 默认 **2 小时**后重新探测,**源恢复即自动
//     复活**(2026-10-27 用户拍板统一:此前默认 45s,靠 core-pre-probe 插件配置
//     negativeTtlSeconds(默认 7200)拉长 —— 现在模块默认与插件默认对齐,两类负缓存
//     (探测型 + 内容型 markUnplayable)读同一份可配置 TTL;持久死链播到即跳过,
//     不再每次重试几十秒,VIP/版权恢复后 2 小时内自动复活)。
//   - 网络异常:只短期退避,**不判定不可播**(网络抖动 ≠ 这首歌没有源)。
const PLAYABLE_TTL_DEFAULT_MS = 60 * 60 * 1000;
const NEGATIVE_TTL_DEFAULT_MS = 2 * 60 * 60 * 1000;
const TRANSIENT_BACKOFF_DEFAULT_MS = 5 * 1000;

/** 单曲探测超时默认值(毫秒)。预探测路径可传更短的值(不阻塞播放)。 */
export const PROBE_TIMEOUT_DEFAULT_MS = 12 * 1000;

let playableTtlMs = PLAYABLE_TTL_DEFAULT_MS;
let negativeTtlMs = NEGATIVE_TTL_DEFAULT_MS;
let transientBackoffMs = TRANSIENT_BACKOFF_DEFAULT_MS;

/** 覆写缓存 TTL(由 core-pre-probe 配置驱动;非法/缺省值保持原值)。 */
export function configureStreamFallbackCache(opts: {
  playableTtlMs?: number;
  negativeTtlMs?: number;
  transientBackoffMs?: number;
}): void {
  if (Number.isFinite(opts.playableTtlMs) && (opts.playableTtlMs as number) > 0) playableTtlMs = opts.playableTtlMs as number;
  if (Number.isFinite(opts.negativeTtlMs) && (opts.negativeTtlMs as number) > 0) negativeTtlMs = opts.negativeTtlMs as number;
  if (Number.isFinite(opts.transientBackoffMs) && (opts.transientBackoffMs as number) >= 0) transientBackoffMs = opts.transientBackoffMs as number;
}

// 搜索结果的源排序偏好:由源插件 manifest.sourcePreference 声明(核心不写死平台顺序)。
function getSourcePreference(providerId: string): string[] {
  return getPluginManifest(providerId)?.sourcePreference || [];
}

// Default fallback provider: the song's own pluginEntry if known, else the first
// enabled source plugin that declares the "stream" capability. Returns "" when no
// source plugin is available (no plugin → no fallback, behaviour-safe).
function defaultStreamProviderId(songPluginEntry?: string | null): string {
  if (songPluginEntry) return songPluginEntry;
  for (const { manifest } of getEnabledSourcePlugins()) {
    if (manifest.capabilities.includes("stream")) return manifest.id;
  }
  return "";
}

// songId -> 换源结果。url=命中 URL / null=无替代源；at=写入时间；ttlMs=有效期
// (负结果与网络异常两种)；transient=true 表示"这是网络异常，不是判定不可播"。
type FallbackEntry = { url: string | null; at: number; ttlMs: number; transient: boolean };
const fallbackCache = new Map<string, FallbackEntry>();

function setFallback(key: string, url: string | null, opts?: { transient?: boolean; ttlMs?: number }) {
  const transient = opts?.transient === true;
  fallbackCache.set(key, {
    url,
    at: Date.now(),
    ttlMs: opts?.ttlMs ?? (transient ? transientBackoffMs : negativeTtlMs),
    transient,
  });
  // 取证日志(2026-10-30,纯增量):只记**负结果**写入 —— 正结果每次切歌都有,记了是噪音。
  // ttl 从缓存读回,不重算 TTL 表达式,确保与真实生效值一致。
  if (url === null) {
    const e = fallbackCache.get(key);
    log.info(
      `负缓存写入 song=${key} 档=${transient ? "transient" : "definitive"}` +
        ` ttlMs=${e?.ttlMs ?? -1} who=${who()}`,
    );
  }
  if (fallbackCache.size > FALLBACK_CACHE_MAX) {
    const oldest = fallbackCache.keys().next().value;
    if (oldest === undefined) return;
    fallbackCache.delete(oldest);
  }
}

/** 读取未过期的换源条目；已过期则删除并返回 undefined（下次调用会重新探测）。 */
function getFallback(key: string): FallbackEntry | undefined {
  const e = fallbackCache.get(key);
  if (!e) return undefined;
  if (Date.now() - e.at >= e.ttlMs) {
    fallbackCache.delete(key);
    return undefined;
  }
  return e;
}

/**
 * 解析换源兜底用的 provider:优先 song.pluginEntry 本尊;本尊缺 stream 或 search
 * 能力(纯曲库核实源,如 huawei-chart:有 search 能核实、无 stream 出直链)时,
 * 回退首个「search + stream」齐备的启用源插件。都无 → null(不兜底,行为安全)。
 */
function resolveStreamProvider(providerId: string): { provider: any; config: Record<string, any> } | null {
  const primary = getConfiguredProvider(providerId);
  if (
    primary?.provider &&
    typeof primary.provider.streamUrl === "function" &&
    typeof primary.provider.search === "function"
  ) {
    return primary;
  }
  for (const { manifest } of getEnabledSourcePlugins()) {
    if (!manifest.capabilities.includes("stream") || !manifest.capabilities.includes("search")) continue;
    if (manifest.id === providerId) continue; // 本尊已查过,不合格
    const alt = getConfiguredProvider(manifest.id);
    if (
      alt?.provider &&
      typeof alt.provider.streamUrl === "function" &&
      typeof alt.provider.search === "function"
    ) {
      return alt;
    }
  }
  return null;
}

// ==================== 播放来源优先级(用户可调取源顺序) ====================
//
// 用户在「插件管理 → 媒体获取」页配置取源顺序(见 streamSourcePriority.ts)。
// 列表**非空**时,findFallbackStream 严格按列表顺序逐项尝试,歌曲「本尊插件」不再
// 享有特权(本尊不在列表里就不被优先尝试)。列表条目**只有插件级**(就是 plugin id),
// 插件内部用哪个平台、按什么顺序取源由插件自己决定,宿主不干预:
//   - 具备 search 能力的插件:走该插件常规 search —— 按插件内置 sourcePreference 排列
//     各平台候选,候选须过 importGate;并沿用旧语义跳过「本尊失败平台」(同平台多半是
//     同一条死链);
//   - 纯 stream 插件(含 stream 不含 search):走 `resolveStream(config, songLike)`。
// 任一项拿到 probe 通过的 URL 即返回;全部失败 → 用与默认路径同一把尺子写负缓存/退避。
// 列表为空 → 原有路径(本尊优先 → 启用顺序,含纯 stream 轮询)完全不变。

/** 优先级取源上下文(把 findFallbackStream 的入参与预计算项打包,供各 helper 共用)。 */
interface PriorityContext {
  songId: string;
  title: string;
  artist: string;
  album: string;
  duration: number;
  providerId: string;
  failingSource: string;
  timeoutMs: number;
  query: string;
  gateCfg: ImportGateConfig | undefined;
}

/** 优先级取源的副作用标记:用于末尾统一判定「负结果」还是「短期退避」。 */
interface PriorityFlags {
  /** 出现过「网络异常/超时」——不得据此判定不可播。 */
  sawTransient: boolean;
  /** 任一 search 抛错 —— 属不可判定,最终按 transient 退避而非判死。 */
  searchFailed: boolean;
}

/** 组装纯 stream 插件 resolveStream 的入参 songLike(含 songs.sourceData 原文)。 */
function loadSongLike(ctx: PriorityContext): {
  id: string; title: string; artist: string; album: string;
  duration: number; pluginEntry: string; sourceData: string | null;
} {
  let sdRaw: string | null = null;
  try {
    sdRaw = db.select({ sourceData: songs.sourceData }).from(songs).where(eq(songs.id, ctx.songId)).get()?.sourceData ?? null;
  } catch { sdRaw = null; }
  return {
    id: ctx.songId, title: ctx.title, artist: ctx.artist, album: ctx.album,
    duration: ctx.duration, pluginEntry: ctx.providerId, sourceData: sdRaw,
  };
}

/**
 * 用某个「具备 search 能力」的插件尝试取源(插件级)。
 * 走该插件常规 search(插件内部自行决定各平台候选),沿用旧语义跳过本尊失败平台
 * (同平台多半是同一条死链);不向插件透传 `sources`,平台选择交给插件自己。
 */
async function tryPrioritySearchProvider(
  pluginId: string,
  configured: { provider: any; config: Record<string, any> },
  ctx: PriorityContext,
  flags: PriorityFlags,
): Promise<{ url: string; source: string } | null> {
  const { provider, config } = configured;
  if (typeof provider?.search !== "function" || typeof provider?.streamUrl !== "function") return null;

  const params = { query: ctx.query };
  let results: OnlineSongResult[];
  try {
    const r = await provider.search(config, params);
    results = r?.songs || [];
  } catch {
    // 搜索请求失败(网络异常/上游 5xx)→ 不判定「没有源」,只打标记供末尾退避。
    flags.searchFailed = true;
    return null;
  }

  const preference = getSourcePreference(pluginId);
  const ranked = results
    .filter(s => {
      if (!s?.name) return false;
      if (s.source === ctx.failingSource) {
        // 跳过「刚失败的平台」(与默认路径同语义)。
        return false;
      }
      return passesImportGate(
        { title: ctx.title, artist: ctx.artist, album: ctx.album || null, duration: ctx.duration > 0 ? ctx.duration : null },
        { name: s.name, artist: s.artist, album: s.album, duration: s.duration },
        ctx.gateCfg,
      ).ok;
    })
    .sort((a, b) => {
      const ar = preference.indexOf(a.source);
      const br = preference.indexOf(b.source);
      return (ar === -1 ? 99 : ar) - (br === -1 ? 99 : br);
    });

  for (const cand of ranked) {
    const url = provider.streamUrl(config, cand);
    if (!url) continue;
    const outcome = await probe(url, ctx.timeoutMs);
    if (outcome === "ok") return { url, source: cand.source };
    if (outcome === "transient") flags.sawTransient = true;
  }
  return null;
}

/** 用某个「纯 stream 插件」尝试取源:resolveStream(config, songLike) → URL,probe 通过才换。 */
async function tryPriorityResolveStream(
  manifest: PluginManifest,
  configured: { provider: any; config: Record<string, any> },
  ctx: PriorityContext,
  flags: PriorityFlags,
): Promise<{ url: string; source: string } | null> {
  const { provider, config } = configured;
  if (typeof provider?.resolveStream !== "function") return null;
  let url = "";
  try {
    url = String((await provider.resolveStream(config, loadSongLike(ctx))) || "");
  } catch {
    url = ""; // 插件内部错误 = 该跳失败,与返回 "" 同语义,不阻塞后续候选
  }
  if (!url) return null;
  const outcome = await probe(url, ctx.timeoutMs);
  if (outcome === "ok") return { url, source: manifest.id };
  if (outcome === "transient") flags.sawTransient = true;
  return null;
}

/**
 * 严格按用户优先级列表逐项尝试取源。命中 → {url, source};全部失败 → null。
 * 列表条目即规范化的 plugin id:有 search 能力走 search 路径,否则纯 stream
 * 插件走 resolveStream。未启用/未配置的插件条目直接跳过(可用性由 UI 保障)。
 */
async function tryPrioritySources(
  priority: string[],
  ctx: PriorityContext,
  flags: PriorityFlags,
): Promise<{ url: string; source: string } | null> {
  for (const pluginId of priority) {
    const configured = getConfiguredProvider(pluginId);
    if (!configured?.provider) continue;
    if (typeof configured.provider.search === "function") {
      const hit = await tryPrioritySearchProvider(pluginId, configured, ctx, flags);
      if (hit) return hit;
      continue;
    }
    const manifest = getPluginManifest(pluginId);
    if (manifest && typeof configured.provider.resolveStream === "function") {
      const hit = await tryPriorityResolveStream(manifest, configured, ctx, flags);
      if (hit) return hit;
    }
  }
  return null;
}

export async function findFallbackStream(
  songId: string,
  title: string,
  artist: string,
  album: string,
  duration: number,
  providerId: string,
  failingSource: string,
  timeoutMs: number = PROBE_TIMEOUT_DEFAULT_MS,
): Promise<{ url: string; source: string } | null> {
  const cachedEntry = getFallback(songId);
  if (cachedEntry) {
    if (cachedEntry.url) return { url: cachedEntry.url, source: "" };
    return null;
  }
  // 结构性无解(缺标题 / provider 解析不出):确定性结论,写负缓存。
  if (!title) { setFallback(songId, null); return null; }

  // 总开关(core-stream-fallback):关闭时不再搜索替代源。不写负缓存——开关
  // 随时可改,负缓存会让重新开启后首次播放仍误判无兜底。
  const fbCfg = getFallbackConfig();
  if (!fbCfg.enabled) return null;

  const query = [title, artist].filter(Boolean).join(" ");
  const gateCfg: ImportGateConfig | undefined = fbCfg.durationTolerance > 0
    ? { ...getImportGateConfig(), durationTolerance: fbCfg.durationTolerance }
    : undefined;

  // ---------- 用户配置的「播放来源优先级」:列表非空 → 严格按列表顺序取源 ----------
  const priority = getStreamSourcePriority();
  if (priority.length > 0) {
    const flags: PriorityFlags = { sawTransient: false, searchFailed: false };
    const ctx: PriorityContext = { songId, title, artist, album, duration, providerId, failingSource, timeoutMs, query, gateCfg };
    const hit = await tryPrioritySources(priority, ctx, flags);
    if (hit) {
      setFallback(songId, hit.url);
      return hit;
    }
    // 列表内全部候选都不可播:与默认路径同一把尺子 —— 只要出现过网络异常/search 抛错
    // 就只短期退避(网络抖动 ≠ 没有源),否则写负结果(45s 后重探,源恢复即复活)。
    setFallback(songId, null, { transient: flags.sawTransient || flags.searchFailed });
    return null;
  }

  // provider 解析:pluginEntry 缺 stream/search 能力时自动回退首个齐备源插件
  // (resolveStreamProvider),避免对纯核实源(huawei-chart 等)误判无兜底。
  const configured = resolveStreamProvider(providerId);
  if (!configured) { setFallback(songId, null); return null; }

  let results: OnlineSongResult[];
  let searchFailed = false;
  try {
    const r = await configured.provider.search(configured.config, { query });
    results = r.songs || [];
  } catch {
    // 搜索请求本身失败(网络异常/上游 5xx)→**不判定"没有源"**,只短期退避
    // (2026-10-04 240 真机实锤):旧实现在此直接 return,把下游「纯 stream 插件
    // 跨插件兜底」整段跳过——本尊(gmd)一抛错,洛雪按歌曲 sourceData 里的平台
    // 原生 ID 直查直链的机会就没了(gmd 挂掉时正是这个场景)。改为打标记后
    // 走空结果路径,纯 stream 插件照常轮询;全无果时再由末尾统一按 searchFailed
    // 写 transient 负缓存,语义与原「短期退避」完全一致。
    searchFailed = true;
    results = [];
  }

  // 换源兜底与导入门禁同套断言(v2.3.4):候选必须通过 passesImportGate——
  // 规范化标题+歌手(强制)+ 专辑一致(开关默认开)+ 时长差 ≤ 容差,全命中才允许换源。
  // 此前兜底只有「歌名严格相等 + 歌手首位名分」两维,元数据冒名候选(如《恋人》
  // 被换成网易云「李荣浩-、Montagem」的 funk remix:歌名相等、'李荣浩-'.includes
  // ('李荣浩') 恒真)通过后还被 updateSongUrl 持久化污染 songs.url,此后每次播放
  // 都直用错链。期望侧缺字段(无专辑/无时长)时对应维度自动跳过,与导入语义一致。
  // 时长容差由 gateCfg(函数入口已按 core-stream-fallback.durationTolerance 计算)承载;
  // 排序偏好(sourcePreference)不变。
  const preference = getSourcePreference(providerId);
  const ranked = results
    .filter(s => {
      if (s.source === failingSource || !s.name) return false;
      return passesImportGate(
        { title, artist, album: album || null, duration: duration > 0 ? duration : null },
        { name: s.name, artist: s.artist, album: s.album, duration: s.duration },
        gateCfg,
      ).ok;
    })
    .sort((a, b) => {
      const ar = preference.indexOf(a.source);
      const br = preference.indexOf(b.source);
      return (ar === -1 ? 99 : ar) - (br === -1 ? 99 : br);
    });

  let sawTransient = false;
  for (const cand of ranked) {
    const url = configured.provider.streamUrl(configured.config, cand);
    const outcome = await probe(url, timeoutMs);
    if (outcome === "ok") {
      setFallback(songId, url);
      return { url, source: cand.source };
    }
    if (outcome === "transient") sawTransient = true;
  }

  // 纯 stream 插件跨插件兜底(2026-10-04):本尊重搜+平台轮换全败后,逐个尝试
  // 只声明 stream、**不含** search 的启用源插件(如 lx-source:按歌 sourceData 里的
  // 平台原生 ID 直查洛雪源脚本 musicUrl 并多源轮切,不依赖重搜)。契约与核心调用
  // 插件的既有惯例一致:resolveStream(config, songLike) → Promise<string>,
  // 成功=直链 URL,失败/无链=""(异常同败)。probe 通过才换链;任何结果都计入
  // sawTransient 语义,最终负缓存/退避判定与原先完全一致。
  let sdRaw: string | null = null;
  try {
    sdRaw = db.select({ sourceData: songs.sourceData }).from(songs).where(eq(songs.id, songId)).get()?.sourceData ?? null;
  } catch { sdRaw = null; }
  const songLike = { id: songId, title, artist, album, duration, pluginEntry: providerId, sourceData: sdRaw };
  for (const { manifest } of getEnabledSourcePlugins()) {
    if (!manifest.capabilities.includes("stream") || manifest.capabilities.includes("search")) continue;
    if (manifest.id === providerId) continue; // 本尊已在上面走过,不重复
    const alt = getConfiguredProvider(manifest.id);
    if (!alt?.provider || typeof alt.provider.resolveStream !== "function") continue;
    let url = "";
    try {
      url = String((await alt.provider.resolveStream(alt.config, songLike)) || "");
    } catch {
      url = ""; // 插件内部错误=该跳失败,与返回 "" 同语义,不阻塞后续候选
    }
    if (!url) continue;
    const outcome = await probe(url, timeoutMs);
    if (outcome === "ok") {
      setFallback(songId, url);
      return { url, source: manifest.id };
    }
    if (outcome === "transient") sawTransient = true;
  }

  // 全候选都不可播:只要其中有「网络异常/超时」就不判定不可播(网络抖动 ≠ 没有源),
  // 只按短期退避记;只有全是明确的 403/404/410 才写负结果。
  setFallback(songId, null, { transient: sawTransient || searchFailed });
  return null;
}

/** 单曲探测结果。刻意分三态,避免把「网络异常」误判成「没有源」。 */
export type ProbeOutcome = "ok" | "gone" | "transient";

/**
 * content-type 明确非音频 → 判 gone(2026-09-14「带我走-杨丞琳」实锤:migu 源挂掉时
 * music-dl 透传上游 `HTTP 200 + application/json {"code":"200002","info":"PE参数格式错误"}`,
 * 仅凭状态码判 ok → 死链当可播 → 设备拉到 47 字节垃圾后 MUZO 永久卡 BUFFERING)。
 * 黑名单只拦"明确不是音频"的信号(json/text);缺失、audio/*、octet-stream、application/ogg
 * 等模糊值保守放行 —— 正规 CDN 存在无 content-type / octet-stream 的合法音频响应,
 * 宁漏杀不错杀。
 */
function isExplicitNonAudioContentType(contentType: string | null): boolean {
  const ct = (contentType || "").split(";")[0].trim().toLowerCase();
  if (!ct) return false;
  return ct === "application/json" || ct.endsWith("+json") || ct.startsWith("text/");
}

/**
 * 探测一个流 URL 是否可播。
 *   - "ok"        200/206 且 content-type 非明确非音频 → 可播;
 *   - "gone"      403/404/410,或 200/206 但 content-type 明确非音频(JSON/text 错误体)
 *                 → **明确不可播**,可据此判定不可播并触发多源兜底;
 *   - "transient" 429/5xx/网络异常/超时 → **不可判定**,调用方不得据此写负缓存。
 * 此前把三者一律算 false(2026-09-11 前),一次网络抖动就能把一首歌永久判死。
 */
async function probe(url: string, timeoutMs: number = PROBE_TIMEOUT_DEFAULT_MS): Promise<ProbeOutcome> {
  if (!url) return "gone";
  try {
    const res = await fetch(url, { headers: { Range: "bytes=0-20000" }, signal: AbortSignal.timeout(timeoutMs) });
    const status = res.status;
    const contentType = res.headers.get("content-type");
    await res.body?.cancel();
    if (status === 200 || status === 206) {
      if (isExplicitNonAudioContentType(contentType)) return "gone";
      return "ok";
    }
    if (status === 403 || status === 404 || status === 410) return "gone";
    return "transient";
  } catch {
    return "transient";
  }
}

export { probe as probeStream };

/**
 * 在线直链轻量复核(预探测扫描与 judge 播前裁决**共用同一把尺子**)。
 *
 * 背景:正缓存(可播记忆,TTL 1 小时)命中即短路 —— 一首歌扫描时活、播时死
 * (酷狗直链 404),judge 若盲信正缓存就会把死链推给播放器。2026-09-16 的复核
 * 只长在扫描路径,judge 没份,两把尺子量同一个"可播"。
 *
 * 语义:仅对「在线直链行」(有 url ＋ pluginEntry)做一次短超时 probe;
 * 非在线行(本地/WebDAV/空直链)返回 "skip",调用方按原逻辑走。
 *   - "ok"        直链仍活,维持原判;
 *   - "gone"      直链明确已死(404/403/410 或显式非音频) —— 这是知识不是未知,
 *                 调用方应逐出正缓存、找替代,无替代可判跳过;
 *   - "transient" 网络抖动,维持原判(绝不据此写负缓存);
 *   - "skip"      非在线直链行,调用方按原逻辑走。
 */
export async function recheckOnlineDirect(
  row: { url?: string | null; pluginEntry?: string | null } | null | undefined,
  timeoutMs: number,
): Promise<"ok" | "gone" | "transient" | "skip"> {
  const url = row?.url;
  const isOnlineDirect =
    typeof url === "string" && url.length > 0 &&
    typeof row?.pluginEntry === "string" && !!row.pluginEntry;
  if (!isOnlineDirect) return "skip";
  try {
    return await probe(url, timeoutMs);
  } catch {
    return "transient";
  }
}

export function clearFallbackCache(songId?: string) {
  if (songId) fallbackCache.delete(songId);
  else fallbackCache.clear();
}

/**
 * 内容型判死（预取完整性判官专用）：把「整首字节已抓到、但内容是试听片段/假成功」
 * 记为负结果。与探测路径的负缓存**同一份数据**（`getCachedPlayability` 直接读），
 * 且共用**同一份可配置 TTL**（`negativeTtlMs`，模块默认 2 小时，core-pre-probe
 * 插件配置 negativeTtlSeconds 可覆写）—— 2026-10-27 用户拍板统一，废除原独立
 * 固定值 5 分钟（5 分钟过期太快，重复播放场景每 5 分钟重蹈一次坏源）。
 * 判据是完整字节跑出来的硬结论，不是一次抖动；又不锁死太久：平台版权/VIP/试听
 * 策略会变，过期后自动复活重探。
 */
export function markUnplayable(songId: string, opts?: { ttlMs?: number }): void {
  if (!songId) return;
  const ttlMs = opts?.ttlMs && opts.ttlMs > 0 ? opts.ttlMs : negativeTtlMs;
  // 立即清掉可能存在的正缓存：否则同一首歌同时持有「可播(1h)」与「不可播」两条，
  // 读视图按正缓存优先 ⇒ 判跳失效（见 addPlayable 的注释）。
  playableCache.delete(songId);
  // 与 setFallback 的通用负缓存日志分开:这条是**内容判官**的结论(整曲字节判出
  // 试听片段/假成功),性质与「换源穷尽」不同,排障要能一眼分辨。
  log.info(`判死(内容判官) song=${songId} ttlMs=${ttlMs} who=${who()}`);
  setFallback(songId, null, { transient: false, ttlMs });
}

/**
 * 拉流实测失败时逐出该歌的换源/可播缓存(由代理层在 upstream 真实 403/404/5xx
 * 时调用)。插件源直链会过期(网易等约 20 分钟),而两个缓存命中即返回、不重探
 * (probe 只发生在搜索候选时),过期链会被锁死到 FIFO 淘汰或重启 —— 逐出后下次
 * findFallbackStream/ensurePlayableStream 重新走真实探测/换源。
 */
export function evictStreamFallbackCache(songId: string): void {
  fallbackCache.delete(songId);
  playableCache.delete(songId);
}

/** 清空全部回退缓存(含可播记忆,供空闲内存回收;下次使用会重新探测)。 */
export function clearStreamFallbackCache(): void {
  fallbackCache.clear();
  playableCache.clear();
}

// songId -> 确认可播的时间戳（带 TTL,见文件头说明）。
const playableCache = new Map<string, number>();

function addPlayable(songId: string) {
  // ★ 2026-10-27（《纵身一跃》第四刀）：**已知不可播的歌不得被「源解析成功」重新标成
  //   可播**。VIP 试听源的直链能 200/206 正常解析（源没错，错在内容只有 60s），于是
  //   队列预解析（RESOLVE-AUDIO）先写正缓存，把判官刚写的负缓存盖住；而
  //   getCachedPlayability 读正缓存优先 ⇒ 判跳失效，照播 60s 假歌。
  //   负缓存未过期期间一律拒绝写正缓存；负缓存过期（源可能已恢复）后自动解禁。
  // 取证:正缓存被负缓存拒绝(源解析成功但翻不回 playable)的唯一痕迹。
  // 注意:下面这行 `if (isNegativeFresh(songId)) return;` 被
  // scripts/check-group-invariants.mjs 的 G16 静态钉死,**不许改写成花括号块**。
  if (isNegativeFresh(songId)) log.info(`正缓存被负缓存拒绝 song=${songId} who=${who()} (负结果仍新鲜)`);
  if (isNegativeFresh(songId)) return;
  playableCache.set(songId, Date.now());
  if (playableCache.size > PLAYABLE_CACHE_MAX) {
    const oldest = playableCache.keys().next().value;
    if (oldest !== undefined) playableCache.delete(oldest);
  }
}

/**
 * 负结果是否仍然有效（**只读**，不做过期删除 —— 这里是写路径的判据，不是读视图）。
 * 只认「明确不可播」（url 为空且非 transient）；网络抖动档不拦截正缓存。
 */
function isNegativeFresh(songId: string): boolean {
  const e = fallbackCache.get(songId);
  if (!e || e.url || e.transient) return false;
  return Date.now() - e.at < e.ttlMs;
}

/** 正结果是否仍然可信(带 TTL)；过期则删除并返回 false。 */
function isPlayableFresh(songId: string): boolean {
  const at = playableCache.get(songId);
  if (at === undefined) return false;
  if (Date.now() - at >= playableTtlMs) {
    playableCache.delete(songId);
    return false;
  }
  return true;
}

/**
 * 查询某首歌**当前**的可播性判定（供预探测调度与"已知不可播就跳过"使用）。
 * 全部带 TTL，过期即"unknown"：
 *   - "playable"   正缓存未过期，确认可播；
 *   - "unplayable" 负缓存未过期，**明确的**不可播（所有平台都没有可播候选）；
 *   - "transient"  近期网络异常/超时 —— 不可判定，调用方**不得**据此跳过；
 *   - "unknown"    无记录或已过期 —— 调用方**不得**据此跳过（应照常播放）。
 */
export function getCachedPlayability(songId: string): "playable" | "unplayable" | "transient" | "unknown" {
  if (!songId) return "unknown";
  if (isPlayableFresh(songId)) return "playable";
  const e = getFallback(songId);
  if (!e) return "unknown";
  if (e.url) return "playable";
  return e.transient ? "transient" : "unplayable";
}

/**
 * 远程(**未入库**)行的出流前可播地址裁决(P2-7)。
 *
 * 为什么必须放在「交给管道之前」:出流改走服务端实时管道后,URL 是交给 ffmpeg
 * 子进程去取的 —— 上游 401/403/404 只会让 ffmpeg 报错退出,主进程再无机会换源。
 * 旧 `serveWebSongStream` 的「多源换源」(原平台 404/VIP 时按歌名-歌手换平台)
 * 就长在那次代理 fetch 上,改管道后会整段丢掉,所以把它前移成一次轻量裁决。
 *
 * 判定(与 judge 同一把尺子,`probe` 语义见上):
 *   - "ok"                  → 返回原链;
 *   - "gone"                → 原链明确不可播,试多源换源,命中返回替代链;
 *   - "gone" 且换源未命中   → 返回 **null**(明确不可播,交调用方回 404,别起注定
 *                             失败的空管道);
 *   - "transient"           → 返回原链(一次网络抖动不该把能播的源换成别的平台,
 *                             更不该判死 —— 成败交给 ffmpeg)。
 *
 * cacheKey 用调用方的合成 id(`remote:provider:source:id`),与库内真实行隔离;
 * 正缓存(TTL)让同一首搜索即播在 TTL 内不再重复探测。
 */
export async function resolveRemoteStreamUrl(
  url: string,
  meta: { cacheKey: string; title?: string; artist?: string; album?: string; duration?: number; provider: string; source: string },
  timeoutMs: number = PROBE_TIMEOUT_DEFAULT_MS,
): Promise<string | null> {
  if (!url) return null;
  const outcome: ProbeOutcome =
    getCachedPlayability(meta.cacheKey) === "playable" ? "ok" : await probe(url, timeoutMs);
  if (outcome === "ok") {
    addPlayable(meta.cacheKey);
    return url;
  }
  if (outcome !== "gone") return url;
  const fb = await findFallbackStream(
    meta.cacheKey, meta.title || "", meta.artist || "", meta.album || "",
    Number(meta.duration || 0), meta.provider, meta.source, timeoutMs,
  );
  return fb?.url || null;
}

/**
 * 空直链 web 行的兜底解析(纯曲库核实源导入,如 huawei-chart:门禁在华为曲库
 * 核实通过,但华为无公开全曲直链,songs.url 为空)。跳过原链探测,直接多源换源;
 * 命中即回写 songs.url,此后 /rest/stream 直用,不再每次播放都搜。
 * 无 pluginEntry/sourceData 或兜底未命中 → null。
 */
export async function resolveEmptyUrlStream(
  song: {
    id: string; title?: string | null; artist?: string | null; album?: string | null;
    duration?: number | null; pluginEntry?: string | null; sourceData?: string | null;
  },
  timeoutMs: number = PROBE_TIMEOUT_DEFAULT_MS,
): Promise<string | null> {
  if (!song?.id || !song.pluginEntry) return null;
  let sd: any = null;
  try { sd = JSON.parse(song.sourceData || "{}"); } catch {}
  const fb = await findFallbackStream(
    song.id, song.title || sd?.title || "", song.artist || sd?.artist || "",
    song.album || sd?.album || "", Number(song.duration || sd?.duration || 0),
    song.pluginEntry, sd?.source || "", timeoutMs,
  );
  if (!fb) return null;
  updateSongUrl(song.id, fb.url, fb.source || undefined);
  return fb.url;
}

/**
 * Ensure a web song has a streamable URL before casting it to a renderer.
 *   - If the original URL probes OK, returns it (cached per songId, 带 TTL).
 *   - Otherwise tries findFallbackStream (multi-source) and, on a hit,
 *     persists the replacement URL back into songs.url so future casts and
 *     /rest/stream proxies use it directly.
 *   - Empty original URL (纯核实源导入行)直接走多源兜底,不再恒判不可播。
 *   - Returns null when no source is playable (caller should skip the track).
 *
 * 注意:缓存命中/未命中都受 TTL 约束(2026-09-11),过期即重新探测 ——
 * 源恢复后不需要等重启。网络异常不写负缓存。
 */
export async function ensurePlayableStream(
  song: { id: string; title?: string | null; artist?: string | null; album?: string | null; duration?: number | null; url?: string | null; pluginEntry?: string | null; sourceData?: string | null },
  timeoutMs: number = PROBE_TIMEOUT_DEFAULT_MS,
): Promise<string | null> {
  if (!song?.id) return null;
  if (isPlayableFresh(song.id)) return song.url || null;
  const cachedEntry = getFallback(song.id);
  if (cachedEntry) {
    const cached = cachedEntry.url;
    if (cached) {
      addPlayable(song.id);
      // Persist the previously-discovered replacement URL if the song still
      // carries the failing original (keeps /rest/stream fast on later plays).
      if (song.url && cached !== song.url) updateSongUrl(song.id, cached);
    }
    return cached;
  }

  // Original missing → 空直链兜底(命中回写),不再直接判死。
  if (!song.url) return resolveEmptyUrlStream(song, timeoutMs);

  if ((await probe(song.url, timeoutMs)) === "ok") {
    addPlayable(song.id);
    return song.url;
  }

  // Original fails → try the multi-source fallback.
  let sd: any = null;
  try { sd = JSON.parse(song.sourceData || "{}"); } catch {}
  const fb = await findFallbackStream(
    song.id, song.title || sd?.title || "", song.artist || sd?.artist || "",
    song.album || sd?.album || "", Number(song.duration || sd?.duration || 0),
    defaultStreamProviderId(song.pluginEntry), sd?.source || "", timeoutMs,
  );
  if (fb) {
    addPlayable(song.id);
    updateSongUrl(song.id, fb.url, fb.source || undefined);
    return fb.url;
  }

  // 本行自身无可用源,但「播放优选」可能在出流时把它换成组内可播的兄弟行
  // (web→local/webdav 优选,或 local 不可用→web 回退)。那种情况这首歌实际
  // 能播 —— 之前探测不知道这件事,把可播的歌判成无可用音源,客户端照着判定
  // 就白跳一首(实测 60 首 web 行里 5 首属此类)。这里复用出流同一份解析,
  // 保证探测结论与实际出流一致。
  // 返回 /rest/stream?id=<原行>:出流端点自己会再走一遍优选换源,所以这里
  // 既不标可播(isPlayableFresh 会让后续调用直接返回原死链)、也不回写原行
  // URL(会污染去重指纹与来源角标)。
  const preferred = await resolvePreferredStreamUrl(song.id);
  if (preferred) return preferred;

  return null;
}

/** 播放优选能在组内换成可播源时,返回「走服务端出流」的 URL;否则 null。 */
async function resolvePreferredStreamUrl(songId: string): Promise<string | null> {
  try {
    const row = db.select().from(songs).where(eq(songs.id, songId)).get();
    if (!row) return null;
    const pref = await resolvePreferredSong(row);
    if (!pref || pref.id === row.id) return null;
    return `${getEffectiveBaseUrl()}/rest/stream?id=${songId}`;
  } catch {
    return null;
  }
}

function updateSongUrl(songId: string, url: string, streamSource?: string): void {
  try {
    const patch: { url: string; sourceData?: string } = { url };
    if (streamSource) {
      // 显示语义:角标优先展示「实际出流平台」(extra.streamSource),不动
      // provider/source/remoteId——它们参与去重指纹,改了会导致同一首歌被
      // 反复重新导入。extra 其余键保留合并。
      const row = db.select({ sourceData: songs.sourceData }).from(songs).where(eq(songs.id, songId)).get();
      let sd: any = {};
      try { sd = JSON.parse(row?.sourceData || "{}"); } catch {}
      sd.extra = { ...(sd.extra || {}), streamSource };
      patch.sourceData = JSON.stringify(sd);
    }
    db.update(songs).set(patch).where(eq(songs.id, songId)).run();
  } catch {}
}
