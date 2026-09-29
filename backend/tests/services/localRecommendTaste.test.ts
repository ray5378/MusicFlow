// ==================== localRecommend 的配置读取与抽取算法 ====================
//
// 既有 tests/services/localRecommend.test.ts 钉的是「生成歌单」这条主链路
// (固定 id / 当天幂等 / force + seedSalt / 参考歌单池 / 封面)。本文件补的是它**没有照到**的
// 两段纯逻辑:
//
//   ① getLocalRecommendConfig —— 配置的**钳制与兜底**。它决定「每天生成多少首」和
//      「从哪儿抽」,配置写坏(JSON 非法 / count 超范围 / 歌单 id 混入非字符串)时
//      必须静默回落,绝不能让定时任务崩掉;
//   ② pickLocalRecommendSongs / pickRandomLibrarySongs —— 抽取算法本身:口味加权、
//      「排除近期播放」、以及 date-seeded 确定性(同一天重跑结果一致是「幂等」的前提,
//      不同天内容要变是「推荐」的前提)。
//
// 全部走真实 SQLite:抽样逻辑的正确性恰恰依赖真实的 SQL 过滤条件
// (suffix IS NOT NULL AND path IS NOT NULL、playable=1)与 rowid 分布,
// 换成假体就测不到。外部副作用面只有封面文件,用 partial mock 保留真身。
// MUST be the first import:把 DATA_DIR 指到本文件专属的隔离目录。
import "../plugins/_env.js";

import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";

type Any = any;

const COV = vi.hoisted(() => ({ boom: false }));

// 封面:只加一个「让它抛错」的开关,其余走真身 —— 用来验证定时任务吞异常。
vi.mock("../../src/services/playlistCover.js", async (importOriginal) => {
  const actual = await importOriginal<Record<string, Any>>();
  return {
    ...actual,
    pickDailyRotatedCover: (...args: Any[]) => {
      if (COV.boom) throw new Error("cover boom");
      return (actual as Any).pickDailyRotatedCover(...args);
    },
  };
});

import { sqlite, initDatabase } from "../../src/db/index.js";
import { registerBuiltinPlugins } from "../../src/plugins/builtins.js";
import { setSetting } from "../../src/services/settings.js";
import {
  getLocalRecommendConfig,
  pickLocalRecommendSongs,
  pickRandomLibrarySongs,
  generateLocalDailyPlaylist,
  runLocalDailyRecommendJob,
  localRecommendPlugin,
  LOCAL_FIXED_PLAYLIST_ID,
  LOCAL_RECOMMEND_PLUGIN_ID,
  DEFAULT_SONG_COUNT,
  MAX_SONG_COUNT,
} from "../../src/services/plugin/localRecommend.js";

const PLUGIN = LOCAL_RECOMMEND_PLUGIN_ID;

let adminId = "";

// songs.artist_id / album_id 是外键,建歌前必须有对应的艺术家/专辑行。
function seedArtist(id: string) {
  sqlite.prepare("INSERT OR IGNORE INTO artists (id, name) VALUES (?,?)").run(id, `艺术家 ${id}`);
}

function seedAlbum(id: string, artistId?: string) {
  sqlite.prepare("INSERT OR IGNORE INTO albums (id, name, artist_id) VALUES (?,?,?)").run(id, `专辑 ${id}`, artistId ?? null);
}

/** 可播放的本地曲目(playable 判据 = suffix + path 都非空)。 */
function seedSongs(n: number, over: Any = {}) {
  if (over.artistId) seedArtist(over.artistId);
  if (over.albumId) seedAlbum(over.albumId, over.artistId);
  const ins = sqlite.prepare(
    "INSERT INTO songs (id, title, artist, album, artist_id, album_id, genre, duration, path, suffix, type, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
  );
  const now = new Date().toISOString();
  for (let i = 0; i < n; i++) {
    ins.run(
      `s${i}`, `Song ${i}`, "Artist", "Album",
      over.artistId ?? null, over.albumId ?? null, over.genre ?? null,
      200, `l:src:/tmp/s${i}.mp3`, "mp3", "local", now,
    );
  }
}

function seedPlaylist(id: string, songIds: string[]) {
  sqlite
    .prepare("INSERT INTO playlists (id, name, owner_id, is_public, comment, created_at, updated_at) VALUES (?,?,?,1,?,?,?)")
    .run(id, `歌单 ${id}`, adminId, "", new Date().toISOString(), new Date().toISOString());
  const ins = sqlite.prepare("INSERT INTO playlist_songs (playlist_id, song_id, position, playable, created_at) VALUES (?,?,?,1,?)");
  songIds.forEach((sid, i) => ins.run(id, sid, i, new Date().toISOString()));
}

/** 近 30 天窗口内的播放记录(权重随时间衰减,这里统一取"刚刚")。 */
function seedHistory(songIds: string[], userId = adminId) {
  const ins = sqlite.prepare("INSERT INTO play_history (user_id, song_id, played_at) VALUES (?,?,?)");
  songIds.forEach((sid) => ins.run(userId, sid, new Date().toISOString()));
}

/** 保证插件行存在:前序用例可能整行删掉了它(见「插件被停用 / 行不存在」)。
 *  这里**不能**用 registerBuiltinPlugins() 兜底 —— 它带 `registered` 模块级一次性
 *  开关,第二次调用直接 return,补不回行。 */
function ensurePluginRow() {
  if (sqlite.prepare("SELECT id FROM plugins WHERE name = ?").get(PLUGIN)) return;
  const now = new Date().toISOString();
  sqlite
    .prepare("INSERT INTO plugins (id, name, version, description, manifest, enabled, config, created_at, updated_at) VALUES (?,?,'1.0.0','','{}',1,'{}',?,?)")
    .run(PLUGIN, PLUGIN, now, now);
}

function setCfg(cfg: Record<string, Any>, enabled = 1) {
  ensurePluginRow();
  sqlite.prepare("UPDATE plugins SET config = ?, enabled = ? WHERE name = ?").run(JSON.stringify(cfg), enabled, PLUGIN);
}

function reset() {
  for (const t of ["playlist_songs", "play_history", "user_favorite_songs", "playlists", "songs"]) {
    sqlite.prepare(`DELETE FROM ${t}`).run();
  }
  setCfg({}, 1);
  setSetting("daily_recommend_local_enabled", "true");
  COV.boom = false;
}

beforeAll(() => {
  if (!process.env.APP_VERSION) process.env.APP_VERSION = "1.0.0";
  initDatabase();
  registerBuiltinPlugins();
  adminId = (sqlite.prepare("SELECT id FROM users WHERE is_admin = 1 LIMIT 1").get() as Any)?.id || "";
  if (!adminId) {
    sqlite.prepare(
      "INSERT INTO users (id, username, password, salt, subsonic_salt, is_admin, is_active, created_at, updated_at) VALUES ('u1','admin','','s','s',1,1,?,?)",
    ).run(new Date().toISOString(), new Date().toISOString());
    adminId = "u1";
  }
});

beforeEach(reset);

// ==================== 配置读取:钳制与兜底 ====================

describe("getLocalRecommendConfig —— 配置写坏也不能让定时任务崩", () => {
  it("未配置 → 默认 50 首、无参考歌单、排除近期播放", () => {
    const cfg = getLocalRecommendConfig();
    // 契约:默认行为必须可预期 —— 不配就是「全库口味推荐 50 首、排除近期」。
    expect(cfg).toEqual({ sourcePlaylists: [], count: DEFAULT_SONG_COUNT, excludeRecent: true });
  });

  it("插件被停用 / 行不存在 → 回落默认(停用插件不应影响读取,只影响是否调度)", () => {
    setCfg({ count: 7 }, 0);
    expect(getLocalRecommendConfig().count).toBe(DEFAULT_SONG_COUNT);
    sqlite.prepare("DELETE FROM plugins WHERE name = ?").run(PLUGIN);
    expect(getLocalRecommendConfig()).toEqual({ sourcePlaylists: [], count: DEFAULT_SONG_COUNT, excludeRecent: true });
  });

  it("count 超上限钳到 500;非法值(0/负数/非数字)回落 50", () => {
    // 上限的意义:一个歌单塞几千首会让重建条目与封面拼图变得极慢,必须封顶。
    setCfg({ count: MAX_SONG_COUNT + 1000 });
    expect(getLocalRecommendConfig().count).toBe(MAX_SONG_COUNT);
    setCfg({ count: 0 });
    expect(getLocalRecommendConfig().count).toBe(DEFAULT_SONG_COUNT);
    setCfg({ count: -5 });
    expect(getLocalRecommendConfig().count).toBe(DEFAULT_SONG_COUNT);
    setCfg({ count: "abc" });
    expect(getLocalRecommendConfig().count).toBe(DEFAULT_SONG_COUNT);
  });

  it("sourcePlaylists 只保留非空字符串项(脏数据不能变成 SQL 参数)", () => {
    setCfg({ sourcePlaylists: ["pl-a", "", 123, null, "pl-b", {}] });
    expect(getLocalRecommendConfig().sourcePlaylists).toEqual(["pl-a", "pl-b"]);
    setCfg({ sourcePlaylists: "pl-a" });
    expect(getLocalRecommendConfig().sourcePlaylists).toEqual([]);
  });

  it("excludeRecent 只有显式 false 才关闭(缺省/其它值一律开启)", () => {
    setCfg({});
    expect(getLocalRecommendConfig().excludeRecent).toBe(true);
    setCfg({ excludeRecent: false });
    expect(getLocalRecommendConfig().excludeRecent).toBe(false);
    setCfg({ excludeRecent: "no" });
    expect(getLocalRecommendConfig().excludeRecent).toBe(true);
  });

  it("config 字段不是对象 / 是非法 JSON → 回落默认(不抛)", () => {
    sqlite.prepare("UPDATE plugins SET config = ? WHERE name = ?").run("not-json", PLUGIN);
    expect(getLocalRecommendConfig().count).toBe(DEFAULT_SONG_COUNT);
    sqlite.prepare("UPDATE plugins SET config = ? WHERE name = ?").run(JSON.stringify([1, 2]), PLUGIN);
    expect(getLocalRecommendConfig()).toEqual({ sourcePlaylists: [], count: DEFAULT_SONG_COUNT, excludeRecent: true });
  });
});

// ==================== 抽取算法 ====================

describe("pickLocalRecommendSongs —— 口味抽取与「排除近期播放」", () => {
  it("总开关关闭 → 空结果(停用插件即不再产出)", () => {
    seedSongs(20);
    setSetting("daily_recommend_local_enabled", "false");
    const r = pickLocalRecommendSongs(new Date("2026-09-20T10:00:00"));
    expect(r.songIds).toEqual([]);
    expect(r.sourceUsers).toBe(0);
    expect(r.fallback).toBe(false);
  });

  it("排除近期播放:近 30 天听过的歌不进今天的推荐", () => {
    seedSongs(20, { artistId: "ar-1", albumId: "al-1", genre: "Pop" });
    const recent = Array.from({ length: 10 }, (_, i) => `s${i}`);
    seedHistory(recent);

    const r = pickLocalRecommendSongs(new Date("2026-09-21T10:00:00"));
    // 契约:「排除近期播放」是让每天推荐感觉新鲜的唯一手段,漏排 = 每天都是同一批歌。
    for (const id of r.songIds) expect(recent).not.toContain(id);
    expect(r.songIds.length).toBe(10);
    expect(r.fallback).toBe(false);
    expect(r.sourceUsers).toBe(1);
  });

  it("excludeRecent=false → 口味路径近期歌重新入候选(已修复 D17)", () => {
    // D17 修复:pickCandidateSongs 现在按 excludeRecent 决定是否用 profile.recentSongIds
    // 当排除集;关掉「排除近期播放」后,近期听过的歌会**回到**候选里(用户就是想再听)。
    seedSongs(20, { artistId: "ar-1", albumId: "al-1", genre: "Pop" });
    const recent = Array.from({ length: 10 }, (_, i) => `s${i}`);
    seedHistory(recent);
    setCfg({ excludeRecent: false });

    const r = pickLocalRecommendSongs(new Date("2026-09-22T10:00:00"));
    expect(r.fallback).toBe(false);
    // 关掉开关后 20 首全部可入候选(不再被近期历史挡掉)。
    expect(r.songIds).toHaveLength(20);
    expect(r.songIds.some((id) => recent.includes(id))).toBe(true);
  });

  it("参考歌单池优先:只从池内歌曲抽,且数量受 count 控制", () => {
    seedSongs(60);
    seedPlaylist("pl-pool", Array.from({ length: 30 }, (_, i) => `s${i}`));
    setCfg({ sourcePlaylists: ["pl-pool"], count: 12, excludeRecent: false });

    const r = pickLocalRecommendSongs(new Date("2026-09-23T10:00:00"));
    expect(r.songIds).toHaveLength(12);
    for (const id of r.songIds) {
      expect(parseInt(String(id).slice(1), 10)).toBeLessThan(30);
    }
    // 池路径不经过口味画像,故 sourceUsers 为 0。
    expect(r.sourceUsers).toBe(0);
    expect(r.fallback).toBe(false);
  });

  it("池内歌曲被「排除近期播放」清空 → 回落全库兜底而不是产出空歌单", () => {
    seedSongs(20, { artistId: "ar-1", albumId: "al-1", genre: "Pop" });
    const poolIds = Array.from({ length: 20 }, (_, i) => `s${i}`);
    seedPlaylist("pl-pool", poolIds);
    seedHistory(poolIds); // 池里每一首都在近期窗口内
    setCfg({ sourcePlaylists: ["pl-pool"], count: 10, excludeRecent: true });

    const r = pickLocalRecommendSongs(new Date("2026-09-24T10:00:00"));
    // 池被排空时若直接返回空,用户会看到「本地推荐」变成空歌单 —— 必须有兜底。
    expect(r.songIds).toHaveLength(10);
    expect(r.fallback).toBe(true);
  });

  it("现状记录(缺陷台账):兜底分支不遵守 excludeRecent,可能推回刚听过的歌", () => {
    // pickCandidateSongs 严格排除 profile.recentSongIds,但候选不足 5 首时改走的
    // pickRandomSample 直接全库随机、不看播放历史 —— 于是「排除近期播放」在这条
    // 兜底路径上静默失效。这里把现状钉住,便于修好后改成反向断言。
    seedSongs(20, { artistId: "ar-1", albumId: "al-1", genre: "Pop" });
    const recent = Array.from({ length: 16 }, (_, i) => `s${i}`);
    seedHistory(recent);
    setCfg({ count: 10, excludeRecent: true });

    const r = pickLocalRecommendSongs(new Date("2026-09-24T11:00:00"));
    expect(r.fallback).toBe(true);
    expect(r.songIds.some((id) => recent.includes(id))).toBe(true);
  });

  it("date-seeded 确定性:同一天重复抽取结果完全一致(幂等的前提)", () => {
    seedSongs(40);
    const d = new Date("2026-09-25T10:00:00");
    const a = pickLocalRecommendSongs(d);
    const b = pickLocalRecommendSongs(d);
    expect(a.songIds).toEqual(b.songIds);
  });

  it("无口味数据(无历史/无收藏)→ 全库随机兜底并标记 fallback", () => {
    seedSongs(30);
    const r = pickLocalRecommendSongs(new Date("2026-09-26T10:00:00"));
    // 新装用户没有播放历史:直接产出空歌单等于功能不可用,必须走全库随机。
    expect(r.fallback).toBe(true);
    expect(r.songIds.length).toBeGreaterThan(0);
    expect(r.sourceUsers).toBe(0);
  });

  it("收藏算强信号:有收藏时不再走全库随机兜底", () => {
    seedSongs(30, { artistId: "ar-1", albumId: "al-1", genre: "Pop" });
    sqlite.prepare("INSERT INTO user_favorite_songs (user_id, song_id) VALUES (?,?)").run(adminId, "s5");
    const r = pickLocalRecommendSongs(new Date("2026-09-27T10:00:00"));
    // 收藏权重 2.0 且不衰减 → 足够凑出 >= 5 首候选,不该落到 fallback。
    expect(r.fallback).toBe(false);
    expect(r.songIds.length).toBeGreaterThanOrEqual(5);
  });
});

describe("pickRandomLibrarySongs —— rowid 过采样的确定性随机", () => {
  it("空曲库 → 空数组(不抛、不返回 undefined)", () => {
    expect(pickRandomLibrarySongs(new Date("2026-09-28T10:00:00"), 10)).toEqual([]);
  });

  it("曲库比 limit 小 → 返回全部(一个不落)", () => {
    seedSongs(8);
    const ids = pickRandomLibrarySongs(new Date("2026-09-28T10:00:00"), 50);
    expect(ids).toHaveLength(8);
    expect(new Set(ids).size).toBe(8);
  });

  it("大曲库:严格取满 limit 且互不重复", () => {
    seedSongs(200);
    const ids = pickRandomLibrarySongs(new Date("2026-09-28T10:00:00"), 50);
    expect(ids).toHaveLength(50);
    expect(new Set(ids).size).toBe(50);
    for (const id of ids) expect(id.startsWith("s")).toBe(true);
  });

  it("同一天同一 limit → 顺序完全一致;换一天 → 顺序改变", () => {
    seedSongs(200);
    const d1 = new Date("2026-09-28T10:00:00");
    const d2 = new Date("2026-10-05T10:00:00");
    const a = pickRandomLibrarySongs(d1, 50);
    const a2 = pickRandomLibrarySongs(d1, 50);
    const b = pickRandomLibrarySongs(d2, 50);
    // 同一天必须一致:否则「重启服务后歌单内容变了」会让客户端缓存的洗牌序错位。
    expect(a).toEqual(a2);
    // 不同天必须变:否则「每天推荐」就是一批死唱片。
    expect(a.join(",")).not.toBe(b.join(","));
  });
});

// ==================== 生成与定时任务的收口 ====================

describe("generateLocalDailyPlaylist —— 固定行的自愈与空结果收口", () => {
  it("已存在的固定行名字不对 → 自动改回「本地推荐」", async () => {
    seedSongs(20);
    const now = new Date().toISOString();
    sqlite
      .prepare("INSERT INTO playlists (id, name, owner_id, is_public, comment, created_at, updated_at) VALUES (?,?,?,1,?,?,?)")
      .run(LOCAL_FIXED_PLAYLIST_ID, "每日推荐", adminId, "", now, now);

    const r = await generateLocalDailyPlaylist(new Date("2026-11-01T10:00:00"));
    expect(r!.skipped).toBe(false);
    // 历史遗留行(旧版共用「每日推荐」名)必须被纠正,否则首页出现两张同名卡。
    const row = sqlite.prepare("SELECT name FROM playlists WHERE id = ?").get(LOCAL_FIXED_PLAYLIST_ID) as Any;
    expect(row.name).toBe("本地推荐");
  });

  it("曲库为空 → 空结果 + skipped(不建空歌单、不报错)", async () => {
    const r = await generateLocalDailyPlaylist(new Date("2026-11-02T10:00:00"));
    // 新装还没导入音乐时不能报错:定时任务会把它记成失败,用户看到红字。
    expect(r).not.toBeNull();
    expect(r!.skipped).toBe(true);
    expect(r!.total).toBe(0);
    const n = sqlite.prepare("SELECT COUNT(*) AS n FROM playlist_songs WHERE playlist_id = ?").get(LOCAL_FIXED_PLAYLIST_ID) as Any;
    expect(n.n).toBe(0);
  });

  it("runLocalDailyRecommendJob:生成过程抛错被吞掉,返回 null(定时任务不把异常抛给调度器)", async () => {
    seedSongs(20);
    COV.boom = true;
    const r = await runLocalDailyRecommendJob({ force: true });
    expect(r).toBeNull();
  });

  it("localRecommendPlugin 门面:pickSongs 透传;runDailyJob 跳过返回 null、成功返回摘要", async () => {
    seedSongs(30);
    const d = new Date("2026-11-03T10:00:00");
    const direct = pickLocalRecommendSongs(d);
    const viaPlugin = await localRecommendPlugin.pickSongs(d);
    expect(viaPlugin.songIds).toEqual(direct.songIds);

    const first = await localRecommendPlugin.runDailyJob({ force: true, seedSalt: 1 });
    expect(typeof first).toBe("string");
    expect(first).toContain("本地推荐");
    // 同一天再跑一次(不 force)→ 幂等跳过 → 门面返回 null,调度器据此不记一条噪音日志。
    const second = await localRecommendPlugin.runDailyJob();
    expect(second).toBeNull();
  });
});
