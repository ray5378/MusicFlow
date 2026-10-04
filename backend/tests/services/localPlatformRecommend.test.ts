// 内置插件「本地随机(按平台)」:首页动态分区的数据源。
//
// 该插件此前**没有任何直接测试** —— 只有 tests/routes/chartLocalPlatRoute.test.ts 从
// 路由侧间接碰过。而它是首页「本地随机」区块的唯一数据源,依赖三处容易回归的细节:
//   ① getConfig 的**静默兜底**(插件行缺失/被停用/配置非数字 → 默认 6 / 20),以及
//      homeCount 的上限夹取(MAX_HOME_COUNT=50);
//   ② 封面 ref 的**归一化**:歌单自身有封面时统一返回不带扩展名的 `pl-<id>`
//      (直接透传 DB 的 `pl-<id>.jpg` 会让 getCoverArt 把 `.jpg` 混进歌单 id 查库 → 封面空白);
//      自身无封面时回落到「歌单内可播歌曲的封面」随机一张,再没有才 null;
//   ③ 任何读库异常都必须被吞掉并返回空 channels(首页区块宁可不显示,不能 500)。
//
// MUST be the first import: redirects DATA_DIR to an isolated temp dir.
import "../plugins/_env.js";

import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from "vitest";
import fs from "fs";
import path from "path";
import { initDatabase, sqlite } from "../../src/db/index.js";
import { registerBuiltinPlugins } from "../../src/plugins/builtins.js";
import { clearCoverResolveCache } from "../../src/services/playlistCover.js";
import {
  recommendLocalPlatforms,
  localPlatformRecommendPlugin,
  localPlatformRecommendManifest,
  invalidatePlatformPool,
  LOCAL_PLATFORM_REC_PLUGIN_ID,
} from "../../src/services/plugin/localPlatformRecommend.js";
import { getPlaylistCover } from "../../src/services/playlistCover.js";

const NOW = "2026-09-27T00:00:00.000Z";
let owner = "";

function coversDir(): string {
  return path.join(process.env.DATA_DIR as string, "covers");
}

/** 写一个真实存在的封面文件(resolveCoverFile 会 stat 校验,不存在的 ref 一律视为无封面)。 */
function writeCover(name: string) {
  fs.mkdirSync(coversDir(), { recursive: true });
  fs.writeFileSync(path.join(coversDir(), name), "x");
}

function setPluginConfig(cfg: Record<string, unknown>, enabled = 1) {
  sqlite
    .prepare("UPDATE plugins SET config = ?, enabled = ? WHERE name = ?")
    .run(JSON.stringify(cfg), enabled, LOCAL_PLATFORM_REC_PLUGIN_ID);
}

function seedPlaylist(
  id: string,
  platform: string | null,
  opts: { name?: string; coverArt?: string | null; songCount?: number } = {},
) {
  sqlite
    .prepare(
      `INSERT INTO playlists (id, name, owner_id, is_public, comment, cover_art, song_count, duration,
                              sync_enabled, source_platform, created_at, updated_at)
       VALUES (?,?,?,1,'',?,?,0,0,?,?,?)`,
    )
    .run(
      id,
      opts.name ?? id,
      owner,
      opts.coverArt ?? null,
      opts.songCount ?? 0,
      platform,
      NOW,
      NOW,
    );
}

/** 给歌单塞一首带封面的可播歌(供「歌手自身无封面 → 抽歌内封面」的兜底分支)。 */
function seedPlayableSong(playlistId: string, songId: string, coverRef: string | null) {
  sqlite
    .prepare(
      `INSERT INTO songs (id, title, artist, album, duration, path, suffix, type, cover_art, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?)`,
    )
    .run(songId, songId, "A", "Al", 100, `l:src:/tmp/${songId}.mp3`, "mp3", "local", coverRef, NOW);
  sqlite
    .prepare(
      `INSERT INTO playlist_songs (playlist_id, song_id, position, playable, created_at) VALUES (?,?,?,1,?)`,
    )
    .run(playlistId, songId, 0, NOW);
}

function bySource(channels: any[]): Record<string, any> {
  const m: Record<string, any> = {};
  for (const c of channels) m[c.source] = c;
  return m;
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
  // 封面文件在**任何一次 resolveCoverFile 之前**就位(解析结果会被进程内缓存)。
  writeCover("pl-p-self.jpg");
  writeCover("cv-song.jpg");
});

beforeEach(() => {
  sqlite.prepare("DELETE FROM playlist_songs").run();
  sqlite.prepare("DELETE FROM playlists").run();
  sqlite.prepare("DELETE FROM songs").run();
  clearCoverResolveCache();
  // P0-3:候选池是进程内缓存,跨用例必须清空,否则前一用例的候选集合会串味。
  invalidatePlatformPool();
  setPluginConfig({}, 1);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("recommendLocalPlatforms:分组与平台名", () => {
  it("库里没有任何带平台歌单 → channels 为空数组(不报错)", () => {
    expect(recommendLocalPlatforms()).toEqual({ channels: [] });
  });

  it("按 source_platform 分组;平台显示名走插件自带词典,未知平台回落 slug", () => {
    seedPlaylist("p-n1", "netease", { name: "云1", songCount: 11 });
    seedPlaylist("p-n2", "netease", { name: "云2" });
    seedPlaylist("p-q1", "qq");
    seedPlaylist("p-x1", "some-new-platform");

    const ch = recommendLocalPlatforms().channels;
    expect(ch).toHaveLength(3);
    const m = bySource(ch);
    expect(m.netease.name).toBe("网易云");
    expect(m.netease.count).toBe(2);
    expect(m.qq.name).toBe("QQ 音乐");
    expect(m.qq.count).toBe(1);
    expect(m["some-new-platform"].name).toBe("some-new-platform"); // 词典没有就原样
    // 所有平台共用插件配置里的 sortOrder(默认 20)
    expect(ch.every((c) => c.sortOrder === 20)).toBe(true);
  });

  it("歌单项:imported 恒 true,songCount 取 song_count,coverArt 为归一化 ref", () => {
    seedPlaylist("p-self", "netease", { name: "有封面", coverArt: "pl-p-self.jpg", songCount: 7 });
    const c = recommendLocalPlatforms().channels[0];
    expect(c.playlists).toHaveLength(1);
    const p = c.playlists[0];
    expect(p.id).toBe("p-self");
    expect(p.name).toBe("有封面");
    expect(p.songCount).toBe(7);
    expect(p.imported).toBe(true);
    // ① 歌单自身有可解析封面 → 必须是不带扩展名的 `pl-<id>`
    expect(p.coverArt).toBe("pl-p-self");
  });

  it("source_platform 为空串的歌单不计入任何分组", () => {
    seedPlaylist("p-empty", "");
    seedPlaylist("p-null", null);
    seedPlaylist("p-ok", "netease");
    const ch = recommendLocalPlatforms().channels;
    expect(ch).toHaveLength(1);
    expect(ch[0].source).toBe("netease");
    expect(ch[0].playlists.map((p: any) => p.id)).toEqual(["p-ok"]);
  });
});

describe("recommendLocalPlatforms:homeCount / sortOrder 配置", () => {
  it("homeCount 生效:每组随机取 N 个", () => {
    for (let i = 0; i < 4; i++) seedPlaylist(`p-n${i}`, "netease");
    setPluginConfig({ homeCount: 2 });
    const ch = recommendLocalPlatforms().channels;
    expect(ch[0].count).toBe(2);
    expect(ch[0].playlists).toHaveLength(2);
    // 抽到的都是库里真实存在的歌单
    const ids = ch[0].playlists.map((p: any) => p.id);
    expect(new Set(ids).size).toBe(2);
    for (const id of ids) expect(id.startsWith("p-n")).toBe(true);
  });

  it("homeCount 非法(0 / 非数字 / 负数)→ 回落默认 6", () => {
    for (let i = 0; i < 8; i++) seedPlaylist(`p-n${i}`, "netease");
    for (const bad of [0, -3, "abc", null, undefined]) {
      setPluginConfig({ homeCount: bad });
      expect(recommendLocalPlatforms().channels[0].count).toBe(6);
    }
  });

  it("homeCount 超上限 → 夹到 MAX_HOME_COUNT(50),不是无限", () => {
    for (let i = 0; i < 55; i++) seedPlaylist(`p-b${String(i).padStart(2, "0")}`, "bulk");
    setPluginConfig({ homeCount: 999 });
    expect(recommendLocalPlatforms().channels[0].count).toBe(50);
  });

  it("sortOrder 生效;非法值回落 20", () => {
    seedPlaylist("p-n", "netease");
    setPluginConfig({ sortOrder: 5 });
    expect(recommendLocalPlatforms().channels[0].sortOrder).toBe(5);
    for (const bad of [0, -1, "x", null]) {
      setPluginConfig({ sortOrder: bad });
      expect(recommendLocalPlatforms().channels[0].sortOrder).toBe(20);
    }
  });

  it("插件行被停用(enabled=0)或配置坏 JSON → 走默认值 6 / 20", () => {
    seedPlaylist("p-n", "netease");
    setPluginConfig({ homeCount: 2, sortOrder: 77 }, 0); // 停用 → 查不到行
    let c = recommendLocalPlatforms().channels[0];
    expect(c.count).toBe(1); // 只有 1 个歌单,默认 6 也取 1
    expect(c.sortOrder).toBe(20);

    // 坏 JSON:JSON.parse 抛错 → catch 兜底
    sqlite
      .prepare("UPDATE plugins SET config = ?, enabled = 1 WHERE name = ?")
      .run("{not-json", LOCAL_PLATFORM_REC_PLUGIN_ID);
    c = recommendLocalPlatforms().channels[0];
    expect(c.sortOrder).toBe(20);
  });
});

describe("recommendLocalPlatforms:封面回落链", () => {
  it("歌单自身无封面 → 从歌单内可播歌曲的封面里抽一张", () => {
    seedPlaylist("p-nofile", "netease", { coverArt: "pl-p-nofile.jpg" }); // 文件不存在 → 解析失败
    seedPlayableSong("p-nofile", "s-cov", "cv-song.jpg");
    const p = recommendLocalPlatforms().channels[0].playlists[0];
    expect(p.coverArt).toBe("cv-song.jpg");
  });

  it("歌单自身与歌内都没有封面 → coverArt 为 null(前端显示占位符)", () => {
    seedPlaylist("p-bare", "netease"); // 无 cover_art,无歌
    expect(recommendLocalPlatforms().channels[0].playlists[0].coverArt).toBeNull();
  });

  it("歌内的封面文件不存在(断链)→ 同样回落 null,不返回假 ref", () => {
    seedPlaylist("p-dead", "netease");
    seedPlayableSong("p-dead", "s-dead", "no-such-cover.jpg");
    expect(recommendLocalPlatforms().channels[0].playlists[0].coverArt).toBeNull();
  });
});

describe("recommendLocalPlatforms:异常吞掉", () => {
  it("读库抛错 → 返回空 channels(首页区块不因此 500)", () => {
    seedPlaylist("p-n", "netease");
    vi.spyOn(sqlite, "prepare").mockImplementation(() => {
      throw new Error("db boom");
    });
    expect(recommendLocalPlatforms()).toEqual({ channels: [] });
  });
});

describe("插件清单与入口", () => {
  it("manifest:recommender 类型 + localPlatformRecommend 能力(不占 /v1/recommend)", () => {
    expect(localPlatformRecommendManifest.id).toBe(LOCAL_PLATFORM_REC_PLUGIN_ID);
    expect(localPlatformRecommendManifest.type).toBe("recommender");
    expect(localPlatformRecommendManifest.capabilities).toEqual(["localPlatformRecommend"]);
    expect(localPlatformRecommendManifest.defaultEnabled).toBe(true);
  });

  it("manifest:两个配置项默认值 6 / 20,并带上调度字段", () => {
    const byKey: Record<string, any> = {};
    for (const f of localPlatformRecommendManifest.configSchema) byKey[f.key] = f;
    expect(byKey.homeCount.default).toBe(6);
    expect(byKey.homeCount.type).toBe("number");
    expect(byKey.sortOrder.default).toBe(20);
    // SCHEDULE_FIELDS 展开:至少含 scheduleEnabled
    expect(byKey.scheduleEnabled).toBeDefined();
  });

  it("manifest:i18n.en 带平台词典(与中文词典同键集)", () => {
    const en = (localPlatformRecommendManifest.i18n as any)?.en;
    expect(en?.name).toBeTruthy();
    expect(en.platformLabels.netease).toBe("NetEase Cloud");
    expect(Object.keys(en.platformLabels).sort()).toEqual(
      ["bytedance", "kugou", "kuwo", "local", "migu", "netease", "qq", "soundcloud", "ximalaya", "youtube"].sort(),
    );
  });

  it("recommendLocal() 直接转发 recommendLocalPlatforms()", async () => {
    seedPlaylist("p-fwd", "qq");
    const r = await localPlatformRecommendPlugin.recommendLocal();
    expect(r.channels).toHaveLength(1);
    expect(r.channels[0].source).toBe("qq");
  });
});


describe("P0-2/P0-3:封面语义等价 + 候选池缓存 + 显式失效", () => {
  it("coverArt 语义与 getPlaylistCover 逐字等价(同列 / 同扩展名门 / 同 resolveCoverFile)", () => {
    // 自身封面(小写扩展名)存在 → pl-<id>
    writeCover("pl-p-a.jpg");
    seedPlaylist("p-a", "netease", { coverArt: "pl-p-a.jpg" });
    // 大写扩展名同样命中(正则 /i)→ pl-<id>
    writeCover("pl-p-b.PNG");
    seedPlaylist("p-b", "netease", { coverArt: "pl-p-b.PNG" });
    // 无扩展名的 cover_art → 不算自身封面(getPlaylistCover 亦返回 null)→ 无歌 → null
    seedPlaylist("p-c", "netease", { coverArt: "pl-p-c" });

    const byId: Record<string, any> = {};
    for (const p of recommendLocalPlatforms().channels[0].playlists) byId[p.id] = p;

    expect(byId["p-a"].coverArt).toBe("pl-p-a");
    expect(byId["p-b"].coverArt).toBe("pl-p-b");
    expect(byId["p-c"].coverArt).toBeNull();

    // 直接对照详情页解析路径:非空/空与被测函数一致(证明未改变语义)。
    expect(getPlaylistCover("p-a")).not.toBeNull();
    expect(getPlaylistCover("p-b")).not.toBeNull();
    expect(getPlaylistCover("p-c")).toBeNull();
  });

  it("TTL 内候选集合不变、但每次仍重新洗牌(随机性 100% 保留)", () => {
    for (let i = 0; i < 6; i++) seedPlaylist(`p-r${i}`, "netease");
    setPluginConfig({ homeCount: 6 }); // 池大小 == homeCount → 集合恒定,只有顺序可能变
    const first = recommendLocalPlatforms().channels[0].playlists.map((p: any) => p.id);
    expect(new Set(first).size).toBe(6);

    const seenOrders = new Set<string>([first.join(",")]);
    for (let i = 0; i < 25; i++) {
      const ids = recommendLocalPlatforms().channels[0].playlists.map((p: any) => p.id);
      // 候选集合始终相同(TTL 内不再重查库)
      expect(new Set(ids)).toEqual(new Set(first));
      seenOrders.add(ids.join(","));
    }
    // 25 次里至少出现 2 种不同顺序(6! 排列,几乎不可能全同 → 证明洗牌未被缓存吞掉)
    expect(seenOrders.size).toBeGreaterThan(1);
  });

  it("TTL 内候选池只查库一次(稳态不再叠加 DB 往返)", () => {
    seedPlaylist("p-n1", "netease");
    seedPlaylist("p-n2", "qq");
    const spy = vi.spyOn(sqlite, "prepare");
    recommendLocalPlatforms();
    recommendLocalPlatforms();
    const poolQueries = spy.mock.calls.filter((a: any) => /FROM playlists/i.test(String(a[0]))).length;
    expect(poolQueries).toBe(1);
  });

  it("invalidatePlatformPool() 后立即重建(新导入歌单立即可见)", () => {
    seedPlaylist("p-old", "netease");
    setPluginConfig({ homeCount: 50 });
    expect(recommendLocalPlatforms().channels[0].playlists.map((p: any) => p.id)).toEqual(["p-old"]);
    // 新增歌单但在 TTL 内 → 缓存未失效,仍只看到旧的
    seedPlaylist("p-new", "netease");
    expect(recommendLocalPlatforms().channels[0].playlists.map((p: any) => p.id)).toEqual(["p-old"]);
    // 显式失效 → 立即重建,新歌单可见
    invalidatePlatformPool();
    const ids = recommendLocalPlatforms().channels[0].playlists.map((p: any) => p.id);
    expect(new Set(ids)).toEqual(new Set(["p-old", "p-new"]));
  });
});
