// MUST be the first import: redirects DATA_DIR to an isolated temp dir before
// the backend opens its SQLite DB at module-load time.
import "../plugins/_env.js";

import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import { Hono } from "hono";
import md5 from "md5";
import { db, initDatabase, encryptPassword } from "../../src/db/index.js";
import { users, playlists, playlistSongs, songs } from "../../src/db/schema.js";
import { eq, asc } from "drizzle-orm";
import { authMiddleware } from "../../src/middleware/auth.js";

// ==================== mocks ====================
// 这些 mock 让路由走「已配置 provider」的正常分支,不被真实网络/子进程拖住。
// vi.mock 会被提升到文件顶部,故共享 mock 对象必须经 vi.hoisted 先建。
const { FAKE_PROVIDER, matchMocks, runBatchJobMock, BATCH_RESULTS } = vi.hoisted(() => {
  const results: Record<string, any> = {
    "match-playlist": { matched: 1, noMatch: 0, error: 0, results: [{ entryId: 1 }] },
    "match-playlists": { done: 1, results: [{ id: "pl1", matched: 1 }] },
    "purge-web-songs": { purged: 2 },
    "recommend-sync-all": { imported: 1 },
  };
  return {
    BATCH_RESULTS: results,
    FAKE_PROVIDER: {
      test: vi.fn(async () => ({ success: true, message: "ok" })),
      search: vi.fn(async (_cfg: any, p: any) => ({
        songs: [{ id: "o1", title: "T", source: "netease", artist: "A", album: "AL", duration: 100, platform: "netease" }],
        query: p.query,
      })),
      streamUrl: vi.fn(() => "http://stream/1.mp3"),
      recommend: vi.fn(async () => ({
        channels: [{ name: "netease", playlists: [{ id: "r1", name: "热门", source: "netease" }] }],
      })),
      playlistSongs: vi.fn(async () => ({ songs: [] })),
    },
    matchMocks: {
      matchUnmatchedPlaylistEntries: vi.fn(async () => ({ total: 1, matched: 1, noMatch: 0, error: 0, results: [] })),
      matchToOnlineSong: vi.fn(async () => ({ status: "matched", songId: "s-imp" })),
      crossVerifySongs: vi.fn(async (_p: string, _c: any, _pr: any, list: any[]) => ({ verified: list, rejected: 0 })),
    },
    runBatchJobMock: vi.fn(async (kind: string, _payload: any, opts?: any) => {
      if (opts?.onProgress) opts.onProgress({ done: 1, total: 1, current: "pl1" });
      return { result: results[kind] ?? {} };
    }),
  };
});

vi.mock("../../src/services/source/online/index.js", async (importOriginal) => {
  const actual = await importOriginal<any>();
  return {
    ...actual,
    getOnlineProvider: () => FAKE_PROVIDER,
    getSourcePluginConfig: () => ({ baseUrl: "http://fake" }),
    getConfiguredProvider: () => ({ provider: FAKE_PROVIDER, config: { baseUrl: "http://fake" } }),
  };
});

vi.mock("../../src/services/source/online/match.js", async (importOriginal) => {
  const actual = await importOriginal<any>();
  return { ...actual, ...matchMocks };
});

vi.mock("../../src/services/source/online/service.js", async (importOriginal) => {
  const actual = await importOriginal<any>();
  return {
    ...actual,
    importOnlineSongs: vi.fn(async () => ({ imported: 1, ids: ["s-imp"], deduped: [] })),
  };
});

vi.mock("../../src/services/source/online/recommendImport.js", async (importOriginal) => {
  const actual = await importOriginal<any>();
  return {
    ...actual,
    importRecommendPlaylist: vi.fn(async () => ({ success: true, playlistId: "pl1", songCount: 1 })),
    isDailyRecommendPlaylist: (p: any) => String(p?.id || "").startsWith("pl-daily"),
    findRecommendPlaylist: () => null,
  };
});

vi.mock("../../src/services/plugin/jobRunner.js", async (importOriginal) => {
  const actual = await importOriginal<any>();
  return { ...actual, runPluginJob: vi.fn(() => ({ started: true, alreadyRunning: false })) };
});

vi.mock("../../src/batch/runner.js", async (importOriginal) => {
  const actual = await importOriginal<any>();
  return { ...actual, runBatchJob: runBatchJobMock };
});

// ==================== harness ====================
import { onlineRoutes } from "../../src/routes/api/online.js";

const app = new Hono();
app.use("/rest/api/*", authMiddleware);
app.route("/rest/api", onlineRoutes);

const PLAIN = "hunter2";
const SALT = "clientsalt123";
const authQS = () => `u=alice&t=${md5(PLAIN + SALT)}&s=${SALT}`;
async function call(method: string, path: string, body?: any) {
  const res = await app.request(`/rest/api${path}${path.includes("?") ? "&" : "?"}${authQS()}`, {
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let parsed: any = null;
  try { parsed = JSON.parse(text); } catch { parsed = null; }
  return { status: res.status, body: parsed, text };
}
const settle = () => new Promise((r) => setTimeout(r, 25));
const P = "go-music-dl";

beforeAll(() => {
  if (!process.env.APP_VERSION) process.env.APP_VERSION = "1.0.0";
  initDatabase();
  db.insert(users).values({
    id: "u1", username: "alice", password: "", salt: "salt", subsonicSalt: "subsalt",
    passEnc: encryptPassword(PLAIN), isAdmin: 1, isActive: 1,
  }).run();
  db.insert(playlists).values([
    { id: "pl1", name: "小歌单", ownerId: "u1", isPublic: 0, songCount: 2 },
    { id: "pl2", name: "大歌单", ownerId: "u1", isPublic: 0, songCount: 31 },
    { id: "pl-daily", name: "每日推荐", ownerId: "u1", sourcePlatform: "netease", externalId: "r1", songCount: 3, coverArt: "c/x.jpg" },
  ]).run();
  // playlist_songs.song_id 有 FK 指向 songs,先建被引用的曲目行。
  db.insert(songs).values({ id: "s-ok", title: "可播歌", path: "l:src:/ok.mp3" }).run();
  db.insert(playlistSongs).values([
    { playlistId: "pl1", songId: null, position: 0, playable: 0, externalTitle: "未匹配歌", externalArtist: "A", externalAlbum: "AL", externalDuration: 200 },
    { playlistId: "pl1", songId: "s-ok", position: 1, playable: 1, externalTitle: "" },
  ]).run();
  const many: any[] = [];
  for (let i = 0; i < 31; i += 1) {
    many.push({ playlistId: "pl2", songId: null, position: i, playable: 0, externalTitle: `未匹配${i}` });
  }
  db.insert(playlistSongs).values(many).run();
});

describe("online: provider test / search", () => {
  it("POST test → 透传 provider 连通性结果", async () => {
    const r = await call("POST", `/v1/online/${P}/test`);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ success: true, message: "ok" });
    expect(FAKE_PROVIDER.test).toHaveBeenCalled();
  });

  it("POST search → 返回带 platformLabel/streamUrl 的歌曲列表", async () => {
    const r = await call("POST", `/v1/online/${P}/search`, { q: "周杰伦" });
    expect(r.status, r.text.slice(0, 200)).toBe(200);
    expect(r.body.success).toBe(true);
    expect(r.body.total).toBe(1);
    expect(r.body.songs[0]).toMatchObject({ platformLabel: "netease", streamUrl: "http://stream/1.mp3" });
  });

  it("POST search → 缺 q 报错,provider 抛错被吞成 success=false", async () => {
    const missing = await call("POST", `/v1/online/${P}/search`, {});
    expect(missing.body.success).toBe(false);
    FAKE_PROVIDER.search.mockRejectedValueOnce(new Error("boom"));
    const bad = await call("POST", `/v1/online/${P}/search`, { q: "x" });
    expect(bad.body.success).toBe(false);
    expect(bad.body.error).toBe("boom");
  });
});

describe("online: 歌单匹配", () => {
  it("match-playlist → 缺 playlistId / 歌单不存在 / 无未匹配条目", async () => {
    const noId = await call("POST", `/v1/online/${P}/match-playlist`, {});
    expect(noId.body.success).toBe(false);
    const missing = await call("POST", `/v1/online/${P}/match-playlist`, { playlistId: "nope" });
    expect(missing.status).toBe(404);
    // pl1 有 1 条未匹配 → 小歌单走内联匹配
    const small = await call("POST", `/v1/online/${P}/match-playlist`, { playlistId: "pl1" });
    expect(small.body).toMatchObject({ success: true, jobId: null, matched: 1 });
    expect(matchMocks.matchUnmatchedPlaylistEntries).toHaveBeenCalled();
  });

  it("match-playlist → 无未匹配条目时 alreadyMatched 短路", async () => {
    const r = await call("POST", `/v1/online/${P}/match-playlist`, { playlistId: "pl-daily" });
    expect(r.body).toMatchObject({ success: true, total: 0, alreadyMatched: true });
  });

  it("match-playlist → 大歌单走后台任务,状态可轮询", async () => {
    const r = await call("POST", `/v1/online/${P}/match-playlist`, { playlistId: "pl2" });
    expect(r.body.running).toBe(true);
    expect(runBatchJobMock).toHaveBeenCalledWith("match-playlist", expect.anything(), expect.anything());
    const jobId = r.body.jobId;
    const noJob = await call("GET", `/v1/online/${P}/match-playlist/status`);
    expect(noJob.body.success).toBe(false);
    const unknown = await call("GET", `/v1/online/${P}/match-playlist/status?jobId=nope`);
    expect(unknown.status).toBe(404);
    await settle();
    const st = await call("GET", `/v1/online/${P}/match-playlist/status?jobId=${jobId}`);
    expect(st.status).toBe(200);
    expect(st.body.status).toBe("completed");
    expect(st.body.result).toMatchObject({ matched: 1 });
  });

  it("match-playlists → 批量适配启动 + 状态轮询", async () => {
    const r = await call("POST", `/v1/online/${P}/match-playlists`);
    expect(r.body).toMatchObject({ success: true, started: true });
    expect(r.body.total).toBeGreaterThanOrEqual(2);
    const noId = await call("GET", `/v1/online/${P}/match-playlists/status`);
    expect(noId.body.success).toBe(false);
    const unknown = await call("GET", `/v1/online/${P}/match-playlists/status?batchId=nope`);
    expect(unknown.status).toBe(404);
    await settle();
    const st = await call("GET", `/v1/online/${P}/match-playlists/status?batchId=${r.body.batchId}`);
    expect(st.body.status).toBe("completed");
    expect(st.body.results.length).toBe(1);
  });

  it("match-track → 参数/条目校验 + 已可播短路 + 命中匹配", async () => {
    const bad = await call("POST", `/v1/online/${P}/match-track`, { entryId: 0 });
    expect(bad.body.success).toBe(false);
    const missing = await call("POST", `/v1/online/${P}/match-track`, { entryId: 999999 });
    expect(missing.status).toBe(404);
    const rows = db.select().from(playlistSongs).where(eq(playlistSongs.playlistId, "pl1")).orderBy(asc(playlistSongs.position)).all();
    const playable = rows.find((r) => r.playable);
    const done = await call("POST", `/v1/online/${P}/match-track`, { entryId: playable!.id });
    expect(done.body).toMatchObject({ success: true, alreadyPlayable: true });
    const unmatched = rows.find((r) => !r.playable);
    const hit = await call("POST", `/v1/online/${P}/match-track`, { entryId: unmatched!.id });
    expect(hit.body).toMatchObject({ success: true, status: "matched" });
  });

  it("unmatched → 缺参数报错,正常返回占位条目", async () => {
    const bad = await call("GET", `/v1/online/${P}/unmatched`);
    expect(bad.body.success).toBe(false);
    const ok = await call("GET", `/v1/online/${P}/unmatched?playlistId=pl1`);
    expect(ok.body.success).toBe(true);
    expect(ok.body.count).toBe(1);
    expect(ok.body.entries[0]).toMatchObject({ title: "未匹配歌" });
  });
});

describe("online: 导入", () => {
  // 用例执行顺序由 vitest 决定(非声明序),跨用例的 mock 调用计数必须逐例清零,
  // 否则「本用例未触发核实」类断言会被别的用例的调用污染。
  beforeEach(() => {
    matchMocks.crossVerifySongs.mockClear();
  });

  it("import → 缺 songs / 未配置 provider 报错", async () => {
    const empty = await call("POST", `/v1/online/${P}/import`, { songs: [] });
    expect(empty.body.success).toBe(false);
    const noSongs = await call("POST", `/v1/online/${P}/import`, {});
    expect(noSongs.body.success).toBe(false);
  });

  it("import → verified=true 直接入库(跳过交叉核实)", async () => {
    const r = await call("POST", `/v1/online/${P}/import`, {
      songs: [{ id: "o1", title: "T", source: "netease" }],
      playlistId: "pl1",
      verified: true,
    });
    expect(r.status, r.text.slice(0, 200)).toBe(200);
    expect(r.body).toMatchObject({ success: true, rejected: 0, imported: 1 });
    expect(matchMocks.crossVerifySongs).not.toHaveBeenCalled();
  });

  it("import → 未 verified 走交叉核实;全被拒时报错并回传数量", async () => {
    matchMocks.crossVerifySongs.mockResolvedValueOnce({ verified: [], rejected: 3 });
    const r = await call("POST", `/v1/online/${P}/import`, { songs: [{ id: "o1", title: "T" }] });
    expect(r.body.success).toBe(false);
    expect(r.body.rejected).toBe(3);
    matchMocks.crossVerifySongs.mockResolvedValueOnce({ verified: [{ id: "o2", title: "T2" }], rejected: 1 });
    const ok = await call("POST", `/v1/online/${P}/import`, { songs: [{ id: "o2", title: "T2" }] });
    expect(ok.body).toMatchObject({ success: true, rejected: 1, imported: 1 });
  });

  it("import → 入库抛错被吞成 success=false", async () => {
    const pkg: any = await import("../../src/services/source/online/service.js");
    (pkg.importOnlineSongs as any).mockRejectedValueOnce(new Error("db down"));
    const r = await call("POST", `/v1/online/${P}/import`, { songs: [{ id: "o3" }], verified: true });
    expect(r.body).toMatchObject({ success: false, error: "db down" });
  });
});

describe("online: 推荐歌单", () => {
  it("recommend → 渠道列表并标注 imported", async () => {
    const r = await call("GET", `/v1/online/${P}/recommend`);
    expect(r.status, r.text.slice(0, 200)).toBe(200);
    expect(r.body.success).toBe(true);
    expect(r.body.channels[0].playlists[0].imported).toBe(false);
    expect(FAKE_PROVIDER.recommend).toHaveBeenCalled();
  });

  it("recommend → provider 无 recommend 能力时明确报错", async () => {
    const r = await call("GET", `/v1/online/${P}/recommend`);
    expect(r.body.success).toBe(true);
    FAKE_PROVIDER.recommend.mockRejectedValueOnce(new Error("upstream down"));
    const bad = await call("GET", `/v1/online/${P}/recommend`);
    expect(bad.body).toMatchObject({ success: false, error: "upstream down" });
  });

  it("recommend/local → 只列出本地已导入的推荐歌单", async () => {
    const r = await call("GET", `/v1/online/${P}/recommend/local`);
    expect(r.body.success).toBe(true);
    expect(r.body.playlists.map((p: any) => p.id)).toEqual(["pl-daily"]);
    expect(r.body.playlists[0]).toMatchObject({ source: "netease", imported: true, coverArt: "pl-pl-daily" });
  });

  it("recommend/import → 缺 source/id 报错,成功透传结果", async () => {
    const bad = await call("POST", `/v1/online/${P}/recommend/import`, { id: "r1" });
    expect(bad.body.success).toBe(false);
    const ok = await call("POST", `/v1/online/${P}/recommend/import`, { id: "r1", source: "netease", name: "热门", trackCount: "12" });
    expect(ok.body).toMatchObject({ success: true, playlistId: "pl1" });
  });

  it("recommend/sync-all → 启动聚合;重复调用 409;状态可查", async () => {
    // 让路径 A 的后台任务挂住不返回,才能观察到「运行中 → 重复调用 409」的语义。
    let releaseSync!: () => void;
    runBatchJobMock.mockImplementationOnce((_kind: string) => new Promise((res) => {
      releaseSync = () => res({ result: BATCH_RESULTS["recommend-sync-all"] });
    }));
    const first = await call("POST", `/v1/online/${P}/recommend/sync-all`);
    expect(first.body).toMatchObject({ success: true, started: true });
    expect(first.body.pathA).toMatchObject({ running: true });
    const again = await call("POST", `/v1/online/${P}/recommend/sync-all`);
    expect(again.status).toBe(409);
    const running = await call("GET", `/v1/online/${P}/recommend/sync-all/status`);
    expect(running.body.running).toBe(true);
    releaseSync();
    await settle();
    const st = await call("GET", `/v1/online/${P}/recommend/sync-all/status`);
    expect(st.body.running).toBe(false);
    expect(st.body.result).toMatchObject({ imported: 1 });
  });

  it("sync-all/status → 无记录 404", async () => {
    const r = await call("GET", `/v1/online/other-provider/recommend/sync-all/status`);
    expect(r.status).toBe(404);
  });

  it("purge-web-songs → 未配置报错,已配置走批量清理", async () => {
    const ok = await call("POST", `/v1/online/${P}/purge-web-songs`);
    expect(runBatchJobMock).toHaveBeenCalledWith("purge-web-songs", { providerId: P });
    expect(ok.body).toMatchObject({ success: true, purged: 2 });
  });
});
