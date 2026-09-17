import { BIN_JSON, BIN_FRAGMENT_MORE, BIN_FRAGMENT_END, MAX_FRAGMENT_FIRST, MAX_FRAGMENT_NEXT } from "./constants.js";

export interface JsonMessage { type: string; payload?: any }

export const packJsonBody = (m: JsonMessage): Uint8Array =>
  new Uint8Array(Buffer.concat([Buffer.from([BIN_JSON]), Buffer.from(JSON.stringify(m), "utf8")]));

export const unpackJsonBody = (b: Uint8Array): JsonMessage =>
  JSON.parse(Buffer.from(b.subarray(1)).toString("utf8"));

// 音频二进制帧头 = aiosendspin 金标准:1B msg_type(0x04) + 8B 大端微秒时间戳 + 4B 大端 send_ahead(ms)。
// 此前缺 send_ahead 4B(9B 头)导致严格客户端校验帧长不符;13B 头对齐 MA wire(`>BqI`)。
export const packAudioChunk = (timestampUs: bigint, data: Uint8Array, sendAheadMs = 0): Uint8Array => {
  const head = Buffer.allocUnsafe(13);
  head[0] = 0x04;
  head.writeBigInt64BE(timestampUs, 1);
  head.writeUInt32BE(sendAheadMs, 9);
  return new Uint8Array(Buffer.concat([head, Buffer.from(data)]));
};

export const parseAudioChunk = (b: Uint8Array): { timestampUs: bigint; sendAheadMs: number; data: Uint8Array } => {
  const ts = Buffer.from(b.subarray(1, 9)).readBigInt64BE(0);
  const ahead = Buffer.from(b.subarray(9, 13)).readUInt32BE(0);
  return { timestampUs: ts, sendAheadMs: ahead, data: b.subarray(13) };
};

export function fragment(data: Uint8Array, origType: number): Uint8Array[] {
  if (data.length <= MAX_FRAGMENT_FIRST + 1) {
    return [new Uint8Array(Buffer.concat([Buffer.from([BIN_FRAGMENT_MORE, origType]), Buffer.from(data)]))];
  }
  const parts: Uint8Array[] = [];
  let off = 0;
  parts.push(
    new Uint8Array(
      Buffer.concat([Buffer.from([BIN_FRAGMENT_MORE, origType]), Buffer.from(data.subarray(0, MAX_FRAGMENT_FIRST))]),
    ),
  );
  off = MAX_FRAGMENT_FIRST;
  while (off < data.length) {
    const n = Math.min(MAX_FRAGMENT_NEXT, data.length - off);
    const end = off + n >= data.length;
    const head = end ? BIN_FRAGMENT_END : BIN_FRAGMENT_MORE;
    parts.push(
      new Uint8Array(Buffer.concat([Buffer.from([head]), Buffer.from(data.subarray(off, off + n))])),
    );
    off += n;
  }
  return parts;
}

export function reassemble(parts: Uint8Array[]): Uint8Array {
  let out = Buffer.alloc(0);
  for (let i = 0; i < parts.length; i++) {
    // 首帧头 = [MORE, orig_type]（2B），续帧头 = [MORE|END]（1B）
    const skip = i === 0 ? 2 : 1;
    out = Buffer.concat([out, parts[i].subarray(skip)]);
  }
  return new Uint8Array(out);
}