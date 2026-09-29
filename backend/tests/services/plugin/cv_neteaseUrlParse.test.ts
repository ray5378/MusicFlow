// ==================== 覆盖率 C 类缺口:网易云 importer 的 fetchPlaylist URL 解析 ====================
//
// 目标:src/services/plugin/importers/netease.ts 154-158 —— neteaseImporter.fetchPlaylist:
//   ① 非法链接(识别不出歌单 id)→ throw new Error("无法从链接中识别网易云歌单 ID"),
//      且不发起任何网络请求;
//   ② 合法链接 → 提取 id 后转发 fetchNeteasePlaylist(id)(底层 fetch 层透传正确 id)。
//
// mock 策略照抄 tests/services/plugin/importers.test.ts:整体 mock http.js,
// 不触达真实平台。本文件位于 out/tests/services/plugin/,相对深度与该参考测试一致。
// MUST be the first import: redirects DATA_DIR to an isolated temp dir before
// the backend opens its SQLite DB at module-load time.
import "../../plugins/_env.js";

import { describe, it, expect, beforeEach, vi } from "vitest";

const M = vi.hoisted(() => ({
  json: null as any,
  calls: [] as string[],
}));

vi.mock("../../../src/services/plugin/importers/http.js", () => ({
  fetchJson: async (url: string) => {
    M.calls.push(url);
    return typeof M.json === "function" ? M.json(url) : M.json;
  },
  resolveRedirect: async () => "",
}));

import { neteaseImporter } from "../../../src/services/plugin/importers/netease.js";

beforeEach(() => {
  M.json = null;
  M.calls = [];
});

describe("neteaseImporter.fetchPlaylist:URL 解析与透传(154-158)", () => {
  it("非法链接识别不出歌单 ID → 抛错,且不发起任何网络请求", async () => {
    M.json = {};
    await expect(
      neteaseImporter.fetchPlaylist("https://music.163.com/#/discover/toplist"),
    ).rejects.toThrow("无法从链接中识别网易云歌单 ID");
    await expect(neteaseImporter.fetchPlaylist("https://music.163.com/#/playlist")).rejects.toThrow(
      "无法从链接中识别网易云歌单 ID",
    );
    expect(M.calls).toHaveLength(0);
  });

  it("合法链接 ?id= 形态 → 提取 id 并转发 fetchNeteasePlaylist(id)", async () => {
    M.json = (url: string) =>
      url.includes("song/detail")
        ? { songs: [] }
        : { playlist: { name: "透传歌单", coverImgUrl: "https://c/777.jpg", trackIds: [], tracks: [] } };
    const pl = await neteaseImporter.fetchPlaylist("https://music.163.com/#/playlist?id=777");
    expect(M.calls[0]).toContain("api/v6/playlist/detail?id=777");
    expect(pl.name).toBe("透传歌单");
    expect(pl.platform).toBe("netease");
    expect(pl.coverUrl).toBe("https://c/777.jpg");
  });

  it("playlist/<id> 形态同样透传(url 先 trim)", async () => {
    M.json = { playlist: { trackIds: [], tracks: [] } };
    const pl = await neteaseImporter.fetchPlaylist("  https://music.163.com/playlist/888  ");
    expect(M.calls[0]).toContain("id=888");
    expect(pl.name).toBe("网易云歌单 888");
  });
});
