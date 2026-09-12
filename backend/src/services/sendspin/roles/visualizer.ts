// ==================== visualizer@v1 role ====================
//
// 出站:type 16-21 下发可视化数据(loudness/beat/f_peak/spectrum/peak)。
import { BaseRole, sendJson } from "./base.js";

export const BIN_VIS_LOUDNESS = 16;
export const BIN_VIS_BEAT = 17;
export const BIN_VIS_F_PEAK = 18;
export const BIN_VIS_SPECTRUM = 19;
export const BIN_VIS_PEAK = 20;

export class VisualizerRole extends BaseRole {
  constructor(client: any) {
    super("visualizer@v1", client);
  }

  onActivate(): void {
    sendJson(this.client, "stream/start", {});
  }
}

export function createVisualizerRole(client: any): VisualizerRole {
  return new VisualizerRole(client);
}