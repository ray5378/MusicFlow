// ==================== QQ 导入器:插件入口 fetchPlaylist / canHandle 长尾 ====================
// 既有 importers.test.ts 只测了 fetchQQPlaylist / fetchQQToplist 两个「内部拉取函数」;
// 这里补插件契约层 qqImporter.fetchPlaylist 的分支(榜单优先 / 歌单 / 短链展开 / 无法识别)。
// 网络层 http.js 整体 mock,不触达真实平台。
// MUST be the first import: re-exports the isolated DATA_DIR env for this file.
import "../../plugins/_env.js";

import { describe, it, expect, beforeEach, vi } from "vitest";

const M = vi.hoisted(() => ({
  json: null as any,
  redirect: "" as string,
  calls: [] as string[],
}));

vi.mock("../../../src/services/plugin/importers/http.js", () => ({
  fetchJson: async (url: string) => { M.calls.push(url); return typeof M.json === "function" ? M.json(url) : M.json; },
  resolveRedirect: async (url: string) => { M.calls.push(`redirect:${url}`); return M.redirect; },
}));

import { qqImporter } from "../../../src/services/plugin/importers/qq.js";

beforeEach(() => {
  M.json = null;
  M.redirect = "";
  M.calls = [];
});

describe("qqImporter.canHandle", () => {
  it("认领 QQ 域名;非 QQ 域名不认领", () => {
    // 为什么:核心按 canHandle 逐个插件问「你认领吗」,认领错会把别的平台歌单导坏。
    expect(qqImporter.canHandle("https://y.qq.com/n/ryqq/playlist/1")).toBe(true);
    expect(qqImporter.canHandle("https://music.163.com/playlist?id=1")).toBe(false);
    // 空白会被 trim 后再判
    expect(qqImporter.canHandle("  https://c.y.qq.com/x  ")).toBe(true);
  });
});

describe("qqImporter.fetchPlaylist", () => {
  it("普通歌单链接 → 提取 id 走 fetchQQPlaylist(不请求榜单接口)", async () => {
    M.json = { cdlist: [{ dissname: "歌单", songlist: [{ songmid: "m1", songname: "s1" }] }] };
    const pl = await qqImporter.fetchPlaylist("https://y.qq.com/n/ryqq/playlist/8802318711");
    expect(pl.name).toBe("歌单");
    expect(pl.platform).toBe("qq");
    expect(M.calls.some((c) => c.includes("disstid=8802318711"))).toBe(true);
    expect(M.calls.some((c) => c.includes("redirect:"))).toBe(false); // 非短链不展开
  });

  it("榜单链接 → topid 优先识别,走 fetchQQToplist", async () => {
    // 为什么:两条解析规则都命中(榜单 URL 里也有数字),必须 topid 优先,否则榜单全导错。
    M.json = { topinfo: { ListName: "热歌榜" }, songlist: [{ songmid: "t1", songname: "榜歌" }] };
    const pl = await qqImporter.fetchPlaylist("https://y.qq.com/n/ryqq/toplist/26");
    expect(pl.name).toBe("热歌榜");
    expect(M.calls.some((c) => c.includes("topid=26"))).toBe(true);
  });

  it("分享短链(c6.y.qq.com/...u?__=) → 先跟随跳转再解析", async () => {
    // 为什么:用户从 App 分享出来的是短链,不展开就取不到 disstid。
    M.redirect = "https://y.qq.com/n/ryqq/playlist/999";
    M.json = { cdlist: [{ dissname: "短链歌单", songlist: [] }] };
    const pl = await qqImporter.fetchPlaylist("https://c6.y.qq.com/base/fcgi-bin/u?__=abc");
    expect(pl.name).toBe("短链歌单");
    expect(M.calls.some((c) => c.startsWith("redirect:https://c6.y.qq.com"))).toBe(true);
    expect(M.calls.some((c) => c.includes("disstid=999"))).toBe(true);
  });

  it("既无 topid 也无歌单 id → 抛「无法从链接中识别 QQ 歌单 ID」", async () => {
    await expect(qqImporter.fetchPlaylist("https://y.qq.com/n/ryqq/singer/001"))
      .rejects.toThrow("无法从链接中识别 QQ 歌单 ID");
  });
});
