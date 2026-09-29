// ==================== 每日推荐:固定行的生命周期 + 首页张数的钳制 ====================
//
// 既有 tests/services/dailyRecommendService.test.ts 钉的是**生成算法**
// (榜单清洗 / 黑名单 / 推荐池抽样 / 幂等 / 失败安全)。本文件补两条它没照到的契约:
//
//   ① getDailyHomeCount —— 首页顶部展示张数必须钳在 1~24。这个数直接进前端渲染循环,
//      配置写坏(0 / 负数 / 非数字 / 超上限)时若原样透传,要么首页空一片、要么一次
//      拉几百张歌单卡拖垮首屏;
//   ② 「每日推荐」固定行(pl-daily-today)的**身份稳定性** —— id 与 created_at 恒不变,
//      客户端(web/app/HA/卡片)按常量 id 引用它,曲库侧也据此复用封面文件名。
//      每天重建内容必须换内容不换行。
//
// 外部副作用面(远程抓取 / 歌单重建 / 曲库索引 / 封面文件)一律假体,其余走真实 SQLite。
// MUST be the first import:把 DATA_DIR 指到本文件专属的隔离目录。
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
import { songs } from "../../src/db/schema.js";
import {
  DAILY_TAG,
  FIXED_TODAY_ID,
  DAILY_RECOMMEND_PLUGIN_ID,
  DEFAULT_HOME_COUNT,
  MAX_HOME_COUNT,
  getDailyHomeCount,
  loadCandidates,
  saveCandidates,
  generateDailyPlaylist,
} from "../../src/services/plugin/dailyRecommend.js";

const PLUGIN = DAILY_RECOMMEND_PLUGIN_ID;

/** 插件行的权威来源(与 getPluginConfig 假体相互独立:homeCount 读真表)。 */
function setPluginRow(cfgJson: string, enabled = 1) {
  if (!sqlite.prepare("SELECT id FROM plugins WHERE name = ?").get(PLUGIN)) {
    sqlite.prepare("INSERT INTO plugins (id, name, version, description, manifest, enabled, config, created_at, updated_at) VALUES (?,?,'1.0.0','','{}',1,'{}',?,?)")
      .run(PLUGIN, PLUGIN, new Date().toISOString(), new Date().toISOString());
  }
  sqlite.prepare("UPDATE plugins SET config = ?, enabled = ? WHERE name = ?").run(cfgJson, enabled, PLUGIN);
}

function seedSong(id: string) {
  db.insert(songs).values({ id, title: `t-${id}`, path: `l:t:/music/${id}.mp3`, suffix: "mp3", duration: 120 }).run();
}

function addFavorite(userId: string, songId: string) {
  sqlite.prepare("INSERT OR IGNORE INTO user_favorite_songs (user_id, song_id) VALUES (?,?)").run(userId, songId);
}

function addPool(sourceType: string, sourceId: string) {
  sqlite.prepare("INSERT INTO recommend_pool (source_type, source_id, source_name, user_id, enabled, created_at) VALUES (?,?,?,?,1,?)")
    .run(sourceType, sourceId, "", "u-pool", new Date().toISOString());
}

function todayRow() {
  return sqlite.prepare("SELECT * FROM playlists WHERE id = ?").get(FIXED_TODAY_ID) as Any;
}

beforeAll(() => {
  if (!process.env.APP_VERSION) process.env.APP_VERSION = "1.0.0";
  initDatabase();
  sqlite.prepare("INSERT OR IGNORE INTO users (id, username, password, salt, subsonic_salt, is_admin, is_active, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?)")
    .run("u-pool", "u-pool", "", "s", "s", 0, 1, new Date().toISOString(), new Date().toISOString());
});

beforeEach(() => {
  vi.resetAllMocks();
  // songs 一并清掉再重播:本文件每个用例都要一条同名曲目,留着会撞主键。
  for (const t of ["playlist_songs", "user_favorite_songs", "recommend_pool", "playlists", "songs"]) {
    sqlite.prepare(`DELETE FROM ${t}`).run();
  }
  setPluginRow("{}", 1);
  f.getPluginConfig.mockReturnValue(null);
  f.importPlaylistFromUrl.mockRejectedValue(new Error("network down"));
  f.rebuildPlaylistEntries.mockImplementation(async () => ({ matched: 0, unmatched: 0, wishAdded: 0 }));
  f.pickDailyRotatedCover.mockReturnValue(null);
  // 推荐池有内容 ⇒ 远程全失败也能正常生成(走「仅推荐池」路径)。
  seedSong("s1");
  addFavorite("u-pool", "s1");
  addPool("favorites", "u-pool");
});

// ==================== 首页张数的钳制 ====================

describe("getDailyHomeCount —— 首页展示张数必须钳在 1~24", () => {
  it("未配置 / 配置里没这个键 → 默认 8", () => {
    expect(getDailyHomeCount()).toBe(DEFAULT_HOME_COUNT);
    setPluginRow(JSON.stringify({ candidates: [] }));
    expect(getDailyHomeCount()).toBe(DEFAULT_HOME_COUNT);
  });

  it("合法区间内原样采用(1 与 24 是两端边界)", () => {
    setPluginRow(JSON.stringify({ homeCount: 1 }));
    expect(getDailyHomeCount()).toBe(1);
    setPluginRow(JSON.stringify({ homeCount: MAX_HOME_COUNT }));
    expect(getDailyHomeCount()).toBe(MAX_HOME_COUNT);
    setPluginRow(JSON.stringify({ homeCount: 12 }));
    expect(getDailyHomeCount()).toBe(12);
  });

  it("超过上限钳到 24(首页不能一次拉几百张卡)", () => {
    setPluginRow(JSON.stringify({ homeCount: 999 }));
    expect(getDailyHomeCount()).toBe(MAX_HOME_COUNT);
  });

  it("非法值(0 / 负数 / 非数字)回落默认 8", () => {
    for (const bad of [0, -3, "abc", null, {}]) {
      setPluginRow(JSON.stringify({ homeCount: bad }));
      expect(getDailyHomeCount()).toBe(DEFAULT_HOME_COUNT);
    }
  });

  it("插件被停用 → 回落默认(停用后不应继续按旧配置渲染首页)", () => {
    setPluginRow(JSON.stringify({ homeCount: 20 }), 0);
    expect(getDailyHomeCount()).toBe(DEFAULT_HOME_COUNT);
  });

  it("config 不是合法 JSON / 不是对象 → 回落默认且不抛", () => {
    setPluginRow("not-json");
    expect(getDailyHomeCount()).toBe(DEFAULT_HOME_COUNT);
    setPluginRow(JSON.stringify([1, 2]));
    expect(getDailyHomeCount()).toBe(DEFAULT_HOME_COUNT);
    setPluginRow(JSON.stringify(null));
    expect(getDailyHomeCount()).toBe(DEFAULT_HOME_COUNT);
  });
});

// ==================== 固定歌单行的身份稳定性 ====================

describe("「每日推荐」固定行 —— 换内容不换行", () => {
  it("首次生成创建固定行:名字/来源平台/同步开关/封面初值都符合契约", async () => {
    await generateDailyPlaylist(new Date("2026-12-01T04:00:00"));
    const row = todayRow();
    expect(row).toBeTruthy();
    expect(row.id).toBe(FIXED_TODAY_ID);
    expect(row.name).toBe("每日推荐");
    // source_platform='mixed' + sync_enabled=0:它是本地聚合歌单,
    // 绝不能被歌单自动同步当成「导入歌单」去回拉远程源。
    expect(row.source_platform).toBe("mixed");
    expect(row.sync_enabled).toBe(0);
    expect(row.cover_art).toBeNull();
    // comment 里带插件标记 + 当天日期:这是「今天已生成过」的唯一判据
    // (行是固定的,created_at 永远是首次创建那天)。
    expect(row.comment).toContain(DAILY_TAG);
    expect(row.comment).toContain("2026-12-01");
  });

  it("跨天 force 重建:id / created_at / owner 一律不变(客户端按常量 id 引用)", async () => {
    await generateDailyPlaylist(new Date("2026-12-02T04:00:00"));
    const first = todayRow();

    // 12-03 那次必须真正产出新内容,否则命中 D14 空跑提前返回(不盖当天日期戳),走不到重建路径。
    seedSong("s2");
    addFavorite("u-pool", "s2");

    await generateDailyPlaylist(new Date("2026-12-03T04:00:00"), { force: true });
    const second = todayRow();

    expect(second.id).toBe(first.id);
    expect(second.created_at).toBe(first.created_at);
    expect(second.owner_id).toBe(first.owner_id);
    // 内容确实换了:comment 上的日期戳跟着走。
    expect(second.comment).toContain("2026-12-03");
    expect(second.comment).not.toContain("2026-12-02");
  });

  it("重复生成不会多出第二条固定行(整张 playlists 表里只有它一个)", async () => {
    await generateDailyPlaylist(new Date("2026-12-04T04:00:00"));
    await generateDailyPlaylist(new Date("2026-12-05T04:00:00"), { force: true });
    await generateDailyPlaylist(new Date("2026-12-06T04:00:00"), { force: true });
    const n = sqlite.prepare("SELECT COUNT(*) AS n FROM playlists WHERE id = ?").get(FIXED_TODAY_ID) as Any;
    expect(n.n).toBe(1);
  });
});

// ==================== 候选榜单写回的兜底 ====================

describe("saveCandidates 的兜底", () => {
  it("存进空数组 → 读取时回落内置清单(清空榜单不会让「每日推荐」没有候选)", () => {
    saveCandidates([]);
    const stored = JSON.parse((sqlite.prepare("SELECT config FROM plugins WHERE name = ?").get(PLUGIN) as Any).config);
    expect(stored.candidates).toEqual([]);
    // 一个候选都没有时若照着空清单生成,「每日推荐」会直接抛「生成失败」;
    // 回落内置清单是最后一道安全网。
    expect(loadCandidates().length).toBeGreaterThan(0);
  });

  it("现状记录(缺陷台账):插件行缺失时 saveCandidates 静默丢改动", () => {
    // setPluginConfigCandidates 只做 UPDATE,行不存在时影响 0 行 —— 用户的榜单编辑
    // 被无声丢弃(不抛错、不建行)。插件行在启动时播种,正常跑不到;这里钉住现状。
    sqlite.prepare("DELETE FROM plugins WHERE name = ?").run(PLUGIN);
    expect(() => saveCandidates([{ platform: "qq", url: "https://y.qq.com/n/ryqq/toplist/4", name: "流行指数" }])).not.toThrow();
    expect(sqlite.prepare("SELECT id FROM plugins WHERE name = ?").get(PLUGIN)).toBeUndefined();
  });
});
