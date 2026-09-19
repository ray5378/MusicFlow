// P1-1:AudioPipeline 参数骨架单测(纯拼装,零副作用)。
// 断言即契约:改任一字符串必须同步改 plan §3/§4 与 MA 引证。
import { describe, it, expect } from "vitest";
import {
  decodeArgs,
  loudnessFilter,
  limiterFilter,
  outputFilters,
  codecArgs,
  DEFAULT_TARGET_LUFS,
  LIMITER_CEILING_DB,
} from "../../src/services/audio/pipeline.js";
import { AudioBuffer } from "../../src/services/audio/buffer.js";

describe("decodeArgs ①解码(跟随源)", () => {
  it("不带 -ar/-ac,只取首音频流出 f32le", () => {
    const a = decodeArgs({ input: "/m/a.flac" });
    expect(a).not.toContain("-ar");
    expect(a).not.toContain("-ac");
    expect(a.slice(-3)).toEqual(["-f", "f32le", "pipe:1"]);
    expect(a).toContain("-map");
    expect(a).toContain("0:a:0");
    expect(a).toContain("-vn");
  });

  it("-ss 放 -i 之前;非正数不加", () => {
    const a = decodeArgs({ input: "/m/a.flac", timeOffsetSec: 12.5 });
    expect(a.indexOf("-ss")).toBeLessThan(a.indexOf("-i"));
    expect(a).toContain("12.5");
    expect(decodeArgs({ input: "/m/a.flac", timeOffsetSec: 0 })).not.toContain("-ss");
    expect(decodeArgs({ input: "/m/a.flac", timeOffsetSec: -3 })).not.toContain("-ss");
  });
});

describe("loudnessFilter ②响度", () => {
  it("dynamic 走实时 loudnorm(默认 -14,可配目标)", () => {
    expect(loudnessFilter({ mode: "dynamic" })).toBe(
      `loudnorm=I=${DEFAULT_TARGET_LUFS}:TP=-2.0:LRA=10.0:offset=0.0:print_format=json`,
    );
    expect(loudnessFilter({ mode: "dynamic", targetLoudness: -16 })).toContain("I=-16");
  });

  it("fixed_gain/measurement_only 走 volume 静态增益", () => {
    expect(loudnessFilter({ mode: "fixed_gain", gainDb: -3.5 })).toBe("volume=-3.5dB");
    expect(loudnessFilter({ mode: "measurement_only", gainDb: 2 })).toBe("volume=2dB");
    expect(loudnessFilter({ mode: "fixed_gain" })).toBe("volume=0dB");
  });

  it("disabled/source 不加滤镜(禁二次归一)", () => {
    expect(loudnessFilter({ mode: "disabled" })).toBeNull();
    expect(loudnessFilter({ mode: "source" })).toBeNull();
  });
});

describe("limiterFilter ⑤限制器", () => {
  it("默认 -1dB 纯天花板语义", () => {
    expect(limiterFilter()).toBe(`alimiter=limit=${LIMITER_CEILING_DB}dB:level=false:asc=true:latency=true`);
    expect(limiterFilter(-2)).toContain("limit=-2dB");
  });
});

describe("outputFilters ⑥重采样 + dither(按需)", () => {
  const base = { targetRate: 48000, targetBits: 16, hasLoudnorm: false } as const;

  it("同采样率不加 aresample", () => {
    expect(outputFilters({ ...base, sourceRate: 48000, sourceBits: 16 })).toEqual([]);
  });

  it("变采样率:无 loudnorm 走 soxr,有 loudnorm 降级 swr", () => {
    expect(outputFilters({ ...base, sourceRate: 44100, sourceBits: 16 })).toEqual([
      "aresample=48000:resampler=soxr:precision=30",
    ]);
    expect(outputFilters({ ...base, sourceRate: 44100, sourceBits: 16, hasLoudnorm: true })).toEqual([
      "aresample=48000:resampler=swr",
    ]);
    expect(outputFilters({ ...base, sourceRate: 44100, sourceBits: 16, soxrAvailable: false })).toEqual([
      "aresample=48000:resampler=swr",
    ]);
  });

  it("仅 >16bit→16bit 加 triangular_hp(不是 triangular)", () => {
    expect(outputFilters({ ...base, sourceRate: 48000, sourceBits: 24 })).toEqual([
      "aresample=osf=s16:dither_method=triangular_hp",
    ]);
    expect(outputFilters({ ...base, sourceRate: 48000, sourceBits: 16 })).toEqual([]);
    expect(outputFilters({ ...base, sourceRate: 48000, sourceBits: null })).toEqual([]);
  });

  it("源采样率未知不加 aresample(保守)", () => {
    expect(outputFilters({ ...base, sourceRate: null, sourceBits: 16 })).toEqual([]);
  });

  it("变采样率 + 降位深同时成立时两条都出且有序", () => {
    expect(outputFilters({ ...base, sourceRate: 96000, sourceBits: 24 })).toEqual([
      "aresample=48000:resampler=soxr:precision=30",
      "aresample=osf=s16:dither_method=triangular_hp",
    ]);
  });
});

describe("codecArgs 通道编码", () => {
  it("mp3/aac 默认码率,flac/pcm 无码率参数", () => {
    expect(codecArgs("mp3")).toEqual(["-c:a", "libmp3lame", "-b:a", "320k"]);
    expect(codecArgs("aac")).toEqual(["-c:a", "aac", "-b:a", "256k"]);
    expect(codecArgs("flac")).toEqual(["-c:a", "flac"]);
    expect(codecArgs("pcm")).toEqual(["-c:a", "pcm_s16le"]);
    expect(codecArgs("mp3", 192)).toEqual(["-c:a", "libmp3lame", "-b:a", "192k"]);
  });
});

describe("AudioBuffer 下标数学", () => {
  it("跨块切片 + 越界截断 + 淘汰后越界抛", () => {
    const b = new AudioBuffer();
    b.append(new Float32Array([1, 2, 3, 4]));
    b.append(new Float32Array([5, 6, 7, 8]));
    expect(b.decodedSamples).toBe(8);
    expect(Array.from(b.slice(2, 6))).toEqual([3, 4, 5, 6]);
    expect(b.slice(6, 100).length).toBe(2); // EOF 截断
    expect(b.slice(4, 4).length).toBe(0);
    b.evictBefore(4);
    expect(b.base).toBe(4);
    expect(Array.from(b.slice(4, 6))).toEqual([5, 6]);
    expect(() => b.slice(2, 4)).toThrow(RangeError);
  });

  it("clear 保留基址,reset 归零", () => {
    const b = new AudioBuffer();
    b.append(new Float32Array([1, 2]));
    b.clear();
    expect(b.buffered).toBe(0);
    b.append(new Float32Array([9]));
    expect(b.base).toBe(0); // clear 不动基址:调用方须 reset 才能复用播下一首
    b.reset();
    b.append(new Float32Array([7]));
    expect(Array.from(b.slice(0, 1))).toEqual([7]);
  });
});
