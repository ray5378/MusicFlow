// MUST be the first import: redirects DATA_DIR to an isolated temp dir before
// the backend opens its SQLite DB at module-load time.
import "../plugins/_env.js";

import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import { Hono } from "hono";
import md5 from "md5";
import { db, initDatabase, encryptPassword } from "../../src/db/index.js";
import { users, playlists, plugins, songs } from "../../src/db/schema.js";
import { eq, inArray } from "drizzle-orm";
import { authMiddleware } from "../../src/middleware/auth.js";
import { apiRoutes } from "../../src/routes/api/index.js";
import { registerPlugin, unregisterPlugin } from "../../src/plugins/registry.js";
import { installInProcessBatchRunner } from "../batch/fakeRunner.js";

const app = new Hono();
app.use("/rest/api/*", authMiddleware);
app.route("/rest/api", apiRoutes);

const PLAIN = "hunter2";
const CLIENT_SALT = "clientsalt123";
const authQS = () => `u=alice&t=${md5(PLAIN + CLIENT_SALT)}&s=${CLIENT_SALT}`;

const FAKE = "fake-dl";
let songSearchCalls = 0;
let artistSearchCalls = 0;
let albumSearchCalls = 0;
let playlistCalls = 0;

/** 注册一个声明 songSearch/artistSearch/albumSearch/playlistSongs 的假插件。 */
function registerFakePlugin() {
  registerPlugin(
    {
      id: FAKE,
      name: "fake-dl 聚合",
      version: "1.0.0",
      type: "source",
      capabilities: ["songSearch", "artistSearch", "albumSearch", "playlistSongs"],
      platforms: ["netease", "qq"],
      platformLabels: { netease: "网易云", qq: "QQ 音乐" },
      configSchema: [],
    } as any,
    {
      async searchSongs(config: any, params: any) {
        songSearchCalls++;
        if (!params?.query) return { songs: [] };
        return {
          songs: [
            { id: "s1", source: "netease", name: "晴天", artist: "周杰伦", album: "叶惠美", duration: 269, cover: "http://x/1.jpg" },
            { id: "s2", source: "qq", name: "七里香", artist: "周杰伦", album: "七里香", duration: 298 },
          ],
        };
      },
      async searchArtists(config: any, params: any) {
        artistSearchCalls++;
        if (!params?.query) return { artists: [] };
        return {
          artists: [
            { id: "a1", source: "netease", name: "周杰伦", avatar: "http://x/a.jpg", albumCount: 14, songCount: 120 },
            { id: "a2", source: "qq", name: "林俊杰", songCount: 100 },
          ],
        };
      },
      async searchAlbums(config: any, params: any) {
        albumSearchCalls++;
        if (!params?.query) return { albums: [] };
        return {
          albums: [
            { id: "al1", source: "netease", name: "叶惠美", artist: "周杰伦", cover: "http://x/al.jpg", trackCount: 10, year: 2003 },
            { id: "al2", source: "qq", name: "七里香", artist: "周杰伦", trackCount: 12 },
          ],
        };
      },
      async playlistSongs(config: any, source: string, id: string) {
        playlistCalls++;
        return {
          songs: [
            { id: `t-${source}-${id}-1`, source, name: "Track 1", artist: "A", album: "", duration: 200, cover: "" },
            { id: `t-${source}-${id}-2`, source, name: "Track 2", artist: "A", album: "", duration: 210, cover: "" },
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

/** 注册一个只声明 artistSearch 的插件(验证 providers 按能力过滤)。 */
const FAKE_ARTIST_ONLY = "artist-only";
function registerArtistOnlyPlugin() {
  registerPlugin(
    {
      id: FAKE_ARTIST_ONLY,
      name: "纯艺术家",
      version: "1.0.0",
      type: "source",
      capabilities: ["artistSearch"],
      platforms: ["apple"],
      platformLabels: { apple: "Apple Music" },
      configSchema: [],
    } as any,
    {
      async searchArtists() {
        return { artists: [] };
      },
    } as any,
  );
  db.delete(plugins).where(eq(plugins.name, FAKE_ARTIST_ONLY)).run();
  db.insert(plugins).values({ id: FAKE_ARTIST_ONLY, name: FAKE_ARTIST_ONLY, enabled: 1, config: "{}" }).run();
}

beforeAll(() => {
  if (!process.env.APP_VERSION) process.env.APP_VERSION = "1.0.0";
  initDatabase();
  if (!db.select().from(users).where(eq(users.username, "alice")).get()) {
    db.insert(users).values({ id: "u1", username: "alice", password: "", salt: "salt", subsonicSalt: "subsalt", passEnc: encryptPassword(PLAIN), isAdmin: 1, isActive: 1, email: "a@b.c" }).run();
  }
});

beforeEach(() => {
  installInProcessBatchRunner();
  for (const id of [FAKE, FAKE_ARTIST_ONLY]) {
    db.delete(plugins).where(eq(plugins.name, id)).run();
    unregisterPlugin(id);
  }
  songSearchCalls = 0;
  artistSearchCalls = 0;
  albumSearchCalls = 0;
  playlistCalls = 0;
  registerFakePlugin();
  registerArtistOnlyPlugin();
});

afterAll(() => {
  unregisterPlugin(FAKE);
  unregisterPlugin(FAKE_ARTIST_ONLY);
});

describe("GET /v1/{song,artist,album}-search/providers", () => {
  it("列出声明对应能力的插件,未声明的不出现(按能力过滤)", async () => {
    const songRes = await app.request(`/rest/api/v1/song-search/providers?${authQS()}`);
    const songBody = (await songRes.json()) as any;
    expect(songBody.providers.find((p: any) => p.id === FAKE)).toBeTruthy();
    expect(songBody.providers.find((p: any) => p.id === FAKE_ARTIST_ONLY)).toBeFalsy(); // 未声明 songSearch

    const artistRes = await app.request(`/rest/api/v1/artist-search/providers?${authQS()}`);
    const artistBody = (await artistRes.json()) as any;
    expect(artistBody.providers.find((p: any) => p.id === FAKE)).toBeTruthy();
    expect(artistBody.providers.find((p: any) => p.id === FAKE_ARTIST_ONLY)).toBeTruthy();

    const albumRes = await app.request(`/rest/api/v1/album-search/providers?${authQS()}`);
    const albumBody = (await albumRes.json()) as any;
    expect(albumBody.providers.find((p: any) => p.id === FAKE)).toBeTruthy();
    expect(albumBody.providers.find((p: any) => p.id === FAKE_ARTIST_ONLY)).toBeFalsy();
  });

  it("providers 带平台与标签", async () => {
    const res = await app.request(`/rest/api/v1/song-search/providers?${authQS()}`);
    const p = ((await res.json()) as any).providers.find((x: any) => x.id === FAKE);
    expect(p.platforms).toEqual(["netease", "qq"]);
    expect(p.platformLabels).toMatchObject({ netease: "网易云" });
  });
});

describe("POST /v1/song-search/:id/search", () => {
  it("调插件 searchSongs,返回带平台标签的歌曲", async () => {
    const res = await app.request(`/rest/api/v1/song-search/${FAKE}/search?${authQS()}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ q: "周杰伦" }),
    });
    const body = (await res.json()) as any;
    expect(body.success).toBe(true);
    expect(songSearchCalls).toBe(1);
    expect(body.total).toBe(2);
    expect(body.items[0].name).toBe("晴天");
    expect(body.items[0].platformLabel).toBe("网易云");
    expect(body.items[1].platformLabel).toBe("QQ 音乐");
  });

  it("空关键词报错", async () => {
    const res = await app.request(`/rest/api/v1/song-search/${FAKE}/search?${authQS()}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ q: "   " }),
    });
    const body = (await res.json()) as any;
    expect(body.success).toBe(false);
    expect(songSearchCalls).toBe(0);
  });

  it("未注册插件 → 404", async () => {
    const res = await app.request(`/rest/api/v1/song-search/no-such/search?${authQS()}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ q: "x" }),
    });
    expect(res.status).toBe(404);
  });
});

describe("POST /v1/artist-search/:id/search", () => {
  it("调插件 searchArtists,返回艺术家(无导入端点)", async () => {
    const res = await app.request(`/rest/api/v1/artist-search/${FAKE}/search?${authQS()}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ q: "杰伦" }),
    });
    const body = (await res.json()) as any;
    expect(body.success).toBe(true);
    expect(artistSearchCalls).toBe(1);
    expect(body.items[0].name).toBe("周杰伦");
    expect(body.items[0].avatar).toBe("http://x/a.jpg");
    expect(body.items[0].platformLabel).toBe("网易云");
  });

  it("artist 没有 import 端点(404)", async () => {
    const res = await app.request(`/rest/api/v1/artist-search/${FAKE}/import?${authQS()}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(404);
  });
});

describe("POST /v1/album-search/:id/search", () => {
  it("调插件 searchAlbums,返回专辑", async () => {
    const res = await app.request(`/rest/api/v1/album-search/${FAKE}/search?${authQS()}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ q: "叶惠美" }),
    });
    const body = (await res.json()) as any;
    expect(body.success).toBe(true);
    expect(albumSearchCalls).toBe(1);
    expect(body.items[0].name).toBe("叶惠美");
    expect(body.items[0].year).toBe(2003);
    expect(body.items[0].platformLabel).toBe("网易云");
  });
});

describe("import endpoints", () => {
  // 导入端点已异步化:POST 返回 taskId,轮询 GET /v1/tasks/:id 直到完成。
  async function importAndWait(urlPath: string, body: any): Promise<any> {
    const res = await app.request(`${urlPath}?${authQS()}`, {
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

  it("song import:歌曲数据入库为可播在线歌曲(fingerprint 去重)", async () => {
    const body = await importAndWait(`/rest/api/v1/song-search/${FAKE}/import`, {
      songs: [
        { id: "s1", source: "netease", name: "晴天", artist: "周杰伦", album: "叶惠美", duration: 269 },
        { id: "s2", source: "qq", name: "七里香", artist: "周杰伦", album: "七里香", duration: 298 },
      ],
    });
    expect(body.success).toBe(true);
    expect(body.added).toBe(2);
    // 结果带导入后的真实 DB songId(供「导入后立即播放」)
    expect(Array.isArray(body.ids)).toBe(true);
    expect(body.ids.length).toBe(2);
    const rows = db.select().from(songs).where(inArray(songs.fingerprint, [`${FAKE}:netease:s1`, `${FAKE}:qq:s2`])).all();
    expect(rows.length).toBe(2);
    for (const id of body.ids) expect(rows.some((r) => r.id === id)).toBe(true);
  });

  it("song import:重复导入去重(fingerprint 幂等)", async () => {
    const songsBody = [{ id: "s-dup-1", source: "netease", name: "去重测试", artist: "X", duration: 180 }];
    const first = await importAndWait(`/rest/api/v1/song-search/${FAKE}/import`, { songs: songsBody });
    expect(first.added).toBe(1);
    const second = await importAndWait(`/rest/api/v1/song-search/${FAKE}/import`, { songs: songsBody });
    expect(second.added).toBe(0);
    expect(second.deduped).toBe(1);
  });

  it("song import:缺 songs 列表报错", async () => {
    const res = await app.request(`/rest/api/v1/song-search/${FAKE}/import?${authQS()}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    const body = (await res.json()) as any;
    expect(body.success).toBe(false);
  });

  it("album import:拉整专 → 建「专辑歌单」(合成 sourceUrl 幂等)", async () => {
    const body = await importAndWait(`/rest/api/v1/album-search/${FAKE}/import`, {
      source: "netease", id: "al1", name: "叶惠美", cover: "http://x/al.jpg",
    });
    expect(body.success).toBe(true);
    expect(playlistCalls).toBe(1);
    expect(body.trackCount).toBe(2);
    expect(body.created).toBe(true);
    const pl = db.select().from(playlists).where(eq(playlists.sourceUrl, `${FAKE}://album/netease/al1`)).get();
    expect(pl).toBeTruthy();
    expect(pl!.name).toBe("叶惠美");
    expect(pl!.sourcePlatform).toBe("netease");
  });

  it("album import:再次导入 = 更新不新建", async () => {
    const args = { source: "qq", id: "al2", name: "七里香" };
    const first = await importAndWait(`/rest/api/v1/album-search/${FAKE}/import`, args);
    expect(first.created).toBe(true);
    const before = db.select().from(playlists).where(eq(playlists.sourceUrl, `${FAKE}://album/qq/al2`)).all();
    expect(before.length).toBe(1);
    const second = await importAndWait(`/rest/api/v1/album-search/${FAKE}/import`, args);
    expect(second.created).toBe(false);
    const after = db.select().from(playlists).where(eq(playlists.sourceUrl, `${FAKE}://album/qq/al2`)).all();
    expect(after.length).toBe(1);
    expect(playlistCalls).toBe(2);
  });

  it("album import:缺 source/id 报错", async () => {
    const res = await app.request(`/rest/api/v1/album-search/${FAKE}/import?${authQS()}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ source: "netease" }),
    });
    const body = (await res.json()) as any;
    expect(body.success).toBe(false);
  });

  it("album import:插件无 playlistSongs → 404", async () => {
    const res = await app.request(`/rest/api/v1/album-search/${FAKE_ARTIST_ONLY}/import?${authQS()}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ source: "netease", id: "x" }),
    });
    expect(res.status).toBe(404);
  });
});

describe("GET /v1/{album,artist}-search/:id/items (远程详情,只拉不导入)", () => {
  it("album items:调插件 playlistSongs,返回歌曲列表且不写库", async () => {
    const before = db.select().from(songs).all().length;
    const res = await app.request(`/rest/api/v1/album-search/${FAKE}/items?${authQS()}&source=netease&id=al1`);
    const body = (await res.json()) as any;
    expect(body.success).toBe(true);
    expect(playlistCalls).toBe(1);
    expect(body.total).toBe(2);
    expect(body.items[0].name).toBe("Track 1");
    expect(body.items[0].platformLabel).toBe("网易云");
    // 只拉不导入:歌曲表零新增
    const after = db.select().from(songs).all().length;
    expect(after).toBe(before);
  });

  it("album items:缺 source/id 报错", async () => {
    const res = await app.request(`/rest/api/v1/album-search/${FAKE}/items?${authQS()}`);
    const body = (await res.json()) as any;
    expect(body.success).toBe(false);
  });

  it("artist items:调插件 searchSongs 按名字拉歌(通用能力)", async () => {
    const res = await app.request(`/rest/api/v1/artist-search/${FAKE}/items?${authQS()}&source=netease&name=周杰伦`);
    const body = (await res.json()) as any;
    expect(body.success).toBe(true);
    expect(songSearchCalls).toBe(1);
    expect(body.total).toBe(2);
    expect(body.items[0].name).toBe("晴天");
  });

  it("artist items:缺名字报错", async () => {
    const res = await app.request(`/rest/api/v1/artist-search/${FAKE}/items?${authQS()}&source=netease`);
    const body = (await res.json()) as any;
    expect(body.success).toBe(false);
  });

  it("未注册插件 → 404", async () => {
    const res = await app.request(`/rest/api/v1/album-search/no-such/items?${authQS()}&source=netease&id=1`);
    expect(res.status).toBe(404);
  });

  it("song 类型没有 items 端点(404)", async () => {
    const res = await app.request(`/rest/api/v1/song-search/${FAKE}/items?${authQS()}&source=netease&id=1`);
    expect(res.status).toBe(404);
  });
});

describe("POST /v1/{song,artist,album}-search/aggregate/search (聚合搜索)", () => {
  const postAgg = (kind: "song" | "artist" | "album", q: string) =>
    app.request(`/rest/api/v1/${kind}-search/aggregate/search?${authQS()}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ q }),
    });

  it("song 聚合:查启用且声明 songSearch 的插件,结果带 providerId/providerName", async () => {
    const body = (await (await postAgg("song", "周杰伦")).json()) as any;
    expect(body.success).toBe(true);
    expect(songSearchCalls).toBe(1);
    expect(body.total).toBe(2);
    expect(body.providers.map((p: any) => p.id)).toEqual([FAKE]);
    // 未声明 songSearch 的 artist-only 插件不参与
    expect(body.providers.some((p: any) => p.id === FAKE_ARTIST_ONLY)).toBe(false);
    for (const it of body.items) {
      expect(it.providerId).toBe(FAKE);
      expect(it.providerName).toBe("fake-dl 聚合");
    }
  });

  it("album 聚合:返回专辑并归位 provider", async () => {
    const body = (await (await postAgg("album", "叶惠美")).json()) as any;
    expect(body.success).toBe(true);
    expect(albumSearchCalls).toBe(1);
    expect(body.items[0].name).toBe("叶惠美");
    expect(body.items[0].providerId).toBe(FAKE);
    expect(body.items[0].platformLabel).toBe("网易云");
  });

  it("artist 聚合:跨多个已启用插件并发合并(FAKE + 纯艺术家)", async () => {
    const body = (await (await postAgg("artist", "杰伦")).json()) as any;
    expect(body.success).toBe(true);
    // 两个声明 artistSearch 的插件都被调用
    expect(artistSearchCalls).toBe(1); // 计数仅在 FAKE 递增,artist-only 返回空
    expect(body.providers.map((p: any) => p.id).sort()).toEqual([FAKE, FAKE_ARTIST_ONLY].sort());
    // FAKE 返回 2 条,纯艺术家返回空 → 合并 2 条
    expect(body.total).toBe(2);
  });

  it("空关键词报错", async () => {
    const body = (await (await postAgg("song", "   ")).json()) as any;
    expect(body.success).toBe(false);
    expect(songSearchCalls).toBe(0);
  });

  it("单个插件失败不阻断聚合(仅成功插件的结果保留)", async () => {
    const BAD = "bad-artist";
    registerPlugin(
      { id: BAD, name: "坏插件", version: "1.0.0", type: "source", capabilities: ["artistSearch"], platforms: [], platformLabels: {}, configSchema: [] } as any,
      { async searchArtists() { throw new Error("boom"); } } as any,
    );
    db.insert(plugins).values({ id: BAD, name: BAD, enabled: 1, config: "{}" }).run();
    try {
      const body = (await (await postAgg("artist", "杰伦")).json()) as any;
      expect(body.success).toBe(true);
      // 好插件(FAKE)结果保留,坏插件被跳过 → 合并 2 条
      expect(body.total).toBe(2);
      expect(body.items.every((it: any) => it.providerId === FAKE)).toBe(true);
    } finally {
      unregisterPlugin(BAD);
      db.delete(plugins).where(eq(plugins.name, BAD)).run();
    }
  });
});
