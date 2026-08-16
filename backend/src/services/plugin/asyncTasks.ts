// ==================== 通用异步任务注册表 ====================
//
// 目的:把「HTTP 同步等待到任务完成」的入口(URL 歌单导入 / 平台搜索加入库 / 手动同步)
// 改为「触发即返回 taskId + 前端轮询状态」——任务在后台跑,HTTP 不长时间挂起。
// 与 jobRunner(插件级任务)互补:这里服务核心业务任务(不绑插件),同一套轮询心智。
//
// 契约:
//   - startAsyncTask(kind, key, fn):key 给出去重键(同 kind+key 在跑则 alreadyRunning);
//     fn 可写 state.progress 汇报进度;返回结果存入 state.result。
//   - getAsyncTask(id):查状态;任务完成/失败后仍可查(不清理,重启即清零)。
//   - GET /v1/tasks/:id 暴露给前端轮询(见 api/index.ts)。

export type AsyncTaskKind = "playlist-import" | "playlist-search-import" | "playlist-sync";

export interface AsyncTaskState {
  id: string;
  kind: AsyncTaskKind;
  status: "running" | "ok" | "error";
  key?: string;
  startedAt: string;
  finishedAt?: string;
  progress?: { current: number; total: number; label: string };
  result?: any;
  error?: string;
}

const tasks = new Map<string, AsyncTaskState>();
const runningKeys = new Map<string, string>(); // `${kind}:${key}` -> taskId

/** 启动一个异步任务。返回 { started:true, taskId } 或 { started:false, alreadyRunning:true, taskId }。 */
export function startAsyncTask<T>(
  kind: AsyncTaskKind,
  key: string | undefined,
  fn: (state: AsyncTaskState) => Promise<T>,
): { started: boolean; taskId?: string; alreadyRunning?: boolean } {
  const rk = key ? `${kind}:${key}` : null;
  if (rk && runningKeys.has(rk)) {
    return { started: false, alreadyRunning: true, taskId: runningKeys.get(rk) };
  }
  const id = `t-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  const state: AsyncTaskState = { id, kind, key, status: "running", startedAt: new Date().toISOString() };
  tasks.set(id, state);
  if (rk) runningKeys.set(rk, id);
  (async () => {
    try {
      const result = await fn(state);
      Object.assign(state, { status: "ok", result, finishedAt: new Date().toISOString() });
    } catch (e: any) {
      Object.assign(state, {
        status: "error",
        error: String((e && e.message) || e),
        finishedAt: new Date().toISOString(),
      });
    } finally {
      if (rk) runningKeys.delete(rk);
    }
  })();
  return { started: true, taskId: id };
}

/** 查询任务状态;不存在返回 null。 */
export function getAsyncTask(id: string): AsyncTaskState | null {
  return tasks.get(id) ?? null;
}

/** 是否有异步任务正在运行(供 GET /v1/system/busy 聚合)。 */
export function anyTaskRunning(): boolean {
  for (const t of tasks.values()) if (t.status === "running") return true;
  return false;
}
