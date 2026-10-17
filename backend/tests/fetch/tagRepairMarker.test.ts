// 标签修复完成标记(tag_repair_done)单测：覆盖写入/命中失效/30 天 TTL/统计口径/DB 异常降级。
// 依赖 setup.ts 已初始化的真实 SQLite schema（tag_repair_done 表由 initDatabase 建好）。
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sqlite } from "../../src/db/index.js";
import {
  _resetTagRepairMarkersForTest,
  clearTagRepairMark,
  getTagRepairMarkedCount,
  getTagRepairMarkedPaths,
  getTagRepairPlatformCounts,
  getTagRepairUnobtainableCount,
  isTagRepairMarked,
  markTagRepairDone,
} from "../../src/services/fetch/tagRepairMarker.js";

/** 让 sqlite.prepare 对匹配的 SQL 抛错(其余走真实实现),用于覆盖 catch 降级分支。 */
function breakPrepare(pattern: RegExp): void {
  const realPrepare = sqlite.prepare.bind(sqlite);
  vi.spyOn(sqlite, "prepare").mockImplementation(((sql: string) => {
    if (pattern.test(String(sql))) throw new Error("db down");
    return realPrepare(sql);
  }) as never);
}

/** 直接改某行的 at 列(构造超期/非法时间 TTL)。 */
function setAt(fsPath: string, atIso: string): void {
  sqlite.prepare("UPDATE tag_repair_done SET at = ? WHERE fs_path = ?").run(atIso, fsPath);
}

function makeFile(name: string, content: string): string {
  const f = path.join(basedir, name);
  writeFileSync(f, content);
  return f;
}

let basedir: string;

describe("tagRepairMarker 标签修复完成标记", () => {
  beforeEach(() => {
    basedir = mkdtempSync(path.join(os.tmpdir(), "mf-tagmark-"));
    _resetTagRepairMarkersForTest();
  });

  afterEach(() => {
    rmSync(basedir, { recursive: true, force: true });
    _resetTagRepairMarkersForTest();
    vi.restoreAllMocks();
  });

  it("markTagRepairDone：空路径/文件不存在返回 false；文件存在写入并可命中", () => {
    const f = makeFile("song.flac", "hello");
    expect(markTagRepairDone("", "src")).toBe(false);
    expect(markTagRepairDone(path.join(basedir, "missing.flac"), "src")).toBe(false);
    expect(markTagRepairDone(f, "tag-provider", "qq")).toBe(true);
    expect(isTagRepairMarked(f)).toBe(true);
  });

  it("isTagRepairMarked：空路径/无标记均返回 false", () => {
    expect(isTagRepairMarked("")).toBe(false);
    expect(isTagRepairMarked(path.join(basedir, "unmarked.flac"))).toBe(false);
  });

  it("isTagRepairMarked：size/mtime 变化或文件消失 → 判失效并清除失效行", () => {
    const f = makeFile("changed.flac", "hello");
    markTagRepairDone(f, "s", "qq");
    expect(isTagRepairMarked(f)).toBe(true);

    writeFileSync(f, "hello-world-longer"); // size 变化
    expect(isTagRepairMarked(f)).toBe(false);
    expect(getTagRepairMarkedPaths()).not.toContain(f); // 失效行已删除

    // 位置没动但 mtime 被改写 → 失效
    markTagRepairDone(f, "s", "qq");
    setAt(f, new Date().toISOString());
    sqlite
      .prepare("UPDATE tag_repair_done SET mtime_ms = ? WHERE fs_path = ?")
      .run(Date.now() + 10_000, f);
    expect(isTagRepairMarked(f)).toBe(false);

    // 文件被删除 → 标记失去意义
    markTagRepairDone(f, "s", "qq");
    rmSync(f);
    expect(isTagRepairMarked(f)).toBe(false);
  });

  it("markTagRepairDone 幂等：重复标记以最新 src/platform 为准；空 platform 落 NULL", () => {
    const f = makeFile("idem.flac", "a");
    markTagRepairDone(f, "s1", "qq");
    writeFileSync(f, "a-much-longer");
    markTagRepairDone(f, "s2", "netease");
    let row = sqlite
      .prepare("SELECT src, platform FROM tag_repair_done WHERE fs_path = ?")
      .get(f) as { src: string; platform: string | null };
    expect(row.src).toBe("s2");
    expect(row.platform).toBe("netease");

    markTagRepairDone(f, "s3", undefined); // platform 三元 false 分支 → NULL
    row = sqlite
      .prepare("SELECT src, platform FROM tag_repair_done WHERE fs_path = ?")
      .get(f) as { src: string; platform: string | null };
    expect(row.platform).toBeNull();
  });

  it("unobtainable 带 30 天 TTL：期内命中、超期失效(不删行)；fixed 不受 TTL 影响", () => {
    const f = makeFile("unobj.flac", "x");
    expect(markTagRepairDone(f, "s", "qq", "unobtainable")).toBe(true);
    expect(isTagRepairMarked(f)).toBe(true);

    setAt(f, new Date(Date.now() - 31 * 24 * 3_600_000).toISOString()); // 31 天前
    expect(isTagRepairMarked(f)).toBe(false);
    expect(getTagRepairMarkedPaths()).toContain(f); // 超期只是放弃跳过，不删行

    // at 非法 → Number.isFinite 为假 → 视为未超期仍命中
    setAt(f, "not-a-date");
    expect(isTagRepairMarked(f)).toBe(true);

    // fixed outcome 即便 at 很旧也命中
    const g = makeFile("fixed.flac", "y");
    markTagRepairDone(g, "s", "qq", "fixed");
    setAt(g, new Date(Date.now() - 400 * 24 * 3_600_000).toISOString());
    expect(isTagRepairMarked(g)).toBe(true);
  });

  it("clearTagRepairMark：清除后不再命中；空路径为 no-op", () => {
    const f = makeFile("clr.flac", "x");
    markTagRepairDone(f, "s");
    clearTagRepairMark(f);
    expect(isTagRepairMarked(f)).toBe(false);
    expect(() => clearTagRepairMark("")).not.toThrow();
  });

  it("统计口径：MarkedCount 排除 unobtainable；Unobtainable 单独计数；Paths 含全部；PlatformCounts 排除 unobtainable 且 NULL→空串", () => {
    const f1 = makeFile("f1.flac", "1");
    const f2 = makeFile("f2.flac", "2");
    const f3 = makeFile("f3.flac", "3");
    markTagRepairDone(f1, "s", "qq"); // fixed + qq
    markTagRepairDone(f2, "s"); // fixed + NULL
    markTagRepairDone(f3, "s", "qq", "unobtainable"); // 终态不可得

    expect(getTagRepairMarkedCount()).toBe(2);
    expect(getTagRepairUnobtainableCount()).toBe(1);
    expect(getTagRepairMarkedPaths().sort()).toEqual([f1, f2, f3].sort());

    // 历史行 outcome=NULL 亦计入已修复；platform=NULL 归空串
    sqlite
      .prepare(
        "INSERT INTO tag_repair_done (fs_path, size, mtime_ms, src, platform, outcome, at) VALUES (?,?,?,?,?,?,?)",
      )
      .run(path.join(basedir, "hist.flac"), 0, 0, "", null, null, "");
    expect(getTagRepairMarkedCount()).toBe(3);

    const map = Object.fromEntries(getTagRepairPlatformCounts().map((r) => [r.platform, r.count]));
    expect(map["qq"]).toBe(1); // 仅 f1
    expect(map[""]).toBe(2); // f2 + 历史行
  });

  it("DB 异常降级：统计类返回 0/[]，reset 静默，标记写入失败返回 false", () => {
    const f = makeFile("boom.flac", "x");
    breakPrepare(/./); // 所有语句抛错
    expect(getTagRepairMarkedCount()).toBe(0);
    expect(getTagRepairUnobtainableCount()).toBe(0);
    expect(getTagRepairMarkedPaths()).toEqual([]);
    expect(getTagRepairPlatformCounts()).toEqual([]);
    expect(markTagRepairDone(f, "s")).toBe(false);
    expect(() => _resetTagRepairMarkersForTest()).not.toThrow();
  });

  it("deleteMarker 异常：文件消失触发删行、删除语句抛错被吞，仍返回未命中", () => {
    const f = makeFile("delfail.flac", "x");
    markTagRepairDone(f, "s", "qq");
    rmSync(f);
    breakPrepare(/DELETE/i); // 仅删行语句抛错，查询走真实实现
    expect(isTagRepairMarked(f)).toBe(false);
    vi.restoreAllMocks();
    expect(getTagRepairMarkedPaths()).toContain(f); // 删除失败 → 行仍在
  });
});
