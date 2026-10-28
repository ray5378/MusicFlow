// ==================== QA 独立反证：闸门 0 是不是真的零字节 ====================
//
// 实现者用「resolvePreferredSong 是否被调」当探针，只测了 prefetchSong 这一个入口。
// 真实排程入口是 prefetchUpcoming（lookahead=1 的调度器）—— 如果它绕过 prefetchSong
// 直接下字节，闸门 0 就形同虚设。本文件从**排程入口**打进去验证。
import { describe, it, expect, vi, beforeAll, beforeEach, afterAll } from "vitest";

const st = vi.hoisted(() => ({
  resolved: [] as string[],
  dead: new Set<string>(),
}));

vi.mock("../../src/services/source/preferredSource.js", () => ({
  resolvePreferredSong: async (row: any) => {
    st.resolved.push(row?.id ?? "?");
    return row;
  },
}));

vi.mock("../../src/services/source/online/streamFallback.js", async (importOriginal) => {
  const actual = await importOriginal<any>();
  return {
    ...actual,
    getCachedPlayability: (songId: string) => (st.dead.has(songId) ? "unplayable" : "unknown"),
    markUnplayable: (songId: string) => st.dead.add(songId),
  };
});

import { sqlite } from "../../src/db/index.js";
import { prefetchSong, prefetchUpcoming, resetPrefetchForTest } from "../../src/services/source/prefetchCache.js";

beforeAll(() => {
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS songs (
      id TEXT PRIMARY KEY, title TEXT, path TEXT, type TEXT, size INTEGER,
      duration REAL, suffix TEXT, group_id TEXT, url TEXT, stream_headers TEXT
    );
  `);
  const ins = sqlite.prepare(
    "INSERT INTO songs (id, title, path, type, size, duration, suffix) VALUES (?,?,?,?,?,?,?) ON CONFLICT(id) DO NOTHING",
  );
  ins.run("qu-dead", "t1", "l:/nonexistent-1.mp3", "local", 1000, 200, "mp3");
  ins.run("qu-plain", "t2", "l:/nonexistent-2.mp3", "local", 1000, 200, "mp3");
});

beforeEach(() => {
  st.resolved.length = 0;
  st.dead.clear();
  resetPrefetchForTest();
});

afterAll(() => {
  resetPrefetchForTest();
});

const peek = (items: string[], currentIndex = 0) =>
  ({ items: items.map((songId) => ({ songId })), currentIndex, playMode: "order" }) as any;

async function settle(ms = 400): Promise<void> {
  await new Promise((r) => setTimeout(r, ms));
}

describe("QA⑤ 闸门 0 从排程入口（prefetchUpcoming）验证", () => {
  it("已判死的歌经 prefetchUpcoming 排程 ⇒ 一个字节都不下；同轮其它歌照旧", async () => {
    st.dead.add("qu-dead");
    // 队列 = [当前曲, qu-dead(已判死), qu-plain(活)]，游标 0 ⇒ lookahead 覆盖到这两首
    prefetchUpcoming(peek(["qu-cur", "qu-dead", "qu-plain"]), 2);
    await settle();
    expect(st.resolved).toEqual(["qu-plain"]);
  });

  it("未判死时排程照旧放行（基线：证明上面的拦截不是因为排程根本没跑）", async () => {
    // 队列 = [当前曲, qu-dead, qu-plain]，游标在 0 ⇒ lookahead 覆盖后两首
    prefetchUpcoming(peek(["qu-cur", "qu-dead", "qu-plain"]), 2);
    await settle();
    expect(st.resolved.slice().sort()).toEqual(["qu-dead", "qu-plain"]);
  });

  it("★ 判死发生在预取**排队之后**：同步闸门（句柄已装载）也必须拦下", async () => {
    // 先跑一次正常预取，把同步句柄 playabilityReader 装载起来
    await prefetchSong("qu-plain");
    expect(st.resolved).toContain("qu-plain");
    st.resolved.length = 0;
    // 句柄已装载后再判死 ⇒ 同步闸门应在进队之前就 return
    st.dead.add("qu-dead");
    await prefetchSong("qu-dead");
    await prefetchSong("qu-dead");
    expect(st.resolved).toEqual([]);
  });

  it("★ 判死后被 evict（TTL 到/逐出）⇒ 恢复预取（闸门不是永久封死）", async () => {
    st.dead.add("qu-dead");
    await prefetchSong("qu-dead");
    expect(st.resolved).toEqual([]);
    // 模拟逐出
    st.dead.delete("qu-dead");
    await prefetchSong("qu-dead");
    expect(st.resolved).toContain("qu-dead");
  });
});
