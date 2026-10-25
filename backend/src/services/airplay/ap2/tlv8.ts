// ==================== HAP TLV8 编解码（Phase 6b 批 1）====================
//
// 语义与对端 /tmp/ap2recv/ap2/pairing/hap.py Tlv8 逐字对齐：
//   - 编码：tag(1B) + len(1B) + value；value > 255 字节时按 255 分片
//     （同 tag 重复，对端 decode 会把同 tag 分片拼接）。
//   - 解码：同 tag 多次出现时**追加拼接**（hap.py decode 行为）。
// 消费方：hapPairing 状态机；严禁在别处手写 TLV 字节。
/** HAP TLV8 tag（hap.py Tlv8.Tag）。 */
export const TlvTag = {
  METHOD: 0,
  IDENTIFIER: 1,
  SALT: 2,
  PUBLICKEY: 3,
  PROOF: 4,
  ENCRYPTEDDATA: 5,
  STATE: 6,
  ERROR: 7,
  RETRYDELAY: 8,
  CERTIFICATE: 9,
  SIGNATURE: 10,
  PERMISSIONS: 11,
  FRAGMENTDATA: 12,
  FRAGMENTLAST: 13,
  FLAGS: 19,
  SEPARATOR: 255,
} as const;
export type TlvTagValue = (typeof TlvTag)[keyof typeof TlvTag];

/** TLV value 输入：Buffer 原样；string 按 utf8；number 为单字节（0-255，State/Method/Flags 等）。 */
export type TlvValue = Buffer | string | number;

export class TlvEncodeError extends Error {}

function toBuf(v: TlvValue): Buffer {
  if (Buffer.isBuffer(v)) return v;
  if (typeof v === "number") {
    if (!Number.isInteger(v) || v < 0 || v > 0xff) {
      throw new TlvEncodeError(`number value 必须是 0-255 整数: ${v}`);
    }
    return Buffer.from([v]);
  }
  return Buffer.from(v, "utf8");
}

/** 编码 tag/value 对序列。单 value > 255B 自动按 255 分片（同 tag 重复）。 */
export function tlvEncode(pairs: ReadonlyArray<readonly [number, TlvValue]>): Buffer {
  const chunks: Buffer[] = [];
  for (const [tag, value] of pairs) {
    if (!Number.isInteger(tag) || tag < 0 || tag > 0xff) {
      throw new TlvEncodeError(`tag 必须是 0-255 整数: ${tag}`);
    }
    const raw = toBuf(value);
    if (raw.length === 0) {
      chunks.push(Buffer.from([tag, 0]));
      continue;
    }
    for (let off = 0; off < raw.length; off += 255) {
      const len = Math.min(255, raw.length - off);
      chunks.push(Buffer.from([tag, len]), raw.subarray(off, off + len));
    }
  }
  return Buffer.concat(chunks);
}

/** 解析 TLV8。同 tag 分片拼接（hap.py 语义）。输入不合法（截断）抛错。 */
export function tlvDecode(buf: Buffer): Map<number, Buffer> {
  const out = new Map<number, Buffer>();
  let ptr = 0;
  while (ptr < buf.length) {
    if (buf.length - ptr < 2) {
      throw new Error(`TLV8 截断: 剩余 ${buf.length - ptr} 字节不足 tag+len`);
    }
    const tag = buf[ptr];
    const len = buf[ptr + 1];
    const end = ptr + 2 + len;
    if (buf.length < end) {
      throw new Error(`TLV8 截断: tag=${tag} 声明 ${len}B 但只剩 ${buf.length - (ptr + 2)}B`);
    }
    const value = buf.subarray(ptr + 2, end);
    const prev = out.get(tag);
    out.set(tag, prev ? Buffer.concat([prev, value]) : Buffer.from(value));
    ptr = end;
  }
  return out;
}

/** 取必填项，缺失抛错（携带 tag 名便于排障）。 */
export function tlvRequire(map: Map<number, Buffer>, tag: number, what: string): Buffer {
  const v = map.get(tag);
  if (!v) throw new Error(`HAP 响应缺少 ${what} (tag=${tag})`);
  return v;
}
