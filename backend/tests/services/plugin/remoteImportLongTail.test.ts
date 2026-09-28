// ==================== services/plugin/remoteImport 长尾 ====================
// importRemotePlaylistLike 把「歌单/专辑搜加入库」两条入口收敛到一处。这里补两条
// 直接决定用户可见错误文案的分支:
//   - 插件返回空/非法歌曲数组 → 抛「该歌单没有可导入的歌曲」;
//   - 交叉验证全部拒导 → 抛「没有歌曲通过导入门禁…拒导 N 首」;
//   - 入库后没有任何条目且无拒导 → 抛「歌曲入库失败,请检查在线源配置」。
// 依赖全部用桩,不触达网络/曲库。
import "../../plugins/_env.js";

import { describe, it, expect, beforeEach, vi } from "vitest";

const h = vi.hoisted(() => ({
  crossVerify: vi.fn(async () => ({ verified: [] as any[], rejected: 0 })),
  importOnline: vi.fn(async () => ({ songs: [] as any[], added: 0, deduped: 0, failed: 0 })),
  replaceSongs: vi.fn(async () => {}),
  matchLib: vi.fn(() => [] as (string | null)[]),
  startCount: 0,
  endCount: 0,
}));

vi.mock("../../../src/services/source/online/service.js", () => ({ importOnlineSongs: h.importOnline }));
vi.mock("../../../src/services/source/online/match.js", () => ({ crossVerifySongs: h.crossVerify }));
vi.mock("../../../src/services/source/online/recommendImport.js", () => ({ replacePlaylistSongs: h.replaceSongs }));
vi.mock("../../../src/services/plugin/shared.js", () => ({ refreshPlaylistCounts: () => {} }));
vi.mock("../../../src/services/playlistCover.js", () => ({ cacheRemoteCover: async () => null }));
vi.mock("../../../src/services/plugin/libraryIndex.js", () => ({ clearLibraryIndex: () => {} }));
vi.mock("../../../src/services/plugin/libraryMatch.js", () => ({ matchSongsToLibrary: h.matchLib }));
vi.mock("../../../src/services/plugin/batchPacer.js", () => ({
  markInteractiveStart: () => { h.startCount++; },
  markInteractiveEnd: () => { h.endCount++; },
}));
vi.mock("../../../src/services/memory/reclaim.js", () => ({ touch: () => {} }));

import { importRemotePlaylistLike } from "../../../src/services/plugin/remoteImport.js";

const input = (plugin: any) => ({
  providerId: "p1",
  plugin,
  config: {},
  userId: "u1",
  source: "qq",
  id: "pl-id",
  sourceUrl: "playlist://qq/pl-id",
});

beforeEach(() => {
  h.crossVerify.mockReset().mockResolvedValue({ verified: [], rejected: 0 });
  h.importOnline.mockReset().mockResolvedValue({ songs: [], added: 0, deduped: 0, failed: 0 });
  h.matchLib.mockReset().mockReturnValue([]);
  h.startCount = 0;
  h.endCount = 0;
});

describe("importRemotePlaylistLike 错误文案", () => {
  it("插件返回空数组 → 抛「该歌单没有可导入的歌曲」", async () => {
    await expect(importRemotePlaylistLike(input({ playlistSongs: async () => ({ songs: [] }) })))
      .rejects.toThrow("该歌单没有可导入的歌曲");
  });

  it("插件返回非数组 → 同样按空歌单处理(不 TypeError)", async () => {
    await expect(importRemotePlaylistLike(input({ playlistSongs: async () => ({ songs: null }) })))
      .rejects.toThrow("该歌单没有可导入的歌曲");
  });

  it("全部被交叉验证拒导 → 错误文案带拒导数量", async () => {
    h.crossVerify.mockResolvedValue({ verified: [], rejected: 3 });
    await expect(importRemotePlaylistLike(input({ playlistSongs: async () => ({ songs: [{ name: "a" }] }) })))
      .rejects.toThrow(/没有歌曲通过导入门禁.*拒导 3 首/);
  });

  it("无拒导但入库产出为空 → 抛「歌曲入库失败,请检查在线源配置」", async () => {
    h.crossVerify.mockResolvedValue({ verified: [{ name: "a" }], rejected: 0 });
    h.importOnline.mockResolvedValue({ songs: [], added: 0, deduped: 0, failed: 1 });
    await expect(importRemotePlaylistLike(input({ playlistSongs: async () => ({ songs: [{ name: "a" }] }) })))
      .rejects.toThrow("歌曲入库失败,请检查在线源配置");
  });

  it("无论成功失败,交互窗口标记都成对开闭(finally)", async () => {
    // 为什么:markInteractiveEnd 漏调会让后台批量任务永久让路(CPU 白白闲置)。
    await expect(importRemotePlaylistLike(input({ playlistSongs: async () => ({ songs: [] }) })))
      .rejects.toThrow();
    expect(h.startCount).toBe(1);
    expect(h.endCount).toBe(1);
  });
});
