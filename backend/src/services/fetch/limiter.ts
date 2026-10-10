// ==================== MusicFetch 下载限流（零依赖手写） ====================
//
// 下载是「网络 IO 等待型」负载，瓶颈在家庭带宽与对方风控，不在 CPU。因此不能复用
// `batchPacer`（会因用户在操作把并发压到 1，让下载退化成串行），也不引入任何 npm 并发库
// （SPEC §六.1 零新增依赖），照 house-style（`services/source/online/match.ts` 的 worker 池）
// 手写两个小设施：
//
//   - `Semaphore`   —— 全局并发闸：任意时刻最多 N 个任务在跑，超出 FIFO 排队，
//                      返回**幂等 release**，支持 `AbortSignal` 取消排队。
//   - `HostLimiter` —— 按 host 分泳道：每个 host 开 `perHost` 条串行链，同一链相邻任务之间
//                      插 `minIntervalMs`。一个结构同时满足「单域并发上限」与「单域最小间隔」。
//
// 形态与 `services/transcode.ts` 的 SlotPool 对齐（分池计数 + FIFO waiters + 幂等 release +
// 可取消排队），但**按任务实例创建** —— 模块级单例会违反 SPEC §六.7「禁止无上限常驻结构」。
// `HostLimiter` 内部的 `Map<host, Lane[]>` 只活在实例里，任务结束随对象 GC，不做模块级缓存。

/** 排队取消时抛出的错误。`name` 固定为 "AbortError"，便于调用方按类型识别。 */
export class AbortError extends Error {
  constructor(message = "aborted") {
    super(message);
    this.name = "AbortError";
  }
}

function abortError(): AbortError {
  return new AbortError("等待限流额度时被取消");
}

interface Waiter {
  resolve: (release: () => void) => void;
  reject: (err: unknown) => void;
  signal?: AbortSignal;
  /** 排队期间挂上的 abort 监听（授予额度 / 出队时摘除）。 */
  onAbort?: () => void;
}

/**
 * 全局并发闸（信号量）。
 *
 * 语义：
 *   - `acquire()` 在未超限时立即 resolve 一个 **幂等** release 函数；
 *   - 超限时 FIFO 排队，前一个 release 会把额度**移交**给队首（不经过计数抖动）；
 *   - `signal` 已 abort 时立即 reject；排队中途 abort 会把自己从队列摘除并 reject。
 */
export class Semaphore {
  private readonly limit: number;
  private active = 0;
  private readonly waiters: Waiter[] = [];

  constructor(limit: number) {
    this.limit = Number.isFinite(limit) && limit > 0 ? Math.max(1, Math.floor(limit)) : 1;
  }

  /** 当前正在占用额度的任务数（测试断言用）。 */
  get activeCount(): number {
    return this.active;
  }

  /** 当前排队等待的任务数（测试断言用）。 */
  get pendingCount(): number {
    return this.waiters.length;
  }

  acquire(signal?: AbortSignal): Promise<() => void> {
    if (signal?.aborted) return Promise.reject(abortError());

    return new Promise<() => void>((resolve, reject) => {
      const waiter: Waiter = { resolve, reject, signal };
      if (signal) {
        waiter.onAbort = () => {
          const i = this.waiters.indexOf(waiter);
          if (i >= 0) this.waiters.splice(i, 1);
          reject(abortError());
        };
        signal.addEventListener("abort", waiter.onAbort, { once: true });
      }
      if (this.active < this.limit) {
        this.active++;
        resolve(this.makeRelease(waiter));
      } else {
        this.waiters.push(waiter);
      }
    });
  }

  /** 生成幂等 release：重复调用不重复归还额度。 */
  private makeRelease(waiter: Waiter): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      if (waiter.signal && waiter.onAbort) {
        waiter.signal.removeEventListener("abort", waiter.onAbort);
      }
      const next = this.shiftLive();
      if (next) {
        // 额度直接移交队首，`active` 不变（不出现瞬时超额）。
        next.resolve(this.makeRelease(next));
      } else {
        this.active = Math.max(0, this.active - 1);
      }
    };
  }

  /** 取出队首尚未 abort 的等待者（abort 的已在 onAbort 里出队，这里再防御一次）。 */
  private shiftLive(): Waiter | undefined {
    while (this.waiters.length > 0) {
      const w = this.waiters.shift() as Waiter;
      if (w.signal?.aborted) continue;
      return w;
    }
    return undefined;
  }
}

interface Task<T> {
  run: () => Promise<T>;
  resolve: (v: T) => void;
  reject: (err: unknown) => void;
  signal?: AbortSignal;
  onAbort?: () => void;
}

/** 一条串行链：队列 + 运行标记 + 上次结束时间（用于最小间隔）。 */
interface Lane {
  queue: Array<Task<any>>;
  running: boolean;
  lastFinishedAt: number;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * 按 host 分泳道限流。
 *
 * `run(key, fn, signal)` 把任务投到 key（通常取 URL 的 host）对应的一组泳道里：
 *   - 每个 host 有 `perHost` 条**串行链**，任务被派到当前最空的那条链；
 *   - 同一链内任务严格串行，且相邻任务之间至少间隔 `minIntervalMs`；
 *   - 若构造时传了 `global`（Semaphore），任务真正执行前还要再抢一次全局额度；
 *   - `signal` abort 时：仍在排队的任务直接拒绝并出队；已在执行的任务由 `fn` 自己响应。
 */
export class HostLimiter {
  /** host 键上限：host 数正常只有个位数，这里只作「无上限增长」的兜底（超限丢最老的）。 */
  private static readonly MAX_HOSTS = 512;

  private readonly perHost: number;
  private readonly minIntervalMs: number;
  private readonly global?: Semaphore;
  private readonly lanes = new Map<string, Lane[]>();

  constructor(perHost: number, minIntervalMs: number, global?: Semaphore) {
    this.perHost = Number.isFinite(perHost) && perHost > 0 ? Math.max(1, Math.floor(perHost)) : 1;
    this.minIntervalMs =
      Number.isFinite(minIntervalMs) && minIntervalMs > 0 ? Math.floor(minIntervalMs) : 0;
    this.global = global;
  }

  /** 当前活跃 host 数（测试/观测用）。 */
  get hostCount(): number {
    return this.lanes.size;
  }

  run<T>(key: string, fn: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    if (signal?.aborted) return Promise.reject(abortError());

    const lanes = this.lanesOf(key);
    const lane = this.pickLane(lanes);
    return new Promise<T>((resolve, reject) => {
      const task: Task<T> = { run: fn, resolve, reject, signal };
      if (signal) {
        task.onAbort = () => {
          const i = lane.queue.indexOf(task);
          if (i >= 0) {
            lane.queue.splice(i, 1);
            reject(abortError());
          }
        };
        signal.addEventListener("abort", task.onAbort, { once: true });
      }
      lane.queue.push(task);
      this.pump(lane);
    });
  }

  /** 取（必要时建）host 的泳道组。泳道**随实例存活**（实例即任务），仅对 host 键数封顶。 */
  private lanesOf(key: string): Lane[] {
    let lanes = this.lanes.get(key);
    if (!lanes) {
      if (this.lanes.size >= HostLimiter.MAX_HOSTS) {
        const oldest = this.lanes.keys().next().value;
        if (oldest !== undefined) this.lanes.delete(oldest);
      }
      lanes = Array.from({ length: this.perHost }, () => ({
        queue: [],
        running: false,
        lastFinishedAt: 0,
      }));
      this.lanes.set(key, lanes);
    }
    return lanes;
  }

  /** 派任务到「排队数最少」的那条链（并列取最靠前的），天然做到多 host / 多链并行。 */
  private pickLane(lanes: Lane[]): Lane {
    let best = lanes[0];
    let bestLoad = best.queue.length + (best.running ? 1 : 0);
    for (let i = 1; i < lanes.length; i++) {
      const load = lanes[i].queue.length + (lanes[i].running ? 1 : 0);
      if (load < bestLoad) {
        best = lanes[i];
        bestLoad = load;
      }
    }
    return best;
  }

  private pump(lane: Lane): void {
    if (lane.running || lane.queue.length === 0) return;
    lane.running = true;
    void this.drain(lane);
  }

  private async drain(lane: Lane): Promise<void> {
    try {
      while (lane.queue.length > 0) {
        const task = lane.queue.shift() as Task<any>;
        if (task.signal?.aborted) {
          task.reject(abortError());
          continue;
        }

        // 同链相邻任务之间的最小间隔：等待到「上次结束 + minInterval」。
        if (this.minIntervalMs > 0) {
          const wait = lane.lastFinishedAt + this.minIntervalMs - Date.now();
          if (wait > 0) await sleep(wait);
        }

        let release: (() => void) | undefined;
        if (this.global) {
          try {
            release = await this.global.acquire(task.signal);
          } catch (e) {
            // 排队抢全局额度时被 abort：本任务作废，继续处理链上的后续任务。
            if (task.signal && task.onAbort) task.signal.removeEventListener("abort", task.onAbort);
            task.reject(e);
            lane.lastFinishedAt = Date.now();
            continue;
          }
        }

        try {
          // 已开始执行：摘除 abort 监听（此后由 fn 自己响应 signal）。
          if (task.signal && task.onAbort) task.signal.removeEventListener("abort", task.onAbort);
          const value = await task.run();
          task.resolve(value);
        } catch (e) {
          task.reject(e);
        } finally {
          release?.();
          lane.lastFinishedAt = Date.now();
        }
      }
    } finally {
      lane.running = false;
    }
  }
}
