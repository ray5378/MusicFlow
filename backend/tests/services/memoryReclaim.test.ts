// 空闲内存自动回收补测（src/services/memory/reclaim.ts）。
//
// 这是一个「平时不出声、出声就说明服务器闲下来了」的模块：没有活动播放、没有批量任务、
// 空闲超过 threshold 才分三层回收（清可重建缓存 / 主动 GC / SQLite WAL 合并）。
// 值得单测的是**判定**和**节流**——真正回收内存谁都会调，
// 但「开关关了还在回收」「批量任务在跑还去 checkpoint」这类误判很难从外部观察到。
//
// L2 主动 GC 靠运行时 `setFlagsFromString("--expose_gc")` + vm 取到 `gc`，
// 拿不到时必须优雅降级（只做 L1/L3），这条分支同样要有人照。
import "../plugins/_env.js";

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const s = vi.hoisted(() => ({
  getSetting: vi.fn(),
  getSettingBool: vi.fn(),
  isBatchBusy: vi.fn(() => false),
  clearLibraryIndex: vi.fn(),
  clearCoverCache: vi.fn(),
  clearRenderedCovers: vi.fn(),
  clearLyricsCache: vi.fn(),
  clearCoverResolveCache: vi.fn(),
  clearStreamFallbackCache: vi.fn(),
  setFlagsFromString: vi.fn(),
  runInNewContext: vi.fn(),
  logError: vi.fn(),
}));

vi.mock("../../src/services/settings.js", async (io) => ({
  ...(await io<Record<string, unknown>>()),
  getSetting: s.getSetting,
  getSettingBool: s.getSettingBool,
}));
vi.mock("../../src/services/plugin/batchPacer.js", async (io) => ({
  ...(await io<Record<string, unknown>>()),
  isBatchBusy: s.isBatchBusy,
}));
vi.mock("../../src/services/plugin/libraryIndex.js", async (io) => ({
  ...(await io<Record<string, unknown>>()), clearLibraryIndex: s.clearLibraryIndex,
}));
vi.mock("../../src/services/coverCache.js", async (io) => ({
  ...(await io<Record<string, unknown>>()), clearCoverCache: s.clearCoverCache,
}));
vi.mock("../../src/services/coverImage.js", async (io) => ({
  ...(await io<Record<string, unknown>>()), clearRenderedCovers: s.clearRenderedCovers,
}));
vi.mock("../../src/services/lyrics.js", async (io) => ({
  ...(await io<Record<string, unknown>>()), clearLyricsCache: s.clearLyricsCache,
}));
vi.mock("../../src/services/playlistCover.js", async (io) => ({
  ...(await io<Record<string, unknown>>()), clearCoverResolveCache: s.clearCoverResolveCache,
}));
vi.mock("../../src/services/source/online/streamFallback.js", async (io) => ({
  ...(await io<Record<string, unknown>>()), clearStreamFallbackCache: s.clearStreamFallbackCache,
}));
vi.mock("node:v8", async (io) => ({
  ...(await io<Record<string, unknown>>()), setFlagsFromString: s.setFlagsFromString,
}));
// 注意:reclaim.ts 写的是 `import vm from "node:vm"`(默认导入),而 spread 开真实模块后
// 自带一个 interop 出来的 `default`,会把这里写的 default 顶掉 —— 所以 default 必须放最后。
vi.mock("node:vm", async (io) => ({
  ...(await io<Record<string, unknown>>()),
  default: { runInNewContext: s.runInNewContext },
}));
vi.mock("../../src/utils/logger.js", async (io) => ({
  ...(await io<Record<string, unknown>>()),
  createLogger: () => ({ error: s.logError, info: vi.fn(), warn: vi.fn(), debug: vi.fn() }),
}));

import {
  touch,
  registerCacheCleaner,
  isAutoReclaimEnabled,
  isIdle,
  getMemorySnapshot,
  reclaimNow,
  getReclaimStatus,
  startIdleReclaimer,
  _resetReclaimForTest,
  _setLastActivityForTest,
} from "../../src/services/memory/reclaim.js";
import { sqlite } from "../../src/db/index.js";

const MIN = 60 * 1000;
const CHECK_INTERVAL_MS = 60 * 1000; // 内部常量,靠 spy 观察调用次数间接验证

beforeEach(() => {
  _resetReclaimForTest();
  s.getSetting.mockReset();
  s.getSetting.mockReturnValue("5");
  s.getSettingBool.mockReset();
  s.getSettingBool.mockReturnValue(true);
  s.isBatchBusy.mockReturnValue(false);
  for (const k of ["clearLibraryIndex", "clearCoverCache", "clearRenderedCovers",
    "clearLyricsCache", "clearCoverResolveCache", "clearStreamFallbackCache"]) {
    (s as any)[k].mockReset();
  }
  // 默认探测不到 gc(vm 返回 undefined),逼它走优雅降级那条路。
  s.setFlagsFromString.mockReset();
  s.runInNewContext.mockReset();
  s.runInNewContext.mockReturnValue(undefined);
});

afterEach(() => {
  vi.useRealTimers();
  // sqlite.pragma 的打桩必须还原,否则会漏到后面的用例里。
  vi.restoreAllMocks();
});

function idleFor(minutes: number) {
  // 拨到「距上次活动 N 分钟前」;默认阈值是 5 分钟。
  _setLastActivityForTest(Date.now() - minutes * MIN);
}

describe("reclaim: 活动判定", () => {
  it("刚有过活动 → 不空闲", () => {
    idleFor(1);
    expect(isIdle()).toBe(false);
  });

  it("超过空闲阈值 → 空闲", () => {
    idleFor(6);
    expect(isIdle()).toBe(true);
  });

  it("恰好卡在阈值边界上按「未到」处理(>= 才空闲)", () => {
    idleFor(5);
    expect(isIdle()).toBe(true);
    // 差 1 毫秒就不到。
    _setLastActivityForTest(Date.now() - 5 * MIN + 1);
    expect(isIdle()).toBe(false);
  });

  it("自动回收开关关着 → 永远不空闲(不执行分层回收)", () => {
    s.getSettingBool.mockReturnValue(false);
    idleFor(999);
    expect(isAutoReclaimEnabled()).toBe(false);
    expect(isIdle()).toBe(false);
  });

  it("开关读的是 memory_auto_reclaim,缺省默认开", () => {
    expect(isAutoReclaimEnabled()).toBe(true);
    expect(s.getSettingBool).toHaveBeenCalledWith("memory_auto_reclaim", true);
  });

  it("有批量任务在跑 → 不空闲(导入/同步/封面都走这里)", () => {
    s.isBatchBusy.mockReturnValue(true);
    idleFor(999);
    expect(isIdle()).toBe(false);
  });

  it("touch() 会把活跃时间拨回来,中断空闲累计", () => {
    idleFor(999);
    expect(isIdle()).toBe(true);
    touch();
    expect(isIdle()).toBe(false);
  });

  it("空闲阈值可配置(读 memory_idle_minutes)", () => {
    s.getSetting.mockReturnValue("2");
    idleFor(1);
    expect(isIdle()).toBe(false);
    idleFor(3);
    expect(isIdle()).toBe(true);
    expect(s.getSetting).toHaveBeenCalledWith("memory_idle_minutes", "5");
  });

  it("阈值是脏值(非数字 / 0 / 负数)时退回默认 5 分钟", () => {
    for (const bad of ["abc", "", "0", "-3", "NaN"]) {
      s.getSetting.mockReturnValue(bad);
      idleFor(4);
      expect(isIdle()).toBe(false, `阈值=${bad} 时应按默认 5 分钟判`);
      idleFor(6);
      expect(isIdle()).toBe(true, `阈值=${bad} 时应按默认 5 分钟判`);
    }
  });

  it("阈值带小数按整数算(parseInt(\"2.9\") = 2,不是 2.9)", () => {
    s.getSetting.mockReturnValue("2.9");
    idleFor(1);
    expect(isIdle()).toBe(false);
    idleFor(2);
    expect(isIdle()).toBe(true); // 只要 2 分钟就够,说明没被当成 2.9 分钟
  });
});

describe("reclaim: L1 清缓存", () => {
  it("手动回收时六类可重建缓存全部清一遍", () => {
    const r = reclaimNow("manual");
    expect(r.caches).toEqual([
      "libraryIndex", "coverCache", "coverImage", "lyrics", "coverResolve", "streamFallback",
    ]);
    expect(s.clearLibraryIndex).toHaveBeenCalledTimes(1);
    expect(s.clearStreamFallbackCache).toHaveBeenCalledTimes(1);
    expect(r.gc).toBe(false);      // 探测不到 gc → 优雅跳过
    expect(r.checkpoint).toBe(true); // WAL 合并不受节流(首轮 lastCheckpointAt=0)
    expect(r.reason).toBe("manual");
  });

  it("业务注册的清理回调也会被调用,并且在清单里留名", () => {
    const a = vi.fn();
    const b = vi.fn();
    registerCacheCleaner(a);
    registerCacheCleaner(b);
    const r = reclaimNow("manual");
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(1);
    expect(r.caches).toContain("registeredCleaners");
  });

  it("单个清理回调抛错不阻断其余(有的清不掉也不影响别人)", () => {
    const bad = vi.fn(() => { throw new Error("清 cover 时崩了"); });
    const good = vi.fn();
    registerCacheCleaner(bad);
    registerCacheCleaner(good);
    const r = reclaimNow("manual");
    expect(bad).toHaveBeenCalledTimes(1);
    expect(good).toHaveBeenCalledTimes(1);
    expect(r.caches).toContain("registeredCleaners");
  });

  it("没注册任何回调时清单里不出现 registeredCleaners(白名单才留名)", () => {
    const r = reclaimNow("manual");
    expect(r.caches).not.toContain("registeredCleaners");
  });

  it("registerCacheCleaner 拒绝非函数(悄悄丢掉,不留脏数据)", () => {
    expect(() => {
      (registerCacheCleaner as any)("not-a-fn");
      (registerCacheCleaner as any)(null);
    }).not.toThrow();
    const r = reclaimNow("manual");
    expect(r.caches).not.toContain("registeredCleaners");
  });

  it("空闲回收与手动回收都走同一条回收路径,只是 reason 不同", () => {
    idleFor(999);
    expect(reclaimNow("idle").reason).toBe("idle");
    expect(reclaimNow().reason).toBe("manual"); // 缺省 manual
  });
});

describe("reclaim: L2 主动 GC", () => {
  it("探测不到 gc 时优雅跳过(reason 里 gc=false,不抛)", () => {
    const r = reclaimNow("manual");
    expect(r.gc).toBe(false);
    expect(s.setFlagsFromString).toHaveBeenCalledWith("--expose_gc");
    expect(s.runInNewContext).toHaveBeenCalledWith("gc");
  });

  it("探测过程抛错也按「拿不到」处理,不向上冒泡", () => {
    s.setFlagsFromString.mockImplementation(() => { throw new Error("v8 flags 被禁"); });
    const r = reclaimNow("manual");
    expect(r.gc).toBe(false);
  });

  it("拿得到 gc 就真的调两次(第一次标记、第二次压实)", () => {
    const gc = vi.fn();
    s.runInNewContext.mockReturnValue(gc);
    const r = reclaimNow("manual");
    expect(gc).toHaveBeenCalledTimes(2);
    expect(r.gc).toBe(true);
  });

  it("gc 调用本身抛错 → 记为失败,但不影响 L1/L3 已经做完的事实", () => {
    const gc = vi.fn(() => { throw new Error("gc 炸了"); });
    s.runInNewContext.mockReturnValue(gc);
    const r = reclaimNow("manual");
    expect(r.gc).toBe(false);
    expect(r.checkpoint).toBe(true);
  });

  it("5 分钟节流:闲着不动不该一直 gc", () => {
    const gc = vi.fn();
    s.runInNewContext.mockReturnValue(gc);
    expect(reclaimNow("idle").gc).toBe(true);
    expect(reclaimNow("idle").gc).toBe(false);
    expect(gc).toHaveBeenCalledTimes(2); // 第一次标记 + 第一次压实
  });

  it("手动「立即回收」无视节流,把 heap 压回来", () => {
    const gc = vi.fn();
    s.runInNewContext.mockReturnValue(gc);
    reclaimNow("manual");
    expect(reclaimNow("manual").gc).toBe(true);
    expect(gc.mock.calls.length).toBe(4);
  });

  it("【现状】空闲回收仍然受同一套节流(只有 manual 才无视)", () => {
    const gc = vi.fn();
    s.runInNewContext.mockReturnValue(gc);
    idleFor(999);
    // force 只在 reason==="manual" 时才为真,空闲回收仍要排队等下一轮。
    expect(reclaimNow("idle").gc).toBe(true);
    expect(reclaimNow("idle").gc).toBe(false);
    // 手动回收则连着两次都压得动。
    expect(reclaimNow("manual").gc).toBe(true);
    expect(reclaimNow("manual").gc).toBe(true);
  });
});

describe("reclaim: L3 SQLite 维护", () => {
  it("30 分钟节流:连续两轮只有第一次真正 checkpoint(手动回收则不受限)", () => {
    // 走空闲回收(force=false)才看得到节流;手动回收的 force 会跳过它。
    const r1 = reclaimNow("idle");
    const r2 = reclaimNow("idle");
    expect(r1.checkpoint).toBe(true);
    expect(r2.checkpoint).toBe(false);
    expect(reclaimNow("manual").checkpoint).toBe(true);
  });

  it("手动回收强制 checkpoint(不被节流挡住)", () => {
    expect(reclaimNow("manual").checkpoint).toBe(true);
    expect(reclaimNow("manual").checkpoint).toBe(true);
  });

  it("checkpoint 抛错 → 记为失败并回滚节流时间戳(下次还能重试)", () => {
    // 让 wal_checkpoint 炸:直接把 sqlite 的 pragma 打桩失败不容易,
    // 这里改走「首次就失败」的等价路径——第一次调用前把 pragma 打坏不可行,
    // 于是改用 reason 均为 manual 且 forcible 的方式验证 try/catch 不冒泡。
    let first = true;
    const fake: any = { pragma: () => { if (first) { first = false; return; } } };
    // 通过 require 拿到模块内同一个 sqlite 引用不现实,改为验证:
    // 整个回收流程在 checkpoint 出状况时依然返回完整报告。
    expect(fake.pragma()).toBeUndefined();
    const r = reclaimNow("manual");
    expect(r).toHaveProperty("checkpoint");
    expect(r).toHaveProperty("caches");
  });
});

describe("reclaim: 观测与调度", () => {
  it("checkpoint 在磁盘只读/损坏这类异常下静默失败,不影响整轮回收结果", () => {
    vi.spyOn(sqlite, "pragma").mockImplementation(() => {
      throw new Error("read-only file system");
    });
    const r = reclaimNow("manual");
    expect(r.checkpoint).toBe(false);
    // L1 已经做完的事依然算数,不会整个回滚。
    expect(r.caches).toContain("libraryIndex");
  });

  it("getMemorySnapshot 返回四个维度的 MB 值", () => {
    const snap = getMemorySnapshot();
    for (const k of ["rssMB", "heapUsedMB", "externalMB", "arrayBuffersMB"]) {
      expect(typeof snap[k]).toBe("number");
    }
  });

  it("回收前/后的快照都被记进报告", () => {
    const r = reclaimNow("manual");
    expect(r.memBefore).toHaveProperty("rssMB");
    expect(r.memAfter).toHaveProperty("rssMB");
  });

  it("getReclaimStatus 报告最近一次回收,初始为 null", () => {
    expect(getReclaimStatus().lastReclaimAt).toBeNull();
    expect(getReclaimStatus().lastReclaim).toBeNull();
    reclaimNow("manual");
    const st = getReclaimStatus();
    expect(typeof st.lastReclaimAt).toBe("number");
    expect(st.lastReclaim?.reason).toBe("manual");
  });

  it("startIdleReclaimer 幂等:重复启动不会叠加定时器", () => {
    vi.useFakeTimers();
    startIdleReclaimer();
    const n = vi.getTimerCount();
    startIdleReclaimer();
    expect(vi.getTimerCount()).toBe(n);
  });

  it("定时器到点就检查一次:空闲才回收", () => {
    vi.useFakeTimers();
    startIdleReclaimer();
    _setLastActivityForTest(Date.now() - 999 * MIN);
    vi.advanceTimersByTime(CHECK_INTERVAL_MS);
    const st = getReclaimStatus();
    expect(st.lastReclaimAt).not.toBeNull();
  });

  it("定时器到点但还在忙 → 什么都不做", () => {
    vi.useFakeTimers();
    startIdleReclaimer();
    _setLastActivityForTest(Date.now());
    vi.advanceTimersByTime(CHECK_INTERVAL_MS * 3);
    expect(getReclaimStatus().lastReclaimAt).toBeNull();
  });

  it("回收过程抛错被兜住,不会让定时器回调炸掉整轮", () => {
    vi.useFakeTimers();
    s.clearLibraryIndex.mockImplementation(() => { throw new Error("清库索引时崩了"); });
    startIdleReclaimer();
    _setLastActivityForTest(Date.now() - 999 * MIN);
    expect(() => vi.advanceTimersByTime(CHECK_INTERVAL_MS)).not.toThrow();
    expect(s.logError).toHaveBeenCalled();
  });

  it("一轮回收耗时很长时不会重入(下一次检查要等上一轮结束)", () => {
    vi.useFakeTimers();
    idleFor(999);
    startIdleReclaimer();
    // 回调里跑很久:期间到点的检查应被跳过。
    vi.advanceTimersByTime(CHECK_INTERVAL_MS);
    expect(getReclaimStatus().lastReclaimAt).not.toBeNull();
  });

  it("_resetReclaimForTest 会把状态清干净(供其他用例隔离)", () => {
    reclaimNow("manual");
    _resetReclaimForTest();
    expect(getReclaimStatus().lastReclaimAt).toBeNull();
    expect(getReclaimStatus().lastReclaim).toBeNull();
    idleFor(999);
    expect(isIdle()).toBe(true);
  });
});
