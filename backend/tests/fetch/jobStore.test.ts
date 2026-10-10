// MusicFetch 任务登记（fetch_jobs）单测：覆盖创建/回读、状态流转、items 整列写回、
// counts 合并、保洁只删终态、坏 JSON 容错、不存在返回 null。
//
// 每个测试文件由 tests/setup.ts 分配独立 DATA_DIR 并 initDatabase() 建全量 schema，
// 因此这里直接使用真实 fetch_jobs 表；文件内用 beforeEach 清表隔离（shuffle 顺序安全）。

import { beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "../../src/db/index.js";
import { fetchJobs } from "../../src/db/schema.js";
import {
  FETCH_JOBS_KEEP_MAX,
  _resetFetchJobsForTest,
  createFetchJob,
  deleteFetchJob,
  getFetchJob,
  listFetchJobs,
  pruneFetchJobs,
  saveFetchJobImports,
  saveFetchJobItems,
  updateFetchJobStatus,
} from "../../src/services/fetch/jobStore.js";
import type { FetchJobItem } from "../../src/services/fetch/jobStore.js";

/** 直接改 created_at，供保洁排序用例构造确定的时间序（同毫秒创建会并列）。 */
function stampCreatedAt(id: string, iso: string): void {
  db.update(fetchJobs).set({ createdAt: iso }).where(eq(fetchJobs.id, id)).run();
}

function item(over: Partial<FetchJobItem> = {}): FetchJobItem {
  return {
    id: "it-1",
    targetId: "t-1",
    status: "queued",
    attempts: 0,
    ...over,
  };
}

beforeEach(() => {
  _resetFetchJobsForTest();
});

describe("createFetchJob / getFetchJob", () => {
  it("创建后回读：字段/默认值正确", () => {
    const rec = createFetchJob({
      id: "job-1",
      kind: "daily",
      sourceId: "dl-abc",
      targets: { playlistId: "p1", targets: [{ id: "t1", title: "歌" }] },
      config: { qualityFloor: "320", maxConcurrentDownloads: 2 },
    });

    expect(rec.id).toBe("job-1");
    expect(rec.kind).toBe("daily");
    expect(rec.status).toBe("pending");
    expect(rec.sourceId).toBe("dl-abc");
    expect(rec.targets).toEqual({ playlistId: "p1", targets: [{ id: "t1", title: "歌" }] });
    expect(rec.config).toEqual({ qualityFloor: "320", maxConcurrentDownloads: 2 });
    expect(rec.items).toEqual([]);
    expect(rec.imports).toEqual([]);
    expect(rec.counts).toEqual({
      total: 0,
      done: 0,
      failed: 0,
      skipped: 0,
      added: 0,
      updated: 0,
      bytes: 0,
    });
    expect(rec.error).toBeNull();
    expect(rec.startedAt).toBeNull();
    expect(rec.finishedAt).toBeNull();
    expect(rec.createdAt).not.toBe("");
    expect(rec.updatedAt).not.toBe("");

    const back = getFetchJob("job-1");
    expect(back).toEqual(rec);
  });

  it("未给 id 时自动生成，且默认 kind=manual / sourceId=null", () => {
    const rec = createFetchJob({ targets: { targets: [] } });
    expect(rec.id).toMatch(/[0-9a-f-]{36}/);
    expect(rec.kind).toBe("manual");
    expect(rec.sourceId).toBeNull();
  });

  it("getFetchJob 不存在返回 null", () => {
    expect(getFetchJob("no-such-id")).toBeNull();
  });
});

describe("updateFetchJobStatus", () => {
  it("running 补 startedAt；终态补 finishedAt", () => {
    createFetchJob({ id: "j", targets: {} });

    updateFetchJobStatus("j", "running");
    let rec = getFetchJob("j")!;
    expect(rec.status).toBe("running");
    expect(rec.startedAt).not.toBeNull();
    expect(rec.finishedAt).toBeNull();

    updateFetchJobStatus("j", "done");
    rec = getFetchJob("j")!;
    expect(rec.status).toBe("done");
    expect(rec.finishedAt).not.toBeNull();
  });

  it("extra.error / extra.sourceId 覆盖；partial / cancelled 也算终态", () => {
    createFetchJob({ id: "j", targets: {} });
    updateFetchJobStatus("j", "partial", { error: "部分失败", sourceId: "dl-x" });
    const rec = getFetchJob("j")!;
    expect(rec.status).toBe("partial");
    expect(rec.error).toBe("部分失败");
    expect(rec.sourceId).toBe("dl-x");
    expect(rec.finishedAt).not.toBeNull();
  });
});

describe("saveFetchJobItems / saveFetchJobImports", () => {
  it("items 整列写回与回读", () => {
    createFetchJob({ id: "j", targets: {} });
    const items: FetchJobItem[] = [
      item({
        id: "it-a",
        targetId: "t-a",
        status: "done",
        attempts: 2,
        chosen: { candidateId: "c1", pluginId: "lx-source", platform: "wy", probed: { bitrateKbps: 320 } },
        rejected: [{ candidateId: "c0", reason: "BELOW_BAR" }],
        host: "cdn.example.com",
        bytes: 12345,
        finalPath: "/MUSIC/DOWNLOAD/a.flac",
      }),
      item({ id: "it-b", targetId: "t-b", status: "failed", attempts: 1, errorCode: "TIMEOUT" }),
    ];
    saveFetchJobItems("j", items);

    const rec = getFetchJob("j")!;
    expect(rec.items).toEqual(items);
  });

  it("counts 按 Partial 合并（未给的键保留现值）", () => {
    createFetchJob({ id: "j", targets: {} });
    saveFetchJobItems("j", [item()], { total: 5, done: 1 });
    let rec = getFetchJob("j")!;
    expect(rec.counts).toEqual({
      total: 5,
      done: 1,
      failed: 0,
      skipped: 0,
      added: 0,
      updated: 0,
      bytes: 0,
    });

    // 第二次只更新 done，total 应保留 5。
    saveFetchJobItems("j", [item()], { done: 3 });
    rec = getFetchJob("j")!;
    expect(rec.counts.total).toBe(5);
    expect(rec.counts.done).toBe(3);
  });

  it("imports 整列写回与回读", () => {
    createFetchJob({ id: "j", targets: {} });
    saveFetchJobImports("j", [
      { itemId: "it-a", songId: "song-1", result: "added", filePath: "/MUSIC/DOWNLOAD/a.flac" },
      { itemId: "it-b", result: "failed", err: "no space" },
    ]);
    const rec = getFetchJob("j")!;
    expect(rec.imports).toHaveLength(2);
    expect(rec.imports[0]).toEqual({
      itemId: "it-a",
      songId: "song-1",
      result: "added",
      filePath: "/MUSIC/DOWNLOAD/a.flac",
    });
    expect(rec.imports[1].result).toBe("failed");
  });
});

describe("pruneFetchJobs", () => {
  it("只删已终态且保留最新，pending / running 永不删", () => {
    // 4 条终态（时间递增）+ 1 条 pending + 1 条 running
    for (let i = 1; i <= 4; i++) {
      createFetchJob({ id: `done-${i}`, targets: {} });
      updateFetchJobStatus(`done-${i}`, "done");
      stampCreatedAt(`done-${i}`, `2026-01-0${i}T00:00:00.000Z`);
    }
    createFetchJob({ id: "pending-1", targets: {} });
    createFetchJob({ id: "running-1", targets: {} });
    updateFetchJobStatus("running-1", "running");

    const deleted = pruneFetchJobs(2);
    expect(deleted).toBe(2);

    // 保留最新两条终态
    expect(getFetchJob("done-4")).not.toBeNull();
    expect(getFetchJob("done-3")).not.toBeNull();
    expect(getFetchJob("done-2")).toBeNull();
    expect(getFetchJob("done-1")).toBeNull();
    // 非终态不受影响
    expect(getFetchJob("pending-1")).not.toBeNull();
    expect(getFetchJob("running-1")).not.toBeNull();
  });

  it("未超限时零删除", () => {
    createFetchJob({ id: "d1", targets: {} });
    updateFetchJobStatus("d1", "done");
    expect(pruneFetchJobs(10)).toBe(0);
    expect(getFetchJob("d1")).not.toBeNull();
  });

  it("FETCH_JOBS_KEEP_MAX 默认 200", () => {
    expect(FETCH_JOBS_KEEP_MAX).toBe(200);
  });
});

describe("listFetchJobs", () => {
  it("按 created_at DESC，并支持 status 过滤与 limit", () => {
    for (let i = 1; i <= 3; i++) {
      createFetchJob({ id: `j-${i}`, targets: {} });
      stampCreatedAt(`j-${i}`, `2026-02-0${i}T00:00:00.000Z`);
    }
    updateFetchJobStatus("j-2", "done");

    const all = listFetchJobs();
    expect(all.map((r) => r.id)).toEqual(["j-3", "j-2", "j-1"]);

    const limited = listFetchJobs({ limit: 2 });
    expect(limited.map((r) => r.id)).toEqual(["j-3", "j-2"]);

    const doneOnly = listFetchJobs({ status: "done" });
    expect(doneOnly.map((r) => r.id)).toEqual(["j-2"]);
  });
});

describe("坏数据容错", () => {
  it("坏 JSON 读取不抛异常，回落到默认值", () => {
    db.insert(fetchJobs)
      .values({
        id: "bad",
        kind: "manual",
        status: "pending",
        targetsJson: "{not json",
        itemsJson: "[1,2,",
        importsJson: "not-json",
        configJson: "also bad",
        countsJson: "}{",
        createdAt: "2026-03-01T00:00:00.000Z",
        updatedAt: "2026-03-01T00:00:00.000Z",
      })
      .run();

    const rec = getFetchJob("bad")!;
    expect(rec).not.toBeNull();
    expect(rec.targets).toEqual({});
    expect(rec.items).toEqual([]);
    expect(rec.imports).toEqual([]);
    expect(rec.config).toEqual({});
    expect(rec.counts).toEqual({
      total: 0,
      done: 0,
      failed: 0,
      skipped: 0,
      added: 0,
      updated: 0,
      bytes: 0,
    });
  });

  it("counts 含非法/缺键时被规范化", () => {
    db.insert(fetchJobs)
      .values({
        id: "bad2",
        targetsJson: "{}",
        countsJson: JSON.stringify({ total: 7, done: "x", bogus: 1 }),
        createdAt: "2026-03-01T00:00:00.000Z",
        updatedAt: "2026-03-01T00:00:00.000Z",
      })
      .run();
    const rec = getFetchJob("bad2")!;
    expect(rec.counts.total).toBe(7);
    expect(rec.counts.done).toBe(0);
    expect(Object.keys(rec.counts).sort()).toEqual(
      ["added", "bytes", "done", "failed", "skipped", "total", "updated"].sort(),
    );
  });
});

describe("deleteFetchJob", () => {
  it("删除后回读为 null", () => {
    createFetchJob({ id: "j", targets: {} });
    deleteFetchJob("j");
    expect(getFetchJob("j")).toBeNull();
  });
});
