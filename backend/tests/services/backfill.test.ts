// 歌词/封面批量补全(services/backfill.ts)的候选口径、逐首循环与子进程编排。
//
// 该模块是「C 手动按钮」的核心:主进程只保留 COUNT 与状态转发,真正的逐首补全
// 跑在一次性批量子进程里。此前只有 tests/batch/jobsBehavior.test.ts 从批量子进程
// 侧面碰过它,以下三块**一行未跑**:
//   ① 候选口径 whereClause —— 歌词「有/没有」的区分(lyrics 引用 or has_lyrics=1),
//      封面「本地歌+专辑已有封面 → 不算候选」的那条排除(与执行期守卫同口径,
//      否则整座本地库会永远留在候选集里,界面数字点了不降);
//   ② runBackfillLoop 的逐首分支(sidecar 跳过 / 命中落库 / 未命中 / 抛错 / abort);
//   ③ startBackfill 的编排(重复启动直接返回、progress 落回状态、runner 抛错记账)。
//
// MUST be the first import: redirects DATA_DIR to an isolated temp dir.
import "../plugins/_env.js";

import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from "vitest";
import fs from "fs";
import path from "path";
import { initDatabase, sqlite } from "../../src/db/index.js";

const H = vi.hoisted(() => ({
  searchLyrics: vi.fn(),
  fetchCoverForSong: vi.fn(),
  runCoverBackfill: vi.fn(),
  runBatchJob: vi.fn(),
}));

vi.mock("../../src/plugins/providers.js", () => ({ searchLyrics: H.searchLyrics }));
vi.mock("../../src/services/covers.js", () => ({
  fetchCoverForSong: H.fetchCoverForSong,
  runCoverBackfill: H.runCoverBackfill,
}));
vi.mock("../../src/batch/runner.js", () => ({ runBatchJob: H.runBatchJob }));

import {
  countCandidates,
  collectCandidates,
  runBackfillLoop,
  runBackfillChunked,
  startBackfill,
  backfillStatus,
  _setBackfillRunnerForTest,
  _resetBackfillJobsForTest,
} from "../../src/services/backfill.js";

const ISO = "2026-09-27T00:00:00.000Z";

function dataDir(): string {
  return process.env.DATA_DIR as string;
}

function seedSong(
  id: string,
  opts: {
    type?: string;
    albumId?: string | null;
    coverArt?: string | null;
    lyrics?: string | null;
    hasLyrics?: number | null;
    pathPrefix?: string;
    filePath?: string;
  } = {},
) {
  const p = opts.filePath ?? `${dataDir()}/${id}.mp3`;
  sqlite
    .prepare(
      `INSERT INTO songs (id, title, artist, album, album_id, duration, path, suffix, type, cover_art, lyrics, has_lyrics, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    )
    .run(
      id,
      id,
      "A",
      "Al",
      opts.albumId === undefined ? null : opts.albumId,
      100,
      `${opts.pathPrefix ?? "l:src:"}${p}`,
      "mp3",
      opts.type ?? "local",
      opts.coverArt === undefined ? null : opts.coverArt,
      opts.lyrics === undefined ? null : opts.lyrics,
      opts.hasLyrics === undefined ? null : opts.hasLyrics,
      ISO,
    );
}

function seedAlbum(id: string, coverArt: string | null) {
  sqlite
    .prepare("INSERT INTO albums (id, name, cover_art, created_at, updated_at) VALUES (?,?,?,?,?)")
    .run(id, id, coverArt, ISO, ISO);
}

const rowsOf = (r: any[]) => r.map((x) => x.id).sort();

async function waitJobDone(kind: "lyrics" | "covers" | "covers-batch") {
  const t0 = Date.now();
  while (backfillStatus(kind).running && Date.now() - t0 < 8000) {
    await new Promise((r) => setTimeout(r, 10));
  }
  return backfillStatus(kind);
}

beforeAll(() => {
  if (!process.env.APP_VERSION) process.env.APP_VERSION = "1.0.0";
  initDatabase();
});

beforeEach(() => {
  sqlite.prepare("DELETE FROM songs").run();
  sqlite.prepare("DELETE FROM albums").run();
  _resetBackfillJobsForTest();
  _setBackfillRunnerForTest(null);
  H.searchLyrics.mockReset();
  H.fetchCoverForSong.mockReset();
  H.runCoverBackfill.mockReset();
  H.runBatchJob.mockReset();
  H.runBatchJob.mockResolvedValue({ result: { total: 0, done: 0, ok: 0, fail: 0, skipped: 0 } });
});

afterEach(() => {
  _setBackfillRunnerForTest(null);
  _resetBackfillJobsForTest();
});

describe("候选口径 whereClause", () => {
  it("歌词候选:只有「没有歌词」的歌才算(lyrics 引用 / has_lyrics=1 都视为已有)", () => {
    seedSong("a-nolyrics");
    seedSong("b-haslyrics", { hasLyrics: 1 });
    seedSong("c-lyricsref", { lyrics: "online-lyrics/c.lrc" });
    seedSong("d-explicit-none", { hasLyrics: 0 });

    expect(countCandidates("lyrics")).toBe(2);
    expect(rowsOf(collectCandidates("lyrics"))).toEqual(["a-nolyrics", "d-explicit-none"]);
  });

  it("歌词候选行带子进程需要的字段(path / url / plugin_entry / source_data)", () => {
    seedSong("a-1");
    const row = collectCandidates("lyrics")[0];
    for (const k of ["id", "title", "artist", "album", "duration", "path", "type", "url", "plugin_entry", "source_data"]) {
      expect(Object.keys(row)).toContain(k);
    }
  });

  it("封面候选:本地歌 + 专辑已有封面 → 不算候选(与执行期守卫同口径)", () => {
    seedAlbum("AL-cover", "al-cover.jpg");
    seedAlbum("AL-bare", null);
    seedSong("l1-local-covered", { type: "local", albumId: "AL-cover" });
    seedSong("l2-local-bare", { type: "local", albumId: "AL-bare" });
    seedSong("l3-no-album", { type: "local", albumId: null });
    seedSong("w1-web", { type: "web" });
    seedSong("l4-already-has-cover", { type: "local", coverArt: "x.jpg" });

    expect(rowsOf(collectCandidates("covers"))).toEqual([
      "l2-local-bare",
      "l3-no-album",
      "w1-web",
    ]);
  });

  it("封面候选行带 type / album_id(执行期守卫依据)", () => {
    seedSong("w1-web", { type: "web" });
    const row = collectCandidates("covers")[0];
    expect(Object.keys(row)).toContain("type");
    expect(Object.keys(row)).toContain("album_id");
  });

  it("空库 → 两种候选都是 0(不报错)", () => {
    expect(countCandidates("lyrics")).toBe(0);
    expect(countCandidates("covers")).toBe(0);
    expect(collectCandidates("lyrics")).toEqual([]);
    expect(collectCandidates("covers")).toEqual([]);
  });
});

describe("runBackfillLoop:歌词逐首", () => {
  it("本地歌已有 sidecar .lrc → 直接跳过并标注 has_lyrics=1,不问 provider", async () => {
    const lrc = `${dataDir()}/sidecar-song.lrc`;
    fs.mkdirSync(dataDir(), { recursive: true });
    fs.writeFileSync(lrc, "[00:01.00]词");
    seedSong("s-sidecar", { filePath: `${dataDir()}/sidecar-song.mp3` });
    seedSong("s-nosidecar");

    const seen: any[] = [];
    const r = await runBackfillLoop("lyrics", collectCandidates("lyrics"), (p) => seen.push(p));

    expect(r.skipped).toBe(1);
    expect(r.total).toBe(2);
    expect(r.done).toBe(2);
    // sidecar 命中 → 不搜在线
    expect(H.searchLyrics).toHaveBeenCalledTimes(1);
    expect(H.searchLyrics.mock.calls[0][0].title).toBe("s-nosidecar");
    expect((sqlite.prepare("SELECT has_lyrics AS h FROM songs WHERE id = ?").get("s-sidecar") as any).h).toBe(1);
    // 进度回调最后一条 currentId 归零
    expect(seen[seen.length - 1].currentId).toBeNull();
  });

  it("web 歌(w:/)的路径前缀不算本地 sidecar(只有 l: 才去 stat .lrc)", async () => {
    seedSong("w-1", { type: "web", pathPrefix: "w:src:" });
    H.searchLyrics.mockResolvedValue(null);
    const r = await runBackfillLoop("lyrics", collectCandidates("lyrics"));
    expect(r.skipped).toBe(0);
    expect(H.searchLyrics).toHaveBeenCalledTimes(1);
  });

  it("命中在线歌词 → 写 lyrics 引用 + has_lyrics=1,ok+1", async () => {
    seedSong("s-hit");
    H.searchLyrics.mockResolvedValue("[00:01.00]词");
    const r = await runBackfillLoop("lyrics", collectCandidates("lyrics"));
    expect(r.ok).toBe(1);
    expect(r.fail).toBe(0);
    const row = sqlite.prepare("SELECT lyrics, has_lyrics FROM songs WHERE id = ?").get("s-hit") as any;
    expect(row.lyrics).toBeTruthy();
    // songs.lyrics 存的是**文件引用**(裸文件名),正文不落库
    expect(row.lyrics).toBe("s-hit.lrc");
    expect(row.has_lyrics).toBe(1);
    expect(fs.existsSync(path.join(dataDir(), "online-lyrics", row.lyrics))).toBe(true);
    expect(fs.readFileSync(path.join(dataDir(), "online-lyrics", row.lyrics), "utf8")).toBe("[00:01.00]词");
  });

  it("未命中 → fail+1,库里不写任何东西", async () => {
    seedSong("s-miss");
    H.searchLyrics.mockResolvedValue(null);
    const r = await runBackfillLoop("lyrics", collectCandidates("lyrics"));
    expect(r.ok).toBe(0);
    expect(r.fail).toBe(1);
    expect((sqlite.prepare("SELECT lyrics, has_lyrics FROM songs WHERE id = ?").get("s-miss") as any).lyrics).toBeNull();
  });

  it("provider 抛错 → 该首记 fail,循环不中断,后续歌照常补", async () => {
    seedSong("s-boom");
    seedSong("s-ok");
    sqlite.prepare("UPDATE songs SET title = 'BOOM' WHERE id = 's-boom'").run();
    H.searchLyrics.mockImplementation(async (s: any) => {
      if (s.title === "BOOM") throw new Error("provider 崩了");
      return "[00:02.00]词";
    });
    const r = await runBackfillLoop("lyrics", collectCandidates("lyrics"));
    expect(r.fail).toBe(1);
    expect(r.ok).toBe(1);
    expect(r.done).toBe(2);
  });

  it("signal 已 abort → 直接 break,不处理任何一首", async () => {
    seedSong("s-a1");
    seedSong("s-a2");
    const ac = new AbortController();
    ac.abort();
    const r = await runBackfillLoop("lyrics", collectCandidates("lyrics"), undefined, ac.signal);
    expect(r.done).toBe(0);
    expect(H.searchLyrics).not.toHaveBeenCalled();
  });

  it("covers 模式:走 fetchCoverForSong(force=true),返回 ref 记 ok、null 记 fail", async () => {
    seedSong("c1");
    seedSong("c2");
    sqlite.prepare("UPDATE songs SET title = 'MISS' WHERE id = 'c2'").run();
    H.fetchCoverForSong.mockImplementation(async (s: any) => (s.title === "MISS" ? null : "cover-ref.jpg"));
    const r = await runBackfillLoop("covers", collectCandidates("covers"));
    expect(r.ok).toBe(1);
    expect(r.fail).toBe(1);
    // 必须 force=true —— 绕过「已尝试」门控,由本循环节流
    expect(H.fetchCoverForSong.mock.calls.every((c) => c[1] === true)).toBe(true);
  });
});

describe("runBackfillChunked:>=200 首分块推进", () => {
  it("250 个 id → 2 块,ok/fail 汇总", async () => {
    const ids = Array.from({ length: 250 }, (_, i) => `k${i}`);
    H.runCoverBackfill.mockImplementation(async (chunk: string[]) => ({ ok: chunk.length - 1, fail: 1 }));
    const seen: any[] = [];
    const r = await runBackfillChunked(ids, (p) => seen.push(p));

    expect(H.runCoverBackfill).toHaveBeenCalledTimes(2);
    expect(H.runCoverBackfill.mock.calls[0][0]).toHaveLength(200);
    expect(H.runCoverBackfill.mock.calls[1][0]).toHaveLength(50);
    expect(r.total).toBe(250);
    expect(r.ok).toBe(250 - 2);
    expect(r.fail).toBe(2);
    expect(r.skipped).toBe(0);
    expect(seen[seen.length - 1].currentId).toBeNull();
  });

  it("某一块整体抛错 → 该块全部记 fail,后续块继续", async () => {
    const ids = Array.from({ length: 250 }, () => "x");
    let call = 0;
    H.runCoverBackfill.mockImplementation(async (chunk: string[]) => {
      call++;
      if (call === 1) throw new Error("块崩了");
      return { ok: chunk.length, fail: 0 };
    });
    const r = await runBackfillChunked(ids);
    expect(r.fail).toBe(200);
    expect(r.ok).toBe(50);
    expect(r.done).toBe(250);
  });

  it("abort 后不再处理任何块", async () => {
    const ac = new AbortController();
    ac.abort();
    const r = await runBackfillChunked(["a", "b"], undefined, ac.signal);
    expect(H.runCoverBackfill).not.toHaveBeenCalled();
    expect(r.done).toBe(0);
  });
});

describe("startBackfill:主进程编排", () => {
  it("注入 runner:落回 total/ok/fail/skipped,结束后 running=false 且 currentId 归零", async () => {
    seedSong("s1");
    seedSong("s2");
    let progressCb: ((p: any) => void) | null = null;
    _setBackfillRunnerForTest(async (_kind, onProgress) => {
      progressCb = onProgress;
      onProgress({ total: 2, done: 1, ok: 1, fail: 0, skipped: 0, currentId: "s1" });
      return { total: 2, done: 2, ok: 1, fail: 1, skipped: 0 };
    });

    const started = startBackfill("lyrics");
    expect(started.accepted).toBe(true);
    expect(started.running).toBe(true);
    expect(started.total).toBe(2); // 轻量 COUNT 同步返回
    expect(progressCb).not.toBeNull();

    const job = await waitJobDone("lyrics");
    expect(job.running).toBe(false);
    expect(job.total).toBe(2);
    expect(job.done).toBe(2);
    expect(job.ok).toBe(1);
    expect(job.fail).toBe(1);
    expect(job.currentId).toBeNull();
    expect(job.startedAt).toBeTruthy();
    expect(job.finishedAt).toBeTruthy();
    expect(job.error).toBeUndefined();
  });

  it("同种任务已在跑 → accepted=false 且不叠加第二个执行体", async () => {
    seedSong("s1");
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const runner = vi.fn(async () => {
      await gate;
      return { total: 1, done: 1, ok: 1, fail: 0, skipped: 0 };
    });
    _setBackfillRunnerForTest(runner);

    expect(startBackfill("lyrics").accepted).toBe(true);
    const second = startBackfill("lyrics");
    expect(second.accepted).toBe(false);
    expect(second.running).toBe(true);
    release();
    await waitJobDone("lyrics");
    expect(runner).toHaveBeenCalledTimes(1);
  });

  it("runner 抛错 → 记 error 并收敛 running(不留死状态)", async () => {
    seedSong("s1");
    _setBackfillRunnerForTest(async () => {
      throw new Error("子进程挂了");
    });
    startBackfill("lyrics");
    const job = await waitJobDone("lyrics");
    expect(job.running).toBe(false);
    expect(job.error).toContain("子进程挂了");
    expect(job.finishedAt).toBeTruthy();
  });

  it("三种 kind 各自独立:一种在跑不影响另一种启动", async () => {
    seedSong("s1");
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    _setBackfillRunnerForTest(async () => {
      await gate;
      return { total: 0, done: 0, ok: 0, fail: 0, skipped: 0 };
    });
    expect(startBackfill("lyrics").accepted).toBe(true);
    expect(startBackfill("covers").accepted).toBe(true);
    expect(startBackfill("covers-batch").accepted).toBe(true);
    release();
    await waitJobDone("lyrics");
    await waitJobDone("covers");
    await waitJobDone("covers-batch");
  });

  it("_setBackfillRunnerForTest(null) 恢复默认实现:委托 batch/runner 的 runBatchJob", async () => {
    seedSong("s1");
    H.runBatchJob.mockResolvedValue({ result: { total: 1, done: 1, ok: 1, fail: 0, skipped: 0 } });
    _setBackfillRunnerForTest(null); // 显式走「恢复默认」那条分支

    startBackfill("lyrics");
    const job = await waitJobDone("lyrics");
    expect(H.runBatchJob).toHaveBeenCalledTimes(1);
    expect(H.runBatchJob.mock.calls[0][0]).toBe("backfill");
    expect(H.runBatchJob.mock.calls[0][1]).toEqual({ kind: "lyrics" });
    expect(job.ok).toBe(1);
  });

  it("backfillStatus 返回的就是内部作业对象(前端轮询读同一份状态)", () => {
    expect(backfillStatus("covers-batch").kind).toBe("covers-batch");
    expect(backfillStatus("covers-batch").running).toBe(false);
  });
});
