// ==================== fetch 任务后台分片跑批（自 routes/api/fetch.ts 迁出） ====================
//
// 路由（手动建任务 / 重试）与定时洗版调度器（upgradeScheduler）共用同一条
// 「逐片 runBatchJob + hasMore 续片 + AbortController」语义，抽到 service 层避免
// routes 被非 HTTP 模块反向 import。
import { runBatchJob } from "../../batch/runner.js";
import { sleepBetweenBatch, ensureBaseBatchLimit } from "../plugin/batchPacer.js";
import { createLogger } from "../../utils/logger.js";
import { sqlite } from "../../db/index.js";
import { getFetchJob, updateFetchJobStatus, saveFetchJobItems, collectInterruptedFetchJobIds } from "./jobStore.js";
import type { FetchJobItem } from "./jobStore.js";
import { currentFetchConfig } from "./configStore.js";
import { ensureWritableDir } from "./writable.js";
import { buildLibraryContinuation, libraryBatchProgressed } from "./library.js";
import { buildUpgradeContinuation } from "./upgrade.js";
import { setAutoSession } from "./autoSession.js";
import { enqueueTagRepairs } from "./tagRepair.js";

const log = createLogger("fetch-runner");

/**
 * 运行中任务的控制器（jobId → {hard, drain}），任务结束即移除。
 * 两个 AbortController 并行：hard = 硬停（abortFetchJob，行为一字不改）；
 * drain = 排空（drainFetchJob，只让子进程不再开始新工作、走完在途）。
 */
const controllers = new Map<string, { hard: AbortController; drain: AbortController }>();

/**
 * 后台分片循环：逐片 runBatchJob("fetch")，片间 sleepBetweenBatch 让位；
 * handler 每片结束返回 hasMore，据此决定是否继续。整批失败/取消在 catch 里落终态。
 */
export function startFetchJob(jobId: string): void {
  // 重入守卫（2026-10-16 修正）：同一 jobId 的循环已在跑时不得再起一条——否则
  // 同一任务被两个循环并发推进（`controllers.set` 会互相覆盖，进度/终态互相打架）。
  if (controllers.has(jobId)) return;
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
  const hard = new AbortController();
  const drain = new AbortController();
  controllers.set(jobId, { hard, drain });
  void (async () => {
    // drain 被请求后必须在循环退出处补全终态与未开始条目（详见 finalizeDrainedFetchJob）。
    let drained = false;
    try {
      let chunk = 0;
      for (;;) {
        if (hard.signal.aborted) break;
        // drain 已请求：不再开启新片；本片若已跑完则直接进收尾。
        if (drain.signal.aborted) { drained = true; break; }
        const r = await runBatchJob("fetch", { jobId, chunk }, {
          signal: hard.signal,
          drainSignal: drain.signal,
        });
        // 子进程按 drain 语义收尾（在途走完、未开始的不再开始）后返回；此时必须停链。
        if (drain.signal.aborted) { drained = true; break; }
        if (!r?.result?.hasMore) break;
        chunk++;
        await sleepBetweenBatch();
      }
    } catch (e: any) {
      const cancelled = hard.signal.aborted || drain.signal.aborted;
      drained = drain.signal.aborted;
      updateFetchJobStatus(jobId, cancelled ? "cancelled" : "failed", {
        error: String(e?.message || e),
      });
      log.error("fetch 任务失败", { jobId, err: String(e?.message || e) });
    } finally {
      // 排空收尾 / 完全停止收尾：任务记录补全（未开始项补写 cancelled）+ 落 cancelled 终态。
      // 必须在 maybeContinue*/autoScanAfterJob 之前完成，让它们看到正确的终态。
      // 完全停止（hard abort）优先于排空（两者同时 abort 时按「用户完全停止」记终态说明）：
      // 非末片 / 循环入参阶段被硬停时子进程不会写终态（只有 `!hasMore` 的末片才落），任务行会
      // **永久停在 running** → UI 永远「运行中」、hasAnyActiveJob 永久为真（续批链全断）、
      // 重启时 collectInterruptedFetchJobIds 还会把用户明确「完全停止」的任务复活。
      // 故在循环退出后补写 cancelled 终态（与排空收尾同款守卫，不会把已完成作业降级）。
      if (hard.signal.aborted) finalizeDrainedFetchJob(jobId, "用户完全停止");
      else if (drained) finalizeDrainedFetchJob(jobId);
      controllers.delete(jobId);
      // 完全停止 = 彻底终止整个流程（含自动续批链），语义等同「取消」：即便本任务恰在点击
      // 前一刻已落 done（末片跑完），也必须掐断续批链——否则 maybeContinue* 会在
      // `*AutoContinue` 默认开启下再开下一批（2026-10-16 修正）。
      const hardStopped = hard.signal.aborted;
      maybeContinueLibraryJob(jobId, hardStopped);
      maybeContinueUpgradeJob(jobId, hardStopped);
      autoScanAfterJob(jobId);
    }
  })();
}

/**
 * 排空收尾：`hasMore` 为 true 时 fetchHandler 不会落终态，故这道终态必须由 jobRunner 补。
 * 把本任务 targets.targets 里**尚未出现在 items** 的 targetId 补写成 cancelled 条目
 * （沿用已有条目、按 targetId 去重）—— 任何情况下都要让任务记录完整、UI「重试」可恢复。
 *
 * 终态写 cancelled **有守卫**：取消不能把一个已完成的作业改写成未完成。存在一个窄但真实
 * 的竞态 —— 用户在最后一片已真正跑完并落终态（done/partial/failed）之后的一瞬间点取消，
 * drain 已被 abort 但子进程早已把该片结果与终态算完；此时若无条件写 cancelled，就会把
 * done 降级成 cancelled 并挂上不实的「用户取消（排空收尾）」。故仅在当前 status 仍属于
 * pending/running/cancelled（即确未跑完）时才落 cancelled，done/partial/failed 一律保持不动
 * （保持 done 时 maybeContinue* 与 autoScanAfterJob 的续批/补扫行为与改动前一致）。
 *
 * `terminalError` 区分收尾原因（排空取消 vs 完全停止），供 UI 展示不同的终态说明。
 */
function finalizeDrainedFetchJob(jobId: string, terminalError = "用户取消（排空收尾）"): void {
  try {
    const job = getFetchJob(jobId);
    if (!job) return;
    // 未开始条目补写：与终态守卫无关，任何情况下都要补全记录。
    const all: any[] = Array.isArray(job.targets?.targets) ? job.targets.targets : [];
    const seen = new Set(job.items.map((i) => String(i.targetId)));
    const missing: FetchJobItem[] = all
      .filter((t) => t && t.id != null && !seen.has(String(t.id)))
      .map((t) => ({
        id: String(t.id),
        targetId: String(t.id),
        status: "cancelled" as const,
        attempts: 0,
        rejected: [],
        errorMsg: "任务已取消（未开始）",
      }));
    if (missing.length > 0) {
      // 同步 `counts.total` 与补全后的 items 对齐（2026-10-16 修正）：pending 阶段取消时
      // items 被补成 N 条 cancelled，但 counts.total 仍停在 0 → 列表「总数」与条目数不一致。
      saveFetchJobItems(jobId, [...job.items, ...missing], { total: all.length });
    }
    // 只在「确未跑完」的终态上落 cancelled，避免把已完成的作业降级。
    if (job.status === "pending" || job.status === "running" || job.status === "cancelled") {
      updateFetchJobStatus(jobId, "cancelled", { error: terminalError });
    }
  } catch (e: any) {
    log.error("fetch 排空收尾失败", { jobId, err: String(e?.message || e) });
  }
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

function maybeContinueLibraryJob(jobId: string, hardStopped = false): void {
  try {
    const job = getFetchJob(jobId);
    if (!job) return;
    let cfgj: any = (job as any)?.config;
    if (typeof cfgj === "string") {
      try {
        cfgj = JSON.parse(cfgj);
      } catch {
        cfgj = {};
      }
    }
    // 点名/导入触发批次（`__library.noAutoContinue`）不参与续批链：它是一次性的
    // （「把这批刚入库的歌下完」），**取消它不得误清全库链的会话标记**（2026-10-16 修正）。
    const noAutoContinue = !!cfgj && typeof cfgj === "object" && cfgj.__library?.noAutoContinue === true;
    if (job.status === "cancelled" || hardStopped) {
      // 用户取消 / 完全停止 → 续批链终止：清会话标记，否则调度器会把链复活（重启/让渡恢复）。
      if (job.kind === "library" && !noAutoContinue) setAutoSession("library", false);
      return;
    }
    if (!cfgj || typeof cfgj !== "object" || !cfgj.__library) return;
    // 导入触发批次（__library.noAutoContinue）**不参与全库自动续批**：它的语义是
    // 「把这批刚入库的歌下完」，不是「开始全库下载」，续批会把范围放大到全库。
    if (noAutoContinue) return;
    // 无进展保护(2026-10-12,修 240 无限续批循环):本批若 done=0 且 failed=0(全部 skipped,
    // 典型=全部下载冷却期 COOLDOWN_SKIPPED 且按设计不记账),未尝试集不收缩 → 续批只会
    // 无限重选同一批歌。见 libraryBatchProgressed 注释。必须中止自动续批链。
    // ⚠️ 中止必须**同时清会话标记**（2026-10-16 修正）：仅 return 会让 libraryScheduler
    // 每个 tick 都认为「库里仍有待下且无活动任务」→ 反复建批 → 无限续批。
    if (!libraryBatchProgressed(job.counts)) {
      const cc = job.counts;
      setAutoSession("library", false);
      log.info(
        `[LIBRARY-AUTO] 停止续批:本批无进展(done=${Number(cc?.done) || 0} failed=${Number(cc?.failed) || 0} skipped=${Number(cc?.skipped) || 0}),均为跳过/冷却秒跳,中止自动续批链,交由后续定时调度或手动重试`,
      );
      return;
    }
    const cfg = currentFetchConfig();
    if (!cfg.libraryAutoContinue) {
      setAutoSession("library", false);
      return;
    }
    if (hasAnyActiveJob()) return;
    const next = buildLibraryContinuation(cfg);
    if (!next.job) {
      setAutoSession("library", false);
      log.info(`[LIBRARY-AUTO] 全库续批完成：无待下项（剩余 pending ${next.remaining}）`);
      return;
    }
    setAutoSession("library", true); // 链未完：供重启/让渡后调度器立即接续
    startFetchJob(next.job.id);
    log.info(`[LIBRARY-AUTO] 自动续批 ${next.enqueued} 首（剩余 pending ${next.remaining}），job=${next.job.id}`);
  } catch (e: any) {
    log.error("library 自动续批失败", { jobId, err: String(e?.message || e) });
  }
}

/**
 * 洗版自动续批（产品定调 2026-10-12，对齐全库下载）：`__upgrade` 标记的任务终态后，
 * 若仍有可洗歌曲则自动创建并启动下一批，直到全部洗完 / 关闭 / 用户取消。
 *
 * 与全库下载的差异：冷却在**建批时**整批预记（buildUpgradeContinuation），未尝试集
 * 每批必收缩，链条天然终止；另加一道「零尝试」闸——本批一条都没跑上（典型=启动
 * 预检失败）时直接停链，避免系统性故障把整池歌无谓地扫进冷却。
 */
function maybeContinueUpgradeJob(jobId: string, hardStopped = false): void {
  try {
    const job = getFetchJob(jobId);
    if (!job) return;
    let cfgj: any = (job as any)?.config;
    if (typeof cfgj === "string") {
      try {
        cfgj = JSON.parse(cfgj);
      } catch {
        cfgj = {};
      }
    }
    // 点名批次（`__upgrade.noAutoContinue`）不参与续批链：取消它不得误清全库洗版链的会话标记。
    const noAutoContinue = !!cfgj && typeof cfgj === "object" && cfgj.__upgrade?.noAutoContinue === true;
    if (job.status === "cancelled" || hardStopped) {
      if (job.kind === "upgrade" && !noAutoContinue) setAutoSession("upgrade", false);
      return;
    }
    if (!cfgj || typeof cfgj !== "object" || !cfgj.__upgrade) return;
    // 点名批次（__upgrade.noAutoContinue）**不参与自动续批**：语义是「洗完点名的这几首」。
    if (noAutoContinue) return;
    const cc = (job as any)?.counts ?? {};
    // 零尝试闸：total>0 但 done/failed/skipped 全 0 = 启动预检失败之类的一条没跑上，
    // 续批只会把整池歌无谓扫进冷却，直接停链交回定时调度/手动。
    if (Number(cc?.total ?? 0) > 0 && !Number(cc?.done) && !Number(cc?.failed) && !Number(cc?.skipped)) {
      setAutoSession("upgrade", false);
      log.info(
        `[UPGRADE-AUTO] 停止续批:本批零尝试(total=${Number(cc?.total) || 0}),疑似启动预检失败,中止自动续批链`,
      );
      return;
    }
    const cfg = currentFetchConfig();
    if (!cfg.upgradeAutoContinue) {
      setAutoSession("upgrade", false);
      return;
    }
    if (hasAnyActiveJob()) return; // 让渡：会话标记保持，调度器随后接续
    const next = buildUpgradeContinuation(cfg);
    if (!next.job) {
      setAutoSession("upgrade", false);
      log.info(`[UPGRADE-AUTO] 全库洗版完成：无可洗项（剩余 belowBar ${next.remaining}）`);
      return;
    }
    setAutoSession("upgrade", true);
    startFetchJob(next.job.id);
    log.info(`[UPGRADE-AUTO] 自动续批 ${next.enqueued} 首（剩余 belowBar ${next.remaining}），job=${next.job.id}`);
  } catch (e: any) {
    log.error("upgrade 自动续批失败", { jobId, err: String(e?.message || e) });
  }
}

/**
 * 任务终态后自动增量扫描对应源（产品定调 2026-10-10「立刻添加进媒体库」）：
 * fetch 流程只落盘 + 迁移行，songs 行靠扫描器 upsertSong 建立——不扫就不进媒体库。
 * 防抖：扫 done 或（排空取消后）added>0 的任务；__library 续批链中批
 * （hasAnyActiveJob=true）跳过，链尾扫一次。
 */
function autoScanAfterJob(jobId: string): void {
  try {
    const job = getFetchJob(jobId);
    if (!job || !job.sourceId) return;
    const counts = (job as any)?.counts ?? {};
    // 守卫只覆盖两类：正常 done；以及被取消（drain 或硬停止）但本批**真落盘**的歌
    // （added>0）—— 否则这些歌进了文件系统却永远不进媒体库。
    // 刻意不放开 partial/failed：它们的漏扫是本次改动之前就存在的既有行为，不在范围内。
    // `added` 为 0 时下面那道闸照旧直接返回（什么都不做）。
    if (!(job.status === "done" || (job.status === "cancelled" && Number(counts.added) > 0))) return;
    // 标签缺失修复入队（方案 B 事件主路径，2026-10-11）：本次任务成功落盘入库的
    // 歌曲（imports 带 songId）都过一轮「探缺 → 拿得到才写」。enrich 阶段封面/
    // 歌词失败只告警不上抛（DNS 风暴等瞬时故障），这里兜住。入队自带 10min 初始
    // 延迟，等增量扫描把 songs 行建好；无关队列开关——tagRepairEnabled 在 tick 判。
    try {
      const ids = (job.imports ?? [])
        .filter((i) => i.songId && (i.result === "added" || i.result === "updated"))
        .map((i) => i.songId as string);
      if (ids.length > 0) enqueueTagRepairs([...new Set(ids)]);
    } catch (e: any) {
      log.warn("标签修复入队失败(不影响任务)", { jobId, err: String(e?.message || e) });
    }
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

/** 硬停止运行中任务（abort 语义，一字不改）；任务不在跑返回 false。 */
export function abortFetchJob(jobId: string): boolean {
  const ctrl = controllers.get(jobId);
  if (!ctrl) return false;
  ctrl.hard.abort();
  return true;
}

/** 排空式取消运行中任务（只停「开始新工作」，在途/已缓存工作走完）；任务不在跑返回 false。 */
export function drainFetchJob(jobId: string): boolean {
  const ctrl = controllers.get(jobId);
  if (!ctrl) return false;
  ctrl.drain.abort();
  return true;
}

/**
 * boot 恢复的延迟（2026-10-15）：容器起来后**不立刻**续跑遗留的批量任务，等 60s。
 *
 * 为什么要延后：启动瞬间宿主同时在跑 entrypoint 收尾、外置插件沙箱装配与首批用户
 * 请求，而一次续批会立刻拉起批量子进程 + 4 路 ffmpeg 转码。生产实测（2026-10-15）
 * 容器 CPU 419%~534%、宿主 8 核 load 15，转码闸排队最长 waitMs=64.7s，表现为
 * 「容器刚起来就卡」——所有依赖转码/入库/插件的操作都排在队列后面。
 * 延后 60s 让启动路径与首批交互先走完，随后按原逻辑续跑。
 */
export const BOOT_RESUME_DELAY_MS = 60_000;

/**
 * boot 恢复（PATCH19）：上一进程遗留的 pending/running fetch 任务**重新入队续跑**，
 * 不再落 failed 终态。PATCH17 断点续跑已让 chunk 重跑对已有终态项秒跳，续跑成本
 * ≈ 只跑未完成项；全部终态的任务会在首片走「todo.length===0」分支直接落终态。
 * 返回恢复的任务数；单个恢复失败落 failed 不拖累其它任务。
 */
export function resumeInterruptedFetchJobs(): number {
  let resumed = 0;
  for (const id of collectInterruptedFetchJobIds()) {
    // 本进程内已经在推进的任务**不算中断任务**，必须跳过：boot 恢复自 2026-10-15 起被
    // 延后 BOOT_RESUME_DELAY_MS，而这个窗口里别的调度器可能已经起了新任务（如
    // upgradeScheduler 的 boot tick 在 15s 恢复洗版链、libraryScheduler 在 60s 接续），
    // 那些行的状态同样是 pending/running，会被 collectInterruptedFetchJobIds 误收。
    // 而 startFetchJob 注册 AbortController 时不做「是否已在跑」判断，重复调用会让同一个
    // job 被两个批次循环并行推进，并残留两个 AbortController（取消时只 abort 后一个）。
    if (controllers.has(id)) continue;
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
