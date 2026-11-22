// ==================== WebDAV 标签修复：任务运行器（游标式进度，可续跑） ====================
//
// 进度用「游标」而不是「待办清单」（2026-11-23 重做）：
//   旧做法把 4.6 万个 songId 塞进 settings 一条记录（1.8MB），每处理一首就整体重写一次，
//   既慢到 1 首/秒，重启后整份失效时又表现为「从零开始」。
//   现在只记 `{ lastPath, done, fixed… }`（两百字节），候选按 path 升序取，续跑就是
//   `WHERE path > lastPath` 接着往后走；稳定排序保证不漏不重。
//
// 其余约定不变：只修**缺**标签的、一首一首串行、全程内存不落盘。
// 目录递归：目标目录用前缀匹配（path LIKE 'w:<src>:<dir>/%'），自然覆盖所有子目录。
import { sqlite } from "../../db/index.js";
import { createLogger } from "../../utils/logger.js";
import { getSetting, setSetting } from "../settings.js";
import { repairWebdavSongTags, type WdavRepairRow } from "./tagRepairWdav.js";
import { currentFetchConfig } from "./configStore.js";

const log = createLogger("wdav-repair");

export interface WdavTarget {
  sourceId: string;
  /** 以 / 开头、无尾斜杠的绝对目录（如 /dav/共享/天翼网盘/音乐/马天宇） */
  dir: string;
}

export interface WdavRepairState {
  running: boolean;
  dryRun: boolean;
  stopping: boolean;
  targets: WdavTarget[];
  total: number;
  done: number;
  fixed: number;
  skipped: number;
  failed: number;
  current: { songId: string; title: string } | null;
  startedAt: number;
  updatedAt: number;
  finishedAt: number | null;
  lastError: string | null;
}

/** 进度记录（v2）：只有游标与计数，几十字节。 */
export interface WdavProgress {
  version: 2;
  targets: WdavTarget[];
  dryRun: boolean;
  /** 已处理到的最后一个 path（含）；续跑从它之后开始 */
  lastPath: string;
  total: number;
  done: number;
  fixed: number;
  skipped: number;
  failed: number;
  startedAt: number;
  updatedAt: number;
  /** 本轮是否已结束（正常跑完或用户主动停止）；boot 只续跑未结束的 */
  finished: boolean;
}

const PROGRESS_KEY = "fetch.tagrepair.wdavProgress";
const BATCH = 200;
/** 连续写盘失败熔断阈值（网关整段拒绝写入时及时收手） */
const MAX_CONSECUTIVE_ERRORS = 5;

let state: WdavRepairState | null = null;
let stopRequested = false;

export function getWdavRepairState(): WdavRepairState | null {
  return state;
}

export function isWdavRepairRunning(): boolean {
  return state?.running === true;
}

export function stopWdavRepair(): { requested: boolean; running: boolean } {
  const running = state?.running === true;
  if (running && state) state.stopping = true;
  stopRequested = true;
  return { requested: true, running };
}

function normalizeTarget(t: WdavTarget): WdavTarget | null {
  const sourceId = String(t?.sourceId || "").trim();
  let dir = String(t?.dir || "").trim();
  if (!sourceId) return null;
  if (!dir.startsWith("/")) dir = "/" + dir;
  dir = dir.replace(/\/+$/, "");
  return { sourceId, dir };
}

function candidateClauses(targets: WdavTarget[]): { where: string; params: string[] } {
  const clauses = targets.map(
    () =>
      "(s.path LIKE ? AND (s.has_lyrics IS NULL OR s.has_lyrics = 0 OR " +
      "COALESCE(TRIM(s.album),'') = '' OR LOWER(TRIM(COALESCE(s.album,''))) IN ('unknown album','未知专辑') OR " +
      "COALESCE(TRIM(s.title),'') = '' OR COALESCE(TRIM(s.artist),'') = '' OR " +
      "(COALESCE(TRIM(s.cover_art),'') = '' AND (s.album_id IS NULL OR COALESCE(TRIM(a.cover_art),'') = ''))))",
  );
  const params = targets.map((t) => `w:${t.sourceId}:${t.dir}/%`);
  return { where: clauses.join(" OR "), params };
}

/** 候选：选中目录（递归）下、DB 五项任一缺失的歌，按 path 升序（游标依赖稳定序）。 */
function selectWdavRows(targets: WdavTarget[], afterPath: string, limit: number): WdavRepairRow[] {
  if (!targets.length) return [];
  const { where, params } = candidateClauses(targets);
  const sql =
    "SELECT s.id AS id, s.title AS title, s.artist AS artist, s.album AS album, s.duration AS duration, " +
    "s.path AS path, s.has_lyrics AS has_lyrics, s.album_id AS album_id, s.source_data AS source_data, s.url AS url " +
    "FROM songs s LEFT JOIN albums a ON a.id = s.album_id WHERE (" +
    where +
    ") AND s.path > ? ORDER BY s.path ASC LIMIT ?";
  return sqlite.prepare(sql).all(...params, afterPath, limit) as WdavRepairRow[];
}

function countCandidates(targets: WdavTarget[]): number {
  if (!targets.length) return 0;
  const { where, params } = candidateClauses(targets);
  const row = sqlite
    .prepare("SELECT COUNT(*) c FROM songs s LEFT JOIN albums a ON a.id = s.album_id WHERE " + where)
    .get(...params) as { c: number };
  return row.c;
}

function saveProgress(p: WdavProgress): void {
  p.updatedAt = Date.now();
  setSetting(PROGRESS_KEY, JSON.stringify(p));
}

function loadProgress(): WdavProgress | null {
  try {
    const raw = getSetting(PROGRESS_KEY, "");
    if (!raw) return null;
    const p = JSON.parse(raw) as WdavProgress;
    if (!p || p.version !== 2 || !Array.isArray(p.targets)) return null;
    return p;
  } catch {
    return null;
  }
}

function clearProgress(): void {
  setSetting(PROGRESS_KEY, "");
}

export function getWdavProgressInfo(): WdavProgress | null {
  return loadProgress();
}

/** 预演：只统计候选数量与预估耗时（不读文件、不写任何东西）。 */
export function previewWdavRepair(targetsInput: WdavTarget[]): {
  targets: WdavTarget[];
  candidates: number;
  estSeconds: number;
} {
  const targets = targetsInput.map(normalizeTarget).filter((t): t is WdavTarget => Boolean(t));
  const candidates = countCandidates(targets);
  // 读头 ~1s/首；真正要修的按 5% 比例、每首 20s 摊销
  const estSeconds = Math.round(candidates + candidates * 0.05 * 20);
  return { targets, candidates, estSeconds };
}

function syncState(p: WdavProgress): void {
  if (!state) return;
  state.total = Math.max(state.total, p.total);
  state.done = p.done;
  state.fixed = p.fixed;
  state.skipped = p.skipped;
  state.failed = p.failed;
  state.updatedAt = Date.now();
}

async function runLoop(p: WdavProgress): Promise<void> {
  const cfg = currentFetchConfig();
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  let cursor = p.lastPath;
  let sinceYield = 0;
  let consecutiveErrors = 0;

  while (!stopRequested) {
    const rows = selectWdavRows(p.targets, cursor, BATCH);
    if (!rows.length) break;
    for (const row of rows) {
      if (stopRequested) break;
      if (state) state.current = { songId: row.id, title: row.title ?? "" };
      try {
        const out = await repairWebdavSongTags(row, cfg);
        if (out.outcome === "fixed") p.fixed += 1;
        else if (out.outcome === "error") {
          // 写盘失败：**不前进游标**，这首歌留在原位等下一轮重试；
          // 连续失败到阈值就熔断（网关整段拒绝写入时，继续跑只会把剩下的全标成失败）。
          p.failed += 1;
          consecutiveErrors += 1;
          if (state) state.lastError = out.note ?? "写盘失败";
          log.warn(`[wdav-repair] 写盘失败 song=${row.id} ${row.title}: ${out.note ?? ""}`);
          if (consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
            log.error(
              `[wdav-repair] 连续 ${consecutiveErrors} 首写入失败，熔断本轮（进度停在 ${p.done}/${p.total}）`,
            );
            break;
          }
          saveProgress(p);
          syncState(p);
          if (++sinceYield % 50 === 0) await sleep(200);
          continue; // 游标不动
        } else p.skipped += 1;
        if (out.note) log.info(`[wdav-repair] ${row.title}: ${out.note}`);
      } catch (e) {
        p.failed += 1;
        const msg = e instanceof Error ? e.message : String(e);
        log.warn(`[wdav-repair] 失败 song=${row.id} ${msg}`);
        if (state) state.lastError = msg;
        consecutiveErrors += 1;
        if (consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) break;
        saveProgress(p);
        syncState(p);
        continue;
      }
      consecutiveErrors = 0;
      p.done += 1;
      cursor = row.path;
      p.lastPath = cursor;
      saveProgress(p); // 每首落一次：几十字节，代价可忽略，重启不丢进度
      syncState(p);
      if (++sinceYield % 50 === 0) await sleep(200); // 轻节流，给播放/其它请求让路
    }
  }

  p.finished = true;
  saveProgress(p);
  if (state) {
    state.running = false;
    state.stopping = false;
    state.current = null;
    state.finishedAt = Date.now();
  }
  log.info(
    `[wdav-repair] 本轮结束：${p.done}/${p.total}，修复 ${p.fixed} / 跳过 ${p.skipped} / 失败 ${p.failed}`,
  );
}

/** 启动新任务，或从游标续跑。 */
export async function startWdavRepair(opts: {
  targets?: WdavTarget[];
  dryRun?: boolean;
  resume?: boolean;
  fresh?: boolean;
}): Promise<WdavRepairState> {
  if (state?.running) return state;

  let p: WdavProgress | null = null;
  if (opts.resume) p = loadProgress();
  if (p && p.finished) p = null; // 已结束的进度不再续跑

  if (!p || opts.fresh) {
    const targets = (opts.targets ?? []).map(normalizeTarget).filter((t): t is WdavTarget => Boolean(t));
    // 同一个目标重复点「开始」**不能从零重来**：已有未完成的同目标进度就接着跑。
    // （前端不会区分"新任务/续跑"，用户重启后再点一次开始，是最容易踩到这条的路径）
    const prev = loadProgress();
    const sameTargets =
      prev &&
      prev.targets.length === targets.length &&
      prev.targets.every((t) => targets.some((x) => x.sourceId === t.sourceId && x.dir === t.dir));
    // 同一目标再次「开始」：无论上轮是跑完还是被停止，都从已有游标继续 —— 只有 fresh 才清零。
    if (!opts.fresh && prev && sameTargets) {
      p = prev;
      p.finished = false;
      log.info(`[wdav-repair] 目标与已有进度一致 ⇒ 继续（已完成 ${p.done}/${p.total}）`);
    } else if (!targets.length) {
      if (!prev) throw new Error("未选择任何云盘目录");
      p = prev;
      p.finished = false;
    } else {
      p = {
        version: 2,
        targets,
        dryRun: Boolean(opts.dryRun),
        lastPath: "",
        total: countCandidates(targets),
        done: 0,
        fixed: 0,
        skipped: 0,
        failed: 0,
        startedAt: Date.now(),
        updatedAt: Date.now(),
        finished: false,
      };
    }
    saveProgress(p);
  }

  if (p.dryRun) {
    clearProgress();
    state = {
      running: false,
      dryRun: true,
      stopping: false,
      targets: p.targets,
      total: p.total,
      done: 0,
      fixed: 0,
      skipped: 0,
      failed: 0,
      current: null,
      startedAt: p.startedAt,
      updatedAt: Date.now(),
      finishedAt: Date.now(),
      lastError: null,
    };
    return state;
  }

  stopRequested = false;
  state = {
    running: true,
    dryRun: false,
    stopping: false,
    targets: p.targets,
    total: Math.max(p.total, p.done),
    done: p.done,
    fixed: p.fixed,
    skipped: p.skipped,
    failed: p.failed,
    current: null,
    startedAt: p.startedAt,
    updatedAt: Date.now(),
    finishedAt: null,
    lastError: null,
  };
  log.info(
    `[wdav-repair] 启动：${p.targets.length} 个目录，共 ${p.total} 首` +
      (p.done > 0 ? `（续跑：已完成 ${p.done}）` : ""),
  );
  void runLoop(p).catch((e) => {
    log.error(`[wdav-repair] 异常中止: ${e instanceof Error ? e.message : e}`);
    if (state) {
      state.running = false;
      state.lastError = e instanceof Error ? e.message : String(e);
    }
  });
  return state;
}

/** 进程启动时调用：有未跑完的进度就按游标接着跑（绝不从零重来）。 */
export function resumeWdavRepairOnBoot(): { resumed: boolean; done?: number; total?: number } {
  if (state?.running) return { resumed: false };
  const p = loadProgress();
  if (!p || p.finished) return { resumed: false };
  log.info(`[wdav-repair] boot 续跑：已完成 ${p.done}/${p.total}，从游标继续`);
  void startWdavRepair({ resume: true });
  return { resumed: true, done: p.done, total: p.total };
}

/** 测试用：清掉内存态与进度。 */
export function _resetWdavRepairForTest(): void {
  state = null;
  stopRequested = false;
  clearProgress();
}
