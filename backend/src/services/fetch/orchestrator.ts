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
import { mkdtempSync, readFileSync, renameSync, rmdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { db } from "../../db/index.js";
import { songs } from "../../db/schema.js";
import { downloadToFile, probeRemoteSize, type DownloadResult } from "../../utils/httpDownload.js";
import { searchCover, searchLyrics, searchMetadata } from "../../plugins/providers.js";
import type { LyricSongInput } from "../../plugins/types.js";
import { markTagRepairDone } from "./tagRepairMarker.js";
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
import { writeTags, applyTagsVariant, type SongTags } from "./tagWriter.js";
import { transcodeFile } from "./transcode.js";
import { finalizeFile, type FinalizeResult } from "./finalize.js";
import { findExistingPlayable } from "./existing.js";
import {
  DOWNLOAD_COOLDOWN_CODE,
  downloadAttemptKeyOf,
  effectiveCooldownDays,
  isPermanentFailureCode,
  recordDownloadAttempt,
  lastDownloadAttempt,
  rollbackPermanentFailure,
  shouldSkipByCooldown,
} from "./attempts.js";
import { purgeDeadSongs, type DeadSongPurgeResult } from "./deadSongPurge.js";
import { ensureDownloadSource } from "./source.js";
import {
  buildUpgradeQuality,
  disposeOriginalFile,
  isBelowUpgradeBar,
  migrateUpgradedSong,
  pruneEmptyDirs,
} from "./upgrade.js";
import { canWriteDir, ensureWritableDir } from "./writable.js";
import { scanLocalFiles } from "../source/scanner.js";
import { resolveFetchConfig, validateFetchPaths, type FetchConfig } from "./config.js";
import { HostLimiter, Semaphore } from "./limiter.js";
import type {
  Candidate,
  CandidateQuality,
  FetchErrorCode,
  ItemStatus,
  QualityConfig,
  QualityTier,
} from "./types.js";
import { createLogger } from "../../utils/logger.js";

const log = createLogger("FETCH-ORCH");

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
  /**
   * 本次成品的实际落盘根（下载品质分流，2026-10-11）：**源本身已达标无损** → losslessRoot，
   * 否则 downloadRoot。flush 据此选对应媒体源入库（缺省 = 流水线 downloadRoot）。
   */
  destRoot?: string;
  /**
   * 下载尝试台账的稳定键（PATCH21）：库内歌 = songId，无库行退回 target.id。
   * 终态结算（死链判定 / 源故障保护回滚）靠它把 items 与台账行对上，故必须在
   * processTarget 创建 item 时就填好 —— 失败项拿不到 songId，只能靠这个键。
   */
  attemptKey?: string;
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
  /** 死链清理结果（PATCH21）：本轮把哪些网络歌移出曲库、歌单转了几条未匹配。 */
  purge?: DeadSongPurgeResult;
}

/**
 * 源整体故障保护（PATCH21）阈值：**本轮尝试数 ≥ MIN_TRIED（100）**、且「资源不存在类」
 * 失败占比 ≥ RATIO，**并且本轮一首都没成功**（done === 0），才认定「源集体挂了」而不是
 * 「这批歌都死了」，此时回滚本轮误加的永久失效计数、跳过清理。
 *
 * 判定必须覆盖**所有** A 类错误码，不能只看 NO_CANDIDATE：插件被禁用/凭据过期会刷
 * NO_CANDIDATE，而签名链路失效（取到的 URL 一用就过期）会刷一片 HTTP_404 —— 两种都是
 * 「一轮之内大批同向失败」。
 *
 * 2026-10-11 用户定调「**0/100 才判定**」：判据 = 尝试数 ≥ 100 且成功数严格为 0，两条同时满足。
 *   - 样本量门槛：尝试数必须 ≥ 100 —— 小样本（例如单片 20 首）里偶发全灭，不足以断定源挂了；
 *   - 成功率严格为 0：只要有**任何一首成功**，就证明源在工作、链路是通的，剩下的失败更
 *     可能是「这批歌本身有问题」。
 * 收紧前用过「成功率 < 20%」的宽松版：240 生产实测单轮 20 首里失败 13–16 首、A 类占比
 * 65–75%、成功率 0–16% → 仍被判定为「源故障」并回滚计数 → `fail_count` 长期停在 0/1
 * → **死链清理一次都跑不起来**（功能形同关闭）。
 *   - tried 100 / done 0  → 触发（源真的挂了）✓
 *   - tried  99 / done 0  → 不触发（样本不足，宁可多跑一轮清理）✓
 *   - tried  20 / done 0  → 不触发 ✓
 *   - tried 134 / done 83 → 不触发 ✓
 * ⚠️ `settleDeadSongs` 是**按片**调用的（默认 chunkSize=20），单片尝试数远小于 100，
 * 所以该保护在默认配置下**实际不会触发** —— 这是刻意选的「最保守」：宁可让死链清理正常
 * 生效，也不冒险在小样本上误判源故障。把 chunkSize 调到 ≥100 时保护即恢复作用。
 */
const SOURCE_OUTAGE_MIN_TRIED = 100;
const SOURCE_OUTAGE_RATIO = 0.5;

/** 测试注入点：默认用真实实现，单测里整体替换。 */
export interface FetchDeps {
  collectCandidates: typeof collectCandidates;
  downloadToFile: typeof downloadToFile;
  probeRemoteSize: typeof probeRemoteSize;
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
  /** 元数据 provider（价值增值项：一次调用补齐缺失的轨/碟/年/流派/专辑，拿不到只告警）。 */
  searchMetadata: typeof searchMetadata;
  /** 下载尝试台账（PATCH17 / 2026-10-11 定调 B）：窗口内试过即跳过，**永久失效类除外**
   *  （否则 fail_count 永远停在 1，死链清理永不生效）；终态时记录（可轮转）。 */
  shouldSkipByCooldown: typeof shouldSkipByCooldown;
  /** 最近一次尝试终态快照（2026-10-12 孤儿 done 放行判据消费；测试可桩）。 */
  lastDownloadAttempt: typeof lastDownloadAttempt;
  recordDownloadAttempt: typeof recordDownloadAttempt;
  /** 死链清理（PATCH21）：任务终态把连续永久失败的网络歌移出曲库。 */
  purgeDeadSongs: typeof purgeDeadSongs;
  /** 源整体故障保护（PATCH21）：回滚本轮误加的永久失败计数。 */
  rollbackPermanentFailure: typeof rollbackPermanentFailure;
}

const DEFAULT_DEPS: FetchDeps = {
  collectCandidates,
  downloadToFile,
  probeRemoteSize,
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
  searchMetadata,
  shouldSkipByCooldown,
  lastDownloadAttempt,
  recordDownloadAttempt,
  purgeDeadSongs,
  rollbackPermanentFailure,
};

export interface RunFetchPipelineOptions {
  targets: FetchTarget[];
  config?: Partial<FetchConfig>;
  /** 省略时内部调 ensureDownloadSource */
  sourceId?: string;
  onProgress?: (p: FetchPipelineProgress) => void;
  /**
   * PATCH17 增量落库回调：单曲终态时触发。done 项在 flush（scan/迁移/处置）完成、
   * songId 已反查后回调；failed/skipped 即时回调；cancelled 不回调（重跑要继续处理）。
   * jobs 层借此把完整 outcome 立刻写进 fetch_jobs.items_json，中断重跑按终态秒跳。
   */
  onItem?: (o: FetchItemOutcome) => void;
  signal?: AbortSignal;
  /**
   * 排空信号（drain）：「不再开始新工作、走完在途工作」用。**只**在准入处（runOne 拿到
   * targetSem 闸位后）参与判定：未开始的条目直接落 cancelled；在途下载、缓存中待转码、
   * flush 点名入库与洗版迁移/原件处置**一律只认硬 signal**，故会自然走完。
   */
  drainSignal?: AbortSignal;
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

/** 音质短描述（「声明」与「源实测」两个口径共用同一格式；写进 comment 供日后核查）。 */
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
 * 「孤儿 done」放行判据（2026-10-12，240 生产事故修复）：
 *
 * 全库/入库目标（sourceData.library）上一次下载尝试是 `done`、但歌曲行**仍在下载池里**
 * （path 既非 `l:` 本地也非 `w:` 在线）→ 台账记了成功、实体却没落地（flush 的扫描入库/
 * 行迁移丢失；240 实证：文件在磁盘、DB 无行）。此时 15 天冷却会把这首歌锁死——每批都被
 * COOLDOWN_SKIPPED，而秒跳按设计不写库冷却表，池子永远收缩不了，「待下载 N 首」常驻。
 *
 * 放行需三条同时满足：library 目标 / 上次终态 done / 行仍在池内。
 * done 已真正入库（行已是 l:）或上次是失败（照常冷却）都不放行。
 */
function libraryOrphanDone(t: FetchTarget | undefined, akey: string, deps: FetchDeps): boolean {
  if (!t?.sourceData) return false;
  let songId = "";
  try {
    const sd = JSON.parse(t.sourceData) as { library?: { songId?: unknown } };
    const sid = sd.library?.songId;
    if (typeof sid === "string" && sid) songId = sid;
  } catch {
    return false;
  }
  if (!songId || songId !== akey) return false;
  const last =
    typeof deps.lastDownloadAttempt === "function" ? deps.lastDownloadAttempt(akey) : null;
  if (!last || last.status !== "done") return false;
  try {
    const row = db.select({ path: songs.path }).from(songs).where(eq(songs.id, songId)).get();
    const p = row?.path ?? "";
    return !!p && !p.startsWith("l:") && !p.startsWith("w:");
  } catch {
    return false;
  }
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

/** 预探只看最前面一批声明码率缺失的候选，避免为整批死链付超时代价。 */
const BITRATE_PROBE_MAX = 8;
/** 单候选预探超时：体积头应秒回，6s 已非常宽裕。 */
const BITRATE_PROBE_TIMEOUT_MS = 6000;

/**
 * 直链体积预探（PATCH15）：声明 bitrateKbps 缺失的 http(s) 候选，用 HEAD/Range 拿
 * Content-Length，结合目标时长估算有效码率（体积×8/时长，与下载后探针同口径），
 * 回填 declared（标 estimated）。门槛预筛/排序/抢救通道随之按真实体积决策，
 * 「下载完才发现不达标」的带宽浪费就此消除。预探拿不到体积（null）保持原行为。
 */
async function backfillEstimatedBitrates(
  cands: Candidate[],
  t: FetchTarget,
  probe: typeof probeRemoteSize,
  trustedHosts: string[] | undefined,
): Promise<void> {
  const dur = Number(t.durationSec ?? 0);
  if (!(dur > 0)) return;
  const targets = cands
    .filter((c) => {
      if (!/^https?:\/\//i.test(c.url)) return false;
      const k = Number(c.declared?.bitrateKbps ?? 0);
      return !(k > 0);
    })
    .slice(0, BITRATE_PROBE_MAX);
  if (targets.length === 0) return;
  await Promise.all(
    targets.map(async (c) => {
      try {
        const bytes = await probe({
          url: c.url,
          headers: c.headers,
          timeoutMs: BITRATE_PROBE_TIMEOUT_MS,
          ssrfGuard: true,
          trustedHosts,
        });
        if (!bytes || !(bytes > 0)) return;
        const kbps = Math.round((bytes * 8) / dur / 1000);
        if (!(kbps > 0)) return;
        c.declared = { ...(c.declared ?? {}), bitrateKbps: kbps, estimated: true };
        log.debug("直链体积预探", { candidateId: c.id, bytes, estimatedKbps: kbps });
      } catch {
        /* 单候选预探失败不影响主流程 */
      }
    }),
  );
}

/**
 * 洗版「抢救候选」（PATCH14B）：全部候选被 rank 预筛拒绝时，挑出仍值得下载验证的：
 * 无损容器 +（声明码率已知时）高于原件基准。声明缺失视为未知（值得试），最终以探针裁决。
 */
function rescueCandidatesForInPlace(cands: Candidate[], t: FetchTarget): Candidate[] {
  const um = upgradeMetaOf(t);
  if (!um?.originalFsPath || !um.originalSourceId) return [];
  const baseline = um.baselineKbps ?? 0;
  if (!(baseline > 0)) return [];
  // 240 实测教训：桥接候选的 declared 容器来自 URL 扩展名，lx 直链常无扩展名 → 容器未知。
  // 所以只排除「确定不值得」的：已知有损容器、已知无损且声明码率不超过原件；其余（含
  // 容器/码率全未知）都值得下载验证 —— 最终裁决一律以探针为准。
  const LOSSY = new Set(["mp3", "aac", "ogg", "wma", "opus", "m4a"]);
  return cands.filter((c) => {
    const q = qualityOf(c);
    const cont = String(q?.container ?? "").toLowerCase();
    if (LOSSY.has(cont)) return false;
    const k = Number(q?.bitrateKbps ?? 0);
    if (k > 0 && k <= baseline) return false;
    return true;
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
      /** 品质分流：本次成品实际落盘根（达标无损 → losslessRoot）；见步骤 g.5。 */
      destRoot?: string;
    }
  | { kind: "keep" }
  | { kind: "cancel"; detail?: string }
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

/**
 * 下载品质分流判据（产品定调 2026-10-11）：**源音频**是否已达洗版的无损门槛。
 *
 * 直接复用洗版同一套判据（`buildUpgradeQuality` + `isBelowUpgradeBar`）：
 *   - 压缩无损容器（flac / alac / ape）≥ 700kbps；
 *   - 未压缩无损容器（wav / aiff） ≥ 1400kbps；
 *   - 有损容器（mp3 / m4a / ogg…）一律不算。
 * 码率走 `upgradeBaselineKbps`：`size/duration` 现场换算优先，平台不声明码率也能算出来。
 *
 * 🔴 判据必须取**转码前**的源探针。因为 `transcodeEnabled` 时成品会被统一转成 flac，
 * 只看最终容器无法区分「真无损」与「有损转 flac」；源容器 + 源有效码率才是真信号。
 */
function isLosslessGradeSource(q: CandidateQuality | undefined, quality: QualityConfig): boolean {
  if (!q) return false;
  const container = String(q.container ?? "").toLowerCase();
  if (!container) return false;
  return !isBelowUpgradeBar(
    { suffix: container, size: q.bytes, durationSec: q.durationSec, bitRate: q.bitrateKbps },
    buildUpgradeQuality(quality),
  ).below;
}

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
  const drainSignal = opts.drainSignal;
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

  // 下载品质分流（产品定调 2026-10-11）：源达标无损的歌**直接落 losslessRoot**，
  // 不再混进流媒体下载目录。洗版本来就把 downloadRoot 覆盖成 losslessRoot，无需再分流。
  const downloadRootAbs = path.resolve(cfg.downloadRoot);
  const losslessRootAbs = cfg.losslessRoot ? path.resolve(cfg.losslessRoot) : "";
  const losslessRoutable =
    !upgradeMode &&
    !!losslessRootAbs &&
    losslessRootAbs !== downloadRootAbs &&
    canWriteDir(cfg.losslessRoot);

  // 目标根 → 媒体源 id（懒建 + 记忆化）：入库/迁移都按成品**实际所在根**选媒体源，
  // 否则无损成品会被点进「已下载流媒体音质」源，扫描器直接找不到文件。
  const sourceIdByRoot = new Map<string, string>();
  sourceIdByRoot.set(downloadRootAbs, sourceId);
  const sourceIdForRoot = (root?: string): string => {
    const abs = root ? path.resolve(root) : downloadRootAbs;
    const hit = sourceIdByRoot.get(abs);
    if (hit) return hit;
    const r = deps.ensureDownloadSource(
      abs,
      abs === losslessRootAbs ? "已下载无损音质" : "已下载流媒体音质",
    );
    if (r.ancestorSourceId) {
      warnings.push(
        `下载目录 ${abs} 已被另一个媒体源（${r.ancestorSourceId}）覆盖，可能出现同一文件两行`,
      );
    }
    sourceIdByRoot.set(abs, r.sourceId);
    return r.sourceId;
  };

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
    if (pending.length === 0) return;
    const batch = pending.splice(0, pending.length);
    // 分组点名入库：原地替换项落回原媒体源（文件在其目录下），其余按成品**实际落盘根**
    // 选源（downloadRoot / losslessRoot 各对应一个源）。
    const groups = new Map<string, typeof batch>();
    for (const p of batch) {
      const sid = p.inPlace?.sourceId || sourceIdForRoot(p.item.destRoot);
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
    if (opts.originalDisposal || opts.migrateRowOnly) {
      for (const p of batch) {
      if (!p.originalPath || !p.oldSongId) continue;
      const mig = await migrateUpgradedSong({
        oldSongId: p.oldSongId,
        newPath: p.finalPath,
        // 全库下载迁移：新文件可能落在 losslessRoot（无损分流），媒体源要跟着走。
        newSourceId: p.inPlace?.sourceId || sourceIdForRoot(p.item.destRoot),
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
      });
      if (disp.warnings.length > 0) warnings.push(...disp.warnings);
      // 删原件成功后，递归清理遗留的空目录（专辑/歌手目录可能整条链都空了）。
      if (disp.deleted) {
        const pruned = pruneEmptyDirs(origFs, opts.originalDisposal.allowedRoots[0] || path.dirname(origFs));
        if (pruned.warnings.length > 0) warnings.push(...pruned.warnings);
      }
      p.item.replaced = {
        originalPath: origFs,
        newPath: p.finalPath,
        action: disp.action,
        ...(disp.deleted ? { deleted: true } : {}),
        ...(disp.movedTo ? { movedTo: disp.movedTo } : {}),
      };
      }
    }

    // PATCH17 增量落库回调：本批 scan/迁移/处置全部完成（songId 已反查、replaced 已定）
    // 才触发 —— jobs 层借此把完整 outcome 立刻写进 fetch_jobs.items_json。
    if (opts.onItem) {
      for (const p of batch) {
        try {
          opts.onItem(p.item);
        } catch {
          /* 增量落库失败不影响主流程（片尾还有全量落库兜底） */
        }
      }
    }
  };

  // PATCH16 目标级并行：maxConcurrentTargets 路 worker 同时推进不同歌曲的流水线。
  // 网络总闸仍是 global（maxConcurrentDownloads）+ HostLimiter（单站并发 + 最小间隔），
  // 并行只提高「等待重叠度」（插件取链 / 预探 / 转码 / 完整性校验期间别的歌继续跑），
  // 不放大对音源的网络压力。pending/flush 与 counts 变更经调度链串行化，避免并发写竞态。
  //
  // ⚠️ PATCH20（2026-10-11 提速）：上限从 8 提到 64 并**在前端暴露**。原先这里硬夹 8、
  // 且该键从未出现在配置界面，于是「最大并发下载数 / 单站点最大并发」设成 16 也永远吃不满
  // ——全库下载与洗版都是**单个**任务，任务内并发就是这两档的真正天花板（240 实测：8 核
  // load 仅 2.0，ffmpeg 只有 1 个进程，纯属并发被饿死，不是 CPU 瓶颈）。
  // 语义定调：目标级并发 ≥ 下载总闸，否则总闸形同虚设。
  const par = Math.max(1, Math.min(64, Math.floor(Number(cfg.maxConcurrentTargets) || 1)));
  const targetSem = new Semaphore(par);
  // PATCH22 转码总闸：同一时刻最多 N 首歌在跑 ffmpeg 转码（默认 4，1..16），超出 FIFO 排队。
  // 转码是 CPU 重活，目标级并行只放大「流水线重叠度」却会放大 ffmpeg 进程数 —— 单独钳住。
  const transcodeSem = new Semaphore(
    Math.max(1, Math.min(16, Math.floor(Number(cfg.maxConcurrentTranscodes) || 4))),
  );
  const batchId = randomUUID();
  let flushChain: Promise<void> = Promise.resolve();
  const scheduleFlush = (): void => {
    flushChain = flushChain.then(() => flush()).catch(() => undefined);
  };
  const cancelledOutcome = (t: FetchTarget | undefined, i: number): FetchItemOutcome => ({
    targetId: t?.id ?? `target-${i}`,
    status: "cancelled",
    attempts: 0,
    rejected: [],
    errorMsg: "任务已取消",
  });

  try {
    const runOne = async (t: FetchTarget, i: number): Promise<void> => {
      // 排队期间被取消（acquire 抛 AbortError）→ 按 cancelled 收尾，与串行版语义一致。
      const release = await targetSem.acquire(signal).catch(() => null);
      if (!release) {
        items[i] = cancelledOutcome(t, i);
        emitProgress(opts.onProgress, items[i]!, i, targets.length);
        return;
      }
      try {
        // 准入闸：拿到 targetSem 闸位即「将被开始」。硬 abort 或 drain 命中 → 直接
        // cancelled（drain 未开始的条目不启动；已在途的条目此前已越过这道闸，不受影响）。
        if (signal?.aborted || drainSignal?.aborted) {
          items[i] = cancelledOutcome(t, i);
          emitProgress(opts.onProgress, items[i]!, i, targets.length);
          return;
        }
        const item = await processTarget(t, i);
        items[i] = item;
        if (item.status === "done") counts.done++;
        else if (item.status === "failed") counts.failed++;
        else if (item.status === "skipped") counts.skipped++;
        if (item.bytes) counts.bytes += item.bytes;

        // 台账记录（PATCH17）：只记跑完的终态（done/failed）。中断（cancelled）与快速
        // 路径（skipped）不记 —— 前者重跑要继续处理，后者记了只会把冷却起点后推。
        // 洗版走自己的冷却（fetch_upgrade_attempts），这里不记。
        if (!opts.originalDisposal && (item.status === "done" || item.status === "failed")) {
          try {
            deps.recordDownloadAttempt(
              downloadAttemptKeyOf(t),
              batchId,
              item.status,
              effectiveCooldownDays(cfg),
              {
                errorCode: item.errorCode,
                // 只有「资源不存在类」才累计永久失效计数（见 attempts.PERMANENT_FAILURE_CODES）。
                permanent: item.status === "failed" && isPermanentFailureCode(item.errorCode),
              },
            );
          } catch (e) {
            warnings.push(`尝试台账记录失败(忽略): ${msgOf(e)}`);
          }
        }

        // PATCH17 增量落库：failed/skipped 即时回调（无 scan 依赖）；done 项等 flush
        // 反查 songId 后再回调（见 flush 内 onItem），保证重跑时可直接按终态跳过。
        if (opts.onItem && (item.status === "failed" || item.status === "skipped")) {
          try {
            opts.onItem(item);
          } catch {
            /* 兜底在片尾全量落库 */
          }
        }

        if (item.status === "done" && item.finalPath) {
          // 洗版目标：sourceData 里的 `upgrade` 块带原路径与原 songId（见 upgrade.ts:buildUpgradeTargets）。
          const um = upgradeMetaOf(t);
          pending.push({
            item,
            finalPath: item.finalPath,
            ...(um.originalPath ? { originalPath: um.originalPath } : {}),
            ...(um.oldSongId ? { oldSongId: um.oldSongId } : {}),
            ...(item.inPlace ? { inPlace: item.inPlace } : {}),
          });
          if (pending.length >= cfg.scanBatchSize) scheduleFlush();
        }

        emitProgress(opts.onProgress, item, i, targets.length);
      } finally {
        release();
      }
    };

    await Promise.all(targets.map(runOne));
  } finally {
    // 收尾必 flush 一次（否则最后不足一批的不入库）；末次 flush 的错误照常上抛。
    flushChain = flushChain.then(() => flush());
    await flushChain;
  }

  // ==================== 终态结算：源故障保护 + 死链清理（PATCH21） ====================
  const purge = settleDeadSongs(opts, items, warnings);

  return { sourceId, items, counts, warnings, purge };

  /**
   * 终态结算（PATCH21）。放在整轮任务跑完、台账已写全之后做，**不进逐条热路径**
   * （删库是不可逆动作，不该和下载混在一起）。
   *
   *   ① 源整体故障保护：本轮失败数够多、且 NO_CANDIDATE 占比过半 → 认定「源集体挂了」
   *      而不是「这批歌都死了」，回滚本轮误加的永久失效计数，并跳过本轮的清理。
   *      没有这层，插件被禁用 / 凭据过期一次就能把大批歌判死清出曲库。
   *   ② 死链清理：把台账里连续永久失败达阈值的**网络歌**移出曲库，引用它的歌单条目
   *      转成未匹配（保留外部元数据快照，之后可用「一键在线匹配」拉回来）。
   *
   * 洗版（originalDisposal）不参与：它不是入库流程，且本地文件还在，删歌是错的。
   */
  function settleDeadSongs(
    ropts: RunFetchPipelineOptions,
    outs: FetchItemOutcome[],
    warns: string[],
  ): DeadSongPurgeResult | undefined {
    if (ropts.originalDisposal) return undefined;

    const failed = outs.filter((i) => i.status === "failed");
    const fatal = failed.filter((i) => isPermanentFailureCode(i.errorCode));
    const done = outs.filter((i) => i.status === "done").length;
    const tried = done + failed.length;
    // 🔴 「0/100 才判定」（用户定调 2026-10-11）：必须**尝试 ≥100 首**且**一首都没成功**，
    // 才认定为源整体故障；两者缺一不可（小样本不判、有成功就不判）。
    if (
      tried >= SOURCE_OUTAGE_MIN_TRIED &&
      done === 0 &&
      fatal.length / failed.length >= SOURCE_OUTAGE_RATIO
    ) {
      for (const it of fatal) {
        if (!it.attemptKey) continue;
        try {
          deps.rollbackPermanentFailure(it.attemptKey);
        } catch (e) {
          warns.push(`源故障保护回滚失败(忽略): ${msgOf(e)}`);
        }
      }
      // 必须落日志：warnings 数组不会落库也不会落日志，只 push 等于「静默跳过清理」，
      // 运维侧完全看不到这次清理为什么没发生（2026-10-11 生产实测发现）。
      const note =
        `本次「资源不存在类」失败占 ${fatal.length}/${failed.length}（${Math.round(
          (fatal.length / failed.length) * 100,
        )}%），且本轮 ${tried} 首里一首都没成功（0/${tried}）→ 疑为源整体故障（插件停用 / 凭据过期 / 签名链路失效）：已回滚本轮永久失效计数并跳过死链清理`;
      warns.push(note);
      log.warn(note);
      return undefined;
    }

    try {
      const res = deps.purgeDeadSongs(cfg);
      if (res && res.purged > 0) {
        const note = `死链清理：移除 ${res.purged} 首永久失效的网络歌（歌单转未匹配 ${res.playlistEntries} 条）`;
        warns.push(note);
        log.info(note);
      }
      return res;
    } catch (e) {
      const note = `死链清理失败(忽略): ${msgOf(e)}`;
      warns.push(note);
      log.warn(note);
      return undefined;
    }
  }

  // ==================== 单曲流水线（闭包） ====================

  /**
   * 采集「增值标签」：风格（信源声明） / 歌词 / 封面 / 元数据补全。
   *
   * 纪律：**这些都是价值增值项，任一失败只 push warning，绝不上抛**（否则一首歌的
   * 歌词服务抖动就会毁掉整次下载）。风格只认信源声明值（不臆造）；封面优先用候选自带的
   * `coverUrl`，缺了才回落 `searchCover` provider；最后用 `searchMetadata` **只补缺失项**
   * （轨/碟/年/流派/专辑），信源声明值优先。
   * 另返回 `builtinSrc`：若上述增值标签来自**内置标签来源插件**（manifest.
   * builtinTagSource），记录该 provider id，供落盘后写「标签修复完成标记」。
   */
  async function collectExtraTags(
    t: FetchTarget,
    cand: Candidate,
    base: { title: string; artist?: string; album?: string },
  ): Promise<{ extra: Partial<SongTags>; builtinSrc: string | null }> {
    const extra: Partial<SongTags> = {};

    // 记录「谁打上的标签」：只有**内置标签来源插件**（manifest.builtinTagSource）命中才记，
    // 供落盘后写「标签修复完成标记」用；外置插件命中一律不记（产品定调 2026-10-16）。
    let builtinSrc: string | null = null;
    const onMatch = (providerId: string, builtin: boolean): void => {
      if (builtin && !builtinSrc) builtinSrc = providerId;
    };

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
      const lyric = await withTimeout(deps.searchLyrics(songInput, { onMatch }), ENRICH_TIMEOUT_MS);
      if (lyric && lyric.trim()) extra.lyric = lyric;
    } catch (e) {
      warnings.push(`歌词获取失败(忽略，不影响入库): ${msgOf(e)}`);
    }

    // 封面：优先候选自带；回落 provider；再下载成 Buffer 交给 tagWriter（由它落临时图）。
    if (cfg.embedCover) {
      try {
        let coverUrl = cand.coverUrl;
        if (!coverUrl) {
          const u = await withTimeout(deps.searchCover(songInput, { onMatch }), ENRICH_TIMEOUT_MS);
          if (u) coverUrl = u;
        }
        if (coverUrl) {
          const buf = await fetchCoverBuffer(coverUrl);
          if (buf) extra.cover = buf;
        }
      } catch (e) {
        warnings.push(`封面获取失败(忽略，不影响入库): ${msgOf(e)}`);
      }
      // 观测补强（2026-10-11）：静默空结果也要可见——enrich 拿不到封面（候选无
      // coverUrl 且 provider 返 null）时打点，任务终态后由 tagRepair 队列兜底重试。
      if (!extra.cover) {
        warnings.push("封面未获取到(不影响入库，已入修复队列待重试)");
      }
    }

    // 元数据补全：一次调用补齐缺失的轨/年/流派/专辑；只补缺失项，信源声明值优先。
    // 碟号（disc）**一律不采集不写入**：成品文件不留 DISCNUMBER/DISCTOTAL（见 tagWriter 文件头【碟号纪律】）。
    try {
      const meta = await withTimeout(deps.searchMetadata(songInput, { onMatch }), ENRICH_TIMEOUT_MS);
      if (meta) {
        if (!cand.track && meta.track) extra.track = meta.track;
        if (meta.trackTotal) extra.trackTotal = meta.trackTotal;
        if (!cand.year && meta.year !== undefined && meta.year !== null) extra.year = meta.year;
        if (!cand.genre && meta.genre) extra.genre = meta.genre;
        if (!base.album && meta.album) extra.album = meta.album;
      }
    } catch (e) {
      warnings.push(`标签补全失败(忽略，不影响入库): ${msgOf(e)}`);
    }

    return { extra, builtinSrc };
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
      attemptKey: t ? downloadAttemptKeyOf(t) : undefined,
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

      // 2.5) 台账冷却（PATCH17；2026-10-11 定调 B）：窗口内试过 → 秒跳，不取链不预探不下载。
      //      断点重跑 / 反复触发不再从头重试同一批失败项。
      //      🔴 B 的例外：**永久失效类不进冷却**（判据封在 shouldSkipByCooldown 里）——
      //      资源不存在类（404/410/451/NO_CANDIDATE/INTEGRITY_FAILED）不会自愈，必须每轮
      //      重试才能把 fail_count 累积到 deadSongPurgeThreshold；否则冷却 30 天 > 自动间隔
      //      15 天 → 永远只失败一次 → 死链清理一次都跑不起来（240 实测 fail_count>=2 恒 0）。
      //      洗版有自己的冷却（upgradeCooldownDays / fetch_upgrade_attempts），这里不重复管。
      if (!opts.originalDisposal) {
        const cooldownDays = effectiveCooldownDays(cfg);
        const akey = downloadAttemptKeyOf(t);
        if (
          cooldownDays > 0 &&
          deps.shouldSkipByCooldown(akey, cooldownDays) &&
          !libraryOrphanDone(t, akey, deps)
        ) {
          item.status = "skipped";
          item.errorCode = DOWNLOAD_COOLDOWN_CODE;
          item.errorMsg = `冷却期内已尝试过（${cooldownDays} 天窗口，非永久失效类），跳过`;
          return item;
        }
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

      // 3.5) 直链体积预探（PATCH15）：lx 等源脚本只回 URL、不带码率/体积元数据；声明缺失时
      // HEAD/Range 拿 Content-Length 估算有效码率回填 declared（失败保持原行为）。
      try {
        await backfillEstimatedBitrates(cands, t, deps.probeRemoteSize, cfg.ssrfTrustedHosts);
      } catch {
        /* 预探只是优化，绝不阻断主流程 */
      }

      // 3.6) 【已移除】预探估算「假无损」预拒（原 PATCH15）。
      // 产品定调 2026-10-11：「flac 只是容器，不代表无损」「没下载过的歌即便是假无损也该
      // 落流媒体目录」。假无损的取舍改由**真实探针**在下载后按 `classifyTier` 归到有损档：
      //   - 下载档 qualityFloor=any 放行 → 按品质分流落 DOWNLOAD（步骤 g.5）；
      //   - 洗版档 qualityFloor=lossless 自然被门槛挡下（另有高于原件的原地替换通道）。
      // 故此处不再按估算值预拒，避免把「该落流媒体目录的假无损」整次下载省掉。

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

      // 6) 逐候选尝试（eligible 串行）。
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
          if (outcome.destRoot) item.destRoot = outcome.destRoot;
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
        if (outcome.kind === "cancel") {
          // 单个候选在处理途中被取消（典型：排队等转码闸时 hard abort）。整曲落 cancelled
          // 终态，不再换下一候选、不记为失败。
          item.status = "cancelled";
          item.errorMsg = outcome.detail ?? "任务已取消";
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
    /** 兜底 rmdir 本候选专属缓存目录（仅当已空）：避免在 cacheRoot 留下成千上万个空目录
     *  （240 实测 7319 个目录中 4238 个空）。目录非空（如 transcodeKeepOriginal 保留源）或
     *  已不存在时 rmdir 抛错，忽略即可。 */
    const pruneCacheDir = (): void => {
      try {
        rmdirSync(dir);
      } catch {
        /* 目录非空或已不存在：忽略 */
      }
    };
    const cleanup = (): void => {
      for (const p of [partPath, cachePath]) {
        try {
          rmSync(p, { force: true });
        } catch {
          /* 清理失败不影响主流程 */
        }
      }
      pruneCacheDir();
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
      // 转码常开时「全解码」档自动降级 probe：转码本身就是一次完整解码（文件烂了转码
      // 自己会失败），再做全解码纯属重复花销；probe 档的时长对比零额外成本（探针本来
      // 就要做）。产品定调 2026-10-10：完整性只对时长，不花多余钱。
      const effIntegrityLevel: typeof cfg.integrityLevel =
        cfg.transcodeEnabled && cfg.integrityLevel === "decodable" ? "probe" : cfg.integrityLevel;
      const ir = await deps.verifyIntegrity(
        {
          file: cachePath,
          // 断点续传（dl.partial）时 `dl.sha256` 只覆盖**本次新收的字节**（pumpToFile 每片新建
          // hash，见 httpDownload.ts），拿它去比对整文件哈希必然不符 → INTEGRITY_FAILED（永久失效，
          // 连败还会触发 deadSongPurge 删歌）。故 partial 时**不传 sha256**，让完整性校验跳过哈希、
          // 只比字节数/时长（integrity.ts 对缺省 sha256 已支持）。2026-10-16 修正。
          expect: {
            bytes: dl.bytes,
            sha256: dl.partial ? undefined : dl.sha256,
            durationSec: t.durationSec,
          },
        },
        effIntegrityLevel,
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

    // e) 假无损（**洗版专属**）：**先于复筛**判定，好在 UI 上给出更精确的 FAKE_LOSSLESS 错误码。
    //    原地替换（产品定调 2026-10-10）：假无损（无损容器但有效码率不足 700/1400）
    //    若有效码率仍**高于原件现有水平**，则接受 —— 落回原文件所在目录顶替原件，而不是拒之门外。
    //    只豁免假无损这一条门槛；其余复筛失败照旧拒绝。
    //
    //    下载/全库/搜索任务（非洗版）**不走此闸**：它们没有「原件」可比，假无损不再被单独拒，
    //    而是照「flac 只是容器」原则按真实有效码率归到有损档（classifyTier），最终由步骤 g.5
    //    按品质分流落流媒体目录。这正是「没下载过的歌即便是假无损也该落流媒体目录」的产品意图。
    let inPlace: { fsPath: string; sourceId: string } | undefined;
    if (upgradeMode) {
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
        const um = upgradeMetaOf(t);
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
      // 拿不到时长 = **无法证明是完整曲目**（部分 Ogg/Opus 容器根本不写时长），
      // 用 DURATION_UNKNOWN（非永久）：既有的 INTEGRITY_FAILED 在永久失效白名单里，
      // 会把这种「歌还在、只是元数据缺时长」的条目算成死链（同 DURATION_MISMATCH 的坑）。
      return { kind: "fail", code: "DURATION_UNKNOWN", detail: "探针拿不到时长，无法确认是完整曲目（可能是片段）" };
    }
    if (t.durationSec && t.durationSec > 0 && Math.abs(pd - t.durationSec) > cfg.quality.durationToleranceSec) {
      cleanup();
      // 必须用 DURATION_MISMATCH，**不能**沿用 INTEGRITY_FAILED：后者在
      // PERMANENT_FAILURE_CODES 白名单里（见 attempts.ts），而「时长对不上」只说明
      // 拿到的是另一个版本，文件本身完整、歌也还能在线播放。误用会把这种歌判成死链
      // 移出曲库（2026-10-11 生产实测）。
      return {
        kind: "fail",
        code: "DURATION_MISMATCH",
        detail: `时长 ${pd.toFixed(1)}s 与目标 ${t.durationSec}s 偏差超容差 ${cfg.quality.durationToleranceSec}s`,
      };
    }

    // g.5) 下载品质分流（产品定调 2026-10-11）：用**转码前**的源探针判定 —— 源本身
    //      达标无损（复用洗版同一门槛）则成品直接落 losslessRoot，不再混进流媒体下载目录。
    //      原地替换（inPlace）语义更强，优先，不受本项影响。
    const losslessGrade = losslessRoutable && isLosslessGradeSource(probed, cfg.quality);

    // h) 写标签（含增值项：风格 / 歌词 / 封面）。
    //    title/artist/album 用 let：下方中文字形转换会回写它们，保证**文件名与内嵌标签
    //    一致**（否则会出现「文件名是繁体、标签已转简体」的割裂）。
    let title = t.title || cand.title || "Unknown Title";
    let artist = t.artist || cand.artist;
    let album = t.album || cand.album;
    const tags: SongTags = {
      title,
      artist,
      album,
      albumArtist: artist,
      track: cand.track,
      year: cand.year,
    };
    if (cfg.writeSourceComment) {
      // 双口径（2026-10-19 产品调定）：comment 不写「声明」一个口径，而是**声明 + 源实测**两个口径。
      // 起因（240 实测）：酷狗把无损源**声明**成 mp3/128（extra 音质阶梯虚标），下载后内容嗅探
      // 判定 flac、有效码率 817，按「源达标无损」正确落进 losslessRoot；而 comment 只有声明值，
      // 于是「日志写 128K、文件却在无损目录」看起来像 bug。声明值回答「平台说给了什么」，
      // 源实测值回答「我们实际拿到什么」，两者并列即自证分流依据。
      // 口径说明：源实测 = 下载到的**源文件**探针（`probed`，与品质分流判据 isLosslessGradeSource
      // 同一份）。**不**在转码后二次调用 writeTags 写「成品口径」——那会多一次 ffmpeg 写标签、
      // 多一条 TAG_FAILED 失败路径，而转码只是换封装/响度归一、不改「源站到底给了什么」。
      tags.comment = `来源:${cand.platform || cand.pluginId} 声明音质:${describeQuality(cand.declared)} 源实测音质:${describeQuality(probed)} 取链时间:${new Date().toISOString()}`;
    }
    // 增值项采集：风格 / 歌词 / 封面。整体 try 兜底，异常只告警（绝不让整首歌失败）。
    let builtinTagSrc: string | null = null;
    try {
      const extra = await collectExtraTags(t, cand, { title, artist, album });
      Object.assign(tags, extra.extra);
      builtinTagSrc = extra.builtinSrc;
    } catch (e) {
      warnings.push(`增值标签采集异常(忽略): ${msgOf(e)}`);
    }
    // h.1) 中文字形（产品定调 2026-10-16）：**所有 provider 提供的文本**（含上面采到的
    //      歌词/风格/专辑）一律按用户所选字形输出，默认简体。命中匹配已在上一步完成，
    //      故这里转换不影响「用源文本去平台比对」。转换后就地回写命名变量。
    applyTagsVariant(tags, cfg.chineseVariant);
    title = tags.title ?? title;
    artist = tags.artist ?? artist;
    album = tags.album ?? album;
    try {
      // keepSourceCover：本次没采到新封面时，若用户要求内嵌封面（embedCover=true）则保留
      // 源文件已有封面（避免「源里有图、provider 取图失败 → 成品反而没图」）；
      // embedCover=false 明确不保留（尊重用户关闭意图）。
      const tr = await deps.writeTags(cachePath, tags, { keepSourceCover: cfg.embedCover !== false });
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
      // 转码前源路径快照：产物换路径后，源文件若留在 cacheRoot 会永久泄漏（240 实测
      // 13.9G / 3002 个 mp3 残留）。见下方 dstPath 变化处的清理逻辑。
      const srcPreTranscode = cachePath;
      // PATCH22 转码总闸（maxConcurrentTranscodes）：拿到闸位才开始转码，超出的歌 FIFO
      // 排队。下载任务与洗版任务走同一条流水线，一个闸两类都覆盖。等待超 2s 记日志，
      // 便于判断是否要调大上限。finally 保证成功/失败/取消三条路都释放闸位。
      const transcodeWaitStart = Date.now();
      let releaseTranscode: () => void;
      try {
        releaseTranscode = await transcodeSem.acquire(signal);
      } catch (e) {
        // 排队等转码闸时任务被取消 / 完全停止（acquire 以 AbortError reject）。
        // 原实现把 acquire 放在 try/finally 之外，该 reject 会冒到 processTarget 的整曲兜底
        // → 本项被误记 failed、且 **cleanup()/pruneCacheDir 未跑** → 已下载/已打标的缓存产物
        // 永久残留在 cacheRoot（v4.6.22 刚要消灭的残留复现）+ 误记冷却。此处归约为「取消」：
        // 清掉本候选缓存目录、让上层落 cancelled 终态，不误记失败。2026-10-16 修正。
        cleanup();
        return { kind: "cancel", detail: msgOf(e) };
      }
      const transcodeWaitMs = Date.now() - transcodeWaitStart;
      if (transcodeWaitMs > 2000) {
        log.info("转码闸排队等待", { waitMs: transcodeWaitMs, limit: cfg.maxConcurrentTranscodes });
      }
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
        // 转码成功 → 清理缓存中的源文件：产物已替代源（dstPath ≠ 源路径 = 真发生了换封装），
        // 源若留在 cacheRoot 将永久泄漏（每首一个残留，240 实测 13.9G / 3002 个 mp3）。
        // 两种情形**不得删**：① skipped 或原地转码 —— 此时 dstPath 恒等于源路径（见
        // transcode.ts 的 skip 分支），那 dstPath 就是产物本身；② transcodeKeepOriginal
        // —— 该开关语义即「保留源文件在缓存目录」（不删除、也不进入音乐库）。
        if (tr.dstPath !== srcPreTranscode && !cfg.transcodeKeepOriginal) {
          try {
            rmSync(srcPreTranscode, { force: true });
          } catch {
            /* 清理失败不影响主流程（转码产物已就绪） */
          }
        }
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
      } finally {
        releaseTranscode();
      }
    }

    // j) 原子落盘。
    let newIsBetter = false;
    if (existing) {
      // 既有侧的有效码率必须按 `size/duration` 现场换算（effectiveBitrateKbps），**不能**直接用
      // 库内 `bit_rate` 列 —— 240 实测库内 flac 的 bit_rate 基本是垃圾（≈真值/202），直接信它
      // 会把「已有好无损」误判成 unknown/低档，导致新的（更差的）lossless 跨档通过、即便
      // fileConflictPolicy=keepBetter 也照样 write → 用更差新文件覆盖/顶替已有更好文件且旧文件被删
      // （音质回退 + 数据丢失）。bit_rate 仅作换算不出时的回落。2026-10-16 修正。
      const effBitrate = effectiveBitrateKbps(
        Number(existing.size ?? 0),
        Number(existing.durationSec ?? 0),
      );
      const existingKbps = effBitrate > 0 ? effBitrate : existing.bitRate || 0;
      newIsBetter = shouldUpgrade(
        {
          tier: classifyTier({ container: existing.suffix, bitrateKbps: existingKbps || undefined }),
          bitrateKbps: existingKbps || undefined,
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
        // 品质分流：源达标无损 → 落 losslessRoot（保留命名模板的相对目录结构）。
        ...(!inPlace && losslessGrade && cfg.losslessRoot ? { destRootOverride: cfg.losslessRoot } : {}),
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
    if (fr.action === "skip" || fr.action === "keep") {
      // 本次产物未被采纳（skip：已有同款/更好；keep：按策略保留现状）→ 缓存里的产物必须
      // 清掉（此时 cachePath 就是转码产物），否则同样在 cacheRoot 残留。
      cleanup();
      return { kind: "keep" };
    }
    if (!fr.finalPath) {
      return { kind: "fail", code: "MOVE_FAILED", detail: "finalize 未返回 finalPath" };
    }
    // 成品已被 finalize 搬出缓存：兜底清掉本候选专属的空目录（成功路径不会走 cleanup）。
    pruneCacheDir();
    // 下载期由**内置标签来源插件**打上过标签 → 落盘后登记「标签修复完成标记」：
    // 后续标签修复命中且文件位置/大小/mtime 未变即直接跳过（外置插件不标记）。
    if (builtinTagSrc) markTagRepairDone(fr.finalPath, builtinTagSrc);
    return {
      kind: "success",
      cachePath,
      bytes: dl.bytes,
      finalPath: fr.finalPath,
      ...(inPlace ? { inPlace } : {}),
      // 品质分流依据（供 flush 按对应媒体源入库）：无损达标 → losslessRoot。
      ...(!inPlace && losslessGrade && cfg.losslessRoot ? { destRoot: cfg.losslessRoot } : {}),
    };
  }
}
