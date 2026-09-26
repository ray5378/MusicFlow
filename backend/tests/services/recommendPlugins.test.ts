/**
 * plugin/dailyRecommend.ts + plugin/localRecommend.ts —— 每日推荐 / 本地推荐插件的
 * 配置读取、候选榜单读写、推荐池 CRUD、以及确定性随机抽取(date-seeded)。
 *
 * 只断言「配置与选择」这一层(DB + PRNG);真正抓榜单/建歌单的编排
 * (generateDailyPlaylist / runDailyRecommendJob / generateLocalDailyPlaylist)
 * 依赖 playlistImport + playlistSync + 网络,不在本文件范围内。
 */
import { describe, it, expect, beforeEach } from "vitest";

import {
  getDailyHomeCount,
  isCandidateBlocked,
  loadCandidates,
  saveCandidates,
  pickDailyCandidate,
  listRecommendPool,
  addToRecommendPool,
  removeFromRecommendPool,
  isInRecommendPool,
  DEFAULT_HOME_COUNT,
  MAX_HOME_COUNT,
  DAILY_RECOMMEND_PLUGIN_ID,
} from "../../src/services/plugin/dailyRecommend.js";
import {
  getLocalRecommendConfig,
  pickRandomLibrarySongs,
  pickLocalRecommendSongs,
  DEFAULT_SONG_COUNT,
  MAX_SONG_COUNT,
  LOCAL_RECOMMEND_PLUGIN_ID,
} from "../../src/services/plugin/localRecommend.js";
import { sqlite } from "../../src/db/index.js";
import { upsertSong } from "../../src/services/source/scanner.js";

function setPluginConfig(pluginId: string, config: unknown, enabled = true): void {
  sqlite.prepare("DELETE FROM plugins WHERE name = ?").run(pluginId);
  sqlite.prepare(
    "INSERT INTO plugins (id, name, enabled, config, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
  ).run(
    `pid:${pluginId}`,
    pluginId,
    enabled ? 1 : 0,
    typeof config === "string" ? config : JSON.stringify(config),
    new Date().toISOString(),
    new Date().toISOString(),
  );
}

function seedSong(title: string): string {
  const p = `l:rec:/${title}.mp3`;
  upsertSong(
    p,
    {
      title, artist: `A-${title}`, album: "AL", duration: 100, bitRate: 320, genre: "",
      year: 0, track: 0, discNumber: 1, contentType: "audio/mpeg", suffix: "mp3", size: 1,
      albumArtist: "", composer: "", comment: "",
    } as any,
    "rec",
  );
  return (sqlite.prepare("SELECT id FROM songs WHERE path = ?").get(p) as any).id;
}

/** 清空歌曲(drizzle 的 FK 没有 CASCADE,先清引用方)。 */
function resetSongs(): void {
  for (const t of ["playlist_songs", "user_favorite_songs", "play_history", "audio_analysis"]) {
    try { sqlite.prepare(`DELETE FROM ${t}`).run(); } catch { /* 表不存在则跳过 */ }
  }
  sqlite.prepare("DELETE FROM songs").run();
}

beforeEach(() => {
  sqlite.prepare("DELETE FROM plugins WHERE name IN (?, ?)").run(DAILY_RECOMMEND_PLUGIN_ID, LOCAL_RECOMMEND_PLUGIN_ID);
  sqlite.prepare("DELETE FROM recommend_pool").run();
  sqlite.prepare("DELETE FROM settings WHERE key = 'daily_recommend_local_enabled'").run();
  resetSongs();
});

describe("getDailyHomeCount(插件配置 homeCount)", () => {
  it("插件未安装/未启用 -> 默认 8", () => {
    expect(getDailyHomeCount()).toBe(DEFAULT_HOME_COUNT);
    setPluginConfig(DAILY_RECOMMEND_PLUGIN_ID, { homeCount: 12 }, false);
    expect(getDailyHomeCount()).toBe(DEFAULT_HOME_COUNT);
  });

  it("读配置值;超过上限被夹到 24", () => {
    setPluginConfig(DAILY_RECOMMEND_PLUGIN_ID, { homeCount: 12 });
    expect(getDailyHomeCount()).toBe(12);
    setPluginConfig(DAILY_RECOMMEND_PLUGIN_ID, { homeCount: 99 });
    expect(getDailyHomeCount()).toBe(MAX_HOME_COUNT);
    expect(MAX_HOME_COUNT).toBe(24);
  });

  it("非法值(非数字 / 0 / 负数)回落默认 8", () => {
    for (const bad of ["abc", 0, -3, null, ""]) {
      setPluginConfig(DAILY_RECOMMEND_PLUGIN_ID, { homeCount: bad });
      expect(getDailyHomeCount()).toBe(DEFAULT_HOME_COUNT);
    }
  });

  it("config 不是合法 JSON -> 兜底默认值,不抛错", () => {
    setPluginConfig(DAILY_RECOMMEND_PLUGIN_ID, "{not json");
    expect(getDailyHomeCount()).toBe(DEFAULT_HOME_COUNT);
  });
});

describe("isCandidateBlocked(榜单黑名单)", () => {
  it("按 URL 排除 QQ 巅峰榜新歌/欧美 与 网易云新歌榜", () => {
    expect(isCandidateBlocked({ url: "https://y.qq.com/n/ryqq/toplist/27" })).toBe(true);
    expect(isCandidateBlocked({ url: "https://y.qq.com/n/ryqq/toplist/60" })).toBe(true);
    expect(isCandidateBlocked({ url: "https://music.163.com/playlist?id=3779629" })).toBe(true);
    expect(isCandidateBlocked({ url: "https://music.163.com/playlist?foo=1&id=3779629" })).toBe(true);
  });

  it("按名称关键字排除含「新歌」「欧美」的榜单", () => {
    expect(isCandidateBlocked({ url: "https://ok/x", name: "网易云·新歌榜" })).toBe(true);
    expect(isCandidateBlocked({ url: "https://ok/x", name: "QQ音乐·巅峰榜欧美" })).toBe(true);
  });

  it("正常榜单与空对象都不拦", () => {
    expect(isCandidateBlocked({ url: "https://ok/x", name: "网易云·热歌榜" })).toBe(false);
    expect(isCandidateBlocked({})).toBe(false);
  });
});

describe("loadCandidates / saveCandidates", () => {
  it("未配置时使用内置默认榜单(7 条,且已过滤黑名单)", () => {
    const list = loadCandidates();
    expect(list).toHaveLength(7);
    expect(list.every((c) => !isCandidateBlocked(c))).toBe(true);
    expect(new Set(list.map((c) => c.platform))).toEqual(new Set(["qq", "netease"]));
  });

  it("插件配置里的 candidates 优先,并做清洗(去非法项 / 去黑名单 / trim url)", () => {
    setPluginConfig(DAILY_RECOMMEND_PLUGIN_ID, {
      candidates: [
        { platform: "netease", url: "  https://music.163.com/playlist?id=1  ", name: "我的榜" },
        { platform: "netease", url: "https://music.163.com/playlist?id=3779629", name: "网易云·新歌榜" },
        { platform: "", url: "https://x" },
        { platform: "qq" },
        null,
      ],
    });
    const list = loadCandidates();
    expect(list).toEqual([{ platform: "netease", url: "https://music.163.com/playlist?id=1", name: "我的榜" }]);
  });

  it("配置里全是非法/被拦项 -> 回落内置默认榜单", () => {
    setPluginConfig(DAILY_RECOMMEND_PLUGIN_ID, { candidates: [{ platform: "qq", url: "https://y.qq.com/n/ryqq/toplist/27" }] });
    expect(loadCandidates()).toHaveLength(7);
  });

  it("saveCandidates 写回插件 config,且保留其它配置项", () => {
    setPluginConfig(DAILY_RECOMMEND_PLUGIN_ID, { homeCount: 11 });
    saveCandidates([
      { platform: "qq", url: "https://y.qq.com/n/ryqq/toplist/26", name: "热歌" },
      { platform: "netease", url: "https://music.163.com/playlist?id=3779629", name: "新歌榜" },
    ]);

    const cfg = JSON.parse((sqlite.prepare("SELECT config FROM plugins WHERE name = ?").get(DAILY_RECOMMEND_PLUGIN_ID) as any).config);
    expect(cfg.homeCount).toBe(11);
    expect(cfg.candidates).toEqual([{ platform: "qq", url: "https://y.qq.com/n/ryqq/toplist/26", name: "热歌" }]);
    expect(loadCandidates()).toEqual(cfg.candidates);
  });
});

describe("pickDailyCandidate(按日期轮转)", () => {
  it("同一天稳定;每 7 天一轮回到同一张榜", () => {
    const pool = loadCandidates();
    const jan1 = new Date(2025, 0, 1);
    const jan1b = new Date(2025, 0, 1, 23, 59);
    const jan8 = new Date(2025, 0, 8); // dayOfYear 8 -> 8 % 7 = 1，与 1 同余

    expect(pickDailyCandidate(jan1)).toEqual(pickDailyCandidate(jan1b));
    expect(pickDailyCandidate(jan1)).toEqual(pool[1]);
    expect(pickDailyCandidate(jan8)).toEqual(pool[1]);
  });

  it("不同天基本落在不同下标上(1 与 2 天)", () => {
    const pool = loadCandidates();
    expect(pickDailyCandidate(new Date(2025, 0, 1))).toEqual(pool[1]);
    expect(pickDailyCandidate(new Date(2025, 0, 2))).toEqual(pool[2]);
  });
});

describe("推荐池 CRUD", () => {
  it("新增幂等:首次 true,重复 false", () => {
    expect(addToRecommendPool("playlist", "pl1", "我的歌单", "u1")).toBe(true);
    expect(addToRecommendPool("playlist", "pl1", "我的歌单", "u1")).toBe(false);
    expect(isInRecommendPool("playlist", "pl1")).toBe(true);
  });

  it("列表带出全字段,顺序按创建时间", () => {
    addToRecommendPool("playlist", "pl1", "一", "u1");
    addToRecommendPool("favorites", "u2", "二", "u2");
    // 两次插入可能同毫秒 —— 显式分开时间戳,让 ORDER BY created_at 可判定
    sqlite.prepare("UPDATE recommend_pool SET created_at = '2025-01-01T00:00:00.000Z' WHERE source_id = 'pl1'").run();
    sqlite.prepare("UPDATE recommend_pool SET created_at = '2025-01-02T00:00:00.000Z' WHERE source_id = 'u2'").run();

    const list = listRecommendPool();
    expect(list).toHaveLength(2);
    expect(list[0]).toMatchObject({ source_type: "playlist", source_id: "pl1", source_name: "一", user_id: "u1", enabled: 1 });
    expect(list.map((r) => r.source_id)).toEqual(["pl1", "u2"]);
  });

  it("enabled=0 的成员不出现在列表里,但 isIn 仍为真", () => {
    addToRecommendPool("playlist", "pl9", "停用", "u1");
    sqlite.prepare("UPDATE recommend_pool SET enabled = 0 WHERE source_id = 'pl9'").run();
    expect(listRecommendPool()).toHaveLength(0);
    expect(isInRecommendPool("playlist", "pl9")).toBe(true);
  });

  it("删除按受影响行数返回布尔", () => {
    addToRecommendPool("favorites", "u3", "三", "u3");
    expect(removeFromRecommendPool("favorites", "u3")).toBe(true);
    expect(removeFromRecommendPool("favorites", "u3")).toBe(false);
    expect(isInRecommendPool("favorites", "u3")).toBe(false);
  });
});

describe("getLocalRecommendConfig", () => {
  it("未配置 -> 空歌单池 / 50 首 / 排除近期", () => {
    expect(getLocalRecommendConfig()).toEqual({ sourcePlaylists: [], count: DEFAULT_SONG_COUNT, excludeRecent: true });
  });

  it("读取配置:歌单池过滤非法项、count 夹到上限、excludeRecent 显式关", () => {
    setPluginConfig(LOCAL_RECOMMEND_PLUGIN_ID, {
      sourcePlaylists: ["pl-a", "", 3, null, "pl-b"],
      count: 9999,
      excludeRecent: false,
    });
    expect(getLocalRecommendConfig()).toEqual({
      sourcePlaylists: ["pl-a", "pl-b"],
      count: MAX_SONG_COUNT,
      excludeRecent: false,
    });
  });

  it("count 非法(<1 / 非数字)-> 默认 50", () => {
    setPluginConfig(LOCAL_RECOMMEND_PLUGIN_ID, { count: 0 });
    expect(getLocalRecommendConfig().count).toBe(DEFAULT_SONG_COUNT);
    setPluginConfig(LOCAL_RECOMMEND_PLUGIN_ID, { count: "abc" });
    expect(getLocalRecommendConfig().count).toBe(DEFAULT_SONG_COUNT);
  });

  it("config 非法 JSON -> 全默认,不抛错", () => {
    setPluginConfig(LOCAL_RECOMMEND_PLUGIN_ID, "{{{");
    expect(getLocalRecommendConfig()).toEqual({ sourcePlaylists: [], count: DEFAULT_SONG_COUNT, excludeRecent: true });
  });
});

describe("pickRandomLibrarySongs(全库确定性随机)", () => {
  it("空库 -> 空数组", () => {
    expect(pickRandomLibrarySongs(new Date(2025, 0, 1), 10)).toEqual([]);
  });

  it("库小于等于 limit -> 返回全库(打乱),同一天结果一致", () => {
    const ids = [seedSong("r1"), seedSong("r2"), seedSong("r3")];
    const a = pickRandomLibrarySongs(new Date(2025, 0, 1), 10);
    const b = pickRandomLibrarySongs(new Date(2025, 0, 1), 10);
    expect(a).toEqual(b);
    expect([...a].sort()).toEqual([...ids].sort());
  });

  it("库大于 limit -> 只取 limit 首且互不重复,结果落在真实歌曲集合内", () => {
    const ids = new Set<string>();
    for (let i = 0; i < 30; i++) ids.add(seedSong(`big${i}`));

    const picked = pickRandomLibrarySongs(new Date(2025, 2, 3), 5);
    expect(picked).toHaveLength(5);
    expect(new Set(picked).size).toBe(5);
    for (const id of picked) expect(ids.has(id)).toBe(true);
    // 同日可复现
    expect(pickRandomLibrarySongs(new Date(2025, 2, 3), 5)).toEqual(picked);
  });
});

describe("pickLocalRecommendSongs", () => {
  it("开关关闭 -> 空结果且不标回落", () => {
    seedSong("l1");
    sqlite.prepare("INSERT INTO settings (key, value) VALUES ('daily_recommend_local_enabled', 'false')").run();
    expect(pickLocalRecommendSongs(new Date(2025, 0, 1))).toEqual({ songIds: [], sourceUsers: 0, fallback: false });
  });

  it("无口味数据(无播放历史/收藏)-> 全库随机兜底,fallback=true", () => {
    const ids = [seedSong("f1"), seedSong("f2"), seedSong("f3")];
    const r = pickLocalRecommendSongs(new Date(2025, 0, 1));
    expect(r.fallback).toBe(true);
    expect(r.sourceUsers).toBe(0);
    expect([...r.songIds].sort()).toEqual([...ids].sort());
  });

  it("结果受配置 count 上限裁剪", () => {
    for (let i = 0; i < 8; i++) seedSong(`c${i}`);
    setPluginConfig(LOCAL_RECOMMEND_PLUGIN_ID, { count: 3 });
    const r = pickLocalRecommendSongs(new Date(2025, 0, 1));
    expect(r.songIds).toHaveLength(3);
  });

  it("开关显式打开(1)也走正常路径", () => {
    seedSong("on1");
    sqlite.prepare("INSERT INTO settings (key, value) VALUES ('daily_recommend_local_enabled', '1')").run();
    const r = pickLocalRecommendSongs(new Date(2025, 0, 1));
    expect(r.songIds).toHaveLength(1);
  });
});
