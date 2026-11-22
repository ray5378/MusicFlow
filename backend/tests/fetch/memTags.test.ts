import { describe, it, expect } from "vitest";
import {
  containerOfName,
  flacReadTags,
  flacWriteTags,
  mp3ReadTags,
  mp3WriteTags,
  readTags,
  writeTags,
} from "../../src/services/fetch/memTags.js";

/** 最小可用 FLAC：fLaC + STREAMINFO(34B，last) + VORBIS_COMMENT + 音频尾巴。 */
function buildFlac(opts: { title?: string; lyric?: string; audio?: Buffer } = {}): Buffer {
  const vendor = Buffer.from("test", "utf8");
  const entries: Buffer[] = [];
  const push = (k: string, v: string) => {
    const b = Buffer.from(k + "=" + v, "utf8");
    const l = Buffer.alloc(4);
    l.writeUInt32LE(b.length);
    entries.push(l, b);
  };
  if (opts.title) push("TITLE", opts.title);
  if (opts.lyric) push("LYRICS", opts.lyric);
  const vl = Buffer.alloc(4);
  vl.writeUInt32LE(vendor.length);
  const cl = Buffer.alloc(4);
  cl.writeUInt32LE(entries.length / 2);
  const comment = Buffer.concat([vl, vendor, cl, ...entries]);

  const streamInfo = Buffer.alloc(34, 0);
  const mk = (type: number, body: Buffer, last: boolean) => {
    const h = Buffer.alloc(4);
    h[0] = (last ? 0x80 : 0) | type;
    h[1] = (body.length >> 16) & 0xff;
    h[2] = (body.length >> 8) & 0xff;
    h[3] = body.length & 0xff;
    return Buffer.concat([h, body]);
  };
  return Buffer.concat([
    Buffer.from("fLaC", "latin1"),
    mk(0, streamInfo, false),
    mk(4, comment, true),
    opts.audio ?? Buffer.from([0xff, 0xf8, 1, 2, 3, 4, 5, 6]),
  ]);
}

/** 最小 MP3：ID3v2.3(TIT2) + 假音频帧。 */
function buildMp3(title: string): Buffer {
  const body = Buffer.concat([
    Buffer.from([1]),
    Buffer.from("\ufeff" + title, "utf16le"),
  ]);
  const h = Buffer.alloc(10);
  h.write("TIT2", 0, "latin1");
  h.writeUInt32BE(body.length, 4);
  const frame = Buffer.concat([h, body]);
  const size = frame.length;
  const header = Buffer.concat([
    Buffer.from("ID3", "latin1"),
    Buffer.from([3, 0, 0]),
    Buffer.from([(size >> 21) & 0x7f, (size >> 14) & 0x7f, (size >> 7) & 0x7f, size & 0x7f]),
  ]);
  return Buffer.concat([header, frame, Buffer.from([0xff, 0xfb, 0x90, 0x00, 1, 2, 3])]);
}

describe("memTags — 容器识别", () => {
  it("按扩展名识别 flac/mp3，其它返回 null", () => {
    expect(containerOfName("a.FLAC")).toBe("flac");
    expect(containerOfName("b.mp3")).toBe("mp3");
    expect(containerOfName("c.wav")).toBeNull();
  });
});

describe("memTags — FLAC 读写（纯内存）", () => {
  it("读不到标签时返回空对象，写入后可原样读回", () => {
    const src = buildFlac({ audio: Buffer.from([9, 9, 9, 9]) });
    expect(flacReadTags(src)).toEqual({});

    const out = flacWriteTags(src, {
      title: "该死的温柔",
      artist: "马天宇",
      album: "测试专辑",
      lyric: "[00:01.00]第一句\n[00:02.00]第二句",
    });
    const back = flacReadTags(out);
    expect(back.title).toBe("该死的温柔");
    expect(back.artist).toBe("马天宇");
    expect(back.album).toBe("测试专辑");
    expect(back.lyric).toContain("第二句");
  });

  it("音频字节一个不动（只重组 metadata）", () => {
    const audio = Buffer.from([0xff, 0xf8, 7, 7, 7, 7, 7, 7]);
    const src = buildFlac({ audio });
    const out = flacWriteTags(src, { album: "X" });
    expect(out.subarray(out.length - audio.length).equals(audio)).toBe(true);
  });

  it("lyric 传空串 = 删掉歌词条目（不是写空值）", () => {
    const src = buildFlac({ title: "T", lyric: "[00:01.00]旧词" });
    const out = flacWriteTags(src, { lyric: "" });
    expect(flacReadTags(out).lyric).toBeUndefined();
  });

  it("封面（PICTURE）可写可读，且 mime 保留", () => {
    const src = buildFlac({ title: "T" });
    const cover = { data: Buffer.from([0xff, 0xd8, 0xff, 0xd9]), mime: "image/jpeg" };
    const out = flacWriteTags(src, { cover });
    const back = flacReadTags(out);
    expect(back.cover?.mime).toBe("image/jpeg");
    expect(back.cover?.data.equals(cover.data)).toBe(true);
    // PICTURE 的整数是**大端**：类型 3 在磁盘上必须是 00 00 00 03。
    // 写成小端会被解码器读成 0x03000000（ffmpeg: Invalid picture type: 50331648）。
    const i = out.indexOf(Buffer.from("PICTURE"));
    void i;
    const blocks = out.subarray(4);
    let off = 0;
    let type3 = false;
    while (off + 4 <= blocks.length) {
      const head = blocks[off];
      const len = (blocks[off + 1] << 16) | (blocks[off + 2] << 8) | blocks[off + 3];
      if ((head & 0x7f) === 6) {
        const body = blocks.subarray(off + 4, off + 4 + len);
        type3 = body.readUInt32BE(0) === 3;
      }
      off += 4 + len;
      if (head & 0x80) break;
    }
    expect(type3).toBe(true);
  });

  it("改两次不累积：第二次只覆盖指定字段", () => {
    let buf = buildFlac({ title: "A" });
    buf = flacWriteTags(buf, { title: "B" });
    buf = flacWriteTags(buf, { album: "C" });
    const back = flacReadTags(buf);
    expect(back.title).toBe("B");
    expect(back.album).toBe("C");
  });
});

describe("memTags — MP3 ID3v2 读写（纯内存）", () => {
  it("读出已有标题，写入新字段后可读回", () => {
    const src = buildMp3("旧标题");
    expect(mp3ReadTags(src).title).toBe("旧标题");

    const out = mp3WriteTags(src, {
      title: "新标题",
      artist: "歌手",
      album: "专辑",
      lyric: "第一行\n第二行",
    });
    const back = mp3ReadTags(out);
    expect(back.title).toBe("新标题");
    expect(back.artist).toBe("歌手");
    expect(back.album).toBe("专辑");
    expect(back.lyric).toContain("第二行");
  });

  it("音频字节一个不动", () => {
    const src = buildMp3("T");
    const audio = src.subarray(src.length - 7);
    const out = mp3WriteTags(src, { album: "X" });
    expect(out.subarray(out.length - audio.length).equals(audio)).toBe(true);
  });

  it("只改标题时不会重复插入 TIT2", () => {
    let buf = buildMp3("一");
    buf = mp3WriteTags(buf, { title: "二" });
    buf = mp3WriteTags(buf, { title: "三" });
    expect(mp3ReadTags(buf).title).toBe("三");
    const count = buf.subarray(0, 200).toString("latin1").split("TIT2").length - 1;
    expect(count).toBe(1);
  });

  it("封面（APIC）可写可读", () => {
    const src = buildMp3("T");
    const cover = { data: Buffer.from([1, 2, 3, 4, 5]), mime: "image/png" };
    const out = mp3WriteTags(src, { cover });
    const back = mp3ReadTags(out);
    expect(back.cover?.mime).toBe("image/png");
    expect(back.cover?.data.equals(cover.data)).toBe(true);
  });
});

describe("memTags — 统一入口", () => {
  it("readTags/writeTags 按容器分派", () => {
    const flac = buildFlac({ title: "F" });
    expect(readTags(flac, "flac").title).toBe("F");
    const mp3 = buildMp3("M");
    expect(readTags(mp3, "mp3").title).toBe("M");
    expect(readTags(writeTags(mp3, "mp3", { album: "Z" }), "mp3").album).toBe("Z");
  });
});
