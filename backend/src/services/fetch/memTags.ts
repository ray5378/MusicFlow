// ==================== 纯内存标签读写（FLAC / MP3，零落盘） ====================
//
// 为什么不用 ffmpeg：WebDAV 标签修复要求「下载 → 改标签 → 上传」全程只在内存里，
// 而 ffmpeg 只吃文件路径、且要求输出可回填（seekable），必须落临时文件。
// 这里直接操作容器字节：
//   - FLAC：VORBIS_COMMENT（文本标签 + 歌词）与 PICTURE（封面）两个 metadata block；
//   - MP3 ：ID3v2.3 帧（TIT2/TPE1/TALB/USLT/APIC），其它帧原样保留。
// 只做「改这几个字段」，不重编码音频：FLAC 是重组 metadata 后拼接音频字节；
// MP3 是替换文件头的 ID3v2 标签、音频帧一个字节不动。
//
// 内存占用 ≈ 一首歌大小（一次只处理一首），调用方负责及时释放。

export type Container = "flac" | "mp3";

export interface CoverImage {
  data: Buffer;
  mime: string;
}

/** 从文件读出/要写回的一组标签（缺省字段 = 不动）。 */
export interface MemTags {
  title?: string;
  artist?: string;
  album?: string;
  /** 纯文本歌词（无时间轴也可；跟 tagWriter 的 lyric 口径一致） */
  lyric?: string;
  cover?: CoverImage;
}

export function containerOfName(name: string): Container | null {
  const lower = name.toLowerCase();
  if (lower.endsWith(".flac")) return "flac";
  if (lower.endsWith(".mp3")) return "mp3";
  return null;
}

// ---------------------------------------------------------------------------
// FLAC
// ---------------------------------------------------------------------------

interface FlacBlock {
  type: number;
  body: Buffer;
}

function flacSplit(buf: Buffer): { blocks: FlacBlock[]; audioOffset: number } | null {
  if (buf.length < 8 || buf.subarray(0, 4).toString("latin1") !== "fLaC") return null;
  const blocks: FlacBlock[] = [];
  let off = 4;
  for (;;) {
    if (off + 4 > buf.length) return null;
    const head = buf[off];
    const len = (buf[off + 1] << 16) | (buf[off + 2] << 8) | buf[off + 3];
    if (off + 4 + len > buf.length) return null;
    blocks.push({ type: head & 0x7f, body: buf.subarray(off + 4, off + 4 + len) });
    off += 4 + len;
    if (head & 0x80) break;
  }
  return { blocks, audioOffset: off };
}

function flacParseComment(body: Buffer): Map<string, string> {
  const map = new Map<string, string>();
  let p = 0;
  if (p + 4 > body.length) return map;
  const vlen = body.readUInt32LE(p);
  p += 4 + vlen;
  if (p + 4 > body.length) return map;
  const count = body.readUInt32LE(p);
  p += 4;
  for (let i = 0; i < count; i++) {
    if (p + 4 > body.length) break;
    const len = body.readUInt32LE(p);
    p += 4;
    if (p + len > body.length) break;
    const entry = body.subarray(p, p + len).toString("utf8");
    p += len;
    const eq = entry.indexOf("=");
    if (eq > 0) map.set(entry.slice(0, eq).toUpperCase(), entry.slice(eq + 1));
  }
  return map;
}

function flacBuildComment(vendor: Buffer, map: Map<string, string>): Buffer {
  const parts: Buffer[] = [];
  const vl = Buffer.alloc(4);
  vl.writeUInt32LE(vendor.length);
  parts.push(vl, vendor);
  const entries: Buffer[] = [];
  for (const [k, v] of map) {
    const b = Buffer.from(k + "=" + v, "utf8");
    const l = Buffer.alloc(4);
    l.writeUInt32LE(b.length);
    entries.push(l, b);
  }
  const cl = Buffer.alloc(4);
  cl.writeUInt32LE(entries.length / 2);
  parts.push(cl, ...entries);
  return Buffer.concat(parts);
}

function flacParsePicture(body: Buffer): CoverImage | null {
  // type(4) mimeLen(4) mime descLen(4) desc w(4) h(4) depth(4) colors(4) dataLen(4) data
  let p = 0;
  if (body.length < 8) return null;
  p += 4; // picture type（大端，无符号）
  const mimeLen = body.readUInt32BE(p);
  p += 4;
  if (p + mimeLen > body.length) return null;
  const mime = body.subarray(p, p + mimeLen).toString("latin1") || "image/jpeg";
  p += mimeLen;
  if (p + 4 > body.length) return null;
  const descLen = body.readUInt32BE(p);
  p += 4 + descLen;
  if (p + 16 > body.length) return null;
  const dataLen = body.readUInt32BE(p + 16);
  p += 20;
  if (p + dataLen > body.length) return null;
  return { data: body.subarray(p, p + dataLen), mime };
}

function flacBuildPicture(cover: CoverImage): Buffer {
  const mime = Buffer.from(cover.mime || "image/jpeg", "latin1");
  // ⚠️ FLAC 的 PICTURE 块所有整数都是**大端**（VORBIS_COMMENT 才是小端）。
  //   写成小端会被解码器读成 0x03000000（ffmpeg: Invalid picture type: 50331648）。
  const head = Buffer.alloc(4);
  head.writeUInt32BE(3, 0); // 3 = front cover
  const ml = Buffer.alloc(4);
  ml.writeUInt32BE(mime.length, 0);
  const descLen = Buffer.alloc(4);
  descLen.writeUInt32BE(0, 0);
  const dims = Buffer.alloc(16); // w/h/depth/colors 未知填 0，播放器均容错
  const dl = Buffer.alloc(4);
  dl.writeUInt32BE(cover.data.length, 0);
  return Buffer.concat([head, ml, mime, descLen, dims, dl, cover.data]);
}

export function flacReadTags(buf: Buffer): MemTags {
  const split = flacSplit(buf);
  if (!split) return {};
  const out: MemTags = {};
  const vc = split.blocks.find((b) => b.type === 4);
  if (vc) {
    const map = flacParseComment(vc.body);
    if (map.get("TITLE")) out.title = map.get("TITLE");
    if (map.get("ARTIST")) out.artist = map.get("ARTIST");
    if (map.get("ALBUM")) out.album = map.get("ALBUM");
    const lyr = map.get("LYRICS") || map.get("UNSYNCEDLYRICS");
    if (lyr) out.lyric = lyr;
  }
  const pic = split.blocks.find((b) => b.type === 6);
  if (pic) {
    const cover = flacParsePicture(pic.body);
    if (cover) out.cover = cover;
  }
  return out;
}

/**
 * 写回 FLAC：只重组 metadata（VORBIS_COMMENT / PICTURE），音频字节原样拼接。
 * patch 里出现的字段才改；lyric 传空串 = 删掉歌词条目。
 */
export function flacWriteTags(buf: Buffer, patch: MemTags): Buffer {
  const split = flacSplit(buf);
  if (!split) throw new Error("不是合法的 FLAC 头");
  const blocks = split.blocks.map((b) => ({ type: b.type, body: b.body }));

  const vcIdx = blocks.findIndex((b) => b.type === 4);
  const vendor = vcIdx >= 0 ? flacVendorOf(blocks[vcIdx].body) : Buffer.from("MusicFlow", "utf8");
  const map = vcIdx >= 0 ? flacParseComment(blocks[vcIdx].body) : new Map<string, string>();

  const setOrDelete = (key: string, value: string | undefined) => {
    if (value === undefined) return;
    if (value === "") map.delete(key);
    else map.set(key, value);
  };
  setOrDelete("TITLE", patch.title);
  setOrDelete("ARTIST", patch.artist);
  setOrDelete("ALBUM", patch.album);
  setOrDelete("LYRICS", patch.lyric);

  const newComment = flacBuildComment(vendor, map);
  if (vcIdx >= 0) blocks[vcIdx] = { type: 4, body: newComment };
  else blocks.splice(Math.min(1, blocks.length), 0, { type: 4, body: newComment });

  if (patch.cover) {
    const picIdx = blocks.findIndex((b) => b.type === 6);
    const body = flacBuildPicture(patch.cover);
    if (picIdx >= 0) blocks[picIdx] = { type: 6, body };
    else blocks.splice(Math.min(1, blocks.length), 0, { type: 6, body });
  }

  const heads: Buffer[] = [Buffer.from("fLaC", "latin1")];
  blocks.forEach((b, i) => {
    const h = Buffer.alloc(4);
    h[0] = (i === blocks.length - 1 ? 0x80 : 0) | b.type;
    h[1] = (b.body.length >> 16) & 0xff;
    h[2] = (b.body.length >> 8) & 0xff;
    h[3] = b.body.length & 0xff;
    heads.push(h, b.body);
  });
  return Buffer.concat([...heads, buf.subarray(split.audioOffset)]);
}

function flacVendorOf(body: Buffer): Buffer {
  if (body.length < 4) return Buffer.from("MusicFlow", "utf8");
  const vlen = body.readUInt32LE(0);
  if (4 + vlen > body.length) return Buffer.from("MusicFlow", "utf8");
  return body.subarray(4, 4 + vlen);
}

// ---------------------------------------------------------------------------
// MP3（ID3v2）
// ---------------------------------------------------------------------------

interface Id3Frame {
  id: string;
  body: Buffer;
}

function synchsafe(buf: Buffer, off: number): number {
  return ((buf[off] & 0x7f) << 21) | ((buf[off + 1] & 0x7f) << 14) | ((buf[off + 2] & 0x7f) << 7) | (buf[off + 3] & 0x7f);
}

function makeSynchsafe(n: number): Buffer {
  return Buffer.from([(n >> 21) & 0x7f, (n >> 14) & 0x7f, (n >> 7) & 0x7f, n & 0x7f]);
}

function mp3Split(buf: Buffer): { version: number; frames: Id3Frame[]; audioOffset: number } {
  if (buf.length < 10 || buf.subarray(0, 3).toString("latin1") !== "ID3") {
    return { version: 3, frames: [], audioOffset: 0 };
  }
  const major = buf[3];
  const flags = buf[5];
  const size = synchsafe(buf, 6);
  const total = 10 + size + (flags & 0x10 ? 10 : 0);
  const end = Math.min(buf.length, total);
  const frames: Id3Frame[] = [];
  let p = 10;
  while (p + 10 <= end) {
    const id = buf.subarray(p, p + 4).toString("latin1");
    if (!/^[A-Z0-9]{4}$/.test(id)) break;
    const fsize = major >= 4 ? synchsafe(buf, p + 4) : buf.readUInt32BE(p + 4);
    if (fsize <= 0 || p + 10 + fsize > end) break;
    frames.push({ id, body: buf.subarray(p + 10, p + 10 + fsize) });
    p += 10 + fsize;
  }
  return { version: major, frames, audioOffset: end };
}

function decodeText(body: Buffer): string {
  if (body.length === 0) return "";
  const enc = body[0];
  const data = body.subarray(1);
  if (enc === 1) {
    // UTF-16 with BOM
    if (data.length >= 2 && data[0] === 0xff && data[1] === 0xfe) return data.subarray(2).toString("utf16le");
    if (data.length >= 2 && data[0] === 0xfe && data[1] === 0xff) {
      const swapped = Buffer.from(data.subarray(2));
      swapped.swap16();
      return swapped.toString("utf16le");
    }
    return data.toString("utf16le");
  }
  if (enc === 2) {
    const copy = Buffer.from(data);
    if (copy.length % 2 === 0) copy.swap16();
    return copy.toString("utf16le");
  }
  if (enc === 3) return data.toString("utf8");
  return data.toString("latin1");
}

function encodeTextFrame(id: string, value: string): Id3Frame {
  const body = Buffer.concat([Buffer.from([1]), Buffer.from("\ufeff" + value, "utf16le")]);
  return { id, body };
}

function parseApic(body: Buffer): CoverImage | null {
  if (body.length < 4) return null;
  let p = 1; // encoding
  const mimeEnd = body.indexOf(0, p);
  if (mimeEnd < 0) return null;
  const mime = body.subarray(p, mimeEnd).toString("latin1") || "image/jpeg";
  p = mimeEnd + 1 + 1; // + picture type
  // description 以编码相关的终止符结束
  const enc = body[0];
  if (enc === 1 || enc === 2) {
    while (p + 1 < body.length && !(body[p] === 0 && body[p + 1] === 0)) p += 2;
    p += 2;
  } else {
    const d = body.indexOf(0, p);
    if (d < 0) return null;
    p = d + 1;
  }
  if (p >= body.length) return null;
  return { data: body.subarray(p), mime };
}

function buildApic(cover: CoverImage): Id3Frame {
  const mime = Buffer.from(cover.mime || "image/jpeg", "latin1");
  const body = Buffer.concat([
    Buffer.from([0]), // latin1
    mime,
    Buffer.from([0, 3]), // mime 结束 + 3=front cover
    Buffer.from([0]), // 空描述：latin1 描述以单个 0 结束
    cover.data,
  ]);
  return { id: "APIC", body };
}

function parseUslt(body: Buffer): string {
  if (body.length < 5) return "";
  const enc = body[0];
  // enc(1) + lang(3) + descriptor(enc 终止) + 正文
  let p = 4;
  if (enc === 1 || enc === 2) {
    while (p + 1 < body.length && !(body[p] === 0 && body[p + 1] === 0)) p += 2;
    p += 2;
  } else {
    const d = body.indexOf(0, p);
    p = d < 0 ? p : d + 1;
  }
  return decodeText(Buffer.concat([Buffer.from([enc]), body.subarray(p)]));
}

function buildUslt(lyric: string): Id3Frame {
  const body = Buffer.concat([
    Buffer.from([1]),
    Buffer.from("XXX", "latin1"), // 语言占位
    Buffer.alloc(2), // 空描述：UTF-16 描述以 00 00 结束（不是 BOM）
    Buffer.from(lyric, "utf16le"),
  ]);
  return { id: "USLT", body };
}

export function mp3ReadTags(buf: Buffer): MemTags {
  const { frames } = mp3Split(buf);
  const out: MemTags = {};
  for (const f of frames) {
    if (f.id === "TIT2") out.title = decodeText(f.body);
    else if (f.id === "TPE1") out.artist = decodeText(f.body);
    else if (f.id === "TALB") out.album = decodeText(f.body);
    else if (f.id === "USLT") out.lyric = decodeUsltSafe(f.body);
    else if (f.id === "APIC") {
      const cover = parseApic(f.body);
      if (cover) out.cover = cover;
    }
  }
  return out;
}

function decodeUsltSafe(body: Buffer): string {
  try {
    return parseUslt(body);
  } catch {
    return "";
  }
}

/** 写回 MP3：替换/新增指定 ID3 帧，其它帧与音频字节原样保留。 */
export function mp3WriteTags(buf: Buffer, patch: MemTags): Buffer {
  const { frames, audioOffset } = mp3Split(buf);
  const replaced = new Set<string>();
  const next: Id3Frame[] = [];
  for (const f of frames) {
    if (f.id === "TIT2" && patch.title !== undefined) { replaced.add("TIT2"); continue; }
    if (f.id === "TPE1" && patch.artist !== undefined) { replaced.add("TPE1"); continue; }
    if (f.id === "TALB" && patch.album !== undefined) { replaced.add("TALB"); continue; }
    if (f.id === "USLT" && patch.lyric !== undefined) { replaced.add("USLT"); continue; }
    if (f.id === "APIC" && patch.cover !== undefined) { replaced.add("APIC"); continue; }
    next.push(f);
  }
  if (patch.title) next.unshift(encodeTextFrame("TIT2", patch.title));
  if (patch.artist) next.splice(patch.title ? 1 : 0, 0, encodeTextFrame("TPE1", patch.artist));
  if (patch.album) next.push(encodeTextFrame("TALB", patch.album));
  if (patch.lyric) next.push(buildUslt(patch.lyric));
  if (patch.cover) next.push(buildApic(patch.cover));

  const parts: Buffer[] = [];
  for (const f of next) {
    const h = Buffer.alloc(10);
    h.write(f.id, 0, "latin1");
    h.writeUInt32BE(f.body.length, 4); // 统一写 v2.3（非 synchsafe 帧长）
    parts.push(h, f.body);
  }
  const body = Buffer.concat(parts);
  const header = Buffer.concat([Buffer.from("ID3", "latin1"), Buffer.from([3, 0, 0]), makeSynchsafe(body.length)]);
  return Buffer.concat([header, body, buf.subarray(audioOffset)]);
}

// ---------------------------------------------------------------------------
// 统一入口
// ---------------------------------------------------------------------------

export function readTags(buf: Buffer, container: Container): MemTags {
  return container === "flac" ? flacReadTags(buf) : mp3ReadTags(buf);
}

export function writeTags(buf: Buffer, container: Container, patch: MemTags): Buffer {
  return container === "flac" ? flacWriteTags(buf, patch) : mp3WriteTags(buf, patch);
}
