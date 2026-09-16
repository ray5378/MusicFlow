// stalled 连续卡死放行:同一首第 1 次重投兜底,第 2 次起切下一首,不再 2-3 秒无限重播。
// 回归:念菩提案(死源 + BUFFERING 不推进)。
import { describe, it, expect, beforeAll } from "vitest";
import { QueueController } from "../../src/services/player/QueueController.js";
import { PlaybackState } from "../../src/services/player/types.js";

function setup() {
  const qc = new QueueController();
  const played: string[] = [];
  const mockPlayer = {
    playerId: "dlna:stalltest",
    async pollState() {
      // 一直 BUFFERING:触发 HiVi 回避检查之后仍走重投/放行逻辑
      return { playerId: "dlna:stalltest", playbackState: PlaybackState.BUFFERING, position: 2, duration: 180, updatedAt: Date.now() };
    },
    async playMedia(item: any) {
      played.push(item.songId);
      return { mediaUri: "x" };
    },
  } as any;
  const mockCtrl = { beginOptimistic: () => {}, endOptimistic: () => {}, reportState: () => {}, resetTracker: () => {} };
  qc.registerPlayer("stalltest", mockPlayer, mockCtrl);
  qc.setQueue("stalltest", [
    { songId: "s1", title: "t1", mime: "audio/mpeg", duration: 180 },
    { songId: "s2", title: "t2", mime: "audio/mpeg", duration: 180 },
  ] as any, 0, "http://base");
  return { qc, played };
}

describe("stalled 连续卡死放行", () => {
  beforeAll(() => {
    if (!process.env.APP_VERSION) process.env.APP_VERSION = "1.0.0";
  });

  it("第 1 次重投同一首,第 2 次切下一首", async () => {
    const { qc, played } = setup();
    await qc.handleDecision("stalled", "dlna:stalltest");
    expect(played).toEqual(["s1"]);
    expect(qc.snapshot("stalltest").currentIndex).toBe(0);
    await qc.handleDecision("stalled", "dlna:stalltest");
    expect(played).toEqual(["s1", "s2"]);
    expect(qc.snapshot("stalltest").currentIndex).toBe(1);
  });

  it("换歌后计数重置:新歌重新给一次重投机会", async () => {
    const { qc, played } = setup();
    await qc.handleDecision("stalled", "dlna:stalltest");
    await qc.handleDecision("stalled", "dlna:stalltest");
    expect(played).toEqual(["s1", "s2"]);
    // s2 再卡:计数按新歌重来,先重投 s2
    await qc.handleDecision("stalled", "dlna:stalltest");
    expect(played).toEqual(["s1", "s2", "s2"]);
  });
});
