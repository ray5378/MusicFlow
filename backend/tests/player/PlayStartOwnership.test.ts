// 起点归属契约守卫（2026-09-14 ray 拍板，对齐纯 web 前端：**洗牌唯一权威在服务端，
// 起播位置「整列表播放」随机挑首，「指定居中某首」调用方说了算**）。
//
// 背景（历史两次反向修导致摇摆）：
// - 2026-09-10 曾把 playFrom 改成"调用方指定了起点(≥0) 就绝不随机"，于是整列表播放
//   默认把第 1 首 pin 给服务端 → shuffle 下"列表总是第一首开头"（非 web 前端也如是）。
// - 纯 web 前端(localPlayQueue / castPlayQueue)本就是"整列表 shuffle 无条件随机"。
//   2026-09-14 服务端收敛为同一语义，同时保住"指定居中某首"的旧契约。
//
// 本守卫锁死契约：
//   1. **整列表播放**（startIndex 为 null/undefined/负数/0）且 shuffle 且 >1 首 →
//      服务端随机挑首（与 web 前端一致）；
//   2. **指定居中某首**（startIndex 为正整数，如音流/HA 投歌单第 N 首）且 shuffle →
//      严格尊重该下标，绝不随机；
//   3. 非 shuffle / 只有 1 首 → 回落 0（不随机）；
//   4. 随机只作用于**首曲**；后续自动切歌仍沿服务端 shuffleOrder，且 shuffleOrder
//      通过 snapshot() 下发（客户端镜像用，不再自行洗牌）。
//
// 把 playFrom 里的 `listStart` 分支去掉（恢复无条件随机 或 恢复无条件尊重）即红。
import "../plugins/_env.js";

import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from "vitest";
import { QueueController } from "../../src/services/player/QueueController.js";
import { PlayerController } from "../../src/services/player/PlayerController.js";
import {
  PlaybackState,
  type PlayerState,
  type QueueItem,
  type ProtocolPlayer,
} from "../../src/services/player/types.js";
import { UniversalPlayer } from "../../src/services/player/UniversalPlayer.js";
import { sqlite } from "../../src/db/index.js";

beforeAll(() => {
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS songs (
      id TEXT PRIMARY KEY, title TEXT NOT NULL, artist TEXT DEFAULT '', artist_id TEXT,
      album TEXT DEFAULT '', album_id TEXT, duration INTEGER DEFAULT 0,
      bit_rate INTEGER DEFAULT 0, content_type TEXT DEFAULT 'audio/mpeg',
      suffix TEXT DEFAULT 'mp3', path TEXT NOT NULL, cover_art TEXT,
      play_count INTEGER DEFAULT 0, disc_number INTEGER DEFAULT 1, track INTEGER DEFAULT 0,
      genre TEXT DEFAULT '', size INTEGER DEFAULT 0, fingerprint TEXT,
      created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      updated_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      type TEXT DEFAULT 'local', url TEXT, stream_headers TEXT, source_data TEXT,
      plugin_entry TEXT, cache_path TEXT
    );
    CREATE TABLE IF NOT EXISTS device_queues (
      device_id TEXT PRIMARY KEY, items_json TEXT NOT NULL DEFAULT '[]',
      current_index INTEGER NOT NULL DEFAULT -1, play_mode TEXT NOT NULL DEFAULT 'order',
      is_active INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    );
  `);
});

function makeItems(n: number): QueueItem[] {
  return Array.from({ length: n }, (_, i) => ({
    songId: `s${i + 1}`,
    title: `track${i + 1}`,
    mime: "audio/mpeg",
    duration: 100,
  }));
}

/** 极简假设备：只记录被封装的媒体，不模拟完整 GENA 状态机（本文件只测起点选择）。 */
class StubDevice implements Partial<ProtocolPlayer> {
  readonly playerId: string;
  played: string[] = [];
  constructor(public readonly deviceId: string) {
    this.playerId = `dlna:${deviceId}`;
  }
  async playMedia(item: QueueItem): Promise<{ mediaUri: string }> {
    this.played.push(item.songId);
    return { mediaUri: `http://base/stream/${item.songId}` };
  }
  async stop(): Promise<void> {}
  async pause(): Promise<void> {}
  async resume(): Promise<void> {}
  async seek(): Promise<void> {}
  async setVolume(): Promise<void> {}
  async pollState(): Promise<PlayerState> {
    return { state: PlaybackState.PLAYING, position: 0, duration: 100, volume: 50, muted: false };
  }
}

function setup(deviceId = "d1") {
  const pc = new PlayerController();
  const qc = new QueueController();
  const device = new StubDevice(deviceId);
  pc.onDecision = (decision, playerId) => {
    qc.handleDecision(decision, playerId).catch(() => {});
  };
  const up = new UniversalPlayer(device.playerId, "stub");
  up.attachProtocol(device as unknown as ProtocolPlayer);
  qc.registerPlayer(deviceId, up, pc);
  return { pc, qc, device };
}

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date("2026-01-01T00:00:00Z")); });
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe("playFrom 起点归属（整列表播放 random / 指定居中尊重）", () => {
  it("★ 整列表播放（startIndex=0）且 shuffle → 服务端随机挑首，不是固定第 0 首", async () => {
    const { qc, device } = setup();
    // 队列默认 playMode = "shuffle"。start=0 = "整列表播放"，shuffle 下必须随机。
    expect(qc.snapshot("d1").playMode).toBe("shuffle");
    const seen = new Set<number>();
    for (let i = 0; i < 40; i++) {
      const idx = await qc.playFrom("d1", makeItems(200), 0, "http://base");
      expect(idx).toBeGreaterThanOrEqual(0);
      expect(idx).toBeLessThan(200);
      expect(qc.snapshot("d1").currentIndex).toBe(idx);
      seen.add(idx);
    }
    // 40 次全落在同一个下标几乎不可能 → 证明确实随机（复现点：不再恒为 0）。
    expect(seen.size).toBeGreaterThan(1);
    expect(device.played.length).toBeGreaterThan(0);
  });

  it("★ 调用方指定中间下标（>0）时，shuffle 下精确命中该下标（不随机）", async () => {
    const { qc } = setup();
    const seen = new Set<number>();
    for (let i = 0; i < 20; i++) {
      const idx = await qc.playFrom("d1", makeItems(50), 17, "http://base");
      expect(idx).toBe(17);
      expect(qc.snapshot("d1").currentIndex).toBe(17);
      seen.add(idx);
    }
    expect(seen.size).toBe(1); // 恒为 17
  });

  it("未指定起点（null）且 shuffle → 服务端随机（唯一随机点）", async () => {
    const { qc } = setup();
    const seen = new Set<number>();
    for (let i = 0; i < 40; i++) {
      const idx = await qc.playFrom("d1", makeItems(500), null, "http://base");
      expect(idx).toBeGreaterThanOrEqual(0);
      expect(idx).toBeLessThan(500);
      seen.add(idx);
    }
    // 40 次全落在同一个下标几乎不可能 → 证明确实随机了。
    expect(seen.size).toBeGreaterThan(1);
  });

  it("未指定起点且非 shuffle → 回落 0（不随机）", async () => {
    const { qc } = setup();
    qc.setQueue("d1", [], -1, "http://base");
    qc.setPlayMode("d1", "order");
    const idx = await qc.playFrom("d1", makeItems(50), null, "http://base");
    expect(idx).toBe(0);
  });

  it("未指定起点且队列只有 1 首 → 0（无可随机）", async () => {
    const { qc } = setup();
    const idx = await qc.playFrom("d1", makeItems(1), undefined, "http://base");
    expect(idx).toBe(0);
  });

  it("返回实际起播下标，供 /v1/play 如实回执", async () => {
    const { qc } = setup();
    const specified = await qc.playFrom("d1", makeItems(100), 42, "http://base");
    expect(specified).toBe(42);
    const random = await qc.playFrom("d1", makeItems(100), 0, "http://base");
    expect(random).toBe(qc.snapshot("d1").currentIndex);
  });
});

describe("shuffleOrder 权威下发（客户端镜像用）", () => {
  it("snapshot 带 shuffleOrder / shufflePos，且是完整的一轮不重复序列", async () => {
    const { qc } = setup();
    await qc.playFrom("d1", makeItems(10), 3, "http://base");
    const snap = qc.snapshot("d1");
    const order = snap.shuffleOrder!;
    expect(Array.isArray(order)).toBe(true);
    expect(order.length).toBe(10);
    // 一轮内不重复：是 0..9 的一个排列
    expect([...order].sort((a, b) => a - b)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    // 当前曲在序列头部（keepCurrent 语义）
    expect(snap.shufflePos).toBe(0);
    expect(order[0]).toBe(3);
  });

  it("★ 后续自动切歌沿服务端 shuffleOrder 走，客户端无需自行洗牌", async () => {
    const { qc } = setup();
    await qc.playFrom("d1", makeItems(10), 0, "http://base");
    const order = qc.snapshot("d1").shuffleOrder!.slice();
    // 依次 next，游标应逐个落在 shuffleOrder[1], [2], ...
    for (let step = 1; step <= 4; step++) {
      await qc.next("d1", "http://base");
      expect(qc.snapshot("d1").currentIndex).toBe(order[step]);
    }
  });

  it("非 shuffle 模式 shuffleOrder 为空（客户端据此判定无需镜像）", async () => {
    const { qc } = setup();
    qc.setQueue("d1", [], -1, "http://base");
    qc.setPlayMode("d1", "order");
    qc.setQueue("d1", makeItems(5), 0, "http://base");
    expect(qc.snapshot("d1").shuffleOrder).toEqual([]);
  });
});
