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
// 修复目标与取值来源（产品定调 2026-10-11）：
//   - 封面 / 歌词：**先探测、拿得到才写**——searchCover/searchLyrics 拿不到就不碰
//     文件（绝不写空值/占位图）。
//   - 专辑：文件内嵌 album 为空而 DB 行有声明值（下载时 provider 元数据入库）→
//     直接用 DB 值回写，无需网络。
//   写入复用 tagWriter 的 tagtmp+rename 原子语义，失败不破坏原文件。
//   范围硬锁定两个下载目录，绝不碰 WebDAV 云盘库。
//
// fingerprint 安全性（已核实）：scanner.upsertSong 按 **path** 匹配（非 fingerprint），
// tagWriter 重写容器后重扫只会 UPDATE 该行并从文件头刷新 hasLyrics/album picture，
// 不会产生重复条目——本模块写完顺带自更新 DB has_lyrics，让 UI 立即生效。

import { existsSync, statSync } from "node:fs";
import { parseFile } from "music-metadata";
import { sqlite } from "../../db/index.js";
import { createLogger } from "../../utils/logger.js";
import { getSetting, setSetting } from "../settings.js";
import { searchCover, searchLyrics } from "../../plugins/providers.js";
import { cacheRemoteCover, resolveCoverFile } from "../playlistCover.js";
import { withCoverLimit } from "../covers.js";
import { writeTags } from "./tagWriter.js";
import { currentFetchConfig } from "./configStore.js";
import type { FetchConfig } from "./config.js";

const log = createLogger("FETCH_TAG_REPAIR");

const QUEUE_KEY = "fetch.tagrepair.queue";
const LAST_RUN_KEY = "fetch.tagrepair.lastRunAt";
const LAST_RESULT_KEY = "fetch.tagrepair.lastResult";

/** 事件队列重试退避（第 1/2/3 次失败的下次重试间隔）。 */
const BACKOFF_MS = [3_600_000, 6 * 3_600_000, 24 * 3_600_000] as const;
/** 下载终态入队的初始延迟：给终态自动增量扫描留时间（songs 行建立后修复才有意义）。 */
const INITIAL_DELAY_MS = 10 * 60_000;
/** 队列单次 tick 最多处理的歌数（gentle：不与前台请求抢网络）。 */
const QUEUE_BATCH = 10;
/** 调度轮询/启动延迟（与 upgradeScheduler 同款）。 */
const POLL_MS = 60_000;
const BOOT_DELAY_MS = 15_000;

interface QueueEntry {
  count: number;
  nextAt: number;
}

type QueueMap = Record<string, QueueEntry>;

export interface TagRepairResult {
  checked: number;
  /** 修复动作统计：一轮内实际写进文件的封面/歌词/专辑次数（一首可能多项）。 */
  coverFixed: number;
  lyricFixed: number;
  albumFixed: number;
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

function saveLastResult(mode: string, r: TagRepairResult): void {
  setSetting(LAST_RESULT_KEY, JSON.stringify({ ...r, at: Date.now(), mode }));
}

/** 队列规模（供 API/UI 展示）。 */
export function getTagRepairQueueSize(): number {
  return Object.keys(loadQueue()).length;
}

// ---------------------------------------------------------------------------
// 探针：文件头内嵌封面/歌词/专辑（music-metadata 统一处理 flac/mp3/m4a/ogg）
// ---------------------------------------------------------------------------

/** 返回 null = 文件不可解析（不确定，保守跳过不写）。 */
async function probeEmbedded(fsPath: string): Promise<{ cover: boolean; lyric: boolean; album: boolean } | null> {
  try {
    const mm = await parseFile(fsPath, { duration: false });
    return {
      cover: Array.isArray(mm.common.picture) && mm.common.picture.length > 0,
      lyric: Array.isArray(mm.common.lyrics) && mm.common.lyrics.some((l) => String(l || "").trim()),
      album: Boolean(String(mm.common.album ?? "").trim()),
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
}

/**
 * 修复一首：探缺 → 先探测拿得到 → 才写文件 → 回写 DB。
 * skip = 标签其实齐/文件不可用（不重试）；unobtainable = 真缺但拿不到（进退避）。
 */
export async function repairSongTags(songId: string, cfg: FetchConfig): Promise<RepairSongOutcome> {
  const none: RepairSongOutcome = { outcome: "skip", cover: false, lyric: false, album: false };
  const unobtainable: RepairSongOutcome = { outcome: "unobtainable", cover: false, lyric: false, album: false };
  const row = loadRow(songId);
  if (!row || !row.path) return none;
  const fsPath = fsPathOf(row.path);
  if (!fsPath || !inDownloadRoots(fsPath, cfg) || !existsSync(fsPath)) return none;

  const embedded = await probeEmbedded(fsPath);
  if (!embedded) return none; // 不可解析的文件不动（保守）

  const needCover = !embedded.cover;
  const needLyric = !embedded.lyric && !row.has_lyrics;
  const needAlbum = !embedded.album && Boolean(String(row.album ?? "").trim());
  if (!needCover && !needLyric && !needAlbum) {
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

  const tags: { cover?: string; lyric?: string; album?: string } = {};

  if (needAlbum) {
    // 专辑：DB 声明值即权威（下载时 provider 元数据），直接写，无需网络。
    tags.album = String(row.album).trim();
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

  const gotCover = Boolean(tags.cover);
  const gotLyric = Boolean(tags.lyric);
  const gotAlbum = Boolean(tags.album);
  if (!gotCover && !gotLyric && !gotAlbum) return unobtainable;

  // 只在真拿到值时才写 —— tagWriter 原子写（tagtmp+rename），失败抛 FetchTagError。
  await writeTags(fsPath, tags);

  if (gotLyric) {
    sqlite
      .prepare("UPDATE songs SET has_lyrics = 1, updated_at = ? WHERE id = ?")
      .run(new Date().toISOString(), songId);
  } else {
    sqlite.prepare("UPDATE songs SET updated_at = ? WHERE id = ?").run(new Date().toISOString(), songId);
  }
  log.info(
    `标签修复完成 song=${songId} file=${fsPath} ` +
      [gotCover ? "+封面" : "", gotLyric ? "+歌词" : "", gotAlbum ? "+专辑" : ""].filter(Boolean).join(""),
  );
  return { outcome: "fixed", cover: gotCover, lyric: gotLyric, album: gotAlbum };
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
  return { checked: 0, coverFixed: 0, lyricFixed: 0, albumFixed: 0, unobtainable: 0, skipped: 0, fixed: 0 };
}

function accumulate(result: TagRepairResult, o: RepairSongOutcome): void {
  if (o.outcome === "fixed") {
    result.fixed++;
    if (o.cover) result.coverFixed++;
    if (o.lyric) result.lyricFixed++;
    if (o.album) result.albumFixed++;
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

  for (const [songId, entry] of due.slice(0, QUEUE_BATCH)) {
    result.checked++;
    let o: RepairSongOutcome;
    try {
      o = await repairSongTags(songId, cfg);
    } catch (e) {
      log.warn(`队列修复异常 song=${songId}: ${e instanceof Error ? e.message : e}`);
      o = { outcome: "unobtainable", cover: false, lyric: false, album: false };
    }
    accumulate(result, o);
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
// 全量兜底扫
// ---------------------------------------------------------------------------

/** 全量扫两个下载目录：文件头精探内嵌封面/歌词/专辑，只修真缺的。 */
export async function sweepTagRepair(cfg: FetchConfig): Promise<TagRepairResult> {
  const rows = sqlite
    .prepare("SELECT id, path, has_lyrics, album FROM songs WHERE path LIKE 'l:%'")
    .all() as Array<{ id: string; path: string; has_lyrics: number | null; album: string | null }>;
  const result = emptyResult();

  // ① 文件头精探（只读）：三个维度都齐的快速跳过； album 有 DB 值兜底、无需探测即可修。
  const candidates: Array<{ id: string; fsPath: string }> = [];
  let probed = 0;
  for (const r of rows) {
    const fsPath = fsPathOf(r.path);
    if (!fsPath || !inDownloadRoots(fsPath, cfg)) continue;
    probed++;
    const embedded = await probeEmbedded(fsPath);
    const needAlbum = !embedded?.album && Boolean(String(r.album ?? "").trim());
    if (embedded && (!embedded.cover || !embedded.lyric || needAlbum)) {
      candidates.push({ id: r.id, fsPath });
    }
    if (probed % 1000 === 0) log.info(`[TAG-REPAIR] 全量探针进度 ${probed}/${rows.length}，候选 ${candidates.length}`);
  }
  log.info(`[TAG-REPAIR] 全量扫描完成：范围 ${probed} 首，待修复候选 ${candidates.length} 首`);

  // ② 逐首修复（repairSongTags 内部再探一次拿得到才写）。
  for (const { id } of candidates) {
    result.checked++;
    let o: RepairSongOutcome;
    try {
      o = await repairSongTags(id, cfg);
    } catch (e) {
      log.warn(`全量修复异常 song=${id}: ${e instanceof Error ? e.message : e}`);
      o = { outcome: "unobtainable", cover: false, lyric: false, album: false };
    }
    accumulate(result, o);
  }
  return result;
}

// ---------------------------------------------------------------------------
// 统一入口 + 调度
// ---------------------------------------------------------------------------

let repairing = false;

/**
 * 跑一轮修复（手动触发按钮与调度共用）。
 * mode "queue"=只处理到期队列项；"full"=先全量兜底扫、再清队列。
 * 单飞：进行中返回 { busy: true }。
 */
export async function runTagRepairOnce(
  mode: "queue" | "full",
  cfgOver?: FetchConfig,
): Promise<{ busy: boolean; result?: TagRepairResult }> {
  if (repairing) return { busy: true };
  repairing = true;
  try {
    const cfg = cfgOver ?? currentFetchConfig();
    let result: TagRepairResult;
    if (mode === "full") {
      result = await sweepTagRepair(cfg);
      // 全量后队列里遗留的到期项一并清一轮（3 败弃权的不再重试）。
      const qr = await processTagRepairQueue(cfg);
      result.checked += qr.checked;
      result.fixed += qr.fixed;
      result.coverFixed += qr.coverFixed;
      result.lyricFixed += qr.lyricFixed;
      result.albumFixed += qr.albumFixed;
      result.unobtainable += qr.unobtainable;
      result.skipped += qr.skipped;
    } else {
      result = await processTagRepairQueue(cfg);
    }
    setSetting(LAST_RUN_KEY, String(Date.now()));
    saveLastResult(mode, result);
    log.info(
      `[TAG-REPAIR] ${mode} 一轮完成：检查 ${result.checked}，修复 ${result.fixed} 首` +
        `（封面 ${result.coverFixed} / 歌词 ${result.lyricFixed} / 专辑 ${result.albumFixed}），` +
        `拿不到 ${result.unobtainable}，无需修 ${result.skipped}`,
    );
    return { busy: false, result };
  } finally {
    repairing = false;
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
          await runTagRepairOnce("full", cfg);
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
  repairing = false;
  ticking = false;
}

// statSync 引用保留给未来「跳过在途文件（mtime 新鲜度）」用；当前探针+原子写已足够安全。
void statSync;
