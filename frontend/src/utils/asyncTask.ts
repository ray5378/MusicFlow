import api from "@/api";
import { gt } from "@/locales";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * 轮询异步任务直到完成,返回任务 result。
 * 后端「长耗时操作」(URL 导入 / 平台搜索加入库 / 手动同步)已改为触发即返回 taskId,
 * 前端用本函数轮询 GET /v1/tasks/:id,避免长时间挂着一个 await 请求造成假死感。
 */
export async function waitAsyncTask(
  taskId: string,
  opts?: { intervalMs?: number; timeoutMs?: number },
): Promise<any> {
  const interval = opts?.intervalMs ?? 1000;
  const timeout = opts?.timeoutMs ?? 600000;
  const t0 = Date.now();
  for (;;) {
    const res = await api.get(`/rest/api/v1/tasks/${taskId}`).catch(() => null);
    const task = res?.data?.task;
    if (task?.status === "ok") return task.result;
    if (task?.status === "error") throw new Error(task.error || gt("task.failed"));
    if (Date.now() - t0 > timeout) throw new Error(gt("task.timeout"));
    await sleep(interval);
  }
}
