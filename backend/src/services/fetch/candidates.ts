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
//
// 【本轮的增值点】取链只是「拿到一个 URL」，**不足以选最高音质**：聚合源声明的
// 码率/体积普遍虚标，而且同一首歌在不同平台上的真实体量可能差一个数量级
// （240 实测：migu ZQ 档 51.9MB/1749kbps vs netease 10.3MB/320kbps）。因此取链后加一个
// **可开关的 inspect 预探阶段**：
//   a) `declaredFromExtra(platform, extra)`：零网络，从信源 extra（go-music-dl 的
//      `data-extra`，内含酷狗的 sq_hash/hq_hash/... 阶梯、migu 的 format_type）
//      推「声明档位」，用于**预排序 + 防请求放大**（只探最强的前 N 个）；
//   b) `provider.inspectSong()`（go-music-dl `/music/inspect`）：服务端只发
//      `Range: bytes=0-1`，从 `Content-Range` 拿**真实总字节数**再算码率 →
//      把真实 `bitrateKbps` 写进 `declared`，下游 `quality.rankCandidates` 于是
//      按**真实音质**排序（这正是「多源都达门槛时取最高音质」的确定性实现）。
//   inspect 全程是**增强项**：插件没实现 / 服务不可达 / 单个候选失败，一律静默降级，
//   **绝不**影响取链结果（预算与取链预算是两个独立预算，见 inspectRecords 注释）。
//
// 依赖：零新增依赖（不引入任何 npm 包）。
import crypto from "node:crypto";
import { createLogger } from "../../utils/logger.js";
import { getEnabledSourcePlugins } from "../../plugins/registry.js";
import { getConfiguredProvider } from "../source/online/index.js";
import type { OnlineSongResult } from "../source/online/types.js";
import { TIER_RANK, classifyTier } from "./quality.js";
import type { Candidate, CandidateQuality } from "./types.js";

const log = createLogger("FETCH-CAND");

/** 单个音源的取链预算：超时即视为该源本轮换空，不阻塞其它源。 */
export const DEFAULT_CANDIDATE_TIMEOUT_MS = 15 * 1000;

/** 单首歌曲最终保留的候选上限（超出按 sourceRank 截断）。 */
export const DEFAULT_MAX_CANDIDATES_PER_SONG = 6;

/** 单次 inspect 请求的超时（毫秒）。**与取链/下载预算是三个独立预算**，不得合并。 */
export const DEFAULT_INSPECT_TIMEOUT_MS = 8 * 1000;

/** 每首歌最多 inspect 前 N 个候选（按 extra 阶梯预排序后），防请求放大。 */
export const DEFAULT_INSPECT_TOP_N = 6;

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
  /** 是否对候选做 inspect 预探（拿真实体积/码率选最高音质）。默认 true。 */
  inspectCandidates?: boolean;
  /** 单次 inspect 请求超时（毫秒），默认 8000。 */
  inspectTimeoutMs?: number;
  /** 每个源最多 inspect 前 N 个候选，默认 6。 */
  inspectTopN?: number;
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

/** 只保留「有值」的键（用于「缺失字段不覆盖已有字段」的合并）。 */
function withoutUndefined(q: CandidateQuality): CandidateQuality {
  const o: CandidateQuality = {};
  for (const k of Object.keys(q) as (keyof CandidateQuality)[]) {
    const v = q[k];
    if (v !== undefined) (o as Record<string, unknown>)[k] = v;
  }
  return o;
}

/** 无损容器集合（与 quality.ts 同口径；用于 extra 阶梯里「这一档是无损」的容器补位）。 */
const LOSSLESS_CONTAINERS = new Set(["flac", "ape", "wav", "alac", "aiff"]);

/**
 * 把「extra 推出来的声明档位」并入取链时已确定的 declared。
 *
 * 优先级：**取链时已确定的事实优先**（URL/搜索结果给的 container / durationSec / bytes），
 * hint 只补空缺。唯一例外是 container：当 hint 声明**无损容器**而 base 不是无损时以 hint
 * 为准 —— 聚合源的直链是 `/download?stream=1` 这类代理 URL，路径后缀（甚至写成 `.mp3`）
 * 并不代表真实容器，而平台档位标签（migu SQ/ZQ、酷狗 sq_hash）才是「这一档是无损」的
 * 权威证据（240 实测：migu SQ 的 URL 以 .mp3 结尾，实质是 30MB 的无损）。
 */
function mergeDeclaredHint(
  base: CandidateQuality | undefined,
  hint: CandidateQuality | undefined,
): CandidateQuality | undefined {
  if (!hint) return base;
  if (!base) return hint;
  const out: CandidateQuality = { ...withoutUndefined(hint), ...withoutUndefined(base) };
  const bc = (base.container ?? "").toLowerCase();
  if (hint.container && LOSSLESS_CONTAINERS.has(hint.container) && !LOSSLESS_CONTAINERS.has(bc)) {
    out.container = hint.container;
  }
  return compactQuality(out);
}

// ==================== 信源 extra → 声明档位（零网络快路径） ====================

/** 取 extra 里第一个「有非空值」的键（键名大小写不敏感，忽略空白值）。 */
function extraStr(extra: Record<string, string> | undefined, ...keys: string[]): string | undefined {
  if (!extra || typeof extra !== "object") return undefined;
  const byLower = new Map<string, string>();
  for (const k of Object.keys(extra)) byLower.set(k.toLowerCase(), k);
  for (const want of keys) {
    const k = byLower.get(want.toLowerCase());
    if (k === undefined) continue;
    const v = (extra as Record<string, unknown>)[k];
    if (typeof v === "string" && v.trim()) return v.trim();
    if (typeof v === "number" && Number.isFinite(v)) return String(v);
  }
  return undefined;
}

/**
 * 酷狗档位阶梯（240 实测 extra 键）：
 *   sq_hash（无损 flac） > hq_hash / res_hash / ogg_320_hash（320） > hash / file_hash / ogg_128_hash（128）。
 * `privilege === "0"`（版权受限）→ 高档位实际取不到，阶梯封顶到 128。
 * 容器只在「证据全部来自 ogg_*_hash」时才判 ogg，否则按 mp3（**不猜 flac/ape**）。
 */
function kugouQualityFromExtra(extra: Record<string, string>): CandidateQuality | undefined {
  const sq = extraStr(extra, "sq_hash");
  const hi320 = extraStr(extra, "hq_hash", "res_hash");
  const ogg320 = extraStr(extra, "ogg_320_hash");
  const mid = extraStr(extra, "hash", "file_hash");
  const ogg128 = extraStr(extra, "ogg_128_hash");
  const capped = extraStr(extra, "privilege") === "0";
  if (sq && !capped) return { container: "flac" };
  if ((hi320 || ogg320) && !capped) return { container: hi320 ? "mp3" : "ogg", bitrateKbps: 320 };
  if (mid || ogg128) return { container: mid ? "mp3" : "ogg", bitrateKbps: 128 };
  if (sq || hi320 || ogg320) return { container: "mp3", bitrateKbps: 128 }; // privilege=0 封顶
  return undefined;
}

/**
 * migu 档位：`format_type` 是平台自己的标识 —— ZQ（母带级）/ SQ（无损）/ HQ（高品）/ 其余（标准）。
 * ⚠️ 平台只给档位**标签**、不给位深/采样率，这里按标签语义声明（ZQ 按 24bit、SQ 按 16bit
 * 无损）；**真实值由 inspect / 下载后探针覆盖**，此处仅用于预排序与预筛。
 */
function miguQualityFromExtra(extra: Record<string, string>): CandidateQuality | undefined {
  const t = (extraStr(extra, "format_type") ?? "").toUpperCase();
  if (!t) return undefined;
  if (t === "ZQ") return { container: "flac", bitDepth: 24 };
  if (t === "SQ") return { container: "flac", bitDepth: 16 };
  if (t === "HQ") return { container: "mp3", bitrateKbps: 320 };
  return { container: "mp3", bitrateKbps: 128 };
}

/**
 * 从信源 `extra` 推「可得档位」（纯函数，零网络）。
 * 认得的平台：kugou(kw 阶梯) / migu(format_type)；其余平台（netease/qq/kuwo/... 只给 id）
 * 一律返回 `undefined` —— **不给信息就是不猜，交给 inspect 或下载后探针**。
 */
export function declaredFromExtra(
  platform: string,
  extra?: Record<string, string> | null,
): CandidateQuality | undefined {
  if (!extra || typeof extra !== "object") return undefined;
  const p = String(platform ?? "").trim().toLowerCase();
  if (p === "kugou" || p === "kg") return kugouQualityFromExtra(extra);
  if (p === "migu" || p === "mg") return miguQualityFromExtra(extra);
  return undefined;
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
    /** 信源原始附加信息（go-music-dl data-extra 原样透传）。 */
    extra?: Record<string, string>;
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
  // 原始 extra 原样透传（内含平台音质阶梯），是 inspect 判不可用后的诊断依据。
  if (meta?.extra) c.extra = meta.extra;
  return c;
}

// ==================== 两条取链分支 ====================

/** 一条取链记录：候选本体 + 「送给 inspectSong 的原始 song-like」（与 streamUrl 入参同源）。 */
interface CandRecord {
  cand: Candidate;
  /** 原样透传给 inspectSong（分支 A 就是搜索结果本体，携带平台原生 id / source / extra）。 */
  song?: Record<string, any>;
}

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
async function viaSearch(src: CandidateSource, target: FetchTarget): Promise<CandRecord[]> {
  const query = [target.title, target.artist].filter(Boolean).join(" ").trim();
  const res = await src.provider.search(src.config, { query });
  const songs: OnlineSongResult[] = Array.isArray(res?.songs) ? res.songs : [];
  const out: CandRecord[] = [];
  for (const s of songs) {
    let url = "";
    try {
      url = String(src.provider.streamUrl(src.config, s) ?? "");
    } catch (e) {
      log.debug("streamUrl 抛错，跳过该搜索结果", { pluginId: src.pluginId, err: String(e) });
      continue;
    }
    if (!isHttpUrl(url)) continue;
    const platform = normalizePlatform(s.source);
    const durationSec = typeof s.duration === "number" && s.duration > 0 ? s.duration : undefined;
    // 取链已确定的事实（URL 后缀 / sortBitrate / sortSize / duration）为 base，
    // extra 阶梯只补空缺（见 mergeDeclaredHint）。
    const declared = mergeDeclaredHint(
      {
        container: containerFromUrl(url),
        bitrateKbps: parseBitrateKbps(s.sortBitrate),
        bytes: parseBytes(s.sortSize),
        durationSec,
      },
      declaredFromExtra(platform, s.extra),
    );
    const cand = buildCandidate({
      src,
      url,
      platformSongId: s.id ? String(s.id) : "",
      declared,
      meta: {
        title: s.name || undefined,
        artist: s.artist || undefined,
        album: s.album || undefined,
        durationSec,
        coverUrl: s.cover || undefined,
        platform,
        genre: pickGenre(s.extra),
        extra: (s.extra as Record<string, string>) || undefined,
      },
    });
    // 送进 inspectSong 的 duration 与 meetsFloor 时长门禁**同源**：都取该候选
    // declared.durationSec（同一候选对象、同一字段、同一个值）。服务端用
    // `真实字节数*8/duration/1000` 算码率，两处若各用一个 duration，码率会等比失真，
    // 足以把音质更差的候选推上「最高音质」。缺失则传 0（服务端 bitrate 给 "-"，插件省略该键）。
    out.push({ cand, song: { ...s, duration: cand.declared?.durationSec ?? 0 } });
  }
  return out;
}

/** 分支 B：resolveStream(config, songLike) → Promise<string>，空串/异常同败（:255-258）。 */
async function viaResolveStream(src: CandidateSource, target: FetchTarget): Promise<CandRecord[]> {
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
  const cand = buildCandidate({
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
  });
  return [
    {
      cand,
      // 纯 stream 源目前没有 inspectSong；这里仍给一个与 streamUrl 同源的 song-like，
      // 便于未来该分支接上 inspect（gate duration 与 declared 同源：无声明 → 0）。
      song: { ...songLike, source: sd.platform, name: target.title, extra: undefined, duration: cand.declared?.durationSec ?? 0 },
    },
  ];
}

/** inspect 阶段的开关与预算。 */
interface InspectOpts {
  enabled: boolean;
  timeoutMs: number;
  topN: number;
}

/** extra 阶梯强弱（仅用于 inspect 预排序：先把「看起来最好」的探出来）。 */
function hintRank(c: Candidate): number {
  return c.declared ? TIER_RANK[classifyTier(c.declared)] : TIER_RANK.unknown;
}

/**
 * 采纳 inspect 结果。
 * - `bitrateKbps` 是服务端用**真实 Content-Range 字节数**算出的整型值 → 精确，优先；
 * - `bytes` 是服务端 `%.1f MB` 量化后的近似值（小文件误差可达 ±5%）→ 只作兜底
 *   （quality.pickQuality 在两者并存时会主动让位给 bitrateKbps）。
 * - 两者都可能缺失（duration=0 时服务端 bitrate 为 "-"，插件会省略该键）→ 什么都不写。
 */
function applyInspectResult(c: Candidate, res: Record<string, any>): void {
  const q: CandidateQuality = { ...(c.declared ?? {}) };
  if (typeof res.bitrateKbps === "number" && Number.isFinite(res.bitrateKbps) && res.bitrateKbps > 0) {
    q.bitrateKbps = Math.round(res.bitrateKbps);
  }
  if (typeof res.bytes === "number" && Number.isFinite(res.bytes) && res.bytes > 0) {
    q.bytes = Math.round(res.bytes);
  }
  const merged = compactQuality(q);
  if (merged) c.declared = merged;
}

/**
 * `{valid:false}` 的处置：服务端**明确**说这一档取不到地址（酷狗 privilege=10 的官方歌、
 * QQ 当前凭据过期的歌都属此类）。这是**正常业务响应，不是失败** —— 不记 warning、
 * 不计失败、不触发重试。
 *
 * 但候选**保留**在列表里（不静默丢弃，原始 extra 阶梯仍可从 `c.extra` 查）：
 * 清空声明质量 → tier 归 unknown → 下游打分为最低 → 自然排到最后，
 * 不会靠乐观的 extra 阶梯抢到最优位把能用的源挡住。
 */
function markInspectUnavailable(c: Candidate): void {
  c.inspectUnavailable = true;
  c.declared = undefined;
}

/**
 * inspect 预探阶段（增强项，**任何失败都静默降级**）。
 *
 * 预算纪律：**与取链预算是两个独立预算**（`inspectTimeoutMs` vs `candidateTimeoutMs`），
 * 不得合并 —— 单个源取链预算默认 15s，而逐候选串行探 6 个 × 8s 上限 48s；若共用，
 * inspect 一慢就会把**已经拿到的取链结果**一起判超时丢掉，本末倒置（inspect 只是用来排序）。
 * 故这里另设 `deadline = now + inspectTimeoutMs × 待探个数`，到点只是**停止继续探**，
 * 已探到的结果照常生效，取链结果永远保住。
 *
 * 逐候选**串行**（与取链同口径，防风控）；单请求带 `inspectTimeoutMs` 超时；
 * 单个候选失败/超时/返回 null 只影响它自己。
 */
async function inspectRecords(src: CandidateSource, records: CandRecord[], o: InspectOpts): Promise<void> {
  if (!o.enabled || records.length === 0) return;
  if (typeof src.provider?.inspectSong !== "function") {
    // 已装插件还没这个方法 —— 必须能优雅退化，不影响取链结果。
    log.debug("源未实现 inspectSong，跳过 inspect 阶段", { pluginId: src.pluginId });
    return;
  }
  // 预排序：extra 阶梯强的先探（防请求放大；截断到 maxCandidatesPerSong 时留下的也正是这批）。
  const ordered = [...records].sort((a, b) => hintRank(b.cand) - hintRank(a.cand));
  const batch = ordered.slice(0, Math.max(1, o.topN));
  const deadline = Date.now() + o.timeoutMs * batch.length;
  let anyValid = false;
  let anyInvalid = false;
  for (const rec of batch) {
    if (Date.now() > deadline) break; // 预算用尽：停止继续探，保留已探结果
    let res: any = null;
    try {
      res = await withTimeout(Promise.resolve(src.provider.inspectSong(src.config, rec.song)), o.timeoutMs);
    } catch (e) {
      // 超时 → 与 null 同语义（探测异常）；不影响其它候选、更不影响取链结果。
      log.debug("inspect 探测异常/超时（按 null 处理）", {
        pluginId: src.pluginId,
        candidateId: rec.cand.id,
        err: String(e),
      });
      res = null;
    }
    // null / 畸形返回 = 网络失败或解析失败 → 静默跳过（插件保证不抛，这里再兜一层）。
    if (!res || typeof res !== "object" || typeof res.valid !== "boolean") continue;
    if (res.valid === true) {
      anyValid = true;
      applyInspectResult(rec.cand, res);
      continue;
    }
    anyInvalid = true;
    markInspectUnavailable(rec.cand);
  }
  // 「全部失败静默降级」的判据是**没有任何候选返回 valid:true**，
  // 而不是「有任何非 true 的返回」—— 后者会把整批歌都误判成降级。
  if (!anyValid) {
    log.debug("inspect 未取得任何 valid:true 结果，按无 inspect 结果继续", {
      pluginId: src.pluginId,
      anyInvalid,
    });
  }
}

/** 单source取链：多条路由**串行**（防风控），整体受 `timeoutMs` 预算约束。 */
async function collectFromSource(
  src: CandidateSource,
  target: FetchTarget,
  timeoutMs: number,
  inspectOpts: InspectOpts,
): Promise<Candidate[]> {
  const routes: Array<() => Promise<CandRecord[]>> = [];
  if (supportsSearchRoute(src, target)) routes.push(() => viaSearch(src, target));
  if (supportsResolveRoute(src, target)) routes.push(() => viaResolveStream(src, target));
  if (routes.length === 0) {
    log.debug("源不参与本轮换（能力/元数据不匹配）", { pluginId: src.pluginId });
    return [];
  }
  const records = await withTimeout(
    (async () => {
      const acc: CandRecord[] = [];
      for (const route of routes) {
        try {
          acc.push(...(await route()));
        } catch (e) {
          // 单条路由失败不影响同一插件的其它路由，更不影响其它插件。
          log.warn("取链路由失败", { pluginId: src.pluginId, err: String(e) });
        }
      }
      return acc;
    })(),
    timeoutMs,
  );
  // 取链已产出候选；inspect 在**独立预算**里做增强，任何失败都不影响 records。
  try {
    await inspectRecords(src, records, inspectOpts);
  } catch (e) {
    // 理论到不了这里（inspectRecords 内部已全包），再兜一层：绝不让 inspect 拖垮取链。
    log.debug("inspect 阶段异常（忽略，保留取链结果）", { pluginId: src.pluginId, err: String(e) });
  }
  return records.map((r) => r.cand);
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

  const inspectOpts: InspectOpts = {
    enabled: params.inspectCandidates !== false,
    timeoutMs: positiveOr(params.inspectTimeoutMs, DEFAULT_INSPECT_TIMEOUT_MS),
    topN: positiveOr(params.inspectTopN, DEFAULT_INSPECT_TOP_N),
  };

  // 跨插件并发；任一 reject（含超时）由 allSettled 兜住，只影响对应的那一个源。
  const settled = await Promise.allSettled(
    sources.map((s) => collectFromSource(s, target, timeoutMs, inspectOpts)),
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
  // inspect 判「取不到地址」的候选（inspectUnavailable）一律排到最后 —— 它们
  // 已清空声明质量，下游按 unknown 打分本就最低，这里再做一层显式兜底。
  deduped.sort(
    (a, b) =>
      (a.inspectUnavailable ? 1 : 0) - (b.inspectUnavailable ? 1 : 0) || a.sourceRank - b.sourceRank,
  );
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
  if (c.extra && Object.keys(c.extra).length > 0) n++;
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
  let [base, other] = fillScore(b) > fillScore(a) ? [b, a] : [a, b];
  // inspect 判「不可用」的一条绝不做 base：可用那条的信息才有价值。
  if (base.inspectUnavailable && !other.inspectUnavailable) [base, other] = [other, base];
  const merged: Candidate = { ...base };
  if (!merged.url && other.url) merged.url = other.url;
  if (!merged.title && other.title) merged.title = other.title;
  if (!merged.artist && other.artist) merged.artist = other.artist;
  if (!merged.album && other.album) merged.album = other.album;
  if (!merged.genre && other.genre) merged.genre = other.genre;
  if (!merged.extra && other.extra) merged.extra = other.extra;
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
