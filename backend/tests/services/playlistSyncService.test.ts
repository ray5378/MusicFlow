// services/plugin/playlistSync.ts 服务层测试。
//
// 这是「歌单导入/同步」的核心写入路径,也是同类模块里唯一**会删行**的地方:
// 它按 trackKey 算出「上次有、这次远程列表里没有」的条目并删除(playlistSync.ts:209),
// 是 D14 那条缺陷的另一半根基 —— 所以这一层的语义必须被钉住。
//
// 只替换四个外部副作用面(远程抓取 / 封面缓存文件 / 后台匹配 / 批量让行节流),
// **曲库索引与计数刷新都走真实实现** —— 匹配(joint 归一化 key)与 song_count/duration
// 的算法本身就是契约,换成假体就测不出「匹配不到」「计数算错」这类真问题。
import "../plugins/_env.js";

import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from "vitest";

type Any = any;

const f = vi.hoisted(() => ({
  importPlaylistFromUrl: vi.fn(),
  findUrlImporter: vi.fn(),
  cacheRemoteCover: vi.fn(),
  clearPlaylistCoverCache: vi.fn(),
  matchPlaylistInBackground: vi.fn(),
  sleepBetweenBatch: vi.fn(),
}));

vi.mock("../../src/services/plugin/playlistImport.js", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, importPlaylistFromUrl: f.importPlaylistFromUrl, findUrlImporter: f.findUrlImporter };
});

vi.mock("../../src/services/playlistCover.js", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, cacheRemoteCover: f.cacheRemoteCover, clearPlaylistCoverCache: f.clearPlaylistCoverCache };
});

// 只禁掉「后台自动匹配」这一个 fire-and-forget 副作用;normalizeKey / refreshPlaylistCounts
// 保持真实 —— 匹配键与计数是本批要验证的契约。
vi.mock("../../src/services/plugin/shared.js", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, matchPlaylistInBackground: f.matchPlaylistInBackground };
});

// 批量让行节流改为立即返回,让 >300 行的分块逻辑可被快速验证(节流本身有 batchPacer.test.ts)。
vi.mock("../../src/services/plugin/batchPacer.js", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, sleepBetweenBatch: f.sleepBetweenBatch };
});

import { sqlite, db, initDatabase } from "../../src/db/index.js";
import { songs, playlists } from "../../src/db/schema.js";
import { clearLibraryIndex, getLibraryIndex, getLibraryIndexStats } from "../../src/services/plugin/libraryIndex.js";
import {
  isSyncing,
  checkImportCooldown,
  matchTrack,
  rebuildPlaylistEntries,
  syncPlaylist,
  syncAllEnabledPlaylists,
  exportPlaylistEntries,
  playlistSyncPlugin,
} from "../../src/services/plugin/playlistSync.js";

let adminId = "";

function seedUser(id: string, admin = 0) {
  sqlite
    .prepare("INSERT OR IGNORE INTO users (id, username, password, salt, subsonic_salt, is_admin) VALUES (?,?,?,?,?,?)")
    .run(id, `u_${id}`, "x", "x", "x", admin);
}

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
    .prepare("SELECT id, song_id, position, playable, external_song_id, external_title, external_artist, external_duration, unavailable_reason FROM playlist_songs WHERE playlist_id = ? ORDER BY position")
    .all(playlistId) as Any[];
}

function wishCount() {
  return (sqlite.prepare("SELECT COUNT(*) AS n FROM wishes").get() as Any).n as number;
}

function plRow(id: string) {
  return sqlite.prepare("SELECT * FROM playlists WHERE id = ?").get(id) as Any;
}

function track(over: Any = {}) {
  return { externalId: "e1", title: "曲目s1", artist: "歌手", ...over };
}

function imported(tracks: Any[], over: Any = {}) {
  return { name: "远程歌单", platform: "netease", tracks, ...over } as Any;
}

beforeAll(() => {
  if (!process.env.APP_VERSION) process.env.APP_VERSION = "1.0.0";
  initDatabase();
  adminId = (sqlite.prepare("SELECT id FROM users WHERE is_admin = 1 LIMIT 1").get() as Any)?.id || "";
  if (!adminId) { seedUser("u-admin", 1); adminId = "u-admin"; }
});

beforeEach(() => {
  vi.resetAllMocks();
  vi.useRealTimers();
  clearLibraryIndex();
  for (const t of ["playlist_songs", "wishes", "playlists", "songs", "user_favorite_songs", "recommend_pool"]) {
    sqlite.prepare(`DELETE FROM ${t}`).run();
  }
  f.importPlaylistFromUrl.mockImplementation(async () => ({ name: "远程歌单", platform: "netease", tracks: [] }));
  f.findUrlImporter.mockReturnValue(undefined);
  f.cacheRemoteCover.mockImplementation(async () => null);
  f.matchPlaylistInBackground.mockImplementation(async () => {});
  f.sleepBetweenBatch.mockImplementation(async () => {});
});

afterEach(() => {
  vi.useRealTimers();
});

// ==================== 冷却 / 锁 ====================

describe("checkImportCooldown — 同一用户+同一链接 10s 内只放行一次", () => {
  it("首次放行,窗口内第二次拒绝,超过 10s 再次放行", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-27T00:00:00.000Z"));
    expect(checkImportCooldown("u1", "https://x/pl")).toBe(false);
    expect(checkImportCooldown("u1", "https://x/pl")).toBe(true);
    vi.setSystemTime(new Date("2026-09-27T00:00:10.001Z"));
    expect(checkImportCooldown("u1", "https://x/pl")).toBe(false);
  });

  it("按用户+链接分别计数,互不影响", () => {
    // 冷却表是模块级 Map,且没有对外重置入口 —— 每个用例必须用独立 key,
    // 否则会被前一个用例写入的记录挡住(表现为"首次就返回 true")。
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-27T00:00:00.000Z"));
    expect(checkImportCooldown("uA", "https://sep/pl")).toBe(false);
    expect(checkImportCooldown("uB", "https://sep/pl")).toBe(false);
    expect(checkImportCooldown("uA", "https://sep/other")).toBe(false);
    expect(checkImportCooldown("uA", "https://sep/pl")).toBe(true);
  });

  it("表超过 500 条时整体清空(防止无界增长)", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-27T00:00:00.000Z"));
    for (let i = 0; i < 501; i++) checkImportCooldown("u1", `https://x/p${i}`);
    // 清空后先前的记录已丢失 → 同一 key 立刻可再次放行
    expect(checkImportCooldown("u1", "https://x/p0")).toBe(false);
  });
});

describe("isSyncing — 同步锁的对外可见性", () => {
  it("未同步为 false;同步进行中为 true,结束后回到 false", async () => {
    seedPlaylist("pl-lock", { sourceUrl: "https://claimed/pl", sourcePlatform: "netease" });
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => { release = r; });
    f.importPlaylistFromUrl.mockImplementation(() => gate.then(() => imported([])));

    expect(isSyncing("pl-lock")).toBe(false);
    const p = syncPlaylist("pl-lock");
    expect(isSyncing("pl-lock")).toBe(true);
    release();
    await p;
    expect(isSyncing("pl-lock")).toBe(false);
  });
});

// ==================== matchTrack ====================

describe("matchTrack — 优先可播放,其次任意候选", () => {
  it("命中且首个候选可播放 → 返回该行", () => {
    const index = new Map<string, Any[]>([["abc|def", [{ id: "s1", suffix: "mp3", path: "/a.mp3" }]]]);
    expect(matchTrack({ externalId: "", title: "abc", artist: "def" }, index as Any)?.id).toBe("s1");
  });

  it("候选中存在不可播放行 → 优先挑带 suffix+path 的那行", () => {
    const index = new Map<string, Any[]>([["abc|def", [
      { id: "online", suffix: null, path: "/f.mp3" },
      { id: "local", suffix: "flac", path: "/b.flac" },
    ]]]);
    expect(matchTrack({ externalId: "", title: "abc", artist: "def" }, index as Any)?.id).toBe("local");
  });

  it("全部候选都不可播放 → 回落第一行(仍标记为已匹配)", () => {
    const index = new Map<string, Any[]>([["abc|def", [{ id: "online", suffix: null, path: "/f.mp3" }]]]);
    expect(matchTrack({ externalId: "", title: "abc", artist: "def" }, index as Any)?.id).toBe("online");
  });

  it("索引里没有 → null", () => {
    expect(matchTrack({ externalId: "", title: "nope", artist: "x" }, new Map() as Any)).toBe(null);
  });
});

// ==================== rebuildPlaylistEntries ====================

describe("rebuildPlaylistEntries — 首次重建", () => {
  it("可匹配 → 可播条目;不可匹配 → 占位条目 + 待补 wish;计数与时长刷新", async () => {
    seedSong("s1", { title: "曲目s1", artist: "歌手", duration: 200 });
    seedPlaylist("pl-1");

    const r = await rebuildPlaylistEntries("pl-1", imported([
      track({ externalId: "e1", title: "曲目s1", artist: "歌手" }),
      track({ externalId: "e2", title: "没这首歌", artist: "歌手", duration: 180000 }),
    ]), { userId: adminId, autoWish: true, notes: "来自今日推荐组合" });

    expect(r).toEqual({ total: 2, matched: 1, unmatched: 1, wishAdded: 1, platform: "netease" });

    const rows = entries("pl-1");
    expect(rows.length).toBe(2);
    expect(rows[0]).toMatchObject({ song_id: "s1", position: 0, playable: 1, external_song_id: "e1", unavailable_reason: null });
    expect(rows[1]).toMatchObject({ song_id: null, position: 1, playable: 0, external_song_id: "e2", external_title: "没这首歌", unavailable_reason: "曲库中未找到" });

    // 计数:可播 1 首(200s)+ 外部条目 1 首(180s)
    expect(plRow("pl-1").song_count).toBe(2);
    expect(plRow("pl-1").duration).toBe(380);
    const w = sqlite.prepare("SELECT * FROM wishes").get() as Any;
    expect(w.song_title).toBe("没这首歌");
    expect(w.status).toBe("pending");
    expect(w.user_id).toBe(adminId);
    expect(w.notes).toBe("来自今日推荐组合");
  });

  it("autoWish=false → 不写 wish", async () => {
    seedPlaylist("pl-1");
    const r = await rebuildPlaylistEntries("pl-1", imported([track({ externalId: "e9", title: "没有的", artist: "A" })]), { userId: adminId, autoWish: false });
    expect(r.unmatched).toBe(1);
    expect(wishCount()).toBe(0);
  });

  it("remote 条目缺 externalId → 用归一化 title|artist 做键(不依赖平台 id)", async () => {
    seedSong("s1", { title: "曲目S1", artist: "歌手", duration: 100 });
    seedPlaylist("pl-1");
    // 归一化会去掉空白/大小写/连字符,故 "曲目-S1" 与 "曲目S1" 视为同一首
    const r = await rebuildPlaylistEntries("pl-1", imported([{ externalId: "", title: "曲目 - S1", artist: "歌手" }]), { userId: adminId });
    expect(r.matched).toBe(1);
    expect(entries("pl-1")[0].song_id).toBe("s1");
  });

  it("已是 stub 且仍然匹配不上 → 不放后台自动匹配(newUnmatched 才算新)", async () => {
    seedPlaylist("pl-1");
    const t = [track({ externalId: "e9", title: "没有的", artist: "A" })];
    await rebuildPlaylistEntries("pl-1", imported(t), { userId: adminId });
    expect(f.matchPlaylistInBackground).toHaveBeenCalledTimes(1);

    await rebuildPlaylistEntries("pl-1", imported(t), { userId: adminId });
    // 第二次仍是同一 stub,未新增 → 不再触发
    expect(f.matchPlaylistInBackground).toHaveBeenCalledTimes(1);
  });

  it("后台自动匹配失败 → 只记日志,不把重建结果判成失败", async () => {
    seedPlaylist("pl-1");
    f.matchPlaylistInBackground.mockRejectedValue(new Error("匹配服务不可达"));
    const r = await rebuildPlaylistEntries("pl-1", imported([track({ externalId: "e1", title: "没有的", artist: "A" })]), { userId: adminId });
    expect(r.unmatched).toBe(1);
    // fire-and-forget 的 catch 在下一个宏任务里执行,给它一次机会跑完(覆盖日志分支)
    await new Promise((done) => setTimeout(done, 0));
    expect(f.matchPlaylistInBackground).toHaveBeenCalledTimes(1);
  });

  it("wish 批量去重:批内同曲只建一条;已有 pending 的不重复建", async () => {
    seedPlaylist("pl-1");
    // 两条 externalId 不同(故是两个条目),但 title|artist 相同 → wish 只应有一条
    await rebuildPlaylistEntries("pl-1", imported([
      track({ externalId: "a", title: "同一首", artist: "A" }),
      track({ externalId: "b", title: "同一首", artist: "A" }),
    ]), { userId: adminId, notes: "n1" });
    expect(wishCount()).toBe(1);

    // 换一个歌单再导入同一首 → 已有 pending,不重复建
    seedPlaylist("pl-2");
    await rebuildPlaylistEntries("pl-2", imported([track({ externalId: "c", title: "同一首", artist: "A" })]), { userId: adminId });
    expect(wishCount()).toBe(1);
  });
});

describe("rebuildPlaylistEntries — 增量(再同步同一歌单)", () => {
  it("未变化的再同步 → 条目行原样复用(行 id 不变),也不重复补 wish", async () => {
    seedSong("s1", { title: "曲目s1", artist: "歌手" });
    seedPlaylist("pl-1");
    const t = [track({ externalId: "e1", title: "曲目s1", artist: "歌手" }), track({ externalId: "e2", title: "没有的", artist: "A" })];

    await rebuildPlaylistEntries("pl-1", imported(t), { userId: adminId });
    const before = entries("pl-1");

    const r = await rebuildPlaylistEntries("pl-1", imported(t), { userId: adminId });
    const after = entries("pl-1");
    expect(r.matched).toBe(1);
    expect(r.unmatched).toBe(1);
    expect(after.map((x) => x.id)).toEqual(before.map((x) => x.id));
    expect(after).toEqual(before);
    expect(wishCount()).toBe(1);
    expect(plRow("pl-1").song_count).toBe(2);
  });

  it("顺序变化 → 就地更新 position(不删不重建行)", async () => {
    seedSong("s1", { title: "曲目s1", artist: "歌手" });
    seedSong("s2", { title: "曲目s2", artist: "歌手" });
    seedPlaylist("pl-1");
    await rebuildPlaylistEntries("pl-1", imported([
      track({ externalId: "e1", title: "曲目s1", artist: "歌手" }),
      track({ externalId: "e2", title: "曲目s2", artist: "歌手" }),
    ]), { userId: adminId });
    const before = entries("pl-1");

    await rebuildPlaylistEntries("pl-1", imported([
      track({ externalId: "e2", title: "曲目s2", artist: "歌手" }),
      track({ externalId: "e1", title: "曲目s1", artist: "歌手" }),
    ]), { userId: adminId });

    const after = entries("pl-1");
    expect(after.map((x) => x.external_song_id)).toEqual(["e2", "e1"]);
    expect(after.map((x) => x.song_id)).toEqual(["s2", "s1"]);
    // 行本身还是原来那两行
    expect(after.map((x) => x.id).sort()).toEqual(before.map((x) => x.id).sort());
  });

  it("远程列表里已消失的条目被删除(清旧条目的唯一路径)", async () => {
    seedSong("s1", { title: "曲目s1", artist: "歌手" });
    seedSong("s2", { title: "曲目s2", artist: "歌手" });
    seedPlaylist("pl-1");
    await rebuildPlaylistEntries("pl-1", imported([
      track({ externalId: "e1", title: "曲目s1", artist: "歌手" }),
      track({ externalId: "e2", title: "曲目s2", artist: "歌手" }),
    ]), { userId: adminId });
    expect(entries("pl-1").length).toBe(2);

    await rebuildPlaylistEntries("pl-1", imported([track({ externalId: "e1", title: "曲目s1", artist: "歌手" })]), { userId: adminId });

    const after = entries("pl-1");
    expect(after.length).toBe(1);
    expect(after[0].external_song_id).toBe("e1");
    expect(plRow("pl-1").song_count).toBe(1);
  });

  it("stub → 曲库补齐后自动转为可播(原来那行被更新而不是新增)", async () => {
    seedPlaylist("pl-1");
    const t = [track({ externalId: "e1", title: "曲目s1", artist: "歌手" })];
    await rebuildPlaylistEntries("pl-1", imported(t), { userId: adminId });
    expect(entries("pl-1")[0].playable).toBe(0);

    // 曲库此时才有这首歌;索引已被清空重建
    seedSong("s1", { title: "曲目s1", artist: "歌手", duration: 150 });
    clearLibraryIndex();
    const before = entries("pl-1")[0].id;

    const r = await rebuildPlaylistEntries("pl-1", imported(t), { userId: adminId });
    expect(r.matched).toBe(1);
    expect(r.unmatched).toBe(0);
    const after = entries("pl-1");
    expect(after.length).toBe(1);
    expect(after[0].id).toBe(before);
    expect(after[0].song_id).toBe("s1");
    expect(after[0].playable).toBe(1);
    // 现状记录(缺陷台账 D15):rebuild 只对「非空 unavailable_reason」的行单独 CASE 写回,
    // 已匹配行不带该列 → 保留原来的 "曲库中未找到"。而同族的自动匹配路径
    // (services/source/online/match.ts:100)在挂上 song_id 时会把该列显式置 NULL。
    // 该残留值目前不会漏给客户端(路由只在 !(playable && songId) 的分支里读它,
    // routes/api/playlists.ts:416),所以是潜伏的不一致;修复后本断言应改为 null。
    expect(after[0].unavailable_reason).toBe("曲库中未找到");
    expect(plRow("pl-1").song_count).toBe(1);
    expect(plRow("pl-1").duration).toBe(150);
  });

  it("大列表分块写入(>300 条插入 + >50 条更新都走分块路径)", async () => {
    seedPlaylist("pl-1");
    const many = Array.from({ length: 305 }, (_, i) => track({ externalId: `e${i}`, title: `曲目${i}`, artist: "A" }));

    const first = await rebuildPlaylistEntries("pl-1", imported(many), { userId: adminId });
    expect(first.unmatched).toBe(305);
    expect(entries("pl-1").length).toBe(305);

    // 反序再次导入 → 305 条 position 变化 → 公共列 CASE 分块(50/块)
    await rebuildPlaylistEntries("pl-1", imported([...many].reverse()), { userId: adminId });
    const after = entries("pl-1");
    expect(after.length).toBe(305);
    expect(after[0].external_song_id).toBe("e304");
    expect(after[304].external_song_id).toBe("e0");
    // 分块之间调用过让行(节流被 mock,只断言调用发生)
    expect(f.sleepBetweenBatch.mock.calls.length).toBeGreaterThan(0);
  });
});

// ==================== syncPlaylist ====================

describe("syncPlaylist", () => {
  it("歌单不存在 → 报错", async () => {
    await expect(syncPlaylist("nope")).rejects.toThrow("歌单不存在");
  });

  it("非导入歌单(无 sourceUrl / sourcePlatform)→ 报错", async () => {
    seedPlaylist("pl-local");
    await expect(syncPlaylist("pl-local")).rejects.toThrow("该歌单不是导入歌单,无法同步");
    seedPlaylist("pl-half", { sourceUrl: "https://claimed/x" });
    await expect(syncPlaylist("pl-half")).rejects.toThrow("该歌单不是导入歌单,无法同步");
  });

  it("并发同步同一歌单 → 第二个被拒;失败后锁被释放", async () => {
    seedPlaylist("pl-1", { sourceUrl: "https://claimed/pl", sourcePlatform: "netease", coverArt: "old" });
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => { release = r; });
    f.importPlaylistFromUrl.mockImplementation(() => gate.then(() => imported([])));

    const p = syncPlaylist("pl-1");
    await expect(syncPlaylist("pl-1")).rejects.toThrow("该歌单正在同步中,请稍候");
    release();
    await p;

    // 失败也要释放:让抓取抛错后用同一歌单再次同步能成功
    f.importPlaylistFromUrl.mockRejectedValue(new Error("502"));
    await expect(syncPlaylist("pl-1")).rejects.toThrow("502");
    f.importPlaylistFromUrl.mockImplementation(async () => imported([]));
    await expect(syncPlaylist("pl-1")).resolves.toMatchObject({ total: 0 });
  });

  it("有远程封面 → 强制重下并写回歌单;并清掉拼图缓存", async () => {
    seedPlaylist("pl-1", { sourceUrl: "https://claimed/pl", sourcePlatform: "netease", coverArt: "old" });
    f.importPlaylistFromUrl.mockImplementation(async () => imported([], { coverUrl: "https://img/c.jpg" }));
    f.cacheRemoteCover.mockImplementation(async () => "pl-pl-1.jpg");

    await syncPlaylist("pl-1");

    expect(f.cacheRemoteCover).toHaveBeenCalledWith("https://img/c.jpg", "pl-pl-1", true);
    expect(f.clearPlaylistCoverCache).toHaveBeenCalledWith("pl-1");
    expect(plRow("pl-1").cover_art).toBe("pl-pl-1.jpg");
  });

  it("封面下载失败 → 保留原封面(不清空)", async () => {
    seedPlaylist("pl-1", { sourceUrl: "https://claimed/pl", sourcePlatform: "netease", coverArt: "old" });
    f.importPlaylistFromUrl.mockImplementation(async () => imported([], { coverUrl: "https://img/c.jpg" }));
    f.cacheRemoteCover.mockImplementation(async () => null);

    await syncPlaylist("pl-1");
    expect(plRow("pl-1").cover_art).toBe("old");
  });

  it("无 remote 封面 → 不触碰封面;sourcePlatform 跟随远程平台", async () => {
    seedPlaylist("pl-1", { sourceUrl: "https://claimed/pl", sourcePlatform: "netease", coverArt: "old" });
    f.importPlaylistFromUrl.mockImplementation(async () => imported([], { platform: "qq" }));

    await syncPlaylist("pl-1");
    expect(f.cacheRemoteCover).not.toHaveBeenCalled();
    expect(plRow("pl-1").cover_art).toBe("old");
    expect(plRow("pl-1").source_platform).toBe("qq");
  });

  it("远程平台为空 → 保留原 sourcePlatform", async () => {
    seedPlaylist("pl-1", { sourceUrl: "https://claimed/pl", sourcePlatform: "netease" });
    f.importPlaylistFromUrl.mockImplementation(async () => imported([], { platform: "" }));
    await syncPlaylist("pl-1");
    expect(plRow("pl-1").source_platform).toBe("netease");
  });

  it("同步注释带上歌单名,便于在 wish 列表里溯源", async () => {
    seedPlaylist("pl-1", { name: "我的网易歌单", sourceUrl: "https://claimed/pl", sourcePlatform: "netease" });
    f.importPlaylistFromUrl.mockImplementation(async () => imported([track({ externalId: "e9", title: "没有的", artist: "A" })]));
    await syncPlaylist("pl-1", { userId: adminId });
    expect((sqlite.prepare("SELECT notes FROM wishes").get() as Any).notes).toBe("来自歌单「我的网易歌单」同步");
  });
});

// ==================== syncAllEnabledPlaylists ====================

describe("syncAllEnabledPlaylists — 定时任务整轮", () => {
  it("只同步「开了同步 + 有 sourceUrl + 有 importer 认领 + 未被锁」的歌单", async () => {
    f.findUrlImporter.mockImplementation((url: string) => (url.includes("claimed") ? { ok: true } : undefined));
    f.importPlaylistFromUrl.mockImplementation(async () => imported([]));

    seedPlaylist("pl-ok", { sourceUrl: "https://claimed/a", sourcePlatform: "netease", syncEnabled: 1 });
    seedPlaylist("pl-nosync", { sourceUrl: "https://claimed/b", sourcePlatform: "netease", syncEnabled: 0 });
    seedPlaylist("pl-nourl", { sourcePlatform: "netease", syncEnabled: 1 });
    seedPlaylist("pl-orphan", { sourceUrl: "https://nobody/c", sourcePlatform: "netease", syncEnabled: 1 });

    const r = await syncAllEnabledPlaylists();
    expect(r.synced).toBe(1);
    expect(r.results.length).toBe(1);
    expect(r.errors).toEqual([]);
    expect(f.importPlaylistFromUrl).toHaveBeenCalledTimes(1);
    expect(f.importPlaylistFromUrl).toHaveBeenCalledWith("https://claimed/a");
  });

  it("单个歌单失败 → 记入 errors,不中断整轮", async () => {
    f.findUrlImporter.mockReturnValue({ ok: true });
    f.importPlaylistFromUrl.mockImplementation(async (url: string) => {
      if (url.includes("bad")) throw new Error("上游 502");
      return imported([]);
    });
    seedPlaylist("pl-bad", { name: "坏歌单", sourceUrl: "https://claimed/bad", sourcePlatform: "netease", syncEnabled: 1 });
    seedPlaylist("pl-good", { sourceUrl: "https://claimed/good", sourcePlatform: "netease", syncEnabled: 1 });

    const r = await syncAllEnabledPlaylists();
    expect(r.synced).toBe(1);
    expect(r.errors).toEqual(["坏歌单: 上游 502"]);
  });

  it("整轮结束显式回收曲库索引缓存", async () => {
    f.findUrlImporter.mockReturnValue({ ok: true });
    f.importPlaylistFromUrl.mockImplementation(async () => imported([]));
    seedPlaylist("pl-ok", { sourceUrl: "https://claimed/a", sourcePlatform: "netease", syncEnabled: 1 });

    getLibraryIndex(); // 先让缓存建起来
    expect(getLibraryIndexStats().built).toBe(true);

    await syncAllEnabledPlaylists();
    expect(getLibraryIndexStats().built).toBe(false);
  });

  it("无同步歌单 → synced 0 / errors 空(插件口返回 null)", async () => {
    const r = await syncAllEnabledPlaylists();
    expect(r).toEqual({ synced: 0, results: [], errors: [] });
    expect(await playlistSyncPlugin.runSyncJob!()).toBe(null);
  });

  it("有成功也有失败 → 插件口返回摘要串", async () => {
    f.findUrlImporter.mockReturnValue({ ok: true });
    f.importPlaylistFromUrl.mockImplementation(async (url: string) => {
      if (url.includes("bad")) throw new Error("x");
      return imported([]);
    });
    seedPlaylist("pl-bad", { sourceUrl: "https://claimed/bad", sourcePlatform: "netease", syncEnabled: 1 });
    seedPlaylist("pl-good", { sourceUrl: "https://claimed/good", sourcePlatform: "netease", syncEnabled: 1 });

    expect(await playlistSyncPlugin.runSyncJob!()).toBe("synced 1 playlists, errors: 1");
  });
});

// ==================== exportPlaylistEntries ====================

describe("exportPlaylistEntries", () => {
  it("歌单不存在 → 报错", () => {
    expect(() => exportPlaylistEntries("nope")).toThrow("歌单不存在");
  });

  it("按 position 排序,优先导出外部平台元数据(时长按毫秒)", async () => {
    seedSong("s1", { title: "曲目s1", artist: "歌手" });
    seedPlaylist("pl-1");
    await rebuildPlaylistEntries("pl-1", imported([
      track({ externalId: "e1", title: "曲目s1", artist: "歌手", album: "专辑A", duration: 200000 }),
      track({ externalId: "e2", title: "没有的", artist: "歌手", duration: 180000 }),
    ]), { userId: adminId });

    const out = exportPlaylistEntries("pl-1");
    expect(out.name).toBe("歌单pl-1");
    expect(out.tracks).toEqual([
      { externalId: "e1", title: "曲目s1", artist: "歌手", album: "专辑A", duration: 200000 },
      { externalId: "e2", title: "没有的", artist: "歌手", album: undefined, duration: 180000 },
    ]);
  });

  it("无 external title → 回落本地歌曲字段(秒 → 毫秒)", () => {
    seedSong("s1", { title: "本地曲目", artist: "本地歌手", album: "本地专辑", duration: 123 });
    seedPlaylist("pl-1");
    // 手工造一条「只有 song_id、没有外部标题」的条目
    sqlite.prepare("INSERT INTO playlist_songs (playlist_id, song_id, position, playable) VALUES (?,?,?,1)").run("pl-1", "s1", 0);

    const out = exportPlaylistEntries("pl-1");
    expect(out.tracks).toEqual([
      { externalId: "s1", title: "本地曲目", artist: "本地歌手", album: "本地专辑", duration: 123000 },
    ]);
  });

  it("既无外部标题、又找不到本地歌曲 → 跳过该条(不导出空标题)", () => {
    seedPlaylist("pl-1");
    sqlite.prepare("INSERT INTO playlist_songs (playlist_id, song_id, position, playable) VALUES (?,?,?,1)").run("pl-1", null, 0);
    expect(exportPlaylistEntries("pl-1").tracks).toEqual([]);
  });
});

// ==================== 插件门面 ====================

describe("playlistSyncPlugin — 能力门面透传", () => {
  it("syncPlaylist / rebuildPlaylistEntries / refreshPlaylistCounts / checkImportCooldown 走同一实现", async () => {
    seedSong("s1", { title: "曲目s1", artist: "歌手" });
    seedPlaylist("pl-1", { sourceUrl: "https://claimed/pl", sourcePlatform: "netease" });
    f.importPlaylistFromUrl.mockImplementation(async () => imported([track({ externalId: "e1", title: "曲目s1", artist: "歌手" })]));

    const r = await playlistSyncPlugin.syncPlaylist!("pl-1");
    expect(r.matched).toBe(1);

    const r2 = await playlistSyncPlugin.rebuildPlaylistEntries!("pl-1", imported([track({ externalId: "e1", title: "曲目s1", artist: "歌手" })]), { userId: adminId });
    expect(r2.matched).toBe(1);

    playlistSyncPlugin.refreshPlaylistCounts!("pl-1");
    expect(plRow("pl-1").song_count).toBe(1);
    expect(exportPlaylistEntries("pl-1").tracks.length).toBe(playlistSyncPlugin.exportPlaylistEntries!("pl-1").tracks.length);

    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-27T00:00:00.000Z"));
    expect(playlistSyncPlugin.checkImportCooldown!("uZ", "https://facade/pl")).toBe(false);
    expect(playlistSyncPlugin.checkImportCooldown!("uZ", "https://facade/pl")).toBe(true);
    vi.useRealTimers();
  });
});
