// ==================== 音乐下载链回归守卫：入库即入队触发器(importTrigger) ====================
//
// 锚定「网络歌曲入库 → 自动过一轮下载」这条产品定调(2026-10-11)不被回归破坏。
// 全部用例纯内存、不联网、不碰 /MUSIC：
//   - 去重合并(同首歌跨批导入只下 1 次)；
//   - 空白/trim 归一化(空串/纯空白/前后空格不入队)；
//   - 活跃间隔防抖(广播只并入待处理集合、不直接建任务)；
//   - 下载总开关关闭 → 不建任务；
//   - 本地/WebDAV 已有实体(计划器返回 0 项) → 不建任务；
//   - 待处理为空 flush → 直接返回不建任务；
//   - 触发器挂载点仍在(registerFetchImportTrigger 把钩子接到 enqueue)；
//   - 跨批累计并集只建一个任务(去重生效)；
//   - 内部异常/监听器异常一律兜底,绝不拖垮导入流程(2026-10-11 契约)。
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

const h = vi.hoisted(() => ({
  settings: new Map<string, string>(),
  throwOnGet: false,
  throwOnSet: false,
  cfgEnabled: true,
  planItems: [] as any[],
  buildLibraryPlan: vi.fn(),
  buildLibraryTargets: vi.fn((items: any[]) => items.map((i) => ({ target: i.id }))),
  buildLibraryJobConfig: vi.fn(() => ({ noAutoContinue: true })),
  createFetchJob: vi.fn(() => ({ id: "job-x" })),
  startFetchJob: vi.fn(),
  setImportedSongsListener: vi.fn(),
}));

vi.mock("../../src/services/settings.js", () => ({
  getSetting: (k: string, d = "") => {
    if (h.throwOnGet) throw new Error("injected settings failure");
    return h.settings.has(k) ? h.settings.get(k)! : d;
  },
  setSetting: (k: string, v: string) => {
    if (h.throwOnSet) throw new Error("injected settings write failure");
    h.settings.set(k, v);
  },
}));

vi.mock("../../src/services/fetch/configStore.js", () => ({
  currentFetchConfig: () => ({ enabled: h.cfgEnabled }) as any,
}));

vi.mock("../../src/services/fetch/library.js", () => ({
  buildLibraryPlan: (...args: any[]) => h.buildLibraryPlan(...args),
  buildLibraryTargets: (...args: any[]) => h.buildLibraryTargets(...args),
  buildLibraryJobConfig: (...args: any[]) => h.buildLibraryJobConfig(...args),
}));

vi.mock("../../src/services/fetch/jobStore.js", () => ({
  createFetchJob: (...args: any[]) => h.createFetchJob(...args),
}));

vi.mock("../../src/services/fetch/jobRunner.js", () => ({
  startFetchJob: (...args: any[]) => h.startFetchJob(...args),
}));

vi.mock("../../src/services/source/online/importTriggerHook.js", () => ({
  setImportedSongsListener: (...args: any[]) => h.setImportedSongsListener(...args),
  hasImportedSongsListener: vi.fn(() => false),
  emitImportedSongs: vi.fn(),
}));

import {
  IMPORT_TRIGGER_IDLE_MS,
  enqueueImportedSongs,
  flushImportedSongs,
  triggerFetchForImportedSongs,
  registerFetchImportTrigger,
  _resetImportTriggerForTest,
} from "../../src/services/fetch/importTrigger.js";

const PENDING_KEY = "fetch.import.pending";

function pendingIds(): string[] {
  const raw = h.settings.get(PENDING_KEY);
  if (!raw) return [];
  try {
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr.map(String) : [];
  } catch {
    return [];
  }
}

beforeEach(() => {
  h.settings.clear();
  h.throwOnGet = false;
  h.throwOnSet = false;
  h.cfgEnabled = true;
  h.planItems = [];
  h.buildLibraryPlan.mockReset();
  h.buildLibraryTargets.mockReset();
  h.buildLibraryJobConfig.mockReset();
  h.createFetchJob.mockReset();
  h.startFetchJob.mockReset();
  h.setImportedSongsListener.mockReset();
  h.buildLibraryTargets.mockImplementation((items: any[]) => items.map((i) => ({ target: i.id })));
  h.buildLibraryJobConfig.mockReturnValue({ noAutoContinue: true });
  h.createFetchJob.mockReturnValue({ id: "job-x" });
  _resetImportTriggerForTest();
});

afterEach(() => {
  _resetImportTriggerForTest();
});

describe("入库即入队：去重与归一化", () => {
  it("跨批导入同首歌只合并一次(Set 去重,累计并集)", () => {
    const n1 = enqueueImportedSongs(["a", "b"]);
    const n2 = enqueueImportedSongs(["b", "c"]);
    expect(n1).toBe(2);
    expect(n2).toBe(3); // a,b,c
    expect(pendingIds().sort()).toEqual(["a", "b", "c"]);
  });

  it("空白/纯空白/前后空格被归一化丢弃", () => {
    const n = enqueueImportedSongs([" a ", "", "   ", "b"]);
    expect(n).toBe(2);
    expect(pendingIds().sort()).toEqual(["a", "b"]);
  });

  it("空输入不入队、返回当前集合大小、不动 settings", () => {
    enqueueImportedSongs(["x"]);
    const before = pendingIds();
    const n = enqueueImportedSongs([]);
    expect(n).toBe(1);
    expect(pendingIds()).toEqual(before); // 空输入未改写待处理集合
  });

  it("PENDING_KEY 脏数据(非 JSON)被当作空集合,绝不抛错影响导入", () => {
    h.settings.set(PENDING_KEY, "this-is-not-json");
    const n = enqueueImportedSongs(["x"]);
    expect(n).toBe(1);
    expect(pendingIds()).toEqual(["x"]);
  });

  it("settings 落库失败时内存集合仍正确,不抛错", () => {
    h.throwOnSet = true;
    const n = enqueueImportedSongs(["x"]);
    expect(n).toBe(1); // 落库失败只记日志,返回仍正确
    // 恢复落库后,内存里仍保留了 x(再次入队正确累加)
    h.throwOnSet = false;
    const n2 = enqueueImportedSongs(["y"]);
    expect(n2).toBe(2);
    expect(pendingIds().sort()).toEqual(["x", "y"]);
  });
});

describe("活跃间隔防抖与下发", () => {
  it("IMPORT_TRIGGER_IDLE_MS 为 5 分钟(活跃间隔窗口常量)", () => {
    expect(IMPORT_TRIGGER_IDLE_MS).toBe(5 * 60_000);
  });

  it("广播只并入集合、不直接建任务(返回并入后的待处理总数)", () => {
    const n = enqueueImportedSongs(["s1", "s2"]);
    expect(n).toBe(2);
    expect(h.buildLibraryPlan).not.toHaveBeenCalled();
    expect(h.createFetchJob).not.toHaveBeenCalled();
  });

  it("下载总开关关闭 → flush 不建任务(reason=disabled)", () => {
    enqueueImportedSongs(["s1"]);
    h.cfgEnabled = false;
    const r = flushImportedSongs();
    expect(r).toEqual({ enqueued: 0, reason: "disabled" });
    expect(h.buildLibraryPlan).not.toHaveBeenCalled();
  });

  it("计划器返回 0 项(本地/WebDAV 已有实体) → flush 不建任务(reason=nothing-to-do)", () => {
    enqueueImportedSongs(["s1"]);
    h.buildLibraryPlan.mockReturnValue({ items: [] });
    const r = flushImportedSongs();
    expect(r).toEqual({ enqueued: 0, reason: "nothing-to-do" });
    expect(h.createFetchJob).not.toHaveBeenCalled();
  });

  it("待处理为空 → flush 直接返回(reason=empty)", () => {
    const r = flushImportedSongs();
    expect(r).toEqual({ enqueued: 0, reason: "empty" });
  });

  it("活跃间隔到期(flush)→ 用累计并集只建一个任务(去重生效)", () => {
    enqueueImportedSongs(["a", "b"]);
    enqueueImportedSongs(["b", "c"]); // 累计 {a,b,c}
    h.buildLibraryPlan.mockReturnValue({ items: [{ id: "a" }, { id: "b" }, { id: "c" }] });
    const r = flushImportedSongs();
    expect(r.enqueued).toBe(3);
    expect(r.jobId).toBe("job-x");
    expect(h.buildLibraryPlan).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({ songIds: ["a", "b", "c"] }),
    );
    expect(h.createFetchJob).toHaveBeenCalledTimes(1);
    expect(h.startFetchJob).toHaveBeenCalledWith("job-x");
    expect(pendingIds()).toEqual([]); // flush 后并集清空
  });
});

describe("triggerFetchForImportedSongs 直测(边角)", () => {
  it("空列表直接返回 empty,不碰计划器", () => {
    expect(triggerFetchForImportedSongs([])).toEqual({ enqueued: 0, reason: "empty" });
    expect(h.buildLibraryPlan).not.toHaveBeenCalled();
  });

  it("开关关闭直接返回 disabled,不碰计划器", () => {
    h.cfgEnabled = false;
    expect(triggerFetchForImportedSongs(["s1"])).toEqual({ enqueued: 0, reason: "disabled" });
    expect(h.buildLibraryPlan).not.toHaveBeenCalled();
  });

  it("内部异常被兜底(导入不受影响),返回 nothing-to-do", () => {
    h.buildLibraryPlan.mockImplementation(() => {
      throw new Error("plan exploded");
    });
    const r = triggerFetchForImportedSongs(["s1"]);
    expect(r).toEqual({ enqueued: 0, reason: "nothing-to-do" });
    expect(h.createFetchJob).not.toHaveBeenCalled();
  });
});

describe("挂载点契约(registerFetchImportTrigger 把钩子接到 enqueue)", () => {
  it("启动时把入库监听器挂上,且监听器调用即并入待下载集合(跨批去重)", () => {
    registerFetchImportTrigger();
    expect(h.setImportedSongsListener).toHaveBeenCalledTimes(1);
    const listener = h.setImportedSongsListener.mock.calls[0][0] as (
      ids: string[],
      ctx: { providerId: string },
    ) => void;
    // 模拟 importOnlineSongs 广播「本轮新入库」
    listener(["n1", "n2"], { providerId: "netease" });
    expect(pendingIds().sort()).toEqual(["n1", "n2"]);
    // 再广播一轮,与首轮重叠 → 去重
    listener(["n2", "n3"], { providerId: "netease" });
    expect(pendingIds().sort()).toEqual(["n1", "n2", "n3"]);
  });

  it("进程重启恢复:待处理非空时继续计时,flush 时仍能下发", () => {
    // 模拟上次退出时还没满活跃间隔的待处理集合
    h.settings.set(PENDING_KEY, JSON.stringify(["r1"]));
    registerFetchImportTrigger();
    expect(h.setImportedSongsListener).toHaveBeenCalledTimes(1);
    // 活跃间隔到期的 flush 把恢复出来的 r1 正常下发
    h.buildLibraryPlan.mockReturnValue({ items: [{ id: "r1" }] });
    const r = flushImportedSongs();
    expect(r.enqueued).toBe(1);
    expect(r.jobId).toBe("job-x");
  });

  it("监听器异常被吞(下载钩子崩了也不影响导入)", () => {
    registerFetchImportTrigger();
    const listener = h.setImportedSongsListener.mock.calls[0][0] as (
      ids: string[],
      ctx: { providerId: string },
    ) => void;
    // 制造 enqueue 内部异常(getSetting 抛错)→ 必须被监听器 catch 吞掉
    h.throwOnGet = true;
    expect(() => listener(["x"], { providerId: "netease" })).not.toThrow();
  });
});
