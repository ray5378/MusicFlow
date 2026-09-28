// ==================== batch/runner 长尾:启动失败 / 看门狗 / abort 宽限强杀 / heartbeat ====================
// 既有 runner.test.ts 覆盖 happy path + 子进程崩溃 + abort 转发。这里补:
//   - fork 同步抛错 → BatchJobError「子进程启动失败」(不悬挂全局批量闸);
//   - heartbeat 消息被识别(重置 lastActivity,不误判卡死);
//   - 看门狗:长时间无任何消息 → 强杀 + 报「超时」;
//   - abort 宽限期(30s)内子进程不退 → SIGKILL 强杀。
// 用假子进程注入,不真实 fork。
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { EventEmitter } from "events";
import { runBatchJob, _setForkImplForTest, anyBatchChildRunning } from "../../src/batch/runner.js";
import { _resetPacerForTest, isBatchBusy } from "../../src/services/plugin/batchPacer.js";

type FakeScript = (msg: any, fake: FakeChild) => void;

class FakeChild extends EventEmitter {
  connected = true;
  killed = false;
  pid = 4242;
  sent: any[] = [];
  private script: FakeScript;
  constructor(script: FakeScript) { super(); this.script = script; }
  send(msg: any): boolean { this.sent.push(msg); this.script(msg, this); return true; }
  kill(_signal?: NodeJS.Signals | number): boolean { this.killed = true; return true; }
}

/** 注入一个假子进程;ready 由调用方按需发(避免与 fake timers 抢时序)。 */
function installFake(script: FakeScript = () => {}): FakeChild {
  const fake = new FakeChild(script);
  _setForkImplForTest((() => fake) as any);
  return fake;
}

describe("batch runner 长尾", () => {
  beforeEach(() => _resetPacerForTest());
  afterEach(() => {
    vi.useRealTimers();
    _setForkImplForTest(null as any);
  });

  it("fork 同步抛错 → 拒绝「子进程启动失败」,且批量闸被释放", async () => {
    // 为什么:启动失败若不 reject,done 永不收敛、全局闸永久占用 → 后续批量任务全卡死。
    _setForkImplForTest((() => { throw new Error("EACCES spawn"); }) as any);
    await expect(runBatchJob("scan", { sourceId: "s" })).rejects.toThrow(/子进程启动失败/);
    expect(isBatchBusy()).toBe(false);
    expect(anyBatchChildRunning()).toBe(false);
  });

  it("heartbeat 消息被识别:随后 result 仍正常回传(不误判卡死)", async () => {
    const fake = installFake();
    setImmediate(() => {
      fake.emit("message", { type: "ready", pid: fake.pid });
      setTimeout(() => {
        fake.emit("message", { type: "heartbeat", jobId: "j" });
        fake.emit("message", { type: "result", jobId: "j", result: { ok: 7 }, rss: 9 });
      }, 0);
    });
    const res = await runBatchJob("scan", { sourceId: "s" });
    expect(res).toEqual({ result: { ok: 7 }, childRss: 9, aborted: false });
  });

  it("看门狗超时(长时间无消息)→ 强杀子进程并报「超时」", async () => {
    vi.useFakeTimers();
    const fake = installFake();
    const p = runBatchJob("scan", { sourceId: "s" });
    p.catch(() => { /* 断言在下面 */ });
    await vi.advanceTimersByTimeAsync(1); // 让 body 跑到 fork + 挂上监听
    fake.emit("message", { type: "ready", pid: fake.pid });
    await vi.advanceTimersByTimeAsync(1);
    // 推进超过 WATCHDOG_TIMEOUT_MS(15min);检查间隔 30s
    await vi.advanceTimersByTimeAsync(16 * 60 * 1000);
    await expect(p).rejects.toThrow(/超时/);
    expect(fake.killed).toBe(true);
  });

  it("abort 宽限期内子进程不退 → SIGKILL 强杀;随后仍能正常 settle(aborted=true)", async () => {
    vi.useFakeTimers();
    const fake = installFake();
    const ac = new AbortController();
    const p = runBatchJob("scan", { sourceId: "s" }, { signal: ac.signal });
    p.catch(() => { /* 断言在下面 */ });
    await vi.advanceTimersByTimeAsync(1);
    fake.emit("message", { type: "ready", pid: fake.pid });
    await vi.advanceTimersByTimeAsync(1);

    ac.abort();
    await vi.advanceTimersByTimeAsync(1);
    expect(fake.sent.some((m) => m.type === "abort")).toBe(true);
    expect(fake.killed).toBe(false); // 宽限期内不立刻杀

    await vi.advanceTimersByTimeAsync(30_000); // ABORT_GRACE_MS
    expect(fake.killed).toBe(true);

    fake.emit("message", { type: "result", jobId: "j", result: { partial: true }, rss: 3 });
    await expect(p).resolves.toMatchObject({ aborted: true, result: { partial: true } });
  });
});
