// 首页预热聚合接口(GET /v1/home/preload)的接线与契约测试(优化 #3)。
//
// 背景:前端首页启动时原本并发发起 4 个「预热」请求(songs/albums/artists/playlists 第一页,
// 响应体被前端丢弃,只为在服务端触发一遍列表查询)。HTTP/1.1 每域名 6 连接下它们会与首页
// 其余请求争用连接(实测第二批 XHR 排队 q=177~689ms)。现合并为一个聚合接口。
//
// 契约:
//   1) 鉴权/权限门禁与各列表接口一致(未登录不得进入,不出现「无鉴权可访问的隐通道」);
//   2) 服务端逐个触发歌曲/专辑/艺术家/歌单第一页查询,且**复用** buildXxxPage 同一份实现;
//   3) 响应体保持最小 ack({ success: true })——前端本就丢弃这 4 份数据;
//   4) 单个列表失败不影响其它列表与 ack(best-effort 预热)。
import "../plugins/_env.js";

import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import { Hono } from "hono";
import md5 from "md5";
import { db, initDatabase, encryptPassword } from "../../src/db/index.js";
import { users } from "../../src/db/schema.js";
import { eq } from "drizzle-orm";
import { authMiddleware } from "../../src/middleware/auth.js";

const spies = vi.hoisted(() => ({
  buildSongsPage: vi.fn(() => ({ songs: [] as unknown[] })),
  buildAlbumsPage: vi.fn(() => ({ albums: [] as unknown[] })),
  buildArtistsPage: vi.fn(() => ({ artists: [] as unknown[] })),
  buildPlaylistsPage: vi.fn(() => ({ playlists: [] as unknown[] })),
}));

// 以真实模块为底,只替换四个列表构造器 —— 借此精确断言「聚合接口触发了哪些查询、传了什么参」。
vi.mock("../../src/routes/api/library.js", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    buildSongsPage: spies.buildSongsPage,
    buildAlbumsPage: spies.buildAlbumsPage,
    buildArtistsPage: spies.buildArtistsPage,
  };
});
vi.mock("../../src/routes/api/playlists.js", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, buildPlaylistsPage: spies.buildPlaylistsPage };
});

import { apiRoutes } from "../../src/routes/api/index.js";

const app = new Hono();
app.use("/rest/api/*", authMiddleware);
app.route("/rest/api", apiRoutes);

const PLAIN = "hunter2";
const CLIENT_SALT = "clientsalt123";
const authQS = () => "u=alice&t=" + md5(PLAIN + CLIENT_SALT) + "&s=" + CLIENT_SALT;

const call = (qs = authQS()) =>
  app.request("/rest/api/v1/home/preload?" + qs).then(async (res) => ({
    status: res.status,
    body: await res.json().catch(() => null as any),
  }));

beforeAll(() => {
  if (!process.env.APP_VERSION) process.env.APP_VERSION = "1.0.0";
  initDatabase();
  if (!db.select().from(users).where(eq(users.username, "alice")).get()) {
    db.insert(users)
      .values({
        id: "u1",
        username: "alice",
        password: "",
        salt: "salt",
        subsonicSalt: "subsalt",
        passEnc: encryptPassword(PLAIN),
        isAdmin: 1,
        isActive: 1,
        email: "a@b.c",
      })
      .run();
  }
});

beforeEach(() => {
  spies.buildSongsPage.mockReset().mockImplementation(() => ({ songs: [] }));
  spies.buildAlbumsPage.mockReset().mockImplementation(() => ({ albums: [] }));
  spies.buildArtistsPage.mockReset().mockImplementation(() => ({ artists: [] }));
  spies.buildPlaylistsPage.mockReset().mockImplementation(() => ({ playlists: [] }));
});

describe("GET /v1/home/preload 聚合预热接口", () => {
  it("鉴权后一次性触发四个列表第一页,且只回最小 ack", async () => {
    const r = await call();
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ success: true });

    expect(spies.buildSongsPage).toHaveBeenCalledTimes(1);
    expect(spies.buildSongsPage).toHaveBeenCalledWith({ page: "1", pageSize: "25" });
    expect(spies.buildAlbumsPage).toHaveBeenCalledTimes(1);
    expect(spies.buildAlbumsPage).toHaveBeenCalledWith({ page: "1", pageSize: "20" }, "u1");
    expect(spies.buildArtistsPage).toHaveBeenCalledTimes(1);
    expect(spies.buildArtistsPage).toHaveBeenCalledWith({ page: "1", pageSize: "20" }, "u1");
    expect(spies.buildPlaylistsPage).toHaveBeenCalledTimes(1);
    expect(spies.buildPlaylistsPage.mock.calls[0][0]).toEqual({ page: "1", pageSize: "20" });
    // 歌单构造器第二参为当前用户对象(与 /v1/playlists 一致,供私有歌单过滤用)。
    expect(spies.buildPlaylistsPage.mock.calls[0][1]).toBeTruthy();
  });

  it("未鉴权不得进入(不出现无鉴权可访问的隐通道)", async () => {
    const res = await app.request("/rest/api/v1/home/preload");
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
    expect(spies.buildSongsPage).not.toHaveBeenCalled();
  });

  it("best-effort:单个列表失败仍返回 ack、不影响其它列表", async () => {
    spies.buildArtistsPage.mockImplementationOnce(() => {
      throw new Error("boom");
    });
    const r = await call();
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ success: true });
    expect(spies.buildSongsPage).toHaveBeenCalledTimes(1);
    expect(spies.buildAlbumsPage).toHaveBeenCalledTimes(1);
    expect(spies.buildPlaylistsPage).toHaveBeenCalledTimes(1);
  });
});
