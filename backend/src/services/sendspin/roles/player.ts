// ==================== player@v1 role ====================
//
// player 接收服务端推送的带时间戳音频。服务端不做播放状态管理之外的事:
// 实际推流由 stream.ts 的 SendspinStreamSession 逐客户端编码下发。
import { BaseRole } from "./base.js";

export class PlayerRole extends BaseRole {
  constructor(client: any) {
    super("player@v1", client);
  }
}

export function createPlayerRole(client: any): PlayerRole {
  return new PlayerRole(client);
}