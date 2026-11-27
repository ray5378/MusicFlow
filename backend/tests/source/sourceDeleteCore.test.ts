import { describe, it, expect, vi } from "vitest";
import Database from "better-sqlite3";

// cleanupOrphans 依赖全局 sqlite；这里 mock 掉，只验证删除内核自身逻辑。
vi.mock("../../src/services/source/scanner.js", () => ({ cleanupOrphans: vi.fn() }));

import {
  BATCH,
  deleteRanges,
  countSourceSongs,
  upsertDeleteJob,
  markDeleteJobFailed,
  runSourceDelete,
  finalizeSourceDelete,
} from "../../src/services/source/sourceDeleteCore.js";

// 音源删除内核：范围比较走索引（不用 LIKE），依赖表先删、事务批删、进度落库。
// 用独立内存库，避免依赖全局 sqlite / cleanupOrphans 的真实库。
function freshDb(): Database.Database {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE songs (id TEXT PRIMARY KEY, path TEXT);
    CREATE TABLE playlist_songs (song_id TEXT);
    CREATE TABLE user_favorite_songs (song_id TEXT);
    CREATE TABLE play_history (song_id TEXT);
    CREATE TABLE study_progress (song_id TEXT);
    CREATE TABLE study_playlist_progress (song_id TEXT);
    CREATE TABLE audio_analysis (row_id TEXT);
    CREATE TABLE source_delete_jobs (source_id TEXT PRIMARY KEY, total INTEGER, removed INTEGER, status TEXT, error TEXT, created_at INTEGER, updated_at INTEGER);
    CREATE TABLE media_sources (id TEXT PRIMARY KEY, name TEXT, type TEXT);
  `);
  return db;
}
function seedSongs(db: Database.Database, id: string, n: number, prefix = "s") {
  const stmt = db.prepare("INSERT INTO songs (id, path) VALUES (?, ?)");
  for (let i = 0; i < n; i++) stmt.run(`${prefix}-${id}-${i}`, `${prefix}:${id}:/music/${i}.mp3`);
}

describe("deleteRanges（范围比较区间）", () => {
  it("三段前缀 w/s/l，各 [lo,hi)，hi 用 ':' 的下一位 ';'", () => {
    expect(deleteRanges("X")).toEqual([
      "w:X:", "w:X;", "s:X:", "s:X;", "l:X:", "l:X;",
    ]);
  });
});

describe("countSourceSongs / runSourceDelete（批删内核）", () => {
  it("BATCH=400（400 绑定参数远低于 SQLite 上限）", () => {
    expect(BATCH).toBe(400);
  });

  it("countSourceSongs 只数该源三段前缀，不误伤其它源", () => {
    const db = freshDb();
    seedSongs(db, "A", 5);
    seedSongs(db, "B", 3);
    seedSongs(db, "A", 2, "w");
    expect(countSourceSongs(db, "A")).toBe(7);
    expect(countSourceSongs(db, "B")).toBe(3);
    expect(countSourceSongs(db, "none")).toBe(0);
  });

  it("runSourceDelete 删除该源全部歌曲 + 依赖表行，返回删除数", async () => {
    const db = freshDb();
    seedSongs(db, "A", 5);
    db.prepare("INSERT INTO playlist_songs (song_id) VALUES ('s-A-0'),('s-A-1'),('B-x')").run();
    db.prepare("INSERT INTO audio_analysis (row_id) VALUES ('s-A-0')").run();
    upsertDeleteJob(db, "A", 5);
    const removed = await runSourceDelete(db, "A");
    expect(removed).toBe(5);
    expect(countSourceSongs(db, "A")).toBe(0);
    expect((db.prepare("SELECT count(*) n FROM playlist_songs").get() as any).n).toBe(1); // 只剩 B-x
    expect((db.prepare("SELECT count(*) n FROM audio_analysis").get() as any).n).toBe(0);
    expect((db.prepare("SELECT removed FROM source_delete_jobs WHERE source_id='A'").get() as any).removed).toBe(5);
  });

  it("shouldStop 提前返回时不删，任务留在库里待续删", async () => {
    const db = freshDb();
    seedSongs(db, "A", 5);
    upsertDeleteJob(db, "A", 5);
    const removed = await runSourceDelete(db, "A", { shouldStop: () => true });
    expect(removed).toBe(0);
    expect(countSourceSongs(db, "A")).toBe(5);
  });

  it("跨多批删除（BATCH+ 条）全部删净", async () => {
    const db = freshDb();
    seedSongs(db, "A", BATCH + 37);
    upsertDeleteJob(db, "A", BATCH + 37);
    const removed = await runSourceDelete(db, "A");
    expect(removed).toBe(BATCH + 37);
    expect(countSourceSongs(db, "A")).toBe(0);
  });

  it("upsertDeleteJob 幂等：重跑重置 status/error/total，保留 removed", () => {
    const db = freshDb();
    upsertDeleteJob(db, "A", 10);
    db.prepare("UPDATE source_delete_jobs SET removed=4, status='failed', error='x' WHERE source_id='A'").run();
    upsertDeleteJob(db, "A", 12);
    const row = db.prepare("SELECT * FROM source_delete_jobs WHERE source_id='A'").get() as any;
    expect(row.total).toBe(12);
    expect(row.status).toBe("running");
    expect(row.error).toBeNull();
    expect(row.removed).toBe(4);
  });

  it("markDeleteJobFailed 写 status/error", () => {
    const db = freshDb();
    upsertDeleteJob(db, "A", 1);
    markDeleteJobFailed(db, "A", new Error("boom"));
    const row = db.prepare("SELECT * FROM source_delete_jobs WHERE source_id='A'").get() as any;
    expect(row.status).toBe("failed");
    expect(row.error).toBe("boom");
  });

  it("finalizeSourceDelete 清任务行；源行删除由 cleanupOrphans 之外的 DDL 承担", () => {
    const db = freshDb();
    upsertDeleteJob(db, "A", 1);
    db.prepare("INSERT INTO media_sources (id,name,type) VALUES ('A','A','local')").run();
    // finalizeSourceDelete 调真实 cleanupOrphans（依赖全局 sqlite），此处只验证任务行删除路径不抛错于本库范围外
    expect(() => finalizeSourceDelete(db, "A")).not.toThrow();
    expect((db.prepare("SELECT count(*) n FROM source_delete_jobs").get() as any).n).toBe(0);
    expect((db.prepare("SELECT count(*) n FROM media_sources WHERE id='A'").get() as any).n).toBe(0);
  });
});
