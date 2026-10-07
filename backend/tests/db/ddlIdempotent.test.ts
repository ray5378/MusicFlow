// MUST be the first import: redirects DATA_DIR to an isolated temp dir before
// the backend opens its SQLite DB at module-load time.
import "../plugins/_env.js";

import { describe, it, expect } from "vitest";
import { sqlite, initDatabase } from "../../src/db/index.js";

// 启动建表/建索引 DDL 幂等:setup.ts 已跑过一次 initDatabase(),这里连续再跑两次,
// 断言不炸且 schema 对象(表/索引)集合不变 —— 保证线上重复启动/升级重放 DDL 安全。
function schemaObjects(): string[] {
  return (sqlite.prepare("SELECT type || ':' || name AS o FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY o").all() as any[]).map(r => r.o);
}

describe("initDatabase DDL 幂等", () => {
  it("连续多次执行不抛错,表/索引集合保持不变", () => {
    const before = schemaObjects();
    expect(() => initDatabase()).not.toThrow();
    expect(() => initDatabase()).not.toThrow();
    const after = schemaObjects();
    expect(after).toEqual(before);
    // 关键索引确实存在(含本次新增的专辑列索引)
    for (const idx of ["idx_albums_created_at", "idx_albums_year", "idx_albums_genre", "idx_albums_play_count", "idx_album_artists_artist", "idx_songs_album", "idx_songs_genre"]) {
      expect(after).toContain(`index:${idx}`);
    }
  });

  it("有数据时重放 DDL 也不丢数据", () => {
    sqlite.prepare("INSERT OR IGNORE INTO albums (id, name) VALUES ('ddl-idem-al', 'DDL 幂等专辑')").run();
    expect(() => initDatabase()).not.toThrow();
    const row = sqlite.prepare("SELECT name FROM albums WHERE id = 'ddl-idem-al'").get() as any;
    expect(row?.name).toBe("DDL 幂等专辑");
    sqlite.prepare("DELETE FROM albums WHERE id = 'ddl-idem-al'").run();
  });
});
