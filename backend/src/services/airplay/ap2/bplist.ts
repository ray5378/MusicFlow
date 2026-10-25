// ==================== Apple 二进制 plist（bplist00）编解码（Phase 6b 批 2）====================
//
// AP2 SETUP 请求/响应体格式。自研最小实现（backend 无 plist 依赖），只覆盖 AP2
// 用到的类型：dict/array/ascii+utf16BE string/int(带符号)/real(f32|f64)/bool/data/date。
// 与对端 bed 的 biplist 互操作由 tests/fixtures/ap2 的 bplist 向量钉住。
//
// 编码：两遍（收集对象图 → 逐对象序列化）+ 引用宽度自适应 + offset 表 + 32B trailer。
// 解析：trailer → offset 表 → 递归对象图（深度上限防环）。
// int 输出 number（安全域内）；AP2 字段均在安全域。
import { Buffer } from "node:buffer";

export class BplistError extends Error {}

export type PlistValue =
  | string
  | number
  | boolean
  | Buffer
  | Date
  | PlistValue[]
  | { [key: string]: PlistValue };

const MAGIC = Buffer.from("bplist00", "ascii");
const TRAILER_LEN = 32;
const PLIST_EPOCH_OFFSET_MS = 978307200000; // 2001-01-01T00:00:00Z
const MAX_DEPTH = 64;

const isPlainObject = (v: unknown): v is { [key: string]: PlistValue } =>
  typeof v === "object" && v !== null && !Buffer.isBuffer(v) && !(v instanceof Date) && !Array.isArray(v);

/** int 编码宽度（1/2/4/8）。负数一律 8B 补码。 */
function intSize(n: number): number {
  if (n < 0) return 8;
  if (n <= 0xff) return 1;
  if (n <= 0xffff) return 2;
  if (n <= 0xffffffff) return 4;
  return 8;
}

function encodeInt(n: number): Buffer {
  const size = intSize(n);
  const out = Buffer.alloc(size);
  if (size >= 8) {
    // 8B 补码必须走 BigInt：2^64 - n 超出 number 精度（2^53）会静默舍入出错字节。
    let tmp = BigInt(n) & ((1n << 64n) - 1n);
    for (let i = size - 1; i >= 0; i--) {
      out[i] = Number(tmp & 0xffn);
      tmp >>= 8n;
    }
    return out;
  }
  let tmp = n < 0 ? 2 ** (size * 8) + n : n; // 补码
  for (let i = size - 1; i >= 0; i--) {
    out[i] = tmp % 256;
    tmp = Math.floor(tmp / 256);
  }
  return out;
}

/** marker 长度段：<15 直接嵌；≥15 用 0x?F + 完整 int 对象（marker+body）。返回完整 marker 字节。 */
function markerWithLength(markerBase: number, len: number): Buffer {
  if (len < 15) return Buffer.from([markerBase | len]);
  const size = len <= 0xff ? 1 : len <= 0xffff ? 2 : len <= 0xffffffff ? 4 : 8;
  // ⚠️ 长度是一个完整的 int 对象：marker + 长度值本身（不是字节宽度）。
  const nib = size >= 8 ? 3 : size === 4 ? 2 : size === 2 ? 1 : 0;
  return Buffer.concat([Buffer.from([markerBase | 0x0f]), Buffer.from([0x10 | nib]), encodeInt(len)]);
}

/** 编码为 bplist00。 */
export function bplistEncode(root: PlistValue): Buffer {
  // 1) 展开对象图（dict/array 递归登记；key 字符串也登记）
  const list: PlistValue[] = [];
  const indexOf = new Map<PlistValue, number>();
  const register = (v: PlistValue): number => {
    const id = list.length;
    list.push(v);
    if (Array.isArray(v)) for (const item of v) register(item);
    else if (isPlainObject(v)) {
      for (const k of Object.keys(v)) {
        register(k);
        register(v[k]); // ⚠️ value 也必须登记，否则 serialize 查 indexOf 抛「未登记」
      }
    }
    return id;
  };
  const top = register(root);
  const refSize = list.length < 256 ? 1 : list.length <= 0xffff ? 2 : 4;
  list.forEach((v, i) => indexOf.set(v, i));

  const refBuf = (refs: number[]): Buffer => {
    const out = Buffer.alloc(refs.length * refSize);
    refs.forEach((r, i) => {
      let v = r;
      for (let b = refSize - 1; b >= 0; b--) {
        out[i * refSize + b] = v & 0xff;
        v = Math.floor(v / 256);
      }
    });
    return out;
  };

  const serialize = (obj: PlistValue): Buffer => {
    if (obj === true) return Buffer.from([0x09]);
    if (obj === false) return Buffer.from([0x08]);
    if (typeof obj === "number" && Number.isInteger(obj)) {
      const size = intSize(obj);
      // int marker = 0x10 | log2(size)（1/2/4/8B → 0x10/0x11/0x12/0x13），解码端按 1<<nibble 还原。
      const nib = size >= 8 ? 3 : size === 4 ? 2 : size === 2 ? 1 : 0;
      return Buffer.concat([Buffer.from([0x10 | nib]), encodeInt(obj)]);
    }
    if (typeof obj === "number") {
      const body = Buffer.alloc(8);
      body.writeDoubleBE(obj, 0);
      return Buffer.concat([Buffer.from([0x23]), body]);
    }
    if (typeof obj === "string") {
      const isAscii = /^[\x00-\x7f]*$/.test(obj);
      if (isAscii) {
        return Buffer.concat([markerWithLength(0x50, obj.length), Buffer.from(obj, "latin1")]);
      }
      const body = Buffer.alloc(obj.length * 2);
      for (let i = 0; i < obj.length; i++) body.writeUInt16BE(obj.charCodeAt(i), i * 2);
      return Buffer.concat([markerWithLength(0x60, obj.length), body]);
    }
    if (Buffer.isBuffer(obj)) {
      return Buffer.concat([markerWithLength(0x40, obj.length), obj]);
    }
    if (obj instanceof Date) {
      const body = Buffer.alloc(8);
      body.writeDoubleBE((obj.getTime() - PLIST_EPOCH_OFFSET_MS) / 1000, 0);
      return Buffer.concat([Buffer.from([0x33]), body]);
    }
    if (Array.isArray(obj)) {
      const refs = obj.map((item) => {
        const r = indexOf.get(item);
        if (r === undefined) throw new BplistError("array 子对象未登记");
        return r;
      });
      return Buffer.concat([markerWithLength(0xa0, obj.length), refBuf(refs)]);
    }
    if (isPlainObject(obj)) {
      const keys = Object.keys(obj);
      const keyRefs = keys.map((k) => {
        const r = indexOf.get(k);
        if (r === undefined) throw new BplistError("dict key 未登记");
        return r;
      });
      const valRefs = keys.map((k) => {
        const r = indexOf.get(obj[k]);
        if (r === undefined) throw new BplistError("dict value 未登记");
        return r;
      });
      return Buffer.concat([markerWithLength(0xd0, keys.length), refBuf(keyRefs), refBuf(valRefs)]);
    }
    throw new BplistError(`不支持的 plist 类型: ${typeof obj}`);
  };

  // 2) 逐对象序列化（保持 register 的顺序 = 对象编号顺序）
  // ⚠️ offset 是「文件内绝对偏移」（含 8B magic 前缀，与 biplist/标准一致），
  //    不能用 body 内相对偏移 —— 否则按 trailer 的 offsetTableOffset 解析必然错位。
  const chunks: Buffer[] = [];
  const offsets: number[] = [];
  let pos = MAGIC.length;
  for (const v of list) {
    const buf = serialize(v);
    offsets.push(pos);
    chunks.push(buf);
    pos += buf.length;
  }
  const body = Buffer.concat(chunks);

  // offset 表项宽度按「文件总长」选（1/2/4），与对象引用宽度 refSize 独立 ——
  // 对象少但字符串长时文件可远超 255B，必须能装下最大 offset。
  const n = offsets.length;
  let offsetSize = 1;
  for (;;) {
    const maxOff = MAGIC.length + body.length + n * offsetSize;
    const cap = offsetSize >= 4 ? 0x100000000 : 1 << (8 * offsetSize);
    if (maxOff < cap) break;
    offsetSize = offsetSize === 1 ? 2 : 4;
  }

  const offsetTable = Buffer.alloc(n * offsetSize);
  offsets.forEach((off, i) => {
    let v = off;
    for (let b = offsetSize - 1; b >= 0; b--) {
      offsetTable[i * offsetSize + b] = v & 0xff;
      v = Math.floor(v / 256);
    }
  });
  const offsetTableOffset = MAGIC.length + body.length;
  const trailer = Buffer.alloc(TRAILER_LEN);
  trailer[6] = offsetSize; // offsetIntSize
  trailer[7] = refSize; // objectRefSize
  trailer.writeBigInt64BE(BigInt(offsets.length), 8);
  trailer.writeBigInt64BE(BigInt(top), 16);
  trailer.writeBigInt64BE(BigInt(offsetTableOffset), 24);
  return Buffer.concat([MAGIC, body, offsetTable, trailer]);
}

// ---------------------------------------------------------------------------
// 解析
// ---------------------------------------------------------------------------

/** 解析 bplist00。 */
export function bplistDecode(buf: Buffer): PlistValue {
  if (buf.length < MAGIC.length + TRAILER_LEN || !buf.subarray(0, 8).equals(MAGIC)) {
    throw new BplistError("不是 bplist00");
  }
  const t = buf.subarray(buf.length - TRAILER_LEN);
  const offsetSize = t[6]!;
  const refSize = t[7]!;
  const numObjects = Number(t.readBigUInt64BE(8));
  const topObject = Number(t.readBigUInt64BE(16));
  const offsetTableOffset = Number(t.readBigUInt64BE(24));

  const objOffset = (i: number): number => {
    const p = offsetTableOffset + i * offsetSize;
    let v = 0;
    for (let b = 0; b < offsetSize; b++) v = v * 256 + buf[p + b]!;
    return v;
  };

  const parseAt = (objIndex: number, depth: number): PlistValue => {
    if (depth > MAX_DEPTH) throw new BplistError("plist 嵌套过深");
    let p = objOffset(objIndex);
    const marker = buf[p++]!;
    const readInt = (size: number): number => {
      // Apple bplist 语义：1/2/4B int 为无符号，仅 8B 为有符号补码
      // （biplist 实证：44100 → 2B 0xAC44，高位置 1 不代表负数）。
      if (size > 6) {
        let v = 0n;
        for (let b = 0; b < size; b++) v = v * 256n + BigInt(buf[p++]!);
        if (buf[p - size]! & 0x80) v -= 1n << BigInt(8 * size);
        const n = Number(v);
        if (!Number.isSafeInteger(n)) throw new BplistError(`int 超出安全整数域: ${v}`);
        return n;
      }
      let v = 0;
      for (let b = 0; b < size; b++) v = v * 256 + buf[p++]!;
      return v;
    };
    // 跟随长度：marker 已读，若低 4 位为 0xF 则读一个 int 作为长度。
    const followLen = (): number => {
      if ((marker & 0x0f) !== 0x0f) return marker & 0x0f;
      const intMarker = buf[p++]!;
      if ((intMarker & 0xf0) !== 0x10) throw new BplistError(`长度 int 标记非法: 0x${intMarker.toString(16)}`);
      return readInt(1 << (intMarker & 0x0f));
    };
    const readRefs = (len: number): number[] => {
      const out: number[] = [];
      for (let i = 0; i < len; i++) {
        let v = 0;
        for (let b = 0; b < refSize; b++) v = v * 256 + buf[p++]!;
        out.push(v);
      }
      return out;
    };

    switch (marker & 0xf0) {
      case 0x00: {
        const v = marker & 0x0f;
        if (v === 0x08) return false;
        if (v === 0x09) return true;
        if (v === 0x00 || v === 0x0f) return null as unknown as PlistValue;
        throw new BplistError(`简单值标记 0x${v.toString(16)} 未支持`);
      }
      case 0x10: {
        const size = 1 << (marker & 0x0f);
        const v = readInt(size);
        return v;
      }
      case 0x20: {
        const size = 1 << (marker & 0x0f);
        if (size !== 4 && size !== 8) throw new BplistError(`real 宽度 ${size} 未支持`);
        const v = size === 4 ? buf.readFloatBE(p) : buf.readDoubleBE(p);
        return v;
      }
      case 0x30: {
        return new Date(buf.readDoubleBE(p) * 1000 + PLIST_EPOCH_OFFSET_MS);
      }
      case 0x40: {
        const len = followLen();
        return buf.subarray(p, p + len);
      }
      case 0x50: {
        const len = followLen();
        return buf.toString("latin1", p, p + len);
      }
      case 0x60: {
        const len = followLen();
        let out = "";
        for (let i = 0; i < len; i++) out += String.fromCharCode(buf.readUInt16BE(p + i * 2));
        return out;
      }
      case 0x80: {
        // UID（AP2 未用，保留兜底）
        return readInt(marker & 0x0f);
      }
      case 0xa0:
      case 0xc0: {
        const len = followLen();
        return readRefs(len).map((r) => parseAt(r, depth + 1));
      }
      case 0xd0: {
        const len = followLen();
        const keyRefs = readRefs(len);
        const valRefs = readRefs(len);
        const out: { [key: string]: PlistValue } = {};
        for (let i = 0; i < len; i++) {
          const key = parseAt(keyRefs[i]!, depth + 1);
          if (typeof key !== "string") throw new BplistError("dict key 必须是 string");
          out[key] = parseAt(valRefs[i]!, depth + 1);
        }
        return out;
      }
      default:
        throw new BplistError(`未知标记 0x${marker.toString(16)}`);
    }
  };

  if (topObject >= numObjects) throw new BplistError("topObject 越界");
  return parseAt(topObject, 0);
}
