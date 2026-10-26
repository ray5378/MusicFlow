// ==================== 完整性判官「判据顺序」守卫（2026-10-27 240 生产缺陷） ====================
//
// 事故：插件源（web/汽水音乐）把几 KB 的 JSON/HTML 错误页当 200 返回。判官原来**先判体积**
// （<64KB ⇒ too-small）再判 magic，于是错误页被归类成「弱信号 too-small」—— 按 2026-10-21
// 的策略只重试一次、**不写负缓存**，等于放行；播放侧照播这段假内容，整首歌「无源」的
// 结论永远建立不起来。
//
// 本文件锁住修复后的顺序语义：
//   ① 非音频（HTML/JSON 错误页）⇒ not-audio 硬结论（无论多小/多大都走负缓存）；
//   ② 是音频但太小 ⇒ too-small 弱信号（保持「重试一次、不记负缓存」）；
//   ③ 正常 mp3 不受影响（缓存路径未退化）；
//   ④ 60s 真音频 vs 期望 276s ⇒ preview（metadata 口径 15s）；
//   ⑤ 期望 0 ⇒ 放过。
// 判据只读入参 Buffer + music-metadata 的 mock 返回值，不碰网络 / 不解真码。
import { describe, it, expect, vi, beforeEach } from "vitest";
import { judgePrefetchedBuffer } from "../../src/services/source/prefetchCache.js";

// music-metadata 的 parseBuffer 由本文件控制返回时长/码率（判官档 3/4 的输入）。
const mm = vi.hoisted(() => ({ duration: 276, bitrate: 0, fail: false }));
vi.mock("music-metadata", () => ({
  parseBuffer: async () => {
    if (mm.fail) throw new Error("mock parse failure");
    return { format: { duration: mm.duration, bitrate: mm.bitrate, container: "mp3" }, common: {} };
  },
}));

/** 2KB HTML 错误页（240 现场：`{"error":"..."}` / `<html>403` 这类几 KB 的假成功）。 */
function htmlErrorPage(bytes = 2048): Buffer {
  return Buffer.concat([
    Buffer.from("<!DOCTYPE html><html><body>403 Forbidden</body></html>", "utf8"),
    Buffer.alloc(Math.max(0, bytes - 52), 0x20),
  ]);
}

/** JSON 错误页（同一个坑的另一半：`{"code":403,...}`）。 */
function jsonErrorPage(bytes = 900): Buffer {
  return Buffer.concat([Buffer.from('{"error":"forbidden","code":403}', "utf8"), Buffer.alloc(Math.max(0, bytes - 33), 0x20)]);
}

/** 合法音频头的 mp3（ID3v2 + 若干静音字节）—— magic 认它是音频。 */
function mp3Bytes(bytes: number): Buffer {
  const head = Buffer.from([0x49, 0x44, 0x33, 0x04, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]); // "ID3" v2.4
  return Buffer.concat([head, Buffer.alloc(Math.max(0, bytes - head.length), 0)]);
}

beforeEach(() => {
  mm.duration = 276;
  mm.bitrate = 0;
  mm.fail = false;
});

describe("judgePrefetchedBuffer：magic 先于 too-small（顺序锁）", () => {
  it("2KB HTML 错误页（<64KB）⇒ not-audio 硬结论，而不是 too-small", async () => {
    const v = await judgePrefetchedBuffer(htmlErrorPage(2 * 1024), 276);
    expect(v.dead).toBe(true);
    expect(v.reason).toBe("not-audio");
    expect(v.reason).not.toBe("too-small");
  });

  it("900B JSON 错误页 ⇒ not-audio（体积再小也走硬结论）", async () => {
    const v = await judgePrefetchedBuffer(jsonErrorPage(), 276);
    expect(v.dead).toBe(true);
    expect(v.reason).toBe("not-audio");
  });

  it("80KB HTML（> 64KB，旧顺序也能抓到）⇒ 仍是 not-audio（不小于阈值不影响判据）", async () => {
    const v = await judgePrefetchedBuffer(htmlErrorPage(80 * 1024), 276);
    expect(v.dead).toBe(true);
    expect(v.reason).toBe("not-audio");
  });

  it("10KB 真 mp3（magic 认音频但被截断）⇒ too-small 弱信号（重试一次、不记负缓存）", async () => {
    const v = await judgePrefetchedBuffer(mp3Bytes(10 * 1024), 276);
    expect(v.dead).toBe(true);
    expect(v.reason).toBe("too-small");
  });

  it("正常 mp3（128KB / 解析出 276s）⇒ 放过（缓存路径不受影响）", async () => {
    mm.duration = 276;
    const v = await judgePrefetchedBuffer(mp3Bytes(128 * 1024), 276);
    expect(v.dead).toBe(false);
    expect(v.reason).toBeUndefined();
    expect(v.via).toBe("metadata");
    expect(v.expectedSec).toBe(276);
  });
});

describe("judgePrefetchedBuffer：时长档（不受顺序调整影响）", () => {
  it("60s 真音频 vs 期望 276s ⇒ preview（metadata 口径 15s）", async () => {
    mm.duration = 60;
    const v = await judgePrefetchedBuffer(mp3Bytes(128 * 1024), 276);
    expect(v.dead).toBe(true);
    expect(v.reason).toBe("preview");
    expect(v.via).toBe("metadata");
    expect(v.actualSec).toBe(60);
    expect(v.expectedSec).toBe(276);
  });

  it("期望 0（曲库无基准）⇒ 60s 也放过", async () => {
    mm.duration = 60;
    const v = await judgePrefetchedBuffer(mp3Bytes(128 * 1024), 0);
    expect(v.dead).toBe(false);
    expect(v.expectedSec).toBeUndefined();
  });

  it("期望 0 且内容是非音频 ⇒ 仍判 not-audio（硬结论不依赖基准）", async () => {
    const v = await judgePrefetchedBuffer(htmlErrorPage(2 * 1024), 0);
    expect(v.dead).toBe(true);
    expect(v.reason).toBe("not-audio");
  });
});
