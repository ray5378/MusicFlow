import { describe, it, expect, vi, beforeEach, beforeAll } from "vitest";
import { QueueController } from "../../src/services/player/QueueController.js";
import { PlaybackState } from "../../src/services/player/types.js";
import type { UniversalPlayer } from "../../src/services/player/UniversalPlayer.js";
import { sqlite } from "../../src/db/index.js";

// 测试环境不会调 initDatabase(),手动建 device_queues 表以让 persist 可写。
beforeAll(() => {
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS device_queues (
      device_id TEXT PRIMARY KEY,
      items_json TEXT NOT NULL DEFAULT '[]',
      current_index INTEGER NOT NULL DEFAULT -1,
      play_mode TEXT NOT NULL DEFAULT 'order',
      is_active INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    );
  `);
});

// Mock UniversalPlayer
function makeMockPlayer(): UniversalPlayer & { calls: string[] } {
  const calls: string[] = [];
  const proto = {
    playerId: "dlna:d1",
    async playMedia() { calls.push("playMedia"); return { mediaUri: "u-new" }; },
    async stop() { calls.push("stop"); },
    async pause() { calls.push("pause"); },
    async resume() { calls.push("resume"); },
    async seek() { calls.push("seek"); },
    async setVolume() { calls.push("setVolume"); },
    async pollState() { calls.push("pollState"); return { playerId: "dlna:d1", playbackState: PlaybackState.IDLE, position: 0, duration: 0, updatedAt: Date.now() }; },
  };
  const up = {
    playerId: "dlna:d1",
    name: "test",
    attachProtocol: () => {},
    getProtocol: () => proto,
    playMedia: proto.playMedia,
    stop: proto.stop,
    pause: proto.pause,
    resume: proto.resume,
    seek: proto.seek,
    setVolume: proto.setVolume,
    pollState: proto.pollState,
    calls,
  } as unknown as UniversalPlayer & { calls: string[] };
  return up;
}

describe("QueueController", () => {
  let qc: QueueController;
  let mockPlayer: ReturnType<typeof makeMockPlayer>;
  let mockCtrl: { beginOptimistic: ReturnType<typeof vi.fn>; endOptimistic: ReturnType<typeof vi.fn>; reportState: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    mockPlayer = makeMockPlayer();
    mockCtrl = {
      beginOptimistic: vi.fn(),
      endOptimistic: vi.fn(),
      reportState: vi.fn(),
    };
    qc = new QueueController();
    // QueueController 内部用裸 deviceId 作 key(与路由/DB 一致);
    // PlayerController 用 "dlna:<deviceId>" 作 playerId。
    qc.registerPlayer("d1", mockPlayer, mockCtrl as any);
    // 填入队列(setQueue 不触发播放,仅设数据)
    qc.setQueue("d1", [
      { songId: "s1", title: "t1", mime: "audio/mpeg" },
      { songId: "s2", title: "t2", mime: "audio/mpeg" },
    ], 0, "http://base");
  });

  it("onDecision('advance'): 推进到下一首并 cast", async () => {
    await qc.handleDecision("advance", "dlna:d1");
    expect(mockPlayer.calls).toContain("playMedia");
    expect(mockCtrl.beginOptimistic).toHaveBeenCalledWith("dlna:d1", "u-new");
  });

  it("onDecision('ended'): 无下一首,标记结束,不 cast", async () => {
    qc.setQueue("d1", [{ songId: "s1", title: "t1", mime: "audio/mpeg" }], 0, "http://base");
    await qc.handleDecision("ended", "dlna:d1");
    expect(mockPlayer.calls).not.toContain("playMedia");
  });

  it("onDecision('stalled'): 卡死,重试当前首一次", async () => {
    await qc.handleDecision("stalled", "dlna:d1");
    expect(mockPlayer.calls).toContain("playMedia");
  });

  it("playMode=one: advance 时重播当前首", async () => {
    qc.setPlayMode("d1", "one");
    await qc.handleDecision("advance", "dlna:d1");
    expect(mockPlayer.calls).toContain("playMedia");
  });
});
