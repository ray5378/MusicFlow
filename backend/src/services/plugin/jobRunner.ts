// ==================== 插件任务执行器(异步任务通道) ====================
//
// 解决「刷新平台歌单等批量任务被 HTTP 请求 + 沙箱 15s 双卡死」:
//   - 触发即返回(HTTP 不阻塞),任务在后台跑——沙箱 invoke 使用 manifest.longRunning
//     声明的方法级长预算(上限 5 分钟),不再被 15s 看门狗强杀;
//   - per-plugin 串行锁:同插件同时只跑一个任务,手动刷新 / 每日调度 / 6h 维护
//     同时触发时不会撞车重复全量;
//   - 实际执行在一次性批量子进程里(方案3,runBatchJob):子进程调插件 impl[method],
//     全局批量闸由 runBatchJob 持有(FIFO,同一时刻只跑 1 个批量任务);
//   - 记录最近一次结果(状态/摘要/错误含 sandboxCode/hint),供
//     GET /v1/plugins/:id/job 状态端点查询(前端轮询展示)。
//
// 只做「调度与状态」,不复制任何插件业务逻辑;错误捕获后绝不向外抛。

import { getPlugin } from "../../plugins/registry.js";
import { runBatchJob } from "../../batch/runner.js";
import { createLogger } from "../../utils/logger.js";

const log = createLogger("PLUGIN-JOB");

export interface PluginJobState {
  running: boolean;
  status: "running" | "ok" | "error";
  summary?: string;
  error?: string;
  sandboxCode?: string; // 沙箱限制错误码(SANDBOX_TIMEOUT / SANDBOX_PERMISSION / ...)
  hint?: string;        // 修复提示(可行动文案)
  startedAt?: string;
  finishedAt?: string;
}

const running = new Map<string, boolean>();
const states = new Map<string, PluginJobState>();

// 实际执行器:默认 fork 一次性批量子进程(方案3);测试可注入进程内直调,避免真实 fork。
type JobExecFn = (pluginId: string, method: string, opts: any) => Promise<any>;
let execJob: JobExecFn = (pluginId, method, opts) =>
  runBatchJob("plugin-job", { pluginId, method, opts: opts || {} }).then(r => r.result);

/** 测试钩子:替换插件任务的执行实现(注入进程内直调 / 假 runner)。 */
export function _setPluginJobExecForTest(fn: JobExecFn | null): void {
  execJob = fn ?? ((pluginId, method, opts) =>
    runBatchJob("plugin-job", { pluginId, method, opts: opts || {} }).then(r => r.result));
}

/** 查询插件最近一次任务状态;无记录返回 null。 */
export function getPluginJobState(pluginId: string): PluginJobState | null {
  return states.get(pluginId) ?? null;
}

/** 是否有插件任务正在运行(供 GET /v1/system/busy 聚合)。 */
export function anyJobRunning(): boolean {
  for (const v of running.values()) if (v) return true;
  return false;
}

/** 启动一个插件任务(异步,fire-and-forget)。
 *  @returns { started:true } 已启动;{ alreadyRunning:true } 同插件任务在跑,本次未叠加;
 *           { started:false, alreadyRunning:false } 插件不存在/未实现该方法。 */
export function runPluginJob(
  pluginId: string,
  method: "runDailyJob" | "runSyncJob",
  opts?: { force?: boolean; keywordOnly?: boolean },
): { started: boolean; alreadyRunning: boolean } {
  const reg = getPlugin(pluginId);
  if (!reg || typeof reg.impl?.[method] !== "function") return { started: false, alreadyRunning: false };
  if (running.get(pluginId)) return { started: false, alreadyRunning: true };
  running.set(pluginId, true);
  const state: PluginJobState = { running: true, status: "running", startedAt: new Date().toISOString() };
  states.set(pluginId, state);
  (async () => {
    // 实际执行在一次性批量子进程里(方案3):子进程内调插件 impl[method]。
    // 全局批量闸由 runBatchJob 持有(FIFO),这里不再重复取锁。
    try {
      const summary = await execJob(pluginId, method, opts || {});
      Object.assign(state, { running: false, status: "ok", summary, finishedAt: new Date().toISOString() });
    } catch (e: any) {
      Object.assign(state, {
        running: false,
        status: "error",
        error: String((e && e.message) || e),
        sandboxCode: e?.sandboxCode,
        hint: e?.hint,
        finishedAt: new Date().toISOString(),
      });
      log.error("插件任务执行失败", { pluginId, method, err: e?.message || e });
    } finally {
      running.set(pluginId, false);
    }
  })();
  return { started: true, alreadyRunning: false };
}
