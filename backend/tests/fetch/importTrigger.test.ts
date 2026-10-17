// importTrigger.ts 专项测试：入库触发链的活跃间隔防抖、下载总开关、空集/无待下项早退，
// 以及各层异常兜底（落库失败 / 计划器抛错 / 监听器内异常）。
//
// 依赖全部为叶子模块，直接 vi.mock（无真实网络 / 无子进程 / 无 DB）：
//   settings / importTriggerHook / configStore / library / jobStore / jobRunner。
// 防抖与计时器一律走 fake timers（vi.useFakeTimers + advanceTimersByTime）。
//
// 注意：本模块持有模块级单例（pending 集合 / 计时器），每个用例前后用
// _resetImportTriggerForTest() 清掉，避免 base 配置的 shuffle 导致顺序耦合。
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// 用 vi.hoisted 承载 mock 之间的共享状态（vi.mock 工厂会被提升到 import 之前）。
const h = vi.hoisted(() => ({
  store: new Map<string, string>(),
  /** 非 null 时 setSetting 抛该值（可传 Error 或任意值，覆盖两种日志形态）。 */
  setError: null as unknown,
  /** 生效配置（currentFetchConfig 的返回）。 */
  cfg: { enabled: true } as Record<string, unknown>,
  /** buildLibraryPlan 返回的 items。 */
  planItems: [] as Array<{ songId: string }>,
  /** 非 null 时 buildLibraryPlan 抛该值。 */
  planThrow: null as unknown,
  /** 非 null 时 createFetchJob 抛该值。 */
  jobThrow: null as unknown,
  created: [] as Array<Record<string, unknown>>,
  started: [] as string[],
  listener: null as null | ((songIds: string[], ctx: { providerId: string }) => void),
}));

const PENDING_KEY = "fetch.import.pending";

vi.mock("../../src/services/settings.js", () => ({
  getSetting: (k: string, d = ""): string => (h.store.has(k) ? h.store.get(k)! : d),
  setSetting: (k: string, v: string): void => {
    if (h.setError) throw h.setError;
    h.store.set(k, v);
  },
}));

vi.mock("../../src/services/source/online/importTriggerHook.js", () => ({
  setImportedSongsListener: (fn: typeof h.listener): void => {
    h.listener = fn;
  },
}));

vi.mock("../../src/services/fetch/configStore.js", () => ({
  currentFetchConfig: () => h.cfg,
}));

vi.mock("../../src/services/fetch/library.js", () => ({
  buildLibraryPlan: () => {
    if (h.planThrow) throw h.planThrow;
    return { items: h.planItems };
  },
  buildLibraryTargets: (items: Array<{ songId: string }>) =>
    items.map((i) => ({ id: `library:${i.songId}` })),
  buildLibraryJobConfig: (_cfg: unknown, opts?: { noAutoContinue?: boolean }) => ({
    __library: { migrateRowOnly: true, ...(opts?.noAutoContinue ? { noAutoContinue: true } : {}) },
  }),
}));

vi.mock("../../src/services/fetch/jobStore.js", () => ({
  createFetchJob: (input: Record<string, unknown>) => {
    if (h.jobThrow) throw h.jobThrow;
    h.created.push(input);
    return { id: "job-x" };
  },
}));

vi.mock("../../src/services/fetch/jobRunner.js", () => ({
  startFetchJob: (id: string): void => {
    h.started.push(id);
  },
}));

import {
  IMPORT_TRIGGER_IDLE_MS,
  _resetImportTriggerForTest,
  enqueueImportedSongs,
  flushImportedSongs,
  registerFetchImportTrigger,
  triggerFetchForImportedSongs,
} from "../../src/services/fetch/importTrigger.js";

beforeEach(() => {
  vi.useFakeTimers();
  h.store.clear();
  h.setError = null;
  h.cfg = { enabled: true };
  h.planItems = [{ songId: "s1" }];
  h.planThrow = null;
  h.jobThrow = null;
  h.created = [];
  h.started = [];
  h.listener = null;
  _resetImportTriggerForTest();
});

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  _resetImportTriggerForTest();
});

describe("importTrigger 归一化与防抖", () => {
  it("归一化：去空白 / 去空串 / 去重，null 与 undefined 一并跳过", () => {
    const n = enqueueImportedSongs([" a ", "a", "", null as unknown as string, undefined as unknown as string, "b"]);
    expect(n).toBe(2);
    // 空数组与 undefined：ids.length===0 分支 → 直接返回当前总数
    expect(enqueueImportedSongs([] as unknown as string[])).toBe(2);
    expect(enqueueImportedSongs(undefined as unknown as string[])).toBe(2);
  });

  it("活跃间隔防抖：持续入库不断推后，静默满 5 分钟才下发一次", () => {
    enqueueImportedSongs(["a"]);
    vi.advanceTimersByTime(IMPORT_TRIGGER_IDLE_MS - 1);
    expect(h.created.length).toBe(0);
    // 再次入库 → 重置计时器（覆盖 clearTimeout 已有计时器分支）
    enqueueImportedSongs(["b"]);
    vi.advanceTimersByTime(IMPORT_TRIGGER_IDLE_MS - 1);
    expect(h.created.length).toBe(0);
    vi.advanceTimersByTime(1);
    expect(h.created.length).toBe(1);
    expect(h.started).toEqual(["job-x"]);
    expect(h.created[0]).toMatchObject({ kind: "import" });
    // 下发后待处理集合并集已清空
    expect(h.store.get(PENDING_KEY)).toBe("[]");
  });

  it("重复入库：added=0 时不落库但仍续期", () => {
    expect(enqueueImportedSongs(["a"])).toBe(1);
    expect(enqueueImportedSongs(["a"])).toBe(1); // 已在集合内 → added 为 0
    vi.advanceTimersByTime(IMPORT_TRIGGER_IDLE_MS);
    expect(h.created.length).toBe(1);
  });
});

describe("importTrigger flush 与触发", () => {
  it("flush：集合为空 → reason empty（idleTimer 为 null 分支）", () => {
    expect(flushImportedSongs()).toEqual({ enqueued: 0, reason: "empty" });
  });

  it("flush：手动直接调用（清已有计时器），无待下项时 jobId 缺省", () => {
    h.planItems = [];
    enqueueImportedSongs(["a"]); // 装上计时器 → flush 里 clearTimeout 分支为真
    const r = flushImportedSongs();
    expect(r).toEqual({ enqueued: 0, reason: "nothing-to-do" });
    expect(h.created.length).toBe(0);
  });

  it("下载总开关关闭：不建任务", () => {
    h.cfg = { enabled: false };
    expect(triggerFetchForImportedSongs(["a"])).toEqual({ enqueued: 0, reason: "disabled" });
    expect(h.created.length).toBe(0);
  });

  it("点名列表为空（空串 / null / undefined）：reason empty", () => {
    expect(triggerFetchForImportedSongs([])).toEqual({ enqueued: 0, reason: "empty" });
    expect(triggerFetchForImportedSongs([" ", "", null as unknown as string])).toEqual({
      enqueued: 0,
      reason: "empty",
    });
    expect(triggerFetchForImportedSongs(undefined as unknown as string[])).toEqual({
      enqueued: 0,
      reason: "empty",
    });
  });

  it("成功：去重后入队并启动任务，返回 enqueued 与 jobId", () => {
    h.planItems = [{ songId: "a" }, { songId: "b" }];
    const r = triggerFetchForImportedSongs(["a", "b", "a"]);
    expect(r).toEqual({ enqueued: 2, jobId: "job-x" });
    expect(h.started).toEqual(["job-x"]);
    expect(h.created[0]).toBeDefined();
  });

  it("内部异常（Error / 非 Error / 非法入参）：兜底返回，绝不外抛", () => {
    h.planThrow = new Error("plan boom");
    expect(triggerFetchForImportedSongs(["a"])).toEqual({ enqueued: 0, reason: "nothing-to-do" });

    h.planThrow = "raw-fail"; // 非 Error 抛出 → String(e) 分支
    expect(triggerFetchForImportedSongs(["a"])).toEqual({ enqueued: 0, reason: "nothing-to-do" });

    // songIds 不是数组 → normalizeIds 抛错；catch 里 Array.isArray 为假
    expect(triggerFetchForImportedSongs({} as unknown as string[])).toEqual({
      enqueued: 0,
      reason: "nothing-to-do",
    });
  });

  it("createFetchJob 抛错也走兜底", () => {
    h.jobThrow = new Error("create boom");
    expect(triggerFetchForImportedSongs(["a"])).toEqual({ enqueued: 0, reason: "nothing-to-do" });
    expect(h.created.length).toBe(0);
  });
});

describe("importTrigger 持久化与恢复", () => {
  it("恢复脏数据：非法 JSON 与非数组都当空集合", () => {
    h.store.set(PENDING_KEY, "{not json"); // JSON.parse 抛错 → catch
    _resetImportTriggerForTest();
    expect(flushImportedSongs()).toEqual({ enqueued: 0, reason: "empty" });

    h.store.set(PENDING_KEY, "42"); // 合法 JSON 但非数组 → Array.isArray 为假
    _resetImportTriggerForTest();
    expect(flushImportedSongs()).toEqual({ enqueued: 0, reason: "empty" });
  });

  it("落库失败仅告警：内存集合仍有效、计时器照常触发（Error / 非 Error 两种形态）", () => {
    h.setError = new Error("db down");
    expect(enqueueImportedSongs(["a"])).toBe(1);
    vi.advanceTimersByTime(IMPORT_TRIGGER_IDLE_MS);
    expect(h.created.length).toBe(1);

    h.setError = "raw-db-err";
    expect(enqueueImportedSongs(["z"])).toBe(1);
  });

  it("armIdleTimer：计时器具 unref 时调用，不具备时跳过", () => {
    const real = globalThis.setTimeout;
    try {
      (globalThis as unknown as { setTimeout: unknown }).setTimeout = () => ({ unref: vi.fn() });
      expect(enqueueImportedSongs(["u1"])).toBe(1);
      (globalThis as unknown as { setTimeout: unknown }).setTimeout = () => ({});
      expect(enqueueImportedSongs(["u2"])).toBe(2);
    } finally {
      globalThis.setTimeout = real;
    }
  });
});

describe("importTrigger 挂载与监听器兜底", () => {
  it("register：挂载监听器，入库广播累积待下载（挂载时无待处理分支）", () => {
    registerFetchImportTrigger();
    expect(h.listener).toBeTypeOf("function");
    h.listener!(["r1", "r2"], { providerId: "p" });
    expect(h.store.get(PENDING_KEY)).toBe('["r1","r2"]');
    vi.advanceTimersByTime(IMPORT_TRIGGER_IDLE_MS);
    expect(h.created.length).toBe(1);
  });

  it("register：重启恢复待处理集合继续计时（有待处理分支）", () => {
    h.store.set(PENDING_KEY, '["k1"]');
    registerFetchImportTrigger();
    expect(h.created.length).toBe(0);
    vi.advanceTimersByTime(IMPORT_TRIGGER_IDLE_MS);
    expect(h.created.length).toBe(1);
  });

  it("监听器内异常被吞：Error / 非 Error / ctx 缺省", () => {
    registerFetchImportTrigger();
    const real = globalThis.setTimeout;
    try {
      (globalThis as unknown as { setTimeout: unknown }).setTimeout = () => {
        throw new Error("timer boom");
      };
      h.listener!(["x"], { providerId: "p" }); // Error 形态 + providerId 有值
      (globalThis as unknown as { setTimeout: unknown }).setTimeout = () => {
        throw "timer raw";
      };
      h.listener!(["y"], {} as unknown as { providerId: string }); // 非 Error + providerId 缺省
      h.listener!(["z"], undefined as unknown as { providerId: string }); // ctx 整体缺省
    } finally {
      globalThis.setTimeout = real;
    }
  });
});
