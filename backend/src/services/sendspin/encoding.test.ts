// flacCodecHeaderB64:定值合成 STREAMINFO,供 stream/start codec_header。
// 2026-09-17 ESPHome 真机:无此头整个 stream/start 被拒,之后每块音频全灭。
import { describe, it, expect } from "vitest";
import { flacCodecHeaderB64, SAMPLE_RATE, CHANNELS } from "./encoding.js";

describe("flacCodecHeaderB64", () => {
  it("fLaC 魔数 + 0x80 块头 + 34B STREAMINFO,解出 48k/立体声/16bit", () => {
    const h = Buffer.from(flacCodecHeaderB64(), "base64");
    expect(h.length).toBe(42);
    expect(h.subarray(0, 4).toString("ascii")).toBe("fLaC");
    expect(h[4]).toBe(0x80); // last-block + STREAMINFO type 0
    expect(h.readUIntBE(5, 3)).toBe(34);
    const info = h.subarray(8);
    expect(info.readUInt16BE(0)).toBe(4608); // 与 ffmpeg flac 实际块大小一致
    expect(info.readUInt16BE(2)).toBe(4608);
    // 10..17B:rate(20b)|ch-1(3b)|bps-1(5b)|总数(36b)
    let pack = 0n;
    for (let i = 0; i < 8; i++) pack = (pack << 8n) | BigInt(info[10 + i]);
    expect(Number((pack >> 44n) & 0xfffffn)).toBe(SAMPLE_RATE);
    expect(Number((pack >> 41n) & 0x7n)).toBe(CHANNELS - 1);
    expect(Number((pack >> 36n) & 0x1fn)).toBe(15); // 16bit
  });
});
