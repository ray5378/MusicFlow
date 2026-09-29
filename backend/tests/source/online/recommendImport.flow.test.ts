// ==================== 每日推荐:导入 / 匹配 / 首选源 的状态机与收口 ====================
//
// 被测:src/services/source/online/recommendImport.ts
//   - 标记层:recommendSourceUrl / isDailyRecommendPlaylist / findRecommendPlaylist /
//            removePlaylistRows(「这条推荐是不是已经导过、导到哪儿了」的唯一判据)
//   - 单曲歌单层:importRecommendPlaylist(upsert 幂等 / 空歌单自删 / 名称截断 / 封面)
//   - 整轮同步层:syncAllRecommendPlaylists(抓取重试 → 并发导入 → 安全清理)
//
// 为什么值得锁:整轮同步的最后一步会**删歌单**。删错就是用户数据没了,所以「什么时候
// 允许删」是这个文件里最硬的契约:渠道抓空不删、导入数比旧数少不删、收藏的不删。
// 这里把三条禁令各钉一条用例。
//
// 手法:DB 用真实 SQLite(每文件独立 DATA_DIR,见 tests/setup.ts);网络/封面/插件注册表/
//       批量闸全部用 vi.hoisted 句柄做替身,不连任何真外部服务。
// MUST be the first import: 隔离 DATA_DIR(见 tests/setup.ts / tests/plugins/_env.ts)。
import "../../plugins/_env.js";

import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import { db, initDatabase, sqlite } from "../../../src/db/index.js";
import { playlists, playlistSongs } from "../../../src/db/schema.js";
import { eq } from "drizzle-orm";
import type { OnlinePlaylistInfo } from "../../../src/services/source/online/types.js";

// ── 被替身的外部世界 ────────────────────────────────────────────────────────
const H = vi.hoisted(() => ({
  /** providerId → 插件清单里声明的 recommendPrefix(undefined = 该插件没有推荐源)。 */
  prefixes: {} as Record<string, string | undefined>,
  /** listRegistered() 的返回(只需 manifest 字段)。 */
  registered: [] as { manifest: any }[],
  /** getConfiguredProvider() 的返回;null = 在线源未启用。 */
  configured: null as null | { provider: any; config: any },
  /** provider.recommend() 的返回序列(用尽后复用最后一个)。 */
  recommendSeq: [] as any[],
  recommendCalls: 0,
  /** provider.playlistSongs(config, source, id) → 该歌单的上游曲目。 */
  songsByPlaylist: {} as Record<string, any[]>,
  /** crossVerifySongs 的替身:默认原样放行;可换成「全拒」。 */
  verifyMode: "pass" as "pass" | "reject-all",
  /** importOnlineSongs 的产物。null = 从传入的候选原样派生(默认,最贴近真实语义)。 */
  impSongs: null as null | { id: string; title: string }[],
  impAdded: 0,
  impDeduped: 0,
  impFailed: 0,
  importCalls: [] as { pid: string; list: any[]; opts: any }[],
  /** cacheRemoteCover 的返回;null = 缓存失败。 */
  cover: null as null | string,
  coverCalls: [] as { url: string; key: string; force: boolean | undefined }[],
  clearCoverCalls: [] as string[],
  lockAcquired: 0,
  lockReleased: 0,
  sleepCalls: 0,
}));

vi.mock("../../../src/plugins/registry.js", async (io) => {
  const orig = await io<any>();
  return {
    ...orig,
    getPluginManifest: (id: string) =>
      id in H.prefixes ? { id, recommendPrefix: H.prefixes[id] } : undefined,
    listRegistered: () => H.registered,
  };
});

// 在线源的三条外部依赖全部替身:
//   index.js(getConfiguredProvider)/ service.js(importOnlineSongs)/ match.js(crossVerifySongs)
// ——真实实现会走插件宿主 + HTTP,这里只关心 recommendImport 自己的编排与收口。
vi.mock("../../../src/services/source/online/index.js", () => ({
  getConfiguredProvider: () => H.configured,
}));

vi.mock("../../../src/services/source/online/service.js", () => ({
  importOnlineSongs: async (pid: string, list: any[], opts?: any) => {
    H.importCalls.push({ pid, list, opts });
    return {
      added: H.impAdded,
      deduped: H.impDeduped,
      failed: H.impFailed,
      songs: H.impSongs ?? list.map((s) => ({ id: String(s.id), title: s.name || String(s.id) })),
    };
  },
}));

vi.mock("../../../src/services/source/online/match.js", () => ({
  crossVerifySongs: async (_pid: string, _cfg: any, _p: any, list: any[]) => {
    if (H.verifyMode === "reject-all") return { verified: [], rejected: list.length };
    return { verified: list, rejected: 0 };
  },
}));

vi.mock("../../../src/services/playlistCover.js", () => ({
  cacheRemoteCover: async (url: string, key: string, force?: boolean) => {
    H.coverCalls.push({ url, key, force });
    return H.cover;
  },
  clearPlaylistCoverCache: (id: string) => {
    H.clearCoverCalls.push(id);
  },
}));

vi.mock("../../../src/services/plugin/batchPacer.js", () => ({
  acquireBatchLock: async () => {
    H.lockAcquired++;
    return () => {
      H.lockReleased++;
    };
  },
  sleepBetweenBatch: async () => {
    H.sleepCalls++;
  },
}));

import {
  recommendSourceUrl,
  isDailyRecommendPlaylist,
  findRecommendPlaylist,
  removePlaylistRows,
  importRecommendPlaylist,
  syncAllRecommendPlaylists,
} from "../../../src/services/source/online/recommendImport.js";

const PREFIX = "gmdl://recommend/";
const PID = "gmdl";

function plInfo(id: string, name: string, source = "qq", cover = ""): OnlinePlaylistInfo {
  return { id, name, source, creator: "c", cover, trackCount: "10", link: "" } as OnlinePlaylistInfo;
}

/** 上游歌单 → 曲目(用平台 id 当名字,方便反查)。 */
function setSongs(id: string, songs: string[]) {
  H.songsByPlaylist[id] = songs.map((s) => ({
    name: `T-${s}`,
    artist: "A",
    album: "Al",
    duration: 200,
    source: "qq",
    id: s,
  }));
}

// playlists.owner_id 有外键指向 users,插歌单前必须有对应的用户行。
// D27 修复后 importRecommendPlaylist 要求显式 userId(不再落空串撞 FK),用例统一传
// "u1" / "u-42" / "u-1";空 id 已无引用,故不再播种。
const OWNER_IDS = ["u1", "u-42", "u-1"];
function seedUsers() {
  const stmt = sqlite.prepare(
    `INSERT OR IGNORE INTO users (id, username, password, salt, subsonic_salt) VALUES (?,?,?,?,?)`,
  );
  OWNER_IDS.forEach((id, i) => stmt.run(id, `owner-${i}`, "x", "x", "x"));
}

function seedSong(id: string) {
  sqlite
    .prepare(
      `INSERT OR IGNORE INTO songs (id,title,artist,album,duration,path,suffix,type,created_at)
       VALUES (?,?,?,?,?,?,?,?,?)`,
    )
    .run(id, `T-${id}`, "A", "Al", 200, `web:src:/tmp/${id}`, "mp3", "web", new Date().toISOString());
}

function seedPlaylist(id: string, over: Record<string, any> = {}) {
  seedUsers();
  const now = new Date().toISOString();
  sqlite
    .prepare(
      `INSERT INTO playlists (id,name,owner_id,is_public,comment,cover_art,song_count,duration,
        sync_enabled,favorite,source_url,source_platform,external_id,created_at,updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    )
    .run(
      id,
      over.name ?? id,
      over.ownerId ?? "u1",
      over.isPublic ?? 0,
      over.comment ?? "",
      over.coverArt ?? null,
      0,
      0,
      0,
      over.favorite ?? 0,
      over.sourceUrl ?? null,
      over.sourcePlatform ?? null,
      over.externalId ?? null,
      now,
      now,
    );
}

const allPlaylists = () => db.select().from(playlists).all();
const playlistRow = (id: string) => db.select().from(playlists).where(eq(playlists.id, id)).get();
const entrySongIds = (id: string) =>
  db
    .select()
    .from(playlistSongs)
    .where(eq(playlistSongs.playlistId, id))
    .all()
    .sort((a, b) => a.position - b.position)
    .map((e) => e.songId);
const entryPlayable = (id: string) =>
  db
    .select()
    .from(playlistSongs)
    .where(eq(playlistSongs.playlistId, id))
    .all()
    .map((e) => e.playable);

beforeAll(() => {
  if (!process.env.APP_VERSION) process.env.APP_VERSION = "1.0.0";
  initDatabase();
});

beforeEach(() => {
  // 每个用例从一个干净的世界出发(全量套件是 shuffle 的,用例必须互不依赖)。
  sqlite.prepare("DELETE FROM playlist_songs").run();
  sqlite.prepare("DELETE FROM playlists").run();
  sqlite.prepare("DELETE FROM songs").run();
  seedUsers();
  for (const id of ["w1", "w2", "w3", "w4", "w5", "w6"]) seedSong(id);

  H.prefixes = { [PID]: PREFIX };
  H.registered = [{ manifest: { recommendPrefix: PREFIX } }];
  H.recommendSeq = [];
  H.recommendCalls = 0;
  H.songsByPlaylist = {};
  H.verifyMode = "pass";
  H.impSongs = null;
  H.impAdded = 2;
  H.impDeduped = 0;
  H.impFailed = 0;
  H.importCalls.length = 0;
  H.cover = null;
  H.coverCalls.length = 0;
  H.clearCoverCalls.length = 0;
  H.lockAcquired = 0;
  H.lockReleased = 0;
  H.sleepCalls = 0;

  H.configured = {
    config: { cookie: "x" },
    provider: {
      recommend: async () => {
        H.recommendCalls++;
        const idx = Math.min(H.recommendCalls - 1, H.recommendSeq.length - 1);
        return H.recommendSeq[idx];
      },
      playlistSongs: async (_cfg: any, _src: string, id: string) => ({
        songs: H.songsByPlaylist[id] || [],
      }),
    },
  };
});

// ═══════════════════════════════════════════════════════════════════════════
describe("推荐源标记:这条本地歌单是不是「每日推荐」导进来的", () => {
  it("recommendSourceUrl 用插件清单声明的前缀,不硬编码", () => {
    // 前缀来自插件声明 ⇒ 接第二个聚合源时不用改 recommendImport 这个文件。
    expect(recommendSourceUrl(PID, "42")).toBe(`${PREFIX}42`);
    H.prefixes[PID] = "other://rec/";
    expect(recommendSourceUrl(PID, "42")).toBe("other://rec/42");
  });

  it("插件没声明 recommendPrefix → 前缀为空串,且绝不会把任意歌单误判成推荐歌单", () => {
    // 空前缀若不滤掉,`startsWith("")` 恒真 ⇒ 清理逻辑会把用户自建歌单全删了。
    H.prefixes = { [PID]: undefined };
    H.registered = [{ manifest: {} }];
    expect(recommendSourceUrl(PID, "42")).toBe("42");
    expect(isDailyRecommendPlaylist({ sourceUrl: "随便一个自建歌单" })).toBe(false);
    expect(isDailyRecommendPlaylist({ sourceUrl: null })).toBe(false);
  });

  it("isDailyRecommendPlaylist:前缀命中才认;前缀以外的 sourceUrl 一律 false", () => {
    expect(isDailyRecommendPlaylist({ sourceUrl: `${PREFIX}1` })).toBe(true);
    expect(isDailyRecommendPlaylist({ sourceUrl: "gmdl://playlist/1" })).toBe(false);
    expect(isDailyRecommendPlaylist({ sourceUrl: "" })).toBe(false);
    expect(isDailyRecommendPlaylist({})).toBe(false);
  });

  it("findRecommendPlaylist(id, providerId) 按「该源前缀 + id」精确命中,不串台到别的源", () => {
    seedPlaylist("pl-a", { sourceUrl: `${PREFIX}7`, externalId: "7" });
    seedPlaylist("pl-b", { sourceUrl: `other://rec/7`, externalId: "7" });
    const hit = findRecommendPlaylist("7", PID);
    expect(hit?.id).toBe("pl-a");
    expect(findRecommendPlaylist("8", PID)).toBeNull();
  });

  it("findRecommendPlaylist(id) 不带 providerId → 任一注册前缀的都算命中(upsert 查找口)", () => {
    // 同步/清理路径拿不到 providerId 时靠这个口子找回已导入的歌单,保证幂等不重复建。
    seedPlaylist("pl-a", { sourceUrl: `${PREFIX}7`, externalId: "7" });
    expect(findRecommendPlaylist("7")?.id).toBe("pl-a");
    expect(findRecommendPlaylist("999")).toBeNull();
  });

  it("removePlaylistRows:条目 + 歌单行一起删,并清掉封面缓存(不留孤儿)", () => {
    seedPlaylist("pl-x", { sourceUrl: `${PREFIX}7` });
    sqlite
      .prepare("INSERT INTO playlist_songs (playlist_id,song_id,position,playable) VALUES (?,?,?,?)")
      .run("pl-x", "w1", 0, 1);
    removePlaylistRows("pl-x");
    expect(playlistRow("pl-x")).toBeUndefined();
    expect(entrySongIds("pl-x")).toEqual([]);
    expect(H.clearCoverCalls).toContain("pl-x");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe("importRecommendPlaylist:单歌单的 upsert / 自删 / 收口", () => {
  it("在线源未配置 → success:false 且一个库行都不落(没源就不造空歌单)", async () => {
    H.configured = null;
    const r = await importRecommendPlaylist(PID, plInfo("r1", "推荐一"), { userId: "u1" });
    expect(r).toMatchObject({ success: false, created: false, trackCount: 0, added: 0, deduped: 0, failed: 0 });
    expect(allPlaylists()).toHaveLength(0);
    expect(H.importCalls).toHaveLength(0);
  });

  it("provider 缺 playlistSongs → 同样拒导,不落库", async () => {
    H.configured = { config: {}, provider: { recommend: async () => ({ channels: [] }) } };
    const r = await importRecommendPlaylist(PID, plInfo("r1", "推荐一"), { userId: "u1" });
    expect(r.success).toBe(false);
    expect(allPlaylists()).toHaveLength(0);
  });

  it("首次导入 → created:true,落全标记字段,条目按上游顺序 playable=1", async () => {
    setSongs("r1", ["w1", "w2"]);
    const r = await importRecommendPlaylist(PID, plInfo("r1", "推荐一", "qq", "http://c/1.jpg"), {
      userId: "u-42",
    });
    expect(r).toMatchObject({ success: true, created: true, trackCount: 2, name: "推荐一" });
    const row = playlistRow(r.playlistId!)!;
    // sourceUrl 是后续「这条推荐导过没」的唯一判据;externalId 是清理时反解 remote id 用。
    expect(row.sourceUrl).toBe(`${PREFIX}r1`);
    expect(row.externalId).toBe("r1");
    expect(row.sourcePlatform).toBe("qq");
    expect(row.comment).toBe("每日推荐歌单·qq");
    expect(row.ownerId).toBe("u-42");
    expect(row.isPublic).toBe(0); // 导入歌单默认私有
    expect(row.syncEnabled).toBe(0); // 每日推荐由同步整体重写,不参与单歌单同步
    expect(entrySongIds(row.id)).toEqual(["w1", "w2"]);
    expect(entryPlayable(row.id)).toEqual([1, 1]);
    expect(row.songCount).toBe(2); // 计数被刷新过(不是落库时的 0)
  });

  it("同一条推荐再导一次 → 复用同一歌单(幂等 upsert,不重复建)", async () => {
    setSongs("r1", ["w1", "w2"]);
    const a = await importRecommendPlaylist(PID, plInfo("r1", "推荐一"), { userId: "u1" });
    const b = await importRecommendPlaylist(PID, plInfo("r1", "推荐一"), { userId: "u1" });
    expect(b.created).toBe(false);
    expect(b.playlistId).toBe(a.playlistId);
    expect(allPlaylists()).toHaveLength(1);
  });

  it("再导入 = 整单替换:不在新集合里的旧条目被删,新增的补上", async () => {
    setSongs("r1", ["w1", "w2"]);
    const a = await importRecommendPlaylist(PID, plInfo("r1", "推荐一"), { userId: "u1" });
    H.impSongs = [
      { id: "w2", title: "W2" },
      { id: "w3", title: "W3" },
    ];
    await importRecommendPlaylist(PID, plInfo("r1", "推荐一"), { userId: "u1" });
    // 「今天的推荐」语义 = 全量替换,不是往里追加,否则歌单会无限膨胀。
    expect(entrySongIds(a.playlistId!)).toEqual(["w2", "w3"]);
    expect(playlistRow(a.playlistId!)!.songCount).toBe(2);
  });

  it("上游 0 首(交叉验证后为空)→ 删掉已存在的本地歌单,不留空占位", async () => {
    setSongs("r1", []);
    H.verifyMode = "reject-all";
    H.impSongs = [];
    H.impFailed = 3;
    seedPlaylist("pl-old", { sourceUrl: `${PREFIX}r1`, externalId: "r1" });
    const r = await importRecommendPlaylist(PID, plInfo("r1", "推荐一"), { userId: "u1" });
    expect(r).toMatchObject({ success: false, created: false, trackCount: 0 });
    expect(r.failed).toBe(3); // 导入层的 failed 要透传,不能吞掉
    expect(playlistRow("pl-old")).toBeUndefined();
    expect(allPlaylists()).toHaveLength(0);
  });

  it("上游 0 首且本地没有对应歌单 → 什么都不建(不会生成一个空壳)", async () => {
    H.impSongs = [];
    const r = await importRecommendPlaylist(PID, plInfo("r1", "推荐一"), { userId: "u1" });
    expect(r.success).toBe(false);
    expect(allPlaylists()).toHaveLength(0);
  });

  it("歌单名超 18 个码点 → 截断到 18 + 省略号;18 正好不截断;空名回落「每日推荐」", async () => {
    // WebUI 卡片 nowrap 渲染,长名会把平台标签挤掉 —— 截断是显示契约,不是随意为之。
    for (const id of ["r1", "r2", "r3"]) setSongs(id, ["w1"]);
    const long = "一二三四五六七八九十一二三四五六七八九十"; // 20
    const r = await importRecommendPlaylist(PID, plInfo("r1", long), { userId: "u1" });
    expect(r.name).toBe("一二三四五六七八九十一二三四五六七八" + "…");
    expect([...r.name].length).toBe(19);

    const exact = "A".repeat(18);
    const r2 = await importRecommendPlaylist(PID, plInfo("r2", exact), { userId: "u1" });
    expect(r2.name).toBe(exact);

    const r3 = await importRecommendPlaylist(PID, plInfo("r3", ""), { userId: "u1" });
    expect(playlistRow(r3.playlistId!)!.name).toBe("每日推荐");
  });

  it("导入层的 added/deduped/failed 原样透传给调用方(不重写口径)", async () => {
    setSongs("r1", ["w1", "w2"]);
    H.impAdded = 1;
    H.impDeduped = 1;
    H.impFailed = 2;
    const r = await importRecommendPlaylist(PID, plInfo("r1", "推荐一"), { userId: "u1" });
    expect(r).toMatchObject({ added: 1, deduped: 1, failed: 2, trackCount: 2 });
  });

  it("新建路径:封面缓存成功才写 coverArt,缓存失败(null)时保持空", async () => {
    setSongs("r1", ["w1"]);
    H.cover = "/cover/a.jpg";
    const withCover = await importRecommendPlaylist(PID, plInfo("r1", "推荐一", "qq", "http://c/1.jpg"), { userId: "u1" });
    expect(H.coverCalls).toEqual([{ url: "http://c/1.jpg", key: `pl-${withCover.playlistId}`, force: undefined }]);
    expect(playlistRow(withCover.playlistId!)!.coverArt).toBe("/cover/a.jpg");

    H.cover = null;
    H.coverCalls.length = 0;
    setSongs("r2", ["w1"]);
    const noCover = await importRecommendPlaylist(PID, plInfo("r2", "推荐二", "qq", "http://c/2.jpg"), { userId: "u1" });
    expect(H.coverCalls).toHaveLength(1);
    expect(playlistRow(noCover.playlistId!)!.coverArt).toBeNull();
  });

  it("更新路径也强制刷一次封面(force=true):上次可能拉歌曲就失败过,歌单没封面", async () => {
    setSongs("r1", ["w1"]);
    H.cover = "/cover/a.jpg";
    H.coverCalls.length = 0;
    const first = await importRecommendPlaylist(PID, plInfo("r1", "推荐一", "qq", "http://c/1.jpg"), { userId: "u1" });
    expect(playlistRow(first.playlistId!)!.coverArt).toBe("/cover/a.jpg");

    H.cover = "/cover/b.jpg";
    H.coverCalls.length = 0;
    const second = await importRecommendPlaylist(PID, plInfo("r1", "推荐一", "qq", "http://c/1.jpg"), { userId: "u1" });
    expect(second.created).toBe(false);
    // 更新路径必须 force:上一轮可能卡在「拉歌曲」之前,歌单建了但封面没落地。
    expect(H.coverCalls).toEqual([
      { url: "http://c/1.jpg", key: `pl-${first.playlistId}`, force: true },
    ]);
    expect(playlistRow(first.playlistId!)!.coverArt).toBe("/cover/b.jpg");
  });

  it("不传 userId → 显式拒绝导入(不再落空串撞外键)(已修复 D27)", async () => {
    setSongs("r1", ["w1"]);
    const r = await importRecommendPlaylist(PID, plInfo("r1", "推荐一"));
    expect(r.success).toBe(false);
    expect(r.playlistId).toBeUndefined();
    // 没有归属用户 ⇒ 一个歌单行都不落(旧实现落 owner_id="" 在真实库里直接 FK 失败)。
    expect(allPlaylists()).toHaveLength(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe("syncAllRecommendPlaylists:抓取 → 导入 → 安全清理", () => {
  it("在线源没启用(或缺 recommend 能力)→ failed:1 + 明确错误,不导入任何东西", async () => {
    H.configured = null;
    const r = await syncAllRecommendPlaylists(PID, { userId: "u1" });
    expect(r).toMatchObject({ synced: 0, created: 0, failed: 1, playlists: [] });
    expect(r.errors[0]).toContain("在线源未启用或缺少 recommend/playlistSongs");
    // 批量闸必须成对:拿了锁就得还,否则后续所有批量任务永久卡死。
    expect(H.lockAcquired).toBe(1);
    expect(H.lockReleased).toBe(1);
  });

  it("两个渠道的歌单全部导入 → synced 与 playlists 列表一致", async () => {
    setSongs("a1", ["w1", "w2"]);
    setSongs("b1", ["w3"]);
    H.recommendSeq = [
      {
        channels: [
          { source: "qq", playlists: [plInfo("a1", "推荐A")] },
          { source: "kugou", playlists: [plInfo("b1", "推荐B")] },
        ],
      },
    ];
    const r = await syncAllRecommendPlaylists(PID, { userId: "u-1" });
    expect(r.synced).toBe(2);
    expect(r.playlists).toHaveLength(2);
    expect(r.playlists.map((p) => p.trackCount).sort()).toEqual([1, 2]);
    expect(allPlaylists()).toHaveLength(2);
    expect(H.lockReleased).toBe(1);
  });

  it("上游一个渠道都没有(channels 空数组)→ 立即收敛,不白重试 5 轮", async () => {
    // 每轮重试要睡 2.5s。「没有渠道」不是「渠道还没预热好」,不该为此空转 10 秒。
    H.recommendSeq = [{ channels: [] }];
    const r = await syncAllRecommendPlaylists(PID, { userId: "u1" });
    expect(H.recommendCalls).toBe(1);
    expect(r).toMatchObject({ synced: 0, created: 0, failed: 0, playlists: [] });
    expect(r.errors).toEqual([]);
  });

  it("首轮某渠道为空 → 重试到非空才用(部分平台要预热几次才出数据)", async () => {
    setSongs("a1", ["w1"]);
    H.recommendSeq = [
      { channels: [{ source: "kugou", playlists: [] }] },
      { channels: [{ source: "kugou", playlists: [plInfo("a1", "推荐A")] }] },
    ];
    const r = await syncAllRecommendPlaylists(PID, { userId: "u1" });
    expect(H.recommendCalls).toBe(2); // 确实重试了
    expect(r.synced).toBe(1);
    expect(r.errors).toEqual([]); // 拿到数据后不再报「该渠道无推荐歌单」
  }, 30000);

  it("渠道重试到底还是空 → 记错误并**保留**该渠道旧歌单(绝不删)", async () => {
    setSongs("a1", ["w1"]);
    seedPlaylist("pl-old", { sourceUrl: `${PREFIX}old1`, externalId: "old1", sourcePlatform: "kugou" });
    H.recommendSeq = [{ channels: [{ source: "kugou", playlists: [] }] }];
    const r = await syncAllRecommendPlaylists(PID, { userId: "u1" });
    expect(r.synced).toBe(0);
    // 抓不到今天的推荐时,删掉昨天的 = 用户凭空少一批歌单;宁可留旧的。
    expect(r.errors.some((e) => e.includes("该渠道无推荐歌单,保留原有歌单"))).toBe(true);
    expect(playlistRow("pl-old")).toBeDefined();
  }, 60000);

  // D29 修复后:清理统计用的 `old` 在**导入之前**快照,分母回到「昨天的量」,于是远端
  // 下架、今天不再出现的旧歌单会被真正删掉(旧实现放在导入之后取全表,把今天新建的也计进
  // oldByChannel,闸门 `current.size >= oldByChannel` 恒不成立 ⇒ 清理是死代码)。
  it("轮换后的旧推荐歌单会被清理(远端下架 + 今日同渠道导入数不少于旧数)(已修复 D29)", async () => {
    setSongs("new1", ["w1"]);
    seedPlaylist("pl-old", { sourceUrl: `${PREFIX}old1`, externalId: "old1", sourcePlatform: "qq" });
    H.recommendSeq = [{ channels: [{ source: "qq", playlists: [plInfo("new1", "新推荐")] }] }];
    const r = await syncAllRecommendPlaylists(PID, { userId: "u1" });
    expect(r.synced).toBe(1);
    expect(playlistRow("pl-old")).toBeUndefined(); // 已修复:旧歌单被轮换清理
    expect(allPlaylists()).toHaveLength(1);
  });

  it("渠道里混着一个 0 首的歌单 → 不算失败,也不计入 synced(只在日志里记一笔)", async () => {
    // 空歌单已在 importRecommendPlaylist 里自动删除;把它算成 failed 会让定时任务
    // 天天报警,把它算进 synced 又会让前端多出一个假条目。
    setSongs("good", ["w1"]);
    setSongs("empty", []);
    H.recommendSeq = [
      { channels: [{ source: "qq", playlists: [plInfo("empty", "空歌单"), plInfo("good", "好歌单")] }] },
    ];
    const r = await syncAllRecommendPlaylists(PID, { userId: "u1" });
    expect(r.synced).toBe(1);
    expect(r.playlists).toHaveLength(1);
    expect(r.errors).toEqual([]);
    expect(allPlaylists()).toHaveLength(1);
  });

  it("收藏过的歌单不参与轮换删除(但内容仍随同步更新)", async () => {
    setSongs("old1", ["w1", "w2"]);
    seedPlaylist("pl-fav", { sourceUrl: `${PREFIX}old1`, externalId: "old1", sourcePlatform: "qq", favorite: 1 });
    H.recommendSeq = [{ channels: [{ source: "qq", playlists: [plInfo("old1", "收藏的推荐")] }] }];
    const r = await syncAllRecommendPlaylists(PID, { userId: "u1" });
    // 收藏 = 用户表态要留着;轮换清理必须绕开它,但歌单内容照样每天刷新。
    // D29 修复后清理闸门已生效,「不删」由收藏分支单独保证(不再依赖恒不成立的闸门兜底)。
    expect(r.synced).toBe(1);
    expect(playlistRow("pl-fav")).toBeDefined();
    expect(entrySongIds("pl-fav")).toEqual(["w1", "w2"]);

    // 换一天:今天推的是别的 id,收藏的旧歌单仍不能被删。
    setSongs("new1", ["w3"]);
    H.recommendSeq = [{ channels: [{ source: "qq", playlists: [plInfo("new1", "新推荐")] }] }];
    await syncAllRecommendPlaylists(PID, { userId: "u1" });
    expect(playlistRow("pl-fav")).toBeDefined();
  });

  it("今日导入数少于旧有数量 → 一律不清理(疑似抓取不全,宁可留旧)", async () => {
    setSongs("old1", ["w1"]);
    seedPlaylist("pl-1", { sourceUrl: `${PREFIX}old1`, externalId: "old1", sourcePlatform: "qq" });
    seedPlaylist("pl-2", { sourceUrl: `${PREFIX}old2`, externalId: "old2", sourcePlatform: "qq" });
    // 今天只抓回 1 条(昨天有 2 条)→ 判定为部分抓取,old2 必须留着。
    H.recommendSeq = [{ channels: [{ source: "qq", playlists: [plInfo("old1", "推荐一")] }] }];
    const r = await syncAllRecommendPlaylists(PID, { userId: "u1" });
    expect(r.synced).toBe(1);
    expect(playlistRow("pl-1")).toBeDefined();
    expect(playlistRow("pl-2")).toBeDefined();
    expect(allPlaylists()).toHaveLength(2);
  });

  it("单个歌单导入抛错 → 收进 errors,同批其它歌单照常导入(不整轮失败)", async () => {
    setSongs("bad", ["w1"]);
    setSongs("good", ["w2"]);
    H.configured = {
      config: {},
      provider: {
        recommend: async () => ({
          channels: [{ source: "qq", playlists: [plInfo("bad", "坏歌单"), plInfo("good", "好歌单")] }],
        }),
        playlistSongs: async (_cfg: any, _src: string, id: string) => {
          if (id === "bad") throw new Error("上游炸了");
          return { songs: H.songsByPlaylist[id] || [] };
        },
      },
    };
    const r = await syncAllRecommendPlaylists(PID, { userId: "u1" });
    expect(r.synced).toBe(1); // 好歌单照常进来
    expect(r.errors.some((e) => e.includes("上游炸了"))).toBe(true);
    expect(allPlaylists()).toHaveLength(1);
  });

  it("抓取阶段抛错 → 异常冒给调用方,但批量闸一定被释放(finally)", async () => {
    H.configured = {
      config: {},
      provider: {
        recommend: async () => {
          throw new Error("recommend boom");
        },
        playlistSongs: async () => ({ songs: [] }),
      },
    };
    await expect(syncAllRecommendPlaylists(PID)).rejects.toThrow("recommend boom");
    expect(H.lockAcquired).toBe(1);
    expect(H.lockReleased).toBe(1);
  });

  it("整轮同步走全局批量闸,且批间让行(不与别的批量任务叠加抢带宽)", async () => {
    setSongs("a1", ["w1"]);
    H.recommendSeq = [{ channels: [{ source: "qq", playlists: [plInfo("a1", "推荐A")] }] }];
    await syncAllRecommendPlaylists(PID, { userId: "u1" });
    expect(H.lockAcquired).toBe(1);
    expect(H.lockReleased).toBe(1);
    expect(H.sleepCalls).toBeGreaterThanOrEqual(1);
  });
});
