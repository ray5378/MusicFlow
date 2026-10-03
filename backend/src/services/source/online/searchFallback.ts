// ==================== Search fallback (跨插件兜底) ====================
//
// 换源兜底(services/source/online/streamFallback.ts)只覆盖**播放链**:原链失效时换一条
// 可播的替代链。搜索层此前没有任何跨插件兜底 ——
//   POST /v1/online/:providerId/search 只调 `configured.provider.search(...)` 一次,
//   主插件软失败(返回空 / 抛错)就返回空,哪怕别处还有启用着的源插件能用。
//
// 本文件补上这一层:主插件空/错时,改用其它「已启用 + 声明 search & stream 能力」的源
// 插件再试(排除本尊),第一个有结果的直接返回,并回传 fallbackFrom(结果来自哪个插件)
// 与 trace(逐插件回退轨迹)。开关与预算由 core-search-fallback 插件配置驱动(config-only)。
//
// 语义约定(与 streamFallback 的「网络异常 ≠ 没有源」一致):
//   - **上游 5xx / 超时只做短期退避**,不写负缓存、不把「这次搜不到」当成永久结论 ——
//     搜索本身是每次实时请求,没有跨请求的结果记忆,调用方下次请求自然重试;
//   - **全部候选耗尽**才返回显式空结果 + 可读 message(含 N 次回退轨迹),让前端能说清
//     「为什么搜不到」而不是笼统地空着;
//   - enabled=false 时**零行为变化**:直接走原有一次调用路径,不记 trace、不换插件。
//
// import 环说明:registry / online/index / streamFallback 都落在
// `registry → builtins → core 插件(manifest 常量,TDR 敏感)`这条重模块图的边上,故本文件
// 一律用**动态 import**(只在请求内发生,不可能触及模块初始化期)—— 复刻 preProbe.ts 文件头
// 警告的那条回归路径。共享 runner(纯函数、无依赖)则静态 import。

import type { OnlineSongResult, OnlineSearchParams } from "./types.js";
import { runSourceFallback, type FallbackCandidate } from "../../plugin/shared.js";
import { SEARCH_FALLBACK_PLUGIN_ID } from "../../plugin/core/searchFallbackPlugin.js";

/** core-search-fallback 插件配置读取结果(全部带默认值,缺行/停用都能安全 fallback)。 */
export interface SearchFallbackConfig {
  enabled: boolean;
  maxCandidates: number;
  budgetMs: number;
  fallbackOnEmpty: boolean;
  fallbackOnError: boolean;
}

/** 一次搜索候选的尝试产出(带上插件 id,命中后据此回填 fallbackFrom)。 */
interface CandidateAttempt {
  id: string;
  raw: any;
  songs: OnlineSongResult[];
}

/** 一次搜索兜底的产出(成功/耗尽统一同形,调用方不必判空)。 */
export interface SearchFallbackOutcome {
  /** 结果集(耗尽时为 [],与「插件软失败」形状 {empty:true} 同构)。 */
  songs: OnlineSongResult[];
  /** true = 所有候选都没有结果(主插件 + 兜底插件全空/全错)。 */
  empty: boolean;
  /** 可读的失败原因/轨迹汇总(成功时为空串)。 */
  message: string;
  /** 回退轨迹(逐尝试一段;形如 `netease(空结果) > lx-source(403)`,调用方按 `>` 拼接展示)。 */
  trace: string[];
  /** 结果来自哪个源插件(兜底命中时为被改用的插件 id;主插件命中时等于 providerId)。 */
  source: string;
  /** 是否发生过兜底(命中兜底插件时为 true;主插件直接命中为 false)。 */
  fallbackFrom: string;
  /** 是否出现过「超时/网络异常 5xx」类失败(区分「真的没有」与「这次没搜到」)。 */
  transient: boolean;
  /**
   * 主插件抛出的上游错误摘要(非空 = 上游真出错且**兜底没捞回来**)。
   *
   * 契约三态(坑 3 裁决):
   *   - 主插件命中 / 兜底命中  → 空串,调用方正常返 200(兜底成功返 200 是预期);
   *   - 主插件抛错且兜底也耗尽 → 非空,调用方必须回 502/UPSTREAM_ERROR(错误不许被吞成「无结果」);
   *   - 主插件是**空结果**(非抛错)且兜底耗尽 → 空串,回 200 + message(这是「真的没有」,不是错误)。
   * 摘要而非原文:核心永不把上游异常原文透给前端(与 502 分支同一条红线)。
   */
  upstreamError: string;
  /** 命中的插件原始返回对象(透传插件自定义字段,如 lx-source 的 source/trace)。 */
  raw: Record<string, any> | null;
}

const SEARCH_FALLBACK_DEFAULTS: SearchFallbackConfig = {
  enabled: true,
  maxCandidates: 2,
  budgetMs: 6000,
  fallbackOnEmpty: true,
  fallbackOnError: true,
};

/**
 * 读取搜索兜底配置(core-search-fallback 内置插件)。非法值一律回落默认值,永不抛错。
 * 异步(依赖 registry 走动态 import,规避 registry → builtins 的静态回归路径)。
 */
export async function getSearchFallbackConfig(): Promise<SearchFallbackConfig> {
  const cfg = ((await readPluginConfig()) || {}) as Record<string, any>;
  const enabled = cfg.enabled !== false;
  const onEmpty = cfg.fallbackOnEmpty !== false;
  const onError = cfg.fallbackOnError !== false;
  const maxRaw = Number(cfg.maxCandidates);
  const maxCandidates =
    Number.isFinite(maxRaw) && maxRaw >= 0 ? Math.min(Math.floor(maxRaw), 5) : SEARCH_FALLBACK_DEFAULTS.maxCandidates;
  const budgetRaw = Number(cfg.budgetMs);
  const budgetMs =
    Number.isFinite(budgetRaw) && budgetRaw >= 500 ? Math.min(budgetRaw, 60000) : SEARCH_FALLBACK_DEFAULTS.budgetMs;
  return { enabled, maxCandidates, budgetMs, fallbackOnEmpty: onEmpty, fallbackOnError: onError };
}

/** 「错误摘要」:超长截断(根因在前:状态码/异常类型/URL 前缀),控住 trace 长度。 */
function summarizeError(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err ?? "");
  return msg.length > 80 ? msg.slice(0, 79) + "…" : msg;
}

/** 共享 runner 超预算时抛的固定文案(用于区分「网络慢」与「真的没有」)。 */
function isBudgetError(err: unknown): boolean {
  return String(err instanceof Error ? err.message : err ?? "").includes("超过兜底预算");
}

/** 从插件返回对象里取出结果数组:兼容 {songs:[]} 与插件软失败契约({empty:true} 无 songs)。 */
function extractSongs(result: any): OnlineSongResult[] {
  if (Array.isArray(result)) return result as OnlineSongResult[];
  const songs = result && result.songs;
  return Array.isArray(songs) ? songs : [];
}

/** 插件返回是否算「有结果」:非空 songs 才算(软失败契约里 empty:true 必然伴空 songs)。 */
function hasResults(result: any): boolean {
  if (!result || typeof result !== "object") return false;
  if (result.empty === true && extractSongs(result).length === 0) return false;
  return extractSongs(result).length > 0;
}

/** 调用一个源插件的 search(统一形状归一:插件软失败也归一成同形 attempt)。 */
async function callSearch(
  entry: { provider: any; config: Record<string, any>; id: string },
  params: OnlineSearchParams,
): Promise<CandidateAttempt> {
  const raw = await entry.provider.search(entry.config, params);
  return { id: entry.id, raw, songs: extractSongs(raw) };
}

// ---------------------------------------------------------------------------
// 依赖加载(动态,规避 registry/builtins 静态回归路径)
// ---------------------------------------------------------------------------

type RegistryMod = {
  getPluginConfig: (id: string) => Record<string, any> | null;
  getEnabledSourcePlugins: () => { manifest: { id: string; capabilities: string[] } }[];
};
type OnlineIndexMod = {
  getConfiguredProvider: (id: string) => { provider: any; config: Record<string, any> } | null;
};

let registryMod: Promise<RegistryMod> | null = null;
let onlineIndexMod: Promise<OnlineIndexMod> | null = null;

function loadRegistry(): Promise<RegistryMod> {
  if (!registryMod) registryMod = import("../../../plugins/registry.js") as unknown as Promise<RegistryMod>;
  return registryMod;
}
function loadOnlineIndex(): Promise<OnlineIndexMod> {
  if (!onlineIndexMod) onlineIndexMod = import("./index.js") as unknown as Promise<OnlineIndexMod>
  return onlineIndexMod;
}

/** 读取 core-search-fallback 的插件配置(未播种/未启用时返回 null → 走默认值)。 */
async function readPluginConfig(): Promise<Record<string, any> | null> {
  const reg = await loadRegistry();
  return reg.getPluginConfig(SEARCH_FALLBACK_PLUGIN_ID);
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------

/** 带跨插件兜底的搜索输入。 */
export interface RunSearchWithFallbackInput {
  query: string;
  sources?: string[];
}

/**
 * 带跨插件兜底的搜索。
 *
 *   1. 主插件(providerId)先试 —— 抛错按 `fallbackOnError`、空结果按 `fallbackOnEmpty`
 *      决定是否兜底(两项都关 = 退回原路径,零行为变化);
 *   2. 兜底候选 = 其它「已启用 + capabilities 含 search 与 stream」的源插件(排除本尊),
 *      经共享 runner 逐个尝试(总预算 budgetMs / 最多 maxCandidates 个);
 *   3. 首个有结果者直接返回,`fallbackFrom` 标出结果来自哪个插件;
 *   4. 全部耗尽 → 显式空结果 + `全部在线源均无结果(N 次回退): ...` 形式的 message。
 */
export async function runSearchWithFallback(
  providerId: string,
  input: RunSearchWithFallbackInput,
): Promise<SearchFallbackOutcome> {
  const params: OnlineSearchParams = { query: input.query, sources: input.sources };
  const cfg = await getSearchFallbackConfig();
  const trace: string[] = [];
  let transient = false;
  // 主插件抛错时记下来:兜底没捞回来必须让调用方按 502 处理(错误不能被吞成「无结果」)。
  let upstreamError = "";

  // ---------- 1. 主插件 ----------
  const onlineIndex = await loadOnlineIndex();
  const primary = onlineIndex.getConfiguredProvider(providerId);
  if (!primary || typeof primary.provider.search !== "function") {
    trace.push(`${providerId}(不可用)`);
    return {
      songs: [], empty: true, message: `搜索源插件不可用: ${providerId}(未配置、未启用或缺少 search 能力)`,
      trace, source: providerId, fallbackFrom: "", transient, upstreamError: "", raw: null,
    };
  }

  let primaryAttempt: CandidateAttempt | null = null;
  try {
    primaryAttempt = await callSearch({ ...primary, id: providerId }, params);
  } catch (e) {
    if (isBudgetError(e)) transient = true;
    upstreamError = summarizeError(e);
    if (!cfg.enabled || !cfg.fallbackOnError) {
      // 不兜底(开关关着):原样把上游错误交出去,调用方仍按 502 处理。
      return {
        songs: [], empty: true, message: `搜索失败: ${upstreamError}`,
        trace, source: providerId, fallbackFrom: "", transient, upstreamError, raw: null,
      };
    }
    trace.push(`${providerId}(${upstreamError})`);
  }

  if (primaryAttempt && !hasResults(primaryAttempt.raw)) {
    if (!cfg.enabled || !cfg.fallbackOnEmpty) {
      return {
        songs: [], empty: true, message: "", trace,
        source: providerId, fallbackFrom: "", transient, upstreamError: "", raw: null,
      };
    }
    trace.push(`${providerId}(空结果)`);
  } else if (primaryAttempt && hasResults(primaryAttempt.raw)) {
    // 主插件直接命中:零开销返回,不记 trace、不换插件(enabled=false 时走的就是这条)。
    return {
      songs: primaryAttempt.songs, empty: false, message: "", trace,
      source: providerId, fallbackFrom: "", transient, upstreamError: "", raw: primaryAttempt.raw,
    };
  }

  if (!cfg.enabled) {
    return {
      songs: primaryAttempt ? primaryAttempt.songs : [], empty: true, message: "",
      trace, source: providerId, fallbackFrom: "", transient,
      upstreamError, raw: primaryAttempt ? primaryAttempt.raw : null,
    };
  }

  // ---------- 2-4. 兜底候选 ----------
  const candidates = await collectFallbackCandidates(providerId, cfg.maxCandidates);
  const list: FallbackCandidate<CandidateAttempt>[] = candidates.map((c) => ({
    label: c.id,
    run: () => callSearch(c, params),
  }));

  const outcome = await runSourceFallback({
    candidates: list,
    isUsable: (v) => hasResults(v.raw),
    budgetMs: cfg.budgetMs,
    maxTries: cfg.maxCandidates,
    onError: (label, e) => {
      // 超预算/超时属「不可判定」,不写死负结果(与 findFallbackStream 的 sawTransient 同义)。
      if (isBudgetError(e)) transient = true;
      return `${label}(${summarizeError(e)})`;
    },
    onEmpty: (label) => `${label}(空结果)`,
  });

  trace.push(...outcome.trace);
  if (outcome.ok && outcome.value) {
    return {
      songs: outcome.value.songs,
      empty: false,
      message: "",
      trace,
      source: providerId,
      fallbackFrom: outcome.value.id,
      transient,
      // 兜底捞回了结果 ⇒ 上游错误已被覆盖,清空以让调用方返 200(坑 3 裁决的预期)。
      upstreamError: "",
      raw: outcome.value.raw,
    };
  }

  const reason = transient ? "上游超时/网络异常,本次未搜到" : "无结果";
  const message = `全部在线源均无结果(${trace.length} 次回退${trace.length ? ": " + trace.join(" | ") : ""});${reason}`;
  return {
    songs: [], empty: true, message, trace,
    source: providerId, fallbackFrom: "", transient, upstreamError, raw: null,
  };
}

/**
 * 兜底候选枚举:其它「已启用 + capabilities 含 search 与 stream」的源插件,排除本尊。
 * 拓扑与 streamFallback 的 resolveStreamProvider 同款(本尊齐备就用本尊,否则逐个挑齐备的
 * 启用源插件),差别在于这里要的是**全部**满足条件的插件(供逐个尝试而非取第一个)。
 */
async function collectFallbackCandidates(
  providerId: string,
  maxCandidates: number,
): Promise<{ id: string; provider: any; config: Record<string, any> }[]> {
  if (!Number.isFinite(maxCandidates) || maxCandidates <= 0) return [];
  const reg = await loadRegistry();
  const onlineIndex = await loadOnlineIndex();
  const out: { id: string; provider: any; config: Record<string, any> }[] = [];
  for (const { manifest } of reg.getEnabledSourcePlugins()) {
    if (out.length >= maxCandidates) break;
    if (manifest.id === providerId) continue; // 本尊已试过,不自我重试
    if (!manifest.capabilities.includes("search")) continue;
    if (!manifest.capabilities.includes("stream")) continue;
    const resolved = onlineIndex.getConfiguredProvider(manifest.id);
    if (!resolved) continue;
    if (typeof resolved.provider.search !== "function") continue;
    if (typeof resolved.provider.streamUrl !== "function") continue;
    out.push({ id: manifest.id, provider: resolved.provider, config: resolved.config });
  }
  return out;
}
