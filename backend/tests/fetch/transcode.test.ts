import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseFile } from "music-metadata";
import { resolveFfmpeg } from "../../src/services/transcode.js";
import { probeFile } from "../../src/services/fetch/probe.js";
import { buildTranscodeArgs, transcodeFile } from "../../src/services/fetch/transcode.js";
import { writeTags } from "../../src/services/fetch/tagWriter.js";

const DIR = mkdtempSync(join(tmpdir(), "mf-transcode-"));
const TMO = { timeout: 120_000 };
let MP3 = "";
let FLAC = "";

function ff(args: string[]): void {
  execFileSync(resolveFfmpeg(), args, { stdio: ["ignore", "ignore", "pipe"] });
}

beforeAll(() => {
  MP3 = join(DIR, "src.mp3");
  FLAC = join(DIR, "src.flac");
  ff(["-y", "-f", "lavfi", "-i", "sine=frequency=440:duration=3", "-c:a", "libmp3lame", "-b:a", "320k", MP3]);
  ff(["-y", "-f", "lavfi", "-i", "sine=frequency=440:duration=3", "-c:a", "flac", FLAC]);
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
