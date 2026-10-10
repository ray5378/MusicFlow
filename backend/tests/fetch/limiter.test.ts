import { describe, expect, it } from "vitest";
import { AbortError, HostLimiter, Semaphore } from "../../src/services/fetch/limiter.js";

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("Semaphore", () => {
  it("超限时 FIFO 排队，前一个 release 把额度移交队首", async () => {
    const sem = new Semaphore(2);
    const r1 = await sem.acquire();
    const r2 = await sem.acquire();
    expect(sem.activeCount).toBe(2);

    const order: number[] = [];
    const p3 = sem.acquire().then((rel) => {
      order.push(3);
      return rel;
    });
    const p4 = sem.acquire().then((rel) => {
      order.push(4);
      return rel;
    });
    expect(sem.pendingCount).toBe(2);

    r1();
    const r3 = await p3;
    expect(order).toEqual([3]); // FIFO：3 先于 4
    r2();
    const r4 = await p4;
    expect(order).toEqual([3, 4]);

    r3();
    r4();
    expect(sem.activeCount).toBe(0);
    expect(sem.pendingCount).toBe(0);
  });

  it("release 幂等：重复调用不重复归还额度", async () => {
    const sem = new Semaphore(1);
    const r = await sem.acquire();
    expect(sem.activeCount).toBe(1);
    r();
    r();
    r();
    expect(sem.activeCount).toBe(0);
    // 归还后应能再拿（说明额度没有被多还）
    const r2 = await sem.acquire();
    expect(sem.activeCount).toBe(1);
    r2();
    expect(sem.activeCount).toBe(0);
  });

  it("真实任务并发峰值被限在 limit 内", async () => {
    const sem = new Semaphore(3);
    let active = 0;
    let peak = 0;
    const task = async () => {
      const rel = await sem.acquire();
      active++;
      peak = Math.max(peak, active);
      await sleep(10);
      active--;
      rel();
    };
    await Promise.all(Array.from({ length: 10 }, () => task()));
    expect(peak).toBe(3);
    expect(sem.activeCount).toBe(0);
  });

  it("signal 已 abort → 立即 reject(AbortError)", async () => {
    const sem = new Semaphore(1);
    const ac = new AbortController();
    ac.abort();
    await expect(sem.acquire(ac.signal)).rejects.toBeInstanceOf(AbortError);
  });

  it("排队中 abort → 从队列摘除并 reject", async () => {
    const sem = new Semaphore(1);
    const r1 = await sem.acquire();
    const ac = new AbortController();
    const p = sem.acquire(ac.signal);
    expect(sem.pendingCount).toBe(1);
    ac.abort();
    await expect(p).rejects.toBeInstanceOf(AbortError);
    expect(sem.pendingCount).toBe(0);
    r1();
    expect(sem.activeCount).toBe(0);
  });

  it("非法 limit 归一为 1", async () => {
    const sem = new Semaphore(0);
    const r1 = await sem.acquire();
    expect(sem.activeCount).toBe(1);
    const p2 = sem.acquire();
    expect(sem.pendingCount).toBe(1);
    r1();
    const r2 = await p2;
    r2();
  });
});

describe("HostLimiter", () => {
  it("单 host 串行（perHost=1）", async () => {
    const hl = new HostLimiter(1, 0);
    let active = 0;
    let peak = 0;
    const fn = async () => {
      active++;
      peak = Math.max(peak, active);
      await sleep(10);
      active--;
    };
    await Promise.all([hl.run("a", fn), hl.run("a", fn), hl.run("a", fn)]);
    expect(peak).toBe(1);
  });

  it("多 host 并行", async () => {
    const hl = new HostLimiter(1, 0);
    let active = 0;
    let peak = 0;
    const fn = async () => {
      active++;
      peak = Math.max(peak, active);
      await sleep(20);
      active--;
    };
    await Promise.all([hl.run("h1", fn), hl.run("h2", fn), hl.run("h3", fn)]);
    expect(peak).toBeGreaterThanOrEqual(2); // 放宽，避免 flaky
  });

  it("同链相邻任务间隔 ≥ minIntervalMs（放宽断言）", async () => {
    const hl = new HostLimiter(1, 60);
    const starts: number[] = [];
    const fn = async () => {
      starts.push(Date.now());
    };
    await hl.run("a", fn);
    await hl.run("a", fn);
    expect(starts.length).toBe(2);
    expect(starts[1] - starts[0]).toBeGreaterThanOrEqual(50);
  });

  it("返回值透传、异常透传", async () => {
    const hl = new HostLimiter(2, 0);
    await expect(hl.run("a", async () => 42)).resolves.toBe(42);
    await expect(hl.run("a", async () => {
      throw new Error("boom");
    })).rejects.toThrow("boom");
  });

  it("排队中 abort → reject", async () => {
    const hl = new HostLimiter(1, 0);
    const d = deferred<void>();
    const p1 = hl.run("a", () => d.promise);
    const ac = new AbortController();
    const p2 = hl.run("a", async () => undefined, ac.signal);
    ac.abort();
    await expect(p2).rejects.toBeInstanceOf(AbortError);
    d.resolve();
    await p1;
  });

  it("叠加全局 Semaphore 时全局上限生效", async () => {
    const global = new Semaphore(2);
    const hl = new HostLimiter(4, 0, global);
    let active = 0;
    let peak = 0;
    const fn = async () => {
      active++;
      peak = Math.max(peak, active);
      await sleep(15);
      active--;
    };
    const jobs = ["a", "b", "c", "d", "e", "f"].map((h) => hl.run(h, fn));
    await Promise.all(jobs);
    expect(peak).toBe(2);
    expect(global.activeCount).toBe(0);
  });

  it("同一 host 复用泳道（minInterval 跨多次 run 保持），不同 host 各占一组", async () => {
    const hl = new HostLimiter(1, 0);
    expect(hl.hostCount).toBe(0);
    await hl.run("a", async () => undefined);
    expect(hl.hostCount).toBe(1);
    await hl.run("a", async () => undefined);
    expect(hl.hostCount).toBe(1); // 同 host 复用，不新建
    await hl.run("b", async () => undefined);
    expect(hl.hostCount).toBe(2);
  });
});
