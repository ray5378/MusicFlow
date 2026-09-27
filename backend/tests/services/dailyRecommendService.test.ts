// services/plugin/dailyRecommend.ts 服务层测试。
//
// 该文件 40% 行覆盖:路由层契约测试把服务整体换成了假体,所以「每日推荐」真正的
// 业务逻辑(候选榜单清洗/黑名单、用户推荐池的 rowid 过采样抽样与确定性洗牌、
// 当天幂等跳过、封面轮换、失败安全)一直没有测试照着。
//
// 这里只把四个外部副作用面替换掉(远程抓取 / 歌单重建 / 曲库索引 / 封面文件),
// 其余全部走真实 SQLite —— 抽样逻辑的正确性恰恰依赖真实的 rowid 与 SQL 过滤条件
// (playable=1、song_id IS NOT NULL、s.path IS NOT NULL),换成假体就测不到。
import "../plugins/_env.js";

import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";

type Any = any;

const f = vi.hoisted(() => ({
  importPlaylistFromUrl: vi.fn(),
  rebuildPlaylistEntries: vi.fn(),
  clearLibraryIndex: vi.fn(),
  pickDailyRotatedCover: vi.fn(),
  clearPlaylistCoverCache: vi.fn(),
  syncCoverClaim: vi.fn(),
  getPluginConfig: vi.fn(),
}));

vi.mock("../../src/services/plugin/playlistImport.js", () => ({
  importPlaylistFromUrl: f.importPlaylistFromUrl,
}));

vi.mock("../../src/services/plugin/playlistSync.js", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, rebuildPlaylistEntries: f.rebuildPlaylistEntries };
});

vi.mock("../../src/services/plugin/libraryIndex.js", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, clearLibraryIndex: f.clearLibraryIndex };
});

vi.mock("../../src/services/playlistCover.js", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    pickDailyRotatedCover: f.pickDailyRotatedCover,
    clearPlaylistCoverCache: f.clearPlaylistCoverCache,
    syncCoverClaim: f.syncCoverClaim,
  };
});

vi.mock("../../src/plugins/registry.js", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, getPluginConfig: f.getPluginConfig };
});

import { sqlite, db, initDatabase } from "../../src/db/index.js";
import { songs, playlists } from "../../src/db/schema.js";
import {
  DAILY_TAG,
  FIXED_TODAY_ID,
  DAILY_RECOMMEND_PLUGIN_ID,
  DEFAULT_HOME_COUNT,
  isCandidateBlocked,
  loadCandidates,
  saveCandidates,
  pickDailyCandidate,
  listRecommendPool,
  addToRecommendPool,
  removeFromRecommendPool,
  isInRecommendPool,
  generateDailyPlaylist,
  runDailyRecommendJob,
  dailyRecommendPlugin,
} from "../../src/services/plugin/dailyRecommend.js";

const DATE = new Date("2026-09-27T04:00:00");
const DATE_STR = "2026-09-27";

let adminId = "";

function seedUser(id: string, admin = 0) {
  sqlite
    .prepare("INSERT OR IGNORE INTO users (id, username, password, salt, subsonic_salt, is_admin) VALUES (?,?,?,?,?,?)")
    .run(id, `u_${id}`, "x", "x", "x", admin);
}

function seedSong(id: string, over: Any = {}) {
  db.insert(songs)
    .values({ id, title: `t-${id}`, path: `l:t:/music/${id}.mp3`, suffix: "mp3", duration: 120, ...over })
    .run();
}

function seedPlaylist(id: string, over: Any = {}) {
  // 注意:drizzle 的 schema 用的是驼峰属性名(ownerId/isPublic),传 snake_case 会被
  // 静默丢弃 → 直接撞 NOT NULL(owner_id)。
  db.insert(playlists).values({ id, name: `p-${id}`, ownerId: adminId, isPublic: 1, ...over }).run();
}

function addEntries(playlistId: string, rows: { songId?: string | null; playable?: number }[]) {
  const st = sqlite.prepare("INSERT INTO playlist_songs (playlist_id, song_id, position, playable) VALUES (?,?,?,?)");
  rows.forEach((r, i) => st.run(playlistId, r.songId ?? null, i, r.playable ?? 1));
}

function addFavorite(userId: string, songId: string) {
  sqlite.prepare("INSERT OR IGNORE INTO user_favorite_songs (user_id, song_id) VALUES (?,?)").run(userId, songId);
}

function addPool(sourceType: string, sourceId: string, name = "", userId = "u-pool") {
  sqlite
    .prepare("INSERT INTO recommend_pool (source_type, source_id, source_name, user_id, enabled, created_at) VALUES (?,?,?,?,?,?)")
    .run(sourceType, sourceId, name, userId, 1, new Date(Date.now() + Math.floor(Math.random() * 1000)).toISOString());
}

function todayRow() {
  return sqlite.prepare("SELECT * FROM playlists WHERE id = ?").get(FIXED_TODAY_ID) as Any;
}

function todayEntries() {
  return sqlite.prepare("SELECT song_id, position, playable FROM playlist_songs WHERE playlist_id = ? ORDER BY position").all(FIXED_TODAY_ID) as Any[];
}

function setCandidatesConfig(list: Any[]) {
  f.getPluginConfig.mockReturnValue({ candidates: list });
}

/** 让所有远程榜单抓取失败(loadCandidates 必然回落到内置清单,无法置空)。 */
function allRemoteFail() {
  f.getPluginConfig.mockReturnValue(null);
  f.importPlaylistFromUrl.mockRejectedValue(new Error("network down"));
}

beforeAll(() => {
  if (!process.env.APP_VERSION) process.env.APP_VERSION = "1.0.0";
  initDatabase();
  adminId = (sqlite.prepare("SELECT id FROM users WHERE is_admin = 1 LIMIT 1").get() as Any)?.id || "";
  if (!adminId) { seedUser("u-admin", 1); adminId = "u-admin"; }
  seedUser("u-pool");
});

beforeEach(() => {
  vi.resetAllMocks();
  for (const t of ["playlist_songs", "user_favorite_songs", "recommend_pool", "playlists", "songs", "settings"]) {
    sqlite.prepare(`DELETE FROM ${t}`).run();
  }
  // 插件配置权威来源:默认「未配置」→ loadCandidates 回落内置清单
  sqlite.prepare("DELETE FROM plugins WHERE name = ?").run(DAILY_RECOMMEND_PLUGIN_ID);
  f.getPluginConfig.mockReturnValue(null);
  // 关键:这两个假体有用例会以 mockImplementation 覆盖,而 mockResolvedValue 的
  // 优先级**高于**后设的 mockImplementation —— 起底必须同样用 mockImplementation,
  // 否则覆盖被静默忽略(表现为"假体没生效")。
  f.importPlaylistFromUrl.mockImplementation(async () => ({ name: "某榜单", tracks: [] }));
  f.rebuildPlaylistEntries.mockImplementation(async () => ({ matched: 0, unmatched: 0, wishAdded: 0 }));
  f.pickDailyRotatedCover.mockReturnValue(null);
});

// ==================== 候选榜单:黑名单 / 清洗 / 落库 ====================

describe("isCandidateBlocked — 用户点名排除的榜单", () => {
  it("按 URL 命中排除名单(QQ 巅峰榜新歌/欧美、网易云新歌榜)", () => {
    expect(isCandidateBlocked({ url: "https://y.qq.com/n/ryqq/toplist/27" })).toBe(true);
    expect(isCandidateBlocked({ url: "https://y.qq.com/n/ryqq/toplist/60" })).toBe(true);
    expect(isCandidateBlocked({ url: "https://music.163.com/playlist?id=3779629" })).toBe(true);
    // 带其它 query 参数时也要命中
    expect(isCandidateBlocked({ url: "https://music.163.com/playlist?id=3779629&userid=1" })).toBe(true);
  });

  it("按名称关键词命中(新歌/欧美)", () => {
    expect(isCandidateBlocked({ name: "网易云·新歌榜" })).toBe(true);
    expect(isCandidateBlocked({ name: "QQ音乐·巅峰榜欧美" })).toBe(true);
  });

  it("合法榜单与空字段不误伤", () => {
    expect(isCandidateBlocked({ url: "https://y.qq.com/n/ryqq/toplist/26", name: "QQ音乐·巅峰榜热歌" })).toBe(false);
    expect(isCandidateBlocked({})).toBe(false);
    expect(isCandidateBlocked({ url: "  ", name: "  " })).toBe(false);
  });
});

describe("loadCandidates — 插件配置优先,内置清单兜底", () => {
  it("未配置插件 → 回落内置清单,且内置清单本身已过黑名单", () => {
    const list = loadCandidates();
    expect(list.length).toBe(7);
    expect(list.some((c) => isCandidateBlocked(c))).toBe(false);
  });

  it("配置里混入非法项与黑名单项 → 只保留合法项并统一字段形状", () => {
    setCandidatesConfig([
      { platform: "qq", url: "  https://y.qq.com/n/ryqq/toplist/26  ", name: "热歌" },
      { platform: "", url: "https://x/y" },                       // platform 空 → 非法
      { platform: "qq", url: 123 as Any },                        // url 非字符串 → 非法
      null,                                                        // 空项 → 非法
      { platform: "netease", url: "https://music.163.com/playlist?id=3779629" }, // 黑名单
      { platform: "netease", url: "https://music.163.com/playlist?id=19723756" }, // 无 name
    ]);
    const list = loadCandidates();
    expect(list).toEqual([
      { platform: "qq", url: "https://y.qq.com/n/ryqq/toplist/26", name: "热歌" },
      { platform: "netease", url: "https://music.163.com/playlist?id=19723756", name: undefined },
    ]);
  });

  it("配置项全非法 / 全黑名单 → 视为未配置,回落内置清单", () => {
    setCandidatesConfig([{ platform: "", url: "" }]);
    expect(loadCandidates().length).toBe(7);
    setCandidatesConfig([{ platform: "qq", url: "https://y.qq.com/n/ryqq/toplist/27" }]);
    expect(loadCandidates().length).toBe(7);
  });

  it("candidates 不是数组 → 视为未配置", () => {
    f.getPluginConfig.mockReturnValue({ candidates: "oops" });
    expect(loadCandidates().length).toBe(7);
  });

  it("saveCandidates 清洗后写回插件 config,且不破坏其它配置项", () => {
    sqlite.prepare("INSERT INTO plugins (name, enabled, config) VALUES (?,?,?)")
      .run(DAILY_RECOMMEND_PLUGIN_ID, 1, JSON.stringify({ homeCount: 12, candidates: [] }));

    saveCandidates([
      { platform: "qq", url: " https://y.qq.com/n/ryqq/toplist/4 ", name: "流行指数" },
      { platform: "netease", url: "https://music.163.com/playlist?id=3779629" }, // 黑名单应被剔除
    ]);

    const cfg = JSON.parse((sqlite.prepare("SELECT config FROM plugins WHERE name = ?").get(DAILY_RECOMMEND_PLUGIN_ID) as Any).config);
    expect(cfg.homeCount).toBe(12);
    expect(cfg.candidates).toEqual([{ platform: "qq", url: "https://y.qq.com/n/ryqq/toplist/4", name: "流行指数" }]);
  });
});

describe("getDailyHomeCount — 配置损坏时的兜底", () => {
  it("插件 config 不是合法 JSON → 回落默认张数(不抛错、不影响首页)", () => {
    sqlite.prepare("INSERT INTO plugins (name, enabled, config) VALUES (?,?,?)")
      .run(DAILY_RECOMMEND_PLUGIN_ID, 1, "{ 坏掉的 JSON");
    expect(dailyRecommendPlugin.getHomeCount!()).toBe(DEFAULT_HOME_COUNT);
  });
});

describe("pickDailyCandidate — 按日确定性地轮换起始榜单", () => {
  it("同一天结果一致;跨天按 dayOfYear 位移", () => {
    const pool = loadCandidates();
    const d1 = new Date("2026-01-01T10:00:00");
    const d1again = new Date("2026-01-01T23:00:00");
    const d2 = new Date("2026-01-02T10:00:00");
    expect(pickDailyCandidate(d1)).toEqual(pool[1 % pool.length]);
    expect(pickDailyCandidate(d1again)).toEqual(pool[1 % pool.length]);
    expect(pickDailyCandidate(d2)).toEqual(pool[2 % pool.length]);
  });
});

// ==================== 用户推荐池:CRUD ====================

describe("用户推荐池 CRUD", () => {
  it("新增幂等:首次 true,重复 false(不产生第二行)", () => {
    expect(addToRecommendPool("playlist", "pl-1", "我的歌单", "u-pool")).toBe(true);
    expect(addToRecommendPool("playlist", "pl-1", "我的歌单", "u-pool")).toBe(false);
    const n = sqlite.prepare("SELECT COUNT(*) AS n FROM recommend_pool").get() as Any;
    expect(n.n).toBe(1);
  });

  it("isInRecommendPool 命中/未命中", () => {
    addToRecommendPool("favorites", "u-pool", "我喜欢的音乐", "u-pool");
    expect(isInRecommendPool("favorites", "u-pool")).toBe(true);
    expect(isInRecommendPool("favorites", "u-other")).toBe(false);
    expect(isInRecommendPool("playlist", "u-pool")).toBe(false);
  });

  it("删除返回是否真的删到;未命中返回 false", () => {
    addToRecommendPool("playlist", "pl-1", "我的歌单", "u-pool");
    expect(removeFromRecommendPool("playlist", "pl-1")).toBe(true);
    expect(removeFromRecommendPool("playlist", "pl-1")).toBe(false);
  });

  it("listRecommendPool 只返回启用项并按加入时间升序", () => {
    sqlite.prepare("INSERT INTO recommend_pool (source_type, source_id, source_name, user_id, enabled, created_at) VALUES (?,?,?,?,?,?)")
      .run("playlist", "pl-old", "", "u-pool", 1, "2026-01-01T00:00:00.000Z");
    sqlite.prepare("INSERT INTO recommend_pool (source_type, source_id, source_name, user_id, enabled, created_at) VALUES (?,?,?,?,?,?)")
      .run("playlist", "pl-off", "", "u-pool", 0, "2026-01-02T00:00:00.000Z");
    sqlite.prepare("INSERT INTO recommend_pool (source_type, source_id, source_name, user_id, enabled, created_at) VALUES (?,?,?,?,?,?)")
      .run("playlist", "pl-new", "", "u-pool", 1, "2026-01-03T00:00:00.000Z");

    expect(listRecommendPool().map((r) => r.source_id)).toEqual(["pl-old", "pl-new"]);
  });
});

// ==================== 生成:推荐池抽样 ====================

describe("generateDailyPlaylist — 仅推荐池(远程全失败)", () => {
  it("歌单成员 + 收藏成员的歌合并去重后写入固定歌单,并刷新计数与位置", async () => {
    allRemoteFail();
    for (const id of ["s1", "s2", "s3"]) seedSong(id);
    seedPlaylist("pl-pool");
    // 噪声:不可播条目 / 无 song_id 的占位条目都不应被抽中
    addEntries("pl-pool", [{ songId: "s1" }, { songId: "s2" }, { songId: "s3" }, { songId: "s3", playable: 0 }, { songId: null }]);
    for (const id of ["s1", "s2", "s3"]) addFavorite("u-pool", id);
    addPool("playlist", "pl-pool", "我的歌单");
    addPool("favorites", "u-pool", "我喜欢的音乐");

    const r = await generateDailyPlaylist(DATE);

    expect(r.skipped).toBe(false);
    expect(r.poolSongsAdded).toBe(3);
    expect(r.poolMembers).toBe(2);
    expect(r.matched + r.unmatched).toBe(0);
    expect(r.total).toBe(3);
    // 远程一条都没抓到 → 来源标签回落「用户推荐池」,并附上池成员数
    expect(todayRow().comment).toBe(`${DAILY_TAG} ${DATE_STR} 组合自「用户推荐池」 + 2个用户推荐池`);
    expect(todayRow().source_platform).toBe("mixed");
    // 顺序由日期种子洗牌决定(确定性但非插入顺序),这里只断言集合与位置稠密
    const entries = todayEntries();
    expect(entries.map((e) => e.song_id).sort()).toEqual(["s1", "s2", "s3"]);
    expect(entries.map((e) => e.position)).toEqual([0, 1, 2]);
    expect(todayRow().song_count).toBe(3);
    expect(todayRow().duration).toBe(360);
  });

  it("推荐池最终只取 POOL_FINAL_SIZE(50) 首,即使池成员更多", async () => {
    allRemoteFail();
    const ids = Array.from({ length: 60 }, (_, i) => `s${String(i).padStart(2, "0")}`);
    for (const id of ids) seedSong(id);
    for (const id of ids) addFavorite("u-pool", id);
    addPool("favorites", "u-pool");

    const r = await generateDailyPlaylist(DATE);
    expect(r.poolSongsAdded).toBe(50);
    expect(todayEntries().length).toBe(50);
  });

  it("池成员没有可播歌曲 / 未知 source_type → 不贡献任何歌", async () => {
    allRemoteFail();
    seedSong("s1");
    seedPlaylist("pl-empty");
    addEntries("pl-empty", [{ songId: "s1", playable: 0 }, { songId: null }]);
    addPool("playlist", "pl-empty");
    addPool("favorites", "u-nobody");       // 收藏为空
    addPool("weird-type", "x");             // 未知类型

    await expect(generateDailyPlaylist(DATE)).rejects.toThrow("每日推荐生成失败");
  });

  it("远程全失败且推荐池为空 → 报错且不改动既有歌单(失败安全)", async () => {
    allRemoteFail();
    seedPlaylist(FIXED_TODAY_ID, { name: "每日推荐", comment: `${DAILY_TAG} 2026-09-26 组合自「旧内容」` });

    await expect(generateDailyPlaylist(DATE)).rejects.toThrow("所有远程榜单抓取失败且用户推荐池为空");
    // 旧内容原样保留
    expect(todayRow().comment).toContain("旧内容");
    expect(f.rebuildPlaylistEntries).not.toHaveBeenCalled();
  });

  it("推荐池歌与远程命中歌重复时被剔除,不会在歌单里出现两次", async () => {
    setCandidatesConfig([{ platform: "netease", url: "https://music.163.com/playlist?id=19723756", name: "热歌榜" }]);
    f.importPlaylistFromUrl.mockResolvedValue({ name: "热歌榜", tracks: [{ externalId: "e1", title: "T", artist: "A" }] });
    seedSong("s1");
    addFavorite("u-pool", "s1");
    addPool("favorites", "u-pool");
    // 远程重建「已命中」这首歌 → 已在歌单里的 song_id 必须让池歌去重
    f.rebuildPlaylistEntries.mockImplementation(async () => {
      sqlite.prepare("INSERT INTO playlist_songs (playlist_id, song_id, position, playable) VALUES (?,?,?,1)").run(FIXED_TODAY_ID, "s1", 0);
      return { matched: 1, unmatched: 0, wishAdded: 0 };
    });

    const r = await generateDailyPlaylist(DATE);
    expect(r.poolSongsAdded).toBe(0);
    expect(todayEntries().length).toBe(1);
  });
});

// ==================== 生成:远程榜单合并 ====================

describe("generateDailyPlaylist — 远程榜单合并去重", () => {
  it("多榜单增量去重(externalId|title|artist),重建后立即回收曲库索引", async () => {
    setCandidatesConfig([
      { platform: "netease", url: "https://music.163.com/playlist?id=19723756", name: "飙升榜" },
      { platform: "qq", url: "https://y.qq.com/n/ryqq/toplist/26", name: "巅峰榜热歌" },
    ]);
    f.importPlaylistFromUrl.mockImplementation(async (url: string) =>
      url.includes("163.com")
        ? { name: "飙升榜", tracks: [{ externalId: "x", title: "T", artist: "A" }, { externalId: "y", title: "T2", artist: "A" }] }
        : { name: "巅峰榜热歌", tracks: [{ externalId: "x", title: "T", artist: "A" }] },
    );
    // dedupedTracks 在 rebuild 返回后被就地清空(释放内存),所以必须在这里拷一份快照
    let capturedPid = "";
    let capturedMeta: Any = null;
    let capturedOpts: Any = null;
    f.rebuildPlaylistEntries.mockImplementation(async (pid: string, meta: Any, opts: Any) => {
      capturedPid = pid;
      capturedMeta = { ...meta, tracks: meta.tracks.map((t: Any) => ({ ...t })) };
      capturedOpts = opts;
      return { matched: 2, unmatched: 1, wishAdded: 1 };
    });

    const r = await generateDailyPlaylist(DATE);

    expect(f.rebuildPlaylistEntries).toHaveBeenCalledTimes(1);
    const [pid, meta, opts] = [capturedPid, capturedMeta, capturedOpts];
    expect(pid).toBe(FIXED_TODAY_ID);
    expect(meta).toEqual({
      name: "每日推荐",
      platform: "mixed",
      tracks: [{ externalId: "x", title: "T", artist: "A" }, { externalId: "y", title: "T2", artist: "A" }],
    });
    expect(opts).toEqual({ userId: adminId, autoWish: true, notes: "来自今日推荐组合" });
    expect(f.clearLibraryIndex).toHaveBeenCalledTimes(1);

    expect(r.matched).toBe(2);
    expect(r.unmatched).toBe(1);
    expect(r.wishAdded).toBe(1);
    expect(r.total).toBe(3);
    expect(r.picked.length).toBe(2);
    expect(todayRow().comment).toBe(`${DAILY_TAG} ${DATE_STR} 组合自「飙升榜 + 巅峰榜热歌」`);
  });

  it("单个榜单抓取失败不中止整轮,其它榜单与推荐池照常合入", async () => {
    setCandidatesConfig([
      { platform: "netease", url: "https://music.163.com/playlist?id=19723756", name: "飙升榜" },
      { platform: "qq", url: "https://y.qq.com/n/ryqq/toplist/26", name: "坏榜单" },
    ]);
    f.importPlaylistFromUrl.mockImplementation(async (url: string) => {
      if (url.includes("y.qq.com")) throw new Error("502");
      return { name: "飙升榜", tracks: [{ externalId: "x", title: "T", artist: "A" }] };
    });
    f.rebuildPlaylistEntries.mockResolvedValue({ matched: 1, unmatched: 0, wishAdded: 0 });

    const r = await generateDailyPlaylist(DATE);
    expect(r.matched).toBe(1);
    expect(todayRow().comment).toContain("飙升榜");
    expect(todayRow().comment).not.toContain("坏榜单");
  });

  it("远程与推荐池同时有内容 → 来源标签并列,且 total 为三项之和", async () => {
    setCandidatesConfig([{ platform: "netease", url: "https://music.163.com/playlist?id=19723756", name: "飙升榜" }]);
    f.importPlaylistFromUrl.mockResolvedValue({ name: "飙升榜", tracks: [{ externalId: "x", title: "T", artist: "A" }] });
    f.rebuildPlaylistEntries.mockResolvedValue({ matched: 1, unmatched: 2, wishAdded: 2 });
    seedSong("s1");
    addFavorite("u-pool", "s1");
    addPool("favorites", "u-pool");

    const r = await generateDailyPlaylist(DATE);
    expect(r.total).toBe(1 + 2 + 1);
    expect(r.poolSongsAdded).toBe(1);
    expect(todayRow().comment).toBe(`${DAILY_TAG} ${DATE_STR} 组合自「飙升榜」 + 1个用户推荐池`);
  });
});

// ==================== 生成:幂等与封面 ====================

describe("generateDailyPlaylist — 幂等跳过与封面", () => {
  it("当天已生成 → 跳过(零改动),但仍把当天封面同步进认领表", async () => {
    allRemoteFail();
    seedSong("s1");
    addFavorite("u-pool", "s1");
    addPool("favorites", "u-pool");
    f.pickDailyRotatedCover.mockReturnValue("cover-ref-1");

    const first = await generateDailyPlaylist(DATE);
    expect(first.skipped).toBe(false);
    f.syncCoverClaim.mockClear();

    const second = await generateDailyPlaylist(DATE);
    expect(second).toEqual({
      date: DATE_STR,
      playlistId: FIXED_TODAY_ID,
      name: "每日推荐",
      picked: [],
      platform: "mixed",
      total: 0, matched: 0, unmatched: 0, wishAdded: 0,
      poolSongsAdded: 0, poolMembers: 0,
      randomSongsAdded: 0,
      skipped: true,
    });
    expect(f.syncCoverClaim).toHaveBeenCalledWith(FIXED_TODAY_ID, DATE_STR, "cover-ref-1");
    // 幂等路径不得再次改动内容
    expect(todayRow().song_count).toBe(1);
    expect(f.rebuildPlaylistEntries).not.toHaveBeenCalled();
  });

  it("force + seedSalt 跳过当天幂等并重新走一次重建(仍有远程内容时)", async () => {
    setCandidatesConfig([{ platform: "netease", url: "https://music.163.com/playlist?id=19723756", name: "飙升榜" }]);
    f.importPlaylistFromUrl.mockImplementation(async () => ({ name: "飙升榜", tracks: [{ externalId: "x", title: "T", artist: "A" }] }));
    seedSong("s1");
    f.rebuildPlaylistEntries.mockImplementation(async () => {
      sqlite.prepare("DELETE FROM playlist_songs WHERE playlist_id = ?").run(FIXED_TODAY_ID);
      sqlite.prepare("INSERT INTO playlist_songs (playlist_id, song_id, position, playable) VALUES (?,?,?,1)").run(FIXED_TODAY_ID, "s1", 0);
      return { matched: 1, unmatched: 0, wishAdded: 0 };
    });

    await generateDailyPlaylist(DATE);
    expect((await generateDailyPlaylist(DATE)).skipped).toBe(true);

    const forced = await generateDailyPlaylist(DATE, { force: true, seedSalt: 7 });
    expect(forced.skipped).toBe(false);
    expect(forced.matched).toBe(1);
    expect(f.rebuildPlaylistEntries).toHaveBeenCalledTimes(2);
    // 强制刷新后仍写入当天日期 → 下次非 force 调用仍会跳过
    expect(todayRow().comment).toContain(DATE_STR);
    expect((await generateDailyPlaylist(DATE)).skipped).toBe(true);
  });

  it("仅推荐池(远程全失败)时按现状只做追加、不清旧条目 —— 见缺陷台账 D14", async () => {
    allRemoteFail();
    for (const id of ["s1", "s2", "s3"]) seedSong(id);
    for (const id of ["s1", "s2", "s3"]) addFavorite("u-pool", id);
    addPool("favorites", "u-pool");

    const day1 = await generateDailyPlaylist(DATE);
    expect(day1.poolSongsAdded).toBe(3);

    // 次日远程依旧全失败:零远程轨道 → rebuildPlaylistEntries 不被调用 → 旧条目
    // 不会被清;候选又被 existingSongIds 去重 → 一首也加不进去。
    // 结果是「日期戳成新的一天、内容仍是昨天的、且当天不会再重试」(total=0)。
    // 这是现状记录,不是期望行为;修复后本用例应改为断言旧条目被替换。
    const day2 = await generateDailyPlaylist(new Date("2026-09-28T04:00:00"));
    expect(day2.skipped).toBe(false);
    expect(day2.total).toBe(0);
    expect(day2.poolSongsAdded).toBe(0);
    expect(todayEntries().length).toBe(3);
    expect(todayRow().comment).toContain("2026-09-28");
  });

  it("force 不带 seedSalt → 自动取随机盐(同一天也能刷出不同内容)", async () => {
    allRemoteFail();
    seedSong("s1");
    addFavorite("u-pool", "s1");
    addPool("favorites", "u-pool");
    const r = await generateDailyPlaylist(DATE, { force: true });
    expect(r.skipped).toBe(false);
    expect(r.poolSongsAdded).toBe(1);
  });

  it("有可用封面 → 写进歌单;无可用封面 → 清掉旧封面缓存并把 cover_art 置空", async () => {
    allRemoteFail();
    seedSong("s1");
    addFavorite("u-pool", "s1");
    addPool("favorites", "u-pool");

    f.pickDailyRotatedCover.mockReturnValue("cover-A");
    await generateDailyPlaylist(DATE);
    expect(todayRow().cover_art).toBe("cover-A");
    expect(f.clearPlaylistCoverCache).not.toHaveBeenCalled();

    f.pickDailyRotatedCover.mockReturnValue(null);
    await generateDailyPlaylist(DATE, { force: true, seedSalt: 1 });
    expect(todayRow().cover_art).toBe(null);
    expect(f.clearPlaylistCoverCache).toHaveBeenCalledWith(FIXED_TODAY_ID);
  });
});

// ==================== 定时任务入口 ====================

describe("runDailyRecommendJob", () => {
  it("插件开关关闭 → 直接返回 null(不生成)", async () => {
    sqlite.prepare("INSERT INTO settings (key, value) VALUES ('daily_recommend_enabled', 'false')").run();
    expect(await runDailyRecommendJob()).toBe(null);
  });

  it("本地曲库为空 → 跳过(避免只生成一堆不可播占位)", async () => {
    expect(await runDailyRecommendJob()).toBe(null);
    expect(todayRow()).toBe(undefined);
  });

  it("本地曲库有歌 + 远程可用 → 正常生成并返回结果", async () => {
    seedSong("s1");
    setCandidatesConfig([{ platform: "netease", url: "https://music.163.com/playlist?id=19723756", name: "飙升榜" }]);
    f.importPlaylistFromUrl.mockResolvedValue({ name: "飙升榜", tracks: [{ externalId: "x", title: "T", artist: "A" }] });
    f.rebuildPlaylistEntries.mockResolvedValue({ matched: 1, unmatched: 0, wishAdded: 0 });

    const r = await runDailyRecommendJob();
    expect(r?.skipped).toBe(false);
    expect(r?.matched).toBe(1);
  });

  it("生成抛错 → 吞掉并返回 null(定时任务不应把异常抛给调度器)", async () => {
    seedSong("s1");
    allRemoteFail();
    expect(await runDailyRecommendJob()).toBe(null);
  });
});

// ==================== 插件门面 ====================

describe("dailyRecommendPlugin — 参数化能力门面", () => {
  it("runDailyJob:跳过时返回 null,成功时返回摘要串", async () => {
    allRemoteFail();
    seedSong("s1");
    addFavorite("u-pool", "s1");
    addPool("favorites", "u-pool");

    const ok = await dailyRecommendPlugin.runDailyJob!();
    expect(ok).toMatch(/^\d{4}-\d{2}-\d{2}: 0 matched, 0 stubs, 1 pool$/);
    expect(await dailyRecommendPlugin.runDailyJob!()).toBe(null); // 第二次:当天已生成 → skipped
  });

  it("候选/池相关能力直接透传到实现", () => {
    expect(dailyRecommendPlugin.isCandidateBlocked!({ name: "新歌榜" })).toBe(true);
    expect(dailyRecommendPlugin.loadCandidates!().length).toBe(7);
    expect(dailyRecommendPlugin.pickDailyCandidate!(new Date("2026-01-01T10:00:00"))).toEqual(loadCandidates()[1 % 7]);

    expect(dailyRecommendPlugin.addToRecommendPool!("playlist", "pl-x", "X", "u-pool")).toBe(true);
    expect(dailyRecommendPlugin.isInRecommendPool!("playlist", "pl-x")).toBe(true);
    expect(dailyRecommendPlugin.listRecommendPool!().length).toBe(1);
    expect(dailyRecommendPlugin.removeFromRecommendPool!("playlist", "pl-x")).toBe(true);
    expect(dailyRecommendPlugin.listRecommendPool!().length).toBe(0);

    dailyRecommendPlugin.saveCandidates!([
      { platform: "qq", url: " https://y.qq.com/n/ryqq/toplist/4 ", name: "流行指数" },
    ]);
    sqlite.prepare("INSERT INTO plugins (name, enabled, config) VALUES (?,?,?)")
      .run(DAILY_RECOMMEND_PLUGIN_ID, 1, "{}");
    dailyRecommendPlugin.saveCandidates!([
      { platform: "qq", url: " https://y.qq.com/n/ryqq/toplist/4 ", name: "流行指数" },
    ]);
    const cfg = JSON.parse((sqlite.prepare("SELECT config FROM plugins WHERE name = ?").get(DAILY_RECOMMEND_PLUGIN_ID) as Any).config);
    expect(cfg.candidates).toEqual([{ platform: "qq", url: "https://y.qq.com/n/ryqq/toplist/4", name: "流行指数" }]);

    expect(dailyRecommendPlugin.getHomeCount!()).toBe(DEFAULT_HOME_COUNT);
  });

  it("generateDailyPlaylist 门面与实现一致", async () => {
    allRemoteFail();
    seedSong("s1");
    addFavorite("u-pool", "s1");
    addPool("favorites", "u-pool");
    const r = await dailyRecommendPlugin.generateDailyPlaylist!(DATE);
    expect(r.playlistId).toBe(FIXED_TODAY_ID);
    expect(r.poolSongsAdded).toBe(1);
  });
});
