import { describe, it, expect, vi, beforeEach, beforeAll } from "vitest";
import { QueueController } from "../../src/services/player/QueueController.js";
import { PlaybackState } from "../../src/services/player/types.js";
import type { UniversalPlayer } from "../../src/services/player/UniversalPlayer.js";
import { sqlite } from "../../src/db/index.js";
import { setPlaybackSpeed } from "../../src/services/player/playbackSpeed.js";

// 预探测关闭(与 QueueController.test.ts 同口径):避免异步扫描污染 snapshot。
const PRE_PROBE_DISABLED_CFG = {
  enabled: false, lookaheadSongs: 3, deadRunLimit: 50, exhaustedCooldownSeconds: 90,
  probeTimeoutMs: 5000, probeCooldownSeconds: 60, windowMinutes: 8,
  negativeTtlSeconds: 45, concurrency: 3,
};
vi.mock(import("../../src/services/plugin/core/preProbe.js"), async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    preProbeActive: () => false,
    readPreProbeConfig: () => ({ ...PRE_PROBE_DISABLED_CFG }),
  };
});

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
    async pollState() { return { playerId: "dlna:d1", playbackState: PlaybackState.IDLE, position: 0, duration: 0, updatedAt: Date.now() }; },
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

describe("QueueController 可听显示延迟(4.11.12 A 方案)", () => {
  let qc: QueueController;
  let mockPlayer: ReturnType<typeof makeMockPlayer>;
  let mockCtrl: any;

  const setPlayingSample = (pos: number, dur: number) => {
    (qc as any).lastPlaying.set("d1", { pos, dur, at: Date.now() });
  };

  beforeEach(() => {
    mockPlayer = makeMockPlayer();
    mockCtrl = {
      beginOptimistic: vi.fn(), endOptimistic: vi.fn(), reportState: vi.fn(),
      resetTracker: vi.fn(), setExpectedDuration: vi.fn(),
    };
    qc = new QueueController();
    qc.registerPlayer("d1", mockPlayer, mockCtrl);
    qc.setQueue("d1", [
      { songId: "s1", title: "t1", mime: "audio/mpeg", duration: 200 },
      { songId: "s2", title: "t2", mime: "audio/mpeg", duration: 200 },
      { songId: "s3", title: "t3", mime: "audio/mpeg", duration: 200 },
    ], 0, "http://base");
  });

  it("泵路径 advance:旧曲还有 ~10s 可听 → snapshot/status 仍显示旧曲", async () => {
    setPlayingSample(190, 200);
    await qc.handleDecision("advance", "dlna:d1");
    // 内部已切到下一首(cast 已发生),但对外索引仍是旧曲。
    expect(mockPlayer.calls).toContain("playMedia");
    expect(qc.snapshot("d1").currentIndex).toBe(0);
    const hold = qc.displayHoldState("d1");
    expect(hold).toBeTruthy();
    expect(hold!.media.songId).toBe("s1");
    expect(hold!.duration).toBe(200);
    // 位置沿可听时间轴外推(≈190,不会掉回 0)。
    expect(hold!.position).toBeGreaterThan(185);
  });

  it("原生路径(真播完才 advance):remain≈0 → 不设持有,立刻显示下一首", async () => {
    setPlayingSample(200, 200);
    await qc.handleDecision("advance", "dlna:d1");
    // 无持有 ⇒ 立刻对外显示内部当前曲(跳过不可播源时索引可能 >1)。
    expect(qc.snapshot("d1").currentIndex).not.toBe(0);
    expect(qc.displayHoldState("d1")).toBeUndefined();
  });

  it("设备进入新曲(position 重新从小值走)→ 放开显示并广播 queue_changed", async () => {
    setPlayingSample(190, 200);
    await qc.handleDecision("advance", "dlna:d1");
    expect(qc.snapshot("d1").currentIndex).toBe(0);
    const listener = vi.fn();
    qc.on("queue_changed", listener);
    (qc as any).maybeReleaseDisplayHold("d1", { position: 1.2 });
    // playCurrent 可能跳过不可播的下一首,内部索引不一定恰好 +1 —— 只要不再是旧曲即可。
    expect(qc.snapshot("d1").currentIndex).not.toBe(0);
    expect(qc.displayHoldState("d1")).toBeUndefined();
    expect(listener).toHaveBeenCalled();
  });

  it("用户主动 stop/next 会立即清持有(新意图优先)", async () => {
    setPlayingSample(190, 200);
    await qc.handleDecision("advance", "dlna:d1");
    expect(qc.snapshot("d1").currentIndex).toBe(0);
    qc.stopPlayback("d1");
    expect(qc.snapshot("d1").currentIndex).not.toBe(0);
    expect(qc.displayHoldState("d1")).toBeUndefined();
  });

  it("硬顶兜底:超过 remain+5s 即使设备没上报新曲也会放开显示", async () => {
    // 直接设持有(不经 handleDecision):避免 fake timers 干扰起播链路里的真实异步。
    const item = { songId: "s1", title: "t1", mime: "audio/mpeg", duration: 200 };
    qc.setQueue("d1", [item, { songId: "s2", title: "t2", mime: "audio/mpeg" }], 1, "http://base");
    vi.useFakeTimers();
    try {
      (qc as any).setDisplayHold("d1", 0, item, 200, 10, 190, -1);
      expect(qc.snapshot("d1").currentIndex).toBe(0);
      vi.advanceTimersByTime(16_000);
      expect(qc.snapshot("d1").currentIndex).toBe(1);
      expect(qc.displayHoldState("d1")).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it("倍速持有:内容剩余 10s 在 2x 下按 5s 墙钟走完,进度也按 2x 外推", () => {
    const item = { songId: "s1", title: "t1", mime: "audio/mpeg", duration: 200 };
    qc.setQueue("d1", [item, { songId: "s2", title: "t2", mime: "audio/mpeg" }], 1, "http://base");
    setPlaybackSpeed("d1", 2);
    vi.useFakeTimers();
    try {
      (qc as any).setDisplayHold("d1", 0, item, 200, 10, 190, -1);
      vi.advanceTimersByTime(2000);
      // 2s 墙钟 × 2x = 4s 内容 → 190 + 4 ≈ 194(不是 1x 口径的 192)。
      const hold = qc.displayHoldState("d1");
      expect(hold).toBeTruthy();
      expect(hold!.position).toBeGreaterThanOrEqual(193.8);
      expect(hold!.position).toBeLessThanOrEqual(194.2);
      // 内容 10s 在 2x 下 5s 墙钟即播完(定时器到 until,硬顶再 +5s 兜底)。
      vi.advanceTimersByTime(8200);
      expect(qc.snapshot("d1").currentIndex).toBe(1);
      expect(qc.displayHoldState("d1")).toBeUndefined();
    } finally {
      vi.useRealTimers();
      setPlaybackSpeed("d1", 1);
    }
  });
});
