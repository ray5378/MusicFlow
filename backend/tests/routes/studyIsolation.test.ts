// MUST be the first import: redirects DATA_DIR to an isolated temp dir before
// the backend opens its SQLite DB at module-load time.
import "../plugins/_env.js";

import { describe, it, expect, beforeAll } from "vitest";
import { Hono } from "hono";
import md5 from "md5";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { db, initDatabase, encryptPassword } from "../../src/db/index.js";
import { users, songs, playlists, playlistSongs, playHistory, mediaSources, studyProgress, studyPlaylistProgress } from "../../src/db/schema.js";
import { and, eq } from "drizzle-orm";
import { authMiddleware } from "../../src/middleware/auth.js";
import { restRoutes } from "../../src/routes/rest/index.js";
import { registerStudy } from "../../src/routes/api/study.js";
import { registerLibrary } from "../../src/routes/api/library.js";
import { registerPlaylists } from "../../src/routes/api/playlists.js";
import { registerHistory } from "../../src/routes/api/history.js";
import { normalizeRelDir } from "../../src/services/study/browse.js";

const app = new Hono();
app.use("/rest/*", authMiddleware);
const api = new Hono();
registerLibrary(api);
registerPlaylists(api);
registerHistory(api);
registerStudy(api);
app.route("/rest/api", api);
app.route("/rest", restRoutes);

const PLAIN = "hunter2";
const CLIENT_SALT = "clientsalt123";
const authQS = () => `u=alice&t=${md5(PLAIN + CLIENT_SALT)}&s=${CLIENT_SALT}`;
async function call(method: string, p: string, body?: any) {
  return callAs("alice", method, p, body);
}
async function callAs(username: string, method: string, p: string, body?: any) {
  const qs = `u=${username}&t=${md5(PLAIN + CLIENT_SALT)}&s=${CLIENT_SALT}`;
  const res = await app.request(`/rest/api${p}${p.includes("?") ? "&" : "?"}${qs}`, {
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { res, body: await res.json().catch(() => null) };
}
async function rest(pathAndQuery: string) {
  const res = await app.request(`/rest${pathAndQuery}${pathAndQuery.includes("?") ? "&" : "?"}${authQS()}`);
  const body = await res.json().catch(() => null);
  return { res, body };
}

let studyRoot = "";

beforeAll(() => {
  initDatabase();
  db.insert(users).values({
    id: "u1", username: "alice", password: "", salt: "salt", subsonicSalt: "subsalt",
    passEnc: encryptPassword(PLAIN), isAdmin: 1, isActive: 1, email: "a@b.c",
  }).run();
  db.insert(users).values({
    id: "u3", username: "carol", password: "", salt: "salt3", subsonicSalt: "subsalt3",
    passEnc: encryptPassword(PLAIN), isAdmin: 1, isActive: 1, email: "c@b.c",
  }).run();

  // 学习源(本地目录):两层课程目录 + 一个非音频文件
  studyRoot = fs.mkdtempSync(path.join(os.tmpdir(), "study-src-"));
  fs.mkdirSync(path.join(studyRoot, "数学"), { recursive: true });
  fs.mkdirSync(path.join(studyRoot, "英语"), { recursive: true });
  fs.writeFileSync(path.join(studyRoot, "数学", "第01课.mp3"), Buffer.alloc(64));
  fs.writeFileSync(path.join(studyRoot, "数学", "第02课.mp3"), Buffer.alloc(64));
  fs.writeFileSync(path.join(studyRoot, "数学", "大纲.txt"), "not audio");
  // st2 对应的真实文件:目录列表用例需要它在磁盘上可见(进度列靠 path 反查歌曲行)
  fs.writeFileSync(path.join(studyRoot, "英语", "words.mp3"), Buffer.alloc(64));

  db.insert(mediaSources).values([
    { id: "src-music", name: "Music", type: "local", kind: "music", enabled: 1, config: "{}" },
    { id: "src-study", name: "课程", type: "local", kind: "study", enabled: 1, config: JSON.stringify({ path: studyRoot }) },
  ]).run();

  db.insert(songs).values([
    { id: "m1", title: "Song One", artist: "Artist", album: "Album", duration: 180, path: "l:src-music:/m/1.mp3", suffix: "mp3", genre: "Rock", type: "local", kind: "music" },
    { id: "m2", title: "Song Two", artist: "Artist", album: "Album", duration: 200, path: "l:src-music:/m/2.mp3", suffix: "mp3", genre: "Pop", type: "local", kind: "music" },
    { id: "st1", title: "第01课", artist: "", album: "数学", duration: 600, path: `l:src-study:${path.join(studyRoot, "数学", "第01课.mp3")}`, suffix: "mp3", type: "local", kind: "study", sourceId: "src-study", relDir: "数学" },
    { id: "st2", title: "单词", artist: "", album: "英语", duration: 300, path: `l:src-study:${path.join(studyRoot, "英语", "words.mp3")}`, suffix: "mp3", type: "local", kind: "study", sourceId: "src-study", relDir: "英语" },
  ]).run();

  db.insert(playHistory).values({ userId: "u1", songId: "st1", playedAt: new Date().toISOString() }).run();
  db.insert(playlists).values([
    { id: "pl-music", name: "Music List", ownerId: "u1" },
    { id: "pl-study", name: "课程清单", ownerId: "u1", kind: "study" },
  ]).run();
  db.insert(playlistSongs).values([
    { playlistId: "pl-music", songId: "m1", position: 0, playable: 1 },
    { playlistId: "pl-study", songId: "st1", position: 0, playable: 1 },
  ]).run();
});

describe("学习模块隔离矩阵", () => {
  it("/v1/songs 不含学习内容", async () => {
    const { body } = await call("GET", "/v1/songs?pageSize=200");
    expect(body.total).toBe(2);
    expect(body.items.map((i: any) => i.id).sort()).toEqual(["m1", "m2"]);
  });

  it("/v1/stats 只统计音乐行", async () => {
    const { body } = await call("GET", "/v1/stats");
    expect(body.songCount).toBe(2);
  });

  it("/v1/genres 不含学习流派/课程名", async () => {
    const { body } = await call("GET", "/v1/genres?pageSize=200");
    const names = body.items.map((g: any) => g.name);
    expect(names).toContain("Rock");
    expect(names).not.toContain("数学");
  });

  it("getMusicFolders 不返回学习源", async () => {
    const { body } = await rest("/getMusicFolders");
    const folders = body["subsonic-response"].musicFolders.musicFolder as any[];
    expect(folders.some((f) => f.id === "src-study")).toBe(false);
    expect(folders.some((f) => f.id === "src-music")).toBe(true);
  });

  it("search3 空查询不翻出学习内容", async () => {
    const { body } = await rest("/search3?query=&songCount=100");
    const ids = body["subsonic-response"].searchResult3.song.map((s: any) => s.id);
    expect(ids.sort()).toEqual(["m1", "m2"]);
  });

  it("getSong 按 id 取学习内容返回 70", async () => {
    const { body } = await rest("/getSong?id=st1");
    expect(body["subsonic-response"].status).toBe("failed");
    expect(body["subsonic-response"].error.code).toBe(70);
  });

  it("getRandomSongs 只抽音乐行", async () => {
    const { body } = await rest("/getRandomSongs?size=100");
    const ids = body["subsonic-response"].randomSongs.song.map((s: any) => s.id);
    expect(ids.every((id: string) => id === "m1" || id === "m2")).toBe(true);
    expect(ids.length).toBe(2);
  });

  it("音乐歌单列表与 v1 歌单列表都不含学习歌单", async () => {
    const restList = await rest("/getPlaylists");
    const ids = restList.body["subsonic-response"].playlists.playlist.map((p: any) => p.id);
    expect(ids).toEqual(["pl-music"]);
    const v1 = await call("GET", "/v1/playlists?pageSize=200");
    expect(v1.body.items.map((p: any) => p.id)).toEqual(["pl-music"]);
    // 学习歌单详情对第三方 404
    const detail = await rest("/getPlaylist?id=pl-study");
    expect(detail.body["subsonic-response"].status).toBe("failed");
  });

  it("/v1/history 与 scrobble 都忽略学习音频", async () => {
    const { body } = await call("GET", "/v1/history?pageSize=100");
    expect(body.items.length).toBe(0);
    const before = db.select().from(playHistory).where(and(eq(playHistory.userId, "u1"), eq(playHistory.songId, "st1"))).all().length;
    await rest("/scrobble?id=st1&submission=true");
    const after = db.select().from(playHistory).where(and(eq(playHistory.userId, "u1"), eq(playHistory.songId, "st1"))).all().length;
    expect(after).toBe(before);
    const row = db.select().from(songs).where(eq(songs.id, "st1")).get();
    expect(row?.playCount ?? 0).toBe(0);
  });
});

describe("学习 API", () => {
  it("sources 只返回学习源", async () => {
    const { body } = await call("GET", "/v1/study/sources");
    expect(body.items.map((s: any) => s.id)).toEqual(["src-study"]);
    // 曲目数按 source_id 统计;点播入库会在其他用例中继续增加,这里只断言 > 0
    expect(body.items[0].songCount).toBeGreaterThan(0);
  });

  it("dir 实时列目录(只列音频与子目录)且拒绝目录穿越", async () => {
    const { body, res } = await call("GET", `/v1/study/dir?id=dir:src-study:数学`);
    expect(res.status).toBe(200);
    expect(body.items.map((i: any) => i.name).sort()).toEqual(["第01课.mp3", "第02课.mp3"]);
    const bad = await call("GET", `/v1/study/dir?id=dir:src-study:../etc`);
    expect(bad.res.status).toBe(400);
    expect(() => normalizeRelDir("a/../../b")).toThrow();
  });

  it("resolve 点播即入库并打学习章", async () => {
    // 第02课 未入库:走真实「取头解析 → upsertSong」路径
    const rel = "数学/第02课.mp3";
    const { body, res } = await call("POST", "/v1/study/resolve", { sourceId: "src-study", path: rel });
    expect(res.status).toBe(200);
    expect(body.song.title).toBe("第02课");
    expect(body.song.sourceId).toBe("src-study");
    expect(body.song.relDir).toBe("数学");
    const row = db.select().from(songs).where(eq(songs.id, body.song.id)).get();
    expect(row?.kind).toBe("study");
    expect(row?.album).toBe("数学");
    expect(row?.albumId ?? null).toBeNull();
  });

  it("progress 落 study_progress,continue 能续播,且不污染音乐历史", async () => {
    const songId = "st2";
    const put = await call("PUT", "/v1/study/progress", { songId, positionSec: 90, durationSec: 600 });
    expect(put.res.status).toBe(200);
    expect(put.body.finished).toBe(false);
    const saved = db.select().from(studyProgress).where(and(eq(studyProgress.userId, "u1"), eq(studyProgress.songId, songId))).get();
    expect(saved?.positionSec).toBe(90);
    const cont = await call("GET", "/v1/study/continue");
    expect(cont.body.items.some((i: any) => i.id === songId && i.positionSec === 90)).toBe(true);
    const hist = db.select().from(playHistory).where(eq(playHistory.songId, songId)).all().length;
    expect(hist).toBe(0);
  });

  it("dir 条目回带 songId 与当前用户进度(章节进度列)", async () => {
    // 自己写入进度,避免依赖用例执行顺序
    const put = await call("PUT", "/v1/study/progress", { songId: "st2", positionSec: 90, durationSec: 600 });
    expect(put.res.status).toBe(200);
    const prog = db.select().from(studyProgress).all();
    expect(prog.map((p) => [p.userId, p.songId, p.positionSec, p.durationSec])).toContainEqual(["u1", "st2", 90, 600]);
    const { body } = await call("GET", `/v1/study/dir?id=dir:src-study:英语`);
    const item = body.items.find((i: any) => i.name === "words.mp3");
    expect(item?.songId).toBe("st2");
    expect(item?.durationSec).toBe(600);
    expect(item?.positionSec).toBe(90);
    expect(item?.progress).toBeCloseTo(0.15, 3);
    // 已入库文件带 songId;目录里所有条目都不应因为进度缺失而报错
    const math = await call("GET", `/v1/study/dir?id=dir:src-study:数学`);
    const unloaded = math.body.items.find((i: any) => i.name === "第02课.mp3");
    expect(unloaded.progress).toBeGreaterThanOrEqual(0);
  });

  it("resolve-batch 批量入库:顺序对齐,单条失败不影响其余", async () => {
    const { body, res } = await call("POST", "/v1/study/resolve-batch", {
      sourceId: "src-study",
      paths: ["数学/第01课.mp3", "英语/不存在的课.mp3"],
    });
    expect(res.status).toBe(200);
    expect(body.items.length).toBe(2);
    expect(body.items[0].song.id).toBe("st1");
    expect(body.items[0].song.kind).toBe("study");
    expect(body.items[1].error).toBeTruthy();
  });

  it("学习歌单可创建、加曲、与音乐歌单列表隔离", async () => {
    const created = await call("POST", "/v1/study/playlists", { name: "我的课程" });
    expect(created.res.status).toBe(200);
    const id = created.body.id as string;
    const songId = db.select().from(songs).where(eq(songs.kind, "study")).get()!.id;
    await call("POST", `/v1/study/playlists/${id}/tracks`, { add: [songId] });
    const tracks = await call("GET", `/v1/study/playlists/${id}/tracks`);
    expect(tracks.body.total).toBe(1);
    expect(tracks.body.items[0].id).toBe(songId);
    const musicList = await call("GET", "/v1/playlists?pageSize=200");
    expect(musicList.body.items.some((p: any) => p.id === id)).toBe(false);
    const studyList = await call("GET", "/v1/study/playlists");
    expect(studyList.body.items.some((p: any) => p.id === id)).toBe(true);
  });

  it("学习歌单名称在同一用户下不可重复(忽略大小写与首尾空格)", async () => {
    const created = await call("POST", "/v1/study/playlists", { name: "重复测试" });
    expect(created.res.status).toBe(200);
    const dup = await call("POST", "/v1/study/playlists", { name: "  重复测试 " });
    expect(dup.res.status).toBe(409);

    const other = await call("POST", "/v1/study/playlists", { name: "另一个歌单" });
    const renamed = await call("PUT", `/v1/study/playlists/${other.body.id}`, { name: "重复测试" });
    expect(renamed.res.status).toBe(409);
    // 改成自己当前的名字不算重名
    const self = await call("PUT", `/v1/study/playlists/${created.body.id}`, { name: "重复测试" });
    expect(self.res.status).toBe(200);
    // 不同用户可以各自使用同名歌单
    const carol = await callAs("carol", "POST", "/v1/study/playlists", { name: "重复测试" });
    expect(carol.res.status).toBe(200);
  });

  it("管理员的学习歌单列表不包含其他用户创建的歌单", async () => {
    const carolPl = await callAs("carol", "POST", "/v1/study/playlists", { name: "Carol私有课" });
    expect(carolPl.res.status).toBe(200);
    const adminList = await call("GET", "/v1/study/playlists");
    expect(adminList.body.items.some((p: any) => p.id === carolPl.body.id)).toBe(false);
    const carolList = await callAs("carol", "GET", "/v1/study/playlists");
    expect(carolList.body.items.some((p: any) => p.id === carolPl.body.id)).toBe(true);
  });

  it("学习歌单曲目返回与源文件一致的文件名(含扩展名)", async () => {
    const tracks = await call("GET", "/v1/study/playlists/pl-study/tracks");
    expect(tracks.body.items[0].fileName).toBe("第01课.mp3");
  });

  it("学习歌单文件夹:新建/归类/改名/解散,并支持按名称搜索歌单", async () => {
    const folder = await call("POST", "/v1/study/playlist-folders", { name: "高数" });
    expect(folder.res.status).toBe(200);
    const created = await call("POST", "/v1/study/playlists", { name: "高数第一课", folder: "高数" });
    const id = created.body.id as string;

    let list = await call("GET", "/v1/study/playlists");
    expect(list.body.folders).toContain("高数");
    expect(list.body.items.find((p: any) => p.id === id)?.folder).toBe("高数");

    // 按名称搜索只返回匹配项
    const searched = await call("GET", "/v1/study/playlists?q=高数第一");
    expect(searched.body.items.map((p: any) => p.id)).toEqual([id]);
    const miss = await call("GET", "/v1/study/playlists?q=不存在的名字");
    expect(miss.body.items).toHaveLength(0);

    // 改名:文件夹与歌单归属一起更新
    const renamed = await call("PUT", `/v1/study/playlist-folders/${encodeURIComponent("高数")}`, { name: "高等数学" });
    expect(renamed.res.status).toBe(200);
    list = await call("GET", "/v1/study/playlists");
    expect(list.body.folders).toContain("高等数学");
    expect(list.body.folders).not.toContain("高数");
    expect(list.body.items.find((p: any) => p.id === id)?.folder).toBe("高等数学");

    // 移动到根目录
    await call("PUT", `/v1/study/playlists/${id}`, { folder: "" });
    list = await call("GET", "/v1/study/playlists");
    expect(list.body.items.find((p: any) => p.id === id)?.folder).toBe("");

    // 解散文件夹不删歌单
    const removed = await call("DELETE", `/v1/study/playlist-folders/${encodeURIComponent("高等数学")}`);
    expect(removed.res.status).toBe(200);
    list = await call("GET", "/v1/study/playlists");
    expect(list.body.folders).not.toContain("高等数学");
    expect(list.body.items.some((p: any) => p.id === id)).toBe(true);
  });

  it("学习歌单文件夹按用户隔离:列表与歌单归属都不串用户", async () => {
    await call("POST", "/v1/study/playlist-folders", { name: "Alice课程" });
    const pub = await call("POST", "/v1/study/playlists", { name: "Alice公开课", folder: "Alice课程", public: true });

    // carol 创建自己的文件夹
    const bobFolder = await callAs("carol", "POST", "/v1/study/playlist-folders", { name: "Bob笔记" });
    expect(bobFolder.res.status).toBe(200);

    let bobList = await callAs("carol", "GET", "/v1/study/playlists");
    expect(bobList.body.folders).not.toContain("Alice课程");
    expect(bobList.body.folders).toEqual(expect.arrayContaining(["Bob笔记"]));
    // 非本人歌单的文件夹归属不暴露,统一显示在根目录
    expect(bobList.body.items.find((p: any) => p.id === pub.body.id)?.folder).toBe("");

    // alice(管理员)列表同样不混入 carol 的文件夹
    const aliceList = await call("GET", "/v1/study/playlists");
    expect(aliceList.body.folders).toEqual(expect.arrayContaining(["Alice课程"]));
    expect(aliceList.body.folders).not.toContain("Bob笔记");

    // carol 不能改名/删除 alice 的文件夹
    const renamed = await callAs("carol", "PUT", `/v1/study/playlist-folders/${encodeURIComponent("Alice课程")}`, { name: "被改掉" });
    expect(renamed.res.status).toBe(404);
    const removed = await callAs("carol", "DELETE", `/v1/study/playlist-folders/${encodeURIComponent("Alice课程")}`);
    expect(removed.res.status).toBe(200);
    expect((await call("GET", "/v1/study/playlists")).body.folders).toContain("Alice课程");
  });

  it("学习歌单文件夹支持多级子目录:改名/删除整棵迁移", async () => {
    const parent = await call("POST", "/v1/study/playlist-folders", { name: "多级" });
    expect(parent.body.name).toBe("多级");
    const child = await call("POST", "/v1/study/playlist-folders", { name: "子目录", parent: "多级" });
    expect(child.body.name).toBe("多级/子目录");
    const pl = await call("POST", "/v1/study/playlists", { name: "多级歌单", folder: "多级/子目录" });

    let list = await call("GET", "/v1/study/playlists");
    expect(list.body.folders).toEqual(expect.arrayContaining(["多级", "多级/子目录"]));
    expect(list.body.items.find((p: any) => p.id === pl.body.id)?.folder).toBe("多级/子目录");

    // 重命名父目录:子目录与歌单一起迁移
    const renamed = await call("POST", "/v1/study/playlist-folders/rename", { path: "多级", name: "改名" });
    expect(renamed.body.name).toBe("改名");
    list = await call("GET", "/v1/study/playlists");
    expect(list.body.folders).toContain("改名/子目录");
    expect(list.body.items.find((p: any) => p.id === pl.body.id)?.folder).toBe("改名/子目录");

    // 删除父目录:整棵解散,夹内歌单回到上一级(此处为根目录)
    await call("POST", "/v1/study/playlist-folders/delete", { path: "改名" });
    list = await call("GET", "/v1/study/playlists");
    expect(list.body.folders).not.toContain("改名/子目录");
    expect(list.body.items.find((p: any) => p.id === pl.body.id)?.folder).toBe("");
  });

  it("导出学习歌单:带 songId 与相对路径,可跨库重入库", async () => {
    const single = await call("GET", "/v1/study/playlists/pl-study/export");
    expect(single.res.status).toBe(200);
    expect(single.body.app).toBe("MusicFlow-StudyPlaylists");
    expect(single.body.name).toBe("课程清单");
    expect(single.body.tracks).toHaveLength(1);
    expect(single.body.tracks[0].songId).toBe("st1");
    expect(single.body.tracks[0].relPath).toBe("数学/第01课.mp3");
    expect(single.body.tracks[0].sourceId).toBe("src-study");
    expect(single.body.tracks[0].sourceName).toBe("课程");

    // 非拥有者且非管理员不能导出他人歌单
    db.insert(users).values({
      id: "u2", username: "bob", password: "", salt: "salt", subsonicSalt: "subsalt",
      passEnc: encryptPassword(PLAIN), isAdmin: 0, isActive: 1, email: "b@b.c",
    }).run();
    const forbidden = await app.request(
      `/rest/api/v1/study/playlists/pl-study/export?u=bob&t=${md5(PLAIN + CLIENT_SALT)}&s=${CLIENT_SALT}`,
    );
    expect(forbidden.status).toBe(403);

    const all = await call("GET", "/v1/study/playlists/export-all");
    expect(all.res.status).toBe(200);
    expect(all.body.exportAll).toBe(true);
    const list = all.body.playlists.find((p: any) => p.name === "课程清单");
    expect(list?.tracks?.[0]?.relPath).toBe("数学/第01课.mp3");
  });

  it("导入学习歌单:songId 命中;重复导入合并去重;relPath 兜底恢复", async () => {
    const payload = {
      app: "MusicFlow-StudyPlaylists",
      version: 1,
      name: "导入课程",
      tracks: [{ songId: "st1", title: "第01课", relPath: "数学/第01课.mp3", sourceId: "src-study", sourceName: "课程" }],
    };
    const first = await call("POST", "/v1/study/playlists/import", { native: payload });
    expect(first.res.status).toBe(200);
    expect(first.body.created).toBe(1);
    expect(first.body.matched).toBe(1);
    expect(first.body.unmatched).toBe(0);
    const id = first.body.playlists[0].id as string;
    let tracks = await call("GET", `/v1/study/playlists/${id}/tracks`);
    expect(tracks.body.items.map((i: any) => i.id)).toEqual(["st1"]);

    // 同名重复导入 → 合并,不重复加曲
    const again = await call("POST", "/v1/study/playlists/import", { native: payload });
    expect(again.body.merged).toBe(1);
    expect(again.body.created).toBe(0);
    tracks = await call("GET", `/v1/study/playlists/${id}/tracks`);
    expect(tracks.body.total).toBe(1);

    // 只给相对路径(模拟换库后 songId 失效):按 sourceId + relPath 重新入库
    const byPath = await call("POST", "/v1/study/playlists/import", {
      native: { name: "路径恢复", tracks: [{ title: "单词", relPath: "英语/words.mp3", sourceId: "src-study" }] },
    });
    expect(byPath.body.matched).toBe(1);
    const restoredId = byPath.body.playlists[0].id as string;
    tracks = await call("GET", `/v1/study/playlists/${restoredId}/tracks`);
    expect(tracks.body.items.map((i: any) => i.id)).toEqual(["st2"]);
  });

  it("在歌单文件夹内导入:歌单直接归入该文件夹,同名歌单跟随移动", async () => {
    const payload = { name: "子目录课程", tracks: [{ songId: "st1", title: "第01课" }] };
    const first = await call("POST", "/v1/study/playlists/import", { native: payload, folder: "高数" });
    expect(first.res.status).toBe(200);
    expect(first.body.created).toBe(1);
    const id = first.body.playlists[0].id as string;
    let list = await call("GET", "/v1/study/playlists");
    expect(list.body.folders).toContain("高数");
    expect(list.body.items.find((p: any) => p.id === id)?.folder).toBe("高数");

    // 同名歌单再次从根目录导入:不应把它从文件夹里拖出来
    await call("POST", "/v1/study/playlists/import", { native: payload });
    list = await call("GET", "/v1/study/playlists");
    expect(list.body.items.find((p: any) => p.id === id)?.folder).toBe("高数");
  });

  it("导入学习歌单:非法文件返回 400,空曲目也允许建空歌单", async () => {
    const bad = await call("POST", "/v1/study/playlists/import", { native: { foo: 1 } });
    expect(bad.res.status).toBe(400);
    const empty = await call("POST", "/v1/study/playlists/import", {
      native: { playlists: [{ name: "空课程", tracks: [] }] },
    });
    expect(empty.res.status).toBe(200);
    expect(empty.body.created).toBe(1);
    expect(empty.body.trackCount).toBe(0);
  });

  it("删除学习记录:只删自己的那一条", async () => {
    await call("PUT", "/v1/study/progress", { songId: "st1", positionSec: 30, durationSec: 600 });
    db.insert(studyProgress).values({
      userId: "u3", songId: "st1", positionSec: 12, durationSec: 600, finished: 0,
      updatedAt: new Date().toISOString(),
    }).onConflictDoNothing().run();
    const del = await call("DELETE", "/v1/study/progress/st1");
    expect(del.res.status).toBe(200);
    expect(db.select().from(studyProgress).where(and(eq(studyProgress.userId, "u1"), eq(studyProgress.songId, "st1"))).get()).toBeUndefined();
    // 他人同名记录不受影响
    expect(db.select().from(studyProgress).where(and(eq(studyProgress.userId, "u3"), eq(studyProgress.songId, "st1"))).get()).toBeTruthy();
    db.delete(studyProgress).where(and(eq(studyProgress.userId, "u3"), eq(studyProgress.songId, "st1"))).run();
  });

  it("清空学习记录:只清当前用户,他人记录不受影响", async () => {
    await call("PUT", "/v1/study/progress", { songId: "st2", positionSec: 20, durationSec: 600 });
    db.insert(studyProgress).values({
      userId: "u3", songId: "st2", positionSec: 12, durationSec: 600, finished: 0,
      updatedAt: new Date().toISOString(),
    }).onConflictDoNothing().run();
    const cleared = await call("DELETE", "/v1/study/progress");
    expect(cleared.res.status).toBe(200);
    expect(db.select().from(studyProgress).where(eq(studyProgress.userId, "u1")).all()).toHaveLength(0);
    expect(db.select().from(studyProgress).where(eq(studyProgress.userId, "u3")).all().length).toBeGreaterThan(0);
    // 音频文件与歌曲行仍在
    expect(db.select().from(songs).where(eq(songs.id, "st2")).get()).toBeTruthy();
    db.delete(studyProgress).where(eq(studyProgress.userId, "u3")).run();
  });

  it("学习歌单续播:记录位置、continue 返回歌单条目、清空记录一并清理", async () => {
    const put = await call("PUT", "/v1/study/playlists/pl-study/progress", {
      songId: "st1", positionSec: 42, durationSec: 600,
    });
    expect(put.res.status).toBe(200);
    const saved = db.select().from(studyPlaylistProgress)
      .where(and(eq(studyPlaylistProgress.userId, "u1"), eq(studyPlaylistProgress.playlistId, "pl-study"))).get();
    expect(saved?.songId).toBe("st1");
    expect(saved?.positionSec).toBe(42);

    // 歌单曲目带上所属歌单,前端据此上报整单续播位置
    const tracks = await call("GET", "/v1/study/playlists/pl-study/tracks");
    expect(tracks.body.items[0].playlistId).toBe("pl-study");
    expect(tracks.body.items[0].fileName).toBe("第01课.mp3");

    const cont = await call("GET", "/v1/study/continue");
    const item = cont.body.playlistItems.find((i: any) => i.playlistId === "pl-study");
    expect(item?.id).toBe("st1");
    expect(item?.playlistName).toBe("课程清单");
    expect(item?.positionSec).toBe(42);

    // 不在歌单内的曲目拒绝上报
    const bad = await call("PUT", "/v1/study/playlists/pl-study/progress", { songId: "st2", positionSec: 1 });
    expect(bad.res.status).toBe(400);

    // 清空学习记录同时清空歌单续播
    const cleared = await call("DELETE", "/v1/study/progress");
    expect(cleared.res.status).toBe(200);
    expect(db.select().from(studyPlaylistProgress).where(eq(studyPlaylistProgress.userId, "u1")).all()).toHaveLength(0);
  });

  it("学习记录只保留最新 50 条", async () => {
    const ids = Array.from({ length: 60 }, (_, i) => `cap${i}`);
    db.insert(songs).values(ids.map((id) => ({
      id, title: id, artist: "", album: "上限", duration: 100,
      path: `l:src-study:${id}.mp3`, suffix: "mp3", type: "local", kind: "study", sourceId: "src-study",
    }))).run();
    const base = Date.parse("2026-01-01T00:00:00.000Z");
    db.insert(studyProgress).values(ids.map((songId, i) => ({
      userId: "u3", songId, positionSec: i, durationSec: 100, finished: 0,
      updatedAt: new Date(base + i * 1000).toISOString(),
    }))).run();
    const put = await callAs("carol", "PUT", "/v1/study/progress", { songId: "cap59", positionSec: 50, durationSec: 100 });
    expect(put.res.status).toBe(200);
    const left = db.select().from(studyProgress).where(eq(studyProgress.userId, "u3")).all();
    expect(left.length).toBe(50);
    expect(left.some((r) => r.songId === "cap59")).toBe(true);
    expect(left.some((r) => r.songId === "cap0")).toBe(false);
  });
});
