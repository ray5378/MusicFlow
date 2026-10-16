// ==================== 标签缺失修复（歌词/封面/专辑回写，方案 B：事件队列 + 定时兜底） ====================
//
// 背景（2026-10-11）：下载 enrich 阶段的封面/歌词获取是「只告警不上抛」的增值项，
// DNS 风暴等瞬时故障会让成品文件缺内嵌封面/歌词（如吕口口《让泪化作相思雨》）。
// 本模块两级修复：
//   1) 事件队列（主）：fetch 任务终态入库后（jobRunner.autoScanAfterJob），把本次
//      成功落盘的 songId 入队，按退避重试（10min 初始延迟 → 1h → 6h → 24h，
//      3 次失败后移出队列——瞬时故障基本在第一二次重试内自愈，真没有的不空转）。
//   2) 全量兜底扫（辅）：每 tagRepairIntervalHours（默认 168h=7 天）扫一遍两个
//      下载目录（downloadRoot + losslessRoot，即 songs.path 前缀 `l:` 且落在两根内），
//      文件头精探（music-metadata）内嵌封面/歌词/专辑标签，只修真缺的。
//
// 修复目标与取值来源（产品定调 2026-10-11；2026-10-16 范围扩到「补齐**全部**缺失标签」）：
//   - 封面 / 歌词：**先探测、拿得到才写**——searchCover/searchLyrics 拿不到就不碰
//     文件（绝不写空值/占位图）。
//   - 专辑：文件内嵌 album 为空而 DB 行有声明值（下载时 provider 元数据入库）→
//     直接用 DB 值回写，无需网络；DB 也为空才回落 searchMetadata。
//   - 其余标签（title/artist/albumArtist/track/year/genre）：一次 searchMetadata
//     拿到全部，**只补缺失项**、只写真拿到值的字段；失败只告警不抛。title/artist 仅在
//     内嵌缺失时补（避免覆盖文件里已有的值）。**碟号（disc）不在此列**：成品文件既不写
//     也不留 DISCNUMBER/DISCTOTAL（产品定调 2026-10-17，见 tagWriter 文件头【碟号纪律】），
//     故「内嵌无碟号」不算缺失、绝不触发修复。
//   写入复用 tagWriter 的 tagtmp+rename 原子语义，失败不破坏原文件。
//   范围硬锁定两个下载目录，绝不碰 WebDAV 云盘库。
//
// 完成标记（2026-10-16，产品定调）：下载期由**内置标签来源插件**（manifest.
//   builtinTagSource，如内置 tag-provider）打上标签的成品，落盘后在 tag_repair_done
//   登记（见 tagRepairMarker.ts）。修复扫描命中标记且文件未变 → 不探针、不联网直接跳过
//   （outcome=skip，计入「已修复」）。设计意图=下载已用同一 provider 打过一轮，
//   网络波动漏打的不写标记 → 修复仍会补。**其他（外置）插件不标记**。
//
// fingerprint 安全性（已核实）：scanner.upsertSong 按 **path** 匹配（非 fingerprint），
// tagWriter 重写容器后重扫只会 UPDATE 该行并从文件头刷新 hasLyrics/album picture，
// 不会产生重复条目——本模块写完顺带自更新 DB has_lyrics，让 UI 立即生效。

import { existsSync, statSync } from "node:fs";
import { parseFile } from "music-metadata";
import { sqlite } from "../../db/index.js";
import { createLogger } from "../../utils/logger.js";
import { getSetting, setSetting } from "../settings.js";
import { searchCover, searchLyrics, searchMetadata } from "../../plugins/providers.js";
import { cacheRemoteCover, resolveCoverFile } from "../playlistCover.js";
import { withCoverLimit } from "../covers.js";
import { FetchTagError, writeTags, applyTagsVariant, type SongTags } from "./tagWriter.js";
import { currentFetchConfig } from "./configStore.js";
import type { FetchConfig, TagRepairScope } from "./config.js";
import { isTagRepairMarked, _resetTagRepairMarkersForTest } from "./tagRepairMarker.js";

const log = createLogger("FETCH_TAG_REPAIR");

const QUEUE_KEY = "fetch.tagrepair.queue";
const LAST_RUN_KEY = "fetch.tagrepair.lastRunAt";
const LAST_RESULT_KEY = "fetch.tagrepair.lastResult";
const LAST_RESULTS_KEY = "fetch.tagrepair.lastResults";
/** 累计已修复歌数（跨重启累加，供「已修复」统计展示）。 */
const REPAIRED_TOTAL_KEY = "fetch.tagrepair.repairedTotal";

/** 事件队列重试退避（第 1/2/3 次失败的下次重试间隔）。 */
const BACKOFF_MS = [3_600_000, 6 * 3_600_000, 24 * 3_600_000] as const;
/** 下载终态入队的初始延迟：给终态自动增量扫描留时间（songs 行建立后修复才有意义）。 */
const INITIAL_DELAY_MS = 10 * 60_000;
/** 队列单次 tick 最多处理的歌数（gentle：不与前台请求抢网络）。 */
const QUEUE_BATCH = 10;
/** 调度轮询/启动延迟（与 upgradeScheduler 同款）。 */
const POLL_MS = 60_000;
const BOOT_DELAY_MS = 15_000;
/**
 * TAG_FAILED 单次重试延迟。加固（2026-10-11）：首修全量扫 40 起写失败全部集中在
 * 一个 11 分钟窗口，实证为 NAS 存储层瞬时抖动（绿联 trimacl 短窗内 EACCES /
 * 新建条目不可见 / 条目闪没），事后同命令复跑全部成功——2s 后重试 1 次即可吸收。
 * 仅 TAG_FAILED 重试；TIMEOUT 不重试（可能真慢/真卡），其他错误原样上抛。
 */
const TAG_WRITE_RETRY_DELAY_MS = 2_000;

interface QueueEntry {
  count: number;
  nextAt: number;
}

type QueueMap = Record<string, QueueEntry>;

/** 触发挡位：queue=只清到期队列；media=第一档常规(仅 DB 预筛)；all=第二档全量(逐首精探文件头)。 */
export type TagRepairMode = "queue" | "media" | "all";

export interface TagRepairResult {
  checked: number;
  /** 修复动作统计：一轮内实际写进文件的封面/歌词/专辑/元数据次数（一首可能多项）。 */
  coverFixed: number;
  lyricFixed: number;
  albumFixed: number;
  /** 元数据补全命中次数（本次有 title/artist/albumArtist/track/year/genre 被写入）。 */
  metaFixed: number;
  /** 探测过但 provider 拿不到（真没有）——不动文件。 */
  unobtainable: number;
  /** 无需修复（标签其实齐）或文件不存在/不可解析。 */
  skipped: number;
  /** 实际重写文件的歌数。 */
  fixed: number;
}

// ---------------------------------------------------------------------------
// 状态存取（settings JSON，进程重启不丢）
// ---------------------------------------------------------------------------

function loadQueue(): QueueMap {
  try {
    const raw = getSetting(QUEUE_KEY, "");
    if (!raw) return {};
    const parsed = JSON.parse(String(raw)) as QueueMap;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function saveQueue(q: QueueMap): void {
  setSetting(QUEUE_KEY, JSON.stringify(q));
}

/** 读 lastResult（供 API/UI 展示）。 */
export function getTagRepairLastResult(): (TagRepairResult & { at: number; mode: string }) | null {
  try {
    const raw = getSetting(LAST_RESULT_KEY, "");
    if (!raw) return null;
    return JSON.parse(String(raw));
  } catch {
    return null;
  }
}

/** 分挡位的上次结果（供前端两块卡片各显各的；读不到/JSON 异常返回 {}）。 */
export function getTagRepairLastResults(): Partial<
  Record<TagRepairMode, TagRepairResult & { at: number; mode: string }>
> {
  try {
    const raw = getSetting(LAST_RESULTS_KEY, "");
    if (!raw) return {};
    const parsed = JSON.parse(String(raw));
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function saveLastResult(mode: TagRepairMode, r: TagRepairResult): void {
  setSetting(LAST_RESULT_KEY, JSON.stringify({ ...r, at: Date.now(), mode }));
  const all = getTagRepairLastResults();
  all[mode] = { ...r, at: Date.now(), mode };
  setSetting(LAST_RESULTS_KEY, JSON.stringify(all));
}

/** 队列规模（供 API/UI 展示）。 */
export function getTagRepairQueueSize(): number {
  return Object.keys(loadQueue()).length;
}

// ---------------------------------------------------------------------------
// 实时统计（已修复 / 待修复 / 全部）+ 运行中进度
// ---------------------------------------------------------------------------

/** 稳态统计（GET 轮询展示）：
 *  - total：两个下载目录内本地歌总数（songs.path 前缀 `l:` 且落在两根内）；
 *  - pending：当前 DB 预筛「缺歌词/封面/专辑」的待修候选数（同第一档口径）；
 *  - repaired：累计已修复歌数（跨重启累加）。 */
export interface TagRepairStats {
  total: number;
  pending: number;
  repaired: number;
}

/** 运行中进度（仅 running 时非 null）：scan=全量精探阶段 / repair=逐首修复阶段。 */
export interface TagRepairProgress {
  mode: TagRepairMode;
  phase: "scan" | "repair";
  /** 当前阶段总数（scan=待探范围 / repair=候选数）。 */
  total: number;
  /** 当前阶段已处理数。 */
  checked: number;
  /** 本轮实际写文件的歌数。 */
  fixed: number;
  /** 本轮跳过（无需修 / 命中完成标记）的歌数；「已修复」= fixed + skipped。 */
  skipped: number;
  startedAt: number;
}

let progress: TagRepairProgress | null = null;

/** 运行中进度（供 API/UI 展示）；空闲返回 null。 */
export function getTagRepairProgress(): TagRepairProgress | null {
  return progress;
}

/** 累计已修复歌数（持久化，跨重启保留）。 */
export function getTagRepairRepairedTotal(): number {
  return Number(getSetting(REPAIRED_TOTAL_KEY, "0")) || 0;
}

function addRepairedTotal(n: number): void {
  if (!Number.isFinite(n) || n <= 0) return;
  setSetting(REPAIRED_TOTAL_KEY, String(getTagRepairRepairedTotal() + Math.floor(n)));
}

/** DB 派生统计（total/pending）带 5s 短缓存：轮询 5s 一次，避免重复整表扫描。 */
let statsCache: { at: number; total: number; pending: number } | null = null;

function dbStats(): { total: number; pending: number } {
  const now = Date.now();
  if (statsCache && now - statsCache.at < 5_000) return statsCache;
  const cfg = currentFetchConfig();
  let total = 0;
  const rows = sqlite.prepare("SELECT path FROM songs WHERE path LIKE 'l:%'").all() as Array<{ path: string }>;
  for (const r of rows) {
    const fsPath = fsPathOf(r.path);
    if (fsPath && inDownloadRoots(fsPath, cfg)) total++;
  }
  const pending = selectMediaMissingRows().filter((r) => {
    const fsPath = fsPathOf(r.path);
    return Boolean(fsPath && inDownloadRoots(fsPath, cfg));
  }).length;
  statsCache = { at: now, total, pending };
  return statsCache;
}

/** 实时统计（供 API/UI 展示）。 */
export function getTagRepairStats(): TagRepairStats {
  const { total, pending } = dbStats();
  return { total, pending, repaired: getTagRepairRepairedTotal() };
}

// —— 进度写入（仅在一轮运行期间由 sweep/queue 调用；progress 为 null 时全部为 no-op）——

function progressStart(mode: TagRepairMode): void {
  progress = { mode, phase: "scan", total: 0, checked: 0, fixed: 0, skipped: 0, startedAt: Date.now() };
}

/** 切换/重置当前阶段（进入修复阶段或切挡位时重置计数）。 */
function progressPhase(phase: "scan" | "repair", total: number): void {
  if (!progress) return;
  progress.phase = phase;
  progress.total = total;
  progress.checked = 0;
  progress.fixed = 0;
  progress.skipped = 0;
}

/** 推进已处理数（fixedInc=本次是否真写文件；skipInc=本次是否跳过）。 */
function progressTick(fixedInc: number, skipInc = 0): void {
  if (!progress) return;
  progress.checked++;
  progress.fixed += fixedInc;
  progress.skipped += skipInc;
}

function progressSetChecked(checked: number): void {
  if (progress) progress.checked = checked;
}

function progressEnd(): void {
  progress = null;
}

// ---------------------------------------------------------------------------
// 探针：文件头内嵌标签（music-metadata 统一处理 flac/mp3/m4a/ogg）
// ---------------------------------------------------------------------------

/** 内嵌标签存在性（各维度 true = 文件里已有值，无需补）。 */
interface EmbeddedTags {
  cover: boolean;
  lyric: boolean;
  album: boolean;
  title: boolean;
  artist: boolean;
  albumArtist: boolean;
  track: boolean;
  year: boolean;
  genre: boolean;
}

/** 返回 null = 文件不可解析（不确定，保守跳过不写）。 */
async function probeEmbedded(fsPath: string): Promise<EmbeddedTags | null> {
  try {
    const mm = await parseFile(fsPath, { duration: false });
    const c = mm.common;
    return {
      cover: Array.isArray(c.picture) && c.picture.length > 0,
      lyric: Array.isArray(c.lyrics) && c.lyrics.some((l) => String(l || "").trim()),
      album: Boolean(String(c.album ?? "").trim()),
      title: Boolean(String(c.title ?? "").trim()),
      artist: Boolean(String(c.artist ?? "").trim()),
      albumArtist: Boolean(String(c.albumartist ?? "").trim()),
      track: Number(c.track?.no ?? 0) > 0,
      year: Number(c.year ?? 0) > 0,
      genre: Array.isArray(c.genre) && c.genre.some((g) => String(g || "").trim()),
    };
  } catch {
    return null;
  }
}

/** `l:<sourceId>:<fsPath>` → `<fsPath>`；非 `l:` 前缀返回 null。 */
export function fsPathOf(songPath: string): string | null {
  if (typeof songPath !== "string" || !songPath.startsWith("l:")) return null;
  const i = songPath.indexOf(":", 2);
  if (i < 0) return null;
  return songPath.slice(i + 1);
}

/** 该歌的 fsPath 是否落在两个下载目录之一（范围硬门禁）。 */
function inDownloadRoots(fsPath: string, cfg: FetchConfig): boolean {
  const roots = [cfg.downloadRoot, cfg.losslessRoot].filter(Boolean) as string[];
  return roots.some((root) => fsPath === root || fsPath.startsWith(root.endsWith("/") ? root : root + "/"));
}

/** 按用户选择的范围取要扫描的下载目录（download=仅下载根 / lossless=仅无损根 / both=两者）。 */
function rootsForScope(cfg: FetchConfig, scope: TagRepairScope): string[] {
  const dl = cfg.downloadRoot ? [cfg.downloadRoot] : [];
  const ll = cfg.losslessRoot ? [cfg.losslessRoot] : [];
  if (scope === "download") return dl;
  if (scope === "lossless") return ll;
  return [...dl, ...ll];
}

/** 该歌的 fsPath 是否落在指定范围内的下载目录（范围硬门禁）。 */
function inScopeRoots(fsPath: string, cfg: FetchConfig, scope: TagRepairScope): boolean {
  return rootsForScope(cfg, scope).some(
    (root) => fsPath === root || fsPath.startsWith(root.endsWith("/") ? root : root + "/"),
  );
}

// ---------------------------------------------------------------------------
// 单首修复
// ---------------------------------------------------------------------------

interface RepairRow {
  id: string;
  title: string;
  artist: string | null;
  album: string | null;
  duration: number | null;
  path: string;
  has_lyrics: number | null;
  source_data: string | null;
  url: string | null;
}

function loadRow(songId: string): RepairRow | null {
  return (
    (sqlite
      .prepare(
        "SELECT id, title, artist, album, duration, path, has_lyrics, source_data, url FROM songs WHERE id = ?",
      )
      .get(songId) as RepairRow | undefined) ?? null
  );
}

export interface RepairSongOutcome {
  outcome: "fixed" | "unobtainable" | "skip";
  cover: boolean;
  lyric: boolean;
  album: boolean;
  /** 本次是否有 title/artist/albumArtist/track/year/genre 被写入。 */
  meta: boolean;
}

/**
 * 修复一首：探缺 → 先探测拿得到 → 才写文件 → 回写 DB。
 * skip = 标签其实齐/文件不可用（不重试）；unobtainable = 真缺但拿不到（进退避）。
 */
export async function repairSongTags(songId: string, cfg: FetchConfig): Promise<RepairSongOutcome> {
  const none: RepairSongOutcome = { outcome: "skip", cover: false, lyric: false, album: false, meta: false };
  const unobtainable: RepairSongOutcome = {
    outcome: "unobtainable",
    cover: false,
    lyric: false,
    album: false,
    meta: false,
  };
  const row = loadRow(songId);
  if (!row || !row.path) return none;
  const fsPath = fsPathOf(row.path);
  if (!fsPath || !inDownloadRoots(fsPath, cfg) || !existsSync(fsPath)) return none;

  // 下载期已由内置标签来源插件打过标签、且文件位置/大小/mtime 未变 → 不探针、不联网直接跳过。
  if (isTagRepairMarked(fsPath)) return none;

  const embedded = await probeEmbedded(fsPath);
  if (!embedded) return none; // 不可解析的文件不动（保守）

  const dbAlbum = String(row.album ?? "").trim();
  const needCover = !embedded.cover;
  const needLyric = !embedded.lyric && !row.has_lyrics;
  const needAlbum = !embedded.album && Boolean(dbAlbum); // DB 声明值兜底，无需网络
  // 元数据可补的缺失维度：专辑（DB 也为空时才需网络）/ 专辑艺术家 / 轨 / 年 / 流派。
  // （碟号不参与缺失判定：成品本就不带碟号，见文件头说明。）
  const needMeta =
    (!embedded.album && !dbAlbum) ||
    !embedded.albumArtist ||
    !embedded.track ||
    !embedded.year ||
    !embedded.genre;
  if (!needCover && !needLyric && !needAlbum && !needMeta) {
    // 文件其实齐了、DB 滞后（如 repair 前刚被重扫过）→ 只对齐 DB，不重写文件。
    if (!row.has_lyrics && embedded.lyric) {
      sqlite.prepare("UPDATE songs SET has_lyrics = 1, updated_at = ? WHERE id = ?").run(
        new Date().toISOString(),
        songId,
      );
    }
    return none;
  }

  // songInput：与 orchestrator.collectExtraTags 同形（url 带 /music/download 时
  // 插件可短路抠 cover 参数；source 传 provider 平台）。
  let sd: { source?: string; provider?: string } = {};
  try {
    sd = row.source_data ? JSON.parse(row.source_data) : {};
  } catch {
    /* 旧数据无 source_data */
  }
  const songInput = {
    title: row.title,
    artist: row.artist,
    album: row.album,
    duration: row.duration,
    url: row.url,
    source: sd.source ?? sd.provider ?? null,
  };

  const tags: SongTags = {};
  let metaWrote = false;

  if (needAlbum) {
    // 专辑：DB 声明值即权威（下载时 provider 元数据），直接写，无需网络。
    tags.album = dbAlbum;
  }

  if (needCover) {
    try {
      const url = await withCoverLimit(() => searchCover(songInput));
      if (url) {
        // cacheRemoteCover：复用封面下载全局限流 + SSRF 防护 + 本地缓存目录。
        const ref = await cacheRemoteCover(url, `tagfix-${songId}`);
        if (ref) {
          const local = resolveCoverFile(ref);
          if (local && existsSync(local)) {
            tags.cover = local;
          }
        }
      }
    } catch (e) {
      log.warn(`封面探测失败(不计入，进退避重试): song=${songId} err=${e instanceof Error ? e.message : e}`);
    }
  }

  if (needLyric) {
    try {
      const text = await searchLyrics(songInput);
      if (text && text.trim()) {
        tags.lyric = text;
      }
    } catch (e) {
      log.warn(`歌词探测失败(不计入，进退避重试): song=${songId} err=${e instanceof Error ? e.message : e}`);
    }
  }

  // 元数据补全：一次调用拿全部（title/artist/albumArtist/track/year/genre）。碟号不采集不写
  // （见文件头【碟号纪律】）。
  // 专辑仅在 DB 也为空时才用元数据值（DB 优先）；title/artist 仅在内嵌缺失时补，避免覆盖。
  // 整体 try/catch：拿不到/报错只告警，不让整首失败，也不改动文件。
  if (needMeta) {
    try {
      const meta = await searchMetadata(songInput);
      if (meta) {
        if (!embedded.album && !dbAlbum && meta.album) tags.album = meta.album;
        if (meta.albumArtist) {
          tags.albumArtist = meta.albumArtist;
          metaWrote = true;
        }
        if (meta.track) {
          tags.track = meta.track;
          metaWrote = true;
        }
        if (meta.year !== undefined && meta.year !== null) {
          tags.year = meta.year;
          metaWrote = true;
        }
        if (meta.genre) {
          tags.genre = meta.genre;
          metaWrote = true;
        }
        if (!embedded.title && meta.title) {
          tags.title = meta.title;
          metaWrote = true;
        }
        if (!embedded.artist && meta.artist) {
          tags.artist = meta.artist;
          metaWrote = true;
        }
      }
    } catch (e) {
      log.warn(`元数据补全失败(不计入，进退避重试): song=${songId} err=${e instanceof Error ? e.message : e}`);
    }
  }

  const gotCover = Boolean(tags.cover);
  const gotLyric = Boolean(tags.lyric);
  const gotAlbum = Boolean(tags.album);
  const gotMeta = metaWrote;
  if (!gotCover && !gotLyric && !gotAlbum && !gotMeta) return unobtainable;

  // 中文字形（产品定调 2026-10-16）：写盘前把 provider 文本按用户所选字形转换（默认简体）。
  // 放在这里（而非各取值分支）是为了让「哪些字段要转」与下载期共用同一实现
  // （tagWriter.applyTagsVariant），两条写入路径口径一致。
  applyTagsVariant(tags, currentFetchConfig().chineseVariant);

  // 只在真拿到值时才写 —— tagWriter 原子写（tagtmp+rename），失败抛 FetchTagError。
  // TAG_FAILED 短延迟重试 1 次，吸收 NAS 存储层瞬时抖动；原文件保证未被破坏，重试安全。
  try {
    // keepSourceCover：本次不换封面（needCover=false）时必须保留源文件已有封面，
    // 否则「补 genre/track 等缺失标签」的重写会把已有封面一并丢掉（2026-10-17 实测）。
    await writeTags(fsPath, tags, { keepSourceCover: true });
  } catch (e) {
    if (!(e instanceof FetchTagError) || e.code !== "TAG_FAILED") throw e;
    log.warn(`写标签失败，${TAG_WRITE_RETRY_DELAY_MS}ms 后重试一次: song=${songId}`);
    await new Promise((resolve) => setTimeout(resolve, TAG_WRITE_RETRY_DELAY_MS));
    await writeTags(fsPath, tags, { keepSourceCover: true });
  }

  if (gotLyric) {
    sqlite
      .prepare("UPDATE songs SET has_lyrics = 1, updated_at = ? WHERE id = ?")
      .run(new Date().toISOString(), songId);
  } else {
    sqlite.prepare("UPDATE songs SET updated_at = ? WHERE id = ?").run(new Date().toISOString(), songId);
  }
  log.info(
    `标签修复完成 song=${songId} file=${fsPath} ` +
      [gotCover ? "+封面" : "", gotLyric ? "+歌词" : "", gotAlbum ? "+专辑" : "", gotMeta ? "+元数据" : ""]
        .filter(Boolean)
        .join(""),
  );
  return { outcome: "fixed", cover: gotCover, lyric: gotLyric, album: gotAlbum, meta: gotMeta };
}

// ---------------------------------------------------------------------------
// 队列（事件驱动，主路径）
// ---------------------------------------------------------------------------

/** fetch 任务终态后调用：把本次入库的 songId 入队（初始延迟 10min 等扫描完成）。 */
export function enqueueTagRepairs(songIds: string[]): number {
  if (!Array.isArray(songIds) || songIds.length === 0) return 0;
  const q = loadQueue();
  let added = 0;
  for (const id of songIds) {
    if (!id || q[id]) continue;
    q[id] = { count: 0, nextAt: Date.now() + INITIAL_DELAY_MS };
    added++;
  }
  if (added > 0) saveQueue(q);
  if (added > 0) log.info(`[TAG-REPAIR] 新入队 ${added} 首（待检查标签缺失）`);
  return added;
}

function emptyResult(): TagRepairResult {
  return {
    checked: 0,
    coverFixed: 0,
    lyricFixed: 0,
    albumFixed: 0,
    metaFixed: 0,
    unobtainable: 0,
    skipped: 0,
    fixed: 0,
  };
}

function accumulate(result: TagRepairResult, o: RepairSongOutcome): void {
  if (o.outcome === "fixed") {
    result.fixed++;
    if (o.cover) result.coverFixed++;
    if (o.lyric) result.lyricFixed++;
    if (o.album) result.albumFixed++;
    if (o.meta) result.metaFixed++;
  } else if (o.outcome === "skip") {
    result.skipped++;
  } else {
    result.unobtainable++;
  }
}

/** 处理到期队列项（单批 ≤QUEUE_BATCH；成功出队、失败退避、3 败弃权）。 */
export async function processTagRepairQueue(cfg: FetchConfig, nowMs = Date.now()): Promise<TagRepairResult> {
  const q = loadQueue();
  const due = Object.entries(q).filter(([, e]) => Number(e?.nextAt ?? 0) <= nowMs);
  const result = emptyResult();
  if (due.length === 0) return result;
  const batch = due.slice(0, QUEUE_BATCH);
  progressPhase("repair", batch.length);

  for (const [songId, entry] of batch) {
    result.checked++;
    let o: RepairSongOutcome;
    try {
      o = await repairSongTags(songId, cfg);
    } catch (e) {
      log.warn(`队列修复异常 song=${songId}: ${e instanceof Error ? e.message : e}`);
      o = { outcome: "unobtainable", cover: false, lyric: false, album: false, meta: false };
    }
    accumulate(result, o);
    progressTick(o.outcome === "fixed" ? 1 : 0, o.outcome === "skip" ? 1 : 0);
    if (o.outcome === "fixed" || o.outcome === "skip") {
      delete q[songId];
    } else {
      const count = Number(entry?.count ?? 0) + 1;
      if (count >= BACKOFF_MS.length) {
        // 3 败弃权（1h/6h 两轮退避都错过）：移出队列，等全量兜底扫。
        log.info(`[TAG-REPAIR] song=${songId} 连续 ${count} 次拿不到，移出队列（等全量兜底扫）`);
        delete q[songId];
      } else {
        q[songId] = { count, nextAt: nowMs + BACKOFF_MS[count - 1] };
      }
    }
  }
  saveQueue(q);
  return result;
}

// ---------------------------------------------------------------------------
// 全量兜底扫 + 第一档常规扫
// ---------------------------------------------------------------------------

/** 第一档候选：数据库明示缺「歌词 / 封面 / 专辑」的行（纯 SQL，不读文件头）。
 *  封面缺失的判定必须 LEFT JOIN albums 取 albums.cover_art —— 本地/下载歌曲的封面只落在
 *  albums 行，songs.cover_art 恒为空，单看它会把整库都算成缺封面。 */
export function selectMediaMissingRows(): Array<{ id: string; path: string }> {
  return sqlite
    .prepare(
      `SELECT s.id AS id, s.path AS path
         FROM songs s
         LEFT JOIN albums a ON a.id = s.album_id
        WHERE s.path LIKE 'l:%'
          AND (
            COALESCE(s.has_lyrics, 0) = 0
            OR TRIM(COALESCE(s.album, '')) = ''
            OR (
              TRIM(COALESCE(s.cover_art, '')) = ''
              AND (s.album_id IS NULL OR TRIM(COALESCE(a.cover_art, '')) = '')
            )
          )`,
    )
    .all() as Array<{ id: string; path: string }>;
}

/**
 * 扫指定范围（cfg.tagRepairScope 或请求覆盖）的下载目录并逐首修复。
 * scope "media"=第一档常规：纯 DB 预筛（selectMediaMissingRows），不读文件头，成本远低于全量。
 * scope "all"=第二档全量：文件头精探内嵌标签，任一维度缺失即修真缺的。
 * dirScope=扫描目录范围（download/lossless/both）。
 */
export async function sweepTagRepair(
  cfg: FetchConfig,
  scope: "media" | "all" = "all",
  dirScope: TagRepairScope = cfg.tagRepairScope ?? "both",
): Promise<TagRepairResult> {
  const result = emptyResult();
  const candidates: Array<{ id: string; fsPath: string }> = [];
  // 命中「下载期内置插件已打好且文件未变」标记而跳过的歌数：计入「已修复·跳过」。
  let markedSkipped = 0;

  if (scope === "media") {
    // 第一档·常规，纯 DB 判定，不读文件头，成本远低于全量。
    const rows = selectMediaMissingRows();
    for (const r of rows) {
      const fsPath = fsPathOf(r.path);
      if (!fsPath || !inScopeRoots(fsPath, cfg, dirScope)) continue;
      if (isTagRepairMarked(fsPath)) {
        markedSkipped++;
        continue;
      }
      candidates.push({ id: r.id, fsPath });
    }
    log.info(`[TAG-REPAIR] 常规扫描完成（范围 ${dirScope}）：候选中 DB 缺歌词/封面/专辑 ${candidates.length} 首`);
  } else {
    const rows = sqlite
      .prepare("SELECT id, path, has_lyrics, album FROM songs WHERE path LIKE 'l:%'")
      .all() as Array<{ id: string; path: string; has_lyrics: number | null; album: string | null }>;
    // 先按范围（用户选择的下载根）过滤，scan 阶段进度百分比才准确（分母=范围内歌数）。
    const inRoot: Array<{ id: string; fsPath: string }> = [];
    for (const r of rows) {
      const fsPath = fsPathOf(r.path);
      if (fsPath && inScopeRoots(fsPath, cfg, dirScope)) inRoot.push({ id: r.id, fsPath });
    }

    // ① 文件头精探（只读）：封面/歌词/专辑/专辑艺术家/轨/年/流派任一缺失即候选
    //    （album 有 DB 值兜底、无需网络也能修；其余缺失回落 searchMetadata）。
    //    碟号不参与缺失判定（成品本就不带碟号）。
    progressPhase("scan", inRoot.length);
    let probed = 0;
    for (const { id, fsPath } of inRoot) {
      probed++;
      progressSetChecked(probed);
      // 下载期已由内置标签来源插件打好、且文件未变 → 不探针直接跳过（算「已修复·跳过」）。
      if (isTagRepairMarked(fsPath)) {
        markedSkipped++;
        continue;
      }
      const embedded = await probeEmbedded(fsPath);
      if (
        embedded &&
        (!embedded.cover ||
          !embedded.lyric ||
          !embedded.album ||
          !embedded.albumArtist ||
          !embedded.track ||
          !embedded.year ||
          !embedded.genre)
      ) {
        candidates.push({ id, fsPath });
      }
      if (probed % 1000 === 0) log.info(`[TAG-REPAIR] 全量探针进度 ${probed}/${inRoot.length}，候选 ${candidates.length}`);
    }
    log.info(
      `[TAG-REPAIR] 全量扫描完成（范围 ${dirScope}）：范围 ${probed} 首，` +
        `标记跳过 ${markedSkipped} 首，待修复候选 ${candidates.length} 首`,
    );
  }
  result.skipped += markedSkipped;

  // ② 逐首修复（repairSongTags 内部再探一次拿得到才写）。
  progressPhase("repair", candidates.length);
  for (const { id } of candidates) {
    result.checked++;
    let o: RepairSongOutcome;
    try {
      o = await repairSongTags(id, cfg);
    } catch (e) {
      log.warn(`全量修复异常 song=${id}: ${e instanceof Error ? e.message : e}`);
      o = { outcome: "unobtainable", cover: false, lyric: false, album: false, meta: false };
    }
    accumulate(result, o);
    progressTick(o.outcome === "fixed" ? 1 : 0, o.outcome === "skip" ? 1 : 0);
  }
  return result;
}

// ---------------------------------------------------------------------------
// 统一入口 + 调度
// ---------------------------------------------------------------------------

let repairing = false;

/**
 * 跑一轮修复（手动触发按钮与调度共用）。
 * mode "queue"=只处理到期队列项；"media"=第一档常规（仅 DB 预筛，不读文件头）；
 * "all"=第二档全量（先全量兜底扫、再清队列）。
 * dirScope 为本次扫描的目录范围（download/lossless/both），缺省取 cfg.tagRepairScope。
 * 单飞：进行中返回 { busy: true }。
 */
export async function runTagRepairOnce(
  mode: TagRepairMode,
  cfgOver?: FetchConfig,
  dirScopeOver?: TagRepairScope,
): Promise<{ busy: boolean; result?: TagRepairResult }> {
  if (repairing) return { busy: true };
  repairing = true;
  progressStart(mode);
  try {
    const cfg = cfgOver ?? currentFetchConfig();
    const dirScope: TagRepairScope = dirScopeOver ?? cfg.tagRepairScope ?? "both";
    let result: TagRepairResult;
    /** 本轮「已修复」累计增量（口径 = 真写入修复的 + 无需修/命中标记跳过的）。 */
    let doneThisRun: number;
    if (mode === "all") {
      const sweep = await sweepTagRepair(cfg, "all", dirScope);
      // 累计口径取**扫描段**的结果：全量扫已把「标签齐/命中完成标记」的歌计进它自己的
      // skipped，随后清队列时又会在同一批歌上再记一次 skipped —— 直接相加会让累计
      // 「已修复」虚高（同一首歌被计两次）。队列在此只作收尾清账，不重复计入累计。
      doneThisRun = sweep.fixed + sweep.skipped;
      result = sweep;
      // 全量后队列里遗留的到期项一并清一轮（3 败弃权的不再重试）。
      const qr = await processTagRepairQueue(cfg);
      result.checked += qr.checked;
      result.fixed += qr.fixed;
      result.coverFixed += qr.coverFixed;
      result.lyricFixed += qr.lyricFixed;
      result.albumFixed += qr.albumFixed;
      result.metaFixed += qr.metaFixed;
      result.unobtainable += qr.unobtainable;
      result.skipped += qr.skipped;
    } else if (mode === "media") {
      // 第一档常规：仅 DB 预筛，不清队列。
      result = await sweepTagRepair(cfg, "media", dirScope);
      doneThisRun = result.fixed + result.skipped;
    } else {
      result = await processTagRepairQueue(cfg);
      doneThisRun = result.fixed + result.skipped;
    }
    // lastRunAt 只由「第二档全量」推进：它是定时全量兜底扫的到点标记。
    // 常规/队列挡位手动触发都是非穷尽操作，若也推进该标记，用户每次点「常规修复」
    // 都会把到期的全量兜底扫往后推一个间隔，等于让兜底扫永远不跑。
    if (mode === "all") setSetting(LAST_RUN_KEY, String(Date.now()));
    // 累计「已修复」计数（持久化）：口径 = 真写入修复的 + 无需修/命中标记跳过的。
    addRepairedTotal(doneThisRun);
    statsCache = null; // 待修候选数变了，下次查询重算
    saveLastResult(mode, result);
    log.info(
      `[TAG-REPAIR] ${mode} 一轮完成（范围 ${dirScope}）：检查 ${result.checked}，修复 ${result.fixed} 首` +
        `（封面 ${result.coverFixed} / 歌词 ${result.lyricFixed} / 专辑 ${result.albumFixed} / 元数据 ${result.metaFixed}），` +
        `拿不到 ${result.unobtainable}，无需修/跳过 ${result.skipped}`,
    );
    return { busy: false, result };
  } finally {
    repairing = false;
    progressEnd();
  }
}

export function isTagRepairRunning(): boolean {
  return repairing;
}

let started = false;
let ticking = false;

/** 挂载调度循环（幂等）：每分钟 tick —— ① 处理到期队列项；② 到期全量兜底扫。 */
export function startTagRepairScheduler(): void {
  if (started) return;
  started = true;
  const tick = (): void => {
    if (ticking || repairing) return;
    ticking = true;
    void (async () => {
      try {
        const cfg = currentFetchConfig();
        if (!cfg.tagRepairEnabled) return;
        // ① 事件队列：始终处理（主路径，治 DNS 风暴类瞬时故障）。
        await processTagRepairQueue(cfg);
        // ② 全量兜底：到点才跑（lastRunAt 持久化，重启不重复触发）。
        const last = Number(getSetting(LAST_RUN_KEY, "0")) || 0;
        const intervalMs = Math.max(1, Math.floor(cfg.tagRepairIntervalHours || 168)) * 3_600_000;
        if (Date.now() - last >= intervalMs) {
          await runTagRepairOnce("all", cfg);
        }
      } catch (e) {
        log.warn("[TAG-REPAIR] tick 失败: " + (e instanceof Error ? e.message : String(e)));
      } finally {
        ticking = false;
      }
    })();
  };
  setTimeout(tick, BOOT_DELAY_MS);
  setInterval(tick, POLL_MS);
}

/** 测试复位（清全部状态 + 单飞锁）。 */
export function _resetTagRepairForTest(): void {
  saveQueue({});
  setSetting(LAST_RUN_KEY, "0");
  setSetting(LAST_RESULT_KEY, "");
  setSetting(LAST_RESULTS_KEY, "");
  setSetting(REPAIRED_TOTAL_KEY, "");
  repairing = false;
  ticking = false;
  progress = null;
  statsCache = null;
  _resetTagRepairMarkersForTest();
}

// statSync 引用保留给未来「跳过在途文件（mtime 新鲜度）」用；当前探针+原子写已足够安全。
void statSync;
