import { describe, it, expect } from "vitest";
import { packJsonBody, unpackJsonBody, packAudioChunk, parseAudioChunk, fragment, reassemble } from "./framing.js";
import { BIN_JSON, BIN_FRAGMENT_MORE, BIN_FRAGMENT_END, BIN_PLAYER_AUDIO } from "./constants.js";

describe("framing", () => {
  it("JSON body 首字节 0", () => {
    const b = packJsonBody({ type: "server/hello", payload: { name: "x" } });
    expect(b[0]).toBe(BIN_JSON);
    expect(unpackJsonBody(b)).toEqual({ type: "server/hello", payload: { name: "x" } });
  });
  it("音频块 = [04][i64 BE μs][data], 9B 头", () => {
    const data = new Uint8Array([1, 2, 3]);
    const b = packAudioChunk(1_700_000_000n, data);
    expect(b[0]).toBe(BIN_PLAYER_AUDIO);
    expect(parseAudioChunk(b)).toEqual({ timestampUs: 1_700_000_000n, data });
    expect(b.length).toBe(9 + 3);
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