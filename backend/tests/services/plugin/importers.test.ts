// ==================== 平台歌单导入器(QQ / 网易云) ====================
// 覆盖:URL 解析、原始曲目对象 → 导入曲目的转换、批量补齐与失败兜底。
// 网络层(http.js)整体 mock,不触达真实平台。
// MUST be the first import: redirects DATA_DIR to an isolated temp dir before
// the backend opens its SQLite DB at module-load time.
import "../../plugins/_env.js";

import { describe, it, expect, beforeEach, vi } from "vitest";

const M = vi.hoisted(() => ({
  json: null as any,
  calls: [] as string[],
  redirect: "" as string,
  jsonThrows: false as boolean,
}));

vi.mock("../../../src/services/plugin/importers/http.js", () => ({
  fetchJson: async (url: string) => {
    M.calls.push(url);
    // 只让"分批补齐"请求失败(详情请求本身成功),验证补齐失败不冒泡
    if (M.jsonThrows && url.includes("song/detail")) throw new Error("network down");
    return typeof M.json === "function" ? M.json(url) : M.json;
  },
  resolveRedirect: async () => M.redirect,
}));

import {
  extractQQPlaylistId,
  extractQQToplistId,
  parseQQSongs,
  fetchQQPlaylist,
  fetchQQToplist,
} from "../../../src/services/plugin/importers/qq.js";
import {
  extractNeteasePlaylistId,
  buildNeteaseTrack,
  fetchNeteasePlaylist,
} from "../../../src/services/plugin/importers/netease.js";

beforeEach(() => {
  M.json = null;
  M.calls = [];
  M.redirect = "";
  M.jsonThrows = false;
});

describe("QQ:URL 解析", () => {
  it("?id= / playlist/<id> / playlist.html?id= 三种形态", () => {
    expect(extractQQPlaylistId("https://y.qq.com/n/ryqq/playlist/123456")).toBe("123456");
    expect(extractQQPlaylistId("https://y.qq.com/wk/playlist.html?id=654321")).toBe("654321");
    expect(extractQQPlaylistId("https://i2.y.qq.com/x?other=1&id=999")).toBe("999");
  });

  it("非歌单链接 → null", () => {
    expect(extractQQPlaylistId("https://y.qq.com/n/ryqq/singer/001")).toBeNull();
    expect(extractQQPlaylistId("")).toBeNull();
  });

  it("榜单:topid= / toplist/<id>", () => {
    expect(extractQQToplistId("https://y.qq.com/n/ryqq/toplist/26")).toBe("26");
    expect(extractQQToplistId("https://y.qq.com/wk_toplist/index.html?topid=4")).toBe("4");
    expect(extractQQToplistId("https://y.qq.com/")).toBeNull();
  });
});

describe("QQ:曲目转换", () => {
  it("普通歌单条目:externalId 带 qq: 前缀,interval 秒 → 毫秒", () => {
    const out = parseQQSongs([
      {
        songmid: "MID1",
        songname: "歌一",
        singer: [{ name: "A" }, { name: "" }, { name: "B" }],
        albumname: "专辑一",
        interval: 200,
      },
    ]);
    expect(out).toEqual([
      { externalId: "qq:MID1", title: "歌一", artist: "A/B", album: "专辑一", duration: 200_000 },
    ]);
  });

  it("榜单条目嵌套在 data 下也能解开", () => {
    const out = parseQQSongs([{ data: { songid: "SID2", songname: "榜歌", singer: [{ name: "C" }] } }]);
    expect(out[0]).toMatchObject({ externalId: "qq:SID2", title: "榜歌", artist: "C" });
  });

  it("无标题的条目被过滤;无 id 时 externalId 为空串", () => {
    expect(parseQQSongs([{ songname: "" }]).length).toBe(0);
    expect(parseQQSongs([{ songname: "无名曲" }])[0].externalId).toBe("");
  });

  it("缺 interval 时 duration 缺省(不写 0)", () => {
    expect(parseQQSongs([{ songname: "x" }])[0].duration).toBeUndefined();
  });
});

describe("QQ:拉取", () => {
  it("fetchQQPlaylist:拼装歌单(含封面)", async () => {
    M.json = {
      cdlist: [{
        dissname: "我的歌单",
        logo: "https://img/cover.jpg",
        songlist: [{ songmid: "m1", songname: "s1", singer: [{ name: "a" }], interval: 100 }],
      }],
    };
    const pl = await fetchQQPlaylist("111");
    expect(pl.name).toBe("我的歌单");
    expect(pl.platform).toBe("qq");
    expect(pl.coverUrl).toBe("https://img/cover.jpg");
    expect(pl.tracks.length).toBe(1);
    expect(pl.tracks[0].externalId).toBe("qq:m1");
    expect(M.calls[0]).toContain("disstid=111");
  });

  it("歌单名/封面缺失 → 用 id 兜底", async () => {
    M.json = { cdlist: [{ songlist: [] }] };
    const pl = await fetchQQPlaylist("222");
    expect(pl.name).toBe("QQ 歌单 222");
    expect(pl.coverUrl).toBeUndefined();
  });

  it("无 cdlist → 抛错(导入不上)", async () => {
    M.json = {};
    await expect(fetchQQPlaylist("333")).rejects.toThrow("QQ 歌单不存在或无法访问");
  });

  it("fetchQQToplist:榜单名与封面优先 pic_v12", async () => {
    M.json = {
      topinfo: { ListName: "热歌榜", pic_v12: "https://img/v12.jpg", pic: "https://img/old.jpg" },
      songlist: [{ songmid: "t1", songname: "榜曲" }],
    };
    const pl = await fetchQQToplist("26");
    expect(pl.name).toBe("热歌榜");
    expect(pl.coverUrl).toBe("https://img/v12.jpg");
    expect(pl.tracks[0].title).toBe("榜曲");
    expect(M.calls[0]).toContain("topid=26");
  });

  it("榜单无 topinfo → 抛错", async () => {
    M.json = {};
    await expect(fetchQQToplist("26")).rejects.toThrow("QQ 榜单不存在或无法访问");
  });
});

describe("网易云:URL 解析与曲目转换", () => {
  it("?id= / playlist/<id>", () => {
    expect(extractNeteasePlaylistId("https://music.163.com/#/playlist?id=777")).toBe("777");
    expect(extractNeteasePlaylistId("https://music.163.com/playlist/888")).toBe("888");
    expect(extractNeteasePlaylistId("https://music.163.com/")).toBeNull();
  });

  it("buildNeteaseTrack:externalId 带 netease: 前缀,多歌手用 / 连接", () => {
    const t = buildNeteaseTrack({
      id: 123,
      name: "云村歌",
      ar: [{ name: "甲" }, { name: "乙" }],
      al: { name: "云专辑" },
      dt: 240000,
    });
    expect(t).toEqual({
      externalId: "netease:123",
      title: "云村歌",
      artist: "甲/乙",
      album: "云专辑",
      duration: 240000,
    });
  });

  it("空对象 → 空字段(不抛)", () => {
    const t = buildNeteaseTrack({});
    expect(t.externalId).toBe("");
    expect(t.title).toBe("");
    expect(t.artist).toBe("");
    expect(t.duration).toBeUndefined();
  });
});

describe("网易云:拉取与批量补齐", () => {
  it("无 playlist 字段 → 抛错", async () => {
    M.json = {};
    await expect(fetchNeteasePlaylist("1")).rejects.toThrow("网易云歌单不存在或无法访问");
  });

  it("单批:走 v3/song/detail 补齐", async () => {
    M.json = (url: string) =>
      url.includes("song/detail")
        ? { songs: [{ id: 1, name: "补的歌", ar: [{ name: "x" }], al: { name: "al" }, dt: 1000 }] }
        : { playlist: { name: "云歌单", coverImgUrl: "https://c/1.jpg", trackIds: [{ id: 1 }], tracks: [] } };
    const pl = await fetchNeteasePlaylist("1");
    expect(pl.name).toBe("云歌单");
    expect(pl.platform).toBe("netease");
    expect(pl.coverUrl).toBe("https://c/1.jpg");
    expect(pl.tracks.length).toBe(1);
    expect(pl.tracks[0].externalId).toBe("netease:1");
  });

  it("补齐请求全失败 → 回落到详情响应里内嵌的 tracks", async () => {
    M.json = (url: string) =>
      url.includes("song/detail")
        ? null
        : {
            playlist: {
              name: "回落歌单",
              trackIds: [{ id: 9 }],
              tracks: [{ id: 9, name: "内嵌曲", ar: [{ name: "y" }], al: { name: "al" } }],
            },
          };
    const pl = await fetchNeteasePlaylist("9");
    expect(pl.tracks.length).toBe(1);
    expect(pl.tracks[0].title).toBe("内嵌曲");
  });

  it("网络异常(整批抛错)→ 同样回落,不冒泡", async () => {
    M.jsonThrows = true;
    M.json = { playlist: { name: "n", trackIds: [], tracks: [{ id: 1, name: "兜底曲" }] } };
    const pl = await fetchNeteasePlaylist("5");
    expect(pl.tracks.length).toBe(1);
  });

  it("歌单名缺失 → 用 id 兜底", async () => {
    M.json = { playlist: { trackIds: [], tracks: [] } };
    const pl = await fetchNeteasePlaylist("42");
    expect(pl.name).toBe("网易云歌单 42");
  });
});
