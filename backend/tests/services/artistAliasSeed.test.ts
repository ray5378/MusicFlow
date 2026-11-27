import { describe, it, expect, beforeEach } from "vitest";
import { sqlite } from "../../src/db/index.js";
import { readSeed, applySeedIfNeeded, exportSeedSnapshot } from "../../src/services/artistAliasSeed.js";
import { aliasNorm } from "../../src/services/artistAlias.js";

const APPLIED_KEY = "artistAlias.seedVersion";

// 内置别名种子：启动时按 version 增量灌库（幂等）；导出快照供发版内置。
describe("artistAliasSeed（内置别名种子）", () => {
  beforeEach(() => {
    sqlite.exec("DELETE FROM artist_alias");
    sqlite.prepare("DELETE FROM settings WHERE key = ?").run(APPLIED_KEY);
  });

  function addAlias(alias: string, canonical: string, kind = "alias") {
    const a = aliasNorm(alias), c = aliasNorm(canonical);
    sqlite.prepare(`INSERT OR IGNORE INTO artist_alias (alias, alias_norm, canonical, canonical_norm, kind, source, updated_at)
                    VALUES (?,?,?,?,?,?,?)`)
      .run(alias, a, canonical, c, kind, "test", new Date().toISOString());
  }

  it("readSeed：返回 null 或合法结构（version/entries 数组）", () => {
    const seed = readSeed();
    if (seed !== null) {
      expect(typeof seed.version).toBe("number");
      expect(Array.isArray(seed.entries)).toBe(true);
      expect(typeof seed.generatedAt).toBe("string");
      for (const e of seed.entries) {
        expect(Array.isArray(e)).toBe(true);
        expect(typeof e[0]).toBe("string");
        expect(typeof e[1]).toBe("string");
      }
    } else {
      expect(seed).toBeNull();
    }
  });

  it("exportSeedSnapshot：把当前表按 alias_norm 升序导出，version/generatedAt 齐全", () => {
    addAlias("A-Lin", "黄丽玲");
    addAlias("BEYOND", "黄家驹", "member_of");
    const snap = exportSeedSnapshot(7);
    expect(snap.version).toBe(7);
    expect(snap.generatedAt).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(snap.entries.length).toBe(2);
    expect(snap.entries.some((e) => e[0] === "A-Lin" && e[1] === "黄丽玲" && e[2] === "alias")).toBe(true);
    expect(snap.entries.some((e) => e[2] === "member_of")).toBe(true);
  });

  it("exportSeedSnapshot：空表导出空 entries", () => {
    const snap = exportSeedSnapshot(1);
    expect(snap.entries).toEqual([]);
  });

  it("applySeedIfNeeded：已应用版本 >= 种子版本时短路（不重复灌）", () => {
    const seed = readSeed();
    if (!seed) return; // 环境无种子文件时跳过该断言
    sqlite.prepare("INSERT INTO settings (key, value, updated_at) VALUES (?,?,?)")
      .run(APPLIED_KEY, String(seed.version + 100), new Date().toISOString());
    const out = applySeedIfNeeded();
    expect(out.applied).toBe(false);
    expect(out.version).toBe(seed.version);
  });

  it("applySeedIfNeeded：非法已应用值（NaN）按 0 处理，可能灌入种子", () => {
    sqlite.prepare("INSERT INTO settings (key, value, updated_at) VALUES (?,?,?)")
      .run(APPLIED_KEY, "garbage", new Date().toISOString());
    const out = applySeedIfNeeded();
    // 要么灌入成功（有种子文件），要么无种子文件返回 applied:false —— 两种都不抛错
    expect(typeof out.applied).toBe("boolean");
  });
});
