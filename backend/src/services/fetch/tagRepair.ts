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
// 【2026-10-17 修正 1·修复后补标记】此前 `markTagRepairDone` 只在**下载期**被调用，标签修复
//   真正改写文件后**不写标记** → 生产库 `tag_repair_done` 实测 0 行，用户触发的常规修复修了
//   50 首却全部无标记、下轮仍被当候选重扫。现改为：一次修复**真正写入**（outcome=fixed）后
//   登记标记（src=命中的来源 provider id，无 provider 命中时回落 "tag-repair"）。
//
// 【2026-10-17 修正 6·终态不可得（选项 C）】真缺标签但各来源都拿不到的歌（unobtainable）此前
//   **一律不标记** → 每轮全量扫都把它当候选重探/重扫，实测 96% 失败、任务池永不收敛。现改为：
//   返回 unobtainable 前登记 outcome='unobtainable' 标记（同样记 size/mtime，文件一变即失效）。
//   下轮扫描命中该标记即跳过（池子一轮收敛）；安全阀 30 天 TTL —— 超期后允许重探（防断网/
//   平台抽风把整库永久标记，且可自愈）。unobtainable 行**不计入**「已修复」，也**不参与**来源分布聚合。
//
// 【2026-10-17 修正 7·「待修复」口径剔除已落标记】GET stats 的 pending 取 `selectMediaMissingRows()`
//   （纯 DB 预筛）**不剔除已落标记的歌** → 界面「待修复」随修复/标记推进长期停在原位（生产实测
//   3447 不动、与「已修复 2765 / 终态不可得 N」并列时数字自相矛盾）。现改为 pending = 预筛集合
//   减去「已落完成标记的 fs_path」集合（`getTagRepairMarkedPaths()`，纯 DB 不 stat）——与扫描阶段
//   `isTagRepairMarked` 的跳过口径对齐，待修数随池子收敛同步下降（失效判定仍由扫描阶段负责）。
//
// 【2026-10-17 修正 2·专辑封面回写】第一档 DB 预筛按 `songs.cover_art 空 且 albums.cover_art 空`
//   判定缺封面，而修复只回写 `songs.has_lyrics`、**不刷新 `albums.cover_art`** → 实测 19 首
//   「文件已内嵌封面但专辑行仍无封面」的歌每轮都被当候选重扫（pending 恒高）。现改为：任何一次
//   修复/对账后，若文件有内嵌封面而 `albums.cover_art` 为空，则把内嵌封面落盘到
//   `data/covers/<albumId>.<ext>`（与 scanner.saveCoverArt 同款命名）并回写该列，让待修数真实下降。
//
// 【2026-10-17 修正 3·占位专辑不写】DB 的 `album='Unknown Album'`（scanner 对「无专辑标签文件」
//   的占位值）此前被当有效值写进文件，把「无专辑」变成假专辑名。现把 `Unknown Album`/`未知专辑`
//   视同空值：不参与 needAlbum 兜底，也不作为 needMeta 的「DB 已有值」依据（转为走网络补全）。
//
// 【2026-10-17 修正 4·「已修复」数据源】前端「已修复」此前读 settings 的 `repairedTotal`，
//   它只在**一轮跑完**时 `+= 本轮 fixed+skipped`：全量扫动辄数千首、单轮可跑数小时，期间
//   计数恒定不动；一旦中途容器重启/任务被杀，本轮已真实修复的数百首的计数**全部丢失**
//   （实测：DB `tag_repair_done` 已 184 行，前端仍显示 20）。现改为**直接数完成标记行数**
//   （`getTagRepairRepairedTotal()` → `getTagRepairMarkedCount()`）：每首真正修复/达标即写
//   标记，计数随之实时上升，且天然跨重启保留。相应地，前端不再叠加本轮 progress。
//
// fingerprint 安全性（已核实）：scanner.upsertSong 按 **path** 匹配（非 fingerprint），
// tagWriter 重写容器后重扫只会 UPDATE 该行并从文件头刷新 hasLyrics/album picture，
// 不会产生重复条目——本模块写完顺带自更新 DB has_lyrics，让 UI 立即生效。

import { existsSync, mkdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseFile } from "music-metadata";
import { sqlite } from "../../db/index.js";
import { createLogger } from "../../utils/logger.js";
import { getDataDir } from "../../utils/env.js";
import { getSetting, setSetting } from "../settings.js";
import { searchCover, searchLyrics, searchMetadata } from "../../plugins/providers.js";
import { cacheRemoteCover, resolveCoverFile } from "../playlistCover.js";
import { withCoverLimit } from "../covers.js";
import { FetchTagError, writeTags, applyTagsVariant, tmpPathFor, type SongTags } from "./tagWriter.js";
import { currentFetchConfig } from "./configStore.js";
import type { FetchConfig, TagRepairScope } from "./config.js";
import {
  getTagRepairMarkedCount,
  getTagRepairMarkedPaths,
  getTagRepairPlatformCounts,
  getTagRepairUnobtainableCount,
  isTagRepairMarked,
  markTagRepairDone,
  _resetTagRepairMarkersForTest,
} from "./tagRepairMarker.js";

const log = createLogger("FETCH_TAG_REPAIR");

const QUEUE_KEY = "fetch.tagrepair.queue";
const LAST_RUN_KEY = "fetch.tagrepair.lastRunAt";
const LAST_RESULT_KEY = "fetch.tagrepair.lastResult";
const LAST_RESULTS_KEY = "fetch.tagrepair.lastResults";

/**
 * 进行中一轮标签修复的快照持久化 key（断点续跑 / 立刻停止的数据源）。
 * 存 settings（进程重启不丢）：一轮被打断（进程被杀 / 用户主动停止）后，
 * 全量扫动辄数千首、单轮可跑数小时，若只靠内存态，重启即丢进度、候选池重头再扫一遍。
 */
export const ACTIVE_RUN_KEY = "fetch.tagrepair.activeRun";
/** boot 恢复续跑的延迟：与 jobRunner.BOOT_RESUME_DELAY_MS 同款，避开启动瞬间的 CPU/IO 抢跑。 */
export const TAG_REPAIR_RESUME_DELAY_MS = 60_000;

/** 快照落盘节流：每处理 CHECKPOINT_EVERY 首、或距上次落盘 ≥CHECKPOINT_MS 即落一次（force 立即落）。 */
const CHECKPOINT_EVERY = 100;
const CHECKPOINT_MS = 30_000;
/** 快照里 pendingIds/candidateIds 的容量上限：兜住极端超大库，避免 settings 行无限膨胀。 */
const MAX_SNAPSHOT_IDS = 20_000;

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
 * TAG_FAILED 重试退避（加固 2026-10-17：单次 2s → 3 次指数退避）。
 * 背景：首修全量扫 40 起写失败集中在 11 分钟窗口（NAS 存储层瞬时抖动，绿联 trimacl
 * 短窗内 EACCES / 新建条目不可见 / 条目闪没）；后续生产 `/MUSIC/LOSSLESS` 又实测 8 条
 * `ffmpeg 写标签失败(exit=243) Permission denied`（EACCES，同处一个短窗），
 * 单次 2s 重试不足以吸收 —— 改为 3s → 6s → 12s 共 3 次，仍失败才上抛并打印 errno，
 * 便于区分「瞬时抖动（重试可愈）」与「永久权限问题（需运维介入）」。
 * 仅 TAG_FAILED 重试；TIMEOUT 不重试（可能真慢/真卡），其他错误原样上抛。
 * 可用 `MF_TAG_RETRY_DELAYS_MS`（逗号分隔毫秒）覆盖，测试置 0 以加速。
 */
function tagRetryDelaysMs(): number[] {
  const raw = process.env.MF_TAG_RETRY_DELAYS_MS;
  if (raw !== undefined) return raw.split(",").map((s) => Math.max(0, Number(s) || 0));
  return [3_000, 6_000, 12_000];
}

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
 *  - pending：当前 DB 预筛「缺歌词/封面/专辑」**且未落完成标记**的待修候选数（同第一档口径）；
 *  - repaired：已修复（= `tag_repair_done` 中 outcome≠'unobtainable' 的标记行数，含真写入修复
 *    与「无需修/下载期已达标」两类）；
 *  - unobtainableTotal：终态不可得（= outcome='unobtainable' 的标记行数，已被标记跳过、不再重扫）。 */
export interface TagRepairStats {
  total: number;
  pending: number;
  repaired: number;
  /** 终态不可得总数（真缺标签但各来源都拿不到、已标记跳过不再重扫的歌数；带 30 天 TTL）。 */
  unobtainableTotal: number;
  /** 标签来源分布（按完成标记行的 platform 分组聚合，DB 聚合、无实时探测）：
   *  platform="qq"/"netease"，空串 "" = 历史（未记录来源，旧行 platform 为 NULL）。
   *  只在管理端展示，反映「已修复的歌用的是哪个平台」；**排除**终态不可得行。 */
  platforms: Array<{ platform: string; count: number }>;
}

/**
 * 进行中一轮标签修复的运行快照（存 settings 的 ACTIVE_RUN_KEY，进程重启不丢）。
 * 支持「立刻停止 + 断点续跑」：候选/待探清单与已完成的计数随 checkpoint 落盘；
 * 进程被杀/主动停止后续跑从快照接着跑，不重头计数、不重跑已完成的候选。
 */
export interface TagRepairRunSnapshot {
  version: 1;
  mode: "media" | "all";
  dirScope: TagRepairScope;
  phase: "scan" | "repair";
  startedAt: number;
  updatedAt: number;
  checked: number;
  fixed: number;
  skipped: number;
  unobtainable: number;
  /** 当前阶段仍待处理的 songId 清单：scan 阶段=待精探、repair 阶段=待修复候选。 */
  pendingIds: string[];
  /** scan 阶段累计命中（缺标签）的候选 id：scan 结束即整体转入 pendingIds。 */
  candidateIds: string[];
  /** 正在处理的文件本地路径（供停止/启动清理遗留的半成品 tagtmp）。 */
  currentFsPath: string | null;
  /** 是否被用户主动停止：主动停止的快照不自动复活（boot 恢复会清除并跳过）。 */
  stopped: boolean;
  /** 预留：断点游标回退（当前未使用）。 */
  cursorFallback?: { path: string };
}

/** 运行中进度（仅 running 时非 null）：scan=全量精探阶段 / repair=逐首修复阶段。 */
export interface TagRepairProgress {
  mode: TagRepairMode;
  phase: "scan" | "repair";
  /** 当前阶段总数（scan=待探范围 / repair=候选数）。 */
  total: number;
  /** 当前阶段已处理数；repair 阶段恒等于 fixed + skipped + unobtainable（界面三项拆分之和）。 */
  checked: number;
  /** 本轮实际写文件的歌数。 */
  fixed: number;
  /** 本轮跳过（无需修 / 命中完成标记）的歌数；仅用于本轮进度文案，不参与「已修复」计数。 */
  skipped: number;
  /** 本轮真缺标签但**拿不到**（含探测/写入异常）的歌数；仅用于本轮进度文案。 */
  unobtainable: number;
  startedAt: number;
}

let progress: TagRepairProgress | null = null;

// —— 断点续跑 / 立刻停止的模块级运行态（仅在单飞锁 repairing 期间有值）——
// activeSnapshot：进行中一轮的快照（media/all 才有）；进程被杀也已在 settings 里有对应持久行。
// stopRequested：用户点了停止；sweep 的循环头会检查并立刻退出（不等这首跑完网络请求）。
// lastCheckpointAt/sinceCheckpoint：落盘节流计数（见 checkpoint）。
let activeSnapshot: TagRepairRunSnapshot | null = null;
let stopRequested = false;
let lastCheckpointAt = 0;
let sinceCheckpoint = 0;

/** 运行中进度（供 API/UI 展示）；空闲返回 null。 */
export function getTagRepairProgress(): TagRepairProgress | null {
  return progress;
}

/** 累计已修复歌数（= 完成标记表中 outcome≠'unobtainable' 的行数，实时派生，跨重启保留）。
 *  【2026-10-17 修正 4·已修复数据源】此前为 settings 里的 `repairedTotal` 计数器，
 *  只在**一轮跑完**时才 `+= 本轮 fixed+skipped` —— 全量扫描动辄数千首、单轮可跑数小时，
 *  期间前端「已修复」恒定不动；若中途容器重启/任务被杀，本轮已真实修复的数百首的计数
 *  全部丢失，用户看到的就是「已修复一直停在旧值」。现改为直接数 `tag_repair_done` 行数：
 *  每首真正修复/达标的歌落盘即写标记，计数随即上升，且不受进程重启影响。
 *  【修正 6】口径排除 outcome='unobtainable' 的终态不可得行（那些不是「已修复」）。 */
export function getTagRepairRepairedTotal(): number {
  return getTagRepairMarkedCount();
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
  // 待修口径（2026-10-17 修正 7）：DB 预筛「缺歌词/封面/专辑」**且未落完成标记**的歌。
  // 已落标记（outcome='fixed' 已达标 / 'unobtainable' 终态不可得）的歌在扫描阶段被
  // isTagRepairMarked 跳过、不再重扫；若仍计入 pending，界面「待修复」会随修复/标记推进长期停在
  // 原位，与「已修复 / 终态不可得」并列时数字对不上（用户实测反馈）。此处纯 DB 判定（不 stat）：
  // 标记行按 fs_path 取集合，逐个候选查；失效判定（size/mtime 变）仍由扫描阶段的
  // isTagRepairMarked 负责，故本口径只反映「有标记 = 不再重扫」的稳定值，且随扫描自愈。
  const markedPaths = new Set(getTagRepairMarkedPaths());
  const pending = selectMediaMissingRows().filter((r) => {
    const fsPath = fsPathOf(r.path);
    return Boolean(fsPath && inDownloadRoots(fsPath, cfg) && !markedPaths.has(fsPath));
  }).length;
  statsCache = { at: now, total, pending };
  return statsCache;
}

/** 实时统计（供 API/UI 展示）。 */
export function getTagRepairStats(): TagRepairStats {
  const { total, pending } = dbStats();
  return {
    total,
    pending,
    repaired: getTagRepairRepairedTotal(),
    unobtainableTotal: getTagRepairUnobtainableCount(),
    platforms: getTagRepairPlatformCounts(),
  };
}

// —— 进度写入（仅在一轮运行期间由 sweep/queue 调用；progress 为 null 时全部为 no-op）——

/**
 * 初始化运行中进度。传 resume（续跑）时从快照恢复阶段与计数，避免界面进度跳回 0：
 *  - phase：沿用快照阶段；
 *  - total：repair 阶段快照存不下总候选数 → 用「剩余待处理 + 已处理」近似（进入 repair 后
 *    progressPhase 会用真实候选数覆盖它）；scan 阶段同理近似。
 *  - checked/fixed/skipped/unobtainable：直接取快照值（上一段已完成计数）。
 */
function progressStart(mode: TagRepairMode, resume?: TagRepairRunSnapshot | null): void {
  if (resume) {
    progress = {
      mode,
      phase: resume.phase,
      total: resume.pendingIds.length + resume.checked,
      checked: resume.checked,
      fixed: resume.fixed,
      skipped: resume.skipped,
      unobtainable: resume.unobtainable,
      startedAt: resume.startedAt,
    };
    return;
  }
  progress = {
    mode,
    phase: "scan",
    total: 0,
    checked: 0,
    fixed: 0,
    skipped: 0,
    unobtainable: 0,
    startedAt: Date.now(),
  };
}

/** 切换/重置当前阶段（进入修复阶段或切挡位时重置计数）。
 *  preserve=true（续跑且阶段与快照一致）时**不清零**已恢复的计数，只更新阶段与总数，
 *  否则界面进度会在续跑进入同阶段时跳回 0。 */
function progressPhase(phase: "scan" | "repair", total: number, preserve = false): void {
  if (!progress) return;
  progress.phase = phase;
  // 【2026-10-18 修正 8】传进来的 total 是**本阶段剩余**数；preserve=true（续跑）时 progress.checked
  // 还保留着「本段已处理」计数，故分母必须叠加它（total = checked + 剩余）才是真实总数。
  // 此前直接覆盖：续跑时分母小于已处理数 → 进度提前冲到 100%、界面「待修复」（= total - checked）
  // 提前归零，而实际仍有剩余候选在跑（用户实测反馈）。
  progress.total = preserve ? progress.checked + total : total;
  if (preserve) return;
  progress.checked = 0;
  progress.fixed = 0;
  progress.skipped = 0;
  progress.unobtainable = 0;
}

/** 推进已处理数：按本首结果把 checked 完整拆到 fixed / skipped / unobtainable 三档。
 *  【2026-10-17 修正 5】此前只传 (fixedInc, skipInc) 两个增量，unobtainable 的量被计进
 *  checked 却不归属任何一档 —— 界面「已修复 + 跳过」与「已处理」永远对不上（实测
 *  checked=49 / fixed=7 / skipped=0，42 首无归属）。现按结果直接归位，三档之和恒等 checked。 */
function progressTick(outcome: "fixed" | "unobtainable" | "skip"): void {
  if (!progress) return;
  progress.checked++;
  if (outcome === "fixed") progress.fixed++;
  else if (outcome === "skip") progress.skipped++;
  else progress.unobtainable++;
}

function progressSetChecked(checked: number): void {
  if (progress) progress.checked = checked;
}

function progressEnd(): void {
  progress = null;
}

// ---------------------------------------------------------------------------
// 断点续跑快照（ACTIVE_RUN_KEY）：读写 / 节流落盘 / 停止 / 清理半成品
// ---------------------------------------------------------------------------

/** 读取进行中的修复快照；读不到 / JSON 异常 / 版本不符 → null。 */
function loadActiveRun(): TagRepairRunSnapshot | null {
  try {
    const raw = getSetting(ACTIVE_RUN_KEY, "");
    if (!raw) return null;
    const parsed = JSON.parse(String(raw)) as TagRepairRunSnapshot;
    if (!parsed || typeof parsed !== "object" || parsed.version !== 1) return null;
    return parsed;
  } catch {
    return null;
  }
}

/** 落盘快照（JSON）并刷新 updatedAt。 */
function saveActiveRun(snap: TagRepairRunSnapshot): void {
  snap.updatedAt = Date.now();
  setSetting(ACTIVE_RUN_KEY, JSON.stringify(snap));
}

/** 清除快照（一轮正常跑完 / 主动停止的快照已被 boot 恢复消费时调用）。 */
function clearActiveRun(): void {
  setSetting(ACTIVE_RUN_KEY, "");
}

/** 立即落盘当前快照并重置落盘节流计数（force / 停止 / 阶段切换时用）。 */
function flushActiveRun(): void {
  if (!activeSnapshot) return;
  saveActiveRun(activeSnapshot);
  sinceCheckpoint = 0;
  lastCheckpointAt = Date.now();
}

/**
 * 快照落盘节流：距上次落盘 ≥CHECKPOINT_EVERY 首 **或** ≥CHECKPOINT_MS ms，或 force 时落盘。
 * activeSnapshot 非 null 才落盘（快照只在 media/all 挡位建立），避免高频写 settings；
 * 落盘后更新 updatedAt（供 API 展示与续跑判定）。
 */
function checkpoint(force = false): void {
  if (!activeSnapshot) return;
  if (!force) {
    const now = Date.now();
    if (sinceCheckpoint < CHECKPOINT_EVERY && now - lastCheckpointAt < CHECKPOINT_MS) return;
  }
  flushActiveRun();
}

/** 是否已收到停止请求（sweep 的循环头据此立刻退出）。 */
function shouldStop(): boolean {
  return stopRequested;
}

/**
 * 清理某文件对应的半成品临时文件（`<stem>.tagtmp<ext>`）。
 * 为什么必须清：停止/启动恢复时，上一首可能正写到 tagtmp（进程被杀留下残片），
 * 留在下载目录会被下一次扫描当成「多出来的文件」；这里按当前对象路径精确清掉。
 * 清理失败不影响主流程（写标签成功路径本身也会在 finally 里删 tagtmp）。
 */
function cleanupTagTmp(fsPath: string | null): void {
  if (!fsPath) return;
  try {
    const tmp = tmpPathFor(fsPath, "tagtmp");
    if (existsSync(tmp)) rmSync(tmp, { force: true });
  } catch {
    /* 清理失败不影响主流程 */
  }
}

/** 新建一轮媒体/全量修复的空快照（queue 挡位不建快照）。 */
function newSnapshot(mode: "media" | "all", dirScope: TagRepairScope): TagRepairRunSnapshot {
  const now = Date.now();
  return {
    version: 1,
    mode,
    dirScope,
    phase: "scan",
    startedAt: now,
    updatedAt: now,
    checked: 0,
    fixed: 0,
    skipped: 0,
    unobtainable: 0,
    pendingIds: [],
    candidateIds: [],
    currentFsPath: null,
    stopped: false,
  };
}

/** 取某首歌的本地 fsPath（`l:<src>:<fsPath>`）；不存在 / 非本地 → null。
 *  用于续跑：快照只存了候选 id，repair 阶段需要 fsPath 来记录 currentFsPath（清理半成品）。 */
function fsPathForSongId(songId: string): string | null {
  const row = loadRow(songId);
  return row && row.path ? fsPathOf(row.path) : null;
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
  album_id: string | null;
  source_data: string | null;
  url: string | null;
}

function loadRow(songId: string): RepairRow | null {
  return (
    (sqlite
      .prepare(
        "SELECT id, title, artist, album, duration, path, has_lyrics, album_id, source_data, url FROM songs WHERE id = ?",
      )
      .get(songId) as RepairRow | undefined) ?? null
  );
}

/** scanner 对「文件无专辑标签」写入的占位值；视同「无专辑」，绝不写进成品文件
 *  （否则把「无专辑」变成假专辑名）。只精确匹配这两种；其它值一律当合法专辑名。 */
const ALBUM_PLACEHOLDERS = new Set(["unknown album", "未知专辑"]);
function isAlbumPlaceholder(s: string): boolean {
  return ALBUM_PLACEHOLDERS.has(s.trim().toLowerCase());
}

/** 读取文件内嵌封面（首图）原始字节；无封面或不可解析返回 null。 */
async function readEmbeddedCover(fsPath: string): Promise<{ format: string; data: Buffer } | null> {
  try {
    const mm = await parseFile(fsPath, { duration: false });
    const pics = mm.common.picture;
    const p = Array.isArray(pics) && pics.length ? pics[0] : null;
    if (!p?.data || !p.data.length) return null;
    return { format: String(p.format || "image/jpeg"), data: Buffer.from(p.data) };
  } catch {
    return null;
  }
}

/** 把内嵌封面落盘到 `data/covers/<albumId>.<ext>` 并返回文件引用
 *  （与 scanner.saveCoverArt 同款命名，故与刮削路径产出的专辑封面口径一致）。 */
function saveEmbeddedAlbumCover(albumId: string, pic: { format: string; data: Buffer }): string | null {
  try {
    const ext = pic.format === "image/png" ? "png" : pic.format === "image/gif" ? "gif" : "jpg";
    const dir = join(getDataDir(), "covers");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${albumId}.${ext}`), pic.data);
    return `${albumId}.${ext}`;
  } catch (e) {
    log.warn(`专辑封面落盘失败 album=${albumId}: ${e instanceof Error ? e.message : e}`);
    return null;
  }
}

/**
 * 专辑行原封面为空时，用文件内嵌封面落盘并回写 `albums.cover_art`（幂等）。
 * 为什么必须做：第一档 DB 预筛按 `songs.cover_art 空 && albums.cover_art 空` 判定缺封面，
 * 只看文件头而不回写专辑行 → 「已内嵌封面但专辑行无封面」的歌每轮都被当候选重扫
 * （实测 19 首、pending 恒高）。已有封面则不动（绝不覆盖既有值）。
 */
async function syncAlbumCoverFromEmbedded(fsPath: string, albumId: string | null): Promise<void> {
  if (!albumId) return;
  try {
    const cur = sqlite.prepare("SELECT cover_art FROM albums WHERE id = ?").get(albumId) as
      | { cover_art: string | null }
      | undefined;
    if (!cur) return; // 专辑行不存在（未建）→ 不臆造
    if (String(cur.cover_art ?? "").trim()) return; // 已有封面 → 不动
    const pic = await readEmbeddedCover(fsPath);
    if (!pic) return;
    const ref = saveEmbeddedAlbumCover(albumId, pic);
    if (!ref) return;
    sqlite
      .prepare("UPDATE albums SET cover_art = ?, updated_at = ? WHERE id = ?")
      .run(ref, new Date().toISOString(), albumId);
    log.info(`专辑封面回写 album=${albumId} ref=${ref}（文件已内嵌封面，专辑行原为空）`);
  } catch (e) {
    log.warn(`专辑封面回写失败 album=${albumId}: ${e instanceof Error ? e.message : e}`);
  }
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

  const dbAlbumRaw = String(row.album ?? "").trim();
  // scanner 对「无专辑标签文件」写入的占位值（Unknown Album）视同空：既不作为兜底写进文件
  // （否则把「无专辑」变成假专辑名），也不作为 needMeta 的「DB 已有值」依据（转为走网络补全）。
  const dbAlbum = isAlbumPlaceholder(dbAlbumRaw) ? "" : dbAlbumRaw;
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
    // 文件已内嵌封面、专辑行却无封面 → 落盘内嵌封面并回写 albums.cover_art，否则第一档
    // DB 预筛每轮都按「缺封面」把这首歌选中重扫（实测 19 首、pending 恒高）。
    if (embedded.cover) await syncAlbumCoverFromEmbedded(fsPath, row.album_id);
    // 【2026-10-17 修正 4】文件内嵌标签已齐（各维度都在）→ 登记完成标记：与下载期标记同义
    // （「这首歌已达标」），既让「已修复」统计把它计入、又让后续扫描直接跳过不探针。
    // 注意只在**探针确认齐备**时才会走到这里；文件缺失/不可解析的路径在前面已 return，绝不打标记。
    markTagRepairDone(fsPath, "tag-repair");
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
  // 「谁给的值」：记录命中的 provider id，供修复成功后写完成标记的 src 用（首个内置来源优先，
  // 其次任一命中来源；无 provider 命中时回落 "tag-repair"）。与下载期 orchestrator.collectExtraTags 同款纪律。
  let srcId: string | null = null;
  let srcBuiltin = false;
  // 命中的来源平台（"qq" / "netease"）：取自 searchMetadata() 返回值，供完成标记落 platform、
  // 管理端「标签来源分布」聚合。仅元数据链路能拿到；仅走封面/歌词或 DB 兜底时为 null → 落 NULL。
  let platformId: string | null = null;
  const onMatch = (providerId: string, builtin: boolean): void => {
    if (!srcId || (builtin && !srcBuiltin)) {
      srcId = providerId;
      srcBuiltin = builtin;
    }
  };

  if (needAlbum) {
    // 专辑：DB 声明值即权威（下载时 provider 元数据），直接写，无需网络。
    tags.album = dbAlbum;
  }

  if (needCover) {
    try {
      const url = await withCoverLimit(() => searchCover(songInput, { onMatch }));
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
      const text = await searchLyrics(songInput, { onMatch });
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
      const meta = await searchMetadata(songInput, { onMatch });
      if (meta) {
        if (typeof meta.platform === "string" && meta.platform) platformId = meta.platform;
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
  if (!gotCover && !gotLyric && !gotAlbum && !gotMeta) {
    // 【修正 6·选项 C】真缺但各来源都拿不到 → 登记「终态不可得」标记（带 30 天 TTL）。
    // 让候选池收敛：下轮扫描命中该标记即跳过，不再对同一首歌无限重探/重扫。
    markTagRepairDone(fsPath, srcId ?? "tag-repair", platformId, "unobtainable");
    log.info(`标签终态不可得（已标记跳过）song=${songId} file=${fsPath}`);
    return unobtainable;
  }

  // 中文字形（产品定调 2026-10-16）：写盘前把 provider 文本按用户所选字形转换（默认简体）。
  // 放在这里（而非各取值分支）是为了让「哪些字段要转」与下载期共用同一实现
  // （tagWriter.applyTagsVariant），两条写入路径口径一致。
  applyTagsVariant(tags, currentFetchConfig().chineseVariant);

  // 只在真拿到值时才写 —— tagWriter 原子写（tagtmp+rename），失败抛 FetchTagError。
  // TAG_FAILED 指数退避重试（3s→6s→12s 共 3 次），吸收 NAS 存储层瞬时权限抖动；
  // 原文件保证未被破坏（原子写），重试安全；3 次仍失败才上抛（附路径便于排查）。
  const retryDelays = tagRetryDelaysMs();
  for (let attempt = 0; ; attempt++) {
    try {
      // keepSourceCover：本次不换封面（needCover=false）时必须保留源文件已有封面，
      // 否则「补 genre/track 等缺失标签」的重写会把已有封面一并丢掉（2026-10-17 实测）。
      await writeTags(fsPath, tags, { keepSourceCover: true });
      break;
    } catch (e) {
      if (!(e instanceof FetchTagError) || e.code !== "TAG_FAILED") throw e;
      const delay = retryDelays[attempt];
      if (delay === undefined) {
        log.error(
          `写标签重试 ${retryDelays.length} 次仍失败（疑存储层权限/抖动）: ` +
            `song=${songId} file=${fsPath} err=${e.message}`,
        );
        throw e;
      }
      log.warn(
        `写标签失败，${delay}ms 后重试(第 ${attempt + 1}/${retryDelays.length} 次): ` +
          `song=${songId} file=${fsPath} err=${e.message}`,
      );
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }

  if (gotLyric) {
    sqlite
      .prepare("UPDATE songs SET has_lyrics = 1, updated_at = ? WHERE id = ?")
      .run(new Date().toISOString(), songId);
  } else {
    sqlite.prepare("UPDATE songs SET updated_at = ? WHERE id = ?").run(new Date().toISOString(), songId);
  }
  // 专辑行缺封面（而文件已有内嵌封面）→ 落盘内嵌封面并回写 albums.cover_art，让第一档
  // DB 预筛不再把这首歌当「缺封面」重复选中（见文件头【修正 2·专辑封面回写】）。
  await syncAlbumCoverFromEmbedded(fsPath, row.album_id);
  // 修复**真正写入**后登记「标签修复完成标记」：后续扫描命中且文件未变即跳过（不再探针/联网）。
  // 此前只在下载期标记 → 实测 tag_repair_done 0 行，修过的歌下轮仍被当候选重扫。
  // src 取命中的来源 provider id，无 provider 命中（仅 DB 专辑兜底）时回落 "tag-repair"。
  // platform 取 searchMetadata 命中的平台（qq/netease），透传给完成标记供「标签来源分布」聚合。
  markTagRepairDone(fsPath, srcId ?? "tag-repair", platformId);
  log.info(
    `标签修复完成 song=${songId} file=${fsPath} ` +
      [gotCover ? "+封面" : "", gotLyric ? "+歌词" : "", gotAlbum ? "+专辑" : "", gotMeta ? "+元数据" : ""]
        .filter(Boolean)
        .join("") +
      ` [src=${srcId ?? "tag-repair"} platform=${platformId ?? "-"}]`,
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
    progressTick(o.outcome);
    if (o.outcome === "fixed" || o.outcome === "skip") {
      delete q[songId];
    } else {
      const count = Number(entry?.count ?? 0) + 1;
      if (count >= BACKOFF_MS.length) {
        // 3 败弃权（1h/6h 两轮退避都错过）：移出队列，等定时兜底（常规修复）扫。
        log.info(`[TAG-REPAIR] song=${songId} 连续 ${count} 次拿不到，移出队列（等定时兜底扫）`);
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
  const snap = activeSnapshot;
  // 续跑判定（仅供「从快照接着跑」时启用新逻辑）：
  //   快照里还留着未处理清单（pendingIds/candidateIds 非空）或已进入 repair 阶段 → 续跑。
  //   全新一轮刚建的快照三项皆空 → resuming=false，下面所有新逻辑短路，
  //   行为与改动前**逐字一致**（不传 resume 时既有测试/既有调用点不受影响）。
  const resuming = Boolean(
    snap && (snap.pendingIds.length > 0 || snap.candidateIds.length > 0 || snap.phase === "repair"),
  );
  const resumedRepair = Boolean(resuming && snap && snap.phase === "repair");
  const resumedScan = Boolean(resuming && snap && snap.phase === "scan");
  if (snap && resuming) {
    // 用快照计数预填 result：上一段已完成的固定/跳过/拿不到不再从 0 重头计。
    result.checked = snap.checked;
    result.fixed = snap.fixed;
    result.skipped = snap.skipped;
    result.unobtainable = snap.unobtainable;
  }

  const candidates: Array<{ id: string; fsPath: string }> = [];
  // 命中「下载期内置插件已打好且文件未变」标记而跳过的歌数：计入「已修复·跳过」。
  let markedSkipped = 0;
  /** 把 result 计数同步进快照后按节流落盘；skipped 计入本阶段标记跳过数，续跑计数才对得上。 */
  const syncAndCheckpoint = (force = false): void => {
    if (!snap) return;
    snap.checked = result.checked;
    snap.fixed = result.fixed;
    snap.skipped = result.skipped + markedSkipped;
    snap.unobtainable = result.unobtainable;
    checkpoint(force);
  };

  if (resumedRepair) {
    // 续跑·修复阶段：候选直接取快照剩余清单（不再重跑 DB 预筛 / 全量精探），
    // 避免「已落标记 / DB 已变」把剩余候选从预筛结果里挤掉、丢剩余待修歌。
    for (const id of snap!.pendingIds) {
      const fsPath = fsPathForSongId(id);
      if (fsPath) candidates.push({ id, fsPath });
    }
    // 顺便剔除已无法解析 fsPath 的脏 id（如已从库中删除/非本地路径），避免每轮续跑重复尝试。
    snap!.pendingIds = candidates.map((c) => c.id);
    log.info(
      `[TAG-REPAIR] ${scope === "media" ? "常规" : "全量"}续跑（范围 ${dirScope}）：从快照恢复剩余候选 ${candidates.length} 首`,
    );
  } else if (scope === "media") {
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
    // 进入 repair 前把候选清单写进快照：中断后续跑可直接取用，不再重跑本次预筛。
    if (snap) {
      snap.phase = "repair";
      snap.pendingIds = candidates.map((c) => c.id).slice(0, MAX_SNAPSHOT_IDS);
      syncAndCheckpoint(true);
    }
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

    // 待精探清单：续跑（scan 阶段）只保留快照里的剩余项、并按快照顺序遍历（已探过的跳过）；
    // 全新一轮则把全部范围内 id 写进快照，供进程被杀/停止后续跑。
    let probeList = inRoot;
    if (resumedScan) {
      const byId = new Map(inRoot.map((r) => [r.id, r] as const));
      const remain = snap!.pendingIds.filter((id) => byId.has(id));
      snap!.pendingIds = remain; // 丢弃已从库中消失的 id（不必再探）
      probeList = remain.map((id) => byId.get(id)!);
    } else if (snap) {
      snap.pendingIds = inRoot.map((r) => r.id).slice(0, MAX_SNAPSHOT_IDS);
      snap.phase = "scan";
    }

    // ① 文件头精探（只读）：封面/歌词/专辑/专辑艺术家/轨/年/流派任一缺失即候选
    //    （album 有 DB 值兜底、无需网络也能修；其余缺失回落 searchMetadata）。
    //    碟号不参与缺失判定（成品本就不带碟号）。
    //    续跑时不把进度计数清零（resumedScan），已处理进度接着上次显示。
    progressPhase("scan", probeList.length, resumedScan);
    let probed = 0;
    for (const { id, fsPath } of probeList) {
      // 循环头检查停止请求：本轮立刻退出（不等这一首探完），未探项留在快照里供续跑。
      if (stopRequested) break;
      probed++;
      progressSetChecked(probed);
      // 下载期已由内置标签来源插件打好、且文件未变 → 不探针直接跳过（算「已修复·跳过」）。
      if (isTagRepairMarked(fsPath)) {
        markedSkipped++;
      } else {
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
          // 命中候选登记进快照：scan 结束后整体转入 pendingIds，供修复阶段续跑。
          if (snap && snap.candidateIds.length < MAX_SNAPSHOT_IDS) snap.candidateIds.push(id);
        }
      }
      if (probed % 1000 === 0) log.info(`[TAG-REPAIR] 全量探针进度 ${probed}/${probeList.length}，候选 ${candidates.length}`);
      // 断点：这一首已处理完 → 从快照待探清单移除该 id（顺序与遍历一致，正常即 shift）。
      if (snap) {
        if (snap.pendingIds[0] === id) snap.pendingIds.shift();
        else {
          const i = snap.pendingIds.indexOf(id);
          if (i >= 0) snap.pendingIds.splice(i, 1);
        }
      }
      sinceCheckpoint++;
      syncAndCheckpoint();
    }
    log.info(
      `[TAG-REPAIR] 全量扫描${resumedScan ? "续跑" : ""}完成（范围 ${dirScope}）：范围 ${probed} 首，` +
        `标记跳过 ${markedSkipped} 首，待修复候选 ${candidates.length} 首`,
    );
    // scan 结束（未停止）→ 进入 repair：候选清单转 pendingIds、清空 candidateIds 并立即落盘。
    if (snap && !stopRequested) {
      snap.phase = "repair";
      snap.pendingIds = snap.candidateIds.slice(0, MAX_SNAPSHOT_IDS);
      snap.candidateIds = [];
      syncAndCheckpoint(true);
    }
  }
  // 把扫描阶段的标记跳过数并入 result.skipped 后清零 markedSkipped：
  // 之前 syncAndCheckpoint 用「result.skipped + markedSkipped」拼快照（那时 result.skipped 尚未含
  // markedSkipped）；此处并入后若不清零，后续 repair 阶段的 syncAndCheckpoint 会把它重复计入。
  result.skipped += markedSkipped;
  markedSkipped = 0;

  // 停止请求 → 直接返回：未跑完的候选留在快照 pendingIds 里，供下次续跑。
  if (shouldStop()) return result;

  // ② 逐首修复（repairSongTags 内部再探一次拿得到才写）。
  progressPhase("repair", candidates.length, resumedRepair);
  for (const { id, fsPath } of candidates) {
    // 循环头检查停止请求：本轮立刻退出，未修复候选留在快照 pendingIds 里供续跑。
    if (stopRequested) break;
    // 处理前记录当前对象路径：进程被杀/主动停止时据此清理半成品 tagtmp。
    if (snap) {
      snap.currentFsPath = fsPath;
      syncAndCheckpoint();
    }
    result.checked++;
    let o: RepairSongOutcome;
    try {
      o = await repairSongTags(id, cfg);
    } catch (e) {
      log.warn(`全量修复异常 song=${id}: ${e instanceof Error ? e.message : e}`);
      o = { outcome: "unobtainable", cover: false, lyric: false, album: false, meta: false };
    }
    accumulate(result, o);
    progressTick(o.outcome);
    // 断点：这一首已修复完 → 从快照剩余清单移除该 id（顺序与候选一致，正常即 shift）。
    if (snap) {
      if (snap.pendingIds[0] === id) snap.pendingIds.shift();
      else {
        const i = snap.pendingIds.indexOf(id);
        if (i >= 0) snap.pendingIds.splice(i, 1);
      }
    }
    sinceCheckpoint++;
    syncAndCheckpoint();
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
 * resume（可选）为断点续跑快照：传入即从该快照接着跑（boot 恢复用）；不传则为全新一轮。
 * 单飞：进行中返回 { busy: true }。
 */
export async function runTagRepairOnce(
  mode: TagRepairMode,
  cfgOver?: FetchConfig,
  dirScopeOver?: TagRepairScope,
  resume: TagRepairRunSnapshot | null = null,
): Promise<{ busy: boolean; result?: TagRepairResult; stopped?: boolean }> {
  if (repairing) return { busy: true };
  repairing = true;
  stopRequested = false;
  // 续跑沿用传入快照；queue 挡位不落快照（activeSnapshot 保持 null）。
  activeSnapshot = resume;
  progressStart(mode, activeSnapshot);
  // 是否走完全程（正常完成）。供 finally 判断：进程内异常退出的残留快照必须清掉，
  // 否则它会把调度器定时兜底永久顶住（见 finally 注释）。
  let completedNormally = false;
  try {
    const cfg = cfgOver ?? currentFetchConfig();
    const dirScope: TagRepairScope = dirScopeOver ?? cfg.tagRepairScope ?? "both";
    // media/all 且非续跑 → 新建快照（供本轮断点续跑/停止用）。
    if (!activeSnapshot && (mode === "media" || mode === "all")) {
      activeSnapshot = newSnapshot(mode, dirScope);
    }
    let result: TagRepairResult;
    if (mode === "all") {
      const sweep = await sweepTagRepair(cfg, "all", dirScope);
      result = sweep;
      // 收到停止请求则不再清队列（半轮不再叠加额外工作）。
      if (!stopRequested) {
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
      }
    } else if (mode === "media") {
      // 第一档常规：仅 DB 预筛，不清队列。
      result = await sweepTagRepair(cfg, "media", dirScope);
    } else {
      result = await processTagRepairQueue(cfg);
    }
    // 停止分支：本轮被 stopTagRepair 提前中断。
    // 半轮不得冒充「一轮完成」—— 不写 lastResult、不推进 lastRunAt（到点标记）；
    // 快照已在 stopTagRepair 里落盘（stopped=true），保留供 boot/下次续跑判定。
    if (stopRequested && (mode === "media" || mode === "all")) {
      log.info(`[TAG-REPAIR] ${mode} 一轮已按请求停止（快照标记已停止，不会自动续跑）`);
      return { busy: false, result, stopped: true };
    }
    completedNormally = true; // 走完全程（非停止/非异常）→ 允许 finally 正常收尾
    // lastRunAt 是定时兜底扫的到点标记：定时兜底现在跑「第一档·常规修复」（见
    // startTagRepairScheduler），故由 all / media 两个挡位推进 —— 手动点这两个按钮同样推进，
    // 避免刚手动跑完又被定时立刻重跑同一轮。队列挡位是非穷尽操作，不推进。
    if (mode === "all" || mode === "media") setSetting(LAST_RUN_KEY, String(Date.now()));
    statsCache = null; // 待修候选数变了，下次查询重算
    saveLastResult(mode, result);
    // 正常跑完 → 清快照（本轮无剩余，无需续跑）。
    clearActiveRun();
    log.info(
      `[TAG-REPAIR] ${mode} 一轮完成（范围 ${dirScope}）：检查 ${result.checked}，修复 ${result.fixed} 首` +
        `（封面 ${result.coverFixed} / 歌词 ${result.lyricFixed} / 专辑 ${result.albumFixed} / 元数据 ${result.metaFixed}），` +
        `拿不到 ${result.unobtainable}，无需修/跳过 ${result.skipped}`,
    );
    return { busy: false, result };
  } finally {
    // 进程内异常退出（非正常完成、非用户主动停止）→ 清掉残留的未停止快照。
    // 否则调度器 tick 的 hasResumableActiveRun() 会被它永久顶住，定时常规修复被无限期跳过。
    // 真·崩溃（进程被杀）不会执行到这里，快照保留 → 由 boot 续跑。
    if (!completedNormally && !stopRequested) clearActiveRun();
    activeSnapshot = null;
    // 停止标志随本轮结束复位：否则 UI 的「停止中…」会在一轮已结束后永久挂着
    // （isTagRepairStopping 读的正是它）。
    stopRequested = false;
    repairing = false;
    progressEnd();
  }
}

export function isTagRepairRunning(): boolean {
  return repairing;
}

/** 是否已收到停止请求（UI 可据此显示「停止中…」）。 */
export function isTagRepairStopping(): boolean {
  return stopRequested;
}

/** 进行中的修复快照（供 API 展示；运行中取内存态，空闲时回落到持久化快照）；无则 null。 */
export function getTagRepairActiveRun(): TagRepairRunSnapshot | null {
  return activeSnapshot ?? loadActiveRun();
}

/** 是否存在「可续跑」的进行中快照（未主动停止）。供调度器 tick 防抢跑判定。 */
export function hasResumableActiveRun(): boolean {
  const snap = activeSnapshot ?? loadActiveRun();
  return Boolean(snap && !snap.stopped);
}

/**
 * 立刻停止当前一轮标签修复。
 * - 未在跑 → 返回 { requested:false, running:false }（无事可停）；
 * - 在跑 → 置停止标志（sweep 循环头检查会立刻退出）、把快照落盘并标 stopped=true
 *   （供 boot 恢复识别为「主动停止」不复活）、清掉在写的半成品 tagtmp；
 * - 顺延 lastRunAt（D2=A）：把定时兜底扫往后推，避免停止后立刻又被定时拉起重扫同一轮。
 * 注意：仅置标志、不等本轮真正结束；真正收尾在 runTagRepairOnce 的停止分支。
 */
export function stopTagRepair(): { requested: boolean; running: boolean } {
  if (!repairing) return { requested: false, running: false };
  stopRequested = true;
  if (activeSnapshot) {
    activeSnapshot.stopped = true;
    saveActiveRun(activeSnapshot); // 立即落盘，不等节流
  }
  setSetting(LAST_RUN_KEY, String(Date.now()));
  cleanupTagTmp(activeSnapshot?.currentFsPath ?? null);
  return { requested: true, running: true };
}

/**
 * boot 恢复：上一进程遗留的进行中一轮修复按快照自动续跑。
 * - 无快照 → 不续；
 * - 快照标记 stopped（用户主动停止）→ 清快照、不复活；
 * - 已在跑 → 不重复起；
 * - 否则清掉遗留半成品 tagtmp 后，从快照断点续跑（单飞锁保护，重复调用安全）。
 */
export function resumeInterruptedTagRepair(): { resumed: boolean; mode?: TagRepairMode } {
  const snap = loadActiveRun();
  if (!snap) return { resumed: false };
  if (snap.stopped) {
    clearActiveRun();
    return { resumed: false };
  }
  if (isTagRepairRunning()) return { resumed: false };
  cleanupTagTmp(snap.currentFsPath);
  // 异步续跑：这里不 await（boot 接线用 setTimeout 触发，不该阻塞启动）。必须挂 catch，
  // 否则 runTagRepairOnce 抛错（如本轮 cfg 读取失败）会变成 unhandled rejection 打挂进程。
  void runTagRepairOnce(snap.mode, undefined, snap.dirScope, snap).catch((e: any) => {
    log.error(`[TAG-REPAIR] boot 续跑失败: ${e?.message || e}`);
  });
  return { resumed: true, mode: snap.mode };
}

let started = false;
let ticking = false;

/** 挂载调度循环（幂等）：每分钟 tick —— ① 处理到期队列项；② 到期定时常规修复扫（第一档）。 */
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
        // 若存在「可续跑」的进行中快照（进程重启遗留/刚被 boot 恢复接管），跳过定时兜底：
        // 否则 15s 的首个 tick 会抢在 60s 续跑之前把同一轮又拉起来重跑一遍（重复劳动+抢占网络）。
        if (hasResumableActiveRun()) return;
        // ② 定时兜底：到点才跑「第一档·常规修复」(media，仅 DB 预筛、成本低)，给下载期因网络
        //    波动漏打标签的歌补标签（lastRunAt 持久化，重启不重复触发）。第二档全量修复改为仅手动触发。
        const last = Number(getSetting(LAST_RUN_KEY, "0")) || 0;
        const intervalMs = Math.max(1, Math.floor(cfg.tagRepairIntervalHours || 168)) * 3_600_000;
        if (Date.now() - last >= intervalMs) {
          await runTagRepairOnce("media", cfg);
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

/** 测试复位（清全部状态 + 单飞锁 + 断点续跑态）。 */
export function _resetTagRepairForTest(): void {
  saveQueue({});
  setSetting(LAST_RUN_KEY, "0");
  setSetting(LAST_RESULT_KEY, "");
  setSetting(LAST_RESULTS_KEY, "");
  setSetting(ACTIVE_RUN_KEY, "");
  repairing = false;
  ticking = false;
  progress = null;
  statsCache = null;
  // 断点续跑/停止的模块级运行态一并清干净，避免用例间顺序耦合。
  activeSnapshot = null;
  stopRequested = false;
  sinceCheckpoint = 0;
  lastCheckpointAt = 0;
  _resetTagRepairMarkersForTest();
}

// statSync 引用保留给未来「跳过在途文件（mtime 新鲜度）」用；当前探针+原子写已足够安全。
void statSync;
