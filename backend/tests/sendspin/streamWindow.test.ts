// 解码窗口可配(30s~10min) + 整曲保留模式 的回归守卫(batch45)。
// - normalizeWindowSeconds:纯函数吸附(非法/缺省 → 缺省档 30s,超范围钳两端);
// - retainWholeSong:歌长 ≤ 上限时不淘汰(base 恒 0),回退/前跳 seek 全部命中(零重建);
// - 超窗滑动:歌长 > 上限时背压生效 + 超窗回退触发重定位(保证超窗歌照样播完)。
import "../plugins/_env.js";

import { describe, it, expect } from "vitest";
import { PcmWindow } from "../../src/services/sendspin/streamSource.js";
import {
  WINDOW_SECONDS_OPTIONS,
  WINDOW_DEFAULT_SEC,
  normalizeWindowSeconds,
} from "../../src/services/sendspin/windowConfig.js";
import { SAMPLE_RATE, CHANNELS } from "../../src/services/sendspin/encoding.js";

const SPOOK = (sec: number) => Math.floor(sec * SAMPLE_RATE * CHANNELS);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("normalizeWindowSeconds(档位吸附)", () => {
  it("合法档位原样返回(数字与字符串同等)", () => {
    for (const v of WINDOW_SECONDS_OPTIONS) expect(normalizeWindowSeconds(v)).toBe(v);
    expect(normalizeWindowSeconds(String(WINDOW_DEFAULT_SEC))).toBe(WINDOW_DEFAULT_SEC);
  });

  it("非法/缺省 → 缺省档(30s)", () => {
    expect(normalizeWindowSeconds(undefined)).toBe(WINDOW_DEFAULT_SEC);
    expect(normalizeWindowSeconds(null)).toBe(WINDOW_DEFAULT_SEC);
    expect(normalizeWindowSeconds("abc")).toBe(WINDOW_DEFAULT_SEC);
    expect(normalizeWindowSeconds({})).toBe(WINDOW_DEFAULT_SEC);
  });

  it("非档位值吸附到最近档;超范围钳到两端", () => {
    expect(normalizeWindowSeconds(55)).toBe(60);
    expect(normalizeWindowSeconds(590)).toBe(600);
    expect(normalizeWindowSeconds(10000)).toBe(600);
    expect(normalizeWindowSeconds(0)).toBe(30);
    expect(normalizeWindowSeconds(-5)).toBe(30);
  });
});

describe("PcmWindow 整曲保留(retainWholeSong)", () => {
  it("歌长 ≤ 上限:不淘汰(base 恒 0),回退/前跳 seek 全部命中窗口(返回 false,零重建)", async () => {
    const w = new PcmWindow(
      { input: "sine=frequency=440:duration=20:sample_rate=48000", inputFormat: "lavfi" },
      0,
      { highSec: 60, retainWholeSong: true },
    );
    try {
      const deadline = Date.now() + 25_000;
      while (!w.eof && Date.now() < deadline) await sleep(150);
      expect(w.eof).toBe(true);
      expect(w.decoded).toBeGreaterThanOrEqual(SPOOK(19));
      // 不淘汰 → 基准时刻恒 0(整曲驻留)
      expect(w.baseMs).toBe(0);
      // 回退/前跳均命中窗口 → 不重起 ffmpeg
      expect(await w.seekTo(5_000)).toBe(false);
      expect(await w.seekTo(1_000)).toBe(false);
      expect(await w.seekTo(15_000)).toBe(false);
      const got = await w.slice(SPOOK(1), SPOOK(1.05), 5_000);
      expect(got.length).toBeGreaterThan(0);
    } finally {
      w.close();
    }
  }, 40_000);
});

describe("PcmWindow 超窗滑动(歌长 > 上限)", () => {
  it("背压生效(decoded 停在窗口附近),超窗回退触发重定位(返回 true)", async () => {
    const w = new PcmWindow(
      { input: "sine=frequency=440:duration=60:sample_rate=48000", inputFormat: "lavfi" },
      0,
      { highSec: 30, retainWholeSong: false },
    );
    try {
      const deadline = Date.now() + 30_000;
      let prev = -1;
      for (;;) {
        const cur = w.decoded;
        if (cur >= SPOOK(28) && cur === prev) break;
        if (Date.now() > deadline) break;
        prev = cur;
        await sleep(200);
      }
      expect(w.decoded).toBeGreaterThanOrEqual(SPOOK(28));
      expect(w.decoded).toBeLessThanOrEqual(SPOOK(31)); // 不越过高水位

      // 消费 15s → 淘汰随下一块数据推进 base
      const got = await w.slice(0, SPOOK(15), 15_000);
      expect(got.length).toBeGreaterThan(0);
      const dl2 = Date.now() + 10_000;
      while (w.baseMs <= 5_000 && Date.now() < dl2) await sleep(150);
      expect(w.baseMs).toBeGreaterThan(5_000);

      // 超窗回退(1s < base)→ 重定位
      expect(await w.seekTo(1_000)).toBe(true);
    } finally {
      w.close();
    }
  }, 60_000);
});
