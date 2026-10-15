import api from "@/api";
import { gt } from "@/locales";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * 分批并发执行:把 N 个同类异步操作按「每批 batch 个」并发跑(批内 Promise.all、批间串行)。
 * 用于把原先「逐条 await」的批量操作(批量加歌 / 批量移歌 / 逐首在线匹配 / 逐专辑取曲目)
 * 从 N 个 RTT 压成 ceil(N/batch) 个,同时避免一次性把后端连接打满。
 * 语义与串行版本一致:批内任一失败即抛出并中止后续批次(调用方 try/catch 不变)。
 * fn 收到全局下标 index,便于调用方按下标回填结果数组以保留原有顺序。
 */
export async function runBatched<T>(
  items: readonly T[],
  fn: (item: T, index: number) => Promise<unknown>,
  batch = 6,
): Promise<void> {
  for (let i = 0; i < items.length; i += batch) {
    await Promise.all(items.slice(i, i + batch).map((item, k) => fn(item, i + k)));
  }
}

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
