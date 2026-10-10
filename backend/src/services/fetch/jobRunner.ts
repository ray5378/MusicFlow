// ==================== fetch 任务后台分片跑批（自 routes/api/fetch.ts 迁出） ====================
//
// 路由（手动建任务 / 重试）与定时洗版调度器（upgradeScheduler）共用同一条
// 「逐片 runBatchJob + hasMore 续片 + AbortController」语义，抽到 service 层避免
// routes 被非 HTTP 模块反向 import。
import { runBatchJob } from "../../batch/runner.js";
import { sleepBetweenBatch, ensureBaseBatchLimit } from "../plugin/batchPacer.js";
import { createLogger } from "../../utils/logger.js";
import { sqlite } from "../../db/index.js";
import { getFetchJob, updateFetchJobStatus, collectInterruptedFetchJobIds } from "./jobStore.js";
import { currentFetchConfig } from "./configStore.js";
import { ensureWritableDir } from "./writable.js";
import { buildLibraryContinuation } from "./library.js";

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
    // PATCH19 任务级并行：把「同时推进多少个 fetch 任务」落成全局批量闸的保底下限，
    // 运行时改配置即时生效（插件并行资格在此基础上只增不减）。
    ensureBaseBatchLimit(cfg.maxConcurrentJobs);
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
      maybeContinueLibraryJob(jobId);
      autoScanAfterJob(jobId);
    }
  })();
}

/**
 * 全库下载自动续批（产品定调 2026-10-10）：`__library` 标记的任务终态后，
 * 若仍有待下歌曲则自动创建并启动下一批，直到全库完成 / 关闭 / 用户取消。
 *
 * 只认「全库下载」入口建的任务（config 快照带 `__library` 标记）；手动单任务不续。
 * 防御：有其他活动任务时不续（避免多批叠加打爆平台接口）；本次机会让渡，
 * 由后续任务终态或用户手动触发。
 */
function hasAnyActiveJob(): boolean {
  try {
    const row = sqlite
      .prepare("SELECT COUNT(*) AS n FROM fetch_jobs WHERE status IN ('pending','running')")
      .get() as { n?: number };
    return Number(row?.n ?? 0) > 0;
  } catch {
    return true; // 查不动就当有任务在跑，宁可少续
  }
}

function maybeContinueLibraryJob(jobId: string): void {
  try {
    const job = getFetchJob(jobId);
    if (!job || job.status === "cancelled") return;
    let cfgj: any = (job as any)?.config;
    if (typeof cfgj === "string") {
      try {
        cfgj = JSON.parse(cfgj);
      } catch {
        return;
      }
    }
    if (!cfgj || typeof cfgj !== "object" || !cfgj.__library) return;
    // 导入触发批次（__library.noAutoContinue）**不参与全库自动续批**：它的语义是
    // 「把这批刚入库的歌下完」，不是「开始全库下载」，续批会把范围放大到全库。
    if (cfgj.__library.noAutoContinue === true) return;
    const cfg = currentFetchConfig();
    if (!cfg.libraryAutoContinue) return;
    if (hasAnyActiveJob()) return;
    const next = buildLibraryContinuation(cfg);
    if (!next.job) {
      log.info(`[LIBRARY-AUTO] 全库续批完成：无待下项（剩余 pending ${next.remaining}）`);
      return;
    }
    startFetchJob(next.job.id);
    log.info(`[LIBRARY-AUTO] 自动续批 ${next.enqueued} 首（剩余 pending ${next.remaining}），job=${next.job.id}`);
  } catch (e: any) {
    log.error("library 自动续批失败", { jobId, err: String(e?.message || e) });
  }
}

/**
 * 任务成功终态后自动增量扫描对应源（产品定调 2026-10-10「立刻添加进媒体库」）：
 * fetch 流程只落盘 + 迁移行，songs 行靠扫描器 upsertSong 建立——不扫就不进媒体库。
 * 防抖：只扫 done 且 added>0；__library 续批链中批（hasAnyActiveJob=true）跳过，链尾扫一次。
 */
function autoScanAfterJob(jobId: string): void {
  try {
    const job = getFetchJob(jobId);
    if (!job || job.status !== "done" || !job.sourceId) return;
    let cfgj: any = (job as any)?.config;
    if (typeof cfgj === "string") {
      try {
        cfgj = JSON.parse(cfgj);
      } catch {
        cfgj = {};
      }
    }
    const counts = (job as any)?.counts ?? {};
    if (!Number(counts.added)) return;
    void runBatchJob("scan", { sourceId: job.sourceId, mode: "incremental" })
      .then((r) => {
        const st = (r as { result?: { added?: number; updated?: number; removed?: number } })?.result ?? {};
        log.info(`[FETCH-AUTO-SCAN] job=${jobId} 源 ${job.sourceId}: +${st.added ?? 0} ~${st.updated ?? 0} -${st.removed ?? 0}`);
      })
      .catch((e) => log.warn("fetch 终态自动扫描失败", { jobId, err: String((e as Error)?.message || e) }));
  } catch (e) {
    log.warn("autoScanAfterJob 内部错误", { jobId, err: String((e as Error)?.message || e) });
  }
}

/** 取消运行中任务；任务不在跑返回 false。 */
export function abortFetchJob(jobId: string): boolean {
  const ctrl = controllers.get(jobId);
  if (!ctrl) return false;
  ctrl.abort();
  return true;
}

/**
 * boot 恢复（PATCH19）：上一进程遗留的 pending/running fetch 任务**重新入队续跑**，
 * 不再落 failed 终态。PATCH17 断点续跑已让 chunk 重跑对已有终态项秒跳，续跑成本
 * ≈ 只跑未完成项；全部终态的任务会在首片走「todo.length===0」分支直接落终态。
 * 返回恢复的任务数；单个恢复失败落 failed 不拖累其它任务。
 */
export function resumeInterruptedFetchJobs(): number {
  let resumed = 0;
  for (const id of collectInterruptedFetchJobIds()) {
    try {
      startFetchJob(id);
      resumed++;
    } catch (e: any) {
      updateFetchJobStatus(id, "failed", { error: `boot 恢复失败: ${e?.message || e}` });
      log.error("boot 恢复任务失败", { jobId: id, err: String(e?.message || e) });
    }
  }
  return resumed;
}
