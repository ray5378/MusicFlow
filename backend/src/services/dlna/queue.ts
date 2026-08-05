// 兼容层:原 QueueManager 的决策职责已上移到 player/QueueController.ts。
// 保留 getQueueManager() 转发 + 类型导出,供路由层(未迁移的部分)兼容调用。
import { getQueueController } from "../player/index.js";

export type { PlayMode, QueueItem, QueueSnapshot } from "../player/types.js";

export function suffixToMime(suffix: string): string {
  const SUFFIX_MIME: Record<string, string> = {
    mp3: "audio/mpeg", flac: "audio/flac", wav: "audio/wav", aac: "audio/aac",
    ogg: "audio/ogg", m4a: "audio/mp4", opus: "audio/opus",
    wma: "audio/x-ms-wma", ape: "audio/ape",
  };
  return SUFFIX_MIME[(suffix || "").toLowerCase()] || "audio/mpeg";
}

export function getQueueManager() {
  return getQueueController();
}
