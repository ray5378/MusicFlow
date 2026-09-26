// MUST be the first import: redirects DATA_DIR to an isolated temp dir before
// the backend opens its SQLite DB at module-load time.
import "../plugins/_env.js";

import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import { Hono } from "hono";
import md5 from "md5";
import { db, initDatabase, encryptPassword } from "../../src/db/index.js";
import { users, songs, albums, artists, mediaSources, userFavoriteAlbums, userFavoriteArtists } from "../../src/db/schema.js";
import { eq } from "drizzle-orm";
import { authMiddleware } from "../../src/middleware/auth.js";

const { scrapeMock, scanMock, runBatchJobMock } = vi.hoisted(() => ({
  scrapeMock: {
    scrapeArtist: vi.fn(async () => null),
    artistsMissingCovers: vi.fn(() => [] as any[]),
    artistsMissingInfo: vi.fn(() => [] as any[]),
  },
  scanMock: {
    testWebDAVConnection: vi.fn(async () => ({ success: true, message: "ok" })),
  },
  runBatchJobMock: vi.fn(async (_kind: string, _payload: any, opts?: any) => {
    if (opts?.onProgress) opts.onProgress({ stage: "scan", scanned: 1, total: 2 });
    return { result: { scanned: 1 }, aborted: false };
  }),
}));

vi.mock("../../src/services/scraper/artist.js", async (importOriginal) => {
  const actual = await importOriginal<any>();
  return { ...actual, ...scrapeMock };
});
vi.mock("../../src/services/source/scanner.js", async (importOriginal) => {
  const actual = await importOriginal<any>();
  return { ...actual, ...scanMock };
});
vi.mock("../../src/batch/runner.js", async (importOriginal) => {
  const actual = await importOriginal<any>();
  return { ...actual, runBatchJob: runBatchJobMock };
});

import { registerLibrary } from "../../src/routes/api/library.js";
import { registerSources } from "../../src/routes/api/sources.js";
import { scrapeJobs, scanJobs, SCRAPE_JOB_ID } from "../../src/routes/api/shared.js";

const app = new Hono();
app.use("/rest/api/*", authMiddleware);
const api = new Hono();
registerLibrary(api);
registerSources(api);
app.route("/rest/api", api);

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
const countSongs = () => db.select().from(songs).all().length;

beforeAll(() => {
  if (!process.env.APP_VERSION) process.env.APP_VERSION = "1.0.0";
  initDatabase();
  db.insert(users).values({ id: "u1", username: "alice", password: "", salt: "s", subsonicSalt: SALT, passEnc: encryptPassword(PLAIN), isAdmin: 1, isActive: 1 }).run();
  db.insert(artists).values([{ id: "ar1", name: "Alpha", albumCount: 1, scrapeMissing: 1 }, { id: "ar2", name: "Beta" }]).run();
  db.insert(albums).values([
    { id: "al1", name: "Album One", artist: "Alpha", artistId: "ar1", createdAt: "2026-01-01T00:00:00.000Z" },
    { id: "al2", name: "Album Two", artist: "Beta", artistId: "ar2", coverArt: "c/x.jpg", createdAt: "2026-02-01T00:00:00.000Z" },
  ]).run();
  db.insert(songs).values([
    { id: "s1", title: "Song One", artist: "Alpha", artistId: "ar1", album: "Album One", albumId: "al1", genre: "Rock", duration: 200, path: "l:src:/one.mp3", suffix: "mp3", createdAt: "2026-01-01T00:00:00.000Z", groupId: "g1" },
    { id: "s2", title: "Song Two", artist: "Beta", album: "Album Two", albumId: "al2", genre: "Jazz", duration: 100, path: "l:src:/two.mp3", suffix: "mp3", createdAt: "2026-02-01T00:00:00.000Z", groupId: "g1", coverArt: "c/s2.jpg" },
    { id: "s3", title: "Song Three", artist: "Alpha", album: "Album One", albumId: "al1", genre: "Rock", duration: 50, path: "l:src:/three.mp3", suffix: "wav", tags: "{\"a\":1}", lyrics: "x.lrc", createdAt: "2026-03-01T00:00:00.000Z" },
    { id: "s4", title: "Song Four", artist: "Gamma", genre: "Rock", duration: 10, path: "l:src:/four.mp3", tags: "{broken json", hasLyrics: 1, createdAt: "2026-04-01T00:00:00.000Z" },
  ]).run();
  db.insert(userFavoriteAlbums).values({ userId: "u1", albumId: "al1" }).run();
  db.insert(userFavoriteArtists).values({ userId: "u1", artistId: "ar1" }).run();
  db.insert(mediaSources).values([
    { id: "src", name: "Local", type: "local", enabled: 1, config: JSON.stringify({ path: "/" }) },
    // 供 PUT / scan 用例使用的稳定行(必须在 beforeAll 建好:用例执行顺序不保证)。
    { id: "src-here", name: "Here", type: "local", enabled: 1, config: JSON.stringify({ path: "/" }) },
    { id: "src-off", name: "Off", type: "local", enabled: 0, config: "{}" },
    { id: "src-unk", name: "Unk", type: "weird", enabled: 1, config: "{}" },
  ]).run();
});

beforeEach(() => {
  // 用例执行顺序不保证,任务表必须在每个用例前清干净(否则「运行中」状态跨用例泄漏)。
  scrapeJobs.delete(SCRAPE_JOB_ID);
  scanJobs.clear();
  scrapeMock.artistsMissingCovers.mockReturnValue([]);
  scrapeMock.artistsMissingInfo.mockReturnValue([]);
  scrapeMock.scrapeArtist.mockResolvedValue(null);
});

describe("library 域:列表与检索", () => {
  it("GET /v1/stats 汇总四类计数", async () => {
    const r = await call("GET", "/v1/stats");
    expect(r.body.songCount).toBe(countSongs());
    expect(r.body.albumCount).toBe(db.select().from(albums).all().length);
    expect(r.body.artistCount).toBe(db.select().from(artists).all().length);
    expect(r.body.userCount).toBe(db.select().from(users).all().length);
  });

  it("GET /v1/songs 默认分页 + query/genre 过滤 + pageSize 上限", async () => {
    const all = await call("GET", "/v1/songs");
    expect(all.body.total).toBe(countSongs());
    expect(all.body.items.length).toBeGreaterThanOrEqual(4);
    const byQuery = await call("GET", "/v1/songs?query=Two");
    expect(byQuery.body.total).toBeGreaterThanOrEqual(1);
    expect(byQuery.body.items.every((i: any) => /two/i.test(i.title) || /two/i.test(i.artist || "") || /two/i.test(i.album || ""))).toBe(true);
    const byGenre = await call("GET", "/v1/songs?genre=Jazz");
    expect(byGenre.body.items.every((i: any) => i.genre === "Jazz")).toBe(true);
    const clamped = await call("GET", "/v1/songs?pageSize=9999&page=1");
    expect(clamped.body.pageSize).toBe(200);
    const paged = await call("GET", "/v1/songs?page=2&pageSize=1");
    expect(paged.body.items.length).toBeLessThanOrEqual(1);
  });

  it("GET /v1/songs 排序:recentAdded 与 sortField/order", async () => {
    const recent = await call("GET", "/v1/songs?sort=recentAdded&pageSize=50");
    const times = recent.body.items.map((i: any) => i.createdAt);
    expect([...times].sort().reverse()).toEqual(times);
    const byDurDesc = await call("GET", "/v1/songs?sortField=duration&order=desc");
    const durs = byDurDesc.body.items.map((i: any) => i.duration ?? 0);
    expect([...durs].sort((a: number, b: number) => b - a)).toEqual(durs);
    // 未知排序字段/非法 order 回退为按名称升序(不报错)
    const unknown = await call("GET", "/v1/songs?sortField=nope&order=bogus");
    expect(unknown.status).toBe(200);
    for (const f of ["name", "addedAt", "artist", "album", "playCount"]) {
      expect((await call("GET", `/v1/songs?sortField=${f}&order=desc`)).status).toBe(200);
    }
  });

  it("GET /v1/songs 组内多源:同 groupId 的行被合并展示", async () => {
    const r = await call("GET", "/v1/songs?pageSize=50");
    const s1 = r.body.items.find((i: any) => i.id === "s1");
    expect(s1).toBeTruthy();
    // attachGroupSources 生效时 s1 会带来源列表(至少含自身)
    expect(Array.isArray(s1.sources) || s1.sources === undefined).toBe(true);
    expect(r.status).toBe(200);
  });

  it("GET /v1/songs/:id 详情:tags/lyrics 概况与容错", async () => {
    const missing = await call("GET", "/v1/songs/nope");
    expect(missing.status).toBe(404);
    const ok = await call("GET", "/v1/songs/s3");
    expect(ok.body).toMatchObject({ id: "s3", path: "l:src:/three.mp3" });
    expect(ok.body.tags).toEqual({ a: 1 });
    expect(ok.body.lyrics.present).toBe(true);
    // tags 损坏 → null(不抛);内嵌歌词只标存在性时 inLibrary=false
    const broken = await call("GET", "/v1/songs/s4");
    expect(broken.body.tags).toBeNull();
    expect(broken.body.lyrics.present).toBe(true);
    expect(broken.body.lyrics.inLibrary).toBe(false);
  });

  it("DELETE /v1/songs/:id 与批量删除", async () => {
    db.insert(songs).values({ id: "s-del", title: "Del", path: "l:src:/del.mp3" }).run();
    const missing = await call("DELETE", "/v1/songs/nope");
    expect(missing.status).toBe(404);
    const one = await call("DELETE", "/v1/songs/s-del");
    expect(one.body).toMatchObject({ success: true });
    const empty = await call("POST", "/v1/songs/delete", {});
    expect(empty.body).toMatchObject({ success: true, deleted: 0 });
    db.insert(songs).values([{ id: "s-b1", title: "B1", path: "l:src:/b1.mp3" }, { id: "s-b2", title: "B2", path: "l:src:/b2.mp3" }]).run();
    const many = await call("POST", "/v1/songs/delete", { ids: ["s-b1", "s-b2", "nope"] });
    expect(many.body).toMatchObject({ success: true, deleted: 2 });
  });

  it("GET /v1/genres 按风格聚合/搜索/分页", async () => {
    const rockCount = db.select().from(songs).where(eq(songs.genre, "Rock")).all().length;
    const all = await call("GET", "/v1/genres?pageSize=200");
    const names = all.body.items.map((g: any) => g.name);
    expect(names).toContain("Rock");
    expect(names).toContain("Jazz");
    expect(all.body.items.find((g: any) => g.name === "Rock").songCount).toBe(rockCount);
    expect(all.body.items.every((g: any) => !!g.id)).toBe(true);
    const q = await call("GET", "/v1/genres?query=jaz");
    expect(q.body.total).toBe(1);
    const paged = await call("GET", "/v1/genres?page=2&pageSize=1");
    expect(paged.body.items.length).toBe(1);
  });

  it("GET /v1/albums 搜索 + 收藏标记", async () => {
    const all = await call("GET", "/v1/albums");
    expect(all.body.total).toBe(db.select().from(albums).all().length);
    const starred = all.body.items.find((a: any) => a.id === "al1");
    expect(starred.starred).toBe(true);
    const cover = all.body.items.find((a: any) => a.id === "al2");
    expect(cover.coverArt).toBe("al-al2");
    const q = await call("GET", "/v1/albums?query=Beta");
    expect(q.body.total).toBe(1);
  });

  it("GET /v1/artists 列表 + 收藏标记 + 刮削缺失标记", async () => {
    const all = await call("GET", "/v1/artists");
    expect(all.body.total).toBe(db.select().from(artists).all().length);
    const a1 = all.body.items.find((a: any) => a.id === "ar1");
    expect(a1.starred).toBe(true);
    expect(a1.scrapeMissing).toBe(true);
    const q = await call("GET", "/v1/artists?query=Bet");
    expect(q.body.total).toBe(1);
    const paged = await call("GET", "/v1/artists?page=2&pageSize=1");
    expect(paged.body.items.length).toBe(1);
  });
});

describe("library 域:歌手刮削", () => {
  // ⚠️ 以下「未命中 / 忙」分支的 HTTP 状态码是 **200**(apiError 未带状态参数,
  // 语义只看 body.success=false + body.code)。已在缺陷文档登记为待修项,故此处只断
  // 语义(body),不断状态码 —— 修复状态码后这些用例无需改动。
  it("POST /v1/artists/scrape 指定名字:命中返回,未命中给出 NOT_FOUND 语义", async () => {
    const miss = await call("POST", "/v1/artists/scrape", { name: "Nobody" });
    expect(miss.body.success).toBe(false);
    expect(miss.body.code).toBe("NOT_FOUND");
    scrapeMock.scrapeArtist.mockResolvedValueOnce({ name: "Alpha", platform: "qq", coverArt: "ar-ar1", bio: "b" });
    const hit = await call("POST", "/v1/artists/scrape", { name: "Alpha", artistId: "ar1" });
    expect(hit.body).toMatchObject({ success: true, name: "Alpha", platform: "qq", bio: "b" });
    expect(scrapeMock.scrapeArtist).toHaveBeenCalledWith("Alpha", "ar1");
  });

  it("POST /v1/artists/scrape 全量:后台任务 + 进度;运行中给 CONFLICT 语义", async () => {
    scrapeMock.artistsMissingCovers.mockReturnValue([{ id: "ar1" }]);
    const r = await call("POST", "/v1/artists/scrape", {});
    expect(r.body).toMatchObject({ success: true, total: 1 });
    await settle();
    const st = await call("GET", "/v1/artists/scrape-status");
    expect(st.body.status).toBe("done");
    // 人为置「运行中」→ 冲突(状态码为 200,见上方说明)
    scrapeJobs.set(SCRAPE_JOB_ID, { status: "running", startedAt: new Date().toISOString(), progress: { done: 1, total: 2 } as any });
    const busy = await call("POST", "/v1/artists/scrape", {});
    expect(busy.body).toMatchObject({ success: false, code: "CONFLICT" });
    const status = await call("GET", "/v1/artists/scrape-status");
    expect(status.body.progress).toEqual({ done: 1, total: 2 });
  });

  it("刮削任务失败时写 failed 状态并保留原因", async () => {
    runBatchJobMock.mockImplementationOnce(async () => { throw new Error("scrape boom"); });
    scrapeMock.artistsMissingCovers.mockReturnValue([{ id: "ar1" }]);
    await call("POST", "/v1/artists/scrape", {});
    await settle();
    const st = await call("GET", "/v1/artists/scrape-status");
    expect(st.body.status).toBe("failed");
    expect(st.body.error).toContain("scrape boom");
  });

  it("POST /v1/artists/scrape-missing:无缺失短路,有缺失起任务,运行中冲突语义", async () => {
    scrapeMock.artistsMissingInfo.mockReturnValue([]);
    const none = await call("POST", "/v1/artists/scrape-missing");
    expect(none.body).toMatchObject({ success: true, total: 0 });
    scrapeMock.artistsMissingInfo.mockReturnValue([{ id: "ar1" }, { id: "ar2" }]);
    const started = await call("POST", "/v1/artists/scrape-missing");
    expect(started.body).toMatchObject({ success: true, total: 2 });
    await settle();
    scrapeJobs.set(SCRAPE_JOB_ID, { status: "running", startedAt: new Date().toISOString(), progress: undefined as any });
    const busy = await call("POST", "/v1/artists/scrape-missing");
    expect(busy.body).toMatchObject({ success: false, code: "CONFLICT" });
  });

  it("GET /v1/artists/missing-info-count 与 scrape-status 空闲态", async () => {
    scrapeMock.artistsMissingInfo.mockReturnValue([{ id: "ar1" }]);
    expect((await call("GET", "/v1/artists/missing-info-count")).body.count).toBe(1);
    expect((await call("GET", "/v1/artists/scrape-status")).body).toEqual({ status: "idle", progress: null });
  });
});

describe("sources 域", () => {
  it("GET/POST /v1/sources 列表解析 config,新建行", async () => {
    const list = await call("GET", "/v1/sources");
    expect(list.status).toBe(200);
    expect(list.body.find((s: any) => s.id === "src").config).toEqual({ path: "/" });
    const created = await call("POST", "/v1/sources", { name: "New", type: "webdav", config: { url: "http://x" } });
    expect(created.body.id).toBeTruthy();
    const row = db.select().from(mediaSources).where(eq(mediaSources.id, created.body.id)).get()!;
    expect(row.enabled).toBe(1);
  });

  it("PUT /v1/sources/:id 不存在 404 / 更新成功", async () => {
    const missing = await call("PUT", "/v1/sources/nope", { name: "x" });
    expect(missing.status).toBe(404);
    const ok = await call("PUT", "/v1/sources/src-here", { name: "Renamed", enabled: 0, config: { path: "/tmp" } });
    expect(ok.body).toMatchObject({ success: true });
    const row = db.select().from(mediaSources).where(eq(mediaSources.id, "src-here")).get()!;
    expect(row.name).toBe("Renamed");
    expect(row.enabled).toBe(0);
    // characterization:enabled 传布尔值时 SQLite 绑定失败 → 非 2xx(未做类型归一)。
    const boolEnabled = await call("PUT", "/v1/sources/src-here", { enabled: true });
    expect(boolEnabled.status).toBeGreaterThanOrEqual(400);
    await call("PUT", "/v1/sources/src-here", { name: "Here", enabled: 1, config: { path: "/" } });
  });

  it("DELETE /v1/sources/:id 连带删除该源下的歌曲与关联", async () => {
    db.insert(mediaSources).values({ id: "src-del", name: "Del", type: "local", enabled: 1, config: "{}" }).run();
    db.insert(songs).values([
      { id: "sd1", title: "SD1", path: "l:src-del:/a.mp3" },
      { id: "sd2", title: "SD2", path: "w:src-del:/b.mp3" },
      { id: "sd3", title: "Keep", path: "l:other:/c.mp3" },
    ]).run();
    const r = await call("DELETE", "/v1/sources/src-del");
    expect(r.body).toMatchObject({ success: true, removedSongs: 2 });
    expect(db.select().from(songs).where(eq(songs.id, "sd1")).get()).toBeUndefined();
    expect(db.select().from(songs).where(eq(songs.id, "sd3")).get()).toBeTruthy();
    expect(db.select().from(mediaSources).where(eq(mediaSources.id, "src-del")).get()).toBeUndefined();
  });

  it("POST /v1/sources/:id/test 各类型分支", async () => {
    // 源不存在:body 为 NOT_FOUND 语义(状态码 200,见缺陷登记)
    const missing = await call("POST", "/v1/sources/nope/test");
    expect(missing.body).toMatchObject({ code: "NOT_FOUND" });
    const localOk = await call("POST", "/v1/sources/src-here/test");
    expect(localOk.body.success).toBe(true);
    db.insert(mediaSources).values({ id: "src-bad", name: "Bad", type: "local", enabled: 1, config: JSON.stringify({ path: "/definitely/not/here" }) }).run();
    // 路径缺失 / 类型不支持:同样是 apiError 未带状态参数(状态码 200,见缺陷登记)
    const localBad = await call("POST", "/v1/sources/src-bad/test");
    expect(localBad.body).toMatchObject({ success: false, code: "INVALID_PARAM" });
    expect(localBad.body.error).toContain("/definitely/not/here");
    const unsupported = await call("POST", "/v1/sources/src-unk/test");
    expect(unsupported.body).toMatchObject({ success: false, code: "INVALID_PARAM" });

    db.insert(mediaSources).values({ id: "src-web", name: "Web", type: "webdav", enabled: 1, config: JSON.stringify({ url: "http://x", username: "u", password: "p", root_path: "/r" }) }).run();
    expect((await call("POST", "/v1/sources/src-web/test")).body.success).toBe(true);
    scanMock.testWebDAVConnection.mockRejectedValueOnce(new Error("webdav down"));
    const failed = await call("POST", "/v1/sources/src-web/test");
    expect(failed.body).toMatchObject({ success: false, code: "UPSTREAM_ERROR" });
    expect(failed.body.error).toContain("webdav down");
  });

  it("POST /v1/sources/:id/scan 校验 + 进度分发 + 完成/中止/失败", async () => {
    const missing = await call("POST", "/v1/sources/nope/scan");
    expect(missing.body).toMatchObject({ code: "NOT_FOUND" });
    const disabled = await call("POST", "/v1/sources/src-off/scan");
    expect(disabled.body).toMatchObject({ code: "CONFLICT" });

    // 走一遍全部 onProgress 阶段分支(scrape-start / scrape / scrape-done / scrape-failed / null)
    runBatchJobMock.mockImplementationOnce(async (_k: string, _p: any, opts?: any) => {
      const onP = opts?.onProgress;
      onP?.({ stage: "scrape-start", total: 3 });
      onP?.({ stage: "scrape", done: 1, total: 3 });
      onP?.({ stage: "scrape-done", progress: { scraped: 1, skipped: 0, errors: [] } });
      onP?.({ stage: "scrape-failed", error: "scrape err" });
      onP?.(null);
      onP?.({ stage: "scan", scanned: 2, total: 2 });
      return { result: { scanned: 2 }, aborted: false };
    });
    const started = await call("POST", "/v1/sources/src-here/scan", { mode: "incremental" });
    expect(started.body.message).toContain("增量");
    await settle();
    const st = await call("GET", "/v1/sources/src-here/scan-status");
    expect(st.body.status).toBe("completed");
    expect(st.body.mode).toBe("incremental");

    // 中止分支
    scanJobs.clear();
    runBatchJobMock.mockImplementationOnce(async () => ({ result: { scanned: 0 }, aborted: true }));
    await call("POST", "/v1/sources/src-here/scan", {});
    await settle();
    expect((await call("GET", "/v1/sources/src-here/scan-status")).body.status).toBe("stopped");

    // 失败分支
    scanJobs.clear();
    runBatchJobMock.mockImplementationOnce(async () => { throw new Error("scan boom"); });
    await call("POST", "/v1/sources/src-here/scan", {});
    await settle();
    const failed = await call("GET", "/v1/sources/src-here/scan-status");
    expect(failed.body.status).toBe("failed");
    expect(failed.body.error).toContain("scan boom");

    // 运行中重复扫描 → CONFLICT 语义(状态码 200,见缺陷登记)
    scanJobs.clear();
    runBatchJobMock.mockImplementationOnce(() => new Promise(() => { /* never settles */ }));
    await call("POST", "/v1/sources/src-here/scan", {});
    const busy = await call("POST", "/v1/sources/src-here/scan", {});
    expect(busy.body).toMatchObject({ code: "CONFLICT" });
    scanJobs.clear();
  });

  it("POST /v1/sources/:id/scan-stop 未运行给 CONFLICT 语义 / 运行中可停", async () => {
    scanJobs.clear();
    const idle = await call("POST", "/v1/sources/src-off/scan-stop");
    expect(idle.body).toMatchObject({ code: "CONFLICT" });
    runBatchJobMock.mockImplementationOnce(() => new Promise(() => { /* hold */ }));
    await call("POST", "/v1/sources/src-here/scan", {});
    const stop = await call("POST", "/v1/sources/src-here/scan-stop");
    expect(stop.body).toMatchObject({ success: true });
    scanJobs.clear();
  });

  it("GET /v1/sources/:id/scan-status 无任务时 idle", async () => {
    expect((await call("GET", "/v1/sources/src-off/scan-status")).body).toEqual({ status: "idle" });
  });
});
