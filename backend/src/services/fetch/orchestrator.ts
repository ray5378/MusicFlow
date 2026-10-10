// ==================== MusicFetch 下载流水线编排 ====================
//
// 把已落地的所有模块串成「一个 target 一首歌」的流水线：
//   任务内去重 → 本地/WebDAV 已有则跳过 → 取链 → 门槛排序 → 只下最高音质档 →
//   逐候选 下载 / 完整性校验 / 真实探针复筛 / 假无损 / 完整歌曲守卫 / 写标签 /
//   （可选）转码 / 原子落盘 → 攒批点名增量入库 → 每首心跳。
//
// 三条用户硬性需求在本文件的落点：
//   1. 同一首只下载一次：候选循环**首个成功即 break**；跨任务靠 `existing.ts` 的库内判定 +
//      `finalize` 的 keepBetter 双重保证。
//   2. 只下载最高音质：`strictBestTier` 为真时 `eligible` 只在「同档或更高档」里选，
//      最优档失败绝不降级重试；再加「完整歌曲守卫」（时长缺失/超差一律换候选）。
//   3. 本地/WebDAV 已有则不下载：第 2 步命中直接 skipped，**零取链零下载**。
//
// 韧性：每个 target 整体 try/catch（一首歌的异常不得终止整批）；`signal.aborted` 贯穿到底；
// `onProgress` 是防 15 分钟看门狗的唯一心跳（SPEC §1.3）。
//
// 全部外部依赖通过 `deps` 注入（默认用真实实现），单测整体替换即可零网络零 ffmpeg。
import { mkdtempSync, readFileSync, renameSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { createHash } from "node:crypto";
import { eq } from "drizzle-orm";
import { db } from "../../db/index.js";
import { songs } from "../../db/schema.js";
import { downloadToFile, type DownloadResult } from "../../utils/httpDownload.js";
import { searchCover, searchLyrics } from "../../plugins/providers.js";
import type { LyricSongInput } from "../../plugins/types.js";
import { collectCandidates, type FetchTarget } from "./candidates.js";
import {
  classifyTier,
  isFakeLossless,
  meetsFloor,
  rankCandidates,
  shouldUpgrade,
  TIER_RANK,
} from "./quality.js";
import { probeFile, toCandidateQuality } from "./probe.js";
import { verifyIntegrity } from "./integrity.js";
import { writeTags, type SongTags } from "./tagWriter.js";
import { transcodeFile } from "./transcode.js";
import { finalizeFile, type FinalizeResult } from "./finalize.js";
import { findExistingPlayable } from "./existing.js";
import { ensureDownloadSource } from "./source.js";
import { scanLocalFiles } from "../source/scanner.js";
import { resolveFetchConfig, validateFetchPaths, type FetchConfig } from "./config.js";
import { HostLimiter, Semaphore } from "./limiter.js";
import type { Candidate, CandidateQuality, FetchErrorCode, ItemStatus, QualityTier } from "./types.js";

// ==================== 结果契约 ====================

export interface FetchPipelineCounts {
  total: number;
  done: number;
  failed: number;
  skipped: number;
  added: number;
  updated: number;
  bytes: number;
}

export interface FetchItemOutcome {
  targetId: string;
  status: ItemStatus;
  attempts: number;
  /** 本次认定的「最高音质档」（审计用） */
  targetTier?: QualityTier;
  chosen?: {
    candidateId: string;
    pluginId: string;
    platform: string;
    declared?: CandidateQuality;
    probed?: CandidateQuality;
  };
  rejected: Array<{ candidateId: string; reason: FetchErrorCode; detail?: string }>;
  bytes?: number;
  finalPath?: string;
  songId?: string;
  cachePath?: string;
  errorCode?: FetchErrorCode;
  errorMsg?: string;
}

export interface FetchPipelineProgress {
  targetId: string;
  index: number;
  total: number;
  status: ItemStatus;
  tier?: QualityTier;
  bytes?: number;
  errorCode?: FetchErrorCode;
}

export interface FetchPipelineResult {
  sourceId: string;
  items: FetchItemOutcome[];
  counts: FetchPipelineCounts;
  warnings: string[];
}

/** 测试注入点：默认用真实实现，单测里整体替换。 */
export interface FetchDeps {
  collectCandidates: typeof collectCandidates;
  downloadToFile: typeof downloadToFile;
  verifyIntegrity: typeof verifyIntegrity;
  probeFile: typeof probeFile;
  writeTags: typeof writeTags;
  transcodeFile: typeof transcodeFile;
  finalizeFile: typeof finalizeFile;
  findExistingPlayable: typeof findExistingPlayable;
  scanLocalFiles: typeof scanLocalFiles;
  ensureDownloadSource: typeof ensureDownloadSource;
  rankCandidates: typeof rankCandidates;
  /** 歌词 provider（价值增值项：拿不到只告警，不让整首歌失败）。 */
  searchLyrics: typeof searchLyrics;
  /** 封面 provider（同上；优先用 Candidate.coverUrl，缺了才调它）。 */
  searchCover: typeof searchCover;
}

const DEFAULT_DEPS: FetchDeps = {
  collectCandidates,
  downloadToFile,
  verifyIntegrity,
  probeFile,
  writeTags,
  transcodeFile,
  finalizeFile,
  findExistingPlayable,
  scanLocalFiles,
  ensureDownloadSource,
  rankCandidates,
  searchLyrics,
  searchCover,
};

export interface RunFetchPipelineOptions {
  targets: FetchTarget[];
  config?: Partial<FetchConfig>;
  /** 省略时内部调 ensureDownloadSource */
  sourceId?: string;
  onProgress?: (p: FetchPipelineProgress) => void;
  signal?: AbortSignal;
  dryRun?: boolean;
  deps?: Partial<FetchDeps>;
}

// ==================== 小工具 ====================

/** 封面下载体积上限（8 MiB）：防误拉到整轨音频或超大图。 */
const COVER_MAX_BYTES = 8 * 1024 * 1024;

/**
 * 增值项（歌词 / 封面 provider、封面下载）的单次短超时（毫秒）。
 * 铁律：这些都是「锦上添花」，拿不到只记 warning，**绝不让整首歌失败**，也绝不长等。
 */
const ENRICH_TIMEOUT_MS = 10_000;

/** 给一个 promise 套超时护栏（超时即 reject，原 promise 不再占用调用方预算）。 */
function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const guard = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`enrich timeout after ${ms}ms`)), ms);
  });
  return Promise.race([p, guard]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

function shortHash(s: string): string {
  return createHash("sha1").update(s, "utf8").digest("hex").slice(0, 10);
}

/** 安全文件/目录段：去掉路径分隔符与保留字符。 */
function safeSegment(s: string, fallback: string): string {
  const out = String(s ?? "")
    .replace(/[\\/:*?"<>|\x00-\x1f\x7f]/g, "_")
    .replace(/^\.+/, "")
    .trim()
    .slice(0, 80);
  return out || fallback;
}

function normalizeExt(ext: unknown): string {
  return String(ext ?? "").replace(/^\./, "").toLowerCase();
}

/** 候选的缓存文件扩展名：declared.container → URL 路径后缀 → 兜底 mp3。 */
function candidateExt(cand: Candidate): string {
  const fromDeclared = normalizeExt(cand.declared?.container);
  if (fromDeclared) return fromDeclared;
  try {
    const seg = new URL(cand.url).pathname.split(".").pop();
    if (seg && /^[a-z0-9]{2,5}$/i.test(seg)) return seg.toLowerCase();
  } catch {
    /* 非法 URL：走兜底 */
  }
  return "mp3";
}

function hostOf(url: string): string {
  try {
    return new URL(url).host || "unknown";
  } catch {
    return "unknown";
  }
}

/** 错误对象 → FetchErrorCode（尽量取既有 code，取不到回落到 fallback）。 */
function codeOf(e: unknown, fallback: FetchErrorCode): FetchErrorCode {
  const c = (e as { code?: unknown })?.code;
  return typeof c === "string" ? (c as FetchErrorCode) : fallback;
}

function msgOf(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** 候选的可信质量（probed 优先，回落 declared）。 */
function qualityOf(c: Candidate): CandidateQuality | undefined {
  return c.probed ?? c.declared;
}

function tierOf(c: Candidate): QualityTier {
  const q = qualityOf(c);
  return q ? classifyTier(q) : "unknown";
}

/** 声明/探针音质的短描述（写进 comment 供日后核查）。 */
function describeQuality(q: CandidateQuality | undefined): string {
  if (!q) return "未知";
  const parts: string[] = [];
  if (q.container) parts.push(q.container);
  if (q.bitrateKbps) parts.push(`${Math.round(q.bitrateKbps)}kbps`);
  if (q.sampleRateHz) parts.push(`${Math.round(q.sampleRateHz / 1000)}kHz`);
  if (q.bitDepth) parts.push(`${q.bitDepth}bit`);
  return parts.length > 0 ? parts.join("/") : "未知";
}

/** 归一化标题|歌手，用于任务内去重。 */
function dedupeKey(t: FetchTarget): string {
  const norm = (s: string | undefined): string =>
    String(s ?? "")
      .toLowerCase()
      .replace(/[\s()\[\]{}（）【】]+/g, "");
  return `${norm(t.title)}|${norm(t.artist)}`;
}

/** 候选处理结果。 */
type AttemptOutcome =
  | { kind: "success"; cachePath: string; bytes: number; finalPath: string }
  | { kind: "keep" }
  | { kind: "fail"; code: FetchErrorCode; detail?: string };

function emitProgress(
  onProgress: ((p: FetchPipelineProgress) => void) | undefined,
  item: FetchItemOutcome,
  index: number,
  total: number,
): void {
  if (!onProgress) return;
  try {
    onProgress({
      targetId: item.targetId,
      index,
      total,
      status: item.status,
      tier: item.targetTier,
      bytes: item.bytes,
      errorCode: item.errorCode,
    });
  } catch {
    /* 心跳回调异常不影响主流程 */
  }
}

// ==================== 主入口 ====================

export async function runFetchPipeline(opts: RunFetchPipelineOptions): Promise<FetchPipelineResult> {
  const cfg = resolveFetchConfig(opts.config);
  const warnings: string[] = [];
  const targets = Array.isArray(opts.targets) ? opts.targets : [];
  const counts: FetchPipelineCounts = {
    total: targets.length,
    done: 0,
    failed: 0,
    skipped: 0,
    added: 0,
    updated: 0,
    bytes: 0,
  };

  // 入口配置校验：非法路径直接整体失败返回（不硬着头皮往非法路径写文件）。
  const validity = validateFetchPaths(cfg);
  if (!validity.ok) {
    warnings.push(...validity.errors, ...validity.warnings);
    return { sourceId: opts.sourceId ?? "", items: [], counts, warnings };
  }
  warnings.push(...validity.warnings);

  const deps: FetchDeps = { ...DEFAULT_DEPS, ...(opts.deps ?? {}) };
  const signal = opts.signal;
  const dryRun = !!opts.dryRun;

  // sourceId：未给时确保下载源存在。
  let sourceId = opts.sourceId ?? "";
  if (!sourceId) {
    const r = deps.ensureDownloadSource(cfg.downloadRoot);
    sourceId = r.sourceId;
    if (r.ancestorSourceId) {
      warnings.push(
        `下载目录 ${cfg.downloadRoot} 已被另一个媒体源（${r.ancestorSourceId}）覆盖，可能出现同一文件两行`,
      );
    }
  }

  if (cfg.syncToPlaylistIds.length > 0) {
    // 未找到「按 songId 往歌单追加」的既有导出，不为此改其它文件 —— 记警告跳过。
    warnings.push(
      `syncToPlaylistIds 暂未接入（未找到既有导出），已跳过: ${cfg.syncToPlaylistIds.join(",")}`,
    );
  }

  const items: FetchItemOutcome[] = [];
  const seen = new Set<string>();
  const pending: Array<{ item: FetchItemOutcome; finalPath: string }> = [];

  // 限流器：整批共用一个实例（按任务实例创建，跑完随对象 GC）。
  const global = new Semaphore(cfg.maxConcurrentDownloads);
  const hostLimiter = new HostLimiter(cfg.maxConcurrentPerHost, cfg.perHostMinIntervalMs, global);

  const flush = async (): Promise<void> => {
    if (dryRun || pending.length === 0) return;
    const batch = pending.splice(0, pending.length);
    try {
      const res = await deps.scanLocalFiles(sourceId, batch.map((p) => p.finalPath), undefined, signal);
      counts.added += res.added;
      counts.updated += res.updated;
    } catch (e) {
      warnings.push(`点名入库失败: ${msgOf(e)}`);
    }
    // songId 反查（scanLocalFiles 只返回计数）：path = l:<sourceId>:<绝对路径>
    for (const p of batch) {
      try {
        const row = db
          .select({ id: songs.id })
          .from(songs)
          .where(eq(songs.path, `l:${sourceId}:${p.finalPath}`))
          .get();
        if (row?.id) p.item.songId = row.id;
      } catch {
        /* 反查失败不影响主流程 */
      }
    }
  };

  try {
    for (let i = 0; i < targets.length; i++) {
      if (signal?.aborted) {
        // 剩余未开始的 target 全部 cancelled。
        for (let j = i; j < targets.length; j++) {
          const cancelled: FetchItemOutcome = {
            targetId: targets[j]?.id ?? `target-${j}`,
            status: "cancelled",
            attempts: 0,
            rejected: [],
            errorMsg: "任务已取消",
          };
          items.push(cancelled);
          emitProgress(opts.onProgress, cancelled, j, targets.length);
        }
        break;
      }

      const item = await processTarget(targets[i], i);
      items.push(item);
      if (item.status === "done") counts.done++;
      else if (item.status === "failed") counts.failed++;
      else if (item.status === "skipped") counts.skipped++;
      if (item.bytes) counts.bytes += item.bytes;

      if (item.status === "done" && item.finalPath) {
        pending.push({ item, finalPath: item.finalPath });
        if (pending.length >= cfg.scanBatchSize) await flush();
      }

      emitProgress(opts.onProgress, item, i, targets.length);
    }
  } finally {
    // 收尾必 flush 一次（否则最后不足一批的不入库）。
    await flush();
  }

  return { sourceId, items, counts, warnings };

  // ==================== 单曲流水线（闭包） ====================

  /**
   * 采集「增值标签」：风格（信源声明） / 歌词 / 封面。
   *
   * 纪律：**三项都是价值增值项，任一失败只 push warning，绝不上抛**（否则一首歌的
   * 歌词服务抖动就会毁掉整次下载）。风格拿不到不写（不臆造）；封面优先用候选自带的
   * `coverUrl`，缺了才回落 `searchCover` provider。
   */
  async function collectExtraTags(
    t: FetchTarget,
    cand: Candidate,
    base: { title: string; artist?: string; album?: string },
  ): Promise<Partial<SongTags>> {
    const extra: Partial<SongTags> = {};

    // 风格：只认信源声明值（candidates.ts 从 OnlineSongResult.extra 抽取）。
    if (cand.genre) extra.genre = cand.genre;

    const songInput: LyricSongInput = {
      title: base.title,
      artist: base.artist ?? null,
      album: base.album ?? null,
      duration: t.durationSec ?? cand.declared?.durationSec ?? null,
      url: cand.url,
      source: cand.platform || cand.pluginId,
    };

    // 歌词：provider 可能并发多插件，套短超时护栏。
    try {
      const lyric = await withTimeout(deps.searchLyrics(songInput), ENRICH_TIMEOUT_MS);
      if (lyric && lyric.trim()) extra.lyric = lyric;
    } catch (e) {
      warnings.push(`歌词获取失败(忽略，不影响入库): ${msgOf(e)}`);
    }

    // 封面：优先候选自带；回落 provider；再下载成 Buffer 交给 tagWriter（由它落临时图）。
    if (cfg.embedCover) {
      try {
        let coverUrl = cand.coverUrl;
        if (!coverUrl) {
          const u = await withTimeout(deps.searchCover(songInput), ENRICH_TIMEOUT_MS);
          if (u) coverUrl = u;
        }
        if (coverUrl) {
          const buf = await fetchCoverBuffer(coverUrl);
          if (buf) extra.cover = buf;
        }
      } catch (e) {
        warnings.push(`封面获取失败(忽略，不影响入库): ${msgOf(e)}`);
      }
    }

    return extra;
  }

  /** 把封面 URL 下载成内存 Buffer（限 8 MiB）；任何失败返回 undefined 且只记 warning。 */
  async function fetchCoverBuffer(url: string): Promise<Buffer | undefined> {
    let dir: string | undefined;
    try {
      dir = mkdtempSync(path.join(tmpdir(), "mf-cover-"));
      const file = path.join(dir, "cover.part");
      const dl = await deps.downloadToFile({
        url,
        destPath: file,
        timeoutMs: ENRICH_TIMEOUT_MS,
        stallTimeoutMs: ENRICH_TIMEOUT_MS,
        maxBytes: COVER_MAX_BYTES,
        ssrfGuard: true,
        resume: false,
        signal,
      });
      if (!dl.bytes || dl.bytes <= 0) return undefined;
      const buf = readFileSync(file);
      return buf.length > 0 ? buf : undefined;
    } catch (e) {
      warnings.push(`封面下载失败(忽略，不影响入库): ${msgOf(e)}`);
      return undefined;
    } finally {
      if (dir) {
        try { rmSync(dir, { recursive: true, force: true }); } catch { /* 清理失败不影响主流程 */ }
      }
    }
  }

  async function processTarget(t: FetchTarget, index: number): Promise<FetchItemOutcome> {
    const item: FetchItemOutcome = {
      targetId: t?.id ?? `target-${index}`,
      status: "queued",
      attempts: 0,
      rejected: [],
    };
    try {
      if (!t || !t.title) {
        item.status = "failed";
        item.errorCode = "NO_CANDIDATE";
        item.errorMsg = "target 缺标题";
        return item;
      }

      // 1) 任务内去重 —— 零网络零下载。
      const key = dedupeKey(t);
      if (seen.has(key)) {
        item.status = "skipped";
        item.errorCode = "DUPLICATE_TARGET";
        item.errorMsg = "同一任务内重复的曲目";
        return item;
      }
      seen.add(key);

      // 2) 本地/WebDAV 已有 → 跳过（用户硬性要求 3）。命中时绝不发起取链/下载。
      //    无论 skipIfInLibrary 与否都查一次：命中且开关为真 → 跳过；命中且开关为假 →
      //    保留为 newIsBetter 的档位比较依据（见 finalize 前的 shouldUpgrade）。
      let existing: ReturnType<typeof findExistingPlayable> = null;
      try {
        existing = deps.findExistingPlayable(
          { title: t.title, artist: t.artist, album: t.album, durationSec: t.durationSec },
          cfg.quality.durationToleranceSec,
        );
      } catch (e) {
        warnings.push(`库内查重失败(忽略，继续下载): ${msgOf(e)}`);
      }
      if (existing && cfg.skipIfInLibrary) {
        item.status = "skipped";
        item.errorCode = "ALREADY_IN_LIBRARY";
        item.errorMsg = `库内已有：${existing.kind} ${existing.path}`;
        return item;
      }

      // 3) 取链。
      if (signal?.aborted) {
        item.status = "cancelled";
        item.errorMsg = "任务已取消";
        return item;
      }
      let cands: Candidate[] = [];
      try {
        cands = await deps.collectCandidates({
          target: t,
          sourcePriority: cfg.sourcePriority,
          candidateTimeoutMs: cfg.candidateTimeoutMs,
          maxCandidatesPerSong: cfg.maxCandidatesPerSong,
        });
      } catch (e) {
        item.status = "failed";
        item.errorCode = "UNKNOWN";
        item.errorMsg = `取链异常: ${msgOf(e)}`;
        return item;
      }
      if (!Array.isArray(cands) || cands.length === 0) {
        item.status = "failed";
        item.errorCode = "NO_CANDIDATE";
        item.errorMsg = "无可用候选";
        return item;
      }

      // 4) 门槛过滤与排序。
      const ranked = deps.rankCandidates(cands, cfg.quality, { durationSec: t.durationSec });
      if (!ranked || ranked.length === 0) {
        for (const c of cands) {
          // 与 rankCandidates 的预筛口径保持一致（tolerateUnknown）：否则「原因」会对不上。
          const r = meetsFloor(c, cfg.quality, { durationSec: t.durationSec }, { tolerateUnknown: true });
          if (!r.ok) item.rejected.push({ candidateId: c.id, reason: "BELOW_BAR", detail: r.reason });
        }
        item.status = "failed";
        item.errorCode = "BELOW_BAR";
        item.errorMsg = "全部候选未达质量门槛";
        return item;
      }

      // 5) 只下最高音质：strictBestTier 为真时只在「同档或更高档」里选。
      const bestTier = tierOf(ranked[0]);
      item.targetTier = bestTier;
      const eligible = cfg.strictBestTier
        ? ranked.filter((c) => TIER_RANK[tierOf(c)] >= TIER_RANK[bestTier])
        : ranked;

      // 6) dryRun：到此为止，只报告「将会下载」。
      if (dryRun) {
        item.status = "queued";
        return item;
      }

      // 7) 逐候选尝试（eligible 串行）。
      let lastFail: { code: FetchErrorCode; detail?: string } | undefined;
      for (const cand of eligible) {
        if (signal?.aborted) {
          item.status = "cancelled";
          item.errorMsg = "任务已取消";
          return item;
        }
        item.attempts++;
        const outcome = await tryCandidate(cand, t, existing);

        if (outcome.kind === "success") {
          item.status = "done";
          item.bytes = outcome.bytes;
          item.finalPath = outcome.finalPath;
          item.cachePath = outcome.cachePath;
          item.chosen = {
            candidateId: cand.id,
            pluginId: cand.pluginId,
            platform: cand.platform,
            declared: cand.declared,
            probed: cand.probed,
          };
          return item;
        }
        if (outcome.kind === "keep") {
          item.status = "skipped";
          item.errorCode = "ALREADY_IN_LIBRARY";
          item.errorMsg = "落盘目标已存在且更优，保留既有文件";
          return item;
        }
        item.rejected.push({ candidateId: cand.id, reason: outcome.code, detail: outcome.detail });
        lastFail = { code: outcome.code, detail: outcome.detail };
      }

      item.status = "failed";
      item.errorCode = lastFail?.code ?? "UNKNOWN";
      item.errorMsg = lastFail?.detail ?? "全部候选均失败";
      return item;
    } catch (e) {
      // 整曲兜底：一首歌的异常不得终止整批。
      item.status = "failed";
      item.errorCode = "UNKNOWN";
      item.errorMsg = msgOf(e);
      return item;
    }
  }

  /** 单个候选的完整处理；任何失败都归约为 AttemptOutcome（不抛）。 */
  async function tryCandidate(
    cand: Candidate,
    t: FetchTarget,
    existing: ReturnType<typeof findExistingPlayable>,
  ): Promise<AttemptOutcome> {
    const ext = candidateExt(cand);
    const dir = path.join(cfg.cacheRoot, safeSegment(t.id, shortHash(t.title)));
    let cachePath = path.join(dir, `${safeSegment(t.title, "track")}-${shortHash(cand.id)}.${ext}`);
    const partPath = `${cachePath}.part`;
    const cleanup = (): void => {
      for (const p of [partPath, cachePath]) {
        try {
          rmSync(p, { force: true });
        } catch {
          /* 清理失败不影响主流程 */
        }
      }
    };

    // a/b) 限流下载（先落 .part，成功后 rename 成正确扩展名 —— 不能把 .part 喂给 ffmpeg）。
    let dl: DownloadResult;
    try {
      dl = await hostLimiter.run(
        hostOf(cand.url),
        () =>
          deps.downloadToFile({
            url: cand.url,
            destPath: partPath,
            headers: cand.headers,
            timeoutMs: cfg.perFileTimeoutSec * 1000,
            stallTimeoutMs: cfg.stallTimeoutSec * 1000,
            rateLimitKBps: cfg.rateLimitKBps,
            ssrfGuard: true,
            resume: true,
            signal,
          }),
        signal,
      );
    } catch (e) {
      cleanup();
      return { kind: "fail", code: codeOf(e, "FETCH_FAILED"), detail: msgOf(e) };
    }
    try {
      rmSync(cachePath, { force: true });
      renameSync(partPath, cachePath);
    } catch (e) {
      cleanup();
      return { kind: "fail", code: "MOVE_FAILED", detail: `下载完成但改名失败: ${msgOf(e)}` };
    }

    // c) 完整性校验。
    try {
      const ir = await deps.verifyIntegrity(
        {
          file: cachePath,
          expect: { bytes: dl.bytes, sha256: dl.sha256, durationSec: t.durationSec },
        },
        cfg.integrityLevel,
      );
      if (!ir.ok) {
        cleanup();
        return {
          kind: "fail",
          code: ir.code ?? "INTEGRITY_FAILED",
          detail: ir.warnings.join("; ") || "完整性校验失败",
        };
      }
    } catch (e) {
      cleanup();
      return { kind: "fail", code: codeOf(e, "INTEGRITY_FAILED"), detail: msgOf(e) };
    }

    // d) 真实探针；容器与扩展名不一致时改名。
    let probed: CandidateQuality;
    try {
      const p = await deps.probeFile(cachePath);
      probed = toCandidateQuality(p, dl.bytes);
      const realExt = normalizeExt(p.container);
      if (realExt && normalizeExt(path.extname(cachePath)) !== realExt) {
        const newPath = path.join(
          path.dirname(cachePath),
          `${path.basename(cachePath, path.extname(cachePath))}.${realExt}`,
        );
        try {
          rmSync(newPath, { force: true });
          renameSync(cachePath, newPath);
          cachePath = newPath;
        } catch {
          /* 改名失败：保留原名继续 */
        }
      }
    } catch (e) {
      cleanup();
      return { kind: "fail", code: codeOf(e, "INTEGRITY_FAILED"), detail: msgOf(e) };
    }
    const enriched: Candidate = { ...cand, probed };

    // e) 假无损：**先于复筛**判定。原因：`meetsFloor` 内部也含假无损检查（会把它归成
    //    BELOW_BAR）；这里显式先判，才能给出更精确的 FAKE_LOSSLESS 错误码（UI 上不误导）。
    if (cfg.quality.rejectFakeLossless) {
      const fake = isFakeLossless(enriched, cfg.quality);
      if (fake.fake) {
        cleanup();
        return { kind: "fail", code: "FAKE_LOSSLESS", detail: fake.reason };
      }
    }

    // f) 用探针值复筛。
    const floor = meetsFloor(enriched, cfg.quality, { durationSec: t.durationSec });
    if (!floor.ok) {
      cleanup();
      return { kind: "fail", code: "BELOW_BAR", detail: floor.reason };
    }

    // g) 完整歌曲守卫：时长必须拿得到，且（给了目标时长时）在容差内。
    const pd = probed.durationSec;
    if (!(typeof pd === "number" && pd > 0)) {
      cleanup();
      return { kind: "fail", code: "INTEGRITY_FAILED", detail: "探针拿不到时长，疑为试听片段" };
    }
    if (t.durationSec && t.durationSec > 0 && Math.abs(pd - t.durationSec) > cfg.quality.durationToleranceSec) {
      cleanup();
      return {
        kind: "fail",
        code: "INTEGRITY_FAILED",
        detail: `时长 ${pd.toFixed(1)}s 与目标 ${t.durationSec}s 偏差超容差 ${cfg.quality.durationToleranceSec}s`,
      };
    }

    // h) 写标签（含增值项：风格 / 歌词 / 封面）。
    const title = t.title || cand.title || "Unknown Title";
    const artist = t.artist || cand.artist;
    const album = t.album || cand.album;
    const tags: SongTags = {
      title,
      artist,
      album,
      albumArtist: artist,
      track: cand.track,
      disc: cand.disc,
      year: cand.year,
    };
    if (cfg.writeSourceComment) {
      tags.comment = `来源:${cand.platform || cand.pluginId} 声明音质:${describeQuality(cand.declared)} 取链时间:${new Date().toISOString()}`;
    }
    // 增值项采集：风格 / 歌词 / 封面。整体 try 兜底，异常只告警（绝不让整首歌失败）。
    try {
      Object.assign(tags, await collectExtraTags(t, cand, { title, artist, album }));
    } catch (e) {
      warnings.push(`增值标签采集异常(忽略): ${msgOf(e)}`);
    }
    try {
      const tr = await deps.writeTags(cachePath, tags);
      if (tr.warnings && tr.warnings.length > 0) warnings.push(...tr.warnings);
      if (tr.file) cachePath = tr.file;
    } catch (e) {
      cleanup();
      return { kind: "fail", code: codeOf(e, "TAG_FAILED"), detail: msgOf(e) };
    }

    // i) 转码（增值项：失败不致命，删失败产物、保留已写标签的源文件继续落盘）。
    //    注：TranscodeOptions 无 bitDepth 字段，故把 cfg.transcodeBitDepth 映射为
    //    keepBitDepth16（24bit → false，其余 → true），语义等价。
    //    响度归一化（-14 LUFS）也在此透传，缺省开（见 FetchConfig）。
    if (cfg.transcodeEnabled) {
      try {
        const tr = await deps.transcodeFile(cachePath, {
          target: cfg.transcodeTarget,
          sampleRateHz: cfg.transcodeSampleRateHz,
          keepTags: true,
          keepBitDepth16: cfg.transcodeBitDepth !== 24,
          loudnessNormalize: cfg.transcodeLoudnessNormalize,
          loudnessTargetLufs: cfg.transcodeLoudnessTargetLufs,
          loudnessTwoPass: cfg.transcodeLoudnessTwoPass,
        });
        if (tr.dstPath && tr.dstPath !== cachePath) cachePath = tr.dstPath;
      } catch (e) {
        warnings.push(`转码失败(TRANSCODE_FAILED，保留已写标签源文件继续落盘): ${msgOf(e)}`);
      }
    }

    // j) 原子落盘。
    let newIsBetter = false;
    if (existing) {
      newIsBetter = shouldUpgrade(
        {
          tier: classifyTier({ container: existing.suffix, bitrateKbps: existing.bitRate }),
          bitrateKbps: existing.bitRate || undefined,
        },
        { tier: tierOf(enriched), bitrateKbps: probed.bitrateKbps },
        { upgradeCrossTierOnly: true, upgradeMinStepKbps: 64 },
      );
    }
    let fr: FinalizeResult;
    try {
      fr = deps.finalizeFile({
        cachePath,
        target: {
          title,
          artist,
          album,
          track: cand.track,
          disc: cand.disc,
          year: cand.year,
        },
        probed,
        config: cfg,
        newIsBetter,
        source: cand.platform,
      });
    } catch (e) {
      // 落盘失败：不删缓存（便于排障），换候选。
      return { kind: "fail", code: codeOf(e, "MOVE_FAILED"), detail: msgOf(e) };
    }
    if (fr.action === "skip" || fr.action === "keep") return { kind: "keep" };
    if (!fr.finalPath) {
      return { kind: "fail", code: "MOVE_FAILED", detail: "finalize 未返回 finalPath" };
    }
    return { kind: "success", cachePath, bytes: dl.bytes, finalPath: fr.finalPath };
  }
}
