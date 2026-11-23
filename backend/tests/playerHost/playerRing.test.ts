import { describe, expect, it } from "vitest";
import { PlayerRing, type RingFrame } from "../../src/services/playerHost/playerRing.js";

const RATE = 48_000;
const FRAME_FRAMES = 480; // 10ms
const frame = (tsUs: number, n = FRAME_FRAMES): RingFrame => ({
  tsUs,
  nFrames: n,
  data: new Uint8Array(8),
});
const durUs = (n = FRAME_FRAMES) => (n / RATE) * 1e6;

describe("PlayerRing — 每播放器独立投递环", () => {
  it("按 ts 升序取帧，游标单调前进", () => {
    const ring = new PlayerRing();
    const now = 1_000_000;
    for (let i = 0; i < 3; i++) ring.push(frame(now + i * durUs()), now);
    const r = ring.pull(now, 100_000, 100_000);
    expect(r.frames.map((f) => f.tsUs)).toEqual([now, now + durUs(), now + 2 * durUs()]);
    expect(ring.cursor).toBe(now + 3 * durUs());
  });

  it("过期帧直接丢弃，绝不投给设备（原 bug：喂过去的内容全判 late）", () => {
    const ring = new PlayerRing();
    const now = 5_000_000;
    ring.push(frame(now - 1_000_000), now); // 1s 前的内容：超 grace(300ms)
    const r = ring.pull(now, 100_000, 100_000);
    expect(r.frames).toHaveLength(0);
    expect(ring.droppedLate).toBeGreaterThanOrEqual(1);
  });

  it("水位落后墙钟超阈值 ⇒ 整体前跳，不逐帧追历史", () => {
    const ring = new PlayerRing({ lagResetUs: 800_000 });
    const t0 = 10_000_000;
    ring.push(frame(t0), t0);
    ring.pull(t0, 100_000, 100_000); // 游标 ≈ t0+10ms
    // 3 秒后才来取：应前跳而不是补 3 秒历史
    const later = t0 + 3_000_000;
    ring.push(frame(later), later);
    const r = ring.pull(later, 100_000, 100_000);
    expect(r.jumpedUs).toBeGreaterThan(2_000_000);
    expect(r.frames.every((f) => f.tsUs >= later - 1)).toBe(true);
    expect(ring.jumps).toBe(1);
  });

  it("重复 ts 只收一次；远未来帧不入环", () => {
    const ring = new PlayerRing({ horizonUs: 5_000_000 });
    const now = 1_000_000;
    ring.push(frame(now + 1000), now);
    ring.push(frame(now + 1000), now);
    expect(ring.size).toBe(1);
    ring.push(frame(now + 10_000_000), now); // 超 horizon
    expect(ring.size).toBe(1);
    expect(ring.droppedLate).toBe(1);
  });

  it("游标不倒退（seek 由上层 flush 重建，环内只前进）", () => {
    const ring = new PlayerRing();
    const now = 2_000_000;
    ring.push(frame(now), now);
    ring.pull(now, 100_000, 100_000);
    const cur = ring.cursor;
    ring.push(frame(now - 5_000), now); // 更早的帧（已被 grace 丢弃）
    ring.pull(now, 100_000, 100_000);
    expect(ring.cursor).toBeGreaterThanOrEqual(cur);
  });
});
