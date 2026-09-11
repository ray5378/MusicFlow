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
import { passesImportGate, getImportGateConfig, type ImportGateConfig } from "./importGate.js";
import { STREAM_FALLBACK_PLUGIN_ID } from "../../plugin/core/streamFallbackPlugin.js";

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
//   - 负结果:所有平台都没有可播候选 → 45s 后重新探测,**源恢复即自动复活**。
//   - 网络异常:只短期退避,**不判定不可播**(网络抖动 ≠ 这首歌没有源)。
const PLAYABLE_TTL_DEFAULT_MS = 60 * 60 * 1000;
const NEGATIVE_TTL_DEFAULT_MS = 45 * 1000;
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

function setFallback(key: string, url: string | null, opts?: { transient?: boolean }) {
  const transient = opts?.transient === true;
  fallbackCache.set(key, {
    url,
    at: Date.now(),
    ttlMs: transient ? transientBackoffMs : negativeTtlMs,
    transient,
  });
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

  // provider 解析:pluginEntry 缺 stream/search 能力时自动回退首个齐备源插件
  // (resolveStreamProvider),避免对纯核实源(huawei-chart 等)误判无兜底。
  const configured = resolveStreamProvider(providerId);
  if (!configured) { setFallback(songId, null); return null; }

  const query = [title, artist].filter(Boolean).join(" ");
  let results: OnlineSongResult[];
  try {
    const r = await configured.provider.search(configured.config, { query });
    results = r.songs || [];
  } catch {
    // 搜索请求本身失败(网络异常/上游 5xx):**不判定"没有源"**,只短期退避。
    setFallback(songId, null, { transient: true });
    return null;
  }

  // 换源兜底与导入门禁同套断言(v2.3.4):候选必须通过 passesImportGate——
  // 规范化标题+歌手(强制)+ 专辑一致(开关默认开)+ 时长差 ≤ 容差,全命中才允许换源。
  // 此前兜底只有「歌名严格相等 + 歌手首位名分」两维,元数据冒名候选(如《恋人》
  // 被换成网易云「李荣浩-、Montagem」的 funk remix:歌名相等、'李荣浩-'.includes
  // ('李荣浩') 恒真)通过后还被 updateSongUrl 持久化污染 songs.url,此后每次播放
  // 都直用错链。期望侧缺字段(无专辑/无时长)时对应维度自动跳过,与导入语义一致。
  // 时长容差默认沿用导入门禁;core-stream-fallback.durationTolerance > 0 时覆写
  // (仅放宽时长维度,标题/歌手/专辑不可放宽)。排序偏好(sourcePreference)不变。
  const gateCfg: ImportGateConfig | undefined = fbCfg.durationTolerance > 0
    ? { ...getImportGateConfig(), durationTolerance: fbCfg.durationTolerance }
    : undefined;
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

  // 全候选都不可播:只要其中有「网络异常/超时」就不判定不可播(网络抖动 ≠ 没有源),
  // 只按短期退避记;只有全是明确的 403/404/410 才写负结果。
  setFallback(songId, null, { transient: sawTransient });
  return null;
}

/** 单曲探测结果。刻意分三态,避免把「网络异常」误判成「没有源」。 */
export type ProbeOutcome = "ok" | "gone" | "transient";

/**
 * 探测一个流 URL 是否可播。
 *   - "ok"        200/206 → 可播;
 *   - "gone"      403/404/410 → **明确不存在/无权限**,可据此判定不可播;
 *   - "transient" 429/5xx/网络异常/超时 → **不可判定**,调用方不得据此写负缓存。
 * 此前把三者一律算 false(2026-09-11 前),一次网络抖动就能把一首歌永久判死。
 */
async function probe(url: string, timeoutMs: number = PROBE_TIMEOUT_DEFAULT_MS): Promise<ProbeOutcome> {
  if (!url) return "gone";
  try {
    const res = await fetch(url, { headers: { Range: "bytes=0-20000" }, signal: AbortSignal.timeout(timeoutMs) });
    const status = res.status;
    await res.body?.cancel();
    if (status === 200 || status === 206) return "ok";
    if (status === 403 || status === 404 || status === 410) return "gone";
    return "transient";
  } catch {
    return "transient";
  }
}

export { probe as probeStream };

export function clearFallbackCache(songId?: string) {
  if (songId) fallbackCache.delete(songId);
  else fallbackCache.clear();
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
  playableCache.set(songId, Date.now());
  if (playableCache.size > PLAYABLE_CACHE_MAX) {
    const oldest = playableCache.keys().next().value;
    if (oldest !== undefined) playableCache.delete(oldest);
  }
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
  return null;
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
