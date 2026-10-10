// MusicFetch（网络音源自动下载入库）—— 多源候选聚合。
//
// 职责边界：本模块**只负责向音源插件要直链并做归一化/去重/排序**，不含下载、校验、
// 标签、落盘（那些在 httpDownload / integrity / tagWriter / finalize 里）。
// 取链由宿主侧主动发起，**不依赖播放期**：以下两个互斥分支均照抄在线源既有调用范例
//  - 分支 A（有 search 能力的源，如 go-music-dl）：`search()` 定位平台歌曲 →
//    `streamUrl(config, song)` **同步**拼出直链。采纳条件是**双条件**
//    （`streamUrl` 且 `search` 都是函数），照抄 streamFallback.ts:134-135 / :144-146
//    与 manifest 过滤 :140（` !includes("stream") || !includes("search") ` → skip）。
//  - 分支 B（纯 stream、无 search 的源，如 lx-source）：`await resolveStream(config,
//    songLike)` 返回直链字符串；manifest 过滤**反向**（:249 `!includes("stream") ||
//    includes("search")` → skip），方法判空 :252。该分支强依赖 target 的 `sourceData`
//    （:243-247），**sourceData 为空时不走分支 B**。
//
// 韧性语义（本模块的核心要求）：**单个音源失败/超时不得让整首歌失败**。每个源独立跑在
// 自己的超时预算里，抛错/超时只记为「该源缺失」，其它源照常返回；一个候选都拿不到时
// 返回空数组（由上层转成 `NO_CANDIDATE`），**不抛异常**。
//
// 并发：跨插件并发、同一插件内的多条取链路由串行（防风控），对齐设计稿 §5。
// 依赖：零新增依赖（不引入任何 npm 包）。
import crypto from "node:crypto";
import { createLogger } from "../../utils/logger.js";
import { getEnabledSourcePlugins } from "../../plugins/registry.js";
import { getConfiguredProvider } from "../source/online/index.js";
import type { OnlineSongResult } from "../source/online/types.js";
import type { Candidate, CandidateQuality } from "./types.js";

const log = createLogger("FETCH-CAND");

/** 单个音源的取链预算：超时即视为该源本轮换空，不阻塞其它源。 */
export const DEFAULT_CANDIDATE_TIMEOUT_MS = 15 * 1000;

/** 单首歌曲最终保留的候选上限（超出按 sourceRank 截断）。 */
export const DEFAULT_MAX_CANDIDATES_PER_SONG = 6;

/** 一个待下载对象（可能来自 web 占位行，也可能来自本地占位条目）。 */
export interface FetchTarget {
  id: string;
  title: string;
  artist?: string;
  album?: string;
  durationSec?: number;
  /** 平台原生信息的 JSON 串（如 `{"source":"netease","remoteId":123}`），分支 B 强依赖。 */
  sourceData?: string | null;
  /** 产出该 target 的插件 id（本尊），用于去重语境。 */
  pluginEntry?: string | null;
}

/** 一个可用取链源（宿内侧视角：拿到 provider 实例 + 已解析配置）。 */
export interface CandidateSource {
  pluginId: string;
  /** manifest.capabilities，用于判定走哪个分支。 */
  capabilities: string[];
  provider: any;
  config: Record<string, any>;
}

export interface CollectParams {
  target: FetchTarget;
  /** 用户可配的来源优先级，形如 ["lx-source:kw","lx-source:kg","go-music-dl"]；
   *  同时支持只写 pluginId。未列出的源统一排在最后。 */
  sourcePriority?: string[];
  /** 单个音源的取链预算（毫秒），默认 15000。 */
  candidateTimeoutMs?: number;
  /** 单首歌曲保留的候选上限，默认 6。 */
  maxCandidatesPerSong?: number;
  /** 测试/复用注入点：显式给出取链源，缺省从插件注册表读取。 */
  sources?: CandidateSource[];
}

/** platform slug 归一化：Go-music-dl 给 netease/qq/kugou/..., Candidate.platform 用短码。 */
const PLATFORM_ALIAS: Record<string, string> = {
  netease: "wy",
  qq: "qq",
  kugou: "kg",
  kuwo: "kw",
  migu: "mg",
  bilibili: "bili",
  ximalaya: "xmly",
};

function normalizePlatform(raw: string | undefined | null): string {
  const s = String(raw ?? "").trim().toLowerCase();
  if (!s) return "";
  return PLATFORM_ALIAS[s] ?? s;
}

function isHttpUrl(raw: unknown): boolean {
  if (typeof raw !== "string" || !raw) return false;
  try {
    const u = new URL(raw);
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}

/** 正有限数优先，非法/非正值回落到缺省值。 */
function positiveOr(v: number | undefined, fallback: number): number {
  return typeof v === "number" && Number.isFinite(v) && v > 0 ? v : fallback;
}

function shortHash(s: string): string {
  return crypto.createHash("sha1").update(s, "utf8").digest("hex").slice(0, 12);
}

/** 容器后缀：从直链路径推导。**不从格式猜**，取不到就 undefined。 */
function containerFromUrl(url: string): string | undefined {
  try {
    const ext = new URL(url).pathname.split(".").pop();
    if (!ext || !/^[a-z0-9]{2,5}$/i.test(ext)) return undefined;
    return ext.toLowerCase();
  } catch {
    return undefined;
  }
}

/** "320k" / "320kbps" / "1.41Mbps" → kbps。取不到返回 undefined（不臆造）。 */
function parseBitrateKbps(raw: unknown): number | undefined {
  if (typeof raw === "number" && Number.isFinite(raw) && raw > 0) return raw;
  const s = String(raw ?? "").trim().toLowerCase();
  if (!s) return undefined;
  const m = s.match(/(\d+(?:\.\d+)?)\s*(kbps|k|mbps|m)/);
  if (!m) {
    const n = Number.parseFloat(s);
    return Number.isFinite(n) && n > 0 ? n : undefined;
  }
  const n = Number.parseFloat(m[1]);
  if (!Number.isFinite(n) || n <= 0) return undefined;
  if (m[2] === "mbps" || m[2] === "m") return Math.round(n * 1000);
  return Math.round(n);
}

/** "12.3M" / "8.5MB" / "1024" → 字节。 */
function parseBytes(raw: unknown): number | undefined {
  if (typeof raw === "number" && Number.isFinite(raw) && raw > 0) return Math.round(raw);
  const s = String(raw ?? "").trim().toLowerCase();
  if (!s) return undefined;
  const m = s.match(/^(\d+(?:\.\d+)?)\s*(kb|mb|gb|b)?$/);
  if (!m) return undefined;
  const n = Number.parseFloat(m[1]);
  if (!Number.isFinite(n) || n <= 0) return undefined;
  const mul = m[2] === "gb" ? 1024 ** 3 : m[2] === "mb" ? 1024 ** 2 : m[2] === "kb" ? 1024 : 1;
  return Math.round(n * mul);
}

/** 全 undefined 的质量对象退化为空对象会让下游误判「已声明」，这里统一成 undefined。 */
function compactQuality(q: CandidateQuality): CandidateQuality | undefined {
  return Object.values(q).some((v) => v !== undefined) ? q : undefined;
}

/**
 * 宽容读取 target.sourceData：只要 JSON 对象里出现常见的平台/ID 键就取出，
 * 取不到返回空（分支 B 此时不可用）。**不解析失败即整首失败**。
 */
function readSourceData(target: FetchTarget): { platform: string; songId: string } {
  const raw = target.sourceData;
  if (!raw) return { platform: "", songId: "" };
  let obj: Record<string, any>;
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return { platform: "", songId: "" };
    obj = parsed as Record<string, any>;
  } catch {
    return { platform: "", songId: "" };
  }
  const platformRaw = obj.source ?? obj.platform ?? obj.provider ?? obj.remoteSource;
  const idRaw = obj.remoteId ?? obj.songId ?? obj.id ?? obj.platformId;
  return {
    platform: normalizePlatform(typeof platformRaw === "string" ? platformRaw : ""),
    songId: idRaw === undefined || idRaw === null ? "" : String(idRaw),
  };
}

/** 按用户配置的 sourcePriority 计算该候选的来源序号（越小越优先，未列出的排最后）。 */
function rankOf(pluginId: string, platform: string, priority: string[]): number {
  if (priority.length === 0) return 0;
  const exact = platform ? priority.indexOf(`${pluginId}:${platform}`) : -1;
  if (exact >= 0) return exact;
  const byPlugin = priority.indexOf(pluginId);
  return byPlugin >= 0 ? byPlugin : priority.length;
}

/**
 * 从 `OnlineSongResult.extra` 里挑「风格」。
 *
 * 契约（`services/source/online/types.ts:27`）：`extra` 是 `Record<string, string>`，
 * 键由各插件自行决定。这里只认几个常见键（大小写不敏感），拿到非空字符串才返回；
 * **拿不到就返回 undefined，绝不臆造**（下游据此决定是否写 genre 标签）。
 */
function pickGenre(extra: Record<string, string> | null | undefined): string | undefined {
  if (!extra || typeof extra !== "object") return undefined;
  for (const want of ["genre", "style", "tag", "tags"]) {
    for (const k of Object.keys(extra)) {
      if (k.toLowerCase() !== want) continue;
      const v = extra[k];
      if (typeof v === "string" && v.trim()) return v.trim();
    }
  }
  return undefined;
}

/** 枚举可用取链源：已启用 + 声明 stream 能力 + 能拿到 provider 实例（判空是硬要求）。 */
export function listCandidateSources(): CandidateSource[] {
  const out: CandidateSource[] = [];
  for (const { manifest } of getEnabledSourcePlugins()) {
    if (!manifest.capabilities.includes("stream")) continue;
    const configured = getConfiguredProvider(manifest.id);
    if (!configured?.provider) continue; // getConfiguredProvider 可能为 null（禁用/未配置/插件消失）
    out.push({
      pluginId: manifest.id,
      capabilities: manifest.capabilities,
      provider: configured.provider,
      config: configured.config,
    });
  }
  return out;
}

// ==================== 归一化 ====================

function buildCandidate(params: {
  src: CandidateSource;
  url: string;
  platformSongId?: string;
  declared?: CandidateQuality;
  meta?: {
    title?: string;
    artist?: string;
    album?: string;
    durationSec?: number;
    coverUrl?: string;
    platform?: string;
    genre?: string;
  };
}): Candidate {
  const { src, url, declared, meta } = params;
  const platform = params.meta?.platform ?? "";
  const songId = params.platformSongId || shortHash(url);
  const c: Candidate = {
    id: `${src.pluginId}:${platform}:${songId}`,
    pluginId: src.pluginId,
    platform,
    url,
    // headers **恒为空**：go-music-dl 的 streamUrl 纯拼串不发网络
    // （plugins/go-music-dl/index.js:1132-1146），lx-source 只返回裸 URL，
    // host.callPlugin 返回体本身也没有 headers 字段。M1 由下游用默认 UA 兜底，
    // 需要真 headers 要等 M2 新增 capability 契约。此处不填任何值 = 不臆造。
    declared: declared ? compactQuality(declared) : undefined,
    sourceRank: 0,
  };
  if (meta?.title) c.title = meta.title;
  if (meta?.artist) c.artist = meta.artist;
  if (meta?.album) c.album = meta.album;
  if (meta?.coverUrl) c.coverUrl = meta.coverUrl;
  if (meta?.genre) c.genre = meta.genre;
  return c;
}

// ==================== 两条取链分支 ====================

/** 分支 A 采纳条件（双条件齐备，照抄 streamFallback.ts:134-135 / manifest 过滤 :140）。 */
function supportsSearchRoute(src: CandidateSource, target: FetchTarget): boolean {
  return (
    src.capabilities.includes("stream") &&
    src.capabilities.includes("search") &&
    typeof src.provider?.streamUrl === "function" &&
    typeof src.provider?.search === "function" &&
    Boolean(target.title)
  );
}

/** 分支 B 采纳条件（反向过滤 :249 + 方法判空 :252 + sourceData 非空 :243-247）。 */
function supportsResolveRoute(src: CandidateSource, target: FetchTarget): boolean {
  const sd = readSourceData(target);
  return (
    src.capabilities.includes("stream") &&
    !src.capabilities.includes("search") &&
    typeof src.provider?.resolveStream === "function" &&
    Boolean(sd.songId || sd.platform)
  );
}

/** 分支 A：search 定位 → streamUrl 同步拼链。 */
async function viaSearch(src: CandidateSource, target: FetchTarget): Promise<Candidate[]> {
  const query = [target.title, target.artist].filter(Boolean).join(" ").trim();
  const res = await src.provider.search(src.config, { query });
  const songs: OnlineSongResult[] = Array.isArray(res?.songs) ? res.songs : [];
  const out: Candidate[] = [];
  for (const s of songs) {
    let url = "";
    try {
      url = String(src.provider.streamUrl(src.config, s) ?? "");
    } catch (e) {
      log.debug("streamUrl 抛错，跳过该搜索结果", { pluginId: src.pluginId, err: String(e) });
      continue;
    }
    if (!isHttpUrl(url)) continue;
    out.push(
      buildCandidate({
        src,
        url,
        platformSongId: s.id ? String(s.id) : "",
        declared: {
          container: containerFromUrl(url),
          bitrateKbps: parseBitrateKbps(s.sortBitrate),
          bytes: parseBytes(s.sortSize),
          durationSec: typeof s.duration === "number" && s.duration > 0 ? s.duration : undefined,
        },
        meta: {
          title: s.name || undefined,
          artist: s.artist || undefined,
          album: s.album || undefined,
          durationSec: typeof s.duration === "number" && s.duration > 0 ? s.duration : undefined,
          coverUrl: s.cover || undefined,
          platform: normalizePlatform(s.source),
          genre: pickGenre(s.extra),
        },
      }),
    );
  }
  return out;
}

/** 分支 B：resolveStream(config, songLike) → Promise<string>，空串/异常同败（:255-258）。 */
async function viaResolveStream(src: CandidateSource, target: FetchTarget): Promise<Candidate[]> {
  const sd = readSourceData(target);
  const songLike = {
    id: target.id,
    title: target.title,
    artist: target.artist ?? "",
    album: target.album ?? "",
    duration: target.durationSec ?? 0,
    pluginEntry: target.pluginEntry ?? null,
    sourceData: target.sourceData ?? null,
  };
  let url = "";
  try {
    url = String((await src.provider.resolveStream(src.config, songLike)) || "");
  } catch (e) {
    // 插件内部错误 = 这一跳失败，与返回 "" 同语义，不阻塞其它源。
    log.warn("resolveStream 失败", { pluginId: src.pluginId, err: String(e) });
    return [];
  }
  if (!isHttpUrl(url)) return [];
  // 分支 B 只给裸 URL，任何 declared 字段都无从得知 → 全留 undefined（不编造）。
  return [
    buildCandidate({
      src,
      url,
      platformSongId: sd.songId || "",
      meta: {
        title: target.title,
        artist: target.artist,
        album: target.album,
        durationSec: target.durationSec,
        platform: sd.platform,
      },
    }),
  ];
}

/** 单source取链：多条路由**串行**（防风控），整体受 `timeoutMs` 预算约束。 */
async function collectFromSource(
  src: CandidateSource,
  target: FetchTarget,
  timeoutMs: number,
): Promise<Candidate[]> {
  const routes: Array<() => Promise<Candidate[]>> = [];
  if (supportsSearchRoute(src, target)) routes.push(() => viaSearch(src, target));
  if (supportsResolveRoute(src, target)) routes.push(() => viaResolveStream(src, target));
  if (routes.length === 0) {
    log.debug("源不参与本轮换（能力/元数据不匹配）", { pluginId: src.pluginId });
    return [];
  }
  return withTimeout(
    (async () => {
      const out: Candidate[] = [];
      for (const route of routes) {
        try {
          out.push(...(await route()));
        } catch (e) {
          // 单条路由失败不影响同一插件的其它路由，更不影响其它插件。
          log.warn("取链路由失败", { pluginId: src.pluginId, err: String(e) });
        }
      }
      return out;
    })(),
    timeoutMs,
  );
}

/** 超时即 reject。**被一方超时/拒绝后原 promise 仍在跑（无取消语义），但不占用调用方预算。 */
function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  if (!Number.isFinite(ms) || ms <= 0) return p;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const guard = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`candidate source timeout after ${ms}ms`)), ms);
  });
  return Promise.race([p, guard]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

// ==================== 对外 API ====================

/**
 * 向所有可用音源并行取链，聚合成按 `sourcePriority` 排序的候选数组。
 * - 单源失败/超时只损失该源；零候选返回空数组，**不抛异常**（上层转 NO_CANDIDATE）。
 */
export async function collectCandidates(params: CollectParams): Promise<Candidate[]> {
  const target = params.target;
  const priority = params.sourcePriority ?? [];
  const timeoutMs = positiveOr(params.candidateTimeoutMs, DEFAULT_CANDIDATE_TIMEOUT_MS);
  const maxCandidates = positiveOr(params.maxCandidatesPerSong, DEFAULT_MAX_CANDIDATES_PER_SONG);

  if (!target?.title) {
    log.warn("target 缺标题，无法取链", { targetId: target?.id });
    return [];
  }

  const sources = params.sources ?? listCandidateSources();
  if (sources.length === 0) return [];

  // 跨插件并发；任一 reject（含超时）由 allSettled 兜住，只影响对应的那一个源。
  const settled = await Promise.allSettled(
    sources.map((s) => collectFromSource(s, target, timeoutMs)),
  );
  const pooled: Candidate[] = [];
  settled.forEach((r, i) => {
    if (r.status === "fulfilled") {
      pooled.push(...r.value);
      return;
    }
    log.warn("音源取链失败，本轮换视为缺失", {
      pluginId: sources[i].pluginId,
      targetId: target.id,
      err: String(r.reason),
    });
  });

  const deduped = dedupeCandidates(pooled).map((c) => ({
    ...c,
    sourceRank: rankOf(c.pluginId, c.platform, priority),
  }));
  // Array.prototype.sort 在 ES2019+ 稳定：同 sourceRank 保持入池顺序。
  deduped.sort((a, b) => a.sourceRank - b.sourceRank);
  return deduped.slice(0, maxCandidates);
}

/**
 * 候选去重：同 URL 合并；同 (pluginId + platform + 平台歌曲ID) 也合并。
 * 合并时保留**信息更全**的一条，并用另一条补齐其缺失字段。
 */
export function dedupeCandidates(cands: Candidate[]): Candidate[] {
  const out: Candidate[] = [];
  const slotByUrl = new Map<string, number>();
  const slotByKey = new Map<string, number>();
  for (const c of cands) {
    if (!c || !isHttpUrl(c.url)) continue; // 无有效直链的候选不入库
    const key = identityKey(c);
    let slot = slotByUrl.get(c.url);
    if (slot === undefined && key) slot = slotByKey.get(key);
    if (slot === undefined) {
      const idx = out.length;
      out.push(c);
      slotByUrl.set(c.url, idx);
      if (key) slotByKey.set(key, idx);
      continue;
    }
    out[slot] = mergeCandidates(out[slot], c);
    slotByUrl.set(c.url, slot);
    if (key) slotByKey.set(key, slot);
  }
  return out;
}

/**
 * 取下一个可试的候选（跳过已失败的 id），用于「最优失败自动降级到次优」。
 * 全部已试过返回 undefined。
 */
export function nextCandidate(cands: Candidate[], failedIds: Set<string>): Candidate | undefined {
  for (const c of cands) {
    if (!c) continue;
    if (failedIds?.has(c.id)) continue;
    return c;
  }
  return undefined;
}

// ==================== 去重内部 ====================

/** `${pluginId}:${platform}:${平台歌曲ID}` 语境键；平台歌曲 ID 缺失时返回 ""（不参与合并）。 */
function identityKey(c: Candidate): string {
  const parts = String(c.id ?? "").split(":");
  if (parts.length < 3) return "";
  const [pluginId, platform, songId] = parts;
  if (pluginId !== c.pluginId || platform !== c.platform) return ""; // 非本模块产出的 id 格式
  if (!songId) return "";
  return `${pluginId}:${platform}:${songId}`;
}

/** 信息完整度打分（用于「保留更全的一条」）。 */
function fillScore(c: Candidate): number {
  let n = 0;
  if (c.url) n++;
  if (c.title) n++;
  if (c.artist) n++;
  if (c.album) n++;
  if (c.genre) n++;
  if (c.coverUrl) n++;
  if (c.lyricUrl) n++;
  if (c.headers && Object.keys(c.headers).length > 0) n++;
  const d = c.declared;
  if (d) {
    for (const v of [d.container, d.bitrateKbps, d.sampleRateHz, d.bitDepth, d.channels, d.durationSec, d.bytes, d.encoder]) {
      if (v !== undefined) n++;
    }
  }
  if (c.probed) n += 2;
  return n;
}

/** 合并两条同源候选：base 取信息更全者（并列取先到的），再用另一条补空缺。 */
function mergeCandidates(a: Candidate, b: Candidate): Candidate {
  const [base, other] = fillScore(b) > fillScore(a) ? [b, a] : [a, b];
  const merged: Candidate = { ...base };
  if (!merged.url && other.url) merged.url = other.url;
  if (!merged.title && other.title) merged.title = other.title;
  if (!merged.artist && other.artist) merged.artist = other.artist;
  if (!merged.album && other.album) merged.album = other.album;
  if (!merged.genre && other.genre) merged.genre = other.genre;
  if (!merged.coverUrl && other.coverUrl) merged.coverUrl = other.coverUrl;
  if (!merged.lyricUrl && other.lyricUrl) merged.lyricUrl = other.lyricUrl;
  if ((other.sourceRank ?? 0) < (merged.sourceRank ?? 0)) merged.sourceRank = other.sourceRank;
  const d = other.declared;
  if (d) {
    const q: CandidateQuality = { ...(merged.declared ?? {}) };
    for (const k of ["container", "encoder"] as const) if (q[k] === undefined && d[k] !== undefined) q[k] = d[k];
    for (const k of ["bitrateKbps", "sampleRateHz", "bitDepth", "channels", "durationSec", "bytes"] as const) {
      if (q[k] === undefined && d[k] !== undefined) q[k] = d[k];
    }
    merged.declared = compactQuality(q);
  }
  return merged;
}
