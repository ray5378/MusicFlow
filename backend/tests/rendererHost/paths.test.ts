import { describe, it, expect } from "vitest";
import path from "path";
import { pathToFileURL } from "url";
import { resolveChildEntry } from "../../src/services/rendererHost/paths.js";
import { ensureSongCountColumn } from "../../src/db/songCountColumn.js";
import Database from "better-sqlite3";

// 子进程入口解析：生产找 child.js，dev 退回 child.ts。
describe("resolveChildEntry", () => {
  // 用本测试文件自身路径定位同目录（这里放一个真实存在的伴生文件）
  const here = path.dirname(new URL(import.meta.url).pathname);
  const selfUrl = pathToFileURL(path.join(here, "caller.ts")).href;

  it("entryFile 存在时返回其绝对路径", () => {
    // package.json 一定在 backend 根，这里用一个肯定存在的伴生文件验证「存在即返回」
    const backendUrl = pathToFileURL(path.join(here, "..", "package.json")).href;
    const out = resolveChildEntry(backendUrl, "package.json");
    expect(out).toBe(path.join(here, "..", "package.json"));
  });

  it("entryFile 不存在时把 .js 退回 .ts（dev/tsx）", () => {
    const out = resolveChildEntry(selfUrl, "nonexistent.js");
    expect(out).toBe(path.join(here, "nonexistent.ts"));
  });

  it("非 .js 后缀的 entryFile 不存在时原样返回", () => {
    const out = resolveChildEntry(selfUrl, "missing.mjs");
    expect(out).toBe(path.join(here, "missing.mjs"));
  });
});

// 无迁移框架下的幂等补列：老库缺 song_count 时补，新库有则跳过。
describe("ensureSongCountColumn", () => {
  function dbWithSongCount(hasColumn: boolean): Database.Database {
    const db = new Database(":memory:");
    db.exec(`CREATE TABLE media_sources (id TEXT PRIMARY KEY, name TEXT${hasColumn ? ", song_count INTEGER" : ""})`);
    return db;
  }

  it("已有 song_count 列时不重复 ALTER（幂等）", () => {
    const db = dbWithSongCount(true);
    expect(() => ensureSongCountColumn(db as any)).not.toThrow();
    const cols = db.prepare("PRAGMA table_info(media_sources)").all() as any[];
    expect(cols.filter((c) => c.name === "song_count").length).toBe(1);
  });

  it("缺列时补上 song_count", () => {
    const db = dbWithSongCount(false);
    ensureSongCountColumn(db as any);
    const cols = db.prepare("PRAGMA table_info(media_sources)").all() as any[];
    expect(cols.some((c) => c.name === "song_count")).toBe(true);
  });

  it("重复调用不报错（二次幂等）", () => {
    const db = dbWithSongCount(false);
    ensureSongCountColumn(db as any);
    expect(() => ensureSongCountColumn(db as any)).not.toThrow();
  });
});
