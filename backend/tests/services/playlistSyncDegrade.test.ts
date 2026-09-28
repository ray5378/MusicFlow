// ==================== playlistSync:条目降级 / 重复曲目 / 空歌单导出 ====================
//
// 既有 tests/services/playlistSyncService.test.ts 把「首次重建 / 增量复用 / 同步锁 /
// 冷却 / 封面 / 分块」照得比较全。本文件补它没覆盖的**降级方向**与**导出边角**:
//
//   ① 已匹配(可播)的条目在曲库里消失后,再同步必须降级成占位并写 unavailable_reason
//      —— 反过来(stub → 可播)那边既有测试有,正方向没有。留着指向不存在的 song_id
//      会让播放端投一首空气,而且不会有任何自动匹配再去救它;
//   ② 远程列表里出现重复曲目时,rebuild 会怎么处理(现状记录);
//   ③ exportPlaylistEntries 对空歌单的返回形状(导出后要能被自己重新导入)。
//
// 只替换远程抓取 / 封面文件 / 后台匹配 / 批量节流四个副作用面;曲库索引、匹配键、
// 计数刷新全部走真实实现。
// MUST be the first import:把 DATA_DIR 指到本文件专属的隔离目录。
import "../plugins/_env.js";

import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";

type Any = any;

const f = vi.hoisted(() => ({
  importPlaylistFromUrl: vi.fn(),
  cacheRemoteCover: vi.fn(),
  matchPlaylistInBackground: vi.fn(),
  sleepBetweenBatch: vi.fn(),
}));

vi.mock("../../src/services/plugin/playlistImport.js", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, importPlaylistFromUrl: f.importPlaylistFromUrl };
});

vi.mock("../../src/services/playlistCover.js", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, cacheRemoteCover: f.cacheRemoteCover, clearPlaylistCoverCache: vi.fn() };
});

vi.mock("../../src/services/plugin/shared.js", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, matchPlaylistInBackground: f.matchPlaylistInBackground };
});

vi.mock("../../src/services/plugin/batchPacer.js", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, sleepBetweenBatch: f.sleepBetweenBatch };
});

import { sqlite, db, initDatabase } from "../../src/db/index.js";
import { songs, playlists } from "../../src/db/schema.js";
import { clearLibraryIndex } from "../../src/services/plugin/libraryIndex.js";
import { rebuildPlaylistEntries, exportPlaylistEntries } from "../../src/services/plugin/playlistSync.js";

let adminId = "";

function seedSong(id: string, over: Any = {}) {
  db.insert(songs)
    .values({ id, title: `曲目${id}`, artist: "歌手", path: `l:t:/music/${id}.mp3`, suffix: "mp3", duration: 200, ...over })
    .run();
}

function seedPlaylist(id: string, over: Any = {}) {
  db.insert(playlists).values({ id, name: `歌单${id}`, ownerId: adminId, isPublic: 1, ...over }).run();
}

function entries(playlistId: string) {
  return sqlite
    .prepare("SELECT id, song_id, position, playable, external_title, unavailable_reason FROM playlist_songs WHERE playlist_id = ? ORDER BY position")
    .all(playlistId) as Any[];
}

/** 临时关掉外键:要造一条「指向已被删掉的歌曲」的条目(上一轮同步的产物)。
 *  曲库索引只收可播曲目,所以歌没了就等价于匹配不到 —— 这正是要验证的降级场景。 */
function withFkOff<T>(fn: () => T): T {
  sqlite.pragma("foreign_keys = OFF");
  try { return fn(); } finally { sqlite.pragma("foreign_keys = ON"); }
}

/** 直接铺一条「已匹配」的历史条目(上一轮同步的产物)。 */
function seedMatchedEntry(playlistId: string, songId: string, position: number) {
  withFkOff(() => {
    sqlite.prepare(
      "INSERT INTO playlist_songs (playlist_id, song_id, position, playable, external_song_id, external_title, external_artist, created_at) VALUES (?,?,?,1,?,?,?,?)",
    ).run(playlistId, songId, position, `e-${songId}`, `曲目${songId}`, "歌手", new Date().toISOString());
  });
}

beforeAll(() => {
  if (!process.env.APP_VERSION) process.env.APP_VERSION = "1.0.0";
  initDatabase();
  adminId = (sqlite.prepare("SELECT id FROM users WHERE is_admin = 1 LIMIT 1").get() as Any)?.id || "";
  if (!adminId) {
    sqlite.prepare("INSERT OR IGNORE INTO users (id, username, password, salt, subsonic_salt, is_admin, is_active, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?)")
      .run("u-admin", "admin", "", "s", "s", 1, 1, new Date().toISOString(), new Date().toISOString());
    adminId = "u-admin";
  }
});

beforeEach(() => {
  vi.resetAllMocks();
  clearLibraryIndex();
  for (const t of ["playlist_songs", "wishes", "playlists", "songs"]) {
    sqlite.prepare(`DELETE FROM ${t}`).run();
  }
  f.cacheRemoteCover.mockImplementation(async () => null);
  f.matchPlaylistInBackground.mockImplementation(async () => {});
  f.sleepBetweenBatch.mockImplementation(async () => {});
});

// ==================== 降级:可播 → 占位 ====================

describe("rebuildPlaylistEntries —— 已匹配条目的复用边界", () => {
  it("位置变化时就地更新同一行(不重建行,客户端的关联不断)", async () => {
    seedPlaylist("pl-1");
    seedSong("s1");
    seedSong("s2");
    seedMatchedEntry("pl-1", "s1", 0);
    const before = entries("pl-1")[0];

    await rebuildPlaylistEntries("pl-1", {
      name: "远程歌单", platform: "netease",
      tracks: [
        { externalId: "e2", title: "曲目s2", artist: "歌手" },
        { externalId: "e-s1", title: "曲目s1", artist: "歌手" },
      ],
    }, { userId: adminId, autoWish: false });

    const rows = entries("pl-1");
    const reused = rows.find((r) => r.id === before.id)!;
    expect(reused).toBeTruthy();
    expect(reused.position).toBe(1);
    expect(reused.song_id).toBe("s1");
  });

  it("现状记录(缺陷台账):已匹配条目不做二次匹配 —— 曲库里歌没了仍标可播", async () => {
    // rebuildPlaylistEntries 对「上一轮已匹配」的行直接复用(prev.songId 存在即 return),
    // 不再查曲库。于是本地文件被删 / 移走后,该条目依旧 playable=1、song_id 悬空:
    //  · 计数把它算进 song_count,UI 显示可播;
    //  · 它已经有 song_id,后台自动匹配也不会再来救它 ⇒ 永久悬空。
    // 这是「避免整表重匹配」的性能取舍,代价在这条路径上。钉住现状,便于修后反转。
    seedPlaylist("pl-1");
    seedMatchedEntry("pl-1", "gone", 0); // 曲库里**没有** "gone"
    seedSong("s1");

    const r = await rebuildPlaylistEntries("pl-1", {
      name: "远程歌单", platform: "netease",
      tracks: [{ externalId: "e-gone", title: "曲目gone", artist: "歌手" }],
    }, { userId: adminId, autoWish: false });

    const rows = entries("pl-1");
    expect(rows).toHaveLength(1);
    expect(rows[0].song_id).toBe("gone");
    expect(rows[0].playable).toBe(1);
    expect(r.matched).toBe(1);
    expect(r.unmatched).toBe(0);
  });

  it("现状记录:platform 曲目 id 没变时,即使远程标题改了也沿用原匹配", async () => {
    // 曲目身份以 externalId 为准,标题只是元数据 —— 平台改标题不该把已匹配的本地方
    // 换成另一首(否则用户收藏/缓存的关联会漂)。故沿用原 song_id 是有意的。
    seedPlaylist("pl-1");
    seedSong("s1");
    seedMatchedEntry("pl-1", "s1", 0);

    await rebuildPlaylistEntries("pl-1", {
      name: "远程歌单", platform: "netease",
      tracks: [{ externalId: "e-s1", title: "改了标题的另一首", artist: "别人" }],
    }, { userId: adminId, autoWish: false });

    const rows = entries("pl-1");
    expect(rows).toHaveLength(1);
    expect(rows[0].song_id).toBe("s1");
    expect(rows[0].playable).toBe(1);
  });
});

// ==================== 远程列表里的重复曲目 ====================

describe("rebuildPlaylistEntries —— 远程列表自带重复曲目", () => {
  it("现状记录:同一首重复出现会被原样建成两行(不会批内去重)", async () => {
    seedPlaylist("pl-2");
    seedSong("s1");

    const r = await rebuildPlaylistEntries("pl-2", {
      name: "远程歌单", platform: "netease",
      tracks: [
        { externalId: "e1", title: "曲目s1", artist: "歌手" },
        { externalId: "e1", title: "曲目s1", artist: "歌手" },
      ],
    }, { userId: adminId, autoWish: false });

    const rows = entries("pl-2");
    // 钉住现状:批内不做去重,重复曲目会占两个位置(平台榜单确实可能带重复项)。
    // 若后续决定去重,这里应改成 rows.length === 1。
    expect(rows).toHaveLength(2);
    expect(r.matched).toBe(2);
  });
});

// ==================== 导出边角 ====================

describe("exportPlaylistEntries —— 空歌单也能被导出再导入", () => {
  it("歌单存在但一条都没有 → 返回歌单名 + 空 tracks(不抛)", () => {
    seedPlaylist("pl-3");
    const out = exportPlaylistEntries("pl-3");
    expect(out.name).toBe("歌单pl-3");
    expect(out.tracks).toEqual([]);
  });

  it("条目无外部标题且本地曲已删 → 跳过该条(不导出空标题的脏数据)", () => {
    seedPlaylist("pl-4");
    withFkOff(() => {
      sqlite.prepare("INSERT INTO playlist_songs (playlist_id, song_id, position, playable, external_title, created_at) VALUES (?,?,?,0,?,?)")
        .run("pl-4", "ghost", 0, null, new Date().toISOString());
    });
    // 曲库里没有 "ghost" → title 取不到 → 该条被跳过,导出的 JSON 里不留空标题。
    expect(exportPlaylistEntries("pl-4").tracks).toEqual([]);
  });
});
