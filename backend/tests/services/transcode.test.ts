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
  activeTranscodeCount,
  slotLimit,
  resolveSlotLimits,
  transcodeArgs,
} from "../../src/services/transcode.js";

// 并发槽不允许跨用例泄漏：本文件申请到的租约统一在 afterEach 释放，
// 释放完必须归零（顺带把「谁忘了配对」这类回归钉住）。
const heldLeases: Array<() => void> = [];
async function hold(kind?: "quality" | "pipeline"): Promise<() => void> {
  const release = await acquireTranscodeSlot(kind);
  heldLeases.push(release);
  return release;
}
afterEach(() => {
  while (heldLeases.length) heldLeases.pop()!();
  expect(activeTranscodeCount()).toBe(0);
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

describe("并发池（P2-5 / P3-6）", () => {
  it("上限按核数派生：quality=核数(下限4/上限8)、pipeline=核数×2(下限6)、flow=核数(下限4)", () => {
    expect(resolveSlotLimits(8, {})).toEqual({ quality: 8, pipeline: 16, flow: 8 });
    // 小机器：quality 保底 4，pipeline 保底 6，flow 保底 4
    expect(resolveSlotLimits(2, {})).toEqual({ quality: 4, pipeline: 6, flow: 4 });
    // 大机器：quality 封顶 8（编码重，不无限开），pipeline / flow 跟着核数走
    expect(resolveSlotLimits(32, {})).toEqual({ quality: 8, pipeline: 64, flow: 32 });
    // 核数取不到 → 按 4 核兜底
    expect(resolveSlotLimits(NaN, {})).toEqual({ quality: 4, pipeline: 8, flow: 4 });
  });

  it("环境变量可覆盖，非法 / 非正数回退默认", () => {
    expect(resolveSlotLimits(8, { TRANSCODE_MAX_CONCURRENT: "3" }).quality).toBe(3);
    expect(resolveSlotLimits(8, { TRANSCODE_PIPELINE_MAX_CONCURRENT: "5" }).pipeline).toBe(5);
    expect(resolveSlotLimits(8, { TRANSCODE_FLOW_MAX_CONCURRENT: "2" }).flow).toBe(2);
    expect(resolveSlotLimits(8, { TRANSCODE_MAX_CONCURRENT: "0" }).quality).toBe(8);
    expect(resolveSlotLimits(8, { TRANSCODE_MAX_CONCURRENT: "abc" }).quality).toBe(8);
    expect(resolveSlotLimits(8, { TRANSCODE_MAX_CONCURRENT: "-2" }).quality).toBe(8);
    expect(resolveSlotLimits(8, { TRANSCODE_FLOW_MAX_CONCURRENT: "-1" }).flow).toBe(8);
  });

  it("flow 池独立：交叉淡入的解码器不挤占实时管道（P3-6 的全部意义）", async () => {
    // 占满 flow 池（模拟"多个会话同时处在过渡期"）
    for (let i = 0; i < slotLimit("flow"); i++) await hold("flow");
    expect(activeTranscodeCount("flow")).toBe(slotLimit("flow"));
    // 实时管道池一点没被吃掉 → 普通出流不受交叉淡入影响
    expect(activeTranscodeCount("pipeline")).toBe(0);
    const p = await acquireTranscodeSlot("pipeline");
    heldLeases.push(p);
    expect(activeTranscodeCount("pipeline")).toBe(1);
    // 合计计数把三池都算上（兼容旧调用点）
    expect(activeTranscodeCount()).toBe(slotLimit("flow") + 1);
  });

  it("租约配平后回到 0，且释放幂等", async () => {
    const a = await hold("quality");
    await hold("quality");
    expect(activeTranscodeCount("quality")).toBe(2);
    a();
    a(); // 幂等：重复释放不会把额度多还回去
    expect(activeTranscodeCount("quality")).toBe(1);
  });

  it("池内超出上限排队，释放后唤醒", async () => {
    const limit = slotLimit("pipeline");
    for (let i = 0; i < limit; i++) await hold("pipeline");
    expect(activeTranscodeCount("pipeline")).toBe(limit);

    let extraAcquired = false;
    const extra = acquireTranscodeSlot("pipeline").then((r) => { extraAcquired = true; heldLeases.push(r); });
    // 同步断言：第 limit+1 个仍在排队。
    expect(extraAcquired).toBe(false);

    heldLeases.shift()!(); // 放掉一个
    await extra;
    expect(extraAcquired).toBe(true);
    expect(activeTranscodeCount("pipeline")).toBe(limit);
  });

  it("两池互不抢槽：管道占满不影响音质转码，反之亦然", async () => {
    const drain = () => { while (heldLeases.length) heldLeases.pop()!(); };

    // A. 占满管道池 → 音质池仍能立即取到槽（不被管道池的排队挡住）
    for (let i = 0; i < slotLimit("pipeline"); i++) await hold("pipeline");
    await expect(hold("quality")).resolves.toBeTypeOf("function");
    expect(activeTranscodeCount("quality")).toBe(1);
    drain();

    // B. 占满音质池 → 管道池仍能立即取到槽
    for (let i = 0; i < slotLimit("quality"); i++) await hold("quality");
    await expect(hold("pipeline")).resolves.toBeTypeOf("function");
    expect(activeTranscodeCount("pipeline")).toBe(1);
  });

  it("不传 kind 时统计两池合计（兼容旧调用点）", async () => {
    await hold("quality");
    await hold("pipeline");
    expect(activeTranscodeCount()).toBe(2);
    expect(activeTranscodeCount("quality")).toBe(1);
    expect(activeTranscodeCount("pipeline")).toBe(1);
  });
});

describe("transcodeArgs(P1-5):音质档位与af同一次进程", () => {
  it("无 af 时与旧命令一致(mp3/headers/seek/-map)", () => {
    expect(
      transcodeArgs({
        source: "/m/a.flac",
        headers: { Authorization: "Basic eDp5" },
        format: "mp3",
        bitrateKbps: 192,
        timeOffsetSec: 30,
      }),
    ).toEqual([
      "-hide_banner", "-loglevel", "error",
      "-ss", "30",
      "-headers", "Authorization: Basic eDp5",
      "-i", "/m/a.flac",
      "-vn", "-sn", "-dn", "-map", "0:a:0",
      "-c:a", "libmp3lame", "-b:a", "192k",
      "-f", "mp3", "-",
    ]);
  });

  it("aac 容器是 adts;有 af 时响度链与编码同进程且提 loglevel", () => {
    const a = transcodeArgs({
      source: "/m/a.flac",
      format: "aac",
      bitrateKbps: 256,
      af: ["loudnorm=I=-14:TP=-2.0:LRA=10.0:offset=0.0:print_format=json", "alimiter=limit=-1dB:level=false:asc=true:latency=true"],
    });
    expect(a.slice(0, 4)).toEqual(["-hide_banner", "-loglevel", "info", "-i"]);
    expect(a).toContain("-af");
    expect(a.slice(-7)).toEqual(["-c:a", "aac", "-b:a", "256k", "-f", "adts", "-"]);
    expect(a).not.toContain("pipe:1");
  });
});
