// ==================== 测试用「进程内批量执行器」 ====================
// 批量任务默认 fork 一次性子进程执行;但路由测试的假插件只注册在本进程内存注册表,
// 子进程看不到。此助手把 asyncTasks / jobRunner 的批量执行切换为进程内直调
// (直接执行 batch/jobs.ts 的处理器,与生产共用同一份 handler 代码)。
import { _setBatchRunnerForTest } from "../../src/services/plugin/asyncTasks.js";
import { _setPluginJobExecForTest } from "../../src/services/plugin/jobRunner.js";
import { batchJobHandlers } from "../../src/batch/jobs.js";
import { getPlugin } from "../../src/plugins/registry.js";

export function installInProcessBatchRunner(): void {
  _setBatchRunnerForTest(async (kind, args, opts) => {
    const handler = batchJobHandlers[kind as keyof typeof batchJobHandlers];
    const result = await handler(args, {
      onProgress: opts?.onProgress,
      signal: new AbortController().signal,
    });
    return { result };
  });
  _setPluginJobExecForTest(async (pluginId, method, opts) => {
    const reg = getPlugin(pluginId);
    return reg?.impl?.[method]?.(opts);
  });
}