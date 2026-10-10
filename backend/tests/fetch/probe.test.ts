import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveFfmpeg } from "../../src/services/transcode.js";
import {
  FetchProbeError,
  clearProbeCache,
  normalizeContainer,
  probeFile,
  probeLocalFile,
  toCandidateQuality,
} from "../../src/services/fetch/probe.js";

// 样本现场生成（ffmpeg sine）：不依赖仓库里任何既有音频文件。
const DIR = mkdtempSync(join(tmpdir(), "mf-probe-"));
const MP3 = join(DIR, "tone.mp3");
const FLAC = join(DIR, "tone.flac");
// 扩展名必须是 .bin:music-metadata 会按扩展名挑解析器,给随机字节套 .mp3 会走
// MPEG 解析器并"成功"解析出垃圾结果(伪同步字),拿它当"解析失败"样本会假绿。
const JUNK = join(DIR, "junk.bin");
const TIMEOUT = { timeout: 60_000 };

function ff(args: string[]): void {
  execFileSync(resolveFfmpeg(), args, { stdio: ["ignore", "ignore", "pipe"] });
}

beforeAll(() => {
  ff(["-y", "-f", "lavfi", "-i", "sine=frequency=440:duration=3", "-c:a", "libmp3lame", "-b:a", "320k", MP3]);
  ff(["-y", "-f", "lavfi", "-i", "sine=frequency=440:duration=3", "-c:a", "flac", FLAC]);
  // 真·不可解析:随机二进制(纯文本会被 music-metadata 当成有 tag 的文件解析成功,
  // 拿它当"解析失败"样本会假绿 —— 已踩过一次)。
  writeFileSync(JUNK, randomBytes(4096));
}, TIMEOUT.timeout);

afterAll(() => {
  clearProbeCache();
  rmSync(DIR, { recursive: true, force: true });
});

describe("probeFile", () => {
  it("mp3:容器/编码/时长/码率/采样率/声道正确,位深为空(有损)", async () => {
    const m = await probeFile(MP3);
    expect(m.container).toBe("mp3");
    expect(m.codec).toMatch(/MPEG/i);
    expect(m.durationSec).toBeGreaterThan(2.9);
    expect(m.durationSec).toBeLessThan(3.2);
    expect(m.bitrateKbps).toBeGreaterThanOrEqual(300);
    expect(m.bitrateKbps).toBeLessThanOrEqual(340);
    expect(m.sampleRateHz).toBe(44100);
    // 有损格式拿不到位深 —— 这是「假无损」判定的前提，不能随手填 16。
    expect(m.bitDepth).toBeUndefined();
    // ffmpeg lavfi sine 默认单声道
    expect(m.channels).toBe(1);
    expect(m.hasCover).toBe(false);
    expect(m.bytes).toBeGreaterThan(0);
  }, TIMEOUT.timeout);

  it("flac:有位深(16)且判定为无损容器", async () => {
    const m = await probeFile(FLAC);
    expect(m.container).toBe("flac");
    expect(m.bitDepth).toBe(16);
    expect(m.sampleRateHz).toBe(44100);
    expect(m.lossless).toBe(true);
    expect(m.hasCover).toBe(false);
  }, TIMEOUT.timeout);

  it("文件不存在 → 抛 FetchProbeError(FETCH_FAILED)", async () => {
    await expect(probeFile(join(DIR, "nope.mp3"))).rejects.toBeInstanceOf(FetchProbeError);
    await expect(probeFile(join(DIR, "nope.mp3"))).rejects.toMatchObject({ code: "FETCH_FAILED" });
  });

  it("无法解析的垃圾文件 → 抛 FetchProbeError(INTEGRITY_FAILED)", async () => {
    expect(existsSync(JUNK)).toBe(true);
    await expect(probeFile(JUNK)).rejects.toMatchObject({ code: "INTEGRITY_FAILED" });
  }, TIMEOUT.timeout);

  it("缓存:同文件二次命中同一对象;clearProbeCache 后重新解析", async () => {
    clearProbeCache();
    const a = await probeFile(MP3);
    const b = await probeFile(MP3);
    expect(b).toBe(a); // 命中缓存(size+mtime 未变)
    clearProbeCache();
    const c = await probeFile(MP3);
    expect(c).not.toBe(a);
    expect(c.container).toBe(a.container);
  }, TIMEOUT.timeout);

  it("requireAudio:false 时不因无音频流抛错(交给调用方判)", async () => {
    // 垃圾文件在 requireAudio:false 下仍会因解析失败抛错 —— 这里锁的是
    // 「解析失败」与「无音频流」两条路径互不混淆:解析失败恒 INTEGRITY_FAILED。
    await expect(probeFile(JUNK, { requireAudio: false })).rejects.toMatchObject({
      code: "INTEGRITY_FAILED",
    });
  }, TIMEOUT.timeout);
});

describe("toCandidateQuality / probeLocalFile", () => {
  it("探针结果可转成 CandidateQuality(供 quality 打分)", async () => {
    const m = await probeFile(FLAC);
    const q = toCandidateQuality(m, 1234);
    expect(q.container).toBe("flac");
    expect(q.bitDepth).toBe(16);
    expect(q.sampleRateHz).toBe(44100);
    expect(q.bytes).toBe(1234); // 显式传入优先
    expect(q.encoder).toBe(m.encoder);
  }, TIMEOUT.timeout);

  it("probeLocalFile 直接给 CandidateQuality(设计稿 §3.2 形态)", async () => {
    const q = await probeLocalFile(MP3);
    expect(q.container).toBe("mp3");
    expect(q.durationSec).toBeGreaterThan(2.9);
    expect(q.bytes).toBeGreaterThan(0);
  }, TIMEOUT.timeout);
});

describe("normalizeContainer", () => {
  it("扩展名优先,并把 music-metadata 的 MPEG/MP4 归一成 mp3/m4a", () => {
    expect(normalizeContainer("/x/a.mp3", "MPEG", "MPEG 1 Layer 3")).toBe("mp3");
    expect(normalizeContainer("/x/a.flac", "FLAC", "FLAC")).toBe("flac");
    expect(normalizeContainer("/x/a.m4a", "MP4", "alac")).toBe("m4a");
    expect(normalizeContainer("/x/a.ogg", "Ogg", "Vorbis")).toBe("ogg");
    // 无扩展名时回落 container / codec 推断
    expect(normalizeContainer("/x/noext", "MPEG", "")).toBe("mp3");
    expect(normalizeContainer("/x/noext", "", "FLAC")).toBe("flac");
  });
});
