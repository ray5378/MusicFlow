// 起点归属契约守卫（2026-09-10 ray 拍板：**洗牌唯一权威在服务端，但起播位置由调用方决定**）。
//
// 背景（客户端实测复现的严重 bug）：
// QueueController.playFrom 曾在 shuffle 模式下**无条件** `Math.random() * items.length`
// 自行挑首起播，把调用方传入的 startIndex 整个丢掉。客户端「投今日漫游歌单的第 N 首」
// 时设备却播了另一首 —— 实测 3251 首队列里 currentIndex 随机落在 560 / 3117 / 3206，
// 用户报告「客户端推的百分百不是当前播放的歌曲」。
//
// 更早的痕迹：三份既有测试（tests/player/integration.test.ts、
// tests/group/GroupPlayback.test.ts、tests/group/GroupWatchdog.test.ts）都不得不
// **手工把 playMode 钉成 "order"** 才能让断言确定 —— 现在它们可以去掉那个 workaround。
//
// 本守卫锁死三条契约：
//   1. **调用方指定了起点（非负整数）→ 绝不随机**，即使 playMode=shuffle；
//   2. 调用方未指定（null/undefined/负数）且 shuffle → 服务端随机（唯一的随机点）；
//   3. 随机只作用于**首曲**；后续自动切歌仍沿服务端 shuffleOrder，且 shuffleOrder
//      通过 snapshot() 下发（客户端镜像用，不再自行洗牌）。
//
// 把 playFrom 里的 `specified` 分支去掉（恢复无条件随机）即红。
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

describe("playFrom 起点归属（调用方指定 → 不随机）", () => {
  it("★ 调用方指定起点 0 时，shuffle 模式下也必须播第 0 首（历史 bug 复现点）", async () => {
    const { qc, device } = setup();
    // 队列默认 playMode = "shuffle" —— 这正是历史 bug 的触发条件。
    expect(qc.snapshot("d1").playMode).toBe("shuffle");
    // 连续 8 次：旧实现必然出现 currentIndex != 0（随机），新实现必须恒为 0。
    for (let i = 0; i < 8; i++) {
      const idx = await qc.playFrom("d1", makeItems(200), 0, "http://base");
      expect(idx).toBe(0);
      expect(qc.snapshot("d1").currentIndex).toBe(0);
    }
    expect(device.played.every((s) => s === "s1")).toBe(true);
  });

  it("★ 调用方指定中间下标时，shuffle 下精确命中该下标", async () => {
    const { qc } = setup();
    const idx = await qc.playFrom("d1", makeItems(50), 17, "http://base");
    expect(idx).toBe(17);
    expect(qc.snapshot("d1").currentIndex).toBe(17);
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
    const random = await qc.playFrom("d1", makeItems(100), null, "http://base");
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
