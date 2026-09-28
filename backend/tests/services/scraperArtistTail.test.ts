// 覆盖率长尾补充:services/scraper/artist.ts 的残余分支。
//   - 插件抓取抛错 → 跳过该插件继续(62)
//   - 封面下载异常 → 不落盘、不报错(38-39)
//   - 平台都没有资料 → 用本地专辑封面做头像(79-88 / 120-123)
//   - 批量刮削:无封面 → skipped++;scrapeArtist 抛错 → skipped + errors(170-175)
// 数据源一律走 artistInfo 能力桩插件,不真联网。
// MUST be the first import: re-exports the isolated DATA_DIR env for this file.
import "../plugins/_env.js";

import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import fs from "fs";
import path from "path";
import { db } from "../../src/db/index.js";
import { artists, albums } from "../../src/db/schema.js";
import { eq, inArray } from "drizzle-orm";

const h = vi.hoisted(() => ({
  info: null as null | { name: string; platform: string; coverArtUrl?: string; bio?: string },
  calls: 0,
  infoThrows: false,
  listCacheThrows: false,
}));

vi.mock("../../src/plugins/registry.js", async (imp) => {
  const real: any = await imp();
  return {
    ...real,
    // 桩插件即数据源:核心不写死平台。
    getEnabledByCapability: (cap: string) =>
      cap === "artistInfo"
        ? [
            {
              impl: {
                fetchArtistInfo: async (_name: string) => {
                  h.calls += 1;
                  if (h.infoThrows) throw new Error("upstream 502");
                  return h.info;
                },
              },
            },
          ]
        : [],
  };
});

vi.mock("../../src/utils/artistListCache.js", async (imp) => {
  const real: any = await imp();
  return {
    ...real,
    invalidateArtistList: () => {
      if (h.listCacheThrows) throw new Error("artist list cache boom");
      return real.invalidateArtistList?.();
    },
  };
});

import { scrapeArtist, scrapeArtistList } from "../../src/services/scraper/artist.js";
import { getDataDir } from "../../src/utils/env.js";

const IDS = ["ar-tail-1", "ar-tail-2", "ar-tail-3"];
const COVERS_DIR = path.join(getDataDir(), "covers");

function rowOf(id: string) {
  return db.select().from(artists).where(eq(artists.id, id)).get();
}

function seedArtist(id: string, name: string) {
  db.insert(artists).values({ id, name, albumCount: 0, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }).run();
}

function seedAlbumWithCover(id: string, artistId: string, coverRef: string) {
  const now = new Date().toISOString();
  db.insert(albums)
    .values({ id, name: `Tail Album ${id}`, artistId, artist: "A", year: 2020, genre: "", coverArt: coverRef, songCount: 0, duration: 0, createdAt: now, updatedAt: now })
    .run();
  fs.mkdirSync(COVERS_DIR, { recursive: true });
  fs.writeFileSync(path.join(COVERS_DIR, coverRef), "fake-cover-bytes");
}

/** 清掉本文件之外可能残留的「有封面专辑」,让 useRandomAlbumCover 的可控性成立。 */
function clearAlbums() {
  db.delete(albums).run();
}

beforeEach(() => {
  h.info = null;
  h.calls = 0;
  h.infoThrows = false;
  h.listCacheThrows = false;
  // 先删专辑再删歌手(albums.artist_id 有 FK,顺序反了就 FK 失败)。
  clearAlbums();
  db.delete(artists).where(inArray(artists.id, IDS)).run();
});

afterAll(() => {
  clearAlbums();
  db.delete(artists).where(inArray(artists.id, IDS)).run();
});

describe("scrapeArtist 长尾", () => {
  it("插件抓取抛错 → 跳过并继续(不冒泡),最终按「无资料」收口", async () => {
    seedArtist(IDS[0], "抛错歌手");
    h.infoThrows = true;
    const out = await scrapeArtist("抛错歌手", IDS[0]);

    expect(h.calls).toBe(1); // 确实调用了插件
    expect(out).not.toBeNull();
    expect(out!.platform).toBe("none"); // 异常被吞掉 ⇒ 走无资料分支
    expect(rowOf(IDS[0])?.scrapeMissing).toBe(1);
  });

  it("插件给了封面 URL 但下载抛异常 → 不落封面、不报错(38-39)", async () => {
    seedArtist(IDS[0], "下载失败歌手");
    h.info = { name: "下载失败歌手", platform: "stub", coverArtUrl: "https://example.com/x.jpg" };
    vi.stubGlobal("fetch", async () => {
      throw new Error("ECONNRESET");
    });
    try {
      const out = await scrapeArtist("下载失败歌手", IDS[0]);
      // 没有任何本地专辑可兜底 ⇒ 下载失败后 coverArt 必须为空(而不是写进一个不存在的文件引用)。
      expect(out!.coverArt).toBeUndefined();
      expect(out!.fallbackCover).toBeFalsy();
      expect(rowOf(IDS[0])?.scrapeMissing).toBe(1);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("平台无资料 → 用本地专辑封面做头像并标 fallbackCover(79-88 / 120-123)", async () => {
    seedArtist(IDS[1], "无资料歌手");
    seedAlbumWithCover("al-tail-1", IDS[1], "al-tail-cover-1");
    h.info = null; // 所有插件都查不到

    const out = await scrapeArtist("无资料歌手", IDS[1]);
    expect(out!.fallbackCover).toBe(true);
    expect(out!.coverArt).toBe(`ar-${IDS[1]}.jpg`); // ref 命名契约:ar-<artistId>.jpg

    // 头像文件真的被复制到 covers 目录(不是只写了个引用)。
    expect(fs.existsSync(path.join(COVERS_DIR, `ar-${IDS[1]}.jpg`))).toBe(true);
    expect(rowOf(IDS[1])?.coverArt).toBe(`ar-${IDS[1]}.jpg`);
    expect(rowOf(IDS[1])?.scrapeMissing).toBe(1); // 仍然标记"缺资料",可重试
  });

  it("有本地专辑但封面文件不存在 → 不落头像(79-81 的 existsSync 守卫)", async () => {
    seedArtist(IDS[2], "封面文件缺失歌手");
    const now = new Date().toISOString();
    db.insert(albums)
      .values({ id: "al-tail-missing", name: "Missing", artistId: IDS[2], artist: "A", coverArt: "no-such-file-xyz", songCount: 0, duration: 0, createdAt: now, updatedAt: now })
      .run();
    h.info = null;

    const out = await scrapeArtist("封面文件缺失歌手", IDS[2]);
    expect(out!.coverArt).toBeUndefined();
    expect(out!.fallbackCover).toBeFalsy();
    expect(rowOf(IDS[2])?.scrapeMissing).toBe(1);
  });

  it("复制专辑封面到 covers 目录失败 → 吞掉异常返回 null(86-88)", async () => {
    seedArtist(IDS[0], "复制失败歌手");
    seedAlbumWithCover("al-tail-copy", IDS[0], "al-tail-cover-copy");
    h.info = null;

    const spy = vi.spyOn(fs, "copyFileSync").mockImplementationOnce(() => {
      throw new Error("ENOSPC");
    });
    let out: any;
    try {
      out = await scrapeArtist("复制失败歌手", IDS[0]);
    } finally {
      spy.mockRestore();
    }
    // 兜底封面写盘失败不能让整个刮削报错,退化为"没有封面"。
    expect(out.coverArt).toBeUndefined();
    expect(out.fallbackCover).toBeFalsy();
  });
});

describe("scrapeArtistList 长尾", () => {
  it("抓到但没有任何封面 → 计入 skipped(170-171)", async () => {
    seedArtist(IDS[0], "无封面歌手");
    h.info = null;
    const p = await scrapeArtistList([IDS[0]]);
    expect(p.status).toBe("done");
    expect(p.skipped).toBe(1);
    expect(p.scraped).toBe(0);
    expect(p.fallback).toBe(0);
    expect(p.errors).toEqual([]);
  });

  it("scrapeArtist 抛错 → 计入 skipped 并记入 errors(173-175)", async () => {
    seedArtist(IDS[1], "刮削异常歌手");
    h.info = null;
    h.listCacheThrows = true; // 让 scrapeArtist 在收尾(失效缓存)时抛错
    const p = await scrapeArtistList([IDS[1]]);
    expect(p.status).toBe("done");
    expect(p.skipped).toBe(1);
    expect(p.processed).toBe(1);
    expect(p.errors).toHaveLength(1);
    expect(p.errors[0]).toContain("刮削异常歌手");
  });
});
