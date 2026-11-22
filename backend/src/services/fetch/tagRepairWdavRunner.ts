// ==================== WebDAV 标签修复：任务运行器（可续跑） ====================
//
// 与本地修复（sweepTagRepair）**并行存在、互不干扰**：本地那套绑定 fsPath / 终态标记 /
// ffmpeg，云盘这套是「整文件进内存 → 改标签 → 回传」，判据一致但执行路径完全不同。
//
// 关键设计（用户定的三条）：
//   1) 只修**缺**标签的（内嵌或 DB 任一维度为空才算候选）；
//   2) 一首一首来，串行，不追速度；
//   3) 进程重启后**接着跑**——候选清单与计数落在 settings 里，每首结束强制落盘。
//
// 目录递归：目标目录用前缀匹配（path LIKE 'w:<src>:<dir>/%'），自然覆盖所有子目录。
import { sqlite } from "../../db/index.js";
import { createLogger } from "../../utils/logger.js";

const log = createLogger("wdav-repair");
import { getSetting, setSetting } from "../settings.js";
import { repairWebdavSongTags, type WdavRepairRow } from "./tagRepairWdav.js";
import { currentFetchConfig } from "./configStore.js";

export interface WdavTarget {
  sourceId: string;
  /** 以 / 开头、无尾斜杠的绝对目录（如 /共享/天翼网盘/音乐/马天宇） */
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
  /** 当前正在处理的那首（给前端显示"在做哪首/哪一步"） */
  current: { songId: string; title: string } | null;
  startedAt: number;
  updatedAt: number;
  finishedAt: number | null;
  lastError: string | null;
}

interface WdavSnapshot {
  version: 1;
  targets: WdavTarget[];
  dryRun: boolean;
  pendingIds: string[];
  total: number;
  done: number;
  fixed: number;
  skipped: number;
  failed: number;
  startedAt: number;
  updatedAt: number;
}

const SNAP_KEY = "fetch.tagrepair.wdavRun";
const MAX_IDS = 200_000;

let state: WdavRepairState | null = null;
let stopRequested = false;
let runningPromise: Promise<void> | null = null;

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

/** 候选：选中目录（递归）下、DB 五项任一缺失的歌。 */
function selectWdavRows(targets: WdavTarget[]): WdavRepairRow[] {
  if (!targets.length) return [];
  const clauses = targets.map(() => "(s.path LIKE ? AND (s.has_lyrics IS NULL OR s.has_lyrics = 0 OR " +
    "COALESCE(TRIM(s.album),'') = '' OR LOWER(TRIM(COALESCE(s.album,''))) IN ('unknown album','未知专辑') OR " +
    "COALESCE(TRIM(s.title),'') = '' OR COALESCE(TRIM(s.artist),'') = '' OR " +
    "(COALESCE(TRIM(s.cover_art),'') = '' AND (s.album_id IS NULL OR COALESCE(TRIM(a.cover_art),'') = ''))))");
  const params: string[] = [];
  for (const t of targets) params.push(`w:${t.sourceId}:${t.dir}/%`);
  const sql =
    "SELECT s.id AS id, s.title AS title, s.artist AS artist, s.album AS album, s.duration AS duration, " +
    "s.path AS path, s.has_lyrics AS has_lyrics, s.album_id AS album_id, s.source_data AS source_data, s.url AS url " +
    "FROM songs s LEFT JOIN albums a ON a.id = s.album_id WHERE " +
    clauses.join(" OR ");
  return sqlite.prepare(sql).all(...params) as WdavRepairRow[];
}

function saveSnapshot(snap: WdavSnapshot): void {
  snap.updatedAt = Date.now();
  setSetting(SNAP_KEY, JSON.stringify(snap));
}

function clearSnapshot(): void {
  setSetting(SNAP_KEY, "");
}

function loadSnapshot(): WdavSnapshot | null {
  try {
    const raw = getSetting(SNAP_KEY, "");
    if (!raw) return null;
    const snap = JSON.parse(raw) as WdavSnapshot;
    if (!snap || snap.version !== 1 || !Array.isArray(snap.pendingIds)) return null;
    return snap;
  } catch {
    return null;
  }
}

/** 预演：只统计候选数量与预估耗时（不读文件、不写任何东西）。 */
export function previewWdavRepair(targetsInput: WdavTarget[]): {
  targets: WdavTarget[];
  candidates: number;
  estSeconds: number;
} {
  const targets = targetsInput.map(normalizeTarget).filter((t): t is WdavTarget => Boolean(t));
  const rows = selectWdavRows(targets);
  // 实测：下载 4.4MB/s + 上传 2.2MB/s，25MB flac ≈ 17s/首（含取词/取封面耗时按 3s 计）
  const estSeconds = Math.round(rows.length * 20);
  return { targets, candidates: rows.length, estSeconds };
}

async function runLoop(snap: WdavSnapshot): Promise<void> {
  const cfg = currentFetchConfig();
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

  while (snap.pendingIds.length > 0) {
    if (stopRequested) {
      log.info(`[wdav-repair] 收到停止请求，剩余 ${snap.pendingIds.length} 首留在快照里`);
      break;
    }
    const id = snap.pendingIds[0];
    const dbRow = sqlite
      .prepare(
        "SELECT id, title, artist, album, duration, path, has_lyrics, album_id, source_data, url FROM songs WHERE id = ?",
      )
      .get(id) as WdavRepairRow | undefined;
    if (!dbRow) {
      // 歌已被删除：直接出队，不占进度
      snap.pendingIds.shift();
      saveSnapshot(snap);
      continue;
    }

    if (state) {
      state.current = { songId: id, title: dbRow.title ?? "" };
      state.total = snap.total;
      state.done = snap.done;
      state.fixed = snap.fixed;
      state.skipped = snap.skipped;
      state.failed = snap.failed;
      state.updatedAt = Date.now();
    }

    try {
      const out = await repairWebdavSongTags(dbRow, cfg);
      if (out.outcome === "fixed") snap.fixed += 1;
      else if (out.outcome === "unobtainable") snap.skipped += 1;
      else snap.skipped += 1;
      if (out.note) log.info(`[wdav-repair] ${dbRow.title}: ${out.note}`);
    } catch (e) {
      snap.failed += 1;
      const msg = e instanceof Error ? e.message : String(e);
      log.warn(`[wdav-repair] 失败 song=${id} ${msg}`);
      if (state) state.lastError = msg;
    }

    snap.done += 1;
    snap.pendingIds.shift();
    saveSnapshot(snap); // 每首强制落盘：重启最多重做当前这一首
    if (state) {
      state.done = snap.done;
      state.fixed = snap.fixed;
      state.skipped = snap.skipped;
      state.failed = snap.failed;
      state.updatedAt = Date.now();
    }
    // 轻节流：给播放/其它请求让路（用户要求不追速度）
    await sleep(300);
  }

  if (state) {
    state.running = false;
    state.stopping = false;
    state.current = null;
    state.updatedAt = Date.now();
    state.finishedAt = Date.now();
  }
  const left = snap.pendingIds.length;
  if (left === 0) clearSnapshot();
  log.info(
    `[wdav-repair] 结束：共 ${snap.total} 首，修复 ${snap.fixed} / 跳过 ${snap.skipped} / 失败 ${snap.failed}` +
      (left ? `，剩余 ${left} 首待续跑` : ""),
  );
}

/** 启动（或续跑）一次云盘修复。running 中重复调用直接返回当前状态。 */
export async function startWdavRepair(opts: {
  targets?: WdavTarget[];
  dryRun?: boolean;
  resume?: boolean;
}): Promise<WdavRepairState> {
  if (state?.running) return state;

  let snap: WdavSnapshot | null = null;
  if (opts.resume) {
    snap = loadSnapshot();
  }
  if (!snap) {
    const targets = (opts.targets ?? []).map(normalizeTarget).filter((t): t is WdavTarget => Boolean(t));
    if (!targets.length) throw new Error("未选择任何云盘目录");
    const rows = selectWdavRows(targets);
    snap = {
      version: 1,
      targets,
      dryRun: Boolean(opts.dryRun),
      pendingIds: rows.map((r) => r.id).slice(0, MAX_IDS),
      total: rows.length,
      done: 0,
      fixed: 0,
      skipped: 0,
      failed: 0,
      startedAt: Date.now(),
      updatedAt: Date.now(),
    };
    saveSnapshot(snap);
  }

  stopRequested = false;
  state = {
    running: true,
    dryRun: snap.dryRun,
    stopping: false,
    targets: snap.targets,
    total: snap.total,
    done: snap.done,
    fixed: snap.fixed,
    skipped: snap.skipped,
    failed: snap.failed,
    current: null,
    startedAt: snap.startedAt,
    updatedAt: Date.now(),
    finishedAt: null,
    lastError: null,
  };

  if (snap.dryRun) {
    state.running = false;
    state.finishedAt = Date.now();
    clearSnapshot();
    return state;
  }

  log.info(
    `[wdav-repair] 启动：目标 ${snap.targets.length} 个目录，共 ${snap.total} 首` +
      (snap.done > 0 ? `（续跑，已完成 ${snap.done}）` : ""),
  );
  runningPromise = runLoop(snap).catch((e) => {
    log.error(`[wdav-repair] 异常中止: ${e instanceof Error ? e.message : e}`);
    if (state) {
      state.running = false;
      state.lastError = e instanceof Error ? e.message : String(e);
    }
  });
  void runningPromise;
  return state;
}

/** 进程启动时调用：有未完成快照就自动接着跑。 */
export function resumeWdavRepairOnBoot(): { resumed: boolean; remaining?: number } {
  if (state?.running) return { resumed: false }; // 已有一轮在跑（如启动后立刻手动触发）
  const snap = loadSnapshot();
  if (!snap || snap.pendingIds.length === 0 || snap.dryRun) return { resumed: false };
  log.info(`[wdav-repair] 检测到未完成任务，续跑剩余 ${snap.pendingIds.length} 首`);
  void startWdavRepair({ resume: true });
  return { resumed: true, remaining: snap.pendingIds.length };
}

/** 测试用：清掉内存态与快照。 */
export function _resetWdavRepairForTest(): void {
  state = null;
  stopRequested = false;
  runningPromise = null;
  clearSnapshot();
}
