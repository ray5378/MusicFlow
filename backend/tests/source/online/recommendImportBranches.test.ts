// services/source/online/recommendImport.ts 分支补测。
//
// 该文件此前 50 行未覆盖,缺口集中在「每日推荐」的几条业务分支上:
//   ① 超长歌单名截断 / 空名回退
//   ② 远端空歌单(音乐为 0)→ 自动删除本地同名歌单
//   ③ 首次导入建单 vs 二次导入复用同一行(改名 / 补刷封面)
//   ④ 批量全同步的渠道级保险:空渠道不动旧单、收藏单不轮换、导入数不足不清理、
//      清理抛错被吞进 errors
// 这里沿用 recommendImport.lock.test.ts 的姿势:真实插件 + 真实 SQLite,只把
// 「会联网/会睡」的两个副作用面换掉(封面缓存、批间休眠),遍历逻辑因此仍是真实链路。
import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from "vitest";

const f = vi.hoisted(() => ({
  cacheRemoteCover: vi.fn(),
  clearPlaylistCoverCache: vi.fn(),
  sleepBetweenBatch: vi.fn(async () => {}),
}));

vi.mock("../../../src/services/playlistCover.js", async (io) => ({
  ...(await io<Record<string, unknown>>()),
  cacheRemoteCover: f.cacheRemoteCover,
  clearPlaylistCoverCache: f.clearPlaylistCoverCache,
}));

vi.mock("../../../src/services/plugin/batchPacer.js", async (io) => ({
  ...(await io<Record<string, unknown>>()),
  sleepBetweenBatch: f.sleepBetweenBatch,
}));

import { initDatabase, sqlite, db } from "../../../src/db/index.js";
import { playlists, playlistSongs } from "../../../src/db/schema.js";
import { eq } from "drizzle-orm";
import {
  registerPlugin,
  unregisterPlugin,
  getPluginManifest,
  listRegistered,
} from "../../../src/plugins/registry.js";
import {
  importRecommendPlaylist,
  syncAllRecommendPlaylists,
  removePlaylistRows,
  findRecommendPlaylist,
  isDailyRecommendPlaylist,
  recommendSourceUrl,
  DAILY_TAG,
} from "../../../src/services/source/online/recommendImport.js";

const PROVIDER = "ri-branch-prov";
const PREFIX = "rib://recommend/";
const NETEASE = "netease";

const manifest = {
  id: PROVIDER,
  name: PROVIDER,
  version: "1.0.0",
  type: "source",
  capabilities: ["recommend", "playlistSongs", "stream", "search"],
  platforms: [NETEASE],
  configSchema: [],
  permissions: ["net"],
  recommendPrefix: PREFIX,
} as const;

/** 远端一首歌;search 会回显同名同唱者,使导入命中门禁通过。 */
function remoteSong(id = "101", name = "Song") {
  return { id, source: NETEASE, name, artist: "Artist", album: "Album", duration: 200 };
}

interface ImplOpts {
  songs?: any[] | null;
  channels?: any;
  noPlaylistSongs?: boolean;
  noRecommend?: boolean;
  searchMiss?: boolean;
  playlistSongsThrows?: Error;
  recommendThrows?: Error;
  /** 指定远端歌单 id 的 playlistSongs 抛错(用于「某渠道部分导入失败」用例)。 */
  failPlaylistIds?: string[];
}

function makeImpl(o: ImplOpts = {}) {
  const impl: any = {
    id: PROVIDER,
    manifest,
    async recommend() {
      if (o.recommendThrows) throw o.recommendThrows;
      return {
        channels: o.channels ?? [
          { source: NETEASE, playlists: [{ id: "100", source: NETEASE, name: "推荐单", cover: "" }] },
        ],
      };
    },
    async search(_config: any, params: any) {
      if (o.searchMiss) return { songs: [] };
      // 回显 query(与 want 同元数据)→ passesImportGate 全命中
      const [name, artist] = String(params.query || "").split(" ");
      return { songs: [{ id: "101", source: NETEASE, name, artist, album: "Album", duration: 200 }] };
    },
    streamUrl: (_c: any, s: any) => `http://rib/stream?id=${s.id}`,
  };
  if (!o.noPlaylistSongs) {
    impl.playlistSongs = async (_config: any, _source: string, id: string) => {
      if (o.playlistSongsThrows) throw o.playlistSongsThrows;
      if (o.failPlaylistIds?.includes(String(id))) throw new Error(`上游 ${id} 失败`);
      return { songs: o.songs === null ? [] : (o.songs ?? [remoteSong()]) };
    };
  }
  if (o.noRecommend) delete impl.recommend;
  return impl;
}

function registerProvider(o: ImplOpts = {}) {
  const impl = makeImpl(o);
  registerPlugin(manifest as any, impl);
  sqlite.prepare(
    `INSERT INTO plugins (id, name, version, description, manifest, enabled, config, created_at, updated_at)
     VALUES (?,?,?,'','{}',1,'{}',?,?)
     ON CONFLICT(id) DO UPDATE SET enabled=1, config='{}', manifest=excluded.manifest`,
  ).run(PROVIDER, PROVIDER, "1.0.0", new Date().toISOString(), new Date().toISOString());
  return impl;
}

function info(id: string, name: string, cover = "") {
  return { id, source: NETEASE, name, cover } as any;
}

function plRow(id: string): any | undefined {
  return db.select().from(playlists).where(eq(playlists.id, id)).get() as any;
}

function entries(id: string): any[] {
  return db.select().from(playlistSongs).where(eq(playlistSongs.playlistId, id)).all() as any[];
}

/** 预置一条歌单条目。playlist_songs.song_id 有 FK 指向 songs,先补歌曲行。 */
function seedEntry(plId: string, songId: string) {
  sqlite.prepare(
    "INSERT OR IGNORE INTO songs (id, title, artist, album, duration, path, suffix, type, created_at) VALUES (?,?,?,?,?,?,?,?,?)",
  ).run(songId, songId, "WA", "Album", 200, `web:src:/tmp/${songId}`, "mp3", "web", new Date().toISOString());
  sqlite.prepare(
    "INSERT INTO playlist_songs (playlist_id, song_id, position, playable) VALUES (?,?,0,1) ON CONFLICT DO NOTHING",
  ).run(plId, songId);
}

/** 预置一个「昨天」导入的本地歌单。 */
function seedOldPlaylist(id: string, opts: { favorite?: 0 | 1; platform?: string } = {}) {
  const platform = opts.platform ?? NETEASE;
  sqlite.prepare(
    `INSERT INTO playlists (id, name, owner_id, source_url, source_platform, external_id,
       comment, favorite, song_count, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,0,?,?)
     ON CONFLICT(id) DO UPDATE SET source_url=excluded.source_url, favorite=excluded.favorite`,
  ).run(
    id, `旧歌单 ${id}`, "u1", `${PREFIX}${id}`, platform, id,
    "每日推荐歌单·" + platform, opts.favorite ?? 0,
    new Date().toISOString(), new Date().toISOString(),
  );
}

beforeAll(() => {
  initDatabase();
  sqlite.prepare(
    "INSERT OR IGNORE INTO users (id, username, password, salt, subsonic_salt) VALUES (?,?,?,?,?)",
  ).run("u1", "u1", "x", "x", "x");
});

beforeEach(() => {
  f.cacheRemoteCover.mockReset();
  f.clearPlaylistCoverCache.mockReset();
  f.sleepBetweenBatch.mockImplementation(async () => {});
  f.cacheRemoteCover.mockResolvedValue(null);
  sqlite.prepare("DELETE FROM playlist_songs").run();
  sqlite.prepare("DELETE FROM playlists").run();
});

afterAll(() => {
  unregisterPlugin(PROVIDER);
  sqlite.prepare("DELETE FROM plugins WHERE id = ?").run(PROVIDER);
});

describe("recommendImport: 命名与标记", () => {
  it("超长歌单名截断到 18 字并补省略号(保证 WebUI 卡片能带上平台标签)", async () => {
    registerProvider();
    const long = "这是一个非常长的推荐歌单标题需要被截断才能显示完整平台标签";
    const r = await importRecommendPlaylist(PROVIDER, info("1", long), { userId: "u1" });
    expect(r.success).toBe(true);
    expect(r.created).toBe(true);
    expect(r.name.endsWith("…")).toBe(true);
    expect([...r.name].length).toBe(19); // 18 字 + 省略号
  });

  it("恰好 18 字不截断(阈值是 <=,不加省略号)", async () => {
    registerProvider();
    const name = "一二三四五六七八九一二三四五六七八九";
    expect([...name].length).toBe(18);
    const r = await importRecommendPlaylist(PROVIDER, info("1", name), { userId: "u1" });
    expect(r.name).toBe(name);
  });

  // D28 已修复:落库与返回值统一用兜底名「每日推荐」,不再「库里是每日推荐、返回空串」。
  it("空歌单名:D28 已修复 —— 落库与返回值一致,都是「每日推荐」", async () => {
    registerProvider();
    const r = await importRecommendPlaylist(PROVIDER, info("1", ""), { userId: "u1" });
    expect(plRow(r.playlistId!)!.name).toBe("每日推荐");
    expect(r.name).toBe("每日推荐");
  });

  it("recommendSourceUrl 用插件声明的前缀,不是硬编码", () => {
    registerProvider();
    expect(recommendSourceUrl(PROVIDER, "123")).toBe(`${PREFIX}123`);
  });

  it("未注册 / 未声明前缀的插件返回空前缀(退回裸 id)", () => {
    registerProvider();
    // 已注册的 PROVIDER 有前缀;没注册过的 id 取不到 manifest ⇒ 空白前缀
    expect(recommendSourceUrl(PROVIDER, "1")).toBe(PREFIX + "1");
    expect(recommendSourceUrl("prov-从没注册过", "1")).toBe("1");
  });

  it("isDailyRecommendPlaylist 跨所有已注册前缀匹配", () => {
    registerProvider();
    expect(isDailyRecommendPlaylist({ sourceUrl: `${PREFIX}9` })).toBe(true);
    expect(isDailyRecommendPlaylist({ sourceUrl: "http://other/playlist" })).toBe(false);
    expect(isDailyRecommendPlaylist({})).toBe(false);
  });
});

describe("recommendImport: 门禁与空歌单", () => {
  it("provider 没有 playlistSongs 时直接拒导,不建单不落库", async () => {
    registerProvider({ noPlaylistSongs: true });
    const r = await importRecommendPlaylist(PROVIDER, info("1", "x"), { userId: "u1" });
    expect(r.success).toBe(false);
    expect(r.created).toBe(false);
    expect(r.trackCount).toBe(0);
    expect(r.name).toBe("x");
  });

  it("远端歌单音乐为 0 且本地没有 → 不建任何占位", async () => {
    registerProvider({ songs: [] });
    const r = await importRecommendPlaylist(PROVIDER, info("1", "空单"), { userId: "u1" });
    expect(r.success).toBe(false);
    expect(r.created).toBe(false);
    expect(r.failed).toBe(0);
    expect(plRow("pl-")).toBeUndefined();
  });

  it("远端歌单音乐为 0 且本地已有 → 连条目带行一起删掉,并清封面缓存", async () => {
    registerProvider({ songs: [] });
    seedOldPlaylist("99");
    seedEntry("99", "w1");
    const r = await importRecommendPlaylist(PROVIDER, info("99", "空单"), { userId: "u1" });
    expect(r.success).toBe(false);
    expect(plRow("99")).toBeUndefined();
    expect(entries("99").length).toBe(0);
    expect(f.clearPlaylistCoverCache).toHaveBeenCalledWith("99");
  });
});

describe("recommendImport: 首次导入 vs 二次复用", () => {
  it("首次导入建单行,sourceUrl/comment/externalId 都按插件前缀写", async () => {
    registerProvider();
    const r = await importRecommendPlaylist(PROVIDER, info("100", "推荐单"), { userId: "u1" });

    const row = plRow(r.playlistId!);
    expect(r.created).toBe(true);
    expect(row!.sourceUrl).toBe(`${PREFIX}100`);
    expect(row!.comment).toBe("每日推荐歌单·" + NETEASE);
    expect(row!.externalId).toBe("100");
    expect(row!.sourcePlatform).toBe(NETEASE);
    expect(row!.ownerId).toBe("u1");
    expect(row!.isPublic).toBe(0);
  });

  it("传入 userId 时写入该 owner,不是 admin 兜底", async () => {
    registerProvider();
    const r = await importRecommendPlaylist(PROVIDER, info("100", "推荐单"), { userId: "u1" });
    expect(plRow(r.playlistId!)!.ownerId).toBe("u1");
  });

  // D27 已修复:playlists.owner_id 有 FK 指向 users.id,未带 userId 时显式拒绝 ——
  // 不再写空串、不再触发 `FOREIGN KEY constraint failed` 把整单拖失败。
  it("没传 userId → 显式拒绝(success:false),不触发外键异常", async () => {
    registerProvider();
    const r = await importRecommendPlaylist(PROVIDER, info("100", "推荐单"));
    expect(r.success).toBe(false);
    expect(r.created).toBe(false);
    expect(r.trackCount).toBe(0);
    expect(plRow("100")).toBeUndefined();
  });

  it("有封面时落盘缓存后的 collage URL", async () => {
    registerProvider();
    f.cacheRemoteCover.mockResolvedValue("http://cover/pl.jpg");
    const r = await importRecommendPlaylist(PROVIDER, info("100", "推荐单", "http://remote/cover.jpg"), { userId: "u1" });
    expect(f.cacheRemoteCover).toHaveBeenCalledWith("http://remote/cover.jpg", `pl-${r.playlistId}`);
    expect(plRow(r.playlistId!)!.coverArt).toBe("http://cover/pl.jpg");
  });

  it("封面缓存失败时 coverArt 保持 null,不影响导入成功", async () => {
    registerProvider();
    f.cacheRemoteCover.mockResolvedValue(null);
    const r = await importRecommendPlaylist(PROVIDER, info("100", "推荐单", "http://remote/cover.jpg"), { userId: "u1" });
    expect(r.success).toBe(true);
    expect(plRow(r.playlistId!)!.coverArt).toBeNull();
  });

  it("二次导入复用同一行并改名(created:false)", async () => {
    registerProvider();
    const first = await importRecommendPlaylist(PROVIDER, info("100", "旧名字"), { userId: "u1" });
    const second = await importRecommendPlaylist(PROVIDER, info("100", "新名字"), { userId: "u1" });
    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.playlistId).toBe(first.playlistId);
    expect(plRow(first.playlistId!)!.name).toBe("新名字");
  });

  it("二次导入会刷新 comment 与 updatedAt", async () => {
    registerProvider();
    const first = await importRecommendPlaylist(PROVIDER, info("100", "名字"), { userId: "u1" });
    const plId = first.playlistId!;
    // ⚠️ 与 discoveryHost 那条例同一根因:原先靠 `await setTimeout(5)` 让真实时钟
    // 走一格,再去比对 before/after 的 updatedAt —— 时钟被冻结或倒退时两边同值,
    // 用例就会随机红。彻底修法同样是两层:① 把 updatedAt 钉成 2000 年的哨兵旧值;
    // ② 把 Date 冻住 —— 漏写 updatedAt 的实现下行里留的是 INSERT 时间戳,它不是
    // 哨兵,光钉哨兵会误绿,冻住时钟后漏写就只剩哨兵 → 必红。契约不变(二次导入
    // 必须刷 updatedAt),断言与绝对时钟彻底脱钩,5 毫秒空等也一并省掉。
    const SENTINEL = "2000-01-01T00:00:00.000Z";
    const clockNow = Date.now();
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(clockNow);
      sqlite.prepare("UPDATE playlists SET updated_at = ? WHERE id = ?").run(SENTINEL, plId);
      expect(String(plRow(plId)!.updatedAt)).toBe(SENTINEL); // 钉桩成功
      await importRecommendPlaylist(PROVIDER, info("100", "名字"), { userId: "u1" });
    } finally {
      vi.useRealTimers();
    }
    const after = plRow(plId)!;
    expect(String(after.updatedAt)).not.toBe(SENTINEL);
    expect(after.comment).toBe("每日推荐歌单·" + NETEASE);
  });

  it("二次导入会补刷封面(上次拉取早期失败,本地没封面)", async () => {
    registerProvider();
    const first = await importRecommendPlaylist(PROVIDER, info("100", "名字", "http://remote/c.jpg"), { userId: "u1" });
    expect(f.cacheRemoteCover).toHaveBeenCalledTimes(1);
    f.cacheRemoteCover.mockClear();
    f.cacheRemoteCover.mockResolvedValue("http://cover/pl.jpg");
    await importRecommendPlaylist(PROVIDER, info("100", "名字", "http://remote/c.jpg"), { userId: "u1" });
    expect(f.cacheRemoteCover).toHaveBeenCalledTimes(1);
    expect(plRow(first.playlistId!)!.coverArt).toBe("http://cover/pl.jpg");
  });
});

describe("recommendImport: removePlaylistRows", () => {
  it("删除歌单时连带条目与封面缓存一起清掉", () => {
    seedOldPlaylist("55");
    seedEntry("55", "w1");
    removePlaylistRows("55");
    expect(plRow("55")).toBeUndefined();
    expect(entries("55").length).toBe(0);
    expect(f.clearPlaylistCoverCache).toHaveBeenCalledWith("55");
  });

  it("删不存在的歌单不抛错", () => {
    expect(() => removePlaylistRows("pl-不存在")).not.toThrow();
  });
});

describe("recommendImport: findRecommendPlaylist", () => {
  it("带 providerId 时按 sourceUrl 精确查", () => {
    registerProvider();
    seedOldPlaylist("77");
    expect(findRecommendPlaylist("77", PROVIDER)!.id).toBe("77");
    expect(findRecommendPlaylist("78", PROVIDER)).toBeNull();
  });

  it("不带 providerId 时匹配任意已注册前缀", () => {
    registerProvider();
    seedOldPlaylist("77");
    expect(findRecommendPlaylist("77")!.id).toBe("77");
  });
});

// doSyncAll 的渠道重试里有 `await sleep(2500)`(等上游预热),单条用例超时下限要放开。
describe("recommendImport: syncAll 渠道级保险", () => {
  it("provider 缺少 recommend 或 playlistSongs 时报一次失败,不放跑", async () => {
    registerProvider({ noRecommend: true });
    const r = await syncAllRecommendPlaylists(PROVIDER, { userId: "u1" });
    expect(r).toMatchObject({ synced: 0, created: 0, failed: 1, playlists: [] });
    expect(r.errors[0]).toContain("在线源未启用");
  });

  it("某渠道本轮返回空 → 记一条「保留原有歌单」,且清理阶段跳过该渠道", async () => {
    registerProvider({
      channels: [
        { source: NETEASE, playlists: [{ id: "100", source: NETEASE, name: "有货", cover: "" }] },
        { source: "kugou", playlists: [] },
      ],
    });
    seedOldPlaylist("88", { platform: "kugou" });
    const r = await syncAllRecommendPlaylists(PROVIDER, { userId: "u1" });
    expect(r.synced).toBe(1);
    expect(r.errors.some((e) => e.includes("kugou") && e.includes("保留原有歌单"))).toBe(true);
    // 空渠道的旧歌单必须还在
    expect(plRow("88")).toBeDefined();
  });

  it("导入失败计入 errors(负向对照:空歌单则不算失败)", async () => {
    registerProvider({
      channels: [{ source: NETEASE, playlists: [{ id: "100", source: NETEASE, name: "坏单", cover: "" }] }],
      playlistSongsThrows: new Error("上游 500"),
    });
    const r = await syncAllRecommendPlaylists(PROVIDER, { userId: "u1" });
    expect(r.synced).toBe(0);
    expect(r.errors.some((e) => e.includes("坏单") && e.includes("上游 500"))).toBe(true);
    expect(r.failed).toBe(r.errors.length);
  });

  it("单个歌单导入抛异常被吞进 errors,不影响同批其他歌单", async () => {
    registerProvider({
      channels: [
        { source: NETEASE, playlists: [{ id: "101", source: NETEASE, name: "好", cover: "" }] },
        { source: NETEASE, playlists: [{ id: "102", source: NETEASE, name: "坏", cover: "" }] },
      ],
      playlistSongsThrows: new Error("boom"),
    });
    const r = await syncAllRecommendPlaylists(PROVIDER, { userId: "u1" });
    // 两个歌单共享同一个 provider 实现 → 都会失败;但每个都要留下自己的一条错误
    expect(r.errors.length).toBe(2);
    expect(r.errors.every((e) => e.startsWith("[netease]"))).toBe(true);
  });

  // D29 已修复:做清理统计的 `old` 改为在**导入之前**快照,分母回到「昨天的量」,
  // 远端下架的旧歌单才能被正确清理(旧实现把本次新建的单也算进分母 ⇒ 闸门 `n>=m+n` 永假)。
  it("远端已下架的旧歌单会被清理(旧数统计改为导入前快照)", async () => {
    registerProvider();
    seedOldPlaylist("99");
    const r = await syncAllRecommendPlaylists(PROVIDER, { userId: "u1" });
    expect(r.synced).toBe(1);
    expect(plRow("99")).toBeUndefined(); // 已下架旧单被轮换删除
  });

  // 负向对照:昨天有 2 个旧单、今天只导回 1 个(导入数 < 旧数)→ 安全闸仍挡住不删。
  it("今天只导回一部分(导入数 < 旧数)时不会删旧单", async () => {
    registerProvider();
    seedOldPlaylist("99");
    seedOldPlaylist("98");
    const r = await syncAllRecommendPlaylists(PROVIDER, { userId: "u1" });
    expect(r.synced).toBe(1);
    expect(plRow("99")).toBeDefined();
    expect(plRow("98")).toBeDefined();
  });

  // D29 新增①:某渠道本轮有导入失败 → 不清理该渠道旧单(否则会清空还没补回的歌单)。
  // 这里旧数=1、成功导入 1 单 → 单看闸门本会删掉 99;因「失败渠道不清理」保险而保留。
  it("某渠道部分导入失败 → 不清理该渠道旧歌单", async () => {
    registerProvider({
      channels: [
        {
          source: NETEASE,
          playlists: [
            { id: "100", source: NETEASE, name: "今天好", cover: "" },
            { id: "101", source: NETEASE, name: "今天坏", cover: "" },
          ],
        },
      ],
      failPlaylistIds: ["101"],
    });
    seedOldPlaylist("99");
    const r = await syncAllRecommendPlaylists(PROVIDER, { userId: "u1" });
    expect(r.synced).toBe(1); // 100 导入成功
    expect(r.failed).toBeGreaterThan(0); // 101 失败
    expect(plRow("99")).toBeDefined(); // 该渠道有失败 → 旧单不被清
  });

  // D29 新增②:收藏的歌单不参与轮换删除(修复后清理段首次可达,favorite 分支被照到)。
  it("收藏的旧歌单不参与轮换删除(内容照常更新,但不会被清理)", async () => {
    registerProvider();
    seedOldPlaylist("99", { favorite: 1 });
    const r = await syncAllRecommendPlaylists(PROVIDER, { userId: "u1" });
    expect(r.synced).toBe(1);
    expect(plRow("99")).toBeDefined();
  });

  // D29 新增③:清理段 try/catch —— removePlaylistRows 抛错被吞进 errors,不影响整轮。
  it("清理旧歌单抛错被吞进 errors(不影响整轮)", async () => {
    registerProvider();
    seedOldPlaylist("99");
    // 只让「99」的封面缓存清理抛错 → removePlaylistRows("99") 中途抛出、被清理段捕获;
    // 导入「100」用的是别的歌单 id,不受影响。
    f.clearPlaylistCoverCache.mockImplementation((id: string) => {
      if (id === "99") throw new Error("封面缓存清理炸了");
    });
    const r = await syncAllRecommendPlaylists(PROVIDER, { userId: "u1" });
    expect(r.synced).toBe(1);
    expect(r.errors.some((e) => e.includes("删除旧歌单") && e.includes("封面缓存清理炸了"))).toBe(true);
  });

  it("导入结果里带 playlistId/name/trackCount", async () => {
    registerProvider();
    const r = await syncAllRecommendPlaylists(PROVIDER, { userId: "u1" });
    expect(r.playlists).toHaveLength(1);
    expect(r.playlists[0].id).toMatch(/^pl-/);
    expect(r.playlists[0].trackCount).toBeGreaterThan(0);
    expect(r.created).toBe(r.playlists.length);
  });
}, 30_000);

describe("recommendImport: 常量与注册表口径", () => {
  it("DAILY_TAG 仍为「每日推荐」(UI 硬编码按此匹配)", () => {
    expect(DAILY_TAG).toBe("每日推荐");
  });

  it("已注册插件里带 recommendPrefix 的都能被 allRecommendPrefixes 取到", () => {
    registerProvider();
    const prefixes = listRegistered().map((p) => (p.manifest as any).recommendPrefix).filter(Boolean);
    expect(prefixes).toContain(PREFIX);
  });

  it("getPluginManifest 能取回前缀(未注册的 id 返回 undefined)", () => {
    registerProvider();
    expect((getPluginManifest(PROVIDER) as any)?.recommendPrefix).toBe(PREFIX);
    expect(getPluginManifest("prov-不存在")).toBeUndefined();
  });
});
