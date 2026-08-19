// ==================== 批量任务运行器(父进程侧) ====================
//
// 职责:
//   - 持有全局批量闸(acquireBatchLock)串行化所有批量任务(同一时刻只跑 1 个子进程);
//   - fork 一次性子进程 → 等 ready → 发 run → 转发 progress → 收 result/error;
//   - 看门狗:心跳/进度超时或子进程崩溃 → kill + 标记失败;
//   - abort:父进程 AbortSignal 触发时向子进程发 abort(如扫描停止),宽限期后强杀;
//   - pace:父进程交互窗口(搜索/导入)变化时向子进程发 pace,让批量任务让路;
//   - 收尾:任务结束统一 clearLibraryIndex() + touch()(子进程改了库,主进程缓存失效),
//     并记录子进程峰值 RSS 与主进程前后占用(方案3 的核心观测指标)。

import { fork, type ChildProcess } from "child_process";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";
import { acquireBatchLock, isInteractiveActive, onInteractiveChange } from "../services/plugin/batchPacer.js";
import { clearLibraryIndex } from "../services/plugin/libraryIndex.js";
import { touch } from "../services/memory/reclaim.js";
import { createLogger } from "../utils/logger.js";
import type { BatchJobKind, ChildToParentMessage, ParentToChildMessage } from "./types.js";

const log = createLogger("batch-runner");

// 看门狗:子进程超过该时长无任何消息(心跳 30s 打底,长任务也有 progress)即视为卡死。
const WATCHDOG_TIMEOUT_MS = 15 * 60 * 1000;
const WATCHDOG_CHECK_MS = 30 * 1000;
// abort 宽限期:发 abort 后若子进程仍不退(如卡在网络调用),强杀。
const ABORT_GRACE_MS = 30 * 1000;

const here = path.dirname(fileURLToPath(import.meta.url));
const CHILD_ENTRY = fs.existsSync(path.join(here, "child.js"))
  ? path.join(here, "child.js")
  : path.join(here, "child.ts");

/** 子进程失败时透传沙箱限制错误码/修复提示(与 jobRunner 的 PluginJobState 对齐)。 */
export class BatchJobError extends Error {
  sandboxCode?: string;
  hint?: string;
  constructor(message: string, sandboxCode?: string, hint?: string) {
    super(message);
    this.name = "BatchJobError";
    this.sandboxCode = sandboxCode;
    this.hint = hint;
  }
}

export interface RunBatchJobOptions {
  onProgress?: (payload: any) => void;
  signal?: AbortSignal;
}

export interface RunBatchJobResult {
  result: any;
  childRss: number;
  /** 任务被父进程 abort 中断(如扫描停止)。 */
  aborted?: boolean;
}

const runningChildren = new Set<ChildProcess>();

/** 是否有批量子进程正在运行(供状态端点/测试)。 */
export function anyBatchChildRunning(): boolean {
  return runningChildren.size > 0;
}

/** 测试钩子:替换 fork 实现(注入假子进程)。 */
let forkImpl: typeof fork = fork;
export function _setForkImplForTest(fn: typeof fork): void {
  forkImpl = fn;
}

/** 运行一个一次性批量子进程任务(先拿全局批量闸,FIFO 串行)。 */
export async function runBatchJob(
  kind: BatchJobKind,
  args: Record<string, any>,
  opts?: RunBatchJobOptions,
): Promise<RunBatchJobResult> {
  const release = await acquireBatchLock();
  const jobId = `b-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const startRss = process.memoryUsage().rss;
  try {
    return await new Promise<RunBatchJobResult>((resolve, reject) => {
      let settled = false;
      let aborted = false;
      let lastActivity = Date.now();
      let child: ChildProcess | null = null;
      let watchdog: NodeJS.Timeout | null = null;
      let killTimer: NodeJS.Timeout | null = null;
      let unsubscribePace: (() => void) | null = null;

      const cleanup = () => {
        if (watchdog) { clearInterval(watchdog); watchdog = null; }
        if (killTimer) { clearTimeout(killTimer); killTimer = null; }
        if (unsubscribePace) { unsubscribePace(); unsubscribePace = null; }
        if (child) runningChildren.delete(child);
      };

      const finishLog = (rss: number) => {
        const peak = process.memoryUsage().rss;
        log.info(
          `[BATCH] ${kind} 完成: 子进程峰值 ${Math.round(rss / 1048576)}MB, ` +
          `主进程 ${Math.round(startRss / 1048576)}MB → ${Math.round(peak / 1048576)}MB`,
        );
      };

      const settleResult = (result: any, rss: number) => {
        if (settled) return;
        settled = true;
        cleanup();
        // 子进程改了库,主进程缓存一律失效;标记活动(回收器只有在空闲时才跑)。
        clearLibraryIndex();
        touch();
        finishLog(rss);
        resolve({ result, childRss: rss, aborted });
      };

      const settleError = (err: Error) => {
        if (settled) return;
        settled = true;
        cleanup();
        clearLibraryIndex();
        touch();
        reject(err);
      };

      const sendToChild = (msg: ParentToChildMessage) => {
        if (child && child.connected && !child.killed) child.send(msg);
      };

      const abortNow = () => {
        if (aborted) return;
        aborted = true;
        sendToChild({ type: "abort", jobId });
        // 宽限期后仍不退则强杀(扫描函数支持 AbortSignal,正常会在宽限期内退出)。
        killTimer = setTimeout(() => {
          try { child?.kill("SIGKILL"); } catch { /* ignore */ }
        }, ABORT_GRACE_MS);
      };

      // 交互窗口联动:用户搜索/导入开始或结束时,把当前交互状态同步给子进程。
      unsubscribePace = onInteractiveChange((active) => sendToChild({ type: "pace", active }));

      try {
        child = forkImpl(CHILD_ENTRY, [], { stdio: ["inherit", "inherit", "inherit", "ipc"] });
      } catch (e: any) {
        settleError(new BatchJobError(`批量任务子进程启动失败: ${e?.message || e}`));
        return;
      }
      runningChildren.add(child);

      // 看门狗:无任何消息超时 → 卡死,强杀并报错。
      watchdog = setInterval(() => {
        if (Date.now() - lastActivity > WATCHDOG_TIMEOUT_MS) {
          log.error(`[BATCH] ${kind} 看门狗超时,强杀子进程`, { jobId });
          try { child?.kill("SIGKILL"); } catch { /* ignore */ }
          settleError(new BatchJobError("批量任务超时,已强制终止"));
        }
      }, WATCHDOG_CHECK_MS);
      watchdog.unref?.();

      // abort:父进程信号触发时转发给子进程。
      if (opts?.signal) {
        if (opts.signal.aborted) abortNow();
        else opts.signal.addEventListener("abort", abortNow, { once: true });
      }

      child.on("error", (e) => settleError(new BatchJobError(`批量任务子进程异常: ${e?.message || e}`)));

      child.on("exit", (code, signal) => {
        if (!settled) {
          settleError(new BatchJobError(`批量任务子进程异常退出(code=${code}, signal=${signal || "none"})`));
        }
      });

      child.on("message", (raw: ChildToParentMessage) => {
        if (!raw || typeof raw !== "object") return;
        lastActivity = Date.now();
        switch (raw.type) {
          case "ready":
            sendToChild({ type: "pace", active: isInteractiveActive() });
            sendToChild({ type: "run", jobId, kind, args });
            break;
          case "heartbeat":
            break;
          case "progress":
            opts?.onProgress?.(raw.payload);
            break;
          case "result":
            settleResult(raw.result, raw.rss);
            break;
          case "error":
            settleError(new BatchJobError(raw.error || "批量任务失败", raw.sandboxCode, raw.hint));
            break;
        }
      });
    });
  } finally {
    release();
  }
}
