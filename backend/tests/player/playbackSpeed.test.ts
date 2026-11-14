import { describe, expect, it } from "vitest";
import {
  DEFAULT_PLAYBACK_SPEED,
  PLAYBACK_SPEEDS,
  atempoFilter,
  bareSpeedId,
  contentToStreamSec,
  normalizePlaybackSpeed,
  streamToContentSec,
  withAtempo,
} from "../../src/services/player/playbackSpeed.js";

describe("playbackSpeed: 档位归一", () => {
  it("白名单与客户端一致(0.75/1/1.25/1.5/1.75/2)", () => {
    expect([...PLAYBACK_SPEEDS]).toEqual([0.75, 1, 1.25, 1.5, 1.75, 2]);
  });

  it("合法档位原样保留", () => {
    for (const s of PLAYBACK_SPEEDS) expect(normalizePlaybackSpeed(s)).toBe(s);
  });

  it("越界/非法按最近档位收敛(绝不下发任意值)", () => {
    expect(normalizePlaybackSpeed(0.9)).toBe(1);
    expect(normalizePlaybackSpeed(1.4)).toBe(1.5);
    expect(normalizePlaybackSpeed(0.1)).toBe(0.75);
    expect(normalizePlaybackSpeed(9)).toBe(2);
    expect(normalizePlaybackSpeed("1.25")).toBe(1.25);
    expect(normalizePlaybackSpeed("abc")).toBe(DEFAULT_PLAYBACK_SPEED);
    expect(normalizePlaybackSpeed(undefined)).toBe(DEFAULT_PLAYBACK_SPEED);
    expect(normalizePlaybackSpeed(-1)).toBe(DEFAULT_PLAYBACK_SPEED);
  });
});

describe("playbackSpeed: atempo 滤镜", () => {
  it("1x 不产生滤镜(af 链逐字节不变)", () => {
    expect(atempoFilter(1)).toBeNull();
    expect(withAtempo(["loudnorm=I=-16"], 1)).toEqual(["loudnorm=I=-16"]);
  });

  it("非 1x 追加在**链尾**(响度/DSP 先按原始时长处理)", () => {
    expect(atempoFilter(1.5)).toBe("atempo=1.5");
    expect(withAtempo(["loudnorm=I=-16", "bass=g=2"], 0.75)).toEqual([
      "loudnorm=I=-16",
      "bass=g=2",
      "atempo=0.75",
    ]);
  });
});

describe("playbackSpeed: 内容时间 ↔ 输出流时间", () => {
  it("1.5x:60s 内容只占 40s 输出流;反向换算回 60s", () => {
    expect(contentToStreamSec(60, 1.5)).toBeCloseTo(40, 6);
    expect(streamToContentSec(40, 1.5)).toBeCloseTo(60, 6);
  });

  it("0.75x:60s 内容占 80s 输出流", () => {
    expect(contentToStreamSec(60, 0.75)).toBeCloseTo(80, 6);
    expect(streamToContentSec(80, 0.75)).toBeCloseTo(60, 6);
  });

  it("1x 恒等;非法倍速按 1x", () => {
    expect(contentToStreamSec(12.5, 1)).toBe(12.5);
    expect(streamToContentSec(12.5, 1)).toBe(12.5);
    expect(contentToStreamSec(10, Number.NaN)).toBe(10);
  });
});

describe("playbackSpeed: id 归一", () => {
  it("剥掉协议前缀(与 QueueController.stripPlayerPrefix 同口径)", () => {
    expect(bareSpeedId("dlna:a")).toBe("a");
    expect(bareSpeedId("group:b")).toBe("b");
    expect(bareSpeedId("airplay:c")).toBe("c");
    expect(bareSpeedId("sendspin:d")).toBe("d");
    expect(bareSpeedId("plain")).toBe("plain");
  });
});
