// Player 模块单例 + 接线。对照 MA:PlayerController 决策 → QueueController 切歌。
import { PlayerController } from "./PlayerController.js";
import { QueueController } from "./QueueController.js";

let playerCtrl: PlayerController | null = null;
let queueCtrl: QueueController | null = null;

export function getPlayerController(): PlayerController {
  if (!playerCtrl) playerCtrl = new PlayerController();
  return playerCtrl;
}

export function getQueueController(): QueueController {
  if (!queueCtrl) queueCtrl = new QueueController();
  return queueCtrl;
}

/** 接线:PlayerController 的决策转发给 QueueController。在 index.ts 启动时调一次。 */
export function wirePlayerQueueControllers(): void {
  const pc = getPlayerController();
  const qc = getQueueController();
  pc.onDecision = (decision, playerId) => {
    qc.handleDecision(decision, playerId).catch((e) => {
      console.warn(`[player] handleDecision ${decision} for ${playerId} failed:`, e);
    });
  };
}
