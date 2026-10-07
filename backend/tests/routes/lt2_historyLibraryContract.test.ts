// MUST be the first import:隔离 DATA_DIR 后再加载后端模块。
import "../plugins/_env.js";

// 曲库/历史两个域的残余未覆盖行补测:
//   routes/api/history.ts 29 / 34 / 37-43 / 46-48 —— 有历史数据时的批量补歌/补专辑与行映射
//   routes/api/library.ts 116                     —— recentAdded + 过滤条件并存的分支
//   routes/api/library.ts 142-143                 —— 组内多源查询失败降级(不能拖垮列表主体)
//   routes/api/library.ts 333-334 / 369-370       —— 两个刮削口的兜底 catch
//   routes/api/library.ts 364-365                 —— 后台刮削任务失败写 failed 状态
//
// 为什么要 mock 两个**叶子模块**:组内多源合并与刮削都是"外部/批处理"入口,失败路径
// 靠真实触发要么做不到(要真网络),要么要走子进程批任务(测试里没有)。这两处
// catch 恰恰是"失败时列表还能用/状态能查到"的契约落点,值得锁住。
import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import { Hono } from "hono";
import md5 from "md5";

const leaf = vi.hoisted(() => ({
  attachGroupSources: vi.fn(),
  artistsMissingCovers: vi.fn(() => [] as any[]),
  artistsMissingInfo: vi.fn(() => [] as any[]),
  runBatchJob: vi.fn(async () => ({ result: {} })),
}));

vi.mock("../../src/utils/songSource.js", async (io) => ({
  ...(await io<Record<string, unknown>>()),
  attachGroupSources: leaf.attachGroupSources,
}));

vi.mock("../../src/services/scraper/artist.js", async (io) => ({
  ...(await io<Record<string, unknown>>()),
  artistsMissingCovers: leaf.artistsMissingCovers,
  artistsMissingInfo: leaf.artistsMissingInfo,
}));

vi.mock("../../src/batch/runner.js", async (io) => ({
  ...(await io<Record<string, unknown>>()),
  runBatchJob: leaf.runBatchJob,
}));

import { db, initDatabase, encryptPassword } from "../../src/db/index.js";
import { users, songs, albums, playHistory } from "../../src/db/schema.js";
import { eq } from "drizzle-orm";
import { authMiddleware } from "../../src/middleware/auth.js";
import { apiRoutes } from "../../src/routes/api/index.js";
import { scrapeJobs } from "../../src/routes/api/shared.js";

const app = new Hono();
app.use("/rest/api/*", authMiddleware);
app.route("/rest/api", apiRoutes);

const PLAIN = "hunter2";
const SALT = "clientsalt123";
const authQS = () => `u=alice&t=${md5(PLAIN + SALT)}&s=${SALT}`;

async function call(method: string, path: string, body?: unknown) {
  const url = `/rest/api${path}${path.includes("?") ? "&" : "?"}${authQS()}`;
  const res = await app.request(url, {
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let parsed: any = null;
  try { parsed = JSON.parse(text); } catch { parsed = null; }
  return { status: res.status, body: parsed };
}

beforeAll(() => {
  if (!process.env.APP_VERSION) process.env.APP_VERSION = "1.0.0";
  initDatabase();
  if (!db.select().from(users).where(eq(users.username, "alice")).get()) {
    db.insert(users).values({
      id: "u1", username: "alice", password: "", salt: "salt", subsonicSalt: "subsalt",
      passEnc: encryptPassword(PLAIN), isAdmin: 1, isActive: 1, email: "a@b.c",
    }).run();
  }
});

beforeEach(() => {
  leaf.attachGroupSources.mockReset();
  leaf.attachGroupSources.mockImplementation(() => undefined);
  leaf.artistsMissingCovers.mockReset();
  leaf.artistsMissingCovers.mockImplementation(() => [] as any[]);
  leaf.artistsMissingInfo.mockReset();
  leaf.artistsMissingInfo.mockImplementation(() => [] as any[]);
  leaf.runBatchJob.mockReset();
  leaf.runBatchJob.mockImplementation(async () => ({ result: {} }));
  // scrapeJobs 是模块级 Map:跨用例残留会让"running"判定误命中,必须清。
  scrapeJobs.clear();
});

// play_history.song_id → songs.id 有外键,删歌前必须先清历史(否则 FK 拒绝)。
// 抽成助手:用例顺序被 shuffle,任何"先插历史再删歌"的组合都会撞上这个顺序依赖。
function clearLibraryTables() {
  db.delete(playHistory).run();
  db.delete(songs).run();
  db.delete(albums).run();
}

// ==================== history ====================

describe("GET /v1/history:批量补歌/补专辑", () => {
  it("条目录入后按 playedAt DESC 出队,封面走歌曲→专辑回退链", async () => {
    clearLibraryTables();
    db.insert(albums).values({ id: "al-h", name: "专辑H", artist: "Art", coverArt: "covers/h.jpg" }).run();
    // s1 自带封面 → so- 前缀;s2 无封面但挂在有专辑上 → al- 前缀
    db.insert(songs).values({ id: "s-h1", title: "第一首", artist: "A1", album: "专辑H", albumId: "al-h", coverArt: "covers/1.jpg", duration: 100, path: "l:src:/1.mp3" }).run();
    db.insert(songs).values({ id: "s-h2", title: "第二首", artist: "A2", album: "专辑H", albumId: "al-h", duration: 120, path: "l:src:/2.mp3" }).run();
    // 注:song_id 有外键,构造不出"挂着已删歌的历史行"(库层直接拒绝),
    // 故 null 行过滤是防御性分支,这里只验可解析行的映射与排序。
    db.insert(playHistory).values({ userId: "u1", songId: "s-h1", playedAt: "2026-01-02T00:00:00.000Z" }).run();
    db.insert(playHistory).values({ userId: "u1", songId: "s-h2", playedAt: "2026-01-01T00:00:00.000Z" }).run();

    const r = await call("GET", "/v1/history");
    expect(r.status).toBe(200);
    expect(r.body.total).toBe(2);
    expect(r.body.items.map((x: any) => x.id)).toEqual(["s-h1", "s-h2"]);
    expect(r.body.items[0].coverArt).toBe("so-s-h1");
    expect(r.body.items[1].coverArt).toBe("al-al-h");
    expect(r.body.items[0].playedAt).toBe("2026-01-02T00:00:00.000Z");
  });

  it("分页参数越界被夹:page<1 → 1,pageSize>200 → 200", async () => {
    const r = await call("GET", "/v1/history?page=0&pageSize=9999");
    expect(r.body.page).toBe(1);
    expect(r.body.pageSize).toBe(200);
  });
});

// ==================== library ====================

describe("GET /v1/songs", () => {
  it("sort=recentAdded 叠加 query 过滤(两个条件同时生效)", async () => {
    clearLibraryTables();
    db.insert(songs).values({ id: "s-r1", title: "唯一的命中", artist: "Z", path: "l:src:/r1.mp3" }).run();
    db.insert(songs).values({ id: "s-r2", title: "不该出现", artist: "Z", path: "l:src:/r2.mp3" }).run();
    // 该分支此前只在"无过滤条件"或"非 recentAdded"下被走过
    const r = await call("GET", "/v1/songs?sort=recentAdded&query=" + encodeURIComponent("命中"));
    expect(r.status).toBe(200);
    expect(r.body.items.map((x: any) => x.id)).toEqual(["s-r1"]);
  });

  it("组内多源查询失败时列表主体仍正常返回(降级为单行)", async () => {
    clearLibraryTables();
    db.insert(songs).values({ id: "s-g1", title: "组内主行", artist: "A", groupId: "grp-1", path: "l:src:/g1.mp3" }).run();
    // 模拟"组员查询"炸了(比如 DB 瞬断):不能把整页列表一起带崩
    leaf.attachGroupSources.mockImplementation(() => { throw new Error("组查询失败"); });
    const r = await call("GET", "/v1/songs");
    expect(r.status).toBe(200);
    expect(r.body.items.some((x: any) => x.id === "s-g1")).toBe(true);
  });

  it("pageSize 上限为 2000:>2000 被夹到 2000,2000 整页可用,默认值仍为 50", async () => {
    clearLibraryTables();
    const N = 2001;
    // 分批插入:better-sqlite3 默认变量上限 999,2001 行一次插入会触发 too many SQL variables
    const rows = Array.from({ length: N }, (_, i) => ({ id: `s-p${i}`, title: `分页${String(i).padStart(5, "0")}`, artist: "P", path: `l:src:/p${i}.mp3` }));
    for (let i = 0; i < rows.length; i += 100) db.insert(songs).values(rows.slice(i, i + 100)).run();
    // 越界(99999)被夹到 2000,单页恰好返回 2000 条
    const clamped = await call("GET", "/v1/songs?page=1&pageSize=99999");
    expect(clamped.status).toBe(200);
    expect(clamped.body.pageSize).toBe(2000);
    expect(clamped.body.total).toBe(N);
    expect(clamped.body.items.length).toBe(2000);
    // 显式 2000 恰好整页
    const full = await call("GET", "/v1/songs?page=1&pageSize=2000");
    expect(full.status).toBe(200);
    expect(full.body.pageSize).toBe(2000);
    expect(full.body.items.length).toBe(2000);
    // 不传 pageSize 保持原默认 50(客户端不传参行为不变)
    const def = await call("GET", "/v1/songs");
    expect(def.status).toBe(200);
    expect(def.body.pageSize).toBe(50);
    expect(def.body.items.length).toBe(50);
  });
});

describe("艺术家刮削口", () => {
  it("POST /v1/artists/scrape:取缺失歌手时异常 → 502 + UPSTREAM_ERROR", async () => {
    leaf.artistsMissingCovers.mockImplementation(() => { throw new Error("scraper down"); });
    const r = await call("POST", "/v1/artists/scrape", {});
    expect(r.status).toBe(502);
    expect(r.body).toMatchObject({ success: false, code: "UPSTREAM_ERROR" });
  });

  it("POST /v1/artists/scrape-missing:无缺失 → total 0 且不启动任务", async () => {
    leaf.artistsMissingInfo.mockReturnValue([]);
    const r = await call("POST", "/v1/artists/scrape-missing", {});
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ success: true, total: 0 });
    expect(leaf.runBatchJob).not.toHaveBeenCalled();
  });

  it("POST /v1/artists/scrape-missing:后台批任务失败 → 状态落 failed(可被轮询看到)", async () => {
    leaf.artistsMissingInfo.mockReturnValue([{ id: "ar-1", name: "缺信息" }]);
    leaf.runBatchJob.mockRejectedValue(new Error("batch boom"));
    const r = await call("POST", "/v1/artists/scrape-missing", {});
    expect(r.status).toBe(200);
    expect(r.body.success).toBe(true);

    // 后台任务是 fire-and-forget,轮询到 failed 为止(不依赖固定 sleep 时长)
    let status = "";
    for (let i = 0; i < 100; i++) {
      const s = await call("GET", "/v1/artists/scrape-status");
      status = s.body.status;
      if (status === "failed") break;
      await new Promise((res) => setTimeout(res, 10));
    }
    expect(status).toBe("failed");
    const st = await call("GET", "/v1/artists/scrape-status");
    // 失败原因必须能查到(排障线索),这里只断言"有且是非空字符串"。
    // 注意:当前实现把**原始 e.message 原样**放进状态体(见本次审计报告 online.ts/library.ts
    // 的同类写法),属"内部异常原文外泄"嫌疑;断言刻意不绑定原文,
    // 以便后续按 D11 收敛成通用文案时这条测试仍然成立。
    expect(typeof st.body.error).toBe("string");
    expect(st.body.error.length).toBeGreaterThan(0);
  });

  it("POST /v1/artists/scrape-missing:取缺失列表时异常 → 502", async () => {
    leaf.artistsMissingInfo.mockImplementation(() => { throw new Error("db down"); });
    const r = await call("POST", "/v1/artists/scrape-missing", {});
    expect(r.status).toBe(502);
    expect(r.body).toMatchObject({ success: false, code: "UPSTREAM_ERROR" });
  });
});
