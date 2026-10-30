// ==================== 预览下一首:跳过已被判死的歌(2026-10-30) ====================
//
// 锁住四条:
//   1. 默认(不传 skipDead)行为与旧版逐字节一致 —— 只取第 1 个位置,不查缓存;
//   2. skipDead 时跳过 `unplayable` 的曲,继续往后看;
//   3. 未知 / transient / playable 一律不跳(「不把不知道当成死的」边界);
//   4. 全被判死 / 取不到 → undefined(不预热),且绝不抛。
import { describe, it, expect, beforeEach, vi } from "vitest";

const H = vi.hoisted(() => ({
  dead: new Set<string>(),
  throws: false,
}));

vi.mock("../../src/services/source/online/streamFallback.js", () => ({
  getCachedPlayability: (songId: string) => {
    if (H.throws) throw new Error("boom");
    return H.dead.has(songId) ? "unplayable" : "unknown";
  },
}));
vi.mock("../../src/services/source/prefetchCache.js", () => ({
  prefetchSong: async () => undefined,
}));

import { peekNextSongId } from "../../src/services/player/drainPreheat.js";
import type { QueuePeekSource } from "../../src/services/player/preProbeScheduler.js";

function peekOf(songIds: string[], currentIndex = 0): QueuePeekSource {
  return { items: songIds.map((songId) => ({ songId })), currentIndex, playMode: "order" };
}

beforeEach(() => {
  H.dead.clear();
  H.throws = false;
});

describe("peekNextSongId 跳过判死曲", () => {
  it("默认行为不变:只取下一个,不查缓存", () => {
    H.dead.add("b");
    expect(peekNextSongId(peekOf(["a", "b", "c"]))).toBe("b");
  });

  it("skipDead:跳过 unplayable,取下一个活着的", () => {
    H.dead.add("b");
    expect(peekNextSongId(peekOf(["a", "b", "c", "d"]), { skipDead: true })).toBe("c");
  });

  it("skipDead:连续两首判死 → 取第三首", () => {
    H.dead.add("b");
    H.dead.add("c");
    expect(peekNextSongId(peekOf(["a", "b", "c", "d"]), { skipDead: true })).toBe("d");
  });

  it("skipDead:全判死 → undefined(不预热)", () => {
    H.dead.add("b");
    H.dead.add("c");
    expect(peekNextSongId(peekOf(["a", "b", "c"]), { skipDead: true })).toBeUndefined();
  });

  it("未知 / 网络抖动不跳(不把不知道当成死的)", () => {
    expect(peekNextSongId(peekOf(["a", "b"]), { skipDead: true })).toBe("b");
  });

  it("判据本身抛错 → 照常取下一个,不抛", () => {
    H.throws = true;
    expect(() => peekNextSongId(peekOf(["a", "b"]), { skipDead: true })).not.toThrow();
    expect(peekNextSongId(peekOf(["a", "b"]), { skipDead: true })).toBe("b");
  });

  it("没有队列 / 越界 → undefined", () => {
    expect(peekNextSongId(undefined, { skipDead: true })).toBeUndefined();
    expect(peekNextSongId(peekOf(["a"], 0), { skipDead: true })).toBeUndefined();
  });
});
