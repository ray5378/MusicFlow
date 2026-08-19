// ==================== batch runner 专项测试 ====================
// 覆盖运行器的 IPC 编排(ready → run → progress → result)、错误透传
// (sandboxCode/hint)、子进程崩溃、abort 转发与全局批量闸串行。用假子进程注入,
// 不真实 fork(真实 fork 会在子进程里做完整 bootstrap,测试环境不可控)。

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "events";
import {
  runBatchJob, _setForkImplForTest, anyBatchChildRunning,
} from "../../src/batch/runner.js";
import { _resetPacerForTest, isBatchBusy } from "../../src/services/plugin/batchPacer.js";

type FakeScript = (msg: any, fake: FakeChild) => void;

class FakeChild extends EventEmitter {
  connected = true;
  killed = false;
  pid = 12345;
  sent: any[] = [];
  private script: FakeScript;

  constructor(script: FakeScript) {
    super();
    this.script = script;
  }

  send(msg: any): boolean {
    this.sent.push(msg);
    this.script(msg, this);
    return true;
  }

  kill(signal?: NodeJS.Signals | number): boolean {
    this.killed = true;
    return true;
  }
}

function tick(ms = 5): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function installFake(onRun: (msg: any, fake: FakeChild) => void): FakeChild {
  const fake = new FakeChild((msg, f) => {
    if (msg.type === "run") onRun(msg, f);
  });
  // 模拟子进程启动后立即上报 ready(父进程收到后才发 run)。
  setImmediate(() => fake.emit("message", { type: "ready", pid: fake.pid }));
  _setForkImplForTest((() => fake) as any);
  return fake;
}

describe("batch runner", () => {
  beforeEach(() => {
    _resetPacerForTest();
  });
  afterEach(() => {
    _setForkImplForTest(null as any);
  });

  it("ready → run → progress → result 完整链路,结果回传", async () => {
    const fake = installFake((msg, f) => {
      setTimeout(() => {
        f.emit("message", { type: "progress", jobId: msg.jobId, payload: { done: 1, total: 2 } });
        f.emit("message", { type: "result", jobId: msg.jobId, result: { ok: true }, rss: 42 });
      }, 0);
    });
    const progresses: any[] = [];
    const res = await runBatchJob("purge-web-songs", { providerId: "x" }, { onProgress: (p) => progresses.push(p) });

    expect(fake.sent.some(m => m.type === "pace")).toBe(true);
    const runMsg = fake.sent.find(m => m.type === "run");
    expect(runMsg).toMatchObject({ kind: "purge-web-songs", args: { providerId: "x" } });
    expect(progresses).toEqual([{ done: 1, total: 2 }]);
    expect(res).toEqual({ result: { ok: true }, childRss: 42, aborted: false });
    // 收尾后释放全局批量闸、无子进程在跑。
    expect(isBatchBusy()).toBe(false);
    expect(anyBatchChildRunning()).toBe(false);
  });

  it("子进程 error 消息 → 拒绝并透传 sandboxCode/hint", async () => {
    installFake((msg, f) => {
      setTimeout(() => {
        f.emit("message", {
          type: "error", jobId: msg.jobId, error: "沙箱超时",
          sandboxCode: "SANDBOX_TIMEOUT", hint: "减少歌单规模",
        });
      }, 0);
    });
    await expect(runBatchJob("plugin-job", { pluginId: "p", method: "runDailyJob" }))
      .rejects.toMatchObject({ message: "沙箱超时", sandboxCode: "SANDBOX_TIMEOUT", hint: "减少歌单规模" });
  });

  it("子进程崩溃(无 result/error 直接 exit)→ 拒绝并报异常退出", async () => {
    installFake((msg, f) => {
      setTimeout(() => f.emit("exit", 1, "SIGTERM"), 0);
    });
    await expect(runBatchJob("scan", { sourceId: "s" })).rejects.toThrow(/异常退出/);
  });

  it("abort 转发:父信号触发 → 发 abort 给子进程;子进程优雅停止 → aborted=true", async () => {
    let runJobId = "";
    const fake = installFake((msg) => {
      if (msg.type === "run") runJobId = msg.jobId;
    });
    const ac = new AbortController();
    const p = runBatchJob("scan", { sourceId: "s" }, { signal: ac.signal });
    for (let i = 0; i < 100 && !runJobId; i++) await tick();
    expect(runJobId).toBeTruthy();

    ac.abort();
    await tick();
    expect(fake.sent.some(m => m.type === "abort" && m.jobId === runJobId)).toBe(true);

    // 模拟子进程收到 abort 后扫描提前返回并正常报结果。
    fake.emit("message", { type: "result", jobId: runJobId, result: { partial: true }, rss: 1 });
    const res = await p;
    expect(res.aborted).toBe(true);
    expect(res.result).toEqual({ partial: true });
  });

  it("信号已在启动前 aborted → 立即发 abort 消息", async () => {
    const fake = installFake(() => { /* 不自动回复 */ });
    const ac = new AbortController();
    ac.abort();
    const p = runBatchJob("scan", { sourceId: "s" }, { signal: ac.signal });
    await tick();
    expect(fake.sent.some(m => m.type === "abort")).toBe(true);
    // 子进程随后正常结束,Promise 才 settle。
    fake.emit("message", { type: "result", jobId: "", result: {}, rss: 1 });
    const res = await p;
    expect(res.aborted).toBe(true);
  });
});