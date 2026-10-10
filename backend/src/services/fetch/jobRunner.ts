// ==================== fetch 任务后台分片跑批（自 routes/api/fetch.ts 迁出） ====================
//
// 路由（手动建任务 / 重试）与定时洗版调度器（upgradeScheduler）共用同一条
// 「逐片 runBatchJob + hasMore 续片 + AbortController」语义，抽到 service 层避免
// routes 被非 HTTP 模块反向 import。
import { runBatchJob } from "../../batch/runner.js";
import { sleepBetweenBatch } from "../plugin/batchPacer.js";
import { createLogger } from "../../utils/logger.js";
import { updateFetchJobStatus } from "./jobStore.js";
import { currentFetchConfig } from "./configStore.js";
import { ensureWritableDir } from "./writable.js";

const log = createLogger("fetch-runner");

/** 运行中任务的 AbortController（jobId → controller），任务结束即移除。 */
const controllers = new Map<string, AbortController>();

/**
 * 后台分片循环：逐片 runBatchJob("fetch")，片间 sleepBetweenBatch 让位；
 * handler 每片结束返回 hasMore，据此决定是否继续。整批失败/取消在 catch 里落终态。
 */
export function startFetchJob(jobId: string): void {
  // 写目录预检：挂载属主/权限配错时整个任务快速失败（带修复指引），
  // 而不是跑到一半每个下载项都报 EACCES（2026-10-10 240 生产实测教训）。
  try {
    const cfg = currentFetchConfig();
    ensureWritableDir(cfg.downloadRoot);
    ensureWritableDir(cfg.cacheRoot);
  } catch (e: any) {
    const msg = String(e?.message || e);
    updateFetchJobStatus(jobId, "failed", { error: msg });
    log.error("fetch 任务启动预检失败", { jobId, err: msg });
    return;
  }
  const controller = new AbortController();
  controllers.set(jobId, controller);
  void (async () => {
    try {
      let chunk = 0;
      for (;;) {
        if (controller.signal.aborted) break;
        const r = await runBatchJob("fetch", { jobId, chunk }, { signal: controller.signal });
        if (!r?.result?.hasMore) break;
        chunk++;
        await sleepBetweenBatch();
      }
    } catch (e: any) {
      updateFetchJobStatus(jobId, controller.signal.aborted ? "cancelled" : "failed", {
        error: String(e?.message || e),
      });
      log.error("fetch 任务失败", { jobId, err: String(e?.message || e) });
    } finally {
      controllers.delete(jobId);
    }
  })();
}

/** 取消运行中任务；任务不在跑返回 false。 */
export function abortFetchJob(jobId: string): boolean {
  const ctrl = controllers.get(jobId);
  if (!ctrl) return false;
  ctrl.abort();
  return true;
}
