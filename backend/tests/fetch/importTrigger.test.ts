// 「入库即入队」测试：任何入库的网络歌曲（平台歌曲）都必须过一轮下载流程。
//
// 覆盖六条语义：
//   1. 下载总开关关闭 → 不下载（导入本身照常成功）；
//   2. 点名 songIds → 只对这批新入库的行建任务（kind=import），且**强制关自动续批**
//      （否则任务终态后会顺手开「全库下载」，把范围放大到全库）；
//   3. 「本地 / WebDAV 已有实体文件」的行**不进计划**（这正是「下载流程自动挡住已有」）；
//   4. 点名绕过冷却（重复导入同一首歌不会因为「上次刚试过」被静默跳过）；
//   5. 挂载后「入库事件 → 自动建任务」端到端成立（注册制钩子的接线正确）；
//   6. 钩子抛错绝不影响导入（事件层兜底）。
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
import { _resetSettingsCacheForTest } from "../../src/services/settings.js";
import { _resetFetchJobsForTest, getFetchJob, listFetchJobs } from "../../src/services/fetch/jobStore.js";
import { saveFetchConfigOverride } from "../../src/services/fetch/configStore.js";
import { ensureLibraryAttemptsTable, recordLibraryAttempt } from "../../src/services/fetch/library.js";
import { triggerFetchForImportedSongs, registerFetchImportTrigger } from "../../src/services/fetch/importTrigger.js";
import {
  emitImportedSongs,
  hasImportedSongsListener,
  setImportedSongsListener,
} from "../../src/services/source/online/importTriggerHook.js";

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
  _resetSettingsCacheForTest();
  _resetFetchJobsForTest();
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

  it("同一 id 重复传入只入队一次（导入事件可能按批多次广播）", () => {
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

  it("挂载后：入库事件 → 自动建 import 任务（端到端）", () => {
    seedSong({ id: "w1" });
    registerFetchImportTrigger();
    expect(hasImportedSongsListener()).toBe(true);

    emitImportedSongs(["w1"], { providerId: "go-music-dl" });
    const jobs = listFetchJobs({});
    expect(jobs.length).toBe(1);
    expect(jobs[0].kind).toBe("import");
  });

  it("钩子实现抛错不影响导入（事件层兜底）", () => {
    setImportedSongsListener(() => {
      throw new Error("boom");
    });
    expect(() => emitImportedSongs(["w1"], { providerId: "p" })).not.toThrow();
  });
});
