// 自动生成 —— 由 index.ts 物理拆分而来（tasks 域，2 条路由）。零逻辑改动。
import type { Hono } from "hono";
import {
  BusinessErrorCode,
  anyJobRunning,
  anyTaskRunning,
  apiError,
  getAsyncTask,
  isBatchBusy,
} from "./shared.js";

export function registerTasks(app: Hono): void {
app.get("/v1/tasks/:taskId", (c) => {
  const state = getAsyncTask(c.req.param("taskId")!);
  if (!state) return c.json(apiError(BusinessErrorCode.NOT_FOUND, "errors.task.notFound"), 404);
  return c.json({ success: true, task: state });
});

// 全局 busy 状态(前端横幅提示):批量闸被持有(每日推荐/自动匹配/插件每日任务)或
// 异步任务/插件任务在跑 → busy=true。前端据此显示「后台任务运行中」而非假死。

app.get("/v1/system/busy", (c) => {
  const batch = isBatchBusy();
  const tasks = anyTaskRunning();
  const jobs = anyJobRunning();
  return c.json({ success: true, busy: batch || tasks || jobs, detail: { batch, tasks, jobs } });
});

// ==================== Playlist settings (rename / public toggle / auto-sync toggle) ====================
}
