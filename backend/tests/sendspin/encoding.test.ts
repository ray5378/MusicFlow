// ==================== Sendspin 音频编码工具(encoding) ====================
// 覆盖:FLAC 容器头定位 / 帧头解析 / 样本统计、codec_header 合成与提取、
// f32↔字节互转、PCM 编码器。全部纯函数,不碰网络与子进程。
// MUST be the first import: redirects DATA_DIR to an isolated temp dir before
// the backend opens its SQLite DB at module-load time.
import "../plugins/_env.js";

import { describe, it, expect } from "vitest";
import {
  SAMPLE_RATE,
  CHANNELS,
  FLAC_BIT_DEPTH,
  FLAC_BLOCK_SIZE,
  encodeCodecParams,
  flacCodecHeaderB64,
  flacCodecHeaderFromStream,
  flacFrameStreamOffset,
  parseFlacFrameHeader,
  scanFlacFrameSamples,
  sumFlacSamples,
  f32ToBytes,
  bytesToF32,
  f32ToS16,
  createChunkEncoder,
  isFlacEncoderReady,
  ffmpegBin,
} from "../../src/services/sendspin/encoding.js";

/** 造一个合法 FLAC 帧头(4096 样本 / 48k / 立体声 / 16bit)。 */
function frameHeader(opts: { bsize?: number; sr?: number; chan?: number; bps?: number; frameNo?: number[] } = {}) {
  const bsize = opts.bsize ?? 12; // 12 = 4096
  const sr = opts.sr ?? 10; // 10 = 48000
  const chan = opts.chan ?? 1; // 1 = 2 channels
  const bps = opts.bps ?? 4; // 4 = 16bit
  const no: number[] = opts.frameNo ?? [0x00];
  return Buffer.from([0xff, 0xf8, (bsize << 4) | sr, (chan << 4) | (bps << 1), ...no, 0x00]);
}

/** 造一段「fLaC + 元数据块」容器头。blocks: [isLast, type, payloadLen] */
function flacContainer(blocks: Array<[boolean, number, number]>): Buffer {
  const parts: Buffer[] = [Buffer.from("fLaC", "ascii")];
  for (const [isLast, type, len] of blocks) {
    const hdr = Buffer.alloc(4);
    hdr[0] = (isLast ? 0x80 : 0x00) | (type & 0x7f);
    hdr[1] = (len >> 16) & 0xff;
    hdr[2] = (len >> 8) & 0xff;
    hdr[3] = len & 0xff;
    parts.push(hdr, Buffer.alloc(len));
  }
  return Buffer.concat(parts);
}

describe("codec 参数与常量", () => {
  it("encodeCodecParams:opus / flac / pcm 三种映射", () => {
    expect(encodeCodecParams("opus")).toEqual({ format: "ogg", codecName: "libopus" });
    expect(encodeCodecParams("flac")).toEqual({ format: "flac", codecName: "flac" });
    expect(encodeCodecParams("pcm")).toEqual({ format: "s16le", codecName: "pcm_s16le" });
  });

  it("常量口径:48k / 立体声 / 16bit / 4096 块", () => {
    expect(SAMPLE_RATE).toBe(48000);
    expect(CHANNELS).toBe(2);
    expect(FLAC_BIT_DEPTH).toBe(16);
    expect(FLAC_BLOCK_SIZE).toBe(4096);
  });

  it("ffmpegBin 与 isFlacEncoderReady 可安全调用", () => {
    expect(typeof ffmpegBin()).toBe("string");
    expect(typeof isFlacEncoderReady()).toBe("boolean");
  });
});

describe("FLAC codec_header", () => {
  it("flacCodecHeaderB64 合成 'fLaC'+STREAMINFO(共 42B)", () => {
    const b64 = flacCodecHeaderB64();
    const buf = Buffer.from(b64, "base64");
    expect(buf.length).toBe(42);
    expect(buf.subarray(0, 4).toString("ascii")).toBe("fLaC");
    expect(buf[4]).toBe(0x80); // last-metadata-block + type 0(STREAMINFO)
    // min/max block size 写入前 4 字节
    // 布局:"fLaC"(4) + 块头 0x80(1) + u24 长度(3) + STREAMINFO(34)
    expect(buf.readUInt16BE(8)).toBe(FLAC_BLOCK_SIZE); // min block size
    expect(buf.readUInt16BE(10)).toBe(FLAC_BLOCK_SIZE); // max block size
  });

  it("可按采样率/声道/位深定制", () => {
    const a = flacCodecHeaderB64(44100, 2, 16);
    const b = flacCodecHeaderB64(48000, 2, 16);
    expect(a).not.toBe(b);
  });

  it("flacCodecHeaderFromStream 从真实段头提取(并置 last-block 位)", () => {
    const seg = Buffer.concat([Buffer.from("fLaC", "ascii"), Buffer.alloc(38)]);
    seg[4] = 0x00; // 非 last(真实流里后面还有 VORBIS_COMMENT)
    const b64 = flacCodecHeaderFromStream(seg)!;
    expect(b64).toBeTruthy();
    const out = Buffer.from(b64, "base64");
    expect(out.length).toBe(42);
    expect(out[4] & 0x80).toBe(0x80); // 被强制置 last
  });

  it("太短 / 非 fLaC → null", () => {
    expect(flacCodecHeaderFromStream(Buffer.alloc(10))).toBeNull();
    expect(flacCodecHeaderFromStream(Buffer.from("RIFF....rest-of-data"))).toBeNull();
  });
});

describe("flacFrameStreamOffset:定位裸帧流起点", () => {
  it("单块 STREAMINFO(last) → 偏移 42", () => {
    expect(flacFrameStreamOffset(flacContainer([[true, 0, 34]]))).toBe(42);
  });

  it("多块(STREAMINFO + VORBIS_COMMENT + PADDING)→ 累加跳过", () => {
    const buf = flacContainer([[false, 0, 34], [false, 4, 44], [true, 1, 8192]]);
    expect(flacFrameStreamOffset(buf)).toBe(4 + 38 + 48 + 8196);
  });

  it("非 fLaC → null(调用方保持原样,宁可多传不截断)", () => {
    expect(flacFrameStreamOffset(Buffer.from("XXXX"))).toBeNull();
    expect(flacFrameStreamOffset(Buffer.alloc(2))).toBeNull();
  });

  it("块类型 127(非法)→ null", () => {
    expect(flacFrameStreamOffset(flacContainer([[false, 127, 8]]))).toBeNull();
  });

  it("容器头未收全 → null", () => {
    const buf = flacContainer([[false, 0, 34], [false, 4, 44]]);
    expect(flacFrameStreamOffset(buf.subarray(0, 20))).toBeNull();
  });
});

describe("parseFlacFrameHeader", () => {
  it("解析标准帧头:4096 样本 / 6B 头", () => {
    const h = parseFlacFrameHeader(frameHeader())!;
    expect(h).toEqual({ samples: 4096, headerBytes: 6 });
  });

  it("非同步字 → null", () => {
    expect(parseFlacFrameHeader(Buffer.from([0x00, 0x00, 0x00, 0x00, 0x00, 0x00]))).toBeNull();
  });

  it("保留块长码(0)/ 采样率码(15)/ 位深码(3)→ null", () => {
    expect(parseFlacFrameHeader(frameHeader({ bsize: 0 }))).toBeNull();
    expect(parseFlacFrameHeader(frameHeader({ sr: 15 }))).toBeNull();
    expect(parseFlacFrameHeader(frameHeader({ bps: 3 }))).toBeNull();
  });

  it("声道码 >10(保留)→ null", () => {
    expect(parseFlacFrameHeader(frameHeader({ chan: 11 }))).toBeNull();
    expect(parseFlacFrameHeader(frameHeader({ chan: 10 }))).toBeTruthy(); // mid/side 合法
  });

  it("块长码 6/7:从流里读 8/16 位块长(+1)", () => {
    const b6 = Buffer.from([0xff, 0xf8, (6 << 4) | 10, (1 << 4) | (4 << 1), 0x00, 0x0f, 0x00]);
    expect(parseFlacFrameHeader(b6)!.samples).toBe(16);
    const b7 = Buffer.from([0xff, 0xf8, (7 << 4) | 10, (1 << 4) | (4 << 1), 0x00, 0x01, 0x00, 0x00]);
    expect(parseFlacFrameHeader(b7)!.samples).toBe(257);
  });

  it("UTF-8 多字节帧号:按前导 1 的个数推进偏移", () => {
    const one = parseFlacFrameHeader(frameHeader({ frameNo: [0xc0, 0x80] }))!;
    expect(one.headerBytes).toBe(7);
  });

  it("缓冲区不足 → null", () => {
    expect(parseFlacFrameHeader(Buffer.from([0xff, 0xf8, 0xca]))).toBeNull();
  });
});

describe("帧样本统计", () => {
  it("scanFlacFrameSamples:逐帧解析出样本数", () => {
    const buf = Buffer.concat([frameHeader(), Buffer.alloc(100), frameHeader(), Buffer.alloc(50)]);
    expect(scanFlacFrameSamples(buf)).toEqual([4096, 4096]);
  });

  it("无帧 → 空数组", () => {
    expect(scanFlacFrameSamples(Buffer.alloc(64))).toEqual([]);
  });

  it("sumFlacSamples 求和;解析不出时按 4B/样本估算(时间线不停滞)", () => {
    const buf = Buffer.concat([frameHeader(), Buffer.alloc(20), frameHeader()]);
    expect(sumFlacSamples(buf)).toBe(8192);
    expect(sumFlacSamples(Buffer.alloc(400))).toBe(100);
  });
});

describe("PCM 互转与编码器", () => {
  it("f32ToBytes / bytesToF32 往返一致", () => {
    const src = new Float32Array([0, 0.5, -0.5, 1, -1]);
    const back = bytesToF32(f32ToBytes(src));
    expect(Array.from(back)).toEqual(Array.from(src));
  });

  it("f32ToS16:满幅钳制且每样本 2 字节", () => {
    const out = f32ToS16(new Float32Array([0, 1, -1, 2, -2]));
    expect(out.length).toBe(10);
    // 小端 s16:0 / 32767 / -32768(越界钳到端点)
    const view = new DataView(out.buffer, out.byteOffset, out.byteLength);
    expect(view.getInt16(0, true)).toBe(0);
    expect(view.getInt16(2, true)).toBe(32767);
    expect(view.getInt16(4, true)).toBe(-32767);
    expect(view.getInt16(6, true)).toBe(32767); // 越界钳到满幅
    expect(view.getInt16(8, true)).toBe(-32767);
  });

  it("createChunkEncoder('pcm') → 单块输出,frameSamples 按声道折算", async () => {
    const enc = createChunkEncoder("pcm");
    const chunks = await enc.encode(new Float32Array(2000));
    expect(chunks.length).toBe(1);
    expect(chunks[0].frameSamples).toBe(1000);
    expect(chunks[0].data.length).toBe(4000);
    expect(await enc.flush()).toEqual([]);
    enc.close();
  });
});
