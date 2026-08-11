// MUST be the first import: redirects DATA_DIR to an isolated temp dir before
// the backend opens its SQLite DB at module-load time.
import "../plugins/_env.js";

import { describe, it, expect, beforeAll } from "vitest";
import { Hono } from "hono";
import md5 from "md5";
import { db, initDatabase, encryptPassword } from "../../src/db/index.js";
import { users, artists, albums, songs, playlists, playlistSongs, playHistory, mediaSources } from "../../src/db/schema.js";
import { eq } from "drizzle-orm";
import { authMiddleware } from "../../src/middleware/auth.js";
import { restRoutes } from "../../src/routes/rest/index.js";

// 真实链路:authMiddleware(/rest/* 的 OpenSubsonic u/t/s 认证) + restRoutes。
// 不走 index.ts,避免拉起整台服务器。
const app = new Hono();
app.use("/rest/*", authMiddleware);
app.route("/rest", restRoutes);

const PLAIN = "hunter2";
const CLIENT_SALT = "clientsalt123";
const authQS = () => `u=alice&t=${md5(PLAIN + CLIENT_SALT)}&s=${CLIENT_SALT}`;
const url = (path: string) => `${path}${path.includes("?") ? "&" : "?"}${authQS()}`;

async function get(path: string) {
  const res = await app.request(url(path));
  return { res, body: await res.json().catch(() => null) };
}
const sr = (r: any) => r?.body?.["subsonic-response"] ?? null;

beforeAll(() => {
  if (!process.env.APP_VERSION) process.env.APP_VERSION = "1.0.0";
  initDatabase();
  db.insert(users).values({ id: "u1", username: "alice", password: "", salt: "salt", subsonicSalt: "subsalt", passEnc: encryptPassword(PLAIN), isAdmin: 1, isActive: 1, email: "a@b.c" }).run();
  db.insert(artists).values({ id: "ar1", name: "Test Artist" }).run();
  db.insert(albums).values({ id: "al1", name: "Test Album", artistId: "ar1", artist: "Test Artist", year: 2020, genre: "Rock" }).run();
  db.insert(songs).values([
    { id: "s1", title: "Song One", artist: "Test Artist", artistId: "ar1", album: "Test Album", albumId: "al1", duration: 180, path: "l:src:/tmp/one.mp3", suffix: "mp3", genre: "Rock", type: "local" },
    { id: "s2", title: "Song Two", artist: "Test Artist", artistId: "ar1", album: "Test Album", albumId: "al1", duration: 200, path: "l:src:/tmp/two.mp3", suffix: "mp3", genre: "Rock", type: "local" },
  ]).run();
  db.insert(playlists).values({ id: "pl1", name: "My List", ownerId: "u1", isPublic: 0, songCount: 1, duration: 180 }).run();
  db.insert(playlistSongs).values({ playlistId: "pl1", songId: "s1", position: 0, playable: 1 }).run();
  db.insert(mediaSources).values({ id: "src", name: "Local", type: "local", enabled: 1, config: "{}" }).run();
});

describe("OpenSubsonic 基础合规", () => {
  it("ping 返回 ok / MusicFlow 品牌 / openSubsonic / 1.16.1", async () => {
    const r = await get("/rest/ping");
    expect(r.res.status).toBe(200);
    expect(sr(r)?.status).toBe("ok");
    expect(sr(r)?.type).toBe("MusicFlow");
    expect(sr(r)?.openSubsonic).toBe(true);
    expect(sr(r)?.version).toBe("1.16.1");
  });

  it(".view 别名与 POST 变体均可访问(兼容垫片)", async () => {
    const a = await get("/rest/ping.view");
    expect(sr(a)?.status).toBe("ok");
    const b = await app.request(url("/rest/ping"), { method: "POST" });
    expect((await b.json())["subsonic-response"]?.status).toBe("ok");
  });

  it("未认证请求返回 401 + status failed + code 40", async () => {
    const res = await app.request("/rest/getStarred");
    expect(res.status).toBe(401);
    const b = await res.json();
    expect(b["subsonic-response"]?.status).toBe("failed");
    expect(b["subsonic-response"]?.error?.code).toBe(40);
  });

  it("serverVersion 来自 APP_VERSION", async () => {
    const r = await get("/rest/ping");
    expect(sr(r)?.serverVersion).toBe(process.env.APP_VERSION);
  });

  it("扩展声明含 songLyrics / formPost,不含未实现的 transcoding", async () => {
    const r = await get("/rest/getOpenSubsonicExtensions");
    const names = sr(r)?.openSubsonicExtensions?.map((e: any) => e.name) ?? [];
    expect(names).toContain("songLyrics");
    expect(names).toContain("formPost");
    expect(names).not.toContain("transcoding");
  });
});

describe("浏览与搜索", () => {
  it("getMusicFolders 恒含根目录 0", async () => {
    const r = await get("/rest/getMusicFolders");
    const folders = sr(r)?.musicFolders?.musicFolder ?? [];
    expect(folders[0]?.id).toBe(0);
  });

  it("getIndexes 按首字母分组", async () => {
    const r = await get("/rest/getIndexes");
    const indexes = sr(r)?.indexes?.index ?? [];
    expect(indexes.some((i: any) => i.name === "T" && i.artist.some((a: any) => a.name === "Test Artist"))).toBe(true);
  });

  it("getMusicDirectory 对专辑返回歌曲", async () => {
    const r = await get("/rest/getMusicDirectory?id=al1");
    expect(sr(r)?.directory?.child?.length).toBe(2);
  });

  it("search2 命中歌曲/专辑/歌手,支持空查询全量", async () => {
    const r = await get("/rest/search2?query=Test");
    const s2 = sr(r)?.searchResult2;
    expect(s2?.song?.map((x: any) => x.title)).toContain("Song One");
    expect(s2?.album?.map((x: any) => x.name)).toContain("Test Album");
    expect(s2?.artist?.map((x: any) => x.name)).toContain("Test Artist");
    const all = await get("/rest/search3?query=");
    expect((sr(all)?.searchResult3?.song ?? []).length).toBe(2);
  });

  it("getSong 返回单曲", async () => {
    const r = await get("/rest/getSong?id=s1");
    expect(sr(r)?.song?.title).toBe("Song One");
  });

  it("getAlbumList2 按 newest 返回专辑", async () => {
    const r = await get("/rest/getAlbumList2?type=newest&size=10");
    expect(sr(r)?.albumList2?.album?.[0]?.name).toBe("Test Album");
  });

  it("getTopSongs 支持 artistId(OpenSubsonic 扩展)", async () => {
    const r = await get("/rest/getTopSongs?artistId=ar1&count=10");
    expect((sr(r)?.topSongs?.song ?? []).length).toBe(2);
  });

  it("getLyricsBySongId 无歌词时返回空 structuredLyrics 且 ok", async () => {
    const r = await get("/rest/getLyricsBySongId?id=s1");
    expect(sr(r)?.status).toBe("ok");
    expect(sr(r)?.lyricsList?.structuredLyrics).toEqual([]);
  });
});

describe("失败体合规(status failed + 错误码)", () => {
  const cases: [string, number][] = [
    ["/rest/getSong?id=nope", 70],
    ["/rest/getAlbum?id=nope", 70],
    ["/rest/getArtist?id=nope", 70],
    ["/rest/getPlaylist?id=nope", 70],
    ["/rest/getAvatar?username=ghost", 70],
    ["/rest/stream?id=nope", 70],
    ["/rest/setRating?id=nope&rating=3", 70],
  ];
  for (const [path, code] of cases) {
    it(`${path} → failed ${code}`, async () => {
      const r = await get(path);
      expect(sr(r)?.status).toBe("failed");
      expect(sr(r)?.error?.code).toBe(code);
    });
  }

  it("stream 本地文件缺失 → failed 70", async () => {
    const r = await get("/rest/stream?id=s1");
    expect(sr(r)?.status).toBe("failed");
    expect(sr(r)?.error?.code).toBe(70);
  });
});

describe("歌单 CRUD(OpenSubsonic 写操作)", () => {
  it("createPlaylist / updatePlaylist / deletePlaylist 闭环", async () => {
    const created = await get("/rest/createPlaylist?name=NewList&songId=s1,s2");
    const pid = sr(created)?.playlist?.id;
    expect(pid).toBeTruthy();

    const upd = await get(`/rest/updatePlaylist?playlistId=${pid}&songIdToAdd=s1&comment=hi`);
    expect(sr(upd)?.status).toBe("ok");

    const detail = await get(`/rest/getPlaylist?id=${pid}`);
    expect(sr(detail)?.playlist?.entry?.length).toBe(2);

    await get(`/rest/deletePlaylist?id=${pid}`);
    const gone = await get(`/rest/getPlaylist?id=${pid}`);
    expect(sr(gone)?.status).toBe("failed");
    expect(sr(gone)?.error?.code).toBe(70);
  });

  it("getPlaylists 仅返回可见歌单(owner 可见自己的私有歌单)", async () => {
    const r = await get("/rest/getPlaylists");
    const list = sr(r)?.playlists?.playlist ?? [];
    expect(list.map((p: any) => p.id)).toContain("pl1");
  });

  it("getPlaylist 返回可播放条目", async () => {
    const r = await get("/rest/getPlaylist?id=pl1");
    expect(sr(r)?.playlist?.entry?.[0]?.title).toBe("Song One");
    expect(sr(r)?.playlist?.songCount).toBe(1);
  });
});

describe("收藏与评分", () => {
  it("star / getStarred / unstar 闭环", async () => {
    await get("/rest/star?id=s1");
    let r = await get("/rest/getStarred");
    expect(sr(r)?.starred?.song?.map((x: any) => x.id)).toContain("s1");
    await get("/rest/unstar?id=s1");
    r = await get("/rest/getStarred");
    expect(sr(r)?.starred?.song ?? []).toHaveLength(0);
  });

  it("setRating 持久化并在 getSong/getAlbum 回填 userRating", async () => {
    await get("/rest/setRating?id=s1&rating=4");
    let r = await get("/rest/getSong?id=s1");
    expect(sr(r)?.song?.userRating).toBe(4);
    await get("/rest/setRating?id=al1&rating=5");
    r = await get("/rest/getAlbum?id=al1");
    expect(sr(r)?.album?.userRating).toBe(5);
    await get("/rest/setRating?id=s1&rating=0");
    r = await get("/rest/getSong?id=s1");
    expect(sr(r)?.song?.userRating).toBe(0);
  });
});

describe("scrobble 与播放队列", () => {
  it("scrobble 记历史(10 分钟内同曲去重)并累加 playCount", async () => {
    await get("/rest/scrobble?id=s1");
    await get("/rest/scrobble?id=s1");
    const hist = db.select().from(playHistory).all();
    expect(hist.length).toBe(1);
    const song = db.select().from(songs).where(eq(songs.id, "s1")).get();
    expect(song?.playCount).toBe(2);
  });

  it("savePlayQueue / getPlayQueue 持久化", async () => {
    await get("/rest/savePlayQueue?id=s1,s2&current=s1&position=0");
    const r = await get("/rest/getPlayQueue");
    expect(sr(r)?.playQueue?.entry?.length).toBe(2);
    expect(sr(r)?.playQueue?.current).toBe("s1");
    expect(sr(r)?.playQueue?.username).toBe("alice");
  });
});

describe("头像", () => {
  it("getAvatar 返回 SVG 占位图", async () => {
    const res = await app.request(url("/rest/getAvatar?username=alice"));
    expect(res.status).toBe(200);
    expect((res.headers.get("content-type") || "").includes("image/svg+xml")).toBe(true);
  });
});
