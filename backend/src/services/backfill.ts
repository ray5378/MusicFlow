// 歌词/封面批量补全任务(C 手动按钮)。
// 节流:顺序执行 + 每首 120ms 延迟,避免打满 provider 与沙箱 in-flight 限流。
// job 状态存内存,供前端轮询进度;同一种任务同时只允许一个在跑。
import { sqlite } from "../db/index.js";
import fs from "fs";
import { searchLyrics } from "../plugins/providers.js";
import { fetchCoverForSong } from "./covers.js";
import { saveLyricFile } from "./lyricsStore.js";

export type BackfillKind = "lyrics" | "covers";

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
}

const idle = (kind: BackfillKind): BackfillJob => ({
  kind, running: false, total: 0, done: 0, ok: 0, fail: 0, skipped: 0,
  currentId: null, startedAt: null, finishedAt: null,
});

const jobs: Record<BackfillKind, BackfillJob> = { lyrics: idle("lyrics"), covers: idle("covers") };

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

function collectCandidates(kind: BackfillKind): any[] {
  if (kind === "lyrics") {
    return sqlite.prepare(
      `SELECT id, title, artist, album, duration, path, type, url, plugin_entry, source_data
         FROM songs WHERE lyrics IS NULL OR lyrics = ''`,
    ).all() as any[];
  }
  return sqlite.prepare(
    `SELECT id, title, artist, album, duration, cover_art
       FROM songs WHERE cover_art IS NULL OR cover_art = ''`,
  ).all() as any[];
}

async function runLoop(kind: BackfillKind, rows: any[]) {
  const job = jobs[kind];
  for (const song of rows) {
    if (!job.running) break;
    job.currentId = song.id;
    try {
      let found = false;
      if (kind === "lyrics") {
        // 本地歌曲已有 sidecar .lrc → 读时 sidecar 优先,无需拉取覆盖 DB
        if (isLocalWithSidecar(song.path)) { job.skipped++; job.done++; continue; }
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
      if (found) job.ok++; else job.fail++;
    } catch {
      job.fail++;
    }
    job.done++;
    await delay(120);
  }
  job.running = false;
  job.currentId = null;
  job.finishedAt = new Date().toISOString();
}

/**
 * 启动批量补全。同种任务已在跑则直接返回当前状态(running=true)。
 */
export function startBackfill(kind: BackfillKind): { accepted: boolean; total: number; running: boolean } {
  const job = jobs[kind];
  if (job.running) return { accepted: false, total: job.total, running: true };
  const rows = collectCandidates(kind);
  jobs[kind] = {
    kind, running: true, total: rows.length, done: 0, ok: 0, fail: 0, skipped: 0,
    currentId: null, startedAt: new Date().toISOString(), finishedAt: null,
  };
  void runLoop(kind, rows);
  return { accepted: true, total: rows.length, running: true };
}
