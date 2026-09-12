// ==================== color@v1 role ====================
//
// 出站 `server/state.color`:根据当前音频派生颜色状态。
import { BaseRole, sendJson } from "./base.js";

export type ColorState = {
  color?: string;
  timestamp?: number;
};

export class ColorRole extends BaseRole {
  constructor(client: any) {
    super("color@v1", client);
  }

  onActivate(): void {
    sendJson(this.client, "server/state", { color: null });
  }

  setState(hex: string, timestampUs?: number): void {
    const state: ColorState = { color: hex };
    if (timestampUs !== undefined) state.timestamp = timestampUs;
    sendJson(this.client, "server/state", { color: state });
  }
}

export function createColorRole(client: any): ColorRole {
  return new ColorRole(client);
}