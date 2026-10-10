// ==================== MusicFetch 任务级配置 ====================
//
// 一次下载任务「生效的配置」集中在这里：既包含落盘命名 / 质量门槛（复用 naming.ts /
// types.ts 的既有默认值，不另起一套），也包含并发 / 超时 / 冲突等同一次任务相关的旋钮。
//
// 三条硬性需求在本文件里各有对应开关（由上层 orchestrator 消费）：
//   1. 同一首网络源的歌只下载一次（幂等，跨任务也不重复下）→ 上层配合 `source.ts` +
//      `existing.ts` 判定「是否已有」，本配置提供 `skipIfInLibrary`；
//   2. 只下载最高音质（且必须是完整歌曲）→ `strictBestTier`（最优档失败后只重试同档/
//      更高档，绝不降级）+ `quality.minDurationSec`（过滤试听片段）；
//   3. 本地 / WebDAV 已有则不重复下 → `skipIfInLibrary`（默认开）。
//
// 注意：本文件刻意**零 IO、零副作用**（除 path.resolve 外），便于单测与在任意层引用。
import * as path from "node:path";
import { DEFAULT_NAMING_CONFIG, type ConflictPolicy, type NamingConfig } from "./naming.js";
import { DEFAULT_QUALITY_CONFIG, type QualityConfig } from "./types.js";
import type { IntegrityLevel } from "./integrity.js";

/** 默认下载根目录（落盘成品）。 */
export const DEFAULT_DOWNLOAD_ROOT = "/MUSIC/DOWNLOAD";
/** 默认缓存根目录（半成品 / 死信）。 */
export const DEFAULT_CACHE_ROOT = "/MUSIC/DOWNLOADCACHE";

/** 一次下载任务生效的完整配置。 */
export interface FetchConfig {
  enabled: boolean;
  /** 成品落盘根目录，默认 "/MUSIC/DOWNLOAD" */
  downloadRoot: string;
  /** 缓存/半成品根目录，默认 "/MUSIC/DOWNLOADCACHE" */
  cacheRoot: string;
  /** 落盘命名模板（复用 naming.ts） */
  naming: NamingConfig;
  /** 质量门槛（复用 types.ts） */
  quality: QualityConfig;
  /** 本地(l:)/WebDAV(w:)已有同曲 → 跳过不下载。默认 true */
  skipIfInLibrary: boolean;
  /** 只下最高音质档：最优候选失败后只重试「同档或更高档」，绝不降到更低音质。默认 true */
  strictBestTier: boolean;
  /** 完整性校验档位，默认 "probe" */
  integrityLevel: IntegrityLevel;
  /** 转码默认开启（用户已拍板） */
  transcodeEnabled: boolean;
  transcodeTarget: "flac" | "alac" | "wav";
  transcodeSampleRateHz?: number;
  transcodeBitDepth?: 16 | 24;
  transcodeKeepOriginal: boolean;
  /** 转码时是否把响度归一化到目标 LUFS（-14）。默认开。 */
  transcodeLoudnessNormalize: boolean;
  /** 响度目标 LUFS；缺省 -14（= services/audio/normalization.ts 的 DEFAULT_TARGET_LUFS）。 */
  transcodeLoudnessTargetLufs: number;
  /** 两遍（先测后编，linear）响度归一化；默认 true，false = 单遍动态。 */
  transcodeLoudnessTwoPass: boolean;
  sourcePriority: string[];
  maxCandidatesPerSong: number;
  candidateTimeoutMs: number;
  /** 取链后是否对候选做 inspect 预探（拿真实体积/码率来选最高音质）。默认 true。
   *  插件未实现 `inspectSong` 或服务不可达时静默降级（只记 debug 日志）。 */
  inspectCandidates?: boolean;
  /** 单次 inspect 请求超时（毫秒）。默认 8000。与取链/下载预算是**三个独立预算**。 */
  inspectTimeoutMs?: number;
  /** 每首歌最多 inspect 前 N 个候选（按 extra 阶梯预排序后），防请求放大。默认 6。 */
  inspectTopN?: number;
  fileConflictPolicy: ConflictPolicy;
  overwriteExisting: boolean;
  writeSourceComment: boolean;
  embedCover: boolean;
  maxConcurrentDownloads: number;
  maxConcurrentPerHost: number;
  perHostMinIntervalMs: number;
  /** 0 = 不限速（单位 KB/s） */
  rateLimitKBps: number;
  perFileTimeoutSec: number;
  stallTimeoutSec: number;
  syncToPlaylistIds: string[];
  scanBatchSize: number;
  /** batch 子进程分片大小，见 M2 §2 */
  chunkSize: number;
}

/** 默认配置（所有旋钮的缺省取值见各字段注释）。 */
export const DEFAULT_FETCH_CONFIG: FetchConfig = {
  enabled: true,
  downloadRoot: DEFAULT_DOWNLOAD_ROOT,
  cacheRoot: DEFAULT_CACHE_ROOT,
  naming: DEFAULT_NAMING_CONFIG,
  quality: DEFAULT_QUALITY_CONFIG,
  skipIfInLibrary: true,
  strictBestTier: true,
  integrityLevel: "probe",
  transcodeEnabled: true,
  transcodeTarget: "flac",
  transcodeKeepOriginal: false,
  transcodeLoudnessNormalize: true,
  transcodeLoudnessTargetLufs: -14,
  transcodeLoudnessTwoPass: true,
  sourcePriority: [],
  maxCandidatesPerSong: 6,
  candidateTimeoutMs: 15000,
  inspectCandidates: true,
  inspectTimeoutMs: 8000,
  inspectTopN: 6,
  fileConflictPolicy: "keepBetter",
  overwriteExisting: false,
  writeSourceComment: true,
  embedCover: true,
  maxConcurrentDownloads: 2,
  maxConcurrentPerHost: 1,
  perHostMinIntervalMs: 500,
  rateLimitKBps: 0,
  perFileTimeoutSec: 120,
  stallTimeoutSec: 20,
  syncToPlaylistIds: [],
  scanBatchSize: 10,
  chunkSize: 20,
};

/**
 * 把用户传入的部分配置与默认值合并成完整配置。
 * naming / quality 做**一层深合并**（只覆盖用户显式给的子字段），数组字段做浅拷贝，
 * 避免调用方改到 DEFAULT_FETCH_CONFIG 里的常量对象。
 */
export function resolveFetchConfig(partial?: Partial<FetchConfig>): FetchConfig {
  const p = partial ?? {};
  return {
    ...DEFAULT_FETCH_CONFIG,
    ...p,
    naming: { ...DEFAULT_NAMING_CONFIG, ...(p.naming ?? {}) },
    quality: { ...DEFAULT_QUALITY_CONFIG, ...(p.quality ?? {}) },
    sourcePriority: p.sourcePriority ? [...p.sourcePriority] : [...DEFAULT_FETCH_CONFIG.sourcePriority],
    syncToPlaylistIds: p.syncToPlaylistIds
      ? [...p.syncToPlaylistIds]
      : [...DEFAULT_FETCH_CONFIG.syncToPlaylistIds],
  };
}

/** rel 是否真的落在 base 之内（""=同一路径；以 ".." 开头或为绝对路径=在外）。 */
function isInside(rel: string): boolean {
  return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
}

/**
 * 校验下载 / 缓存两路径。
 *
 * 必须满足：两路径均为绝对路径、互不相同、**互不为祖先**。
 * 为什么要求「互不为祖先」：
 *   - 扫描器（`scanLocalSource`）只遍历 media source 的根目录，若 `cacheRoot` 落在
 *     `downloadRoot` 之内，缓存半成品 / 死信文件会在下一次全量扫描时被一并遍历、
 *     误当成品入库；
 *   - 「结构性隔离」（两目录互不包含）是最可靠的一道防线：另两道是 `.part` 后缀不在
 *     `AUDIO_EXTENSIONS` 里（临时件不入选）、以及只把 rename 成功后的最终路径传给扫描。
 *   三道防线里只有第一道是结构性的，故在此显式校验。
 *
 * 注意：本函数只做**路径形态**校验，不触发任何磁盘 IO（不建目录、不探挂载点）。
 */
export function validateFetchPaths(cfg: FetchConfig): {
  ok: boolean;
  errors: string[];
  warnings: string[];
} {
  const errors: string[] = [];
  const warnings: string[] = [];

  const dl = cfg.downloadRoot;
  const ca = cfg.cacheRoot;

  if (typeof dl !== "string" || dl.trim() === "") {
    errors.push("downloadRoot 为空");
  } else if (!path.isAbsolute(dl)) {
    errors.push(`downloadRoot 必须是绝对路径: ${dl}`);
  }
  if (typeof ca !== "string" || ca.trim() === "") {
    errors.push("cacheRoot 为空");
  } else if (!path.isAbsolute(ca)) {
    errors.push(`cacheRoot 必须是绝对路径: ${ca}`);
  }

  // 形态不对时不再做祖先判断（relative 结果无意义）。
  if (errors.length === 0) {
    const a = path.resolve(dl);
    const b = path.resolve(ca);
    if (a === b) {
      errors.push("downloadRoot 与 cacheRoot 不能是同一路径");
    } else {
      if (isInside(path.relative(a, b))) {
        errors.push(
          `cacheRoot 位于 downloadRoot 之内（${ca} 在 ${dl} 下）：缓存/死信文件会被扫描器一并遍历`,
        );
      }
      if (isInside(path.relative(b, a))) {
        errors.push(
          `downloadRoot 位于 cacheRoot 之内（${dl} 在 ${ca} 下）：成品会被当成缓存清理`,
        );
      }
    }
  }

  return { ok: errors.length === 0, errors, warnings };
}
