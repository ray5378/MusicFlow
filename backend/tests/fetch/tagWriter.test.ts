import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseFile } from "music-metadata";
import { resolveFfmpeg } from "../../src/services/transcode.js";
import { probeFile } from "../../src/services/fetch/probe.js";
import { FetchTagError, buildTagArgs, writeTags, writeTagsTo } from "../../src/services/fetch/tagWriter.js";

const DIR = mkdtempSync(join(tmpdir(), "mf-tag-"));
const FF = resolveFfmpeg();
const TMO = { timeout: 60_000 };

function ff(args: string[]): void {
  execFileSync(FF, args, { stdio: ["ignore", "ignore", "pipe"] });
}

let MP3 = "";
let FLAC = "";
let WAV = "";
let COVER: Buffer;

beforeAll(() => {
  MP3 = join(DIR, "a.mp3");
  FLAC = join(DIR, "a.flac");
  WAV = join(DIR, "a.wav");
  ff(["-y", "-f", "lavfi", "-i", "sine=frequency=440:duration=2", "-c:a", "libmp3lame", "-b:a", "320k", MP3]);
  ff(["-y", "-f", "lavfi", "-i", "sine=frequency=440:duration=2", "-c:a", "flac", FLAC]);
  ff(["-y", "-f", "lavfi", "-i", "sine=frequency=440:duration=2", "-c:a", "pcm_s16le", WAV]);
  const coverPath = join(DIR, "cover.jpg");
  ff(["-y", "-f", "lavfi", "-i", "color=c=blue:s=64x64:d=1", "-frames:v", "1", coverPath]);
  COVER = Buffer.from(execFileSync("cat", [coverPath]) as unknown as Buffer);
}, TMO.timeout);

afterAll(() => rmSync(DIR, { recursive: true, force: true }));

describe("writeTags — mp3", () => {
  it("写入后可被 music-metadata 读回(含中文/轨号/年份),碟号须为空", async () => {
    const r = await writeTags(MP3, {
      title: "中文标题",
      artist: "歌手A",
      album: "专辑B",
      albumArtist: "AA",
      track: 3,
      trackTotal: 12,
      year: 2024,
      genre: "Pop",
      comment: "备注C",
    });
    expect(r.ok).toBe(true);
    const m = await parseFile(MP3, { duration: true });
    expect(m.common.title).toBe("中文标题");
    expect(m.common.artist).toBe("歌手A");
    expect(m.common.album).toBe("专辑B");
    expect(m.common.albumartist).toBe("AA");
    expect(m.common.track.no).toBe(3);
    expect(m.common.track.of).toBe(12);
    // 碟号纪律(2026-10-17)：成品不写也不留 DISCNUMBER/DISCTOTAL，故这里必须为空
    expect(m.common.disk?.no ?? null).toBeNull();
    expect(m.common.disk?.of ?? null).toBeNull();
    expect(m.common.year).toBe(2024);
    expect(m.common.genre).toContain("Pop");
  }, TMO.timeout);

  it("mp3 参数必须带 -id3v2_version 3(否则车机/DLNA 读不出)", () => {
    const args = buildTagArgs({ src: "in.mp3", out: "out.mp3", container: "mp3", tags: { title: "x" } });
    expect(args).toContain("-id3v2_version");
    expect(args[args.indexOf("-id3v2_version") + 1]).toBe("3");
    const flacArgs = buildTagArgs({ src: "in.flac", out: "out.flac", container: "flac", tags: { title: "x" } });
    expect(flacArgs).not.toContain("-id3v2_version");
    // 碟号纪律：无论 mp3/flac 都必须显式清空 disc(空值)，永不写具体碟号
    expect(args).toContain("disc=");
    expect(flacArgs).toContain("disc=");
  });

  it("封面映射:有新区封面只取新图,无新封面时由 keepSourceCover 决定是否保留源图", () => {
    const withCover = buildTagArgs({ src: "in.flac", out: "o.flac", container: "flac", tags: {}, coverPath: "/tmp/c.jpg" });
    expect(withCover).toContain("1:v");
    expect(withCover).not.toContain("0:v?");
    const keep = buildTagArgs({ src: "in.flac", out: "o.flac", container: "flac", tags: {}, keepSourceCover: true });
    expect(keep).toContain("0:v?");
    expect(keep).not.toContain("1:v");
    const drop = buildTagArgs({ src: "in.flac", out: "o.flac", container: "flac", tags: {} });
    expect(drop).not.toContain("0:v?");
    expect(drop).not.toContain("1:v");
  });

  it("源文件自带封面 → keepSourceCover 保留,否则丢弃(2026-10-17 实测缺陷回归)", async () => {
    const f = join(DIR, "keepcover.flac");
    const cov = join(DIR, "keep.jpg");
    ff(["-y", "-f", "lavfi", "-i", "color=c=green:s=64x64:d=1", "-frames:v", "1", cov]);
    // 造「有封面但缺 genre」的成品：纯音频 + 附加图
    ff([
      "-y", "-f", "lavfi", "-i", "sine=frequency=440:duration=1",
      "-i", cov, "-map", "0:a", "-map", "1:v", "-c:a", "flac", "-c:v", "mjpeg",
      "-disposition:v:0", "attached_pic", "-metadata", "title=A", f,
    ]);
    expect((((await parseFile(f)).common.picture) || []).length).toBe(1);
    // 修复路径语义：补缺失标签时必须保住已有封面
    await writeTags(f, { genre: "Pop", track: 3 }, { keepSourceCover: true });
    const after = await parseFile(f);
    expect((after.common.picture || []).length).toBe(1);
    expect(after.common.genre).toContain("Pop");
    expect(after.common.track.no).toBe(3);
    // 反向：不保留时封面被丢弃(与 embedCover=false 语义一致)
    await writeTags(f, { comment: "x" });
    expect((((await parseFile(f)).common.picture) || []).length).toBe(0);
  }, TMO.timeout);

  it("封面写入后探针 hasCover === true", async () => {
    const f = join(DIR, "cov.mp3");
    copyFileSync(MP3, f);
    const before = await probeFile(f);
    expect(before.hasCover).toBe(false);
    const r = await writeTags(f, { title: "带封面", cover: COVER });
    expect(r.ok).toBe(true);
    const after = await probeFile(f);
    expect(after.hasCover).toBe(true);
  }, TMO.timeout);
});

describe("writeTags — flac", () => {
  it("写入后可读回,且歌词可回读(mp3 不可 → warnings)", async () => {
    const r = await writeTags(FLAC, {
      title: "中文标题",
      artist: "歌手A",
      album: "专辑B",
      albumArtist: "AA",
      track: 5,
      year: 2021,
      genre: "Rock",
      lyric: "歌词第一行",
    });
    expect(r.ok).toBe(true);
    const m = await parseFile(FLAC, { duration: true });
    expect(m.common.title).toBe("中文标题");
    expect(m.common.albumartist).toBe("AA");
    expect(m.common.track.no).toBe(5);
    expect(m.common.year).toBe(2021);
    expect(m.common.lyrics?.[0]?.text).toContain("歌词第一行");
    // flac 不应有 mp3 的歌词告警
    expect(r.warnings.join("|")).not.toContain("MP3");
  }, TMO.timeout);

  it("mp3 写歌词进 warnings(实测回读不到,不作为成功依据)", async () => {
    const f = join(DIR, "lyric.mp3");
    copyFileSync(MP3, f);
    const r = await writeTags(f, { title: "x", lyric: "第一行" });
    expect(r.warnings.join("|")).toContain("歌词");
  }, TMO.timeout);

  it("源文件自带碟号 → 写入后被清空(DISCNUMBER/DISCTOTAL 不残留)", async () => {
    const f = join(DIR, "purge-disc.flac");
    ff([
      "-y", "-f", "lavfi", "-i", "sine=frequency=440:duration=1",
      "-metadata", "disc=1/2", "-metadata", "title=A", "-c:a", "flac", f,
    ]);
    expect((await parseFile(f)).common.disk?.no).toBe(1);
    await writeTags(f, { title: "B" });
    const after = await parseFile(f);
    expect(after.common.disk?.no ?? null).toBeNull();
    expect(after.common.disk?.of ?? null).toBeNull();
  }, TMO.timeout);
});

describe("writeTags — 失败与跳过路径", () => {
  it("ffmpeg 失败:抛 TAG_FAILED,且原文件字节与 mtime 不变", async () => {
    const bad = join(DIR, "bad.mp3");
    writeFileSync(bad, "definitely not audio".repeat(30));
    const before = statSync(bad);
    await expect(writeTags(bad, { title: "x" })).rejects.toBeInstanceOf(FetchTagError);
    await expect(writeTags(bad, { title: "x" })).rejects.toMatchObject({ code: "TAG_FAILED" });
    const after = statSync(bad);
    expect(after.size).toBe(before.size);
    expect(after.mtimeMs).toBe(before.mtimeMs);
    // 临时文件必须被清理
    expect(existsSync(`${bad}.tagtmp`)).toBe(false);
  }, TMO.timeout);

  it("不支持内嵌标签的容器(wav):跳过但 ok,warnings 有说明", async () => {
    const f = join(DIR, "skip.wav");
    copyFileSync(WAV, f);
    const before = statSync(f);
    const r = await writeTags(f, { title: "x" });
    expect(r.ok).toBe(true);
    expect(r.warnings.join("|")).toContain("不支持内嵌标签");
    expect(statSync(f).size).toBe(before.size);
  }, TMO.timeout);

  it("writeTagsTo 另存到 dstFile,不动源文件", async () => {
    const src = join(DIR, "src.flac");
    const dst = join(DIR, "dst.flac");
    copyFileSync(FLAC, src);
    const before = statSync(src);
    const r = await writeTagsTo(src, dst, { title: "另存标题", artist: "歌手Z" });
    expect(r.file).toBe(dst);
    expect(statSync(src).size).toBe(before.size);
    expect(statSync(src).mtimeMs).toBe(before.mtimeMs);
    const m = await parseFile(dst, { duration: true });
    expect(m.common.title).toBe("另存标题");
    expect(m.common.artist).toBe("歌手Z");
  }, TMO.timeout);
});
