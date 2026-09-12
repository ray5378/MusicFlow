// ==================== source@v1 role ====================
//
// source 客户端把本地录音经 type 12 上行;服务端把收到的块转发给消费方
// (metadata/visualizer 等)。此处提供块打包/解析纯函数(可单测)与角色占位。
import { BaseRole, sendBinary, sendJson } from "./base.js";

export const packSourceChunk = (timestampUs: bigint, data: Uint8Array): Uint8Array => {
  const h = Buffer.allocUnsafe(9);
  h[0] = 12;
  h.writeBigInt64BE(timestampUs, 1);
  return new Uint8Array(Buffer.concat([h, Buffer.from(data)]));
};

export const parseSourceChunk = (b: Uint8Array): { timestampUs: bigint; data: Uint8Array } => ({
  timestampUs: Buffer.from(b.subarray(1, 9)).readBigInt64BE(0),
  data: b.subarray(9),
});

export class SourceRole extends BaseRole {
  constructor(client: any) {
    super("source@v1", client);
  }

  /** 服务端备用 source(第 Runtime主动发起),一般不用。 */
  sendSourceStart(payload: Record<string, any>): void {
    sendJson(this.client, "stream/start", payload);
  }
  sendSourceData(ts: bigint, data: Uint8Array): void {
    sendBinary(this.client, packSourceChunk(ts, data));
  }
}

export function createSourceRole(client: any): SourceRole {
  return new SourceRole(client);
}