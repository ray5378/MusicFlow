// ==================== online 路由:错误契约与后台任务状态 ====================
//
// 为什么补这一层:既有 `apiOnline.test.ts` 覆盖了各端点的 happy path 与少量校验,
// 但**上游服务抛错 → 路由 catch → 错误响应体形状**这条链(以及后台批量任务的
// failed 状态收口)几乎零覆盖。这些分支正是「用户看到什么」的落点:状态码错了,
// 前端会把「上游炸了」当成「参数错」;错误体少了 error 字段,前端只显示空白。
//
// 手法:与 apiOnline.test.ts 同款 —— 用 `_env.js` 隔离 DATA_DIR、真实 authMiddleware、
// 真实的 onlineRoutes,只把服务层入口换成可编程假体。
//
// MUST be the first import: redirects DATA_DIR to an isolated temp dir.
import "../plugins/_env.js";

import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import { translate } from "../../src/i18n.js";
import { Hono } from "hono";
import md5 from "md5";
import { db, initDatabase, encryptPassword } from "../../src/db/index.js";
import { users, playlists, playlistSongs, songs } from "../../src/db/schema.js";

const { FAKE_PROVIDER, matchMocks, runBatchJobMock, ctrl } = vi.hoisted(() => {
  return {
    // 上游能力假体:各用例按需覆写单个方法。
    FAKE_PROVIDER: {
      test: vi.fn(async () => ({ success: true, message: "ok" })),
      search: vi.fn(async () => ({ songs: [] })),
      streamUrl: vi.fn(() => "http://stream/1.mp3"),
      recommend: vi.fn(async () => ({ channels: [] })),
      playlistSongs: vi.fn(async () => ({ songs: [] })),
    },
    matchMocks: {
      matchUnmatchedPlaylistEntries: vi.fn(async () => ({ total: 1, matched: 1, noMatch: 0, error: 0, results: [] })),
      matchToOnlineSong: vi.fn(async () => ({ status: "matched", songId: "s-imp" })),
      crossVerifySongs: vi.fn(async (_p: string, _c: any, _pr: any, list: any[]) => ({ verified: list, rejected: 0 })),
    },
    // 批量任务假体:由 ctrl.failKind 决定这一次哪个 job 失败。
    runBatchJobMock: vi.fn(async (kind: string) => {
      if (ctrl.failKind === kind) throw new Error(ctrl.failMessage);
      return { result: { ok: true, kind } };
    }),
    ctrl: { failKind: "" as string, failMessage: "上游批量任务炸了" },
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
  return { ...actual, importOnlineSongs: vi.fn(async () => ({ imported: 1, ids: ["s-imp"], deduped: [] })) };
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

vi.mock("../../src/batch/runner.js", async (importOriginal) => {
  const actual = await importOriginal<any>();
  return { ...actual, runBatchJob: runBatchJobMock };
});

import { onlineRoutes } from "../../src/routes/api/online.js";
import { authMiddleware } from "../../src/middleware/auth.js";

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
const settle = () => new Promise((r) => setTimeout(r, 30));
const P = "go-music-dl";

beforeAll(() => {
  if (!process.env.APP_VERSION) process.env.APP_VERSION = "1.0.0";
  initDatabase();
  db.insert(users).values({
    id: "u1", username: "alice", password: "", salt: "salt", subsonicSalt: SALT,
    passEnc: encryptPassword(PLAIN), isAdmin: 1, isActive: 1,
  }).run();
  db.insert(playlists).values([
    { id: "pl-small", name: "小歌单", ownerId: "u1", isPublic: 0, songCount: 1 },
    { id: "pl-big", name: "大歌单", ownerId: "u1", isPublic: 0, songCount: 31 },
  ]).run();
  db.insert(songs).values({ id: "s-ok", title: "可播歌", path: "l:src:/ok.mp3" }).run();
  db.insert(playlistSongs).values([
    { playlistId: "pl-small", songId: null, position: 0, playable: 0, externalTitle: "未匹配", externalDuration: 200 },
    { playlistId: "pl-small", songId: "s-ok", position: 1, playable: 1, externalTitle: "" },
  ]).run();
  const many: any[] = [];
  for (let i = 0; i < 31; i += 1) {
    many.push({ playlistId: "pl-big", songId: null, position: i, playable: 0, externalTitle: `未匹配${i}` });
  }
  db.insert(playlistSongs).values(many).run();
});

beforeEach(() => {
  ctrl.failKind = "";
  matchMocks.matchUnmatchedPlaylistEntries.mockReset();
  matchMocks.matchUnmatchedPlaylistEntries.mockImplementation(async () => ({ total: 1, matched: 1, noMatch: 0, error: 0, results: [] }));
  matchMocks.matchToOnlineSong.mockReset();
  matchMocks.matchToOnlineSong.mockImplementation(async () => ({ status: "matched", songId: "s-imp" }));
  runBatchJobMock.mockClear();
});

describe("online:内联匹配失败必须映射为上游错误(而非 200 success:false)", () => {
  it("小歌单匹配抛错 → 5xx/UPSTREAM 语义 + 错误体带 error,绝不当成成功", async () => {
    matchMocks.matchUnmatchedPlaylistEntries.mockRejectedValueOnce(new Error("上游搜索超时"));
    const r = await call("POST", `/v1/online/${P}/match-playlist`, { playlistId: "pl-small" });
    expect(r.status).toBeGreaterThanOrEqual(400);
    expect(r.body.success).toBe(false);
    expect(String(r.body.error)).toContain("上游搜索超时");
  });
});

describe("online:大歌单后台任务失败要落到 status=failed(前端可轮询到原因)", () => {
  it("match-playlist 后台 job 抛错 → 状态 failed 且 error 可读", async () => {
    ctrl.failKind = "match-playlist";
    ctrl.failMessage = "子进程崩了";
    const r = await call("POST", `/v1/online/${P}/match-playlist`, { playlistId: "pl-big" });
    expect(r.body.running).toBe(true);
    expect(r.body.jobId).toBeTruthy();
    await settle();
    const st = await call("GET", `/v1/online/${P}/match-playlist/status?jobId=${r.body.jobId}`);
    expect(st.body.status).toBe("failed");
    // 后台任务失败:状态体暴露通用文案,内部异常原文不再外泄(只进服务端日志)
    expect(st.body.error).toBe(translate("errors.online.matchFailed"));
    expect(String(st.body.error)).not.toContain("子进程崩了");
    // 失败也必须带 finishedAt(前端靠它停止轮询 / 展示时长)
    expect(st.body.finishedAt).toBeTruthy();
  });

  it("match-playlists 批量 job 抛错 → 状态 failed 且 error 可读", async () => {
    ctrl.failKind = "match-playlists";
    ctrl.failMessage = "批量匹配失败";
    const r = await call("POST", `/v1/online/${P}/match-playlists`);
    expect(r.body.started).toBe(true);
    expect(r.body.batchId).toBeTruthy();
    await settle();
    const st = await call("GET", `/v1/online/${P}/match-playlists/status?batchId=${r.body.batchId}`);
    expect(st.body.status).toBe("failed");
    expect(String(st.body.error)).toContain("批量匹配失败");
  });

  it("recommend/sync-all 路径 A 抛错 → running 归 false 且 error 可读(不假装还在跑)", async () => {
    ctrl.failKind = "recommend-sync-all";
    ctrl.failMessage = "推荐重导失败";
    const r = await call("POST", `/v1/online/${P}/recommend/sync-all`);
    expect(r.body.success).toBe(true);
    await settle();
    const st = await call("GET", `/v1/online/${P}/recommend/sync-all/status`);
    expect(st.status).toBe(200);
    expect(st.body.running).toBe(false);
    expect(String(st.body.error)).toContain("推荐重导失败");
  });

  it("purge-web-songs 批量任务抛错 → 5xx/INTERNAL 语义 + error 透传", async () => {
    ctrl.failKind = "purge-web-songs";
    ctrl.failMessage = "清理子进程异常";
    const r = await call("POST", `/v1/online/${P}/purge-web-songs`);
    expect(r.status).toBeGreaterThanOrEqual(400);
    expect(r.body.success).toBe(false);
    expect(String(r.body.error)).toContain("清理子进程异常");
  });
});

describe("online:单曲匹配失败映射", () => {
  it("match-track 上游抛错 → 非 2xx + error(不得吞成 success:false 的 200)", async () => {
    const rows = db.select().from(playlistSongs).all().filter((e) => e.playlistId === "pl-small" && !e.playable);
    matchMocks.matchToOnlineSong.mockRejectedValueOnce(new Error("匹配服务不可用"));
    const r = await call("POST", `/v1/online/${P}/match-track`, { entryId: rows[0].id });
    expect(r.status).toBeGreaterThanOrEqual(400);
    expect(r.body.success).toBe(false);
    expect(String(r.body.error)).toContain("匹配服务不可用");
  });
});

describe("online:recommend/import 沙箱错误 → 稳定错误码 + 正确状态码 + sandboxCode/hint 透传(不得泄露内部异常原文)", () => {
  it("importRecommendPlaylist 抛带 sandboxCode/hint 的错误 → 502/UPSTREAM_ERROR + 通用文案 + 结构化字段", async () => {
    const mod: any = await import("../../src/services/source/online/recommendImport.js");
    const err: any = new Error("沙箱拒绝网络访问");
    err.sandboxCode = "SANDBOX_HTTP_DENIED";
    err.hint = "请在插件配置中放行该域名";
    (mod.importRecommendPlaylist as any).mockRejectedValueOnce(err);
    const r = await call("POST", `/v1/online/${P}/recommend/import`, { source: "netease", id: "r1", name: "热门" });
    // 合同:失败必须带业务错误码 + 正确 HTTP 状态码(此前是 200 + 无 code)
    expect(r.status).toBe(502);
    expect(r.body.success).toBe(false);
    expect(r.body.code).toBe("UPSTREAM_ERROR");
    expect(r.body.error).toBe(translate("errors.online.importRecommendFailed"));
    // 关键契约:sandboxCode / hint 必须出现在响应体里,否则前端只剩一句无解的错误文案
    expect(r.body.sandboxCode).toBe("SANDBOX_HTTP_DENIED");
    expect(r.body.hint).toBe("请在插件配置中放行该域名");
    // 内部异常原文不得外泄(只进服务端日志)
    expect(r.body.error).not.toContain("沙箱拒绝网络访问");
  });
});
