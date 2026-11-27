import { describe, it, expect } from "vitest";
import {
  clampRecentLimit,
  selectRecentPlaylists,
  RECENT_DEFAULT_LIMIT,
  RECENT_MAX_LIMIT,
  type RecentPoolItem,
} from "../../src/routes/api/homeRecentPlaylists.js";

// 「最近更新」纯计算：无随机位，按 changed 倒序，确定且新鲜。
describe("clampRecentLimit（?limit 夹取）", () => {
  it("缺省 / 非法 → 默认 20", () => {
    expect(clampRecentLimit(undefined)).toBe(RECENT_DEFAULT_LIMIT);
    expect(clampRecentLimit("abc")).toBe(RECENT_DEFAULT_LIMIT);
    expect(clampRecentLimit("")).toBe(RECENT_DEFAULT_LIMIT);
  });
  it("0 视为要 1 条（不是没传），上限 100", () => {
    expect(clampRecentLimit("0")).toBe(1);
    expect(clampRecentLimit("-5")).toBe(1);
    expect(clampRecentLimit("999")).toBe(RECENT_MAX_LIMIT);
    expect(clampRecentLimit("20")).toBe(20);
    expect(clampRecentLimit("7")).toBe(7);
  });
});

describe("selectRecentPlaylists（最近更新倒序）", () => {
  const pool: RecentPoolItem[] = [
    { id: "b", name: "B", songCount: 5, changed: "2026-11-15T10:00:00.000Z" },
    { id: "a", name: "A", songCount: 3, changed: "2026-11-16T10:00:00.000Z" },
    { id: "c", name: "C", songCount: 8, changed: "2026-11-15T10:00:00.000Z" }, // 与 b 并列
  ];

  it("changed 降序，并列按 id 升序兜底（结果确定）", () => {
    const out = selectRecentPlaylists(pool, 10);
    expect(out.map((x) => x.id)).toEqual(["a", "b", "c"]);
  });

  it("coverArt 由服务端算好 pl-<id>", () => {
    const out = selectRecentPlaylists(pool, 10);
    expect(out.every((x) => x.coverArt === `pl-${x.id}`)).toBe(true);
  });

  it("limit 截断，且不修改入参数组", () => {
    const out = selectRecentPlaylists(pool, 2);
    expect(out.map((x) => x.id)).toEqual(["a", "b"]);
    expect(pool.map((x) => x.id)).toEqual(["b", "a", "c"]); // 原序未变
  });

  it("非数组 / 空池 / limit=0 返回空", () => {
    expect(selectRecentPlaylists(null as any, 10)).toEqual([]);
    expect(selectRecentPlaylists([], 10)).toEqual([]);
    expect(selectRecentPlaylists(pool, 0)).toEqual([]);
  });

  it("非法 limit（NaN）回落到默认 20", () => {
    expect(selectRecentPlaylists(pool, NaN).length).toBe(pool.length);
  });
});
