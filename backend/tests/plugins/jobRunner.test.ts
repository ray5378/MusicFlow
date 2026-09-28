// ==================== services/plugin/jobRunner 长尾 ====================
// 既有测试只覆盖 asyncTasks;jobRunner 是「插件任务执行器」的调度+状态机:
//   - 插件不存在 / 未实现方法 → 不启动;
//   - 同插件并发 → alreadyRunning,不叠加;
//   - 执行抛错 → 状态置 error 并透传 sandboxCode/hint(绝不外抛);
//   - _setPluginJobExecForTest(null) 恢复的「默认执行器」真的调用 runBatchJob。
// 默认执行器会 fork 子进程,这里把 batch/runner.js 整体换成桩。
import "./_env.js";

import { describe, it, expect, afterEach, vi } from "vitest";

const h = vi.hoisted(() => ({
  runBatchJob: vi.fn(async (kind: string, args: any) => ({ result: { kind, args }, childRss: 0 })),
}));

vi.mock("../../src/batch/runner.js", () => ({
  runBatchJob: h.runBatchJob,
}));

import { registerPlugin, unregisterPlugin } from "../../src/plugins/registry.js";
import {
  runPluginJob,
  getPluginJobState,
  anyJobRunning,
  _setPluginJobExecForTest,
} from "../../src/services/plugin/jobRunner.js";

const U = Math.random().toString(36).slice(2, 8);
const pid = (s: string) => `lt4job-${s}-${U}`;
const manifest = (id: string) => ({
  id, name: id, version: "1.0.0", type: "recommender", capabilities: ["dailyPlaylist"],
} as any);

async function waitSettled(id: string, ms = 2000) {
  const t = Date.now();
  for (;;) {
    const s = getPluginJobState(id);
    if (s && !s.running) return s;
    if (Date.now() - t > ms) throw new Error(`job ${id} 未收敛`);
    await new Promise((r) => setTimeout(r, 5));
  }
}

afterEach(() => {
  // 恢复默认执行器;顺带覆盖 _setPluginJobExecForTest(null) 的 null 分支。
  _setPluginJobExecForTest(null);
  h.runBatchJob.mockClear();
});

describe("runPluginJob 守卫", () => {
  it("插件不存在 → started:false,不建状态", () => {
    expect(runPluginJob(pid("nope"), "runDailyJob")).toEqual({ started: false, alreadyRunning: false });
    expect(getPluginJobState(pid("nope"))).toBeNull();
  });

  it("插件存在但未实现该方法 → started:false", () => {
    const id = pid("nomethod");
    registerPlugin(manifest(id), {});
    try {
      expect(runPluginJob(id, "runDailyJob")).toEqual({ started: false, alreadyRunning: false });
    } finally {
      unregisterPlugin(id);
    }
  });
});

describe("runPluginJob 并发与状态机", () => {
  it("同插件并发触发 → 第二次 alreadyRunning,不叠加执行", async () => {
    const id = pid("concurrent");
    registerPlugin(manifest(id), { runDailyJob: async () => "ok" });
    let release!: (v: any) => void;
    _setPluginJobExecForTest(() => new Promise((r) => { release = r; }));
    try {
      expect(runPluginJob(id, "runDailyJob")).toEqual({ started: true, alreadyRunning: false });
      expect(runPluginJob(id, "runDailyJob")).toEqual({ started: false, alreadyRunning: true });
      expect(anyJobRunning()).toBe(true);
      release("done");
      const s = await waitSettled(id);
      expect(s.status).toBe("ok");
      expect(s.summary).toBe("done");
      expect(anyJobRunning()).toBe(false);
    } finally {
      unregisterPlugin(id);
    }
  });

  it("执行抛错 → status=error 且透传 sandboxCode/hint,不外抛", async () => {
    const id = pid("failing");
    registerPlugin(manifest(id), { runDailyJob: async () => "ok" });
    _setPluginJobExecForTest(async () => {
      const e: any = new Error("沙箱超时");
      e.sandboxCode = "SANDBOX_TIMEOUT";
      e.hint = "减少歌单规模";
      throw e;
    });
    try {
      expect(runPluginJob(id, "runDailyJob").started).toBe(true);
      const s = await waitSettled(id);
      expect(s.status).toBe("error");
      expect(s.error).toBe("沙箱超时");
      expect(s.sandboxCode).toBe("SANDBOX_TIMEOUT");
      expect(s.hint).toBe("减少歌单规模");
      expect(s.running).toBe(false);
    } finally {
      unregisterPlugin(id);
    }
  });

  it("默认执行器(恢复 null 后)把 pluginId/method/opts 透传给 runBatchJob", async () => {
    // 为什么:这是「任务真正跑在一次性批量子进程里」的唯一落点,传参错会跑错插件。
    const id = pid("default");
    registerPlugin(manifest(id), { runSyncJob: async () => "ok" });
    _setPluginJobExecForTest(null); // 不用注入的假体 → 走真实默认实现(mock 掉 runBatchJob)
    try {
      expect(runPluginJob(id, "runSyncJob", { force: true }).started).toBe(true);
      const s = await waitSettled(id);
      expect(s.status).toBe("ok");
      expect(h.runBatchJob).toHaveBeenCalledWith("plugin-job", {
        pluginId: id, method: "runSyncJob", opts: { force: true },
      });
    } finally {
      unregisterPlugin(id);
    }
  });
});
