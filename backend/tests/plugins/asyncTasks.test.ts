// asyncTasks FIFO 上限测试:验证「只保留最近 N 条已完成/失败任务」,
// running 任务不受限,防止长期运行 tasks Map 无界膨胀。
import { describe, it, expect, beforeEach } from "vitest";
import { startAsyncTask, getAsyncTask, anyTaskRunning, _resetAsyncTasksForTest } from "../../src/services/plugin/asyncTasks.js";

const KEEP_MAX = 50;

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

describe("asyncTasks FIFO 上限", () => {
  // tasks 是模块级单例,且 vitest 配置了 sequence.shuffle(用例顺序随机),
  // 每个用例前清空状态,避免用例间相互污染。
  beforeEach(() => {
    _resetAsyncTasksForTest();
  });

  it(`连续启动超过 ${KEEP_MAX} 个任务并全部完成后,只保留最近 ${KEEP_MAX} 条`, async () => {
    const ids: string[] = [];
    for (let i = 0; i < KEEP_MAX + 10; i++) {
      const r = startAsyncTask("playlist-import", `fifo-${i}`, async () => ({ n: i }));
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
    const ids: string[] = [];
    for (let i = 0; i < KEEP_MAX + 10; i++) {
      const r = startAsyncTask("playlist-import", `running-${i}`, () => new Promise(() => {}));
      ids.push(r.taskId!);
    }
    // 全部仍在 running → 全部可查
    for (const id of ids) expect(getAsyncTask(id)).not.toBeNull();
  });
});
