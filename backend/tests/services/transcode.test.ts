// MUST be the first import: redirects DATA_DIR to an isolated temp dir before
// the backend opens its SQLite DB at module-load time.
import "../plugins/_env.js";

import { describe, it, expect, afterEach } from "vitest";
import {
  decideTranscode,
  normalizeBitRateKbps,
  normalizeTargetFormat,
  resolveFfmpeg,
  acquireTranscodeSlot,
  releaseTranscodeSlot,
  activeTranscodeCount,
} from "../../src/services/transcode.js";

afterEach(() => {
  // 并发槽不允许跨用例泄漏：兜底释放（正常情况下各用例已自行配平）。
  while (activeTranscodeCount() > 0) releaseTranscodeSlot();
});

describe("normalizeBitRateKbps", () => {
  it("kbps 原样保留", () => {
    expect(normalizeBitRateKbps(128)).toBe(128);
    expect(normalizeBitRateKbps(320)).toBe(320);
  });
  it("bps 除以 1000 归一", () => {
    expect(normalizeBitRateKbps(128000)).toBe(128);
    expect(normalizeBitRateKbps(320000)).toBe(320);
  });
  it("空/非正数 → 0", () => {
    expect(normalizeBitRateKbps(null)).toBe(0);
    expect(normalizeBitRateKbps(undefined)).toBe(0);
    expect(normalizeBitRateKbps(0)).toBe(0);
    expect(normalizeBitRateKbps(-5)).toBe(0);
  });
});

describe("normalizeTargetFormat（白名单）", () => {
  it("空 / raw → null（原样返回）", () => {
    expect(normalizeTargetFormat(null)).toBeNull();
    expect(normalizeTargetFormat("")).toBeNull();
    expect(normalizeTargetFormat("raw")).toBeNull();
    expect(normalizeTargetFormat("Raw")).toBeNull();
  });
  it("mp3 / aac 大小写与 . 前缀归一", () => {
    expect(normalizeTargetFormat("mp3")).toBe("mp3");
    expect(normalizeTargetFormat("MP3")).toBe("mp3");
    expect(normalizeTargetFormat(".mp3")).toBe("mp3");
    expect(normalizeTargetFormat("aac")).toBe("aac");
    expect(normalizeTargetFormat("AAC")).toBe("aac");
  });
  it("白名单外格式（flac/ogg/wav/opus...）→ null，防止外部参数打满 CPU", () => {
    expect(normalizeTargetFormat("flac")).toBeNull();
    expect(normalizeTargetFormat("ogg")).toBeNull();
    expect(normalizeTargetFormat("wav")).toBeNull();
    expect(normalizeTargetFormat("opus")).toBeNull();
    expect(normalizeTargetFormat("m4a")).toBeNull();
  });
});

describe("decideTranscode（OpenSubsonic /rest/stream 语义）", () => {
  it("无 format 无 maxBitRate → 原样返回", () => {
    expect(decideTranscode({ sourceFormat: "flac", sourceBitRate: 900 })).toEqual({
      should: false, format: null, bitrateKbps: 0,
    });
  });

  it("format=raw → 原样返回", () => {
    expect(decideTranscode({ requestedFormat: "raw", sourceFormat: "flac", sourceBitRate: 900 })).toEqual({
      should: false, format: null, bitrateKbps: 0,
    });
  });

  it("白名单外格式 → 原样返回", () => {
    expect(decideTranscode({ requestedFormat: "flac", sourceFormat: "flac" })).toEqual({
      should: false, format: null, bitrateKbps: 0,
    });
  });

  it("请求 mp3 且源即 mp3、码率达标 → 直接用原文件，不转码", () => {
    expect(decideTranscode({ requestedFormat: "mp3", sourceFormat: "mp3", sourceBitRate: 320, maxBitRate: 320 })).toEqual({
      should: false, format: null, bitrateKbps: 0,
    });
  });

  it("请求 mp3 但源为 flac → 转 mp3，码率取源/默认 320", () => {
    const d = decideTranscode({ requestedFormat: "mp3", sourceFormat: "flac", sourceBitRate: 900 });
    expect(d.should).toBe(true);
    expect(d.format).toBe("mp3");
    expect(d.bitrateKbps).toBe(320);
  });

  it("请求 mp3、源即 mp3 但 maxBitRate 低于源码率 → 压码率转码", () => {
    const d = decideTranscode({ requestedFormat: "mp3", sourceFormat: "mp3", sourceBitRate: 320, maxBitRate: 128 });
    expect(d.should).toBe(true);
    expect(d.format).toBe("mp3");
    expect(d.bitrateKbps).toBe(128);
  });

  it("请求 aac → 转 aac", () => {
    const d = decideTranscode({ requestedFormat: "aac", sourceFormat: "flac", sourceBitRate: 900 });
    expect(d.should).toBe(true);
    expect(d.format).toBe("aac");
  });

  it("仅 maxBitRate 且源码率更高 → 默认转 mp3 压码率", () => {
    const d = decideTranscode({ sourceFormat: "flac", sourceBitRate: 900, maxBitRate: 192 });
    expect(d.should).toBe(true);
    expect(d.format).toBe("mp3");
    expect(d.bitrateKbps).toBe(192);
  });

  it("仅 maxBitRate 但源码率不超标 → 原样返回", () => {
    expect(decideTranscode({ sourceFormat: "flac", sourceBitRate: 900, maxBitRate: 1000 })).toEqual({
      should: false, format: null, bitrateKbps: 0,
    });
  });

  it("目标码率钳制：mp3 ≤320、aac ≤512、下限 64", () => {
    const mp3 = decideTranscode({ requestedFormat: "mp3", sourceFormat: "flac", sourceBitRate: 1000, maxBitRate: 9999 });
    expect(mp3.bitrateKbps).toBe(320);
    const aac = decideTranscode({ requestedFormat: "aac", sourceFormat: "flac", sourceBitRate: 1000, maxBitRate: 9999 });
    expect(aac.bitrateKbps).toBe(512);
    const lo = decideTranscode({ requestedFormat: "mp3", sourceFormat: "flac", sourceBitRate: 1000, maxBitRate: 8 });
    expect(lo.bitrateKbps).toBe(64);
  });
});

describe("共享契约表（与客户端 shouldUseServerTimeOffsetSeek 对齐，防链路漂移）", () => {
  // 与 MusicFlow-client test/providers/transcoded_stream_seek_test.dart 的
  // _contractVectors 完全一致：同一输入下 should 必须两边相同。
  // 客户端侧 CI（transcode-chain.yml）与本文件互为镜像，任一侧改动判定逻辑都会各自失败。
  const vectors: Array<{
    fmt: string | null;
    br: number | null;
    srcFmt: string | null;
    srcBr: number | null;
    expected: boolean;
  }> = [
    { fmt: null, br: null, srcFmt: "flac", srcBr: 1011, expected: false },
    { fmt: "raw", br: null, srcFmt: "flac", srcBr: 1011, expected: false },
    { fmt: "mp3", br: 320, srcFmt: "flac", srcBr: 1011, expected: true },
    { fmt: "mp3", br: 320, srcFmt: "mp3", srcBr: 192, expected: false },
    { fmt: "mp3", br: null, srcFmt: "mp3", srcBr: 320, expected: false },
    { fmt: "aac", br: null, srcFmt: "flac", srcBr: 1011, expected: true },
    { fmt: null, br: 192, srcFmt: "flac", srcBr: 1011, expected: true },
    { fmt: null, br: 192, srcFmt: "mp3", srcBr: 128, expected: false },
    { fmt: null, br: 1000, srcFmt: "flac", srcBr: 900, expected: false },
    { fmt: "mp3", br: 128, srcFmt: "mp3", srcBr: 320, expected: true },
    { fmt: "flac", br: null, srcFmt: "flac", srcBr: 1011, expected: false },
    { fmt: null, br: 192, srcFmt: "mp3", srcBr: 320000, expected: true },
    { fmt: "aac", br: null, srcFmt: "aac", srcBr: 256, expected: false },
  ];
  it.each(vectors)("fmt=$fmt br=$br src=$srcFmt srcbr=$srcBr → should=$expected", (v) => {
    expect(decideTranscode({
      requestedFormat: v.fmt,
      maxBitRate: v.br,
      sourceFormat: v.srcFmt,
      sourceBitRate: v.srcBr,
    }).should).toBe(v.expected);
  });
});

describe("resolveFfmpeg", () => {
  const prev = process.env.FFMPEG_PATH;
  afterEach(() => {
    if (prev === undefined) delete process.env.FFMPEG_PATH;
    else process.env.FFMPEG_PATH = prev;
  });

  it("FFMPEG_PATH 环境变量优先", () => {
    process.env.FFMPEG_PATH = "/opt/bin/ffmpeg";
    expect(resolveFfmpeg()).toBe("/opt/bin/ffmpeg");
  });

  it("未配置时返回非空可执行名", () => {
    delete process.env.FFMPEG_PATH;
    const bin = resolveFfmpeg();
    expect(typeof bin).toBe("string");
    expect(bin.length).toBeGreaterThan(0);
  });
});

describe("并发槽", () => {
  it("acquire/release 配平后回到 0", async () => {
    await acquireTranscodeSlot();
    await acquireTranscodeSlot();
    expect(activeTranscodeCount()).toBe(2);
    releaseTranscodeSlot();
    releaseTranscodeSlot();
    expect(activeTranscodeCount()).toBe(0);
  });

  it("超出上限排队，释放后唤醒", async () => {
    // 默认上限 4（TRANSCODE_MAX_CONCURRENT）。先占满。
    const held: Promise<void>[] = [];
    for (let i = 0; i < 4; i++) held.push(acquireTranscodeSlot());
    await Promise.all(held);
    expect(activeTranscodeCount()).toBe(4);

    let fifthResolved = false;
    const fifth = acquireTranscodeSlot().then(() => { fifthResolved = true; });
    // 同步断言：第 5 个请求仍在排队。
    expect(fifthResolved).toBe(false);

    releaseTranscodeSlot();
    await fifth;
    expect(fifthResolved).toBe(true);
    expect(activeTranscodeCount()).toBe(4);

    // 清理剩余 4 个槽位。
    for (let i = 0; i < 4; i++) releaseTranscodeSlot();
    expect(activeTranscodeCount()).toBe(0);
  });
});
