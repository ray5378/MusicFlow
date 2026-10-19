// ==================== 媒体源扫描任务运行器（手动 / 定时共用） ====================
//
// 把「发起一次媒体源扫描 + 记录实时进度 + 收尾」收口到一处，供两条触发路径共用：
//   - 手动：routes/api/sources.ts 的 POST /v1/sources/:id/scan（可停止）
//   - 定时：services/source/scanScheduler.ts 的每日定时增量扫描（trigger=auto）
//
// 关键动机：前端要能对**任何**触发方式的扫描实时显示进度（而非只在完成后拿最终态）。
// 进度只存在于批量子进程 IPC 回调的瞬时载荷里，必须落进一份可查询的进程内状态
// （scanJobs），前端轮询聚合接口时才能拿到。此前定时扫描直接调 runBatchJob 且不传
// onProgress，既不写 scanJobs 也无进度——故前端对定时扫描「什么都看不到」。
//
// 进度来源：批量子进程经 IPC 上报 { stage: "scan", ...ScanProgress }；
// 这里把非 scrape-* 的载荷落到 job.progress（与拆分前 routes 内联逻辑逐字对齐），
// scrape-* 载荷交给调用方自带的 onProgress（路由侧据此写 scrapeJobs）。
import { runBatchJob } from "../../batch/runner.js";
import { translate } from "../../i18n.js";
import { createLogger } from "../../utils/logger.js";
import type { ScanProgress } from "./scanner.js";

const log = createLogger("scan-runner");

export interface ScanJobState {
  status: "running" | "completed" | "stopped" | "failed";
  startedAt: string;
  finishedAt?: string;
  progress?: ScanProgress;
  result?: any;
  error?: string;
  mode?: "full" | "incremental";
  /** 触发方：manual（用户点按）/ auto（每日定时）。前端据此标注扫描来源。 */
  trigger?: "manual" | "auto";
  controller?: AbortController;
}

export const scanJobs = new Map<string, ScanJobState>();

// 完成/失败/停止的扫描任务保留 30 min(前端轮询取结果),超时清理防 Map 无界
// (running 中任务不清,避免并发扫描判定失效;参照 online.ts matchJobs 同款)。

export const SCAN_JOB_TTL_MS = 30 * 60 * 1000;

/**
 * 清扫终态任务：TTL 自**完成时刻**(finishedAt)起算，而非开始时刻(startedAt)——大库扫描
 * 常超过 30min，若按 startedAt 计时，任务一收尾就会被下一次清扫立即删除，前端 3s 轮询
 * 可能整段错过终态（toast 不弹、卡片不刷新、进度静默消失）。running 一律保留。
 */
export function sweepScanJobs(now: number = Date.now()): void {
  for (const [k, v] of scanJobs) {
    if (v.status === "running") continue;
    if (now - Date.parse(v.finishedAt ?? v.startedAt) >= SCAN_JOB_TTL_MS) scanJobs.delete(k);
  }
}

export const scanJobsSweep = setInterval(() => sweepScanJobs(), 5 * 60 * 1000);

(scanJobsSweep as any).unref?.();

/** 该源当前是否有扫描在跑（并发闸 / 定时让渡判定）。 */
export function isSourceScanRunning(id: string): boolean {
  return scanJobs.get(id)?.status === "running";
}

/** 聚合状态查询：把 controller 摘掉后外发（供前端一次性拉全部源）。 */
export function listScanJobs(): Record<string, Omit<ScanJobState, "controller">> {
  const out: Record<string, Omit<ScanJobState, "controller">> = {};
  for (const [id, job] of scanJobs) {
    const { controller: _controller, ...rest } = job;
    out[id] = rest;
  }
  return out;
}

export interface StartScanOptions {
  sourceId: string;
  mode: "full" | "incremental";
  trigger: "manual" | "auto";
  /** scrape-* 等非 scan 载荷的旁路回调（路由侧用于写 scrapeJobs）。 */
  onProgress?: (payload: any) => void;
  /** 结束回调（定时侧用于打日志）。 */
  onDone?: (r: { status: ScanJobState["status"]; result?: any; error?: string }) => void;
}

/**
 * 发起一次媒体源扫描。
 * @returns started=false 表示该源已有扫描在跑（busy，调用方自行决定报错或让渡）。
 */
export function startSourceScan(o: StartScanOptions): { started: boolean; busy?: boolean } {
  if (isSourceScanRunning(o.sourceId)) return { started: false, busy: true };

  const controller = new AbortController();
  const job: ScanJobState = {
    status: "running",
    startedAt: new Date().toISOString(),
    mode: o.mode,
    trigger: o.trigger,
    controller,
  };
  scanJobs.set(o.sourceId, job);

  const onProgress = (p: any) => {
    if (!p || typeof p !== "object") return;
    // scrape-* 阶段交回调用方（路由侧维护 scrapeJobs 的既有语义保持不变）。
    if (typeof p.stage === "string" && p.stage.startsWith("scrape")) {
      o.onProgress?.(p);
      return;
    }
    job.progress = { ...p };
  };

  const finalize = (status: ScanJobState["status"], extra: Partial<ScanJobState>): void => {
    scanJobs.set(o.sourceId, {
      ...job,
      ...extra,
      status,
      controller: undefined,
      finishedAt: new Date().toISOString(),
    });
    try {
      o.onDone?.({ status, result: extra.result, error: extra.error });
    } catch (e) {
      log.warn("[SCANNER] onDone 回调异常: " + (e instanceof Error ? e.message : String(e)));
    }
  };

  void (async () => {
    try {
      const { result, aborted } = await runBatchJob(
        "scan",
        { sourceId: o.sourceId, mode: o.mode },
        { signal: controller.signal, onProgress },
      );
      // runBatchJob 返回 { result, childRss, aborted }，但其 result 是 batch 作业的**外层载荷**
      // （scanHandler 返回 { result, aborted, scrape }）—— 真正的扫描结果在 result.result
      // 里，即 { added, updated, removed, skipped, failed }。少解一层会让前端拿不到计数。
      if (aborted || controller.signal.aborted) finalize("stopped", { result: result?.result });
      else finalize("completed", { result: result?.result });
    } catch (e: any) {
      log.error("[SCANNER] Scan error", { err: e });
      finalize("failed", { error: e?.message || translate("errors.scanner.failed") });
    }
  })();

  return { started: true };
}
