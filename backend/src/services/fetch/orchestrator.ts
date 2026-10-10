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
import { mkdtempSync, readFileSync, renameSync, rmSync, statSync } from "node:fs";
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
  effectiveBitrateKbps,
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
import {
  disposeOriginalFile,
  LOSSLESS_COMPRESSED_CONTAINERS,
  LOSSLESS_UNCOMPRESSED_CONTAINERS,
  migrateUpgradedSong,
} from "./upgrade.js";
import { canWriteDir, ensureWritableDir } from "./writable.js";
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
  /** 洗版审计：命中更好音质后对原低码率文件的处置结果。 */
  replaced?: { originalPath: string; newPath: string; action: string; deleted?: boolean; movedTo?: string };
  /** 原地替换（洗版：假无损但高于原件）：新文件落在原媒体源目录，按原 sourceId 入库。 */
  inPlace?: { fsPath: string; sourceId: string };
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
  /** 覆盖成品落盘根（洗版用 /MUSIC/LOSSLESS）；同时决定 ensureDownloadSource 建哪个源。 */
  downloadRootOverride?: string;
  /** 落盘并入库成功后对原文件的处置（洗版用）；省略 = 不处置。 */
  originalDisposal?: { action: "keep" | "move" | "delete"; backupDir?: string; allowedRoots: string[] };
  /**
   * 全库下载模式：只把旧行（web 行）改指新本地文件（保住 id/歌单引用），**不删任何文件**。
   * 与 `originalDisposal` 互斥使用；两者都缺省 → 不做迁移。
   */
  migrateRowOnly?: boolean;
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

/**
 * 从 target.sourceData 里取原路径与原 songId（两处来源，语义不同）：
 *   - `upgrade`（洗版）：原低码率文件路径 + 旧行 id；
 *   - `library`（全库下载）：原 `web` 行 id（path 仅作审计，migrateRowOnly 下不删文件）。
 * 都没有 → 返回空。
 */
function upgradeMetaOf(t: FetchTarget | undefined): {
  originalPath?: string;
  oldSongId?: string;
  /** 原件基准有效码率（buildUpgradeTargets 里用 upgradeBaselineKbps 按 size/duration 预算好）。 */
  baselineKbps?: number;
  /** 库行 path 剥出的原媒体源 id（`l:<sid>:<fs>` 前缀段）。 */
  originalSourceId?: string;
  /** 库行 path 剥出的真实 fs 路径。 */
  originalFsPath?: string;
} {
  const raw = t?.sourceData;
  if (!raw) return {};
  try {
    const obj = JSON.parse(raw) as {
      upgrade?: { path?: unknown; songId?: unknown; bitRate?: unknown };
      library?: { path?: unknown; songId?: unknown };
    };
    const hit = obj?.upgrade ?? obj?.library;
    if (!hit) return {};
    const originalPath = typeof hit.path === "string" && hit.path ? hit.path : undefined;
    let originalSourceId: string | undefined;
    let originalFsPath: string | undefined;
    if (originalPath) {
      const m = /^l:([^:]+):(.+)$/.exec(originalPath);
      if (m) {
        originalSourceId = m[1];
        originalFsPath = m[2];
      } else {
        originalFsPath = originalPath;
      }
    }
    const br = (hit as { bitRate?: unknown }).bitRate;
    return {
      originalPath,
      oldSongId: typeof hit.songId === "string" && hit.songId ? hit.songId : undefined,
      baselineKbps: typeof br === "number" && br > 0 ? br : undefined,
      originalSourceId,
      originalFsPath,
    };
  } catch {
    return {};
  }
}

const ALL_LOSSLESS_CONTAINERS: string[] = [...LOSSLESS_COMPRESSED_CONTAINERS, ...LOSSLESS_UNCOMPRESSED_CONTAINERS];

/**
 * 洗版「抢救候选」（PATCH14B）：全部候选被 rank 预筛拒绝时，挑出仍值得下载验证的：
 * 无损容器 +（声明码率已知时）高于原件基准。声明缺失视为未知（值得试），最终以探针裁决。
 */
function rescueCandidatesForInPlace(cands: Candidate[], t: FetchTarget): Candidate[] {
  const um = upgradeMetaOf(t);
  if (!um?.originalFsPath || !um.originalSourceId) return [];
  const baseline = um.baselineKbps ?? 0;
  if (!(baseline > 0)) return [];
  return cands.filter((c) => {
    const q = qualityOf(c);
    const cont = String(q?.container ?? "").toLowerCase();
    if (!ALL_LOSSLESS_CONTAINERS.includes(cont)) return false;
    const k = Number(q?.bitrateKbps ?? 0);
    return !(k > 0 && k <= baseline);
  });
}

/** 库行 path（`l:<sid>:<fs路径>`）→ 真实 fs 路径；无前缀原样返回。 */
function stripLibraryPathPrefix(p: string): string {
  const m = /^l:([^:]+):(.+)$/.exec(p);
  return m ? m[2] : p;
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
  | {
      kind: "success";
      cachePath: string;
      bytes: number;
      finalPath: string;
      /** 原地替换：见 tryCandidate 步骤 e。 */
      inPlace?: { fsPath: string; sourceId: string };
    }
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
  // 洗版：先把成品根覆盖成 /MUSIC/LOSSLESS，**再**做路径校验（校验必须作用在覆盖后的根上）。
  // ensureDownloadSource / scanLocalFiles 都读同一个 sourceId，覆盖后自动指向新媒体源。
  const cfgResolved = resolveFetchConfig(opts.config);
  const cfg: FetchConfig = opts.downloadRootOverride
    ? { ...cfgResolved, downloadRoot: opts.downloadRootOverride }
    : cfgResolved;
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

  // 写权限统一闸（PATCH14）：对本次运行**实际落盘**的根做预检 —— 洗版把 downloadRoot
  // 覆盖成 LOSSLESS 根后，jobRunner 的基础预检探不到它，EACCES 会漏到逐项 finalize。
  // 不可写（且自适应修复无效）→ 整任务快速失败，绝不逐项刷 EACCES。
  try {
    ensureWritableDir(cfg.downloadRoot);
    ensureWritableDir(cfg.cacheRoot);
  } catch (e) {
    throw new Error(`写目录预检失败（任务整体拒绝启动）: ${msgOf(e)}`);
  }

  const deps: FetchDeps = { ...DEFAULT_DEPS, ...(opts.deps ?? {}) };
  const signal = opts.signal;
  const dryRun = !!opts.dryRun;
  // 洗版模式（config_json.__upgrade 必带 originalDisposal）：启用「假无损原地替换」分支。
  const upgradeMode = !!opts.originalDisposal;

  // sourceId：未给时确保下载源存在。
  let sourceId = opts.sourceId ?? "";
  if (!sourceId) {
    const r = deps.ensureDownloadSource(
      cfg.downloadRoot,
      cfg.downloadRoot === cfg.losslessRoot ? "已下载无损音质" : "已下载流媒体音质",
    );
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
  const pending: Array<{
    item: FetchItemOutcome;
    finalPath: string;
    originalPath?: string;
    oldSongId?: string;
    /** 原地替换项：新文件落原媒体源目录，点名入库/迁移/处置都按原 sourceId 走。 */
    inPlace?: { fsPath: string; sourceId: string };
  }> = [];

  // 限流器：整批共用一个实例（按任务实例创建，跑完随对象 GC）。
  const global = new Semaphore(cfg.maxConcurrentDownloads);
  const hostLimiter = new HostLimiter(cfg.maxConcurrentPerHost, cfg.perHostMinIntervalMs, global);

  const flush = async (): Promise<void> => {
    if (dryRun || pending.length === 0) return;
    const batch = pending.splice(0, pending.length);
    // 分组点名入库：原地替换项落回原媒体源（文件在其目录下），其余落流水线 sourceId。
    const groups = new Map<string, typeof batch>();
    for (const p of batch) {
      const sid = p.inPlace?.sourceId || sourceId;
      const arr = groups.get(sid);
      if (arr) arr.push(p);
      else groups.set(sid, [p]);
    }
    for (const [sid, arr] of groups) {
      try {
        const res = await deps.scanLocalFiles(sid, arr.map((p) => p.finalPath), undefined, signal);
        counts.added += res.added;
        counts.updated += res.updated;
      } catch (e) {
        warnings.push(`点名入库失败: ${msgOf(e)}`);
      }
      // songId 反查（scanLocalFiles 只返回计数）：path = l:<sourceId>:<绝对路径>
      for (const p of arr) {
        try {
          const row = db
            .select({ id: songs.id })
            .from(songs)
            .where(eq(songs.path, `l:${sid}:${p.finalPath}`))
            .get();
          if (row?.id) p.item.songId = row.id;
        } catch {
          /* 反查失败不影响主流程 */
        }
      }
    }

    // 洗版：迁移库行（保住旧行 id，别让歌单/收藏变死引用）→ **成功后才**处置原件。
    // 🔴 顺序硬约束：迁移没成功就绝不允许删原件（disposeOriginalFile 另有多重安全闸）。
    // 全库下载（migrateRowOnly）：只迁移库行（web 行 → 指向新本地文件），**一个文件都不删**。
    if (!opts.originalDisposal && !opts.migrateRowOnly) return;
    for (const p of batch) {
      if (!p.originalPath || !p.oldSongId) continue;
      const mig = await migrateUpgradedSong({
        oldSongId: p.oldSongId,
        newPath: p.finalPath,
        newSourceId: p.inPlace?.sourceId || sourceId,
      });
      if (mig.warnings.length > 0) warnings.push(...mig.warnings);
      if (!mig.migrated) continue; // 迁移失败 → 保留原件，换不了就不删
      // 新行已被删除，存活的是旧行 id。
      p.item.songId = p.oldSongId;
      if (!opts.originalDisposal) {
        // 全库下载：没有原件可处置，只记审计（replaced.action = "migrate"）。
        p.item.replaced = { originalPath: p.originalPath, newPath: p.finalPath, action: "migrate" };
        continue;
      }
      // 库行 path 带 `l:<sid>:` 前缀，处置闸（allowedRoots/扩展名）要真实 fs 路径才判得准。
      const origFs = stripLibraryPathPrefix(p.originalPath);
      const disp = disposeOriginalFile({
        originalPath: origFs,
        newPath: p.finalPath,
        // 原地替换语义 = 原文件被更优版本顶替：keep 一律升级为 delete（move/keep 备份语义
        // 只适用于「迁去 LOSSLESS」；原地留下的旧文件会成为孤儿并被重扫出重复行）。
        action: p.inPlace && opts.originalDisposal.action === "keep" ? "delete" : opts.originalDisposal.action,
        backupDir: opts.originalDisposal.backupDir,
        allowedRoots: p.inPlace
          ? [...opts.originalDisposal.allowedRoots, path.dirname(origFs)]
          : opts.originalDisposal.allowedRoots,
        dryRun: false,
      });
      if (disp.warnings.length > 0) warnings.push(...disp.warnings);
      p.item.replaced = {
        originalPath: origFs,
        newPath: p.finalPath,
        action: disp.action,
        ...(disp.deleted ? { deleted: true } : {}),
        ...(disp.movedTo ? { movedTo: disp.movedTo } : {}),
      };
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
        // 洗版目标：sourceData 里的 `upgrade` 块带原路径与原 songId（见 upgrade.ts:buildUpgradeTargets）。
        const um = upgradeMetaOf(targets[i]);
        pending.push({
          item,
          finalPath: item.finalPath,
          ...(um.originalPath ? { originalPath: um.originalPath } : {}),
          ...(um.oldSongId ? { oldSongId: um.oldSongId } : {}),
          ...(item.inPlace ? { inPlace: item.inPlace } : {}),
        });
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
        trustedHosts: cfg.ssrfTrustedHosts,
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
          inspectCandidates: cfg.inspectCandidates,
          inspectTimeoutMs: cfg.inspectTimeoutMs,
          inspectTopN: cfg.inspectTopN,
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
      let eligible: Candidate[];
      if (!ranked || ranked.length === 0) {
        for (const c of cands) {
          // 与 rankCandidates 的预筛口径保持一致（tolerateUnknown）：否则「原因」会对不上。
          const r = meetsFloor(c, cfg.quality, { durationSec: t.durationSec }, { tolerateUnknown: true });
          if (!r.ok) item.rejected.push({ candidateId: c.id, reason: "BELOW_BAR", detail: r.reason });
        }
        // 洗版抢救通道（PATCH14B）：声明档全低于门槛时，「无损容器且声明码率高于原件」的
        // 候选仍值得下载验证 —— 探针实测 > 原件就原地替换（落回原目录），实测不行照旧拒绝。
        // 声明值不可信，所以只用来决定「值不值得下」，最终裁决一律以探针为准。
        const rescue = upgradeMode ? rescueCandidatesForInPlace(cands, t) : [];
        if (rescue.length === 0) {
          item.status = "failed";
          item.errorCode = "BELOW_BAR";
          item.errorMsg = "全部候选未达质量门槛";
          return item;
        }
        eligible = rescue;
      } else {
        // 5) 只下最高音质：strictBestTier 为真时只在「同档或更高档」里选。
        const bestTier = tierOf(ranked[0]);
        item.targetTier = bestTier;
        eligible = cfg.strictBestTier
          ? ranked.filter((c) => TIER_RANK[tierOf(c)] >= TIER_RANK[bestTier])
          : ranked;
      }

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
          if (outcome.inPlace) item.inPlace = outcome.inPlace;
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
            trustedHosts: cfg.ssrfTrustedHosts,
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
    // 原地替换（洗版专属，产品定调 2026-10-10）：假无损（无损容器但有效码率不足 700/1400）
    // 若有效码率仍**高于原件现有水平**，则接受 —— 落回原文件所在目录顶替原件，而不是拒之门外。
    // 只豁免假无损这一条门槛；其余复筛失败照旧拒绝。
    let inPlace: { fsPath: string; sourceId: string } | undefined;
    if (cfg.quality.rejectFakeLossless) {
      const fake = isFakeLossless(enriched, cfg.quality);
      if (fake.fake) {
        let eff = 0;
        try {
          eff = effectiveBitrateKbps(
            statSync(cachePath).size,
            typeof probed.durationSec === "number" ? probed.durationSec : 0,
          );
        } catch {
          /* stat 失败按 0 处理 → 走拒绝分支 */
        }
        const um = upgradeMode ? upgradeMetaOf(t) : undefined;
        if (
          um?.originalFsPath &&
          um.originalSourceId &&
          (um.baselineKbps ?? 0) > 0 &&
          eff > (um.baselineKbps ?? 0)
        ) {
          // 原目录写权限统一闸（PATCH14）：不可写就不接受原地替换（照旧拒绝该候选），
          // 否则下载/转码全部白做，最后在落盘一步报难懂的 EACCES。
          const destDir = path.dirname(um.originalFsPath);
          if (canWriteDir(destDir)) {
            inPlace = { fsPath: um.originalFsPath, sourceId: um.originalSourceId };
          } else {
            warnings.push(`原地替换目标目录不可写，已跳过: ${destDir}`);
          }
        }
        if (!inPlace) {
          cleanup();
          return { kind: "fail", code: "FAKE_LOSSLESS", detail: fake.reason };
        }
      }
    }

    // f) 用探针值复筛（原地替换已豁免假无损门槛；其余失败照旧）。
    const floor = meetsFloor(enriched, cfg.quality, { durationSec: t.durationSec });
    if (!floor.ok && !inPlace) {
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
    //    位深/采样率自适应跟随源（产品定调 2026-10-10）：transcodeBitDepth 缺省 "auto"
    //    （16bit 源→16、24bit 源→24）；transcodeSampleRateHz 缺省不传 = 跟随源、无上限。
    //    响度归一化（loudnorm -14 LUFS）是**强制的标准化处理**，非可选增值 —— 开启时
    //    绝不能 skip（内容要变），两遍实测失败降级单遍也绝不让整首歌失败。
    //    响度归一化（-14 LUFS）也在此透传，缺省开（见 FetchConfig）。
    if (cfg.transcodeEnabled) {
      try {
        const tr = await deps.transcodeFile(cachePath, {
          target: cfg.transcodeTarget,
          sampleRateHz: cfg.transcodeSampleRateHz, // 缺省 = 跟随源采样率（无上限）
          keepTags: true,
          bitDepth: cfg.transcodeBitDepth ?? "auto", // 缺省 = 跟随源位深
          loudnessNormalize: cfg.transcodeLoudnessNormalize,
          loudnessTargetLufs: cfg.transcodeLoudnessTargetLufs,
          loudnessTwoPass: cfg.transcodeLoudnessTwoPass,
        });
        if (tr.dstPath && tr.dstPath !== cachePath) cachePath = tr.dstPath;
        // 转码改变了容器/位深/采样率/码率：重探针刷新 probed。否则 finalize 用
        // 转码前旧探针命名（flac 成品落 .mp3 名 → 扫描器走 mp3 路径，duration/
        // bit_rate 入库垃圾值），shouldUpgrade 也用旧码率（2026-10-10 240 实测教训）。
        try {
          const p2 = await deps.probeFile(cachePath);
          probed = toCandidateQuality(p2, statSync(cachePath).size);
          enriched.probed = probed;
        } catch {
          /* 重探失败：沿用旧探针（不致命，仅命名/升级判定可能用旧值） */
        }
      } catch (e) {
        // 产品定调 2026-10-10：转码+打标是落盘的**硬前置** —— 失败不再「保留源文件
        // 继续落盘」，而是本候选判失败（换下一候选），绝不把未转码成品放进最终目录。
        cleanup();
        return { kind: "fail", code: "TRANSCODE_FAILED", detail: msgOf(e) };
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
        // 原地替换：成品直接落回原文件所在目录（文件名仍按命名模板生成）。
        ...(inPlace ? { destDirOverride: path.dirname(inPlace.fsPath) } : {}),
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
    return { kind: "success", cachePath, bytes: dl.bytes, finalPath: fr.finalPath, ...(inPlace ? { inPlace } : {}) };
  }
}
