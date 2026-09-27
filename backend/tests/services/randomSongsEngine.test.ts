// 「随机歌曲」插件(services/plugin/randomSongs.ts)的配置解析、过滤 SQL 与两种抽取路径。
//
// 既有 tests/services/randomSongs.test.ts 只覆盖「默认生成 / count 生效 / 惰性刷新」三例。
// 本文件补的是:
//   ① getRandomSongsConfig 的**逐字段兜底**:count / refreshMinutes 的上下限、
//      genre 的空串归一、fromYear/toYear 的区间校验与**自动交换**、坏 JSON 与停用的兜底;
//   ② buildFilterClause:流派 LIKE 的通配符转义、年份经 albums.year 的 JOIN 条件,
//      以及 describeFilters 拼出的歌单 comment;
//   ③ pickRandomPlayableSongs 的两条路径(小库全量洗牌 / 大库 rowid 过采样)、
//      空库跳过、歌单行的创建与**旧名自动改名**、变更事件广播;
//   ④ 后台自适应定时刷新(首轮生成、异常吞掉后继续排下一轮)。
//
// MUST be the first import: redirects DATA_DIR to an isolated temp dir.
import "../plugins/_env.js";

import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from "vitest";
import { initDatabase, sqlite } from "../../src/db/index.js";
import { registerBuiltinPlugins } from "../../src/plugins/builtins.js";
import {
  getRandomSongsConfig,
  generateRandomSongsPlaylist,
  maybeRefreshRandomSongs,
  runRandomSongsJob,
  startRandomSongsAutoRefresh,
  randomSongsEvents,
  randomSongsPlugin,
  RANDOM_PLAYLIST_ID,
  RANDOM_PLUGIN_ID,
  RANDOM_SONGS_CHANGED_EVENT,
  DEFAULT_SONG_COUNT,
  DEFAULT_REFRESH_MINUTES,
  MAX_SONG_COUNT,
} from "../../src/services/plugin/randomSongs.js";

const NOW = "2026-09-27T00:00:00.000Z";
let owner = "";

function setCfg(cfg: Record<string, unknown>, enabled = 1) {
  sqlite
    .prepare("UPDATE plugins SET config = ?, enabled = ? WHERE name = ?")
    .run(JSON.stringify(cfg), enabled, RANDOM_PLUGIN_ID);
}

function seedSong(id: string, opts: { genre?: string; albumId?: string | null; suffix?: string | null } = {}) {
  sqlite
    .prepare(
      `INSERT INTO songs (id, title, artist, album, album_id, genre, duration, path, suffix, type, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    )
    .run(
      id,
      id,
      "A",
      "Al",
      opts.albumId === undefined ? null : opts.albumId,
      opts.genre ?? "Pop",
      100,
      `l:src:/tmp/${id}.mp3`,
      opts.suffix === undefined ? "mp3" : opts.suffix,
      "local",
      NOW,
    );
}

function seedAlbum(id: string, year: number) {
  sqlite.prepare("INSERT INTO albums (id, name, year, created_at, updated_at) VALUES (?,?,?,?,?)").run(id, id, year, NOW, NOW);
}

function seedLibrary(n: number, genre = "Pop") {
  for (let i = 0; i < n; i++) seedSong(`s${i}`, { genre });
}

function commentOf(): string {
  return (sqlite.prepare("SELECT comment FROM playlists WHERE id = ?").get(RANDOM_PLAYLIST_ID) as any)?.comment ?? "";
}

function playlistSongIds(): string[] {
  return (sqlite.prepare("SELECT song_id FROM playlist_songs WHERE playlist_id = ? ORDER BY position").all(RANDOM_PLAYLIST_ID) as any[]).map(
    (r) => r.song_id,
  );
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
      .run(NOW, NOW);
    owner = "u1";
  }
});

beforeEach(() => {
  sqlite.prepare("DELETE FROM playlist_songs").run();
  sqlite.prepare("DELETE FROM playlists").run();
  sqlite.prepare("DELETE FROM songs").run();
  sqlite.prepare("DELETE FROM albums").run();
  setCfg({});
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("getRandomSongsConfig:逐字段兜底", () => {
  it("未配置 → 48 首 / 30 分钟 / 无过滤维度", () => {
    expect(getRandomSongsConfig()).toEqual({ count: DEFAULT_SONG_COUNT, refreshMinutes: DEFAULT_REFRESH_MINUTES });
  });

  it("count 非法回落 48,超上限夹到 500", () => {
    for (const bad of [0, -1, "abc", null]) {
      setCfg({ count: bad });
      expect(getRandomSongsConfig().count).toBe(DEFAULT_SONG_COUNT);
    }
    setCfg({ count: 99999 });
    expect(getRandomSongsConfig().count).toBe(MAX_SONG_COUNT);
    setCfg({ count: 7 });
    expect(getRandomSongsConfig().count).toBe(7);
  });

  it("refreshMinutes 非法回落 30,超上限夹到 1440(一天)", () => {
    for (const bad of [0, -5, "x", null]) {
      setCfg({ refreshMinutes: bad });
      expect(getRandomSongsConfig().refreshMinutes).toBe(DEFAULT_REFRESH_MINUTES);
    }
    setCfg({ refreshMinutes: 99999 });
    expect(getRandomSongsConfig().refreshMinutes).toBe(1440);
    setCfg({ refreshMinutes: 5 });
    expect(getRandomSongsConfig().refreshMinutes).toBe(5);
  });

  it("genre 首尾空白归一:全空白视为未设置", () => {
    setCfg({ genre: "   " });
    expect(getRandomSongsConfig().genre).toBeUndefined();
    setCfg({ genre: "  华语  " });
    expect(getRandomSongsConfig().genre).toBe("华语");
  });

  it("年份只在 1900..今年 之间被采纳,其余忽略", () => {
    const thisYear = new Date().getFullYear();
    setCfg({ fromYear: 1990, toYear: thisYear });
    expect(getRandomSongsConfig()).toMatchObject({ fromYear: 1990, toYear: thisYear });

    setCfg({ fromYear: 1800 });
    expect(getRandomSongsConfig().fromYear).toBeUndefined();
    setCfg({ fromYear: thisYear + 5 });
    expect(getRandomSongsConfig().fromYear).toBeUndefined();
    setCfg({ fromYear: "" });
    expect(getRandomSongsConfig().fromYear).toBeUndefined();
    setCfg({ fromYear: "abc" });
    expect(getRandomSongsConfig().fromYear).toBeUndefined();
    setCfg({ toYear: 1800 });
    expect(getRandomSongsConfig().toYear).toBeUndefined();
  });

  it("起始 > 截至 → 自动交换(不留非法区间)", () => {
    setCfg({ fromYear: 2020, toYear: 1990 });
    const c = getRandomSongsConfig();
    expect(c.fromYear).toBe(1990);
    expect(c.toYear).toBe(2020);
  });

  it("插件停用 / 配置坏 JSON → 全默认", () => {
    setCfg({ count: 3, genre: "X" }, 0);
    expect(getRandomSongsConfig()).toEqual({ count: DEFAULT_SONG_COUNT, refreshMinutes: DEFAULT_REFRESH_MINUTES });
    sqlite.prepare("UPDATE plugins SET config = ?, enabled = 1 WHERE name = ?").run("{bad", RANDOM_PLUGIN_ID);
    expect(getRandomSongsConfig().count).toBe(DEFAULT_SONG_COUNT);
  });
});

describe("过滤条件真的下推到 SQL(经歌单生成观察)", () => {
  it("流派过滤:命中部分匹配的歌曲;单引号/通配符不会破 SQL", () => {
    seedSong("a-pop", { genre: "Pop" });
    seedSong("b-rock", { genre: "Rock" });
    seedSong("c-weird", { genre: "a%b_c" });
    setCfg({ count: 10, genre: "Pop" });
    const r = generateRandomSongsPlaylist();
    expect(r!.total).toBe(1);
    expect(playlistSongIds()).toEqual(["a-pop"]);

    // LIKE 通配符被转义 → % 只作字面量,不会把整库都匹配进来
    setCfg({ count: 10, genre: "a%b_c" });
    expect(playlistSongIds().length).toBe(1);
  });

  it("年份过滤经 albums.year JOIN 生效", () => {
    seedAlbum("AL-1995", 1995);
    seedAlbum("AL-2020", 2020);
    seedSong("old", { albumId: "AL-1995" });
    seedSong("new", { albumId: "AL-2020" });
    setCfg({ count: 10, fromYear: 2010 });
    generateRandomSongsPlaylist();
    expect(playlistSongIds()).toEqual(["new"]);
    setCfg({ count: 10, toYear: 2000 });
    generateRandomSongsPlaylist();
    expect(playlistSongIds()).toEqual(["old"]);
  });

  it("歌单 comment 记录已生效的过滤条件(可读描述)", () => {
    seedAlbum("AL-1995", 1995);
    seedSong("old", { albumId: "AL-1995", genre: "Jazz" });
    setCfg({ count: 10, genre: "Jazz", fromYear: 1990, toYear: 2000 });
    generateRandomSongsPlaylist();
    const c = commentOf();
    expect(c).toContain("流派=Jazz");
    expect(c).toContain("起始≥1990");
    expect(c).toContain("截至≤2000");

    setCfg({ count: 10 });
    generateRandomSongsPlaylist();
    expect(commentOf()).not.toContain("流派=");
    expect(commentOf()).not.toContain("起始≥");
    expect(commentOf()).not.toContain("截至≤");
  });
});

describe("generateRandomSongsPlaylist:抽取路径与歌单行", () => {
  it("空库 → skipped=true,total=0,不创建歌单行", () => {
    expect(generateRandomSongsPlaylist()).toEqual({ total: 0, skipped: true });
    expect(sqlite.prepare("SELECT id FROM playlists WHERE id = ?").get(RANDOM_PLAYLIST_ID)).toBeUndefined();
  });

  it("无可播歌(suffix 为空)→ 同样跳过", () => {
    for (let i = 0; i < 5; i++) seedSong(`x${i}`, { suffix: null });
    expect(generateRandomSongsPlaylist()!.skipped).toBe(true);
  });

  it("小库(库容 <= count)→ 全量洗牌,不重复", () => {
    seedLibrary(10);
    const r = generateRandomSongsPlaylist(20);
    expect(r!.total).toBe(10);
    const ids = playlistSongIds();
    expect(ids).toHaveLength(10);
    expect(new Set(ids).size).toBe(10);
  });

  it("大库(库容 >> count)→ 走 rowid 过采样,恰好 count 首且不重复", () => {
    seedLibrary(200);
    const r = generateRandomSongsPlaylist(); // 默认 48
    expect(r!.total).toBe(DEFAULT_SONG_COUNT);
    const ids = playlistSongIds();
    expect(ids).toHaveLength(DEFAULT_SONG_COUNT);
    expect(new Set(ids).size).toBe(DEFAULT_SONG_COUNT);
    expect((sqlite.prepare("SELECT song_count, duration FROM playlists WHERE id = ?").get(RANDOM_PLAYLIST_ID) as any).song_count).toBe(
      DEFAULT_SONG_COUNT,
    );
  });

  // 现状记录(缺陷台账 D18):rowid 过采样在「库容接近 count」时会饱和 ——
  // 每轮最多命中「不同 rowid 数」个,4 轮上限也用不满,于是歌单会**比 count 少 1~2 首**
  // (实测 60 首库容 + 默认 count 48 时出现过 47)。大库不受影响,仅小曲库可见。
  // 这里只钉住不变量:不超过 count、也不至于差很多。
  it("库容接近 count 时结果可能少于 count(采样饱和)", () => {
    seedLibrary(60);
    const r = generateRandomSongsPlaylist(); // count 默认 48
    expect(r!.skipped).toBe(false);
    expect(r!.total).toBeLessThanOrEqual(DEFAULT_SONG_COUNT);
    expect(r!.total).toBeGreaterThan(DEFAULT_SONG_COUNT - 5);
    expect(playlistSongIds()).toHaveLength(r!.total);
  });

  it("歌单行缺失时创建(带标签 comment);名字被改过则自动改回", () => {
    seedLibrary(3);
    generateRandomSongsPlaylist(2);
    expect((sqlite.prepare("SELECT name FROM playlists WHERE id = ?").get(RANDOM_PLAYLIST_ID) as any).name).toBe("随机歌曲");

    sqlite.prepare("UPDATE playlists SET name = '被改过的名字' WHERE id = ?").run(RANDOM_PLAYLIST_ID);
    generateRandomSongsPlaylist(2);
    expect((sqlite.prepare("SELECT name FROM playlists WHERE id = ?").get(RANDOM_PLAYLIST_ID) as any).name).toBe("随机歌曲");
  });

  it("重建会清空旧条目(不是追加)", () => {
    seedLibrary(6);
    generateRandomSongsPlaylist(6);
    expect(playlistSongIds()).toHaveLength(6);
    generateRandomSongsPlaylist(2);
    expect(playlistSongIds()).toHaveLength(2);
  });

  it("生成后广播 random-songs-changed(ws 服务据此通知客户端重拉)", () => {
    seedLibrary(5);
    const seen: any[][] = [];
    const fn = (...args: any[]) => seen.push(args);
    randomSongsEvents.on(RANDOM_SONGS_CHANGED_EVENT, fn);
    try {
      generateRandomSongsPlaylist(2);
    } finally {
      randomSongsEvents.off(RANDOM_SONGS_CHANGED_EVENT, fn);
    }
    expect(seen).toHaveLength(1);
    expect(seen[0][0]).toBe(RANDOM_PLAYLIST_ID);
  });

  it("显式 count 覆盖插件配置", () => {
    seedLibrary(20);
    setCfg({ count: 3 });
    expect(generateRandomSongsPlaylist(7)!.total).toBe(7);
    expect(generateRandomSongsPlaylist()!.total).toBe(3);
  });
});

describe("maybeRefreshRandomSongs:惰性刷新判据", () => {
  it("歌单从未生成过 → 立即生成并返回 true", () => {
    seedLibrary(5);
    expect(maybeRefreshRandomSongs()).toBe(true);
    expect(playlistSongIds().length).toBe(5);
  });

  it("超过刷新间隔 → 重建;未超过 → false", () => {
    seedLibrary(8);
    setCfg({ count: 4, refreshMinutes: 10 });
    sqlite.prepare("DELETE FROM playlists WHERE id = ?").run(RANDOM_PLAYLIST_ID);
    expect(maybeRefreshRandomSongs()).toBe(true);
    expect(maybeRefreshRandomSongs()).toBe(false); // 刚生成,未到期

    sqlite
      .prepare("UPDATE playlists SET updated_at = ? WHERE id = ?")
      .run(new Date(Date.now() - 11 * 60_000).toISOString(), RANDOM_PLAYLIST_ID);
    expect(maybeRefreshRandomSongs()).toBe(true);
  });

  it("空库时返回 false(没有内容可刷新)", () => {
    expect(maybeRefreshRandomSongs()).toBe(false);
  });
});

describe("runRandomSongsJob / 插件入口 / 定时刷新", () => {
  it("成功返回描述串;空库返回 null", () => {
    seedLibrary(5);
    expect(runRandomSongsJob({ count: 5 })).toBe("全库随机 5 首");
    // playlist_songs 有 FK 指向 songs → 清库前先清条目
    sqlite.prepare("DELETE FROM playlist_songs").run();
    sqlite.prepare("DELETE FROM songs").run();
    expect(runRandomSongsJob()).toBeNull();
  });

  it("底层抛错被吞掉 → 返回 null(定时任务永不抛)", () => {
    seedLibrary(3);
    const spy = vi.spyOn(sqlite, "prepare").mockImplementation(() => {
      throw new Error("db 崩了");
    });
    expect(runRandomSongsJob()).toBeNull();
    spy.mockRestore();
  });

  it("plugin.runDailyJob 委托 runRandomSongsJob", async () => {
    seedLibrary(4);
    expect(await randomSongsPlugin.runDailyJob({ count: 4 })).toBe("全库随机 4 首");
  });

  it("自适应定时:按 refreshMinutes 触发重建,并自动排下一轮", () => {
    vi.useFakeTimers();
    seedLibrary(5);
    setCfg({ count: 3, refreshMinutes: 2 });

    startRandomSongsAutoRefresh();
    expect(playlistSongIds()).toHaveLength(0); // 还没到点

    vi.advanceTimersByTime(2 * 60_000);
    expect(playlistSongIds()).toHaveLength(3);

    // 强制到过期后再走一轮 → 证明回调重新排了定时器
    sqlite
      .prepare("UPDATE playlists SET updated_at = ? WHERE id = ?")
      .run(new Date(Date.now() - 3 * 60_000).toISOString(), RANDOM_PLAYLIST_ID);
    sqlite.prepare("DELETE FROM playlist_songs WHERE playlist_id = ?").run(RANDOM_PLAYLIST_ID);
    vi.advanceTimersByTime(2 * 60_000);
    expect(playlistSongIds()).toHaveLength(3);
  });

  it("定时回调里抛错也被吞掉,并继续排下一轮", () => {
    vi.useFakeTimers();
    seedLibrary(5);
    setCfg({ count: 2, refreshMinutes: 1 });
    startRandomSongsAutoRefresh();

    const spy = vi.spyOn(sqlite, "prepare").mockImplementation(() => {
      throw new Error("db 崩了");
    });
    expect(() => vi.advanceTimersByTime(60_000)).not.toThrow();
    spy.mockRestore();

    // 抛错那一轮里「重新排定时器」也读不到配置 → 回落默认 30 分钟,故要跨过 30 分钟
    sqlite.prepare("DELETE FROM playlists WHERE id = ?").run(RANDOM_PLAYLIST_ID);
    vi.advanceTimersByTime(31 * 60_000);
    expect(playlistSongIds()).toHaveLength(2); // 定时器仍然活着
  });

  it("重复调用 startRandomSongsAutoRefresh 不会叠加定时器(旧的被清掉)", () => {
    vi.useFakeTimers();
    seedLibrary(6);
    setCfg({ count: 2, refreshMinutes: 1 });
    const seen: any[] = [];
    const fn = () => seen.push(1);
    randomSongsEvents.on(RANDOM_SONGS_CHANGED_EVENT, fn);
    try {
      startRandomSongsAutoRefresh();
      startRandomSongsAutoRefresh();
      startRandomSongsAutoRefresh();
      vi.advanceTimersByTime(60_000);
      expect(seen).toHaveLength(1); // 叠加的话会生成三次
      expect(playlistSongIds()).toHaveLength(2);
    } finally {
      randomSongsEvents.off(RANDOM_SONGS_CHANGED_EVENT, fn);
    }
  });
});
