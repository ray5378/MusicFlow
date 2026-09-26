// ==================== 歌手资料抓取插件(artist-info) ====================
// 覆盖:QQ 优先 / 网易云兜底的选择逻辑、大小写匹配、网络失败全链路兜底。
// 全部走 mock fetch,不触达真实平台。
// MUST be the first import: redirects DATA_DIR to an isolated temp dir before
// the backend opens its SQLite DB at module-load time.
import "../../plugins/_env.js";

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

const M = vi.hoisted(() => ({
  handler: null as null | ((url: string) => any),
  calls: [] as string[],
}));

import { artistInfoPlugin, artistInfoManifest, ARTIST_INFO_PLUGIN_ID } from "../../../src/services/plugin/artistInfo.js";

beforeEach(() => {
  M.handler = null;
  M.calls = [];
  vi.stubGlobal("fetch", async (url: any) => {
    const u = String(url);
    M.calls.push(u);
    if (!M.handler) throw new Error("no handler");
    const body = M.handler(u);
    if (body === undefined) return new Response("not found", { status: 404 });
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function qqOk(over: any = {}) {
  return {
    data: {
      song: {
        list: [
          {
            singer: [
              { name: "Other", mid: "MID-OTHER" },
              { name: "周杰伦", mid: "MID-JAY" },
            ],
          },
        ],
      },
      ...over,
    },
  };
}

describe("插件契约", () => {
  it("manifest 声明 artistInfo 能力且默认启用", () => {
    expect(ARTIST_INFO_PLUGIN_ID).toBe("artist-info");
    expect(artistInfoManifest.id).toBe(ARTIST_INFO_PLUGIN_ID);
    expect(artistInfoManifest.capabilities).toContain("artistInfo");
    expect(artistInfoManifest.defaultEnabled).toBe(true);
  });

  it("fetchArtistInfo 是对外唯一入口", () => {
    expect(typeof artistInfoPlugin.fetchArtistInfo).toBe("function");
  });
});

describe("QQ 优先", () => {
  it("命中歌手 → 返回 QQ CDN 头像(按名字精确匹配,大小写不敏感)", async () => {
    M.handler = (u) => (u.includes("c.y.qq.com") ? qqOk() : undefined);
    const r = await artistInfoPlugin.fetchArtistInfo("周杰伦");
    expect(r).toBeTruthy();
    expect(r!.platform).toBe("qq");
    expect(r!.name).toBe("周杰伦");
    expect(r!.coverArtUrl).toBe("https://y.gtimg.cn/music/photo_new/T001R300x300M000MID-JAY.jpg");
    // 命中 QQ 就不再请求网易云
    expect(M.calls.some((u) => u.includes("music.163.com"))).toBe(false);
  });

  it("英文名的大小写差异也能匹配", async () => {
    M.handler = (u) =>
      u.includes("c.y.qq.com")
        ? { data: { song: { list: [{ singer: [{ name: "Eagles", mid: "MID-E" }] }] } } }
        : undefined;
    const r = await artistInfoPlugin.fetchArtistInfo("eagles");
    expect(r!.name).toBe("Eagles");
    expect(r!.coverArtUrl).toContain("MID-E");
  });

  it("没有精确匹配时退回列表第一个歌手", async () => {
    M.handler = (u) =>
      u.includes("c.y.qq.com")
        ? { data: { song: { list: [{ singer: [{ name: "Nobody", mid: "MID-N" }] }] } } }
        : undefined;
    const r = await artistInfoPlugin.fetchArtistInfo("找不到的人");
    expect(r!.name).toBe("Nobody");
  });
});

describe("网易云兜底", () => {
  it("QQ 无结果 → 走网易云,带上头像与简介", async () => {
    M.handler = (u) => {
      if (u.includes("c.y.qq.com")) return { data: { song: { list: [] } } };
      if (u.includes("/api/search/get")) {
        return { result: { artists: [{ id: 100, name: "云歌手", picUrl: "https://p/1.jpg" }] } };
      }
      if (u.includes("/api/artist/100")) return { artist: { briefDesc: "一段简介" } };
      return undefined;
    };
    const r = await artistInfoPlugin.fetchArtistInfo("云歌手");
    expect(r).toBeTruthy();
    expect(r!.platform).toBe("netease");
    expect(r!.coverArtUrl).toBe("https://p/1.jpg");
    expect(r!.bio).toBe("一段简介");
  });

  it("网易云详情无简介 → 不带 bio 字段", async () => {
    M.handler = (u) => {
      if (u.includes("c.y.qq.com")) return null;
      if (u.includes("/api/search/get")) return { result: { artists: [{ id: 7, name: "X" }] } };
      if (u.includes("/api/artist/7")) return { artist: {} };
      return undefined;
    };
    const r = await artistInfoPlugin.fetchArtistInfo("X");
    expect(r!.platform).toBe("netease");
    expect(r!.bio).toBeUndefined();
  });

  it("网易云搜索无歌手 → null", async () => {
    M.handler = (u) => (u.includes("c.y.qq.com") ? null : { result: { artists: [] } });
    expect(await artistInfoPlugin.fetchArtistInfo("查无此人")).toBeNull();
  });
});

describe("异常兜底", () => {
  it("两平台都非 200 → null(不抛)", async () => {
    M.handler = () => undefined;
    expect(await artistInfoPlugin.fetchArtistInfo("谁")).toBeNull();
  });

  it("网络直接抛错 → null(不抛)", async () => {
    vi.stubGlobal("fetch", async () => { throw new Error("boom"); });
    await expect(artistInfoPlugin.fetchArtistInfo("谁")).resolves.toBeNull();
  });

  it("返回非法 JSON → null(不抛)", async () => {
    vi.stubGlobal("fetch", async () => new Response("<html>", { status: 200 }));
    await expect(artistInfoPlugin.fetchArtistInfo("谁")).resolves.toBeNull();
  });
});
