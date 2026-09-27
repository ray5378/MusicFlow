// MUST be the first import: redirects DATA_DIR to an isolated temp dir before
// the backend opens its SQLite DB at module-load time.
import "../plugins/_env.js";

import { describe, it, expect, beforeEach, beforeAll, vi } from "vitest";
import { initDatabase, sqlite } from "../../src/db/index.js";

// 被 mock 的依赖:源可用性探测(真实实现摸文件系统)、插件开关读取、日志。
const h = vi.hoisted(() => ({
  probeOk: vi.fn(async (_song: any) => true),
  active: true,
  preferLocal: true,
  fallbackToWeb: true,
  logs: { info: [] as any[], warn: [] as any[], error: [] as any[] },
}));

// 三个 mock 一律用 importOriginal 展开真实导出:content.ts 的依赖链
// (dlna/queue → player → plugins/builtins)会读同模块的其它导出(如
// playPreferenceManifest / parseSongPath / getLogLevel),整体替换会导致
// 「No … export is defined on the mock」收集失败。
vi.mock("../../src/utils/localSourceProbe.js", async (importOriginal) => {
  const actual = await importOriginal<any>();
  return { ...actual, probeLocalSourceOk: (song: any) => h.probeOk(song) };
});

vi.mock("../../src/services/plugin/core/playPreference.js", async (importOriginal) => {
  const actual = await importOriginal<any>();
  return {
    ...actual,
    playPreferenceActive: () => h.active,
    preferLocalEnabled: () => h.preferLocal,
    fallbackToWebEnabled: () => h.fallbackToWeb,
  };
});

vi.mock("../../src/utils/logger.js", async (importOriginal) => {
  const actual = await importOriginal<any>();
  return {
    ...actual,
    createLogger: () => ({
      debug: () => {},
      info: (msg: string, meta?: any) => h.logs.info.push([msg, meta]),
      warn: (msg: string, meta?: any) => h.logs.warn.push([msg, meta]),
      error: (msg: string, meta?: any) => h.logs.error.push([msg, meta]),
    }),
  };
});

import { resolveContentSongs, songsToQueueItems } from "../../src/services/content.js";

const iso = (n = 0) => new Date(Date.now() + n).toISOString();

function seedArtist(id: string, name = id) {
  sqlite
    .prepare("INSERT OR IGNORE INTO artists (id, name, created_at, updated_at) VALUES (?,?,?,?)")
    .run(id, name, iso(), iso());
}

function seedAlbum(id: string, over: Record<string, any> = {}) {
  if (over.artistId) seedArtist(over.artistId);
  sqlite
    .prepare(
      `INSERT OR IGNORE INTO albums (id, name, artist_id, artist, year, genre, cover_art, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?)`,
    )
    .run(
      id,
      over.name ?? `专辑-${id}`,
      over.artistId ?? null,
      over.artist ?? null,
      over.year === undefined ? 0 : over.year,
      over.genre ?? "",
      over.coverArt ?? null,
      iso(),
      iso(),
    );
}

function seedSong(id: string, over: Record<string, any> = {}) {
  if (over.artistId) seedArtist(over.artistId);
  if (over.albumId) seedAlbum(over.albumId, { artistId: over.albumArtistId });
  sqlite
    .prepare(
      `INSERT INTO songs (id, title, artist, artist_id, album, album_id, genre, duration,
                          path, suffix, type, group_id, cover_art, track, disc_number, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    )
    .run(
      id,
      over.title === undefined ? `T-${id}` : over.title,
      over.artist ?? "",
      over.artistId ?? null,
      over.album ?? "",
      over.albumId ?? null,
      over.genre ?? "",
      over.duration === undefined ? 200 : over.duration,
      over.path ?? `l:src:/tmp/${id}.mp3`,
      over.suffix ?? "mp3",
      over.type ?? "local",
      over.groupId ?? null,
      over.coverArt ?? null,
      over.track === undefined ? 0 : over.track,
      over.discNumber === undefined ? 1 : over.discNumber,
      iso(over.seq ?? 0),
    );
}

function seedPlaylist(id: string, name = `歌单-${id}`) {
  const owner = sqlite.prepare("SELECT id FROM users WHERE is_admin = 1 LIMIT 1").get() as any;
  sqlite
    .prepare("INSERT INTO playlists (id, name, owner_id, is_public, comment, created_at, updated_at) VALUES (?,?,?,1,'',?,?)")
    .run(id, name, owner.id, iso(), iso());
}

function addPlaylistEntry(playlistId: string, songId: string | null, position: number, playable = 1) {
  sqlite
    .prepare("INSERT INTO playlist_songs (playlist_id, song_id, position, playable, created_at) VALUES (?,?,?,?,?)")
    .run(playlistId, songId, position, playable, iso());
}

/** 取回库里的真实歌曲行(drizzle 的 camelCase 属性),用于直接调 songsToQueueItems。 */
function readSongs(...ids: string[]): any[] {
  return ids.map((id) => {
    const r = sqlite.prepare("SELECT * FROM songs WHERE id = ?").get(id) as any;
    return {
      ...r,
      artistId: r.artist_id,
      albumId: r.album_id,
      coverArt: r.cover_art,
      discNumber: r.disc_number,
      groupId: r.group_id,
    };
  });
}

beforeAll(() => {
  if (!process.env.APP_VERSION) process.env.APP_VERSION = "1.0.0";
  initDatabase();
});

beforeEach(() => {
  vi.clearAllMocks();
  h.probeOk.mockImplementation(async () => true);
  h.active = true;
  h.preferLocal = true;
  h.fallbackToWeb = true;
  h.logs.info.length = 0;
  h.logs.warn.length = 0;
  sqlite.prepare("DELETE FROM playlist_songs").run();
  sqlite.prepare("DELETE FROM playlists").run();
  sqlite.prepare("DELETE FROM songs").run();
  sqlite.prepare("DELETE FROM albums").run();
  sqlite.prepare("DELETE FROM artists").run();
  sqlite.prepare("DELETE FROM genres").run();
});

describe("songsToQueueItems:行 → QueueItem 映射", () => {
  it("空输入 → 空数组(不查专辑表,不抛)", () => {
    expect(songsToQueueItems([])).toEqual([]);
  });

  it("封面回退链:自带封面原样透传;否则 al-<albumId>;两者都无 → undefined", () => {
    seedAlbum("al1");
    seedSong("sA", { albumId: "al1", coverArt: "so-x" });
    seedSong("sB", { albumId: "al1" });
    seedSong("sC");
    const out = songsToQueueItems(readSongs("sA", "sB", "sC"));
    expect(out[0].coverArt).toBe("so-x");
    expect(out[1].coverArt).toBe("al-al1");
    expect(out[2].coverArt).toBeUndefined();
  });

  it("专辑元数据补齐:albumArtist / year / genre 从 albums 批取(不逐行 N+1)", () => {
    seedAlbum("al1", { name: "专辑甲", artistId: "ar1", artist: "专辑艺人", year: 1999, genre: "Jazz" });
    seedSong("s1", { albumId: "al1", artist: "曲目艺人", genre: "" });
    seedSong("s2", { albumId: "al1", artist: "曲目艺人", genre: "Rock" });
    const out = songsToQueueItems(readSongs("s1", "s2"));
    expect(out[0]).toMatchObject({ albumId: "al1", albumArtist: "专辑艺人", year: 1999, genre: "Jazz" });
    // 歌曲自己的 genre 优先于专辑的
    expect(out[1].genre).toBe("Rock");
    expect(out[1].albumArtist).toBe("专辑艺人");
  });

  it("专辑行缺失时:albumArtist 回落歌曲 artist、year/genre 为 undefined(不崩)", () => {
    seedSong("s1", { albumId: "al-missing", artist: "独唱" });
    const out = songsToQueueItems(readSongs("s1"));
    expect(out[0].albumArtist).toBe("独唱");
    expect(out[0].year).toBeUndefined();
    expect(out[0].genre).toBeUndefined();
  });

  it("0 / 空串一律归一成 undefined:track、discNumber、duration、title", () => {
    seedSong("s1", { title: "", track: 0, discNumber: 0, duration: 0 });
    const out = songsToQueueItems(readSongs("s1"));
    expect(out[0].title).toBe("未知");
    expect(out[0].track).toBeUndefined();
    expect(out[0].discNumber).toBeUndefined();
    // duration=0 是数字,故保留 0(库里的 0 表示未知只有「非数字」才算未知)
    expect(out[0].duration).toBe(0);
  });

  it("duration 非数字(NaN/NULL)→ undefined", () => {
    seedSong("s1", { duration: null });
    expect(songsToQueueItems(readSongs("s1"))[0].duration).toBeUndefined();
  });

  it("mime 由 suffix 推导;artist/album 空串 → undefined", () => {
    seedSong("s1", { suffix: "flac", artist: "", album: "" });
    const out = songsToQueueItems(readSongs("s1"));
    expect(out[0].mime).toBe("audio/flac");
    expect(out[0].artist).toBeUndefined();
    expect(out[0].album).toBeUndefined();
  });

  it("多首歌复用同一专辑行:albumIds 去重(一次 IN 查询)", () => {
    seedAlbum("al1", { artistId: "ar1", artist: "同一个" });
    seedSong("s1", { albumId: "al1" });
    seedSong("s2", { albumId: "al1" });
    const out = songsToQueueItems(readSongs("s1", "s2"));
    expect(out.map((o) => o.albumArtist)).toEqual(["同一个", "同一个"]);
  });
});

describe("resolveContentSongs('song'):单曲 + 同曲多源组主源选择", () => {
  it("歌曲不存在 → null", async () => {
    await expect(resolveContentSongs("song", "ghost")).resolves.toBeNull();
  });

  it("无 groupId → 原行返回,name 为空时回落『未知』", async () => {
    seedSong("s1", { title: "" });
    const r = await resolveContentSongs("song", "s1");
    expect(r!.rows.map((x) => x.id)).toEqual(["s1"]);
    expect(r!.name).toBe("未知");
    expect(h.probeOk).not.toHaveBeenCalled();
  });

  it("组内只有 1 个成员 → 不走主源排序(直接原行)", async () => {
    seedSong("s1", { groupId: "g1" });
    const r = await resolveContentSongs("song", "s1");
    expect(r!.rows.map((x) => x.id)).toEqual(["s1"]);
    expect(h.probeOk).not.toHaveBeenCalled();
  });

  it("组内多成员 → 主源 = local(核心曲库优先),返回单行", async () => {
    seedSong("w1", { groupId: "g1", type: "web" });
    seedSong("v1", { groupId: "g1", type: "webdav", title: "b" });
    seedSong("l1", { groupId: "g1", type: "local", title: "c" });
    const r = await resolveContentSongs("song", "w1");
    expect(r!.rows.map((x) => x.id)).toEqual(["l1"]);
    expect(r!.name).toBe("c");
  });

  it("同类型按标题排序:两个 local 成员取标题更小的那个", async () => {
    seedSong("l-b", { groupId: "g1", type: "local", title: "B 曲" });
    seedSong("l-a", { groupId: "g1", type: "local", title: "A 曲" });
    const r = await resolveContentSongs("song", "l-b");
    expect(r!.rows[0].id).toBe("l-a");
  });

  it("主源 local 探测失败 + 回退开关开 + 组内有 web → 返回 web 备选(保证可播)", async () => {
    seedSong("l1", { groupId: "g1", type: "local", title: "本地" });
    seedSong("w1", { groupId: "g1", type: "web", title: "线上" });
    h.probeOk.mockImplementation(async (song: any) => song.type !== "local");
    const r = await resolveContentSongs("song", "w1");
    expect(r!.rows.map((x) => x.id)).toEqual(["w1"]);
    expect(r!.name).toBe("线上");
    expect(h.logs.info.some(([m]) => m === "播放回退:核心曲库源不可用,切组内 web 源")).toBe(true);
  });

  it("主源 local 探测失败但回退开关关 → 仍返回 local(按原源播放)", async () => {
    seedSong("l1", { groupId: "g1", type: "local" });
    seedSong("w1", { groupId: "g1", type: "web" });
    h.probeOk.mockImplementation(async () => false);
    h.fallbackToWeb = false;
    const r = await resolveContentSongs("song", "w1");
    expect(r!.rows.map((x) => x.id)).toEqual(["l1"]);
    expect(h.logs.info).toEqual([]);
  });

  it("主源 local 探测失败 + 组内没有 web 备选 → 返回 local(不返回空)", async () => {
    seedSong("l1", { groupId: "g1", type: "local" });
    seedSong("l2", { groupId: "g1", type: "webdav" });
    h.probeOk.mockImplementation(async () => false);
    const r = await resolveContentSongs("song", "l1");
    expect(r!.rows.map((x) => x.id)).toEqual(["l1"]);
  });

  it("主源 local 探测成功 → 返回 local,不查 web 备选", async () => {
    seedSong("l1", { groupId: "g1", type: "local" });
    seedSong("w1", { groupId: "g1", type: "web" });
    const r = await resolveContentSongs("song", "w1");
    expect(r!.rows.map((x) => x.id)).toEqual(["l1"]);
    expect(h.logs.info).toEqual([]);
  });

  it("整组都是 web(主源即 web)→ 不进回退分支,返回排序后主行", async () => {
    seedSong("w1", { groupId: "g1", type: "web", title: "B" });
    seedSong("w2", { groupId: "g1", type: "web", title: "A" });
    h.probeOk.mockImplementation(async () => false);
    const r = await resolveContentSongs("song", "w1");
    expect(r!.rows.map((x) => x.id)).toEqual(["w2"]);
    expect(h.probeOk).not.toHaveBeenCalled();
  });

  it("优选子开关关闭 → 不排序也不探测,原行返回", async () => {
    seedSong("l1", { groupId: "g1", type: "local" });
    seedSong("w1", { groupId: "g1", type: "web" });
    h.preferLocal = false;
    const r = await resolveContentSongs("song", "w1");
    expect(r!.rows.map((x) => x.id)).toEqual(["w1"]);
    expect(h.probeOk).not.toHaveBeenCalled();
  });

  it("插件总开关关闭 → 原行返回(行为与插件化前一致)", async () => {
    seedSong("l1", { groupId: "g1", type: "local" });
    seedSong("w1", { groupId: "g1", type: "web" });
    h.active = false;
    const r = await resolveContentSongs("song", "w1");
    expect(r!.rows.map((x) => x.id)).toEqual(["w1"]);
  });
});

describe("resolveContentSongs('playlist'):批量取行 + 可播过滤", () => {
  it("歌单不存在 → null", async () => {
    await expect(resolveContentSongs("playlist", "ghost")).resolves.toBeNull();
  });

  it("按 position 取行,不可播与空 song_id 条目被剔除;name 用歌单名", async () => {
    seedSong("s1");
    seedSong("s2");
    seedSong("s3");
    seedPlaylist("pl1", "我的歌单");
    addPlaylistEntry("pl1", "s3", 2);
    addPlaylistEntry("pl1", "s1", 0);
    addPlaylistEntry("pl1", "s2", 1, 0); // playable=0 → 剔除
    addPlaylistEntry("pl1", null, 3); // song_id 为空 → 剔除
    const r = await resolveContentSongs("playlist", "pl1");
    expect(r!.rows.map((x) => x.id)).toEqual(["s1", "s3"]);
    expect(r!.name).toBe("我的歌单");
  });

  it("全部条目都不可播 → rows 为空数组(不抛,也不回 null)", async () => {
    seedPlaylist("pl2");
    addPlaylistEntry("pl2", null, 0);
    const r = await resolveContentSongs("playlist", "pl2");
    expect(r).not.toBeNull();
    expect(r!.rows).toEqual([]);
    expect(r!.name).toBe("歌单-pl2");
  });

  it("悬空 song_id 在库层面插不进去(playlist_songs.song_id 有外键)", async () => {
    // 现状记录:正常库状态下「条目指向不存在的歌」不可能存在 —— 这是 DB 不变量,
    // 不是应用层校验。下方那条用例才覆盖代码里的防御性 filter(Boolean)。
    seedSong("s1");
    seedPlaylist("pl3");
    addPlaylistEntry("pl3", "s1", 0);
    expect(() => addPlaylistEntry("pl3", "gone", 1)).toThrow(/FOREIGN KEY/);
    const r = await resolveContentSongs("playlist", "pl3");
    expect(r!.rows.map((x) => x.id)).toEqual(["s1"]);
  });

  it("外键被绕过(song 行被硬删)→ 悬空条目静默过滤,不外泄占位项", async () => {
    seedSong("s1");
    seedPlaylist("pl3");
    addPlaylistEntry("pl3", "s1", 0);
    addPlaylistEntry("pl3", "s1", 1);
    sqlite.pragma("foreign_keys = OFF");
    try {
      sqlite.prepare("DELETE FROM songs WHERE id = ?").run("s1");
    } finally {
      sqlite.pragma("foreign_keys = ON");
    }
    const r = await resolveContentSongs("playlist", "pl3");
    expect(r!.rows).toEqual([]);
    expect(r!.name).toBe("歌单-pl3");
  });
});

describe("resolveContentSongs('album' / 'artist' / 'genre')", () => {
  it("专辑不存在 → null;存在 → 返回该专辑歌曲", async () => {
    await expect(resolveContentSongs("album", "ghost")).resolves.toBeNull();
    seedAlbum("al1", { name: "甲" });
    seedSong("s1", { albumId: "al1", discNumber: 1, track: 2 });
    seedSong("s2", { albumId: "al1", discNumber: 1, track: 1 });
    const r = await resolveContentSongs("album", "al1");
    expect(r!.rows.map((x) => x.id)).toEqual(["s2", "s1"]);
    expect(r!.name).toBe("甲");
  });

  it("艺人不存在 → null", async () => {
    await expect(resolveContentSongs("artist", "ghost")).resolves.toBeNull();
  });

  it("艺人有专辑 → 取「本人署名的歌」∪「其专辑下的歌」两路并集", async () => {
    seedArtist("ar1", "艺人甲");
    seedAlbum("alA", { artistId: "ar1" });
    seedSong("own", { artistId: "ar1" }); // 只挂在艺人上
    seedSong("inAlbum", { albumId: "alA", artist: "别人" }); // 只挂在专辑上
    // 无关歌曲:不应出现
    seedArtist("ar2");
    seedSong("other", { artistId: "ar2" });
    const r = await resolveContentSongs("artist", "ar1");
    expect(r!.rows.map((x) => x.id).sort()).toEqual(["inAlbum", "own"]);
    expect(r!.name).toBe("艺人甲");
  });

  it("艺人名下没有专辑 → 单路按 artistId 查(不拼 inArray 分支)", async () => {
    seedArtist("ar3", "无专辑艺人");
    seedSong("s1", { artistId: "ar3" });
    const r = await resolveContentSongs("artist", "ar3");
    expect(r!.rows.map((x) => x.id)).toEqual(["s1"]);
    expect(r!.name).toBe("无专辑艺人");
  });

  it("流派不存在 → null;存在 → 按流派名匹配歌曲", async () => {
    await expect(resolveContentSongs("genre", "ghost")).resolves.toBeNull();
    sqlite.prepare("INSERT INTO genres (id, name, song_count, created_at, updated_at) VALUES (?,?,?,?,?)").run("ge1", "Jazz", 1, iso(), iso());
    seedSong("s1", { genre: "Jazz" });
    seedSong("s2", { genre: "Rock" });
    const r = await resolveContentSongs("genre", "ge1");
    expect(r!.rows.map((x) => x.id)).toEqual(["s1"]);
    expect(r!.name).toBe("Jazz");
  });

  it("未知类型 → null(调用方据此回 404)", async () => {
    await expect(resolveContentSongs("podcast", "x")).resolves.toBeNull();
  });
});
