import { describe, it, expect } from "vitest";
import {
  decodeArgs,
  isLoopbackUrl,
  outputFilters,
  codecArgs,
  INPUT_READ_ARGS,
  HTTP_RECONNECT_ARGS,
} from "../../src/services/audio/ffmpegArgs.js";

// ffmpeg 参数拼装：纯函数零依赖。对齐 MA 的全局参数序、输入读参数、重连参数。
describe("decodeArgs（解码段参数）", () => {
  it("最小输入：全局参数 + INPUT_READ_ARGS + -i + 只取首音频流 + f32le", () => {
    const a = decodeArgs({ input: "/music/a.flac" });
    expect(a.slice(0, 5)).toEqual(["-hide_banner", "-loglevel", "error", "-nostats", "-ignore_unknown"]);
    expect(a).toContain("-i");
    expect(a).toContain("/music/a.flac");
    expect(a).toContain("-map");
    expect(a).toContain("0:a:0");
    expect(a.slice(-3)).toEqual(["-f", "f32le", "pipe:1"]);
    // INPUT_READ_ARGS 每个输入都带
    for (const x of INPUT_READ_ARGS) expect(a).toContain(x);
  });

  it("loudnorm 在 af 链里 → loglevel 提到 info", () => {
    const a = decodeArgs({ input: "/a.flac", af: ["loudnorm=I=-23"] });
    expect(a.slice(0, 3)).toEqual(["-hide_banner", "-loglevel", "info"]);
    expect(a).toContain("-af");
    expect(a).toContain("loudnorm=I=-23");
  });

  it("-ss 只在正数且有限时追加，且在 -i 之前", () => {
    const a = decodeArgs({ input: "/a.flac", timeOffsetSec: 12.5 });
    const ss = a.indexOf("-ss");
    expect(ss).toBeGreaterThan(-1);
    expect(a[ss + 1]).toBe("12.5");
    expect(ss).toBeLessThan(a.indexOf("-i"));
    // 0 / 负数 / NaN 不加
    expect(decodeArgs({ input: "/a", timeOffsetSec: 0 })).not.toContain("-ss");
    expect(decodeArgs({ input: "/a", timeOffsetSec: -1 })).not.toContain("-ss");
    expect(decodeArgs({ input: "/a", timeOffsetSec: NaN })).not.toContain("-ss");
  });

  it("http(s) 输入补重连参数，但 reconnect:false / 显式 inputFormat / 本地路径不补", () => {
    const http = decodeArgs({ input: "https://x/a.mp3" });
    for (const x of HTTP_RECONNECT_ARGS) expect(http).toContain(x);
    const noReconnect = decodeArgs({ input: "https://x/a.mp3", reconnect: false });
    expect(noReconnect).not.toContain("-reconnect");
    const withFmt = decodeArgs({ input: "https://x/a", inputFormat: "mp3" });
    expect(withFmt).not.toContain("-reconnect");
    expect(decodeArgs({ input: "/local/a.mp3" })).not.toContain("-reconnect");
  });

  it("headers 拼成 CRLF 分隔的 -headers，放 -i 之前", () => {
    const a = decodeArgs({ input: "https://x/a", headers: { Authorization: "Bearer t", "X-A": "b" } });
    const h = a.indexOf("-headers");
    expect(h).toBeGreaterThan(-1);
    expect(a[h + 1]).toBe("Authorization: Bearer t\r\nX-A: b");
    expect(h).toBeLessThan(a.indexOf("-i"));
  });

  it("forceRate / forceChannels / outputFormat 作为输出选项追加", () => {
    const a = decodeArgs({ input: "/a", forceRate: 44100.4, forceChannels: 2, outputFormat: "s16le" });
    expect(a).toContain("-ar");
    expect(a[a.indexOf("-ar") + 1]).toBe("44100");
    expect(a).toContain("-ac");
    expect(a[a.indexOf("-ac") + 1]).toBe("2");
    expect(a.slice(-3)).toEqual(["-f", "s16le", "pipe:1"]);
    // 非法值忽略
    const b = decodeArgs({ input: "/a", forceRate: -1, forceChannels: 0 });
    expect(b).not.toContain("-ar");
    expect(b).not.toContain("-ac");
  });
});

describe("isLoopbackUrl（回环地址判定）", () => {
  it("127.0.0.1 / localhost 为回环（大小写不敏感）", () => {
    expect(isLoopbackUrl("http://127.0.0.1:1234/x")).toBe(true);
    expect(isLoopbackUrl("http://LOCALHOST/x")).toBe(true);
  });
  it("IPv6 字面量 [::1]：Node hostname 带方括号，当前实现不识别为回环", () => {
    // new URL('http://[::1]/').hostname === '[::1]'（含方括号），与源码比较的 '::1' 不等。
    // 此处锁定现状；若将来源码补上 IPv6 识别，需同步更新本断言。
    expect(isLoopbackUrl("http://[::1]:1234/x")).toBe(false);
  });
  it("非回环 / 非法 URL 为 false", () => {
    expect(isLoopbackUrl("https://music.example.com/x")).toBe(false);
    expect(isLoopbackUrl("/relative/path")).toBe(false);
  });
});

describe("outputFilters（输出滤镜链）", () => {
  const base = { sourceRate: 48000, sourceBits: 16, targetRate: 48000, targetBits: 16, hasLoudnorm: false };

  it("无需重采样/dither/声道时不加任何滤镜", () => {
    expect(outputFilters(base)).toEqual([]);
    expect(outputFilters({ ...base, sourceBits: null, sourceRate: null })).toEqual([]);
  });

  it("采样率不同 → aresample 带 osr，soxr 可用时 precision=30", () => {
    const f = outputFilters({ ...base, sourceRate: 44100 });
    expect(f.length).toBe(1);
    expect(f[0]).toContain("resampler=soxr:precision=30");
    expect(f[0]).toContain("osr=48000");
  });

  it("loudnorm 或无 soxr → swr", () => {
    expect(outputFilters({ ...base, sourceRate: 44100, hasLoudnorm: true })[0]).toContain("resampler=swr");
    expect(outputFilters({ ...base, sourceRate: 44100, soxrAvailable: false })[0]).toContain("resampler=swr");
  });

  it("高位于深降到 16bit → dither triangular_hp（不是 triangular）", () => {
    const f = outputFilters({ ...base, sourceBits: 24, targetBits: 16 });
    expect(f[0]).toContain("osf=s16");
    expect(f[0]).toContain("dither_method=triangular_hp");
    expect(f[0]).not.toMatch(/triangular(?!_hp)/);
  });

  it("forceRate 无视 sourceRate 恒发 aresample；forceChannels 追加 aformat", () => {
    const f = outputFilters({ ...base, forceRate: 44100, forceChannels: "stereo" });
    expect(f[0]).toContain("osr=44100");
    expect(f.some((x) => x === "aformat=channel_layouts=stereo")).toBe(true);
  });

  it("单个 aresample 同时承载 resample + dither（不跑两遍重采样）", () => {
    const f = outputFilters({ ...base, sourceRate: 44100, sourceBits: 24, targetBits: 16 });
    expect(f.filter((x) => x.startsWith("aresample=")).length).toBe(1);
    expect(f[0]).toContain("osr=48000");
    expect(f[0]).toContain("osf=s16");
  });
});

describe("codecArgs（通道编码参数）", () => {
  it("各编码默认码率", () => {
    expect(codecArgs("flac")).toEqual(["-c:a", "flac"]);
    expect(codecArgs("pcm")).toEqual(["-c:a", "pcm_s16le"]);
    expect(codecArgs("mp3")).toEqual(["-c:a", "libmp3lame", "-b:a", "320k"]);
    expect(codecArgs("aac")).toEqual(["-c:a", "aac", "-b:a", "256k"]);
    expect(codecArgs("opus")).toEqual(["-c:a", "libopus", "-b:a", "128k"]);
  });
  it("自定义码率覆盖默认", () => {
    expect(codecArgs("mp3", 192)).toEqual(["-c:a", "libmp3lame", "-b:a", "192k"]);
    expect(codecArgs("aac", 128)).toEqual(["-c:a", "aac", "-b:a", "128k"]);
  });
});
