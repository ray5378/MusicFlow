// 「本地推荐」引擎(services/plugin/localRecommend.ts)的**抽取算法与配置面**。
//
// 既有 tests/services/localRecommend.test.ts 只覆盖 generateLocalDailyPlaylist 的
// happy path(生成 / 幂等 / force / seedSalt / 封面),而真正决定「推荐什么」的
// 三块代码此前一行未跑:
//   ① buildTasteProfile + pickCandidateSongs:从 play_history / 收藏聚合出
//      艺人-专辑-风格三层加权候选,并剔除近期播放过的歌;
//   ② pickFromPlaylistPool:配置了「参考歌单」时从池里确定性抽(此处 excludeRecent 生效);
//   ③ 兜底链:候选不足 5 首 → 全库确定性随机(pickRandomSample);
//      池内无可播 → 回落口味;口味也无 → 空结果不报错。
//
// 顺带固化一个**口径不一致**(缺陷台账 D17):`excludeRecent` 只在「参考歌单池」
// 路径生效,「口味路径」的近期剔除是无条件的 —— 关掉该开关在口味推荐下看不出效果。
//
// MUST be the first import: redirects DATA_DIR to an isolated temp dir.
import "../plugins/_env.js";

import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from "vitest";
import { initDatabase, sqlite } from "../../src/db/index.js";
import { registerBuiltinPlugins } from "../../src/plugins/builtins.js";
import {
  pickLocalRecommendSongs,
  pickRandomLibrarySongs,
  getLocalRecommendConfig,
  generateLocalDailyPlaylist,
  runLocalDailyRecommendJob,
  localRecommendPlugin,
  LOCAL_FIXED_PLAYLIST_ID,
  LOCAL_RECOMMEND_PLUGIN_ID,
  DAILY_TAG_LOCAL,
  DEFAULT_SONG_COUNT,
  MAX_SONG_COUNT,
} from "../../src/services/plugin/localRecommend.js";

const NOW = new Date("2026-09-20T12:00:00Z");
let owner = "";

const iso = (daysAgo: number) => new Date(Date.now() - daysAgo * 86400000).toISOString();

function seedArtist(id: string) {
  sqlite.prepare("INSERT OR IGNORE INTO artists (id, name, created_at, updated_at) VALUES (?,?,?,?)").run(id, id, iso(1), iso(1));
}

function seedAlbumRow(id: string) {
  sqlite.prepare("INSERT OR IGNORE INTO albums (id, name, created_at, updated_at) VALUES (?,?,?,?)").run(id, id, iso(1), iso(1));
}

function seedSong(
  id: string,
  opts: { artistId?: string | null; albumId?: string | null; genre?: string | null; suffix?: string | null; duration?: number } = {},
) {
  const artistId = opts.artistId === undefined ? "A1" : opts.artistId;
  const albumId = opts.albumId === undefined ? "AL1" : opts.albumId;
  // songs.artist_id / album_id 都是外键 → 先补齐被引用行(幂等)
  if (artistId) seedArtist(artistId);
  if (albumId) seedAlbumRow(albumId);
  sqlite
    .prepare(
      `INSERT INTO songs (id, title, artist, artist_id, album, album_id, genre, duration, path, suffix, type, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
    )
    .run(
      id,
      id,
      "A",
      artistId,
      "Al",
      albumId,
      opts.genre === undefined ? "Pop" : opts.genre,
      opts.duration ?? 100,
      `l:src:/tmp/${id}.mp3`,
      opts.suffix === undefined ? "mp3" : opts.suffix,
      "local",
      iso(1),
    );
}

function seedHistory(userId: string, songId: string, daysAgo: number) {
  sqlite
    .prepare("INSERT INTO play_history (user_id, song_id, played_at) VALUES (?,?,?)")
    .run(userId, songId, iso(daysAgo));
}

function seedFav(userId: string, songId: string) {
  sqlite.prepare("INSERT OR IGNORE INTO user_favorite_songs (user_id, song_id, created_at) VALUES (?,?,?)").run(userId, songId, iso(1));
}

function setCfg(cfg: Record<string, unknown>, enabled = 1) {
  sqlite
    .prepare("UPDATE plugins SET config = ?, enabled = ? WHERE name = ?")
    .run(JSON.stringify(cfg), enabled, LOCAL_RECOMMEND_PLUGIN_ID);
}

function seedPlaylist(id: string, songIds: string[], playable = true) {
  sqlite
    .prepare(
      "INSERT INTO playlists (id, name, owner_id, is_public, comment, created_at, updated_at) VALUES (?,?,?,1,'',?,?)",
    )
    .run(id, id, owner, iso(1), iso(1));
  const ins = sqlite.prepare(
    "INSERT INTO playlist_songs (playlist_id, song_id, position, playable, created_at) VALUES (?,?,?,?,?)",
  );
  songIds.forEach((s, i) => ins.run(id, s, i, playable ? 1 : 0, iso(1)));
}

function mp(): string[] {
  return (sqlite.prepare("SELECT song_id FROM playlist_songs WHERE playlist_id = ? ORDER BY position").all(LOCAL_FIXED_PLAYLIST_ID) as any[]).map(
    (r) => r.song_id,
  );
}

/** 10 首可播歌:A1/AL1/Pop 五首(s0..s4)+ A2/AL2/Rock 五首(s5..s9)。 */
function seedLibrary() {
  seedArtist("A1");
  seedArtist("A2");
  seedAlbumRow("AL1");
  seedAlbumRow("AL2");
  for (let i = 0; i < 5; i++) seedSong(`s${i}`, { artistId: "A1", albumId: "AL1", genre: "Pop" });
  for (let i = 5; i < 10; i++) seedSong(`s${i}`, { artistId: "A2", albumId: "AL2", genre: "Rock" });
}

beforeAll(() => {
  if (!process.env.APP_VERSION) process.env.APP_VERSION = "1.0.0";
  initDatabase();
  registerBuiltinPlugins();
  const admin = sqlite.prepare("SELECT id FROM users WHERE is_admin = 1 LIMIT 1").get() as any;
  if (admin) {
    owner = admin.id;
  } else {
    sqlite
      .prepare(
        "INSERT INTO users (id, username, password, salt, subsonic_salt, pass_enc, is_admin, is_active, email, created_at, updated_at) VALUES ('u1','admin','','s','ss','',1,1,'a@b.c',?,?)",
      )
      .run(iso(1), iso(1));
    owner = "u1";
  }
});

beforeEach(() => {
  sqlite.prepare("DELETE FROM playlist_songs").run();
  sqlite.prepare("DELETE FROM playlists").run();
  sqlite.prepare("DELETE FROM play_history").run();
  sqlite.prepare("DELETE FROM user_favorite_songs").run();
  sqlite.prepare("DELETE FROM playlist_cover_claims").run();
  sqlite.prepare("DELETE FROM songs").run();
  sqlite.prepare("DELETE FROM albums").run();
  sqlite.prepare("DELETE FROM artists").run();
  sqlite.prepare("DELETE FROM settings").run();
  setCfg({});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("getLocalRecommendConfig:静默兜底", () => {
  it("未配置 → 空池 + 默认 50 首 + 默认排除近期", () => {
    expect(getLocalRecommendConfig()).toEqual({ sourcePlaylists: [], count: DEFAULT_SONG_COUNT, excludeRecent: true });
  });

  it("sourcePlaylists 里的非字符串/空串被过滤掉", () => {
    setCfg({ sourcePlaylists: ["pl-a", "", 42, null, "pl-b"] });
    expect(getLocalRecommendConfig().sourcePlaylists).toEqual(["pl-a", "pl-b"]);
  });

  it("sourcePlaylists 不是数组 → 当空池处理", () => {
    setCfg({ sourcePlaylists: "pl-a" });
    expect(getLocalRecommendConfig().sourcePlaylists).toEqual([]);
  });

  it("count 非法回落 50,超上限夹到 500", () => {
    setCfg({ count: 0 });
    expect(getLocalRecommendConfig().count).toBe(DEFAULT_SONG_COUNT);
    setCfg({ count: "abc" });
    expect(getLocalRecommendConfig().count).toBe(DEFAULT_SONG_COUNT);
    setCfg({ count: 9999 });
    expect(getLocalRecommendConfig().count).toBe(MAX_SONG_COUNT);
    setCfg({ count: 7 });
    expect(getLocalRecommendConfig().count).toBe(7);
  });

  it("excludeRecent 只有显式 false 才关(其余一律视为开)", () => {
    setCfg({ excludeRecent: false });
    expect(getLocalRecommendConfig().excludeRecent).toBe(false);
    setCfg({ excludeRecent: 0 });
    expect(getLocalRecommendConfig().excludeRecent).toBe(true);
    setCfg({});
    expect(getLocalRecommendConfig().excludeRecent).toBe(true);
  });

  it("插件被停用 / 配置坏 JSON → 全部回落默认", () => {
    setCfg({ count: 3, excludeRecent: false }, 0);
    expect(getLocalRecommendConfig()).toEqual({ sourcePlaylists: [], count: DEFAULT_SONG_COUNT, excludeRecent: true });
    sqlite
      .prepare("UPDATE plugins SET config = ?, enabled = 1 WHERE name = ?")
      .run("{broken", LOCAL_RECOMMEND_PLUGIN_ID);
    expect(getLocalRecommendConfig().excludeRecent).toBe(true);
  });
});

describe("口味路径:play_history / 收藏聚合 + 近期剔除", () => {
  it("从播放历史聚合出艺人候选,近期播放过的歌被剔除", () => {
    seedLibrary();
    seedHistory(owner, "s0", 1); // A1 且近期 → 不进候选
    seedHistory(owner, "s5", 2); // A2 且近期 → 不进候选
    const r = pickLocalRecommendSongs(NOW);
    expect(r.fallback).toBe(false);
    expect(r.sourceUsers).toBe(1);
    expect(r.songIds).not.toContain("s0");
    expect(r.songIds).not.toContain("s5");
    // 同艺人的其余歌曲全部进候选(艺人层权重 3)
    expect([...r.songIds].sort()).toEqual(["s1", "s2", "s3", "s4", "s6", "s7", "s8", "s9"]);
  });

  it("收藏算强信号(+2):只有收藏、没有播放历史也能出候选", () => {
    seedLibrary();
    seedFav(owner, "s2");
    const r = pickLocalRecommendSongs(NOW);
    expect(r.fallback).toBe(false);
    expect(r.songIds).toContain("s1"); // 同艺人
    expect(r.sourceUsers).toBe(0); // 无播放历史 → 贡献用户数为 0
  });

  it("窗口外的播放历史不计入口味也不计入近期剔除", () => {
    seedLibrary();
    seedHistory(owner, "s0", 120); // 远超 HISTORY_WINDOW_DAYS(30)
    const r = pickLocalRecommendSongs(NOW);
    // 窗口外历史不产生候选 → 候选不足 5 首 → 全库兜底,且 s0 不再被剔除
    expect(r.fallback).toBe(true);
    expect(r.songIds).toContain("s0");
  });

  it("现状记录(缺陷台账 D17):excludeRecent=false 在口味路径下被忽略,近期歌仍被剔除", () => {
    // 「口味路径」的剔除用的是 buildTasteProfile().recentSongIds,与 excludeRecent 无关;
    // 该开关只在「参考歌单池」路径生效。用户把「排除近期播放」关掉时,口味推荐仍会
    // 把近 30 天听过的歌剔掉 —— 开关在这个模式下看起来失效。
    // 修复后该断言应改为 toContain("s0")。
    seedLibrary();
    seedHistory(owner, "s0", 1);
    seedHistory(owner, "s5", 1); // 两个艺人各有一条近期历史 → 剩余候选 8 首
    setCfg({ excludeRecent: false });
    const r = pickLocalRecommendSongs(NOW);
    expect(r.fallback).toBe(false);
    expect(r.songIds).not.toContain("s0");
    expect(r.songIds).not.toContain("s5");
  });

  it("候选结果被 count 截断(不是把整库吐出来)", () => {
    seedLibrary();
    seedHistory(owner, "s0", 1);
    setCfg({ count: 3 });
    const r = pickLocalRecommendSongs(NOW);
    expect(r.songIds).toHaveLength(3);
  });

  it("选项总开关 daily_recommend_local_enabled=false → 直接空结果(不跑任何抽取)", () => {
    seedLibrary();
    sqlite.prepare("INSERT INTO settings (key, value, updated_at) VALUES (?,?,?)").run("daily_recommend_local_enabled", "false", iso(1));
    expect(pickLocalRecommendSongs(NOW)).toEqual({ songIds: [], sourceUsers: 0, fallback: false });
  });
});

describe("参考歌单池路径:确定性抽取 + excludeRecent 真正生效", () => {
  it("只从池内抽,数量受 count 控制,近期播放歌被剔除", () => {
    seedLibrary();
    seedPlaylist("pl-pool", ["s1", "s2", "s3", "s4"]);
    seedHistory(owner, "s1", 1); // 近期 → 剔除
    setCfg({ sourcePlaylists: ["pl-pool"], count: 2, excludeRecent: true });
    const r = pickLocalRecommendSongs(NOW);
    expect(r.sourceUsers).toBe(0);
    expect(r.fallback).toBe(false);
    expect(r.songIds).toHaveLength(2);
    expect(r.songIds).not.toContain("s1");
    for (const id of r.songIds) expect(["s2", "s3", "s4"]).toContain(id);
  });

  it("excludeRecent=false 时池内的近期播放歌照样入选(与口味路径口径不同)", () => {
    seedLibrary();
    seedPlaylist("pl-pool", ["s1", "s2", "s3", "s4"]);
    seedHistory(owner, "s1", 1);
    setCfg({ sourcePlaylists: ["pl-pool"], count: 4, excludeRecent: false });
    const r = pickLocalRecommendSongs(NOW);
    expect(r.songIds).toHaveLength(4);
    expect([...r.songIds].sort()).toEqual(["s1", "s2", "s3", "s4"]);
  });

  it("池内全是不可播条目 → 回落口味推荐", () => {
    seedLibrary();
    seedPlaylist("pl-dead", ["s1", "s2"], false); // playable = 0
    // 两个艺人各有一条近期历史 → 剩余候选 8 首(>=5),不会触发全库兜底
    seedHistory(owner, "s0", 1);
    seedHistory(owner, "s5", 1);
    setCfg({ sourcePlaylists: ["pl-dead"], count: 10 });
    const r = pickLocalRecommendSongs(NOW);
    expect(r.fallback).toBe(false);
    expect(r.songIds.length).toBeGreaterThan(0);
    expect(r.songIds).not.toContain("s0");
    expect(r.songIds).not.toContain("s5");
  });

  it("同一天两次调用结果一致(日期种子确定性),跨天则不同", () => {
    seedLibrary();
    seedPlaylist("pl-pool", ["s0", "s1", "s2", "s3", "s4", "s5", "s6", "s7", "s8", "s9"]);
    setCfg({ sourcePlaylists: ["pl-pool"], count: 5, excludeRecent: false });
    // 用**本地时间**构造(dayOfYear 走 getFullYear/本地零点),避免跨时区把两天算成一天
    const a = pickLocalRecommendSongs(new Date(2026, 8, 20, 1, 0, 0));
    const b = pickLocalRecommendSongs(new Date(2026, 8, 20, 23, 0, 0));
    expect(a.songIds).toEqual(b.songIds);
    const c = pickLocalRecommendSongs(new Date(2026, 8, 21, 12, 0, 0));
    expect(c.songIds).not.toEqual(a.songIds);
  });
});

describe("全库兜底 pickRandomSample(经 pickLocalRecommendSongs 触发)", () => {
  it("曲库为空 → 空结果,不报错", () => {
    expect(pickLocalRecommendSongs(NOW)).toEqual({ songIds: [], sourceUsers: 0, fallback: true });
  });

  it("无可播歌(suffix 为空)→ 同样空结果", () => {
    for (let i = 0; i < 6; i++) seedSong(`x${i}`, { suffix: null });
    expect(pickLocalRecommendSongs(NOW).songIds).toEqual([]);
  });

  it("无任何口味数据 → 全库确定性随机兜底,fallback=true", () => {
    seedLibrary();
    const r = pickLocalRecommendSongs(NOW);
    expect(r.fallback).toBe(true);
    expect(r.sourceUsers).toBe(0);
    expect(r.songIds).toHaveLength(10); // count 默认 50 > 库内 10 首
    expect(new Set(r.songIds).size).toBe(10);
  });
});

describe("pickRandomLibrarySongs:O(limit) 抽样", () => {
  it("空库 → []", () => {
    expect(pickRandomLibrarySongs(NOW, 5)).toEqual([]);
  });

  it("库容 <= limit → 全量返回(洗牌,不重复)", () => {
    seedLibrary();
    const out = pickRandomLibrarySongs(NOW, 50);
    expect(out).toHaveLength(10);
    expect(new Set(out).size).toBe(10);
  });

  it("库容 > limit → 走 rowid 采样,恰好返回 limit 首且不重复", () => {
    for (let i = 0; i < 40; i++) seedSong(`r${i}`);
    const out = pickRandomLibrarySongs(NOW, 7);
    expect(out).toHaveLength(7);
    expect(new Set(out).size).toBe(7);
    for (const id of out) expect(id.startsWith("r")).toBe(true);
  });

  it("同一天同一 limit 结果稳定(日期种子)", () => {
    for (let i = 0; i < 40; i++) seedSong(`r${i}`);
    // 同『口味/池』路径:dayOfYear 走本地零点 → 必须用本地时间构造,否则 UTC 01:00 与 22:00
    // 在 UTC+8 下分属两个本地日,种子不同 → 断言失败(这是本用例此前的根因)。
    const a = pickRandomLibrarySongs(new Date(2026, 8, 20, 1, 0, 0), 6);
    const b = pickRandomLibrarySongs(new Date(2026, 8, 20, 23, 0, 0), 6);
    expect(a).toEqual(b);
    const c = pickRandomLibrarySongs(new Date(2026, 8, 21, 12, 0, 0), 6);
    expect(c).not.toEqual(a);
  });
});

describe("generateLocalDailyPlaylist 的其余分支", () => {
  it("固定歌单已存在但名字是旧名 → 自动改名并继续生成", async () => {
    seedLibrary();
    sqlite
      .prepare(
        "INSERT INTO playlists (id, name, owner_id, is_public, comment, created_at, updated_at) VALUES (?,?,?,1,'',?,?)",
      )
      .run(LOCAL_FIXED_PLAYLIST_ID, "每日推荐", owner, iso(1), iso(1));
    const r = await generateLocalDailyPlaylist(new Date("2026-09-20T12:00:00Z"), { force: true });
    expect(r!.skipped).toBe(false);
    const row = sqlite.prepare("SELECT name, comment FROM playlists WHERE id = ?").get(LOCAL_FIXED_PLAYLIST_ID) as any;
    expect(row.name).toBe("本地推荐");
    expect(row.comment).toContain(DAILY_TAG_LOCAL);
  });

  it("总开关关闭 → skipped=true 且 total=0(不写歌单内容)", async () => {
    seedLibrary();
    sqlite.prepare("INSERT INTO settings (key, value, updated_at) VALUES (?,?,?)").run("daily_recommend_local_enabled", "false", iso(1));
    const r = await generateLocalDailyPlaylist(new Date("2026-09-21T12:00:00Z"), { force: true });
    expect(r!.skipped).toBe(true);
    expect(r!.total).toBe(0);
    expect(mp()).toEqual([]);
  });

  it("force 但不传 seedSalt → 取随机盐(同一天两次结果可不同),结束后盐被复位", async () => {
    // 20 首里取 10 首 → 两次撞同一序列的概率 1/C(20,10) ≈ 5e-6,可忽略。
    for (let i = 0; i < 20; i++) seedSong(`p${i}`);
    seedPlaylist("pl-pool", Array.from({ length: 20 }, (_, i) => `p${i}`));
    setCfg({ sourcePlaylists: ["pl-pool"], count: 10, excludeRecent: false });
    const d = new Date("2026-09-22T12:00:00Z");
    const a = await generateLocalDailyPlaylist(d, { force: true });
    const aIds = mp();
    const b = await generateLocalDailyPlaylist(d, { force: true });
    const bIds = mp();
    expect(a!.skipped).toBe(false);
    expect(b!.skipped).toBe(false);
    expect(aIds).toHaveLength(10);
    expect(bIds).toHaveLength(10);
    expect(aIds.join(",")).not.toBe(bIds.join(","));
    // 随机盐用完即复位 → 非 force 调用恢复确定性
    const c = await generateLocalDailyPlaylist(new Date("2026-09-23T12:00:00Z"));
    expect(c!.skipped).toBe(false);
  });

  it("runLocalDailyRecommendJob:正常返回结果;底层抛错时吞掉并返回 null", async () => {
    seedLibrary();
    const ok = await runLocalDailyRecommendJob({ force: true });
    expect(ok).not.toBeNull();
    expect(ok!.skipped).toBe(false);

    const spy = vi.spyOn(sqlite, "prepare").mockImplementation(() => {
      throw new Error("db 崩了");
    });
    await expect(runLocalDailyRecommendJob()).resolves.toBeNull();
    spy.mockRestore();
  });
});

describe("插件入口", () => {
  it("pickSongs 转发 pickLocalRecommendSongs", async () => {
    seedLibrary();
    const r = await localRecommendPlugin.pickSongs(NOW);
    expect(r.fallback).toBe(true);
    expect(r.songIds).toHaveLength(10);
  });

  it("runDailyJob:成功返回摘要字符串;skipped 时返回 null", async () => {
    seedLibrary();
    seedPlaylist("pl-pool", ["s0", "s1", "s2"]);
    setCfg({ sourcePlaylists: ["pl-pool"], count: 2, excludeRecent: false });
    sqlite.prepare("DELETE FROM playlists WHERE id = ?").run(LOCAL_FIXED_PLAYLIST_ID);
    const msg = await localRecommendPlugin.runDailyJob!({ force: true });
    expect(typeof msg).toBe("string");
    expect(msg).toContain("本地推荐");

    sqlite.prepare("INSERT INTO settings (key, value, updated_at) VALUES (?,?,?)").run("daily_recommend_local_enabled", "false", iso(1));
    expect(await localRecommendPlugin.runDailyJob!({ force: true })).toBeNull();
  });

  it("plugin.generateLocalDailyPlaylist 直接转发生成函数", async () => {
    seedLibrary();
    sqlite.prepare("DELETE FROM playlists WHERE id = ?").run(LOCAL_FIXED_PLAYLIST_ID);
    const r = await localRecommendPlugin.generateLocalDailyPlaylist!(new Date("2026-09-24T12:00:00Z"), { force: true });
    expect(r!.skipped).toBe(false);
    expect(r!.playlistId).toBe(LOCAL_FIXED_PLAYLIST_ID);
    expect(mp().length).toBe(r!.total);
  });
});
