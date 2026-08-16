// MUST be the first import: redirects DATA_DIR to an isolated temp dir before
// the backend opens its SQLite DB at module-load time.
import "../plugins/_env.js";

import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import { Hono } from "hono";
import md5 from "md5";
import { db, initDatabase, encryptPassword } from "../../src/db/index.js";
import { users, playlists, plugins } from "../../src/db/schema.js";
import { eq } from "drizzle-orm";
import { authMiddleware } from "../../src/middleware/auth.js";
import { apiRoutes } from "../../src/routes/api/index.js";
import { registerPlugin, unregisterPlugin } from "../../src/plugins/registry.js";

const app = new Hono();
app.use("/rest/api/*", authMiddleware);
app.route("/rest/api", apiRoutes);

const PLAIN = "hunter2";
const CLIENT_SALT = "clientsalt123";
const authQS = () => `u=alice&t=${md5(PLAIN + CLIENT_SALT)}&s=${CLIENT_SALT}`;

const FAKE = "fake-dl";
let searchCalls = 0;
let playlistCalls = 0;

function registerFakePlugin() {
  registerPlugin(
    {
      id: FAKE,
      name: "fake-dl 聚合",
      version: "1.0.0",
      type: "source",
      capabilities: ["playlistSearch", "playlistSongs"],
      platforms: ["netease", "qq"],
      platformLabels: { netease: "网易云", qq: "QQ 音乐" },
      configSchema: [],
    } as any,
    {
      async searchPlaylists(config: any, params: any) {
        searchCalls++;
        if (!params?.query) return { playlists: [] };
        return {
          playlists: [
            { id: "p1", source: "netease", name: "热歌榜", creator: "官方", trackCount: 100, cover: "http://x/1.jpg" },
            { id: "p2", source: "qq", name: "华语精选", trackCount: 50 },
          ],
        };
      },
      async playlistSongs(config: any, source: string, id: string) {
        playlistCalls++;
        return {
          songs: [
            { id: `s-${source}-${id}-1`, source, name: "Song 1", artist: "A1", album: "", duration: 200, cover: "" },
            { id: `s-${source}-${id}-2`, source, name: "Song 2", artist: "A2", album: "", duration: 210, cover: "" },
          ],
        };
      },
      streamUrl(config: any, song: any) {
        return "http://fake/stream";
      },
    } as any,
  );
  db.delete(plugins).where(eq(plugins.name, FAKE)).run();
  db.insert(plugins).values({ id: FAKE, name: FAKE, enabled: 1, config: JSON.stringify({ baseUrl: "http://fake" }) }).run();
}

beforeAll(() => {
  if (!process.env.APP_VERSION) process.env.APP_VERSION = "1.0.0";
  initDatabase();
  if (!db.select().from(users).where(eq(users.username, "alice")).get()) {
    db.insert(users).values({ id: "u1", username: "alice", password: "", salt: "salt", subsonicSalt: "subsalt", passEnc: encryptPassword(PLAIN), isAdmin: 1, isActive: 1, email: "a@b.c" }).run();
  }
});

beforeEach(() => {
  for (const id of [FAKE, "go-music-dl"]) {
    db.delete(plugins).where(eq(plugins.name, id)).run();
    unregisterPlugin(id);
  }
  searchCalls = 0;
  playlistCalls = 0;
  registerFakePlugin();
});

afterAll(() => {
  unregisterPlugin(FAKE);
});

describe("GET /v1/playlist-search/providers", () => {
  it("列出已启用且声明 playlistSearch 的插件(含平台与标签)", async () => {
    const res = await app.request(`/rest/api/v1/playlist-search/providers?${authQS()}`);
    const body = (await res.json()) as any;
    expect(res.status).toBe(200);
    const p = body.providers.find((x: any) => x.id === FAKE);
    expect(p.name).toBe("fake-dl 聚合");
    expect(p.platforms).toEqual(["netease", "qq"]);
    expect(p.platformLabels).toMatchObject({ netease: "网易云" });
  });
});

describe("POST /v1/playlist-search/:id/search", () => {
  it("调插件 searchPlaylists,返回带平台标签的歌单", async () => {
    const res = await app.request(`/rest/api/v1/playlist-search/${FAKE}/search?${authQS()}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ q: "周杰伦" }),
    });
    const body = (await res.json()) as any;
    expect(body.success).toBe(true);
    expect(searchCalls).toBe(1);
    expect(body.total).toBe(2);
    expect(body.playlists[0].platformLabel).toBe("网易云");
    expect(body.playlists[1].platformLabel).toBe("QQ 音乐");
    expect(body.playlists[0].name).toBe("热歌榜");
  });

  it("空关键词报错", async () => {
    const res = await app.request(`/rest/api/v1/playlist-search/${FAKE}/search?${authQS()}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ q: "   " }),
    });
    const body = (await res.json()) as any;
    expect(body.success).toBe(false);
    expect(searchCalls).toBe(0);
  });

  it("未启用/未注册插件 → 404", async () => {
    const res = await app.request(`/rest/api/v1/playlist-search/no-such-plugin/search?${authQS()}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ q: "x" }),
    });
    expect(res.status).toBe(404);
  });
});

describe("POST /v1/playlist-search/:id/import", () => {
  // 导入端点已异步化:POST 返回 taskId,轮询 GET /v1/tasks/:id 直到完成,返回 result。
  async function importAndWait(body: any): Promise<any> {
    const res = await app.request(`/rest/api/v1/playlist-search/${FAKE}/import?${authQS()}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const r = (await res.json()) as any;
    expect(r.success).toBe(true);
    const taskId = r.taskId as string;
    expect(taskId).toBeTruthy();
    for (let i = 0; i < 100; i++) {
      const t = await app.request(`/rest/api/v1/tasks/${taskId}?${authQS()}`);
      const tb = (await t.json()) as any;
      if (tb.task?.status === "ok") return tb.task.result;
      if (tb.task?.status === "error") throw new Error(`task error: ${tb.task.error}`);
      await new Promise((r2) => setTimeout(r2, 20));
    }
    throw new Error("task timeout");
  }

  it("拉歌入库并创建平台歌单(合成 sourceUrl)", async () => {
    const body = await importAndWait({ source: "netease", id: "p1", name: "热歌榜" });
    expect(body.success).toBe(true);
    expect(playlistCalls).toBe(1);
    expect(body.trackCount).toBe(2);
    expect(body.created).toBe(true);
    const pl = db.select().from(playlists).where(eq(playlists.sourceUrl, `${FAKE}://netease/p1`)).get();
    expect(pl).toBeTruthy();
    expect(pl!.sourcePlatform).toBe("netease");
    expect(pl!.name).toBe("热歌榜");
  });

  it("同歌单再次导入 = 更新不新建(合成 sourceUrl 幂等)", async () => {
    const first = await importAndWait({ source: "qq", id: "p2", name: "华语精选" });
    expect(first.created).toBe(true);
    const before = db.select().from(playlists).where(eq(playlists.sourceUrl, `${FAKE}://qq/p2`)).all();
    expect(before.length).toBe(1);

    const body = await importAndWait({ source: "qq", id: "p2", name: "华语精选" });
    expect(body.success).toBe(true);
    expect(body.created).toBe(false);
    const after = db.select().from(playlists).where(eq(playlists.sourceUrl, `${FAKE}://qq/p2`)).all();
    expect(after.length).toBe(1); // 不重复建
    expect(playlistCalls).toBe(2);
  });

  it("缺 source/id 报错", async () => {
    const res = await app.request(`/rest/api/v1/playlist-search/${FAKE}/import?${authQS()}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ source: "netease" }),
    });
    const body = (await res.json()) as any;
    expect(body.success).toBe(false);
  });
});

describe("GET /v1/playlist-search/:id/items (远程歌单详情,只拉不导入)", () => {
  it("调插件 playlistSongs 返回歌曲列表,不写库", async () => {
    const res = await app.request(`/rest/api/v1/playlist-search/${FAKE}/items?${authQS()}&source=netease&id=p1`);
    const body = (await res.json()) as any;
    expect(body.success).toBe(true);
    expect(playlistCalls).toBe(1);
    expect(body.total).toBe(2);
    expect(body.items[0].name).toBe("Song 1");
    expect(body.items[0].platformLabel).toBe("网易云");
  });

  it("缺 source/id 报错", async () => {
    const res = await app.request(`/rest/api/v1/playlist-search/${FAKE}/items?${authQS()}&source=netease`);
    const body = (await res.json()) as any;
    expect(body.success).toBe(false);
  });

  it("插件无 playlistSongs → 404", async () => {
    unregisterPlugin(FAKE);
    registerPlugin(
      {
        id: FAKE,
        name: "fake-dl 聚合",
        version: "1.0.0",
        type: "source",
        capabilities: ["playlistSearch"], // 只声明 search,无 playlistSongs
        platforms: ["netease"],
        platformLabels: {},
        configSchema: [],
      } as any,
      { async searchPlaylists() { return { playlists: [] }; } } as any,
    );
    db.delete(plugins).where(eq(plugins.name, FAKE)).run();
    db.insert(plugins).values({ id: FAKE, name: FAKE, enabled: 1, config: "{}" }).run();
    const res = await app.request(`/rest/api/v1/playlist-search/${FAKE}/items?${authQS()}&source=netease&id=p1`);
    expect(res.status).toBe(404);
  });
});
