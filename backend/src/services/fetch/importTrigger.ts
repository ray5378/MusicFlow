// ==================== 网络歌曲「入库即入队」下载触发器 ====================
//
// 产品定调 2026-10-11（最根本的一条需求）：**任何**入库的网络歌曲（平台歌曲）——
// 不论来自插件歌单导入、单曲导入、每日推荐同步、跨源匹配还是发现页——都必须自动过
// 一轮下载流程。上游由 `services/source/online/importTriggerHook.ts` 广播，本模块实现。
//
// 「一轮下载流程」**直接复用全库平台音乐下载那条已验证的链路**：
//   buildLibraryPlan({ songIds }) → buildLibraryTargets → buildLibraryJobConfig
// 于是天然继承三个已实现、已测试的行为：
//   1. 目标按「歌名 + 歌手」走多源搜索取链（与全库下载同一套取链 / 质量预探 / 质量闸，
//      含「只取最高音质、不降级」）；
//   2. 落盘后把原 `web:` 行**迁移**成指向本地文件的行（`__library.migrateRowOnly`）——
//      歌单 / 收藏引用的是行 id，不迁移就会留下两条重复行、歌单指向空壳；
//   3. 「本地 / WebDAV 已有实体文件」「时长不匹配」的曲目由既有闸自动挡住
//      （existing.ts 的 skipIfInLibrary + 质量探针的时长容差）——**此处不做任何预筛**，
//      避免在下载链路之外再造一套口径（两套口径 = 必然漂移）。
//
// 唯一的前置判定是**下载总开关** `fetch.enabled`：关闭时导入照常、不下载。
//
// `__library.noAutoContinue`：这批的语义是「把刚入库的歌下完」，不是「开始全库下载」——
// 不带这个标记的话，任务终态后 jobRunner 会顺手开「全库自动续批」，把范围放大成全库。
import { createLogger } from "../../utils/logger.js";
import { setImportedSongsListener } from "../source/online/importTriggerHook.js";
import { currentFetchConfig } from "./configStore.js";
import { buildLibraryJobConfig, buildLibraryPlan, buildLibraryTargets } from "./library.js";
import { createFetchJob } from "./jobStore.js";
import { startFetchJob } from "./jobRunner.js";

const log = createLogger("FETCH-IMPORT");

/** 触发结果（供测试断言与日志；生产不必消费）。 */
export interface ImportTriggerResult {
  /** 实际入队的曲目数（已是 0 时说明全部无需下载）。 */
  enqueued: number;
  jobId?: string;
  /** 未入队的原因。 */
  reason?: "empty" | "disabled" | "nothing-to-do";
}

/**
 * 把「本轮新入库的网络歌曲」送入一轮下载流程。
 *
 * 幂等与去重：`songIds` 去重后**点名**交给计划器；`buildLibraryPlan` 的点名路径会绕开
 * 冷却（重试语义），因此重复导入同一首歌不会因为「上次刚试过」而被静默跳过。
 * 本函数**不抛错**（内部兜底）；调用方（钩子）另有兜底。
 */
export function triggerFetchForImportedSongs(songIds: string[]): ImportTriggerResult {
  try {
    const ids = [...new Set((songIds ?? []).map((v) => String(v ?? "").trim()).filter((v) => v.length > 0))];
    if (ids.length === 0) return { enqueued: 0, reason: "empty" };

    const cfg = currentFetchConfig();
    if (!cfg.enabled) {
      log.info("下载总开关关闭：本轮入库的网络歌曲不自动下载", { count: ids.length });
      return { enqueued: 0, reason: "disabled" };
    }

    const plan = buildLibraryPlan(cfg, { songIds: ids, limit: ids.length });
    if (plan.items.length === 0) {
      // 全部「本地 / WebDAV 已有实体文件」（行已迁移成本地行）→ 无需下载。
      log.info("本轮入库曲目无需下载（本地/WebDAV 已有实体文件）", { count: ids.length });
      return { enqueued: 0, reason: "nothing-to-do" };
    }

    const job = createFetchJob({
      kind: "import",
      targets: { targets: buildLibraryTargets(plan.items) },
      config: buildLibraryJobConfig(cfg, { noAutoContinue: true }),
    });
    startFetchJob(job.id);
    log.info(`入库触发下载：${plan.items.length} 首入队（job=${job.id}）`);
    return { enqueued: plan.items.length, jobId: job.id };
  } catch (e: unknown) {
    log.error("入库触发下载失败（导入本身不受影响）", {
      count: Array.isArray(songIds) ? songIds.length : 0,
      err: e instanceof Error ? e.message : String(e),
    });
    return { enqueued: 0, reason: "nothing-to-do" };
  }
}

/**
 * 启动时调用一次：把本触发器挂到「网络歌曲入库」事件上。
 * 挂载点由 `src/index.ts` 负责（并有启动日志）；CI 守卫 `check-import-trigger.mjs` 钉死。
 */
export function registerFetchImportTrigger(): void {
  setImportedSongsListener((songIds, ctx) => {
    try {
      triggerFetchForImportedSongs(songIds);
    } catch (e: unknown) {
      log.error("入库触发下载异常（忽略）", {
        providerId: ctx?.providerId ?? "",
        count: songIds.length,
        err: e instanceof Error ? e.message : String(e),
      });
    }
  });
  log.info("已挂载：网络歌曲入库 → 自动走一轮下载流程");
}
