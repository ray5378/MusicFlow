// ==================== metadata@v1 role ====================
//
// 出站 `server/state.metadata`:向客户端推送当前曲文字元数据。
import { BaseRole, sendJson } from "./base.js";

export type MetadataState = {
  media_uri?: string;
  title?: string;
  artist?: string;
  album?: string;
  duration_ms?: number;
  state: "idle" | "playing" | "paused";
  timestamp?: number; // µs
};

export class MetadataRole extends BaseRole {
  constructor(client: any) {
    super("metadata@v1", client);
  }

  onActivate(): void {
    sendJson(this.client, "server/state", { metadata: null });
  }

  setState(state: MetadataState): void {
    sendJson(this.client, "server/state", { metadata: state });
  }
}

export function createMetadataRole(client: any): MetadataRole {
  return new MetadataRole(client);
}