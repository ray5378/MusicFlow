// asyncTasks FIFO 上限测试:验证「只保留最近 N 条已完成/失败任务」,
// running 任务不受限,防止长期运行 tasks Map 无界膨胀。
import { describe, it, expect, beforeEach } from "vitest";
import { startAsyncTask, getAsyncTask, anyTaskRunning, _resetAsyncTasksForTest, _setBatchRunnerForTest } from "../../src/services/plugin/asyncTasks.js";

const KEEP_MAX = 50;

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

describe("asyncTasks FIFO 上限", () => {
  // tasks 是模块级单例,且 vitest 配置了 sequence.shuffle(用例顺序随机),
  // 每个用例前清空状态,避免用例间相互污染。
  beforeEach(() => {
    _resetAsyncTasksForTest();
    // 注入假批量子进程 runner(默认实现会真实 fork 子进程,测试环境不 fork)。
  });

  it(`连续启动超过 ${KEEP_MAX} 个任务并全部完成后,只保留最近 ${KEEP_MAX} 条`, async () => {
    _setBatchRunnerForTest(async () => ({ result: { n: 1 } }));
    const ids: string[] = [];
    for (let i = 0; i < KEEP_MAX + 10; i++) {
      const r = startAsyncTask("playlist-import", `fifo-${i}`, { kind: "playlist-import", args: {} });
      expect(r.started).toBe(true);
      expect(r.taskId).toBeTruthy();
      ids.push(r.taskId!);
    }
    // 等待全部任务结束(finally 里做修剪)
    for (let i = 0; i < 100 && anyTaskRunning(); i++) await sleep(10);
    await sleep(30);

    // 最新的 KEEP_MAX 条可查
    for (let i = 10; i < KEEP_MAX + 10; i++) {
      expect(getAsyncTask(ids[i]), `task ${i} 应保留`).not.toBeNull();
    }
    // 最老的 10 条已被修剪
    for (let i = 0; i < 10; i++) {
      expect(getAsyncTask(ids[i]), `task ${i} 应被修剪`).toBeNull();
    }
  });

  it("running 任务不受上限影响(永不修剪)", () => {
    // 假 runner 永不 resolve → 任务保持 running。
    _setBatchRunnerForTest(() => new Promise(() => {}));
    const ids: string[] = [];
    for (let i = 0; i < KEEP_MAX + 10; i++) {
      const r = startAsyncTask("playlist-import", `running-${i}`, { kind: "playlist-import", args: {} });
      ids.push(r.taskId!);
    }
    // 全部仍在 running → 全部可查
    for (const id of ids) expect(getAsyncTask(id)).not.toBeNull();
  });

  it("runner 拒绝 → 任务标记 error 并保留错误信息", async () => {
    _setBatchRunnerForTest(async () => { throw new Error("子进程失败"); });
    const r = startAsyncTask("playlist-import", "err-1", { kind: "playlist-import", args: {} });
    for (let i = 0; i < 100 && getAsyncTask(r.taskId!)?.status === "running"; i++) await sleep(10);
    const state = getAsyncTask(r.taskId!)!;
    expect(state.status).toBe("error");
    expect(state.error).toBe("子进程失败");
  });
});
