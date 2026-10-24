import { describe, it, expect } from "vitest";
import { packJsonBody, unpackJsonBody, packAudioChunk, parseAudioChunk, fragment, reassemble, AUDIO_HEADER_SEND_AHEAD } from "./framing.js";
import { BIN_JSON, BIN_FRAGMENT_MORE, BIN_FRAGMENT_END, BIN_PLAYER_AUDIO } from "./constants.js";

describe("framing", () => {
  it("JSON body 首字节 0", () => {
    const b = packJsonBody({ type: "server/hello", payload: { name: "x" } });
    expect(b[0]).toBe(BIN_JSON);
    expect(unpackJsonBody(b)).toEqual({ type: "server/hello", payload: { name: "x" } });
  });
  it("⚠️⚠️ 音频块头长度必须与客户端一致:9B / 13B(带 send_ahead)", () => {
    // 判据不是「谁多谁少」,而是**两端剥掉的字节数一致**:剥完之后必须立刻是编码音频。
    const skip = AUDIO_HEADER_SEND_AHEAD ? 13 : 9;
    const data = new Uint8Array([1, 2, 3]);
    const b = packAudioChunk(1_700_000_000n, data, 800_000);
    expect(b[0]).toBe(BIN_PLAYER_AUDIO);
    expect(b.length).toBe(skip + 3);
    expect(parseAudioChunk(b)).toEqual({ timestampUs: 1_700_000_000n, data });
    if (AUDIO_HEADER_SEND_AHEAD) {
      // 13B 口径:第 9..12 字节 = send_ahead(u32 BE)
      expect(Buffer.from(b.subarray(9, 13)).readUInt32BE(0)).toBe(800_000);
    }

    // 真实 FLAC 帧必须以 `FF F8`/`FF F9` 开头;头部之后必须立刻是它。
    // (发 9B 而客户端按 13B 切 ⇒ 帧头前 4B 被吞 ⇒ `Error decoding FLAC frame: -2`)
    const flacFrame = new Uint8Array([0xff, 0xf8, 0xca, 0x18, 0x00, 0x7f]);
    const pkt = packAudioChunk(1n, flacFrame);
    expect(pkt.subarray(skip)).toEqual(flacFrame);
    expect(pkt[skip]).toBe(0xff);
    expect(pkt[skip + 1] & 0xfe).toBe(0xf8);
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