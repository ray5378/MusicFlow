// 回归门禁:暂停后恢复播放**必须从上次暂停位置续播,而非从头(0)**。
//
// 真机现象(2026-09-30 ESP32):暂停 -> 30s 看门狗转 stop(keepCurrent 保留
// group.positionMs) -> 点播放 -> 进度从 0 开始且无声。`coldStartResume` 原实现
// 调 `playMedia(fullItem, baseUrl)` 不带位置,导致 playCore(startMs=0)。
// 修复后它先 `self.pollState()` 读回暂停位置,再透传 startMs。本测试用假
// ProtocolPlayer 把 playMedia 收到的 startMs 抓出来断言 —— 一旦有人把透传删掉,
// 这里立即红。
import { describe, it, expect, vi } from "vitest";

vi.mock("../player/index.js", () => ({
  getQueueController: () => ({
    snapshot: () => ({ currentIndex: 0, items: [{ songId: "song-1", title: "t" }] }),
    resolveItem: async (i: any) =>
      ({ ...i, title: "t", artist: "a", album: "b", coverArt: "", mime: "", duration: 128 }),
  }),
  getPlayerController: () => ({ reportState: () => {} }),
}));

vi.mock("../dlna/control.js", () => ({
  getEffectiveBaseUrl: () => "http://test-base",
  createCastSession: () => ({ streamUrl: "http://test-stream" }),
}));

import { coldStartResume } from "./protocolPlayer.js";

describe("coldStartResume 续播落点门禁", () => {
  it("暂停位置(40.064s)续播:playMedia 收到 startMs=40064,而非 0", async () => {
    const captured: number[] = [];
    const self: any = {
      async pollState() { return { position: 40.064, paused: true, playing: false, duration: 128 }; },
      async playMedia(_item: any, _base: string, startMs = 0) {
        captured.push(startMs);
        return { mediaUri: "x" };
      },
    };
    await coldStartResume(self, "client-1", () => {});
    // 关键断言:续播落点 = 暂停位置(40064ms),绝不能是 0(从头)。
    expect(captured).toEqual([40064]);
  });

  it("读不到位置(0):从头起播,startMs=0,且不得抛错", async () => {
    const captured: number[] = [];
    const self: any = {
      async pollState() { return { position: 0, paused: false, playing: false, duration: 0 }; },
      async playMedia(_item: any, _base: string, startMs = 0) {
        captured.push(startMs);
        return { mediaUri: "x" };
      },
    };
    await expect(coldStartResume(self, "client-2", () => {})).resolves.toBeUndefined();
    expect(captured).toEqual([0]);
  });
});
