// encoding.ts 覆盖补测:防御分支 / 失败收口 / 真实 libFLAC 编码器。
//
// 只补「已有 encoding.test.ts + encodingFrameSplit.test.ts 未触及」的部分:
//   1) libFLAC 未就绪 / 解析失败时的**失败收口**(绝不静默产出空流);
//   2) 一帧一包契约:每个 EncodedChunk 必须自带精确 frameSamples(时间线唯一权威);
//   3) ffmpeg 非零退出 → 解码必须 reject(而不是返回半截缓冲);
//   4) flush 取走尾帧后**原地重建**编码流(否则第二次播报起全链卡死)。
//
// 注意:encoding.ts 用 createRequire 取 libflacjs,是 CJS require —— vitest 的
// vi.mock 拦不住,只能打在 Module._load 上(与 encoding.test.ts 拦 ffmpeg-static 同法)。
import "../plugins/_env.js";

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import Module from "node:module";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";

const origLoad = (Module as any)._load;
type FlacMode = "real" | "throw" | "notReady";
let flacMode: FlacMode = "real";
(Module as any)._load = function (request: string, ...rest: any[]) {
  if (request === "libflacjs") {
    if (flacMode === "throw") throw new Error("libflacjs 不可解析");
    if (flacMode === "notReady") {
      // factory("release") 返回一个「永远不就绪」的模块
      return () => ({ isReady: () => false } as any);
    }
  }
  return origLoad.apply(this, [request, ...rest]);
};

import {
  LibFlacEncoder,
  isFlacEncoderReady,
  waitFlacEncoderReady,
  createChunkEncoder,
  decodeToF32,
  FLAC_BLOCK_SIZE,
  OPUS_FRAME_SAMPLES,
  CHANNELS,
} from "../../src/services/sendspin/encoding.js";

afterAll(() => {
  (Module as any)._load = origLoad;
});

describe("libFLAC 就绪探测的失败收口", () => {
  it("isFlacEncoderReady:libflacjs 解析失败 → false(不抛到调用方)", () => {
    flacMode = "throw";
    try {
      expect(isFlacEncoderReady()).toBe(false);
    } finally {
      flacMode = "real";
    }
  });

  it("isFlacEncoderReady:模块未就绪 → false", () => {
    flacMode = "notReady";
    try {
      expect(isFlacEncoderReady()).toBe(false);
    } finally {
      flacMode = "real";
    }
  });

  it("waitFlacEncoderReady:解析失败 → 立刻 false(不挂到超时)", async () => {
    flacMode = "throw";
    try {
      const t0 = Date.now();
      expect(await waitFlacEncoderReady(2000)).toBe(false);
      expect(Date.now() - t0).toBeLessThan(1500);
    } finally {
      flacMode = "real";
    }
  });

  it("waitFlacEncoderReady:始终不就绪 → 超时返回 false", async () => {
    flacMode = "notReady";
    try {
      expect(await waitFlacEncoderReady(40)).toBe(false);
    } finally {
      flacMode = "real";
    }
  });

  it("LibFlacEncoder 构造时未就绪 → 同步抛错(调用方不得静默产出空流)", () => {
    flacMode = "notReady";
    try {
      expect(() => new LibFlacEncoder()).toThrow(/libFLAC 尚未就绪/);
    } finally {
      flacMode = "real";
    }
  });

  it("编码器就绪后返回 true(waitFlacEncoderReady 的正常出口)", async () => {
    flacMode = "real";
    expect(await waitFlacEncoderReady(5000)).toBe(true);
    expect(isFlacEncoderReady()).toBe(true);
  }, 15_000);
});

describe("decodeToF32:ffmpeg 非零退出必须 reject", () => {
  let tmpDir = "";
  beforeAll(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "enc-gaps-"));
  });
  afterAll(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("ffmpeg 退出码非 0 → 带 stderr 片段 reject(不返回半截缓冲)", async () => {
    const fake = path.join(tmpDir, "fail-ffmpeg.sh");
    fs.writeFileSync(
      fake,
      ["#!/bin/sh", "cat > /dev/null", 'echo "boom-stderr" >&2', "exit 7", ""].join("\n"),
    );
    fs.chmodSync(fake, 0o755);

    const prev = process.env.FFMPEG_PATH;
    process.env.FFMPEG_PATH = fake; // 必须在 decodeToF32 调用(spawn)之前生效
    try {
      await expect(decodeToF32(new Uint8Array([1, 2, 3]))).rejects.toThrow(/ffmpeg decode failed \(7\)/);
    } finally {
      if (prev === undefined) delete process.env.FFMPEG_PATH;
      else process.env.FFMPEG_PATH = prev;
    }
  });
});

describe("LibFlacEncoder:一帧一包 / 首段真实 header / flush 重建", () => {
  /** 一段足够喂满一个 FLAC block 的 F32 立体声交错样本。 */
  function blockF32(monoSamples: number): Float32Array {
    const out = new Float32Array(monoSamples * CHANNELS);
    for (let i = 0; i < out.length; i++) out[i] = Math.sin(i / 50) * 0.5;
    return out;
  }

  it("encode 产出「恰好一帧」的裸包,且首段真实 STREAMINFO 可作 codec_header", async () => {
    expect(await waitFlacEncoderReady(5000)).toBe(true);
    const enc = createChunkEncoder("flac") as LibFlacEncoder;
    expect(enc).toBeInstanceOf(LibFlacEncoder);
    const chunks = await enc.encode(blockF32(FLAC_BLOCK_SIZE * 2));
    expect(chunks.length).toBeGreaterThanOrEqual(1);
    for (const c of chunks) {
      // 每个包必须是 FLAC 帧(FF F8/F9),设备对每个 chunk 只调一次 decode_frame
      expect(c.data[0]).toBe(0xff);
      expect(c.data[1] & 0xfe).toBe(0xf8);
      // 时间线唯一权威:样本数必须是编码器实测值,不是入参长度近似
      expect(c.frameSamples).toBeGreaterThan(0);
    }
    // 首段真实 header:必须是可解 base64,且前 4 字节为 fLaC
    const hb64 = enc.getCodecHeaderB64();
    expect(typeof hb64).toBe("string");
    const head = Buffer.from(hb64!, "base64");
    expect(head.subarray(0, 4).toString("ascii")).toBe("fLaC");
    expect(head.length).toBe(42);
    // 真实 header 的 last-metadata-block 位必须置 1(否则设备按元数据块继续解析 → 无声)
    expect(head[4] & 0x80).toBe(0x80);
    // fixedFrameSamples 来自首帧实测(libFLAC 自选块大小,通常 4096)
    expect(enc.fixedFrameSamples).toBeGreaterThan(0);
    enc.close();
  }, 20_000);

  it("flush 冲掉不足一块的尾帧并**原地重建**编码流,之后还能继续编码", async () => {
    expect(await waitFlacEncoderReady(5000)).toBe(true);
    const enc = new LibFlacEncoder();
    // 只喂 500 单声道样本(< block) → 无完整帧产出
    expect(await enc.encode(blockF32(500))).toEqual([]);
    const tail = await enc.flush();
    // libFLAC finish 会以合法帧头写出尾帧(样本数可能小于 block)
    expect(tail.length).toBeGreaterThanOrEqual(1);
    expect(tail[0].data[0]).toBe(0xff);
    expect(tail[0].data[1] & 0xfe).toBe(0xf8);
    // 关键:flush 终结了旧流 —— 必须重建,否则第二次播报起 process_interleaved 空转卡死
    const again = await enc.encode(blockF32(FLAC_BLOCK_SIZE * 2));
    expect(again.length).toBeGreaterThanOrEqual(1);
    expect(again[0].frameSamples).toBeGreaterThan(0);
    enc.close();
  }, 20_000);

  it("process_interleaved 返回失败 → 放空本次产出(不吐半截/不抛)", async () => {
    expect(await waitFlacEncoderReady(5000)).toBe(true);
    const enc = new LibFlacEncoder();
    // 模拟 libFLAC 内部失败(verify 拒绝等):必须放空并返回 []
    const realProc = (enc as any).Flac.FLAC__stream_encoder_process_interleaved;
    (enc as any).Flac.FLAC__stream_encoder_process_interleaved = () => false;
    try {
      expect(await enc.encode(blockF32(FLAC_BLOCK_SIZE * 2))).toEqual([]);
    } finally {
      // libflacjs 的 Module 可能是单例:必须还原,否则污染后续用例
      (enc as any).Flac.FLAC__stream_encoder_process_interleaved = realProc;
    }
    enc.close();
  }, 20_000);

  it("flush 后重建失败(create 返回 0)→ 编码器停用,encode/flush 一律空(不卡死)", async () => {
    expect(await waitFlacEncoderReady(5000)).toBe(true);
    const enc = new LibFlacEncoder();
    const realCreate = (enc as any).Flac.create_libflac_encoder;
    (enc as any).Flac.create_libflac_encoder = () => 0; // 重建必失败
    try {
      const tail = await enc.flush(); // finish 成功但 openStream 抛错 → 被吞、编码器停用
      expect(Array.isArray(tail)).toBe(true);
      expect(enc.getCodecHeaderB64()).toBeNull(); // header 已被清空且未重建
      expect(await enc.encode(blockF32(FLAC_BLOCK_SIZE))).toEqual([]); // encId=0 → 放空
    } finally {
      (enc as any).Flac.create_libflac_encoder = realCreate;
    }
    enc.close();
  }, 20_000);

  it("close 幂等;关闭后 encode/flush 一律空", async () => {
    expect(await waitFlacEncoderReady(5000)).toBe(true);
    const enc = new LibFlacEncoder();
    enc.close();
    enc.close(); // 第二次不得重复 delete/抛错
    expect(await enc.encode(blockF32(FLAC_BLOCK_SIZE))).toEqual([]);
    expect(await enc.flush()).toEqual([]);
  }, 20_000);
});

describe("编码常量口径(时间线/设备费解的硬约束)", () => {
  it("OPUS_FRAME_SAMPLES 是『交错样本』口径 = 48000*2*20/1000", () => {
    expect(OPUS_FRAME_SAMPLES).toBe((48000 * 2 * 20) / 1000);
  });
});
