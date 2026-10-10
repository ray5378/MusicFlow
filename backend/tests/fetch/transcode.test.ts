import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { copyFileSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseFile } from "music-metadata";
import { resolveFfmpeg } from "../../src/services/transcode.js";
import { parseLoudnorm } from "../../src/services/audio/loudness.js";
import { probeFile } from "../../src/services/fetch/probe.js";
import { buildLoudnessFilter, buildTranscodeArgs, resolveOutDepth, transcodeFile } from "../../src/services/fetch/transcode.js";
import { writeTags } from "../../src/services/fetch/tagWriter.js";

const DIR = mkdtempSync(join(tmpdir(), "mf-transcode-"));
const TMO = { timeout: 120_000 };
let MP3 = "";
let FLAC = "";
let LOW = "";

function ff(args: string[]): void {
  execFileSync(resolveFfmpeg(), args, { stdio: ["ignore", "ignore", "pipe"] });
}

/** 空跑 loudnorm 只测响度（复用 loudness.ts 的 parseLoudnorm 读回 input_i）。 */
function measureLufs(file: string): number | null {
  const res = spawnSync(
    resolveFfmpeg(),
    ["-hide_banner", "-i", file, "-af", "loudnorm=I=-14:TP=-2:LRA=10:print_format=json", "-f", "null", "-"],
    { encoding: "utf8", maxBuffer: 8 * 1024 * 1024 },
  );
  const m = parseLoudnorm(res.stderr || "");
  return m ? m.inputI : null;
}

beforeAll(() => {
  MP3 = join(DIR, "src.mp3");
  FLAC = join(DIR, "src.flac");
  LOW = join(DIR, "low.flac");
  ff(["-y", "-f", "lavfi", "-i", "sine=frequency=440:duration=3", "-c:a", "libmp3lame", "-b:a", "320k", MP3]);
  ff(["-y", "-f", "lavfi", "-i", "sine=frequency=440:duration=3", "-c:a", "flac", FLAC]);
  // 明显偏小(-20dB)的源，用来验证归一化确实把电平拉到 -14 LUFS。
  ff(["-y", "-f", "lavfi", "-i", "sine=frequency=1000:duration=6", "-af", "volume=-20dB", "-c:a", "flac", LOW]);
}, TMO.timeout);

afterAll(() => rmSync(DIR, { recursive: true, force: true }));

describe("transcodeFile", () => {
  it("mp3 → flac:位深必须 16(防 3.5 倍虚假升位回归守卫)", async () => {
    const out = join(DIR, "out16.flac");
    const r = await transcodeFile(MP3, { target: "flac", dstPath: out });
    expect(r.ok).toBe(true);
    expect(r.skipped).toBe(false);
    const p = await probeFile(out);
    expect(p.container).toBe("flac");
    expect(p.bitDepth).toBe(16); // 🔴 硬断言:不加 -sample_fmt s16 这里会是 24
    expect(p.sampleRateHz).toBe(44100);
    // 体积守卫:24bit 样本实测 163950B,16bit 46255B → 超过 70KB 说明又升位了
    expect(statSync(out).size).toBeLessThan(70_000);
  }, TMO.timeout);

  it("源已是 flac 且不改采样率 → skipped:true,不跑 ffmpeg", async () => {
    const f = join(DIR, "already.flac");
    copyFileSync(FLAC, f);
    const before = statSync(f);
    const r = await transcodeFile(f, { target: "flac" });
    expect(r.skipped).toBe(true);
    expect(r.dstPath).toBe(f);
    expect(statSync(f).size).toBe(before.size);
  }, TMO.timeout);

  it("sampleRateHz 生效:目标 22050Hz", async () => {
    const out = join(DIR, "sr.flac");
    const r = await transcodeFile(MP3, { target: "flac", dstPath: out, sampleRateHz: 22050 });
    expect(r.ok).toBe(true);
    const p = await probeFile(out);
    expect(p.sampleRateHz).toBe(22050);
    expect(p.bitDepth).toBe(16);
  }, TMO.timeout);

  it("keepTags:标签与内嵌封面都保留", async () => {
    const src = join(DIR, "tagged.mp3");
    copyFileSync(MP3, src);
    const cover = join(DIR, "c.jpg");
    ff(["-y", "-f", "lavfi", "-i", "color=c=red:s=64x64:d=1", "-frames:v", "1", cover]);
    await writeTags(src, { title: "保留我", artist: "歌手K", album: "专辑L", cover });
    const tagged = await probeFile(src);
    expect(tagged.hasCover).toBe(true);

    const out = join(DIR, "keep.flac");
    const r = await transcodeFile(src, { target: "flac", dstPath: out, keepTags: true });
    expect(r.ok).toBe(true);
    const m = await parseFile(out, { duration: true });
    expect(m.common.title).toBe("保留我");
    expect(m.common.artist).toBe("歌手K");
    const p = await probeFile(out);
    expect(p.hasCover).toBe(true);
    expect(p.bitDepth).toBe(16);
  }, TMO.timeout);

  it("keepTags:false → 不保留标签(-map_metadata -1)", async () => {
    const src = join(DIR, "tagged2.mp3");
    copyFileSync(MP3, src);
    await writeTags(src, { title: "别保留我" });
    const out = join(DIR, "drop.flac");
    await transcodeFile(src, { target: "flac", dstPath: out, keepTags: false });
    const m = await parseFile(out, { duration: true });
    expect(m.common.title).toBeUndefined();
  }, TMO.timeout);

  it("wav 目标:16bit PCM", async () => {
    const out = join(DIR, "out.wav");
    const r = await transcodeFile(MP3, { target: "wav", dstPath: out });
    expect(r.ok).toBe(true);
    const p = await probeFile(out);
    expect(p.container).toBe("wav");
    expect(p.bitDepth).toBe(16);
  }, TMO.timeout);

  it("loudnessNormalize:两遍后成品响度 ≈ -14 LUFS(±1)，采样率/位深跟随源(24bit 源→24bit 成品)", async () => {
    const out = join(DIR, "loud.flac");
    const r = await transcodeFile(LOW, { target: "flac", dstPath: out, loudnessNormalize: true });
    expect(r.ok).toBe(true);
    expect(r.skipped).toBe(false);
    // 两遍法成功 → 无「降级为单遍」告警。
    expect(r.warnings).toEqual([]);
    // 源是 -20dB 的静音轨：归一化必须真的把电平提上来。
    const lufs = measureLufs(out);
    expect(lufs).not.toBeNull();
    expect(Math.abs((lufs as number) - (-14))).toBeLessThanOrEqual(1.0);
    // loudnorm 会把流上采样到 192k + 浮点：aresample 必须把二者复位。
    const srcP = await probeFile(LOW);
    const outP = await probeFile(out);
    expect(outP.container).toBe("flac");
    expect(outP.sampleRateHz).toBe(srcP.sampleRateHz);
    // 位深跟随源（产品定调 2026-10-10）：夹具 sine→flac 落 24bit 源，成品也必须 24bit。
    expect(srcP.bitDepth).toBe(24);
    expect(outP.bitDepth).toBe(24);
  }, TMO.timeout);

  it("loudnessNormalize:true 且源已是 flac → 绝不 skip(必须真跑一遍归一化)", async () => {
    const f = join(DIR, "noskip.flac");
    copyFileSync(FLAC, f);
    const r = await transcodeFile(f, { target: "flac", loudnessNormalize: true, loudnessTwoPass: false });
    expect(r.skipped).toBe(false);
    expect(r.dstPath).toBe(f);
  }, TMO.timeout);
});

describe("buildLoudnessFilter", () => {
  it("loudnorm 必在 aresample 之前，含 osr 与 osf=s16 + 三角抖动", () => {
    const f = buildLoudnessFilter({ targetLufs: -14, targetSampleRateHz: 44100, osf: "s16" });
    const li = f.indexOf("loudnorm=");
    const ai = f.indexOf("aresample=");
    expect(li).toBeGreaterThanOrEqual(0);
    expect(ai).toBeGreaterThan(li);
    expect(f).toContain("I=-14");
    expect(f).toContain("TP=-2");
    expect(f).toContain("LRA=10");
    expect(f).toContain("osr=44100");
    expect(f).toContain("osf=s16");
    expect(f).toContain("dither_method=triangular_hp");
  });

  it("wav 不写 osf；24bit 写 osf=s32；越界目标响度被夹到 [-30,-5]", () => {
    const wav = buildLoudnessFilter({ targetLufs: -14, targetSampleRateHz: 48000 });
    expect(wav).toContain("osr=48000");
    expect(wav).not.toContain("osf=");
    const s32 = buildLoudnessFilter({ targetLufs: -14, targetSampleRateHz: 44100, osf: "s32" });
    expect(s32).toContain("osf=s32");
    expect(s32).not.toContain("dither_method");
    expect(buildLoudnessFilter({ targetLufs: -99, targetSampleRateHz: 44100 })).toContain("I=-30");
  });

  it("给了实测值 → linear=true 且带 measured_* 五值", () => {
    const f = buildLoudnessFilter({
      targetLufs: -14,
      targetSampleRateHz: 44100,
      osf: "s16",
      measured: { i: -24.3, lra: 5.1, tp: -6.2, thresh: -35.0, offset: 0.4 },
    });
    expect(f).toContain("linear=true");
    expect(f).toContain("measured_I=-24.3");
    expect(f).toContain("measured_LRA=5.1");
    expect(f).toContain("measured_TP=-6.2");
    expect(f).toContain("measured_thresh=-35");
    expect(f).toContain("offset=0.4");
  });

  it("-af 透传进转码命令，且排在输出文件之前", () => {
    const a = buildTranscodeArgs({ src: "i.mp3", out: "o.flac", target: "flac", af: "loudnorm=I=-14" });
    const idx = a.indexOf("-af");
    expect(idx).toBeGreaterThanOrEqual(0);
    expect(a[idx + 1]).toBe("loudnorm=I=-14");
    expect(a.indexOf("o.flac")).toBeGreaterThan(idx);
  });
});

describe("buildTranscodeArgs", () => {
  it("flac 默认带 -sample_fmt s16;关闭后不带", () => {
    const a = buildTranscodeArgs({ src: "i.mp3", out: "o.flac", target: "flac" });
    expect(a).toContain("-sample_fmt");
    expect(a[a.indexOf("-sample_fmt") + 1]).toBe("s16");
    const b = buildTranscodeArgs({ src: "i.mp3", out: "o.flac", target: "flac", keepBitDepth16: false });
    expect(b).not.toContain("-sample_fmt");
  });

  it("有封面 + keepTags 才带封面流映射,否则 -vn", () => {
    const a = buildTranscodeArgs({ src: "i.mp3", out: "o.flac", target: "flac", keepTags: true, hasCover: true });
    expect(a).toContain("attached_pic");
    const b = buildTranscodeArgs({ src: "i.mp3", out: "o.flac", target: "flac", keepTags: true, hasCover: false });
    expect(b).toContain("-vn");
    expect(b).not.toContain("attached_pic");
  });

  it("compression_level 在 0-12 内才下发", () => {
    const a = buildTranscodeArgs({ src: "i.mp3", out: "o.flac", target: "flac", compressionLevel: 8 });
    expect(a).toContain("-compression_level");
    const b = buildTranscodeArgs({ src: "i.mp3", out: "o.flac", target: "flac", compressionLevel: 99 });
    expect(b).not.toContain("-compression_level");
  });
});

// ==================== 位深/采样率自适应跟随源（产品定调 2026-10-10） ====================

describe("resolveOutDepth — 位深跟随源", () => {
  it("auto：16bit 源 → 16；24bit 源 → 24；拿不到（有损/探针失败）→ 16 防虚假升位", () => {
    expect(resolveOutDepth("auto", 16)).toBe(16);
    expect(resolveOutDepth("auto", 24)).toBe(24);
    expect(resolveOutDepth("auto", 32)).toBe(24); // 容器上限
    expect(resolveOutDepth("auto", undefined)).toBe(16); // mp3 等拿不到位深 → 16（回归守卫）
    expect(resolveOutDepth("auto", 0)).toBe(16);
  });

  it("显式 16/24 恒生效（源是什么都钳到档位）", () => {
    expect(resolveOutDepth(16, 24)).toBe(16);
    expect(resolveOutDepth(24, 16)).toBe(24);
  });

  it("buildTranscodeArgs：outDepth=24 的 flac 不写 -sample_fmt；outDepth=16 写 s16", () => {
    const d24 = buildTranscodeArgs({ src: "i", out: "o.flac", target: "flac", outDepth: 24 });
    expect(d24.join(" ")).not.toContain("-sample_fmt");
    const d16 = buildTranscodeArgs({ src: "i", out: "o.flac", target: "flac", outDepth: 16 });
    expect(d16.join(" ")).toContain("-sample_fmt s16");
  });

  it("buildTranscodeArgs：wav 位深跟随源 —— 24 → pcm_s24le、16 → pcm_s16le", () => {
    const w24 = buildTranscodeArgs({ src: "i", out: "o.wav", target: "wav", outDepth: 24 });
    expect(w24.join(" ")).toContain("-c:a pcm_s24le");
    const w16 = buildTranscodeArgs({ src: "i", out: "o.wav", target: "wav", outDepth: 16 });
    expect(w16.join(" ")).toContain("-c:a pcm_s16le");
  });

  it("buildTranscodeArgs：不传 outDepth 回退旧 keepBitDepth16 语义（缺省 16）", () => {
    const legacy = buildTranscodeArgs({ src: "i", out: "o.flac", target: "flac" });
    expect(legacy.join(" ")).toContain("-sample_fmt s16");
  });
});
