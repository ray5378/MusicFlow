// ==================== 子进程预热:跨进程断层的反方向(2026-10-30) ====================
//
// 锁住四条:
//   1. 本进程里有在用 sendspin 的组 → 才探测(纯 DLNA 播放不白探);
//   2. 幂等:同一首只探一次(曲末 500ms 节拍会反复触发);
//   3. 探测抛错不外泄(预热失败只等于回到旧行为,绝不许影响播放主链路);
//   4. 空 id / 无组一律静默返回。
import { describe, it, expect, beforeEach, vi } from "vitest";

const H = vi.hoisted(() => ({
  hasPump: true,
  calls: [] as string[],
  throws: false,
  reason: "ensure-ok",
}));

vi.mock("../../src/services/sendspin/streamEngine.js", () => ({
  hasActivePump: () => H.hasPump,
}));
vi.mock("../../src/services/source/resolveAudio.js", () => ({
  resolvePlayableRow: async (songId: string) => {
    H.calls.push(songId);
    if (H.throws) throw new Error("boom");
    return { row: { id: "row-1" }, reason: H.reason };
  },
}));

import {
  warmSongInChild,
  resetPreheatChildStateForTest,
} from "../../src/services/sendspin/preheatChild.js";

/** 预热是 fire-and-forget:等微任务 + 一个宏任务跑完再断言。 */
async function flush(): Promise<void> {
  for (let i = 0; i < 5; i++) await Promise.resolve();
  await new Promise((r) => setTimeout(r, 0));
}

beforeEach(() => {
  resetPreheatChildStateForTest();
  H.hasPump = true;
  H.calls.length = 0;
  H.throws = false;
  H.reason = "ensure-ok";
});

describe("warmSongInChild", () => {
  it("有在用 sendspin 的组 → 在本进程内探测一次", async () => {
    warmSongInChild("song-a");
    await flush();
    expect(H.calls).toEqual(["song-a"]);
  });

  it("幂等:同一首重复触发只探测一次(曲末节拍不会反复抢 IO)", async () => {
    warmSongInChild("song-a");
    warmSongInChild("song-a");
    warmSongInChild("song-a");
    await flush();
    expect(H.calls).toEqual(["song-a"]);
  });

  it("本进程没有在用 sendspin 的组 → 不探测(纯 DLNA 播放不白探)", async () => {
    H.hasPump = false;
    warmSongInChild("song-a");
    await flush();
    expect(H.calls).toHaveLength(0);
  });

  it("空 id / 非字符串 → 静默返回", async () => {
    warmSongInChild("");
    warmSongInChild("   ");
    warmSongInChild(undefined as unknown as string);
    await flush();
    expect(H.calls).toHaveLength(0);
  });

  it("探测抛错不外泄(fire-and-forget 不得冒到调用方)", async () => {
    H.throws = true;
    expect(() => warmSongInChild("song-a")).not.toThrow();
    await flush();
    expect(H.calls).toEqual(["song-a"]);
  });

  it("reset 后可以对同一首再来一次(换会话/换组)", async () => {
    warmSongInChild("song-a");
    await flush();
    resetPreheatChildStateForTest();
    warmSongInChild("song-a");
    await flush();
    expect(H.calls).toEqual(["song-a", "song-a"]);
  });
});
