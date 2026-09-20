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

  it("outputFormat 切 s16le(AirPlay RAOP),forceRate/Channels 以输出选项追加", () => {
    const a = decodeArgs({ input: "/m/a.flac", outputFormat: "s16le", forceRate: 44100, forceChannels: 2 });
    expect(a.slice(-7)).toEqual(["-ar", "44100", "-ac", "2", "-f", "s16le", "pipe:1"]);
    expect(decodeArgs({ input: "/m/a.flac" }).slice(-3)).toEqual(["-f", "f32le", "pipe:1"]);
  });

  it("链里有 loudnorm 才提 loglevel 到 info(否则 JSON 被过滤,P0-4 拿不到测量)", () => {
    const plain = decodeArgs({ input: "/m/a.flac" });
    expect(plain.slice(0, 4)).toEqual(["-hide_banner", "-loglevel", "error", "-i"]);
    const withNorm = decodeArgs({
      input: "/m/a.flac",
      af: ["loudnorm=I=-14:TP=-2.0:LRA=10.0:offset=0.0:print_format=json", "alimiter=limit=-1dB:level=false:asc=true:latency=true"],
    });
    expect(withNorm.slice(0, 4)).toEqual(["-hide_banner", "-loglevel", "info", "-i"]);
  });

  it("headers/inputFormat 透传;af 在 -i 之后;forceRate/Channels 以输出选项追加", () => {
    const chain = "loudnorm=I=-14:TP=-2.0:LRA=10.0:offset=0.0:print_format=json";
    const a = decodeArgs({
      input: "/m/a.flac",
      headers: { Authorization: "Basic eDp5" },
      inputFormat: "mp3",
      af: [chain],
      forceRate: 48000,
      forceChannels: 2,
    });
    expect(a.indexOf("-headers")).toBeLessThan(a.indexOf("-i"));
    expect(a.indexOf("-af")).toBeGreaterThan(a.indexOf("-i"));
    expect(a.slice(-9)).toEqual(["-af", chain, "-ar", "48000", "-ac", "2", "-f", "f32le", "pipe:1"]);
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
      "aresample=resampler=soxr:precision=30:osr=48000",
    ]);
    expect(outputFilters({ ...base, sourceRate: 44100, sourceBits: 16, hasLoudnorm: true })).toEqual([
      "aresample=resampler=swr:osr=48000",
    ]);
    expect(outputFilters({ ...base, sourceRate: 44100, sourceBits: 16, soxrAvailable: false })).toEqual([
      "aresample=resampler=swr:osr=48000",
    ]);
  });

  it("仅 >16bit→16bit 加 dither(同滤镜内 osf,不另起 aresample)", () => {
    expect(outputFilters({ ...base, sourceRate: 48000, sourceBits: 24 })).toEqual([
      "aresample=osf=s16:dither_method=triangular_hp",
    ]);
    expect(outputFilters({ ...base, sourceRate: 48000, sourceBits: 16 })).toEqual([]);
    expect(outputFilters({ ...base, sourceRate: 48000, sourceBits: null })).toEqual([]);
  });

  it("源采样率未知不加 aresample(保守)", () => {
    expect(outputFilters({ ...base, sourceRate: null, sourceBits: 16 })).toEqual([]);
  });

  it("变采样率 + 降位深同时成立时合并进同一个 aresample(分开写会跑两遍)", () => {
    expect(outputFilters({ ...base, sourceRate: 96000, sourceBits: 24 })).toEqual([
      "aresample=resampler=soxr:precision=30:osr=48000:osf=s16:dither_method=triangular_hp",
    ]);
  });

  it("forceRate 无视源采样率恒发 aresample(RAOP 44100 这类协议硬性要求)", () => {
    expect(
      outputFilters({ ...base, sourceRate: null, sourceBits: 32, targetRate: 44100, targetBits: 16, forceRate: 44100 }),
    ).toEqual([
      "aresample=resampler=soxr:precision=30:osr=44100:osf=s16:dither_method=triangular_hp",
    ]);
    expect(
      outputFilters({ ...base, sourceRate: 48000, sourceBits: 32, targetRate: 44100, targetBits: 16, forceRate: 44100, hasLoudnorm: true }),
    ).toEqual([
      "aresample=resampler=swr:osr=44100:osf=s16:dither_method=triangular_hp",
    ]);
  });

  it("forceChannels 追加 aformat 声道布局", () => {
    expect(outputFilters({ ...base, sourceRate: 48000, sourceBits: 32, targetRate: 48000, targetBits: 32, forceChannels: "stereo" })).toEqual([
      "aformat=channel_layouts=stereo",
    ]);
    expect(outputFilters({ ...base, sourceRate: 48000, sourceBits: 16, targetRate: 48000, targetBits: 16 })).toEqual([]);
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

describe("resolveLoudnessAf(P1-6):模式切换", () => {
  it("逃生舱/关闭 → 空链;缺省实时 loudnorm＋限制器", async () => {
    const { resolveLoudnessAf } = await import("../../src/services/audio/pipeline.js");
    process.env.SENDSPIN_LOUDNESS = "0";
    try {
      expect(resolveLoudnessAf({ escapeEnvVar: "SENDSPIN_LOUDNESS" })).toEqual([]);
    } finally {
      delete process.env.SENDSPIN_LOUDNESS;
    }
    expect(resolveLoudnessAf({ enabled: false, escapeEnvVar: "SENDSPIN_LOUDNESS" })).toEqual([]);
    const af = resolveLoudnessAf({});
    expect(af[0]).toContain("loudnorm=I=-14");
    expect(af[af.length - 1]).toContain("alimiter=limit=-1dB");
  });

  it("有测量走静态 volume(自定义目标透传)", async () => {
    const { resolveLoudnessAf } = await import("../../src/services/audio/pipeline.js");
    const { saveAnalysis, deleteAnalysis } = await import("../../src/services/audio/analysisStore.js");
    const { db } = await import("../../src/db/index.js");
    const { songs } = await import("../../src/db/schema.js");
    const { eq } = await import("drizzle-orm");
    db.insert(songs).values({
      id: "af-pipe", title: "p", artist: "a", duration: 10,
      path: "/music/p.mp3", contentType: "audio/mpeg", type: "local",
    } as any).run();
    saveAnalysis("af-pipe", "local", { loudnessIntegrated: -10 });
    try {
      expect(resolveLoudnessAf({ rowId: "af-pipe" })[0]).toBe("volume=-4dB");
      expect(resolveLoudnessAf({ rowId: "af-pipe", targetLoudness: -16 })[0]).toBe("volume=-6dB");
      expect(resolveLoudnessAf({ rowId: "no-such-row" })[0]).toContain("loudnorm");
    } finally {
      deleteAnalysis("af-pipe");
      db.delete(songs).where(eq(songs.id, "af-pipe")).run();
    }
  });
});

describe("整命令段序(P1-6):解码 → af → 编码", () => {
  it("sendspin 式整命令:-ss < -i < -af < -ar < -ac < -f pipe", async () => {
    const { resolveLoudnessAf } = await import("../../src/services/audio/pipeline.js");
    const af = [
      ...resolveLoudnessAf({}),
      ...outputFilters({ sourceRate: null, sourceBits: 32, targetRate: 48000, targetBits: 32, hasLoudnorm: true, forceRate: 48000, forceChannels: "stereo" }),
    ];
    const cmd = decodeArgs({ input: "/m/a.flac", timeOffsetSec: 5, af, forceRate: 48000, forceChannels: 2 });
    const idx = (s: string) => cmd.indexOf(s);
    expect(idx("-ss")).toBeGreaterThan(-1);
    expect(idx("-ss")).toBeLessThan(idx("-i"));
    expect(idx("-i")).toBeLessThan(idx("-af"));
    expect(idx("-af")).toBeLessThan(idx("-ar"));
    expect(idx("-ar")).toBeLessThan(idx("-ac"));
    expect(idx("-ac")).toBeLessThan(idx("-f"));
    expect(cmd[cmd.length - 1]).toBe("pipe:1");
  });
});
