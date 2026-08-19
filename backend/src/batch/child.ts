// ==================== 批量任务子进程入口 ====================
//
// 一次性子进程:启动时完成与主进程一致的插件/DB bootstrap(内置插件 + 建表 + 类型
// 回填 + 外置插件发现),**不**启动 HTTP/WS/播放器/DLNA/热重载/内存回收/调度器。
// 随后进入消息循环处理一个 job,跑完发送 result 并 process.exit(0)。
// 每个 job 独立子进程 → 峰值内存随进程销毁归还操作系统。
//
// 本文件同时会被 runner 直接 fork:prod 用 dist/batch/child.js,dev 用 src/batch/child.ts
// (tsx 的 loader 经 execArgv 继承)。

import { registerBuiltinPlugins } from "../plugins/builtins.js";
import { initDatabase, backfillGenres } from "../db/index.js";
import { discoverExternalPlugins } from "../plugins/discovery.js";
import { setRemoteInteractive } from "../services/plugin/batchPacer.js";
import { batchJobHandlers } from "./jobs.js";
import type { ChildToParentMessage, ParentToChildMessage } from "./types.js";
import { createLogger } from "../utils/logger.js";

const log = createLogger("batch-child");
const APP_VERSION = process.env.APP_VERSION || "dev";

function send(msg: ChildToParentMessage): void {
  if (typeof process.send === "function") process.send(msg);
}

/** 发送终结消息后退出(process.send 是异步的,必须等回调再 exit,否则消息可能丢失)。 */
function sendAndExit(msg: ChildToParentMessage, code: number): void {
  if (typeof process.send === "function") {
    process.send(msg, () => process.exit(code));
  } else {
    process.exit(code);
  }
}

// 心跳:每 30s 上报一次,父进程看门狗据此区分「正常长任务」与「卡死」。unref 不阻止退出。
const heartbeat = setInterval(() => send({ type: "heartbeat", pid: process.pid }), 30000);
heartbeat.unref?.();

let jobId: string | null = null;
let running = false;
const abortController = new AbortController();

process.on("message", async (raw: ParentToChildMessage) => {
  if (!raw || typeof raw !== "object") return;
  if (raw.type === "pace") {
    setRemoteInteractive(!!raw.active);
    return;
  }
  if (raw.type === "abort") {
    abortController.abort();
    return;
  }
  if (raw.type !== "run" || running) return;
  running = true;
  jobId = raw.jobId;

  const handler = batchJobHandlers[raw.kind];
  if (!handler) {
    sendAndExit({ type: "error", jobId: raw.jobId, error: `未知批量任务类型: ${raw.kind}` }, 1);
    return;
  }
  try {
    const result = await handler(raw.args || {}, {
      onProgress: (payload) => send({ type: "progress", jobId: raw.jobId, payload }),
      signal: abortController.signal,
    });
    sendAndExit({ type: "result", jobId: raw.jobId, result: result ?? null, rss: process.memoryUsage().rss }, 0);
  } catch (e: any) {
    log.error(`批量任务失败 ${raw.kind}`, { err: e?.message || e });
    sendAndExit({
      type: "error",
      jobId: raw.jobId,
      error: String((e && e.message) || e),
      sandboxCode: e?.sandboxCode,
      hint: e?.hint,
    }, 1);
  }
});

process.on("uncaughtException", (e: any) => {
  if (jobId) sendAndExit({ type: "error", jobId, error: String(e?.message || e) }, 1);
  else process.exit(1);
});
process.on("unhandledRejection", (e: any) => {
  if (jobId) sendAndExit({ type: "error", jobId, error: String(e?.message || e) }, 1);
  else process.exit(1);
});

// Bootstrap(与主进程 index.ts 顺序一致,但不启动任何服务)。
registerBuiltinPlugins();
initDatabase();
backfillGenres();
discoverExternalPlugins(APP_VERSION)
  .then(() => send({ type: "ready", pid: process.pid }))
  .catch((e: any) => {
    log.error("子进程 bootstrap 失败", { err: e?.message || e });
    process.exit(1);
  });
