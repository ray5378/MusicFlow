// 老库升级:studyColumns 补列/回填必须幂等,且不得碰已有数据。
// 这里用独立内存库模拟「没有 kind 列的历史库」,不依赖 setup 的 DATA_DIR。
import { describe, it, expect } from "vitest";
import Database from "better-sqlite3";
import { ensureStudyColumns } from "../../src/db/studyColumns.js";

function cols(sqlite: Database.Database, table: string): string[] {
  return (sqlite.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((c) => c.name);
}

describe("学习模块老库补列", () => {
  it("补 songs/media_sources/playlists 的 kind 与 source_id/rel_dir,并回填 music", () => {
    const sqlite = new Database(":memory:");
    sqlite.exec(`
      CREATE TABLE songs (id TEXT PRIMARY KEY, path TEXT NOT NULL);
      CREATE TABLE media_sources (id TEXT PRIMARY KEY, name TEXT);
      CREATE TABLE playlists (id TEXT PRIMARY KEY, name TEXT);
      INSERT INTO songs (id, path) VALUES ('a', 'l:src:/a.mp3');
      INSERT INTO media_sources (id, name) VALUES ('src', 'Music');
      INSERT INTO playlists (id, name) VALUES ('pl', 'List');
    `);

    ensureStudyColumns(sqlite as any);
    // 幂等:再跑一次不应报错、不应重复回填
    ensureStudyColumns(sqlite as any);

    expect(cols(sqlite, "songs")).toEqual(expect.arrayContaining(["kind", "source_id", "rel_dir"]));
    expect(cols(sqlite, "media_sources")).toContain("kind");
    expect(cols(sqlite, "playlists")).toContain("kind");

    const song = sqlite.prepare("SELECT kind, source_id, rel_dir FROM songs WHERE id = 'a'").get() as any;
    expect(song.kind).toBe("music");
    expect(song.source_id).toBeNull();
    expect(song.rel_dir).toBe("");

    expect((sqlite.prepare("SELECT kind FROM media_sources WHERE id = 'src'").get() as any).kind).toBe("music");
    expect((sqlite.prepare("SELECT kind FROM playlists WHERE id = 'pl'").get() as any).kind).toBe("music");
  });
});
