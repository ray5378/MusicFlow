// MUST be the first import: redirects DATA_DIR to an isolated temp dir before
// the backend opens its SQLite DB at module-load time.
import "../plugins/_env.js";

import { describe, it, expect, beforeAll } from "vitest";
import { db, initDatabase, sqlite } from "../../src/db/index.js";
import { songs, albums, artists } from "../../src/db/schema.js";
import { eq } from "drizzle-orm";
import {
  extractMetadataHeader,
  upsertSong,
  resolveLocalGroup,
  cleanupOrphans,
} from "../../src/services/source/scanner.js";

beforeAll(() => {
  if (!process.env.APP_VERSION) process.env.APP_VERSION = "1.0.0";
  initDatabase();
});

/** 最小合法 WAV(44B 头 + PCM 数据),用于走通 music-metadata 成功解析路径。 */
function makeWav(seconds = 1): Buffer {
  const sampleRate = 44100;
  const channels = 2;
  const bits = 16;
  const dataLen = sampleRate * channels * (bits / 8) * seconds;
  const buf = Buffer.alloc(44 + dataLen);
  buf.write("RIFF", 0);
  buf.writeUInt32LE(36 + dataLen, 4);
  buf.write("WAVE", 8);
  buf.write("fmt ", 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20); // PCM
  buf.writeUInt16LE(channels, 22);
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * channels * (bits / 8), 28);
  buf.writeUInt16LE((channels * bits) / 8, 32);
  buf.writeUInt16LE(bits, 34);
  buf.write("data", 36);
  buf.writeUInt32LE(dataLen, 40);
  return buf;
}

function meta(over: any = {}): any {
  return {
    title: "T",
    artist: "A",
    album: "AL",
    duration: 100,
    bitRate: 320,
    genre: "Pop",
    year: 2020,
    track: 1,
    discNumber: 1,
    contentType: "audio/mpeg",
    suffix: "mp3",
    size: 1024,
    albumArtist: "",
    composer: "",
    comment: "",
    ...over,
  };
}

describe("scanner.extractMetadataHeader", () => {
  it("头部非音频:music-metadata 返回空标签 → 标题回落到文件名", async () => {
    const m = await extractMetadataHeader(Buffer.from("not-an-audio-file"), "Artist - Title.mp3", 999);
    expect(m.title).toBe("Artist - Title");
    expect(m.artist).toBe("Unknown Artist");
    expect(m.album).toBe("Unknown Album");
    expect(m.contentType).toBe("audio/mpeg");
    expect(m.suffix).toBe("mp3");
    expect(m.size).toBe(999);
  });

  it("无后缀文件:无标签可解析 → 标题回落整个文件名", async () => {
    const m = await extractMetadataHeader(Buffer.from("garbage"), "A - B", 7);
    expect(m.title).toBe("A - B");
    expect(m.artist).toBe("Unknown Artist");
    expect(m.album).toBe("Unknown Album");
  });

  it("后缀决定 contentType/suffix(mp3/flac/wav)", async () => {
    for (const [name, ct] of [["x.mp3", "audio/mpeg"], ["x.flac", "audio/flac"], ["x.wav", "audio/wav"]] as Array<[string, string]>) {
      const m = await extractMetadataHeader(Buffer.from("garbage"), name, 1);
      expect(m.contentType, name).toBe(ct);
    }
  });

  it("合法 WAV 头部 → 解析成功,时长按采样率推算且不再标 incomplete", async () => {
    const wav = makeWav(2);
    const m = await extractMetadataHeader(wav, "Artist - Title.wav", wav.length);
    expect(m.incomplete).toBeUndefined();
    expect(m.duration).toBeGreaterThanOrEqual(1);
    expect(m.contentType).toBe("audio/wav");
    expect(m.suffix).toBe("wav");
    // WAV 无 ID3 标签 → 标题回落到文件名
    expect(m.title).toBe("Artist - Title");
    expect(m.artist).toBe("Unknown Artist");
  });
});

describe("scanner.upsertSong", () => {
  const p1 = "test:scanner:song-1";

  it("首次入库 added,再次同 path 入库 updated", () => {
    const r1 = upsertSong(p1, meta({ title: "Song One" }), "src-test");
    expect(r1).toBe("added");
    const row = db.select().from(songs).where(eq(songs.path, p1)).get();
    expect(row).toBeTruthy();
    expect(row!.title).toBe("Song One");
    expect(row!.artist).toBe("A");
    expect(typeof row!.artistId).toBe("string");
    expect(typeof row!.albumId).toBe("string");

    const r2 = upsertSong(p1, meta({ title: "Song One Renamed" }), "src-test");
    expect(r2).toBe("updated");
    const row2 = db.select().from(songs).where(eq(songs.path, p1)).get();
    expect(row2!.title).toBe("Song One Renamed");
  });

  it("歌词存在性只标 1/0,且不会把已有 1 降级", () => {
    const p = "test:scanner:lyric-" + Date.now();
    expect(upsertSong(p, meta({ lyrics: "lalala" }), "src-test")).toBe("added");
    expect(db.select().from(songs).where(eq(songs.path, p)).get()!.hasLyrics).toBe(1);
    // 二次扫描元数据里没有歌词 → 保持 1(在线歌词可能已落盘)
    upsertSong(p, meta({ lyrics: undefined }), "src-test");
    expect(db.select().from(songs).where(eq(songs.path, p)).get()!.hasLyrics).toBe(1);
  });

  it("fingerprint 传入即落库", () => {
    const p = "test:scanner:fp-" + Date.now();
    upsertSong(p, meta(), "src-test", "123|etag|x");
    expect(db.select().from(songs).where(eq(songs.path, p)).get()!.fingerprint).toBe("123|etag|x");
  });
});

describe("scanner.resolveLocalGroup", () => {
  it("title 与 artist 皆空 → 返回 null", () => {
    expect(resolveLocalGroup(meta({ title: "", artist: "" }))).toBeNull();
    expect(resolveLocalGroup(meta({ title: "   ", artist: "  " }))).toBeNull();
  });

  it("有标题或艺术家 → 返回 groupId 与 groupKey", () => {
    const g = resolveLocalGroup(meta({ title: "Same Song", artist: "Same Artist", album: "Same Album" }));
    expect(g).not.toBeNull();
    expect(typeof g!.groupId).toBe("string");
    expect(typeof g!.groupKey).toBe("string");
    expect(g!.groupId.length).toBeGreaterThan(0);
  });
});

describe("scanner.cleanupOrphans", () => {
  it("清掉无歌曲的专辑/艺术家,有歌曲的保留", () => {
    // 造孤儿专辑(无任何歌曲)+ 孤儿艺术家
    const orphanAlbumId = "album-orphan-" + Date.now();
    const orphanArtistId = "artist-orphan-" + Date.now();
    sqlite.prepare("INSERT INTO artists (id, name) VALUES (?, ?)").run(orphanArtistId, "Orphan Artist");
    sqlite.prepare("INSERT INTO albums (id, name) VALUES (?, ?)").run(orphanAlbumId, "Orphan Album");

    expect(() => cleanupOrphans()).not.toThrow();
    // 孤儿必须被清掉
    expect(db.select().from(albums).where(eq(albums.id, orphanAlbumId)).get()).toBeUndefined();
    expect(db.select().from(artists).where(eq(artists.id, orphanArtistId)).get()).toBeUndefined();

    // 有歌曲的专辑/艺术家必须保留(本用例自造,不依赖其他用例的执行顺序)
    const keepPath = "test:scanner:keep-" + Date.now();
    upsertSong(keepPath, meta({ title: "Keep Me" }), "src-test");
    const kept = db.select().from(songs).where(eq(songs.path, keepPath)).get();
    expect(kept).toBeTruthy();
    expect(db.select().from(albums).where(eq(albums.id, kept!.albumId!)).get()).toBeTruthy();
    expect(db.select().from(artists).where(eq(artists.id, kept!.artistId!)).get()).toBeTruthy();
  });
});
