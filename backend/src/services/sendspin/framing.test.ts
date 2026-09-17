import { describe, it, expect } from "vitest";
import { packJsonBody, unpackJsonBody, packAudioChunk, parseAudioChunk, fragment, reassemble } from "./framing.js";
import { BIN_JSON, BIN_FRAGMENT_MORE, BIN_FRAGMENT_END, BIN_PLAYER_AUDIO } from "./constants.js";

describe("framing", () => {
  it("JSON body 首字节 0", () => {
    const b = packJsonBody({ type: "server/hello", payload: { name: "x" } });
    expect(b[0]).toBe(BIN_JSON);
    expect(unpackJsonBody(b)).toEqual({ type: "server/hello", payload: { name: "x" } });
  });
  it("⚠️⚠️ 音频块 = [04][i64 BE μs][编码数据], 严格 9B 头(不得有 send_ahead)", () => {
    const data = new Uint8Array([1, 2, 3]);
    const b = packAudioChunk(1_700_000_000n, data);
    expect(b[0]).toBe(BIN_PLAYER_AUDIO);
    expect(b.length).toBe(9 + 3);
    expect(parseAudioChunk(b)).toEqual({ timestampUs: 1_700_000_000n, data });

    // 设备侧 sendspin-cpp `player_role.cpp:handle_binary()` 恒剥 8B 时间戳后
    // 把余下全部当编码音频 —— 任何额外前缀字节都会污染解码器输入。
    // 真实 FLAC 帧必须以 `FF F8`/`FF F9` 开头;9B 之后必须立刻是它。
    const flacFrame = new Uint8Array([0xff, 0xf8, 0xca, 0x18, 0x00, 0x7f]);
    const pkt = packAudioChunk(1n, flacFrame);
    expect(pkt.subarray(9)).toEqual(flacFrame);
    expect(pkt[9]).toBe(0xff);
    expect(pkt[10] & 0xfe).toBe(0xf8);
  });
  it("分片 2/3 重组", () => {
    const big = new Uint8Array(70_000).map((_, i) => i & 0xff);
    const parts = fragment(big, BIN_JSON);
    expect(parts[0][0]).toBe(BIN_FRAGMENT_MORE);
    // 需要多于一帧才会走到 END:70_000 远超单帧上限
    expect(parts.some((p) => p[0] === BIN_FRAGMENT_END)).toBe(true);
    expect(reassemble(parts)).toEqual(big);
  });
});