/**
 * source/scanner.ts —— 元数据抽取 / 入库 / 孤儿清理 / 本地源扫描。
 *
 * 夹具说明:`tests/fixtures/audio/` 下的 tagged.flac / tagged.mp3 是极小的真实
 * 编码文件(ffmpeg 生成,数 KB),用来覆盖 music-metadata 的**成功解析路径**:
 * Vorbis Comment 的多值标签 + 带/不带时间轴歌词、ID3v2.3 的 APIC 内嵌封面。
 * WAV 则在本文件里按 RIFF 手搓(只有 PCM 头,零标签),覆盖「解析成功但无标签」。
 */
import { describe, it, expect, beforeEach } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { fileURLToPath } from "url";

import {
  extractMetadataHeader,
  upsertSong,
  cleanupOrphans,
  resolveLocalGroup,
  scanLocalSource,
} from "../../src/services/source/scanner.js";
import { sqlite } from "../../src/db/index.js";

const FIXTURES = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../fixtures/audio");

const FLAC_LYRICS_TAG = "[00:01.00]line one\n[00:02.00]line two";
const FLAC_UNSYNCED = "plain lyric body";

function fixture(name: string): Buffer {
  return fs.readFileSync(path.join(FIXTURES, name));
}

/** 手搓最小 WAV:44 字节 RIFF 头 + 静音 data 块(解析必成功、但一个标签都没有)。 */
function buildWav(seconds: number, sampleRate = 8000, channels = 1, bits = 8): Buffer {
  const byteRate = (sampleRate * channels * bits) / 8;
  const blockAlign = (channels * bits) / 8;
  const dataLen = Math.round(byteRate * seconds);
  const buf = Buffer.alloc(44 + dataLen);
  buf.write("RIFF", 0, "ascii");
  buf.writeUInt32LE(36 + dataLen, 4);
  buf.write("WAVE", 8, "ascii");
  buf.write("fmt ", 12, "ascii");
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(channels, 22);
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(byteRate, 28);
  buf.writeUInt16LE(blockAlign, 32);
  buf.writeUInt16LE(bits, 34);
  buf.write("data", 36, "ascii");
  buf.writeUInt32LE(dataLen, 40);
  return buf;
}

function makeMeta(over: Record<string, unknown> = {}) {
  return {
    title: "T", artist: "A", album: "AL", duration: 100, bitRate: 320,
    genre: "Rock", year: 2020, track: 1, discNumber: 1,
    contentType: "audio/mpeg", suffix: "mp3", size: 1000,
    albumArtist: "", composer: "", comment: "",
    ...over,
  } as any;
}

let tmpRoot = "";

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "mf-scan-"));
});

describe("extractMetadataHeader / FLAC(Vorbis Comment)", () => {
  it("字段全量映射:标题/歌手/专辑/流派/年份/轨道/碟号/多值标签", async () => {
    const buf = fixture("tagged.flac");
    const meta = await extractMetadataHeader(buf, "tagged.flac", buf.length);

    expect(meta.title).toBe("Flac Title");
    expect(meta.artist).toBe("Flac Artist");
    expect(meta.album).toBe("Flac Album");
    expect(meta.genre).toBe("Jazz");
    expect(meta.year).toBe(2021);
    expect(meta.track).toBe(3);
    expect(meta.discNumber).toBe(1);
    expect(meta.suffix).toBe("flac");
    expect(meta.contentType).toBe("audio/flac");
    expect(meta.size).toBe(buf.length);
    expect(meta.bitRate).toBe(1); // 1120 bps -> kbps
    // 多值标签折叠成单串
    expect(meta.albumArtist).toBe("Album Artist");
    expect(meta.composer).toBe("Comp One; Comp Two");
    // ffmpeg 把 comment 写成 DESCRIPTION,Vorbis 侧没有 COMMENT -> 空串而非 undefined
    expect(meta.comment).toBe("");
    // 解析成功不算不完整(WebDAV 据此决定不升档重取)
    expect(meta.incomplete).toBeUndefined();
  });

  it("歌词:多条来源去重后,带时间轴的优先", async () => {
    const buf = fixture("tagged.flac");
    const meta = await extractMetadataHeader(buf, "tagged.flac", buf.length);
    // common.lyrics 是纯文本、native LYRICS 带 [mm:ss]、UNSYNCEDLYRICS 纯文本
    expect(meta.lyrics).toBe(FLAC_LYRICS_TAG);
    expect(meta.lyrics).not.toContain(FLAC_UNSYNCED);
  });

  it("tags JSON:规范化标签 + native 原始字段,歌词只留长度不重复存正文", async () => {
    const buf = fixture("tagged.flac");
    const meta = await extractMetadataHeader(buf, "tagged.flac", buf.length);
    const tags = JSON.parse(meta.tags!);

    expect(tags.title).toBe("Flac Title");
    expect(tags.year).toBe(2021);
    // common.lyrics -> 只留长度(正文已进 songs.has_lyrics 语义,不双份存储)
    expect(tags.lyrics[0].textLength).toBe("line one\nline two".length);
    expect(tags.lyrics[0].text).toBeUndefined();
    // native:vorbis 的字段名直接作为 key
    expect(tags.native.TITLE).toBe("Flac Title");
    expect(tags.native.LYRICS).toBe(`[lyrics ${FLAC_LYRICS_TAG.length}]`);
    expect(tags.native.UNSYNCEDLYRICS).toBe(`[lyrics ${FLAC_UNSYNCED.length}]`);
    expect(tags.native.ENCODER).toBeTruthy();
  });

  it("无内嵌封面时不返回 picture", async () => {
    const buf = fixture("tagged.flac");
    const meta = await extractMetadataHeader(buf, "tagged.flac", buf.length);
    expect(meta.picture).toBeUndefined();
  });
});

describe("extractMetadataHeader / MP3(ID3v2.3)", () => {
  it("内嵌封面被抽出(APIC),二进制标签在 tags 里只留占位", async () => {
    const buf = fixture("tagged.mp3");
    const meta = await extractMetadataHeader(buf, "tagged.mp3", buf.length);

    expect(meta.title).toBe("Mp3 Title");
    expect(meta.artist).toBe("Mp3 Artist");
    expect(meta.album).toBe("Mp3 Album");
    expect(meta.picture).toBeDefined();
    expect(meta.picture!.format).toBe("image/jpeg");
    expect(meta.picture!.data.length).toBeGreaterThan(0);
    // music-metadata v11 给的是 Uint8Array(不是 Node Buffer);saveCoverArt 直接 writeFileSync 二者都收
    expect(meta.picture!.data instanceof Uint8Array).toBe(true);

    const tags = JSON.parse(meta.tags!);
    expect(tags.picture[0]).toMatchObject({ format: "image/jpeg" });
    expect(tags.picture[0].data).toBeUndefined();
    // ID3 的原始标签 key 带格式前缀,二进制正文只留长度占位
    expect(tags.native["ID3v2.3:APIC"]).toMatch(/^\[binary \d+\]$/);
    expect(tags.native["ID3v2.3:TIT2"]).toBe("Mp3 Title");
  });

  it("缺流派/年份/轨道/碟号时落到默认值,albumArtist 折叠成空串", async () => {
    const buf = fixture("tagged.mp3");
    const meta = await extractMetadataHeader(buf, "tagged.mp3", buf.length);
    expect(meta.genre).toBe("");
    expect(meta.year).toBe(0);
    expect(meta.track).toBe(0);
    expect(meta.discNumber).toBe(1);
    expect(meta.albumArtist).toBe("");
  });

  it("MP3 时长缺失时按 文件大小/码率 估算", async () => {
    const buf = fixture("tagged.mp3");
    const meta = await extractMetadataHeader(buf, "tagged.mp3", buf.length);
    expect(meta.bitRate).toBe(64);
    // duration = round(size*8 / (bitRate*1000))
    expect(meta.duration).toBe(Math.round((buf.length * 8) / (64 * 1000)));
  });
});

describe("extractMetadataHeader / WAV 与兜底", () => {
  it("WAV 解析成功但零标签:标题回落到文件名,duration/采样率来自格式头", async () => {
    const buf = buildWav(2);
    const meta = await extractMetadataHeader(buf, "song.wav", buf.length);

    expect(meta.title).toBe("song");
    expect(meta.artist).toBe("Unknown Artist");
    expect(meta.album).toBe("Unknown Album");
    expect(meta.duration).toBe(2);
    expect(meta.contentType).toBe("audio/wav");
    expect(meta.suffix).toBe("wav");
    // 解析成功 → 不标 incomplete,WebDAV 不会白升档
    expect(meta.incomplete).toBeUndefined();
  });

  it("'歌手 - 标题' 文件名在解析失败时被拆成 artist/title 并标记 incomplete", async () => {
    // 只有「结构异常」才会让 music-metadata 抛错:256KB 全 0 冒充 FLAC -> FieldDecodingError。
    const junk = Buffer.alloc(256 * 1024);
    const meta = await extractMetadataHeader(junk, "Cool Band - Nice Song.flac", 12345);

    expect(meta.incomplete).toBe(true);
    expect(meta.artist).toBe("Cool Band");
    expect(meta.title).toBe("Nice Song");
    expect(meta.album).toBe("Unknown Album");
    expect(meta.duration).toBe(0);
    expect(meta.bitRate).toBe(0);
    expect(meta.size).toBe(12345);
    expect(meta.suffix).toBe("flac");
    expect(meta.contentType).toBe("audio/flac");
    expect(meta.lyrics).toBeUndefined();
    expect(meta.tags).toBeUndefined();
  });

  it("文件名无分隔符时 title=整个基名、artist=Unknown Artist", async () => {
    const junk = Buffer.from([0x00, 0x01, 0x02]);
    const meta = await extractMetadataHeader(junk, "justaname.flac", 10);
    expect(meta.title).toBe("justaname");
    expect(meta.artist).toBe("Unknown Artist");
    expect(meta.contentType).toBe("audio/flac");
  });

  /**
   * ⚠️ 以下两条是**现状固化**(characterization),不是期望行为 —— 已登记为缺陷:
   * music-metadata 对「头部被截断 / 根本不是音频」的字节是**宽容**的:它 resolve 一个
   * 空的 common/format,而不是抛错。于是 extractMetadataHeader 里唯一的 incomplete
   * 判据(catch 分支)永不触发,WebDAV 的 256KB→1MB→4MB 分级取头也就永不升档。
   */
  it("[缺陷固化] 3 字节垃圾 + .mp3:不抛错 → 无 incomplete,标题退化成整个文件名", async () => {
    const junk = Buffer.from([0x00, 0x01, 0x02]);
    const meta = await extractMetadataHeader(junk, "Cool Band - Nice Song.mp3", 12345);

    // 期望(未实现):incomplete=true,artist="Cool Band",title="Nice Song"
    expect(meta.incomplete).toBeUndefined();
    expect(meta.title).toBe("Cool Band - Nice Song");
    expect(meta.artist).toBe("Unknown Artist");
    expect(meta.duration).toBe(0);
  });

  it("[缺陷固化] 未知扩展名回落 audio/mpeg,扩展名原样进 suffix", async () => {
    const junk = Buffer.from([0x00]);
    const meta = await extractMetadataHeader(junk, "weird.xyz", 1);
    expect(meta.contentType).toBe("audio/mpeg");
    expect(meta.suffix).toBe("xyz");
    expect(meta.incomplete).toBeUndefined();
    expect(meta.title).toBe("weird");
  });

  it("无扩展名时 suffix 为空串", async () => {
    const meta = await extractMetadataHeader(Buffer.from([0x00]), "noext", 1);
    expect(meta.suffix).toBe("");
    expect(meta.title).toBe("noext");
  });
});

describe("upsertSong", () => {
  it("首次入库:added,并同步 artist/album 的聚合计数", () => {
    const res = upsertSong("l:s1:/m/a.mp3", makeMeta({ title: "Song A", artist: "Artist A", album: "Album A" }), "s1");
    expect(res).toBe("added");

    const song = sqlite.prepare("SELECT * FROM songs WHERE path = ?").get("l:s1:/m/a.mp3") as any;
    expect(song.title).toBe("Song A");
    expect(song.has_lyrics).toBe(0);
    expect(song.artist_id).toBeTruthy();
    expect(song.album_id).toBeTruthy();

    const album = sqlite.prepare("SELECT * FROM albums WHERE id = ?").get(song.album_id) as any;
    expect(album.song_count).toBe(1);
    expect(album.duration).toBe(100);

    const artist = sqlite.prepare("SELECT * FROM artists WHERE id = ?").get(song.artist_id) as any;
    expect(artist.album_count).toBe(1);
  });

  it("带歌词的文件把 has_lyrics 置 1 并落库 tags", () => {
    upsertSong("l:s1:/m/lyric.flac", makeMeta({
      title: "WithLyrics", suffix: "flac", contentType: "audio/flac",
      lyrics: "line1\nline2", tags: '{"a":1}',
    }), "s1");
    const song = sqlite.prepare("SELECT has_lyrics, tags FROM songs WHERE path = ?").get("l:s1:/m/lyric.flac") as any;
    expect(song.has_lyrics).toBe(1);
    expect(JSON.parse(song.tags)).toEqual({ a: 1 });
  });

  it("同路径二次入库:updated,字段刷新且 fingerprint 落库", () => {
    upsertSong("l:s1:/m/b.mp3", makeMeta({ title: "Old", duration: 10 }), "s1");
    const res = upsertSong("l:s1:/m/b.mp3", makeMeta({ title: "New", duration: 20 }), "s1", "999|2021");
    expect(res).toBe("updated");

    const song = sqlite.prepare("SELECT title, duration, fingerprint FROM songs WHERE path = ?").get("l:s1:/m/b.mp3") as any;
    expect(song.title).toBe("New");
    expect(song.duration).toBe(20);
    expect(song.fingerprint).toBe("999|2021");
  });

  it("已有歌词标记不被'文件无歌词'降级(在线歌词可能已落盘)", () => {
    upsertSong("l:s1:/m/c.flac", makeMeta({ title: "C", lyrics: "x", suffix: "flac" }), "s1");
    sqlite.prepare("UPDATE songs SET has_lyrics = 1 WHERE path = ?").run("l:s1:/m/c.flac");
    upsertSong("l:s1:/m/c.flac", makeMeta({ title: "C2", suffix: "flac" }), "s1");
    const song = sqlite.prepare("SELECT has_lyrics, title FROM songs WHERE path = ?").get("l:s1:/m/c.flac") as any;
    expect(song.title).toBe("C2");
    expect(song.has_lyrics).toBe(1);
  });

  it("Unknown Artist / Unknown Album 不建 artist/album 行(NULL 关联)", () => {
    upsertSong("l:s1:/m/d.mp3", makeMeta({ title: "D", artist: "Unknown Artist", album: "Unknown Album" }), "s1");
    const song = sqlite.prepare("SELECT artist_id, album_id FROM songs WHERE path = ?").get("l:s1:/m/d.mp3") as any;
    expect(song.artist_id).toBeNull();
    expect(song.album_id).toBeNull();
  });

  it("同名专辑二次入库复用同一 album 行,并补写缺失的流派/封面", () => {
    upsertSong("l:s1:/m/e1.mp3", makeMeta({ title: "E1", artist: "AR", album: "Shared", genre: "" }), "s1");
    const before = sqlite.prepare("SELECT id, genre FROM albums WHERE name = 'Shared'").get() as any;
    upsertSong("l:s2:/m/e2.mp3", makeMeta({ title: "E2", artist: "AR", album: "Shared", genre: "Pop" }), "s2");
    const after = sqlite.prepare("SELECT id, genre FROM albums WHERE name = 'Shared'").get() as any;

    expect(after.id).toBe(before.id);
    expect(after.genre).toBe("Pop");
  });
});

describe("cleanupOrphans", () => {
  it("删除无歌曲的专辑与歌手,并清掉仍引用该歌手的歌曲外键", () => {
    // 造一个"孤儿歌手":先建歌手+专辑+歌,再删歌
    upsertSong("l:s9:/m/orphan.mp3", makeMeta({ title: "Orphan", artist: "Ghost Artist", album: "Ghost Album" }), "s9");
    const song = sqlite.prepare("SELECT artist_id, album_id FROM songs WHERE path = ?").get("l:s9:/m/orphan.mp3") as any;
    const ghostArtist = song.artist_id;
    const ghostAlbum = song.album_id;
    expect(ghostArtist).toBeTruthy();

    sqlite.prepare("DELETE FROM songs WHERE path = ?").run("l:s9:/m/orphan.mp3");
    cleanupOrphans();

    expect(sqlite.prepare("SELECT id FROM albums WHERE id = ?").get(ghostAlbum)).toBeUndefined();
    expect(sqlite.prepare("SELECT id FROM artists WHERE id = ?").get(ghostArtist)).toBeUndefined();
  });

  it("还有歌的专辑/歌手不会被误删,且清空引用后歌曲仍可查", () => {
    upsertSong("l:s9:/m/keep.mp3", makeMeta({ title: "Keep", artist: "Keep Artist", album: "Keep Album" }), "s9");
    cleanupOrphans();
    const song = sqlite.prepare("SELECT title FROM songs WHERE path = ?").get("l:s9:/m/keep.mp3") as any;
    expect(song.title).toBe("Keep");
    expect(sqlite.prepare("SELECT COUNT(*) c FROM albums WHERE name = 'Keep Album'").get() as any).toMatchObject({ c: 1 });
  });

  it("没有孤儿时是安全的空操作", () => {
    expect(() => cleanupOrphans()).not.toThrow();
  });
});

describe("resolveLocalGroup", () => {
  it("标题与歌手都为空 -> 不归组(null)", () => {
    expect(resolveLocalGroup(makeMeta({ title: "", artist: "" }))).toBeNull();
  });

  it("返回 groupId + groupKey", () => {
    const g = resolveLocalGroup(makeMeta({ title: "Grouped Song", artist: "GA", album: "GAL", duration: 200 }));
    expect(g).toBeTruthy();
    expect(g!.groupId).toBeTruthy();
    expect(typeof g!.groupKey).toBe("string");
  });

  it("命中已有组(同 key + 容忍度内时长)时并入现有 group_id", () => {
    const meta = makeMeta({ title: "Dup", artist: "DA", album: "DAL", duration: 180 });
    const key = resolveLocalGroup(meta)!.groupKey;
    upsertSong("l:g1:/m/dup1.mp3", makeMeta({ title: "Dup", artist: "DA", album: "DAL", duration: 180 }), "g1");
    sqlite.prepare("UPDATE songs SET group_id = ?, group_key = ? WHERE path = ?").run("GROUP-XYZ", key, "l:g1:/m/dup1.mp3");

    const g = resolveLocalGroup(meta)!;
    expect(g.groupKey).toBe(key);
    expect(g.groupId).toBe("GROUP-XYZ");
  });

  it("时长超出容忍度时另起新组", () => {
    const meta = makeMeta({ title: "Dup2", artist: "DB", album: "DAL2", duration: 180 });
    const key = resolveLocalGroup(meta)!.groupKey;
    upsertSong("l:g1:/m/dup2.mp3", makeMeta({ title: "Dup2", artist: "DB", album: "DAL2", duration: 180 }), "g1");
    sqlite.prepare("UPDATE songs SET group_id = ?, group_key = ? WHERE path = ?").run("GROUP-OLD", key, "l:g1:/m/dup2.mp3");

    const g = resolveLocalGroup(makeMeta({ title: "Dup2", artist: "DB", album: "DAL2", duration: 400 }))!;
    expect(g.groupKey).toBe(key);
    expect(g.groupId).not.toBe("GROUP-OLD");
  });
});

describe("scanLocalSource", () => {
  function writeFiles(): string {
    const dir = path.join(tmpRoot, "music");
    fs.mkdirSync(path.join(dir, "sub"), { recursive: true });
    fs.writeFileSync(path.join(dir, "one.wav"), buildWav(1));
    fs.writeFileSync(path.join(dir, "sub", "two.wav"), buildWav(1));
    fs.writeFileSync(path.join(dir, "notes.txt"), "ignore me");
    return dir;
  }

  it("目录不存在直接抛错", async () => {
    await expect(scanLocalSource("sX", { path: path.join(tmpRoot, "nope") }, "full")).rejects.toThrow(/不存在/);
  });

  it("full 扫描:递归收集音频、跳过非音频、上报进度", async () => {
    const dir = writeFiles();
    const phases: string[] = [];
    const res = await scanLocalSource("sL1", { path: dir }, "full", (p) => phases.push(p.phase));

    expect(res).toMatchObject({ added: 2, updated: 0, removed: 0, skipped: 0 });
    expect(phases[0]).toBe("scanning");
    expect(phases[phases.length - 1]).toBe("done");

    const rows = sqlite.prepare("SELECT path, title FROM songs WHERE path LIKE 'l:sL1:%'").all() as any[];
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.title === "one" || r.title === "two")).toBe(true);
    expect(rows.some((r) => r.path.endsWith("notes.txt"))).toBe(false);
  });

  it("二次 full 扫描:全部走 updated(fingerprint 落库)", async () => {
    const dir = writeFiles();
    await scanLocalSource("sL2", { path: dir }, "full");
    const res = await scanLocalSource("sL2", { path: dir }, "full");
    expect(res).toMatchObject({ added: 0, updated: 2, removed: 0, skipped: 0 });
  });

  it("incremental 扫描:指纹未变则全 skip", async () => {
    const dir = writeFiles();
    await scanLocalSource("sL3", { path: dir }, "full");
    const res = await scanLocalSource("sL3", { path: dir }, "incremental");
    expect(res).toMatchObject({ added: 0, updated: 0, removed: 0, skipped: 2 });
  });

  it("incremental 扫描:文件内容变化后重新入库(updated)", async () => {
    const dir = writeFiles();
    await scanLocalSource("sL4", { path: dir }, "full");
    // 改大小 -> 指纹变化
    fs.writeFileSync(path.join(dir, "one.wav"), buildWav(3));
    const res = await scanLocalSource("sL4", { path: dir }, "incremental");
    expect(res.added).toBe(0);
    expect(res.updated).toBe(1);
    expect(res.skipped).toBe(1);
  });

  it("文件消失后 full 扫描回收歌曲行并清理孤儿", async () => {
    const dir = writeFiles();
    await scanLocalSource("sL5", { path: dir }, "full");
    fs.unlinkSync(path.join(dir, "sub", "two.wav"));
    const res = await scanLocalSource("sL5", { path: dir }, "full");

    expect(res).toMatchObject({ added: 0, updated: 1, removed: 1 });
    const rows = sqlite.prepare("SELECT id FROM songs WHERE path LIKE 'l:sL5:%'").all();
    expect(rows).toHaveLength(1);
  });

  it("预先 aborted 的 signal:立即返回 aborted 且不做删除", async () => {
    const dir = writeFiles();
    await scanLocalSource("sL6", { path: dir }, "full");
    const ac = new AbortController();
    ac.abort();
    const res = await scanLocalSource("sL6", { path: dir }, "full", undefined, ac.signal);

    expect(res.aborted).toBe(true);
    expect(res.removed).toBe(0);
    const rows = sqlite.prepare("SELECT id FROM songs WHERE path LIKE 'l:sL6:%'").all();
    expect(rows).toHaveLength(2);
  });
});
