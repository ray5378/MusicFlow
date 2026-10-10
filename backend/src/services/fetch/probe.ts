// ==================== 本地音频探针（MusicFetch M1） ====================
//
// 下载落盘之后、入库之前，需要知道「这个文件到底是什么」：容器、编码、时长、
// 码率、采样率、位深、声道、有无内嵌封面、编码器串。这些信息有两个用途：
//   1. 达标判定（`quality.meetsFloor` / `isFakeLossless`）—— 以 probed（真实探针）
//      为准，不信任信源 declared 的声明值；
//   2. 后处理决策 —— 位深决定转码参数、hasCover 决定要不要重新内嵌封面。
//
// 解析用与扫描器同一套 `music-metadata`（`parseFile`），保证「扫描入库」与
// 「下载校验」对同一个文件给出一致的口径，避免两处各自实现导致判定打架。
//
// 缓存：`audioInfo.ts` 的同款 path + size + mtimeMs 判命中（文件被替换自动失效）。
// 与 audioInfo 不同的是本模块**必须解析封面与时长**（download 校验需要 hasCover /
// durationSec），故不传 `skipCovers` / `duration:false`。
//
// 失败语义：本模块**只在真正拿不到信息时抛错**（文件不存在 / 无法解析 / 无音频流），
// 抛出的错误带 `FetchErrorCode`，调用方直接落 Item 状态即可。
import { statSync } from "node:fs";
import { extname } from "node:path";
import { parseFile } from "music-metadata";
import { createLogger } from "../../utils/logger.js";
import type { CandidateQuality, FetchErrorCode } from "./types.js";

const log = createLogger("FETCH_PROBE");

/** 探针结果：一个本地音频文件的真实属性（probed，非信源声明）。 */
export interface ProbedMedia {
  /** 绝对路径 */
  path: string;
  /** 文件字节数 */
  bytes: number;
  /** 归一化容器名：mp3 / flac / m4a / ogg / opus / wav / aiff / ape */
  container?: string;
  /** 编码器名（music-metadata 原文，如 "MPEG 1 Layer 3" / "FLAC"） */
  codec?: string;
  /** 时长（秒） */
  durationSec?: number;
  /** 码率（kbps） */
  bitrateKbps?: number;
  /** 采样率（Hz） */
  sampleRateHz?: number;
  /** 位深（有损格式通常拿不到 → undefined；flac/wav/alac 有值） */
  bitDepth?: number;
  /** 声道数 */
  channels?: number;
  /** 是否含内嵌封面 */
  hasCover: boolean;
  /** 编码器 metadata 串（"Lavf61.1.100" 等，假无损的 meta 判定依据） */
  encoder?: string;
  /** 是否无损容器 */
  lossless?: boolean;
}

/** 探针失败：文件不存在 / 无法解析 / 非音频。 */
export class FetchProbeError extends Error {
  readonly code: FetchErrorCode;
  readonly file: string;

  constructor(code: FetchErrorCode, message: string, file: string) {
    super(message);
    this.name = "FetchProbeError";
    this.code = code;
    this.file = file;
  }
}

/** 按扩展名归一化容器（最可靠：同一容器可能被 music-metadata 报成不同名字）。 */
const CONTAINER_BY_EXT: Record<string, string> = {
  ".mp3": "mp3",
  ".flac": "flac",
  ".m4a": "m4a",
  ".mp4": "m4a",
  ".alac": "m4a",
  ".ogg": "ogg",
  ".oga": "ogg",
  ".opus": "opus",
  ".wav": "wav",
  ".wave": "wav",
  ".aiff": "aiff",
  ".aif": "aiff",
  ".ape": "ape",
};

/** music-metadata 的 format.container → 归一化容器名兜底映射。 */
const CONTAINER_BY_FORMAT: Record<string, string> = {
  MPEG: "mp3",
  FLAC: "flac",
  Ogg: "ogg",
  Opus: "opus",
  WAVE: "wav",
  AIFF: "aiff",
  "Monkey's Audio": "ape",
  ADTS: "aac",
  MP4: "m4a",
  QuickTime: "m4a",
  "Matroska / WebM": "mka",
};

/**
 * 归一化容器名。
 *
 * 为什么扩展名优先：music-metadata 把 mp3 报成 `MPEG`、把 m4a 报成 `MP4`，直接拿
 * 它当容器名会和 `QualityConfig.allowedContainers`（'flac'|'mp3'|…）对不上。
 */
export function normalizeContainer(
  file?: string,
  container?: string,
  codec?: string,
): string | undefined {
  const ext = extname(file || "").toLowerCase();
  if (CONTAINER_BY_EXT[ext]) return CONTAINER_BY_EXT[ext];
  const raw = (container || "").trim();
  if (CONTAINER_BY_FORMAT[raw]) return CONTAINER_BY_FORMAT[raw];
  const lower = raw.toLowerCase();
  if (lower.includes("mpeg") || lower.includes("mp3") || lower.includes("layer")) return "mp3";
  if (lower.includes("flac")) return "flac";
  if (lower.includes("ogg") || lower.includes("vorbis")) return "ogg";
  if (lower.includes("opus")) return "opus";
  if (lower.includes("wave") || lower.includes("pcm")) return "wav";
  if (lower.includes("aiff")) return "aiff";
  const codecLower = (codec || "").toLowerCase();
  if (codecLower.includes("mp3") || codecLower.includes("mpeg")) return "mp3";
  if (codecLower.includes("flac")) return "flac";
  return lower || undefined;
}

interface CacheEntry {
  size: number;
  mtimeMs: number;
  media: ProbedMedia;
}

/** 上限（防无界增长）：超了直接清空重来 —— 重解析一次的代价远小于 LRU 记账。 */
const CACHE_MAX = 2048;
const cache = new Map<string, CacheEntry>();

/** 测试用：清空探针缓存（生产不调用）。 */
export function clearProbeCache(): void {
  cache.clear();
}

/**
 * 探测本地音频文件。
 *
 * @param file  绝对路径
 * @param opts  useCache（默认 true）/ requireAudio（默认 true：非音频直接抛错）
 * @throws FetchProbeError  FETCH_FAILED（不存在/不可读）| INTEGRITY_FAILED（无法解析/无音频流）
 */
export async function probeFile(
  file: string,
  opts: { useCache?: boolean; requireAudio?: boolean } = {},
): Promise<ProbedMedia> {
  const useCache = opts.useCache !== false;
  const requireAudio = opts.requireAudio !== false;

  let st: { size: number; mtimeMs: number; isFile: () => boolean };
  try {
    st = statSync(file);
  } catch {
    throw new FetchProbeError("FETCH_FAILED", `文件不存在或不可读: ${file}`, file);
  }
  if (!st.isFile()) {
    throw new FetchProbeError("FETCH_FAILED", `不是普通文件: ${file}`, file);
  }

  const hit = useCache ? cache.get(file) : undefined;
  if (hit && hit.size === st.size && hit.mtimeMs === st.mtimeMs) return hit.media;

  let meta: any;
  try {
    meta = await parseFile(file, { duration: true });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    log.warn("音频解析失败", { file, err: msg });
    throw new FetchProbeError("INTEGRITY_FAILED", `无法解析音频文件: ${file} (${msg})`, file);
  }

  const fmt: any = meta?.format || {};
  const common: any = meta?.common || {};
  if (requireAudio && fmt.hasAudio === false) {
    throw new FetchProbeError("INTEGRITY_FAILED", `文件不含音频流: ${file}`, file);
  }

  const media: ProbedMedia = {
    path: file,
    bytes: st.size,
    container: normalizeContainer(file, fmt.container, fmt.codec),
    codec: typeof fmt.codec === "string" && fmt.codec ? fmt.codec : undefined,
    durationSec:
      typeof fmt.duration === "number" && Number.isFinite(fmt.duration) && fmt.duration > 0
        ? fmt.duration
        : undefined,
    bitrateKbps:
      typeof fmt.bitrate === "number" && Number.isFinite(fmt.bitrate) && fmt.bitrate > 0
        ? Math.round(fmt.bitrate / 1000)
        : undefined,
    sampleRateHz:
      typeof fmt.sampleRate === "number" && Number.isFinite(fmt.sampleRate) && fmt.sampleRate > 0
        ? fmt.sampleRate
        : undefined,
    bitDepth:
      typeof fmt.bitsPerSample === "number" && Number.isFinite(fmt.bitsPerSample) && fmt.bitsPerSample > 0
        ? fmt.bitsPerSample
        : undefined,
    channels:
      typeof fmt.numberOfChannels === "number" && fmt.numberOfChannels > 0
        ? fmt.numberOfChannels
        : undefined,
    hasCover: !!(Array.isArray(common.picture) && common.picture.length > 0),
    encoder: typeof fmt.tool === "string" && fmt.tool ? fmt.tool : undefined,
    lossless: typeof fmt.lossless === "boolean" ? fmt.lossless : undefined,
  };

  if (cache.size >= CACHE_MAX) cache.clear();
  cache.set(file, { size: st.size, mtimeMs: st.mtimeMs, media });
  return media;
}

/** 探针结果 → CandidateQuality（供 quality 打分/门槛判定消费）。 */
export function toCandidateQuality(p: ProbedMedia, bytes?: number): CandidateQuality {
  return {
    container: p.container,
    bitrateKbps: p.bitrateKbps,
    sampleRateHz: p.sampleRateHz,
    bitDepth: p.bitDepth,
    channels: p.channels,
    durationSec: p.durationSec,
    bytes: typeof bytes === "number" ? bytes : p.bytes,
    encoder: p.encoder,
  };
}

/** 设计稿 §3.2 形态：直接返回 CandidateQuality（probeFile + toCandidateQuality）。 */
export async function probeLocalFile(file: string): Promise<CandidateQuality> {
  const media = await probeFile(file);
  return toCandidateQuality(media, media.bytes);
}
