// ==================== artwork@v1 role ====================
//
// 出站:经 type 8-11 通道下发 jpeg/png 封面分块。type 由源(source)决定:
//   8 = artwork, 9-11 保留。
import { BaseRole, sendBinary } from "./base.js";

export const packArtworkChunk = (typeId: number, timestampUs: bigint, data: Uint8Array): Uint8Array => {
  const h = Buffer.allocUnsafe(9);
  h[0] = typeId;
  h.writeBigInt64BE(timestampUs, 1);
  return new Uint8Array(Buffer.concat([h, Buffer.from(data)]));
};

export class ArtworkRole extends BaseRole {
  constructor(client: any) {
    super("artwork@v1", client);
  }

  onActivate(): void {
    // artwork 无 client/state 对象 → 首个 server/state 之外,客户端 activation 即开流
  }

  sendImage(data: Uint8Array, timestampUs: bigint = 0n, typeId = 8): void {
    sendBinary(this.client, packArtworkChunk(typeId, timestampUs, data));
  }
}

export function createArtworkRole(client: any): ArtworkRole {
  return new ArtworkRole(client);
}