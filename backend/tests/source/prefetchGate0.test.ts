// ==================== prefetchSong 闸门 0：已判死 ⇒ 一个字节都不下 ====================
//
// 背景（2026-10-28 240 生产事故）：《等你飞奔而来》只有 60s 试听片段。判死之后，
// prefetchSong 原本还有「已缓存 / 在途 / 并发上限」三道闸门，唯独**没有「已判死」**这一道
// —— 于是同一首试听片段每次轮到都重新下一遍（240 实测：同一首 972KB，6 小时内下了 5 次）。
//
// 本文件钉死补上的闸门 0：
//   ① 未判死 ⇒ 照旧走到出流解析（resolvePreferredSong 被调用 = 准备下字节）；
//   ② 已判死 ⇒ 在**任何上游字节之前**返回，resolvePreferredSong 一次都不被调；
//   ③ 同步入口（句柄已装载后）同样拦下 —— 排队中的请求连 doPrefetch 都进不去。
//
// 探针选型：不做真实网络。用「resolvePreferredSong 是否被调用」当「是否决定要下字节」的
// 判据 —— 它在 doPrefetch 里位于闸门 0 **之后**、所有抓取动作**之前**（见 prefetchCache.ts）。
// 曲库行用本地行（type=local）：放行侧会在 isNetworkSong 处自然返回，不产生任何网络动作。
import { describe, it, expect, vi, beforeAll, beforeEach, afterAll } from "vitest";

const st = vi.hoisted(() => ({
  /** resolvePreferredSong 被喂进来的行 id（= 预取已决定要下字节）。 */
  resolved: [] as string[],
  /** 已被判死的 songId（streamFallback 负缓存的替身）。 */
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
import { prefetchSong, resetPrefetchForTest } from "../../src/services/source/prefetchCache.js";

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
  ins.run("pg-plain", "t1", "l:/nonexistent-1.mp3", "local", 1000, 200, "mp3");
  ins.run("pg-dead", "t2", "l:/nonexistent-2.mp3", "local", 1000, 200, "mp3");
});

beforeEach(() => {
  st.resolved.length = 0;
  resetPrefetchForTest();
});

afterAll(() => {
  resetPrefetchForTest();
});

describe("prefetchSong 闸门 0（已判死不下字节）", () => {
  it("① 未判死 ⇒ 照旧走到出流解析（放行侧的基线：探针确实会亮）", async () => {
    await prefetchSong("pg-plain");
    expect(st.resolved).toContain("pg-plain");
  });

  it("② 已判死 ⇒ 一个字节都不下：resolvePreferredSong 一次都不被调", async () => {
    st.dead.add("pg-dead");
    await prefetchSong("pg-dead");
    expect(st.resolved).not.toContain("pg-dead");
    expect(st.resolved).toEqual([]);
  });

  it("③ 同步入口同样拦下（句柄已装载后，排队中的请求连 doPrefetch 都进不去）", async () => {
    st.dead.add("pg-dead");
    // 第一次会进 doPrefetch 由权威版闸门拦下，同时装载同步句柄；
    // 第二次起同步闸门直接 return —— 两者都不许产生任何上游动作。
    await prefetchSong("pg-dead");
    await prefetchSong("pg-dead");
    await prefetchSong("pg-dead");
    expect(st.resolved).toEqual([]);
  });

  it("④ 判死只影响这一首：同一轮里未判死的歌照旧放行", async () => {
    st.dead.add("pg-dead");
    await prefetchSong("pg-dead");
    await prefetchSong("pg-plain");
    expect(st.resolved).toEqual(["pg-plain"]);
  });
});
