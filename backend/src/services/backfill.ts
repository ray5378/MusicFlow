// 歌词/封面批量补全任务(C 手动按钮)。
// 节流:顺序执行 + 每首 120ms 延迟,避免打满 provider 与沙箱 in-flight 限流。
// job 状态存主进程内存,供前端轮询进度;同一种任务同时只允许一个在跑。
//
// 方案3(v1.7.75+):实际补全循环(候选查询 + 逐首调用)迁移到一次性批量子进程
// (`runBatchJob("backfill", { kind })`),峰值内存随子进程退出归还;主进程只保留
// 计数查询(SELECT COUNT)与状态转发(子进程 progress 经 IPC 落回 jobs[kind])。
// 前端契约不变:POST /v1/{lyrics,covers}/backfill 立即返回 {accepted,total,running},
// GET /v1/{lyrics,covers}/backfill/status 轮询进度。
import { sqlite } from "../db/index.js";
import fs from "fs";
import { searchLyrics } from "../plugins/providers.js";
import { fetchCoverForSong, runCoverBackfill } from "./covers.js";
import { saveLyricFile } from "./lyricsStore.js";
import { runBatchJob } from "../batch/runner.js";

export type BackfillKind = "lyrics" | "covers" | "covers-batch";

export interface BackfillJob {
  kind: BackfillKind;
  running: boolean;
  total: number;
  done: number;
  ok: number;
  fail: number;
  skipped: number;
  currentId: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  error?: string;
}

const idle = (kind: BackfillKind): BackfillJob => ({
  kind, running: false, total: 0, done: 0, ok: 0, fail: 0, skipped: 0,
  currentId: null, startedAt: null, finishedAt: null,
});

const jobs: Record<BackfillKind, BackfillJob> = {
  lyrics: idle("lyrics"),
  covers: idle("covers"),
  "covers-batch": idle("covers-batch"),
};

export function backfillStatus(kind: BackfillKind): BackfillJob {
  return jobs[kind];
}

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

function isLocalWithSidecar(path: string): boolean {
  try {
    const colon1 = path.indexOf(":");
    if (colon1 < 0) return false;
    const prefix = path.slice(0, colon1);
    if (prefix !== "l") return false;
    const rest = path.slice(colon1 + 1);
    const colon2 = rest.indexOf(":");
    if (colon2 < 0) return false;
    const filePath = rest.slice(colon2 + 1);
    const lrcPath = filePath.replace(/\.[^.]+$/, "") + ".lrc";
    return fs.existsSync(lrcPath);
  } catch {
    return false;
  }
}

// ---- 子进程侧 worker(纯函数,child 可 import;不做任何父进程状态) ----

function whereClause(kind: BackfillKind): string {
  if (kind === "lyrics") return "lyrics IS NULL OR lyrics = ''";
  return "cover_art IS NULL OR cover_art = ''";
}

/** 候选总数(轻量 COUNT,主进程同步返回给 startBackfill 契约)。 */
export function countCandidates(kind: BackfillKind): number {
  const row = sqlite.prepare(`SELECT COUNT(*) AS c FROM songs WHERE ${whereClause(kind)}`).get() as any;
  return Number(row?.c ?? 0);
}

/** 候选全量(SELECT,子进程内跑;内存随子进程退出归还)。 */
export function collectCandidates(kind: BackfillKind): any[] {
  if (kind === "lyrics") {
    return sqlite.prepare(
      `SELECT id, title, artist, album, duration, path, type, url, plugin_entry, source_data
         FROM songs WHERE ${whereClause(kind)}`,
    ).all() as any[];
  }
  return sqlite.prepare(
    `SELECT id, title, artist, album, duration, cover_art
       FROM songs WHERE ${whereClause(kind)}`,
  ).all() as any[];
}

export interface BackfillWorkerResult {
  total: number;
  done: number;
  ok: number;
  fail: number;
  skipped: number;
}

export interface BackfillWorkerProgress {
  done: number;
  ok: number;
  fail: number;
  skipped: number;
  currentId: string | null;
}

/** 顺序补全(lyrics / covers):逐首调用 provider,每首 120ms 节流。 */
export async function runBackfillLoop(
  kind: "lyrics" | "covers",
  rows: any[],
  onProgress?: (p: BackfillWorkerProgress) => void,
  signal?: AbortSignal,
): Promise<BackfillWorkerResult> {
  let done = 0, ok = 0, fail = 0, skipped = 0;
  for (const song of rows) {
    if (signal?.aborted) break;
    try {
      let found = false;
      if (kind === "lyrics") {
        // 本地歌曲已有 sidecar .lrc → 读时 sidecar 优先,无需拉取覆盖 DB
        if (isLocalWithSidecar(song.path)) { skipped++; done++; onProgress?.({ done, ok, fail, skipped, currentId: song.id }); continue; }
        let sourceData: any = null;
        try { sourceData = JSON.parse(song.source_data || "{}"); } catch {}
        const lrc = await searchLyrics({
          url: song.url,
          duration: song.duration,
          title: song.title,
          artist: song.artist,
          album: song.album,
          source: sourceData?.source || undefined,
          extra: sourceData?.extra || null,
        });
        if (lrc) {
          // C 批量补全总是落库:写 online-lyrics/<id>.lrc 文件 + songs.lyrics 存引用
          // (与封面同构;其目的就是建离线歌词库)。
          const ref = saveLyricFile(song.id, lrc);
          if (ref) sqlite.prepare("UPDATE songs SET lyrics = ? WHERE id = ?").run(ref, song.id);
          found = true;
        }
      } else {
        // force=true:绕过"已尝试"门控,由本循环节流
        const ref = await fetchCoverForSong(song, true);
        found = !!ref;
      }
      if (found) ok++; else fail++;
    } catch {
      fail++;
    }
    done++;
    onProgress?.({ done, ok, fail, skipped, currentId: song.id });
    await delay(120);
  }
  onProgress?.({ done, ok, fail, skipped, currentId: null });
  return { total: rows.length, done, ok, fail, skipped };
}

/**
 * covers-batch:并发批量补封面。复用 runCoverBackfill(内部 ≤2 并发 + 全局限流),
 * 按 200 首/块顺序推进,避免一次性载入全库。
 */
export async function runBackfillChunked(
  ids: string[],
  onProgress?: (p: BackfillWorkerProgress) => void,
  signal?: AbortSignal,
): Promise<BackfillWorkerResult> {
  const CHUNK = 200;
  let done = 0, ok = 0, fail = 0;
  for (let off = 0; off < ids.length; off += CHUNK) {
    if (signal?.aborted) break;
    const chunk = ids.slice(off, off + CHUNK);
    try {
      const r = await runCoverBackfill(chunk);
      ok += r.ok;
      fail += r.fail;
      done += r.ok + r.fail;
    } catch {
      fail += chunk.length;
      done += chunk.length;
    }
    onProgress?.({ done, ok, fail, skipped: 0, currentId: null });
  }
  onProgress?.({ done, ok, fail, skipped: 0, currentId: null });
  return { total: ids.length, done, ok, fail, skipped: 0 };
}

// ---- 主进程侧编排 ----

// 实际执行器:默认 fork 一次性批量子进程(方案3);测试可注入进程内直调,避免真实 fork。
type BackfillRunner = (
  kind: BackfillKind,
  onProgress: (p: any) => void,
) => Promise<BackfillWorkerResult>;

let runBackfillExec: BackfillRunner = (kind, onProgress) =>
  runBatchJob("backfill", { kind }, { onProgress }).then(r => r.result);

/** 测试钩子:替换批量子进程运行实现(仅供测试,生产禁止)。 */
export function _setBackfillRunnerForTest(fn: BackfillRunner | null): void {
  runBackfillExec = fn ?? ((kind, onProgress) =>
    runBatchJob("backfill", { kind }, { onProgress }).then(r => r.result));
}

/** 测试专用:清空补全任务状态(避免用例间共享模块级 Map 串扰)。 */
export function _resetBackfillJobsForTest(): void {
  for (const k of Object.keys(jobs) as BackfillKind[]) jobs[k] = idle(k);
}

/** 把子进程 progress 落回主进程状态。 */
function applyProgress(kind: BackfillKind, p: any): void {
  const job = jobs[kind];
  if (!job) return;
  if (p && typeof p.total === "number") job.total = p.total;
  if (p && typeof p.done === "number") job.done = p.done;
  if (p && typeof p.ok === "number") job.ok = p.ok;
  if (p && typeof p.fail === "number") job.fail = p.fail;
  if (p && typeof p.skipped === "number") job.skipped = p.skipped;
  if (p && p.currentId !== undefined) job.currentId = p.currentId;
}

/**
 * 启动批量补全。同种任务已在跑则直接返回当前状态(running=true)。
 * 候选总数走轻量 COUNT 同步返回(契约不变);全量查询 + 逐首补全在一次性子进程内跑。
 */
export function startBackfill(kind: BackfillKind): { accepted: boolean; total: number; running: boolean } {
  const job = jobs[kind];
  if (job.running) return { accepted: false, total: job.total, running: true };
  const total = countCandidates(kind);
  jobs[kind] = {
    kind, running: true, total, done: 0, ok: 0, fail: 0, skipped: 0,
    currentId: null, startedAt: new Date().toISOString(), finishedAt: null, error: undefined,
  };
  (async () => {
    try {
      const result = await runBackfillExec(kind, (p) => applyProgress(kind, p));
      const j = jobs[kind];
      if (j) {
        if (typeof result?.total === "number") j.total = result.total;
        if (typeof result?.done === "number") j.done = result.done;
        if (typeof result?.ok === "number") j.ok = result.ok;
        if (typeof result?.fail === "number") j.fail = result.fail;
        if (typeof result?.skipped === "number") j.skipped = result.skipped;
        j.running = false;
        j.currentId = null;
        j.finishedAt = new Date().toISOString();
      }
    } catch (e: any) {
      const j = jobs[kind];
      if (j) {
        j.running = false;
        j.currentId = null;
        j.finishedAt = new Date().toISOString();
        j.error = String((e && e.message) || e);
      }
    }
  })();
  return { accepted: true, total, running: true };
}