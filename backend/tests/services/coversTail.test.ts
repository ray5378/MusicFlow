// 覆盖率长尾补充:services/covers.ts 的残余分支。
//   - 本地歌经专辑封面兜底判定「其实已有封面」→ 不触发在线搜索(90-94)
//   - searchCover 抛错 → 记尝试并返回 null(112-113)
//   - 远程封面下载失败(cacheRemoteCover 返回 null)→ 记尝试并返回 null(123-125)
//   - 批量补全 worker 内 fetchCoverForSong 抛错 → 计入 fail(155-156)
//   - 批量补全 ref=null(在线无命中)→ 计入 fail(153)
//   - withCoverLimit:第 3 个调用在 ≤2 并发上限下必须排队等待(49-50)
// 外部依赖(封面插件 / 远程缓存 / 设置)全部用替身,不真联网。
// MUST be the first import: redirects DATA_DIR to an isolated temp dir.
import "../plugins/_env.js";

import { describe, it, expect, beforeEach, vi } from "vitest";
import { db, sqlite } from "../../src/db/index.js";
import { songs, albums, artists } from "../../src/db/schema.js";
import { eq } from "drizzle-orm";

const H = vi.hoisted(() => ({
  hasProvider: true,
  searchThrows: false,
  searchUrl: null as string | null,
  cacheReturns: null as string | null,
  resolveThrows: false,
  resolveOk: true,
  searchCalls: 0,
}));

vi.mock("../../src/plugins/providers.js", async (imp) => {
  const real: any = await imp();
  return {
    ...real,
    hasCoverProvider: () => H.hasProvider,
    searchCover: async () => {
      H.searchCalls += 1;
      if (H.searchThrows) throw new Error("provider 502");
      return H.searchUrl;
    },
  };
});

vi.mock("../../src/services/playlistCover.js", async (imp) => {
  const real: any = await imp();
  return {
    ...real,
    cacheRemoteCover: async () => H.cacheReturns,
    resolveCoverFile: (ref: string | null) => {
      if (H.resolveThrows) throw new Error("cover dir unreadable");
      return H.resolveOk && ref ? `/covers/${ref}` : null;
    },
  };
});

vi.mock("../../src/services/settings.js", async (imp) => {
  const real: any = await imp();
  return { ...real, getSettingBool: (_k: string, def: boolean) => def };
});

import { fetchCoverForSong, runCoverBackfill, withCoverLimit, clearCoverAttempt } from "../../src/services/covers.js";

const ALBUM = "alb-tail-1";
const ARTIST = "art-tail-1";
const SONGS = ["cov-tail-1", "cov-tail-2", "cov-tail-3", "cov-tail-4"];

function seedAlbumWithCover(id: string, coverArt: string) {
  const now = new Date().toISOString();
  // albums.artist_id 有 FK ⇒ 先建歌手行(生产路径里 artistId 为空串时压根不会建专辑)。
  db.delete(albums).where(eq(albums.id, id)).run();
  db.delete(artists).where(eq(artists.id, ARTIST)).run();
  db.insert(artists).values({ id: ARTIST, name: "Tail Artist", albumCount: 0, createdAt: now, updatedAt: now }).run();
  db.insert(albums)
    .values({ id, name: `Album ${id}`, artistId: ARTIST, artist: "Tail Artist", year: 0, genre: "", coverArt, songCount: 0, duration: 0, createdAt: now, updatedAt: now })
    .run();
}

beforeEach(() => {
  H.hasProvider = true;
  H.searchThrows = false;
  H.searchUrl = null;
  H.cacheReturns = null;
  H.resolveThrows = false;
  H.resolveOk = true;
  H.searchCalls = 0;
  sqlite.prepare("DELETE FROM songs WHERE id LIKE 'cov-tail-%'").run();
  sqlite.prepare("DELETE FROM albums WHERE id = ?").run(ALBUM);
  for (const id of SONGS) clearCoverAttempt(id);
});

describe("covers: 本地歌曲专辑封面兜底", () => {
  it("本地歌 + 专辑已有可解析封面 → 直接返回专辑引用,绝不触发在线搜索(90-94)", async () => {
    seedAlbumWithCover(ALBUM, "al-tail-cover");
    const song = { id: "cov-tail-1", title: "本地歌", artist: "A", album: "AL", type: "local", albumId: ALBUM };

    const ref = await fetchCoverForSong(song);
    expect(ref).toBe("al-tail-cover");
    // 这是本分支的全部意义:本地歌已有专辑封面兜底时不得用在线图覆盖/浪费请求。
    expect(H.searchCalls).toBe(0);
  });

  it("本地歌 + 专辑引用解析不出来 → 继续走在线搜索(守卫不误伤)", async () => {
    seedAlbumWithCover(ALBUM, "al-tail-cover");
    H.resolveOk = false; // 文件不存在 ⇒ 视为「其实没封面」
    H.searchUrl = "https://example.com/remote.jpg";
    H.cacheReturns = "cov-tail-2.jpg";

    const song = { id: "cov-tail-2", title: "本地歌", artist: "A", album: "AL", type: "local", albumId: ALBUM };
    const ref = await fetchCoverForSong(song);
    expect(ref).toBe("cov-tail-2.jpg");
    expect(H.searchCalls).toBe(1);
  });
});

describe("covers: 失败收口", () => {
  it("searchCover 抛错 → 记尝试并返回 null(不冒泡)", async () => {
    H.searchThrows = true;
    const song = { id: "cov-tail-3", title: "T", artist: "A", album: "AL" };
    await expect(fetchCoverForSong(song)).resolves.toBeNull();
    expect(H.searchCalls).toBe(1);

    // 失败记忆生效:TTL 内再取不再重复打插件(防风暴)。
    await expect(fetchCoverForSong(song)).resolves.toBeNull();
    expect(H.searchCalls).toBe(1);
  });

  it("找到 URL 但远程缓存失败 → 记尝试并返回 null(123-125)", async () => {
    H.searchUrl = "https://example.com/broken.jpg";
    H.cacheReturns = null; // 下载/落盘失败
    const song = { id: "cov-tail-4", title: "T", artist: "A", album: "AL" };
    await expect(fetchCoverForSong(song)).resolves.toBeNull();
    expect(H.searchCalls).toBe(1);

    await expect(fetchCoverForSong(song)).resolves.toBeNull();
    expect(H.searchCalls).toBe(1); // 已记尝试 → 不重试
  });
});

describe("covers: 批量补全", () => {
  it("fetchCoverForSong 抛错 → 该首计入 fail,不中断整批(155-156)", async () => {
    seedAlbumWithCover(ALBUM, "al-tail-cover");
    H.resolveThrows = true; // 专辑封面解析抛错 ⇒ fetchCoverForSong 冒泡
    const now = new Date().toISOString();
    sqlite
      .prepare(
        "INSERT INTO songs (id, title, artist, album, duration, path, suffix, type, album_id, cover_art, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,NULL,?,?)",
      )
      .run("cov-tail-1", "T1", "A", "AL", 100, "l:src:/x.mp3", "mp3", "local", ALBUM, now, now);

    const r = await runCoverBackfill(["cov-tail-1"]);
    expect(r.ok).toBe(0);
    expect(r.fail).toBe(1);
  });

  it("无 coverProvider 或空列表 → 立即返回 0/0", async () => {
    H.hasProvider = false;
    await expect(runCoverBackfill(["whatever"])).resolves.toEqual({ ok: 0, fail: 0 });
    H.hasProvider = true;
    await expect(runCoverBackfill([])).resolves.toEqual({ ok: 0, fail: 0 });
  });

  it("在线搜索无命中(ref=null)→ 该首计入 fail,不中断整批(153)", async () => {
    clearCoverAttempt("cov-tail-5");
    const now = new Date().toISOString();
    // album_id 置 NULL ⇒ 本地歌专辑兜底守卫不触发,直接落到在线搜索。
    sqlite
      .prepare(
        "INSERT INTO songs (id, title, artist, album, duration, path, suffix, type, album_id, cover_art, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,NULL,NULL,?,?)",
      )
      .run("cov-tail-5", "T5", "A", "AL", 100, "l:src:/y.mp3", "mp3", "local", now, now);
    H.searchUrl = null; // searchCover 返回 null ⇒ fetchCoverForSong 返回 null(不抛)
    H.cacheReturns = null;

    const r = await runCoverBackfill(["cov-tail-5"]);
    // ref 为空走 else 分支计 fail,而不是被当成 ok。
    expect(r.ok).toBe(0);
    expect(r.fail).toBe(1);
  });
});

describe("covers: withCoverLimit 并发上限", () => {
  it("上限 ≤2:第 3 个调用排队,释放后才执行(49-50)", async () => {
    let rel1!: () => void;
    let rel2!: () => void;
    let thirdStarted = false;

    const p1 = withCoverLimit(() => new Promise<void>((r) => { rel1 = r; }));
    const p2 = withCoverLimit(() => new Promise<void>((r) => { rel2 = r; }));
    const p3 = withCoverLimit(async () => { thirdStarted = true; return "third"; });

    await Promise.resolve();
    // 两个槽已被占满 ⇒ 第三个必须排队而不是并发开跑(否则批量导入会把网络打满)。
    expect(thirdStarted).toBe(false);

    rel1();
    await p1;
    await p3;
    expect(thirdStarted).toBe(true);
    expect(await p3).toBe("third");

    rel2();
    await p2;
  });
});
