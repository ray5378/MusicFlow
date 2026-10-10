// ==================== 网络歌曲「入库即入队」下载触发器（含活跃间隔防抖） ====================
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
//
// ---------------------------------------------------------------------------
// 活跃间隔防抖（产品定调 2026-10-11 第二轮）
// ---------------------------------------------------------------------------
// 为什么需要：一次**大歌单导入**会分多批调用 `importOnlineSongs`（每批 TX_CHUNK 首），
// 于是每批都在返回前广播一次「本轮新入库」。若每次广播都立刻建下载任务，一次导入会炸出
// **一串「每批几首」的碎任务**：取链/预探配额被摊薄、任务列表被刷屏、单站限速互相排队。
//
// 所以这里把「触发」改成**活跃间隔防抖**（trailing debounce）：
//   1. 每次入库广播 → 把 songIds **并入**待处理集合（`Set` 去重）；
//   2. 该集合**持久化**到 settings（`fetch.import.pending`）——进程重启不丢，
//      启动时 `registerFetchImportTrigger` 会把它捡回来继续计时；
//   3. 每次广播都**重置**计时器为 `IMPORT_TRIGGER_IDLE_MS`（5 分钟）；
//   4. 距**最后一次**入库满 5 分钟（= 这轮导入已结束）才真正建**一个**任务，
//      目标为累计并集。
//
// 为什么是「距最后一次」而不是「首批后固定等待」：导入结束时间未知，只有「静默 5 分钟」
// 才能等价于「导入结束了」。持续有新歌入库时计时器不断被推后（这正是「大歌单还在导」），
// 一旦安静下来 5 分钟就立刻下发。
//
// 为什么 5 分钟：既要盖住大歌单的分批间隔（批间通常秒级，5 分钟余量充足），又不能
// 让「导入一两首歌」的用户等太久（单首导入的用户感知延迟上限就是这 5 分钟）。
import { createLogger } from "../../utils/logger.js";
import { getSetting, setSetting } from "../settings.js";
import { setImportedSongsListener } from "../source/online/importTriggerHook.js";
import { currentFetchConfig } from "./configStore.js";
import { buildLibraryJobConfig, buildLibraryPlan, buildLibraryTargets } from "./library.js";
import { createFetchJob } from "./jobStore.js";
import { startFetchJob } from "./jobRunner.js";

const log = createLogger("FETCH-IMPORT");

/**
 * 「入库活跃间隔」（毫秒）：距**最后一次**入库广播满这么久（= 导入已结束）才真正下发任务。
 * 5 分钟 —— 见文件头「活跃间隔防抖」。
 */
export const IMPORT_TRIGGER_IDLE_MS = 5 * 60_000;

/** 待下载集合的持久化键（settings 表，值为 JSON 字符串数组）。 */
const PENDING_KEY = "fetch.import.pending";

/** 触发结果（供测试断言与日志；生产不必消费）。 */
export interface ImportTriggerResult {
  /** 实际入队的曲目数（已是 0 时说明全部无需下载）。 */
  enqueued: number;
  jobId?: string;
  /** 未入队的原因。 */
  reason?: "empty" | "disabled" | "nothing-to-do";
}

/** 去重 + 去空白 + 去空串。 */
function normalizeIds(songIds: string[] | undefined): string[] {
  return [...new Set((songIds ?? []).map((v) => String(v ?? "").trim()).filter((v) => v.length > 0))];
}

// 待处理集合与计时器都是模块级单例（进程内只有一份）。
let pending: Set<string> | null = null;
let idleTimer: ReturnType<typeof setTimeout> | null = null;

/** 惰性加载待处理集合（首次从 settings 恢复）。 */
function loadPending(): Set<string> {
  if (pending) return pending;
  try {
    const raw = getSetting(PENDING_KEY, "[]");
    const arr: unknown = JSON.parse(raw);
    pending = new Set(Array.isArray(arr) ? arr.map((v) => String(v)) : []);
  } catch {
    // 脏数据（被手改过 / 半截写入）→ 当作空集合，绝不因它抛错影响导入。
    pending = new Set();
  }
  return pending;
}

/** 落库（失败只记日志：内存集合仍然正确，最坏是重启后少恢复一批）。 */
function savePending(): void {
  try {
    setSetting(PENDING_KEY, JSON.stringify([...loadPending()]));
  } catch (e: unknown) {
    log.warn("待下载集合落库失败（内存仍保留）", {
      err: e instanceof Error ? e.message : String(e),
    });
  }
}

/** 重置活跃间隔计时器（从「现在」起算 IDLE_MS 后 flush）。 */
function armIdleTimer(): void {
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = setTimeout(() => {
    idleTimer = null;
    flushImportedSongs();
  }, IMPORT_TRIGGER_IDLE_MS);
  // 别让一个待触发计时器拖住进程退出（Node Timeout 才有 unref；假计时器可能没有）。
  const t = idleTimer as unknown as { unref?: () => void };
  if (typeof t.unref === "function") t.unref();
}

/**
 * 收到「本轮新入库」广播：并入待处理集合并**重置**活跃间隔计时器。
 * 本函数**不建任务**——真正的下发在 `flushImportedSongs`（由计时器到期触发）。
 * 返回并入后的待处理总数（便于日志/测试）。
 */
export function enqueueImportedSongs(songIds: string[]): number {
  const ids = normalizeIds(songIds);
  if (ids.length === 0) return loadPending().size;
  const p = loadPending();
  let added = 0;
  for (const id of ids) {
    if (!p.has(id)) {
      p.add(id);
      added++;
    }
  }
  if (added > 0) savePending();
  // 只要还有待下载项就（重新）计时：本次广播本身就是「导入仍在继续」的证据。
  if (p.size > 0) armIdleTimer();
  return p.size;
}

/**
 * 把累计的「待下载并集」真正送入一轮下载（活跃间隔到期时自动调用；也供测试与运维直接调用）。
 * 清空并集 → 走全库下载同一条链路（点名 songIds + kind=import + noAutoContinue）。
 */
export function flushImportedSongs(): ImportTriggerResult {
  if (idleTimer) {
    clearTimeout(idleTimer);
    idleTimer = null;
  }
  const p = loadPending();
  if (p.size === 0) return { enqueued: 0, reason: "empty" };
  const ids = [...p];
  p.clear();
  savePending();
  const r = triggerFetchForImportedSongs(ids);
  log.info(
    `活跃间隔已满（${IMPORT_TRIGGER_IDLE_MS / 60_000} 分钟）：累计 ${ids.length} 首入库歌下发${r.jobId ? `（job=${r.jobId}）` : ""}`,
  );
  return r;
}

/**
 * 把一批网络歌送入一轮下载流程。
 *
 * 幂等与去重：`songIds` 去重后**点名**交给计划器；`buildLibraryPlan` 的点名路径会绕开
 * 冷却（重试语义），因此重复导入同一首歌不会因为「上次刚试过」而被静默跳过。
 * 本函数**不抛错**（内部兜底）；调用方（钩子）另有兜底。
 */
export function triggerFetchForImportedSongs(songIds: string[]): ImportTriggerResult {
  try {
    const ids = normalizeIds(songIds);
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
      enqueueImportedSongs(songIds);
    } catch (e: unknown) {
      // 与 triggerFetchForImportedSongs 内层兜底同理：钩子异常绝不影响导入本身。
      log.error("入库触发下载异常（忽略）", {
        providerId: ctx?.providerId ?? "",
        count: songIds.length,
        err: e instanceof Error ? e.message : String(e),
      });
    }
  });
  // 重启恢复：上次进程退出时还没满活跃间隔的待处理集合，捡回来继续计时。
  const p = loadPending();
  if (p.size > 0) {
    log.info(`重启恢复：${p.size} 首待下载歌继续等待活跃间隔`);
    armIdleTimer();
  }
  log.info(
    `已挂载：网络歌曲入库 → 累积待下载，距最后一次入库满 ${IMPORT_TRIGGER_IDLE_MS / 60_000} 分钟自动走一轮下载流程`,
  );
}

/** Test-only：清掉内存里的待处理集合与计时器（避免用例间顺序耦合）。 */
export function _resetImportTriggerForTest(): void {
  if (idleTimer) {
    clearTimeout(idleTimer);
    idleTimer = null;
  }
  pending = null;
}
