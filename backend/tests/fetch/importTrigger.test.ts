// 「入库即入队」测试：任何入库的网络歌曲（平台歌曲）都必须过一轮下载流程。
//
// 分两层：
//   A. `triggerFetchForImportedSongs`（真正建任务的原子操作）语义；
//   B. `enqueueImportedSongs` / 钩子（活跃间隔防抖）语义 —— 2026-10-11 第二轮：
//      大歌单会分多批广播，必须「累积 + 静默 5 分钟」后只建**一个**任务。
//
// 覆盖：
//   1. 下载总开关关闭 → 不下载（导入本身照常成功）；
//   2. 点名 songIds → 只对这批新入库的行建任务（kind=import），且**强制关自动续批**
//      （否则任务终态后会顺手开「全库下载」，把范围放大到全库）；
//   3. 「本地 / WebDAV 已有实体文件」的行**不进计划**（这正是「下载流程自动挡住已有」）；
//   4. 点名绕过冷却（重复导入同一首歌不会因为「上次刚试过」被静默跳过）；
//   5. 挂载后「入库事件 → 自动建任务」端到端成立（注册制钩子的接线正确）；
//   6. 钩子抛错绝不影响导入（事件层兜底）。
//   7. 活跃间隔防抖：广播**不立即**建任务；距最后一次广播满 5 分钟才建一个；
//      窗口内持续广播不断推迟；累计的是并集；并集持久化 + 重启恢复；flush 后清空。
//
// 纯 DB + 计划器；批量子进程整体桩化（不 fork）；下载目录指向临时目录（不碰 /MUSIC）。
// MUST be the first import：先加载 env 助手（DATA_DIR 隔离由 setup.ts 统一分配）。
import "../plugins/_env.js";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";

import { db, sqlite } from "../../src/db/index.js";
import { songs, albums, playlists, playlistSongs, settings } from "../../src/db/schema.js";
import { _resetSettingsCacheForTest, getSetting } from "../../src/services/settings.js";
import { _resetFetchJobsForTest, getFetchJob, listFetchJobs } from "../../src/services/fetch/jobStore.js";
import { saveFetchConfigOverride } from "../../src/services/fetch/configStore.js";
import { ensureLibraryAttemptsTable, recordLibraryAttempt } from "../../src/services/fetch/library.js";
import {
  IMPORT_TRIGGER_IDLE_MS,
  _resetImportTriggerForTest,
  enqueueImportedSongs,
  flushImportedSongs,
  triggerFetchForImportedSongs,
  registerFetchImportTrigger,
} from "../../src/services/fetch/importTrigger.js";
import {
  emitImportedSongs,
  hasImportedSongsListener,
  setImportedSongsListener,
} from "../../src/services/source/online/importTriggerHook.js";

const PENDING_KEY = "fetch.import.pending";

// 批量子进程运行器整体替换成桩，避免真 fork。
const { runBatchJobMock } = vi.hoisted(() => ({
  runBatchJobMock: vi.fn(async () => ({ result: { hasMore: false }, aborted: false, childRss: 0 })),
}));
vi.mock("../../src/batch/runner.js", async (importOriginal) => {
  const actual = await importOriginal<any>();
  return { ...actual, runBatchJob: runBatchJobMock };
});

let DL = "";
let CA = "";

/** 往 songs 表塞一行：默认是「平台（web）行」= 本地没有实体文件。 */
function seedSong(o: { id: string; title?: string; artist?: string; path?: string; type?: string }) {
  db.insert(songs)
    .values({
      id: o.id,
      title: o.title ?? "歌",
      artist: o.artist ?? "歌手",
      album: "专辑",
      path: o.path ?? "web:go-music-dl:netease",
      suffix: "mp3",
      bitRate: 0,
      size: 0,
      duration: 200,
      type: o.type ?? "web",
      contentType: "audio/mpeg",
    })
    .run();
}

beforeEach(() => {
  db.delete(playlistSongs).run();
  db.delete(playlists).run();
  db.delete(songs).run();
  db.delete(albums).run();
  db.delete(settings).where(eq(settings.key, "fetch.config")).run();
  db.delete(settings).where(eq(settings.key, PENDING_KEY)).run();
  _resetSettingsCacheForTest();
  _resetFetchJobsForTest();
  _resetImportTriggerForTest();
  ensureLibraryAttemptsTable();
  sqlite.prepare("DELETE FROM fetch_library_attempts").run();
  setImportedSongsListener(null);
  runBatchJobMock.mockClear();
  DL = mkdtempSync(join(tmpdir(), "mf-imp-dl-"));
  CA = mkdtempSync(join(tmpdir(), "mf-imp-ca-"));
  // 目录指向临时目录：startFetchJob 的写目录预检才不会去碰 /MUSIC。
  saveFetchConfigOverride({ enabled: true, downloadRoot: DL, cacheRoot: CA });
});

afterEach(() => {
  setImportedSongsListener(null);
  _resetImportTriggerForTest();
  vi.useRealTimers();
  if (DL) rmSync(DL, { recursive: true, force: true });
  if (CA) rmSync(CA, { recursive: true, force: true });
});

describe("triggerFetchForImportedSongs", () => {
  it("下载总开关关闭 → 不建任何任务（导入本身照常成功）", () => {
    saveFetchConfigOverride({ enabled: false, downloadRoot: DL, cacheRoot: CA });
    seedSong({ id: "w1" });

    const r = triggerFetchForImportedSongs(["w1"]);
    expect(r.enqueued).toBe(0);
    expect(r.reason).toBe("disabled");
    expect(listFetchJobs({}).length).toBe(0);
    expect(runBatchJobMock).not.toHaveBeenCalled();
  });

  it("点名 songIds → 只对这批建 kind=import 任务，并强制关闭全库自动续批", () => {
    seedSong({ id: "w1", title: "A" });
    seedSong({ id: "w2", title: "B" });
    seedSong({ id: "w3", title: "C" });

    const r = triggerFetchForImportedSongs(["w1", "w3"]);
    expect(r.enqueued).toBe(2);
    expect(r.jobId).toBeTruthy();

    const job = getFetchJob(r.jobId!)!;
    expect(job.kind).toBe("import");
    const targets = (job as any).targets.targets as any[];
    expect(targets.map((t) => t.id)).toEqual(["library:w1", "library:w3"]);
    // targets 带 library 块 → 落盘后把原 web 行迁移成指向本地文件的行（保歌单引用）。
    expect(JSON.parse(targets[0].sourceData).library.songId).toBe("w1");
    // 关键：noAutoContinue —— 否则任务终态后会自动开「全库下载」，范围放大到全库。
    expect((job.config as any).__library).toEqual({ migrateRowOnly: true, noAutoContinue: true });
    expect(runBatchJobMock).toHaveBeenCalled();
  });

  it("本地 / WebDAV 已有实体文件的行不进计划（下载流程自动挡住「已有」）", () => {
    seedSong({ id: "l1", path: "l:src-1:/m/a.flac", type: "local" });
    seedSong({ id: "w1", path: "w:webdav-1:/m/b.flac", type: "local" });

    const r = triggerFetchForImportedSongs(["l1", "w1"]);
    expect(r.enqueued).toBe(0);
    expect(r.reason).toBe("nothing-to-do");
    expect(listFetchJobs({}).length).toBe(0);
    expect(runBatchJobMock).not.toHaveBeenCalled();
  });

  it("空列表 / 全空白 id → 不建任务", () => {
    expect(triggerFetchForImportedSongs([]).reason).toBe("empty");
    expect(triggerFetchForImportedSongs(["", "  "]).reason).toBe("empty");
    expect(listFetchJobs({}).length).toBe(0);
  });

  it("点名绕过冷却：刚试过的歌被重新导入时仍会入队（不静默跳过）", () => {
    seedSong({ id: "w1" });
    // 模拟「上一轮已经试过且失败」——冷却台账里有记录。全库下载的隐式路径会跳过它，
    // 但点名重试语义必须绕开（否则用户重导一次歌单，歌会因为冷却被静默丢掉）。
    recordLibraryAttempt("w1", "batch-x", "failed");

    const r = triggerFetchForImportedSongs(["w1"]);
    expect(r.enqueued).toBe(1);
  });

  it("同一 id 重复传入只入队一次", () => {
    seedSong({ id: "w1" });
    const r = triggerFetchForImportedSongs(["w1", "w1", " w1 "]);
    expect(r.enqueued).toBe(1);
  });
});

describe("注册制钩子", () => {
  it("未挂载时入库事件是空实现（导入单测不受影响）", () => {
    expect(hasImportedSongsListener()).toBe(false);
    seedSong({ id: "w1" });
    expect(() => emitImportedSongs(["w1"], { providerId: "go-music-dl" })).not.toThrow();
    expect(listFetchJobs({}).length).toBe(0);
  });

  it("钩子实现抛错不影响导入（事件层兜底）", () => {
    setImportedSongsListener(() => {
      throw new Error("boom");
    });
    expect(() => emitImportedSongs(["w1"], { providerId: "p" })).not.toThrow();
  });
});

describe("活跃间隔防抖（2026-10-11 第二轮：大歌单分多批广播不允许炸出碎任务）", () => {
  beforeEach(() => {
    // 只假造定时器，不动 Date / microtask —— 免得影响 settings 的 TTL 缓存与 batch 桩。
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  });

  it("挂载后广播**不立即**建任务；距最后一次广播满 5 分钟才建，且目标是累计并集", () => {
    seedSong({ id: "w1", title: "A" });
    seedSong({ id: "w2", title: "B" });
    registerFetchImportTrigger();
    expect(hasImportedSongsListener()).toBe(true);

    emitImportedSongs(["w1", "w2"], { providerId: "go-music-dl" });
    // 关键：这一瞬间**没有**任何任务（旧实现会在这里就建出来）。
    expect(listFetchJobs({}).length).toBe(0);

    // 差 1 毫秒还不满窗口 → 仍不建。
    vi.advanceTimersByTime(IMPORT_TRIGGER_IDLE_MS - 1);
    expect(listFetchJobs({}).length).toBe(0);

    vi.advanceTimersByTime(1);
    const jobs = listFetchJobs({});
    expect(jobs.length).toBe(1);
    expect(jobs[0].kind).toBe("import");
    const targets = (jobs[0] as any).targets.targets as any[];
    expect(targets.map((t) => t.id).sort()).toEqual(["library:w1", "library:w2"]);
  });

  it("窗口内持续广播不断推迟：两次广播只建**一个**任务（不炸碎任务）", () => {
    seedSong({ id: "w1" });
    seedSong({ id: "w2" });
    seedSong({ id: "w3" });
    registerFetchImportTrigger();

    emitImportedSongs(["w1"], { providerId: "p" });
    vi.advanceTimersByTime(2 * 60_000); // 2 分钟后又来一批（大歌单还在导）
    emitImportedSongs(["w2", "w3"], { providerId: "p" });

    // 距「第一次」已经 6 分钟，但距最后一次只有 4 分钟 → 仍不该建。
    vi.advanceTimersByTime(4 * 60_000);
    expect(listFetchJobs({}).length).toBe(0);

    vi.advanceTimersByTime(1 * 60_000); // 距最后一次满 5 分钟
    const jobs = listFetchJobs({});
    expect(jobs.length).toBe(1);
    const targets = (jobs[0] as any).targets.targets as any[];
    expect(targets.map((t) => t.id).sort()).toEqual(["library:w1", "library:w2", "library:w3"]);
  });

  it("并集去重 + 持久化：窗口内累计的 id 落进 settings，flush 后清空", () => {
    seedSong({ id: "w1" });
    seedSong({ id: "w2" });
    registerFetchImportTrigger();

    emitImportedSongs(["w1", "w2", "w1"], { providerId: "p" });
    expect(JSON.parse(getSetting(PENDING_KEY, "[]")).sort()).toEqual(["w1", "w2"]);

    vi.advanceTimersByTime(IMPORT_TRIGGER_IDLE_MS);
    expect(listFetchJobs({}).length).toBe(1);
    expect(JSON.parse(getSetting(PENDING_KEY, "[]"))).toEqual([]);

    // flush 之后没有新入库 → 不会再冒出第二个任务。
    vi.advanceTimersByTime(IMPORT_TRIGGER_IDLE_MS * 3);
    expect(listFetchJobs({}).length).toBe(1);
  });

  it("空广播/全空白不产生任务，也不动计时器", () => {
    seedSong({ id: "w1" });
    registerFetchImportTrigger();
    emitImportedSongs([], { providerId: "p" });
    emitImportedSongs(["", "  "], { providerId: "p" });
    vi.advanceTimersByTime(IMPORT_TRIGGER_IDLE_MS * 2);
    expect(listFetchJobs({}).length).toBe(0);
  });

  it("重启恢复：进程重启后待处理集合从 settings 捡回，继续等满活跃间隔才下发", () => {
    seedSong({ id: "w1", title: "A" });
    registerFetchImportTrigger();
    emitImportedSongs(["w1"], { providerId: "p" });
    expect(listFetchJobs({}).length).toBe(0);

    // 模拟进程重启：内存里的集合与计时器都没了，DB 里还留着。
    _resetImportTriggerForTest();
    setImportedSongsListener(null);
    expect(JSON.parse(getSetting(PENDING_KEY, "[]"))).toEqual(["w1"]);

    registerFetchImportTrigger();
    vi.advanceTimersByTime(IMPORT_TRIGGER_IDLE_MS - 1);
    expect(listFetchJobs({}).length).toBe(0);
    vi.advanceTimersByTime(1);
    const jobs = listFetchJobs({});
    expect(jobs.length).toBe(1);
    expect(((jobs[0] as any).targets.targets as any[]).map((t) => t.id)).toEqual(["library:w1"]);
  });

  it("enqueueImportedSongs / flushImportedSongs 可被直接调用（运维手动下发）", () => {
    seedSong({ id: "w1" });
    seedSong({ id: "w2" });
    expect(enqueueImportedSongs(["w1"])).toBe(1);
    expect(enqueueImportedSongs(["w2", "w1"])).toBe(2);
    const r = flushImportedSongs();
    expect(r.enqueued).toBe(2);
    expect(listFetchJobs({}).length).toBe(1);
    // 再 flush 一次（并集已空）→ 不建新任务。
    expect(flushImportedSongs().reason).toBe("empty");
    expect(listFetchJobs({}).length).toBe(1);
  });
});
