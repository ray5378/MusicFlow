/**
 * scanLocalFiles ——「只扫指定文件列表」的增量入库入口(MusicFetch 落盘链路)。
 *
 * 与全量扫描(scanLocalSource)的唯一结构性差别:**不做收尾对账删除**。
 * 本文件的核心用例是「回归守卫」:调用后库里预先存在的其它条目数量必须不变 ——
 * 一旦有人把 scanLocalSource 的 seenPaths → DELETE 段搬进 scanLocalFiles,
 * 那条用例会立刻变红。
 *
 * 夹具:`tests/fixtures/audio/tagged.flac` 是带 Vorbis Comment 的真实小文件,
 * 用来证明本入口**复用**既有 extractMetadataLocal(而不是另写一套元信息提取)。
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { fileURLToPath } from "url";

import { scanLocalFiles, upsertSong } from "../../src/services/source/scanner.js";
import { db, sqlite } from "../../src/db/index.js";
import { mediaSources } from "../../src/db/schema.js";

const FIXTURES = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../fixtures/audio");

/** 手搓最小 WAV:44 字节 RIFF 头 + 静音 data 块(解析成功、但一个标签都没有)。 */
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

let tmpRoot = "";
let srcRoot = "";
let seq = 0;

/** 每个用例用独立 sourceId:同一个测试文件共用一个 SQLite 库。 */
function nextSourceId(): string {
  seq += 1;
  return `sf${seq}`;
}

/** 登记一个本地源(scanLocalFiles 用它取「源根」做越界校验)。 */
function registerSource(id: string, root: string): void {
  db.insert(mediaSources).values({
    id,
    name: `src-${id}`,
    type: "local",
    enabled: 1,
    config: JSON.stringify({ path: root }),
  }).run();
}

function writeWav(name: string, seconds = 1): string {
  const p = path.join(srcRoot, name);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, buildWav(seconds));
  return p;
}

function rowOf(songPath: string): any {
  return sqlite.prepare("SELECT * FROM songs WHERE path = ?").get(songPath);
}

function countSongs(): number {
  return (sqlite.prepare("SELECT COUNT(*) AS c FROM songs").get() as any).c;
}

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "mf-scanfiles-"));
  srcRoot = path.join(tmpRoot, "music");
  fs.mkdirSync(srcRoot, { recursive: true });
});

describe("scanLocalFiles", () => {
  it("扫 1 个新文件 -> 入库,关键字段正确(指纹/size/后缀与全量扫描同口径)", async () => {
    const id = nextSourceId();
    registerSource(id, srcRoot);
    const file = writeWav("one.wav", 2);
    const stat = fs.statSync(file);

    const res = await scanLocalFiles(id, [file]);

    expect(res).toMatchObject({ added: 1, updated: 0, failed: 0, skipped: 0 });

    const row = rowOf(`l:${id}:${file}`);
    expect(row).toBeTruthy();
    // WAV 无标签 -> 标题落文件名兜底
    expect(row.title).toBe("one");
    expect(row.artist).toBe("Unknown Artist");
    expect(row.album).toBe("Unknown Album");
    expect(row.suffix).toBe("wav");
    // 裸 SQL 取回的是 snake_case 列名
    expect(row.content_type).toBe("audio/wav");
    expect(row.size).toBe(stat.size);
    expect(row.fingerprint).toBe(`${stat.size}|${stat.mtimeMs}`);
  });

  it("扫 3 个文件 -> 三个都入库(含子目录)", async () => {
    const id = nextSourceId();
    registerSource(id, srcRoot);
    const files = [
      writeWav("a.wav"),
      writeWav("sub/b.wav"),
      writeWav("sub/deep/c.wav"),
    ];

    const res = await scanLocalFiles(id, files);

    expect(res).toMatchObject({ added: 3, updated: 0, failed: 0, skipped: 0 });
    const rows = sqlite.prepare("SELECT path FROM songs WHERE path LIKE ?").all(`l:${id}:%`) as any[];
    expect(rows).toHaveLength(3);
    for (const f of files) expect(rowOf(`l:${id}:${f}`)).toBeTruthy();
  });

  it("重复扫同一个文件 -> updated,不产生重复条目", async () => {
    const id = nextSourceId();
    registerSource(id, srcRoot);
    const file = writeWav("dup.wav");

    const first = await scanLocalFiles(id, [file]);
    const second = await scanLocalFiles(id, [file]);

    expect(first.added).toBe(1);
    expect(second).toMatchObject({ added: 0, updated: 1, failed: 0, skipped: 0 });
    const rows = sqlite.prepare("SELECT id FROM songs WHERE path LIKE ?").all(`l:${id}:%`) as any[];
    expect(rows).toHaveLength(1);
  });

  it("扫不存在的文件 -> 不抛异常、不计入成功(落 failed 并告警路径)", async () => {
    const id = nextSourceId();
    registerSource(id, srcRoot);
    const missing = path.join(srcRoot, "ghost.wav");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    try {
      const res = await scanLocalFiles(id, [missing]);

      expect(res).toMatchObject({ added: 0, updated: 0, failed: 1, skipped: 0 });
      expect(rowOf(`l:${id}:${missing}`)).toBeUndefined();
      const warned = warn.mock.calls.map((c) => String(c[0])).join("\n");
      expect(warned).toContain("指定文件入库失败");
      expect(warned).toContain("ghost.wav");
    } finally {
      warn.mockRestore();
    }
  });

  it("[回归守卫] 只扫 1 个文件 -> 库里预先存在的其它条目一个都不被回收", async () => {
    const id = nextSourceId();
    registerSource(id, srcRoot);

    // 预置:同 source 的其它文件 + 另一个 source 的 + 一条在线条目(非 l: 前缀)
    upsertSong(`l:${id}:/legacy/old1.mp3`, {
      title: "Old1", artist: "OA", album: "OAL", duration: 10, bitRate: 320, genre: "", year: 2000,
      track: 1, discNumber: 1, contentType: "audio/mpeg", suffix: "mp3", size: 100,
      albumArtist: "", composer: "", comment: "",
    } as any, id);
    upsertSong(`l:${id}:/legacy/old2.mp3`, {
      title: "Old2", artist: "OA", album: "OAL", duration: 10, bitRate: 320, genre: "", year: 2000,
      track: 1, discNumber: 1, contentType: "audio/mpeg", suffix: "mp3", size: 100,
      albumArtist: "", composer: "", comment: "",
    } as any, id);
    upsertSong("l:otherSource:/elsewhere/x.mp3", {
      title: "X", artist: "XA", album: "XAL", duration: 10, bitRate: 320, genre: "", year: 2000,
      track: 1, discNumber: 1, contentType: "audio/mpeg", suffix: "mp3", size: 100,
      albumArtist: "", composer: "", comment: "",
    } as any, "otherSource");
    upsertSong("netease:123456", {
      title: "Online", artist: "OA2", album: "OAL2", duration: 10, bitRate: 320, genre: "", year: 2000,
      track: 1, discNumber: 1, contentType: "audio/mpeg", suffix: "mp3", size: 100,
      albumArtist: "", composer: "", comment: "",
    } as any, "netease");

    const before = countSongs();
    const file = writeWav("new.wav");

    const res = await scanLocalFiles(id, [file]);

    expect(res).toMatchObject({ added: 1, failed: 0 });
    // 只多出这一首;既存的 4 条一条不少(证明没有触发全量对账误删)
    expect(countSongs()).toBe(before + 1);
    expect(rowOf(`l:${id}:/legacy/old1.mp3`)).toBeTruthy();
    expect(rowOf(`l:${id}:/legacy/old2.mp3`)).toBeTruthy();
    expect(rowOf("l:otherSource:/elsewhere/x.mp3")).toBeTruthy();
    expect(rowOf("netease:123456")).toBeTruthy();
    expect(rowOf(`l:${id}:${file}`)).toBeTruthy();
  });

  it("空数组 / 非数组输入 -> 安全返回全 0,不抛异常", async () => {
    const id = nextSourceId();
    registerSource(id, srcRoot);
    const before = countSongs();

    await expect(scanLocalFiles(id, [])).resolves.toMatchObject({ added: 0, updated: 0, failed: 0, skipped: 0 });
    await expect(scanLocalFiles(id, undefined as any)).resolves.toMatchObject({ added: 0, updated: 0, failed: 0, skipped: 0 });
    expect(countSongs()).toBe(before);
  });

  it("路径不在 source 根之下 -> 跳过并记日志,不入库", async () => {
    const id = nextSourceId();
    registerSource(id, srcRoot);
    const outside = path.join(tmpRoot, "outside", "sneak.wav");
    fs.mkdirSync(path.dirname(outside), { recursive: true });
    fs.writeFileSync(outside, buildWav(1));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    try {
      const res = await scanLocalFiles(id, [outside]);

      expect(res).toMatchObject({ added: 0, updated: 0, failed: 0, skipped: 1 });
      expect(rowOf(`l:${id}:${outside}`)).toBeUndefined();
      const warned = warn.mock.calls.map((c) => String(c[0])).join("\n");
      expect(warned).toContain("不在源根下");
    } finally {
      warn.mockRestore();
    }
  });

  it("source 未登记(查不到根) -> 降级为不校验,文件照常入库", async () => {
    const id = nextSourceId(); // 故意不 registerSource
    const file = writeWav("noreg.wav");

    const res = await scanLocalFiles(id, [file]);

    expect(res).toMatchObject({ added: 1, updated: 0, failed: 0, skipped: 0 });
    expect(rowOf(`l:${id}:${file}`)).toBeTruthy();
  });

  it("无可读标签的文件 -> 用文件名兜底,不抛异常", async () => {
    const id = nextSourceId();
    registerSource(id, srcRoot);
    // 内容不是合法 mp3:解析失败 -> 走文件名兜底分支
    const file = path.join(srcRoot, "Artist X - Title Y.mp3");
    fs.writeFileSync(file, Buffer.from("not a real mp3 payload at all"));

    const res = await scanLocalFiles(id, [file]);

    expect(res).toMatchObject({ added: 1, updated: 0, failed: 0, skipped: 0 });
    const row = rowOf(`l:${id}:${file}`);
    expect(row.title).toContain("Title Y");
    expect(String(row.artist).length).toBeGreaterThan(0);
    expect(row.suffix).toBe("mp3");
  });

  it("复用既有元信息提取:tagged.flac 的标签字段与全量扫描一致", async () => {
    const id = nextSourceId();
    registerSource(id, srcRoot);
    const file = path.join(srcRoot, "tagged.flac");
    fs.copyFileSync(path.join(FIXTURES, "tagged.flac"), file);

    const res = await scanLocalFiles(id, [file]);

    expect(res).toMatchObject({ added: 1, updated: 0, failed: 0, skipped: 0 });
    const row = rowOf(`l:${id}:${file}`);
    expect(row.title).toBe("Flac Title");
    expect(row.artist).toBe("Flac Artist");
    expect(row.album).toBe("Flac Album");
    expect(row.suffix).toBe("flac");
    expect(row.content_type).toBe("audio/flac");
    expect(row.year).toBe(2021);
  });

  it("进度回调:首尾 phase 正确且计数随文件推进", async () => {
    const id = nextSourceId();
    registerSource(id, srcRoot);
    const files = [writeWav("p1.wav"), writeWav("p2.wav")];
    const seen: any[] = [];

    await scanLocalFiles(id, files, (p) => seen.push({ ...p }));

    expect(seen[0].phase).toBe("scanning");
    expect(seen[seen.length - 1].phase).toBe("done");
    expect(seen[seen.length - 1]).toMatchObject({ added: 2, totalFiles: 2, processedFiles: 2, mode: "incremental" });
    expect(seen.some((p) => p.currentTrack === "p2.wav")).toBe(true);
  });

  it("已 abort 的 signal -> 不处理任何文件,也不删除任何条目", async () => {
    const id = nextSourceId();
    registerSource(id, srcRoot);
    upsertSong(`l:${id}:/legacy/keep.mp3`, {
      title: "Keep", artist: "KA", album: "KAL", duration: 10, bitRate: 320, genre: "", year: 2000,
      track: 1, discNumber: 1, contentType: "audio/mpeg", suffix: "mp3", size: 100,
      albumArtist: "", composer: "", comment: "",
    } as any, id);
    const before = countSongs();
    const ac = new AbortController();
    ac.abort();

    const res = await scanLocalFiles(id, [writeWav("skip.wav")], undefined, ac.signal);

    expect(res).toMatchObject({ added: 0, updated: 0, failed: 0, skipped: 0 });
    expect(countSongs()).toBe(before);
  });
});
