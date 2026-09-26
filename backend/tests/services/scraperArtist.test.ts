// 歌手刮削(scraper/artist)契约测试:
//   - 缺封面 / 缺资料两个补刮名单的口径(自动补刮靠它挑目标)
//   - 插件能力遍历(核心不写死平台,首个返回非空的胜出)
//   - 抓到资料 → 落盘封面 + 清 scrapeMissing;抓不到 → 标记缺失可重试
//   - 批量刮削的进度回调与跳过不存在 id
// 数据源(QQ/网易等)一律走 artistInfo 能力插件,测试里用桩插件替身,不真联网。
// MUST be the first import: re-exports the isolated DATA_DIR env for this file.
import "../plugins/_env.js";

import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { db } from "../../src/db/index.js";
import { artists } from "../../src/db/schema.js";
import { eq, inArray } from "drizzle-orm";

const h = vi.hoisted(() => ({
  info: null as null | { name: string; platform: string; coverArtUrl?: string; bio?: string },
  calls: 0,
  failDownload: false,
}));

vi.mock("../../src/plugins/registry.js", async (imp) => {
  const real: any = await imp();
  return {
    ...real,
    // 只替掉「按能力取启用插件」:桩插件即数据源,核心不写死平台
    getEnabledByCapability: (cap: string) =>
      cap === "artistInfo"
        ? [
            {
              impl: {
                fetchArtistInfo: async (_name: string) => {
                  h.calls += 1;
                  return h.info;
                },
              },
            },
          ]
        : [],
  };
});

import {
  scrapeArtist,
  scrapeArtistList,
  artistsMissingCovers,
  artistsMissingInfo,
} from "../../src/services/scraper/artist.js";

const IDS = ["ar-test-1", "ar-test-2", "ar-test-3"];

function stubFetch(opts: { ok?: boolean; bytes?: number; contentType?: string } = {}) {
  const { ok = true, bytes = 256, contentType = "image/jpeg" } = opts;
  vi.stubGlobal("fetch", async () => ({
    ok,
    headers: { get: () => contentType },
    arrayBuffer: async () => new Uint8Array(bytes).buffer,
  }));
}

function rowOf(id: string) {
  return db.select().from(artists).where(eq(artists.id, id)).get();
}

beforeEach(() => {
  h.info = null;
  h.calls = 0;
  stubFetch();
});

afterAll(() => {
  vi.unstubAllGlobals();
  db.delete(artists).where(inArray(artists.id, IDS)).run();
});

describe("补刮名单口径", () => {
  it("artistsMissingCovers: 只列没有封面的歌手", () => {
    db.delete(artists).where(inArray(artists.id, IDS)).run();
    db.insert(artists).values([
      { id: IDS[0], name: "无封面歌手", coverArt: null },
      { id: IDS[1], name: "有封面歌手", coverArt: "ar-x.jpg" },
    ]).run();

    const missing = artistsMissingCovers().map((a) => a.id);
    expect(missing).toContain(IDS[0]);
    expect(missing).not.toContain(IDS[1]);
  });

  it("artistsMissingInfo: 只列被标记为缺资料的歌手(scrapeMissing=1)", () => {
    db.delete(artists).where(inArray(artists.id, IDS)).run();
    db.insert(artists).values([
      { id: IDS[0], name: "缺资料歌手", scrapeMissing: 1 },
      { id: IDS[1], name: "资料齐全歌手", scrapeMissing: 0 },
    ]).run();

    const missing = artistsMissingInfo().map((a) => a.id);
    expect(missing).toContain(IDS[0]);
    expect(missing).not.toContain(IDS[1]);
  });
});

describe("scrapeArtist 输入边界", () => {
  it("空名 / Unknown Artist 直接返回 null,且不打扰插件", async () => {
    await expect(scrapeArtist("")).resolves.toBeNull();
    await expect(scrapeArtist("Unknown Artist")).resolves.toBeNull();
    expect(h.calls).toBe(0);
  });

  it("库里查不到该歌手 → null(不凭空建条目)", async () => {
    await expect(scrapeArtist("根本不存在的歌手名")).resolves.toBeNull();
  });
});

describe("scrapeArtist 主流程", () => {
  it("插件返回资料 + 封面下载成功 → 落封面、写 bio、清掉缺资料标记", async () => {
    db.delete(artists).where(inArray(artists.id, IDS)).run();
    db.insert(artists).values([{ id: IDS[0], name: "张三", scrapeMissing: 1 }]).run();
    h.info = { name: "张三", platform: "stub", coverArtUrl: "https://example.com/a.jpg", bio: "测试简介" };

    const out = await scrapeArtist("张三", IDS[0]);
    expect(out).not.toBeNull();
    expect(out!.platform).toBe("stub");
    expect(out!.bio).toBe("测试简介");
    expect(out!.fallbackCover).toBeFalsy();

    const row = rowOf(IDS[0]);
    expect(row?.coverArt).toBeTruthy();
    expect(String(row?.coverArt)).toMatch(/^ar-ar-test-1\.(jpg|png)$/);
    expect(row?.scrapeMissing).toBe(0);
    expect(row?.bio).toBe("测试简介");
  });

  it("插件有资料但封面下载失败 → 标 scrapeMissing=1,等下次重试", async () => {
    db.delete(artists).where(inArray(artists.id, IDS)).run();
    db.insert(artists).values([{ id: IDS[1], name: "李四", scrapeMissing: 0 }]).run();
    h.info = { name: "李四", platform: "stub", coverArtUrl: "https://example.com/b.jpg" };
    stubFetch({ ok: false });

    const out = await scrapeArtist("李四", IDS[1]);
    expect(out).not.toBeNull();
    expect(rowOf(IDS[1])?.scrapeMissing).toBe(1);
  });

  it("所有插件都查不到 → 标 scrapeMissing=1,返回 platform=none", async () => {
    db.delete(artists).where(inArray(artists.id, IDS)).run();
    db.insert(artists).values([{ id: IDS[2], name: "王五", scrapeMissing: 0 }]).run();
    h.info = null;

    const out = await scrapeArtist("王五", IDS[2]);
    expect(out).not.toBeNull();
    expect(out!.platform).toBe("none");
    expect(rowOf(IDS[2])?.scrapeMissing).toBe(1);
  });

});

describe("scrapeArtistList 批量刮削", () => {
  it("逐个处理、回调进度、最终 status=done;不存在的 id 只计数不报错", async () => {
    db.delete(artists).where(inArray(artists.id, IDS)).run();
    db.insert(artists).values([{ id: IDS[0], name: "批量歌手", scrapeMissing: 0 }]).run();
    h.info = { name: "批量歌手", platform: "stub", coverArtUrl: "https://example.com/c.jpg" };
    stubFetch();

    const seen: any[] = [];
    const p = await scrapeArtistList([IDS[0], "ar-not-exist"], (s) => seen.push({ ...s }));

    expect(p.status).toBe("done");
    expect(p.total).toBe(2);
    expect(p.processed).toBe(2);
    expect(p.errors).toEqual([]);
    expect(seen.length).toBeGreaterThan(0);
    expect(seen[seen.length - 1].status).toBe("done");
  });
});
