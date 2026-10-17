// libraryScheduler 定时自动全库下载调度单元测试。
//
// 覆盖三块：
//   - runAutoLibraryOnce：interval / time-of-day / busy 三道闸门；空批直接 done、
//     非空批建任务并置会话标记；intervalDays 与 libraryBatchLimit 的边界夹取；
//   - resumeLibrarySession：会话标记 + 自动续批开关 + 活动任务 + 待下项 的各分支；
//   - startLibraryScheduler：幂等挂载，tick 的重入守卫 / 关闭开关 / 接续链 / 周期触发 / 异常吞掉。
//
// 全程 vi.mock 打桩外围依赖：零真实网络 / 零真实子进程；库查询走 better-sqlite3 真实连接，
// 仅对 fetch_jobs 计数查询用 spy 控制（settings 亦已打桩，避免 5s TTL 缓存带来的顺序耦合）。
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ==================== 模块打桩（vi.mock 会被提升到 import 之前） ====================
vi.mock("../../src/services/settings.js", () => ({
  getSetting: vi.fn(),
  setSetting: vi.fn(),
}));
vi.mock("../../src/services/fetch/configStore.js", () => ({
  currentFetchConfig: vi.fn(),
}));
vi.mock("../../src/services/fetch/library.js", () => ({
  buildLibraryContinuation: vi.fn(),
  buildLibraryJobConfig: vi.fn(),
  buildLibraryPlan: vi.fn(),
  buildLibraryTargets: vi.fn(),
}));
vi.mock("../../src/services/fetch/jobStore.js", () => ({
  createFetchJob: vi.fn(),
  updateFetchJobStatus: vi.fn(),
}));
vi.mock("../../src/services/fetch/jobRunner.js", () => ({
  startFetchJob: vi.fn(),
  BOOT_RESUME_DELAY_MS: 60_000,
}));
vi.mock("../../src/services/fetch/autoSession.js", () => ({
  isAutoSessionActive: vi.fn(),
  setAutoSession: vi.fn(),
}));
// libraryScheduler 仅借用 todayTriggerMs：整体打桩以便自由控制「到点」判定。
vi.mock("../../src/services/fetch/upgradeScheduler.js", () => ({
  todayTriggerMs: vi.fn(),
}));

import { sqlite } from "../../src/db/index.js";
import { getSetting, setSetting } from "../../src/services/settings.js";
import { currentFetchConfig } from "../../src/services/fetch/configStore.js";
import {
  buildLibraryContinuation,
  buildLibraryJobConfig,
  buildLibraryPlan,
  buildLibraryTargets,
} from "../../src/services/fetch/library.js";
import { createFetchJob, updateFetchJobStatus } from "../../src/services/fetch/jobStore.js";
import { startFetchJob } from "../../src/services/fetch/jobRunner.js";
import { isAutoSessionActive, setAutoSession } from "../../src/services/fetch/autoSession.js";
import { todayTriggerMs } from "../../src/services/fetch/upgradeScheduler.js";
import {
  resumeLibrarySession,
  runAutoLibraryOnce,
  startLibraryScheduler,
} from "../../src/services/fetch/libraryScheduler.js";
import type { FetchConfig } from "../../src/services/fetch/config.js";

// ==================== 公用件 ====================

const NOW = 1_800_000_000_000;
const realPrepare = sqlite.prepare.bind(sqlite);

/** 活动任务计数：驱动 fetch_jobs 的 busy 判定（默认 0 = 无任务在跑）。 */
let busyN = 0;
let prepareSpy: any;

/** 构造最小 FetchConfig（只填本调度器读取的字段）。 */
function cfg(over: Partial<FetchConfig> = {}): FetchConfig {
  return {
    libraryAutoEnabled: true,
    libraryAutoIntervalDays: 1,
    libraryAutoTimeOfDay: "03:00",
    libraryAutoContinue: true,
    libraryBatchLimit: 500,
    ...over,
  } as FetchConfig;
}

beforeEach(() => {
  vi.resetAllMocks();
  busyN = 0;
  // 只拦 fetch_jobs 计数查询，其余（settings 等）走真实连接。
  prepareSpy = vi.spyOn(sqlite, "prepare").mockImplementation(((sql: any) => {
    if (String(sql).includes("fetch_jobs")) return { get: () => ({ n: busyN }) } as any;
    return realPrepare(sql);
  }) as any);
  vi.mocked(getSetting).mockReturnValue("0");
  vi.mocked(currentFetchConfig).mockReturnValue(cfg());
  vi.mocked(todayTriggerMs).mockReturnValue(1); // 默认视为「今天已到点」
  vi.mocked(buildLibraryJobConfig).mockReturnValue({ __library: { migrateRowOnly: true } } as any);
  vi.mocked(buildLibraryPlan).mockReturnValue({ items: [{ songId: "s1" }] } as any);
  vi.mocked(buildLibraryTargets).mockReturnValue([{ id: "library:s1" }] as any);
  vi.mocked(createFetchJob).mockReturnValue({ id: "job-1" } as any);
  vi.mocked(isAutoSessionActive).mockReturnValue(false);
  vi.mocked(buildLibraryContinuation).mockReturnValue({ job: null, enqueued: 0, remaining: 0 } as any);
});

afterEach(() => {
  prepareSpy?.mockRestore();
});

// ==================== runAutoLibraryOnce：闸门与建批 ====================

describe("runAutoLibraryOnce — 闸门与建批", () => {
  it("interval 闸：距上次成功评估不足 N 天 → 不触发且不落 lastRunAt", () => {
    vi.mocked(getSetting).mockReturnValue(String(NOW - 1000));
    expect(runAutoLibraryOnce(cfg({ libraryAutoIntervalDays: 1 }), NOW)).toEqual({
      triggered: false,
      reason: "interval",
    });
    expect(setSetting).not.toHaveBeenCalled();
  });

  it("time-of-day 闸：非法时刻（triggerMs<=0）与未到点 → 均不触发", () => {
    vi.mocked(todayTriggerMs).mockReturnValue(0);
    expect(runAutoLibraryOnce(cfg(), NOW).reason).toBe("time-of-day");
    vi.mocked(todayTriggerMs).mockReturnValue(NOW + 10_000);
    expect(runAutoLibraryOnce(cfg(), NOW).reason).toBe("time-of-day");
  });

  it("busy 闸：有活动任务 → busy，且不落 lastRunAt、不建任务", () => {
    busyN = 2;
    expect(runAutoLibraryOnce(cfg(), NOW)).toEqual({ triggered: false, reason: "busy" });
    expect(setSetting).not.toHaveBeenCalled();
    expect(createFetchJob).not.toHaveBeenCalled();
  });

  it("lastRunAt 非法字符串 → 视作 0（放行 interval 闸）", () => {
    vi.mocked(getSetting).mockReturnValue("not-a-number");
    expect(runAutoLibraryOnce(cfg(), NOW).triggered).toBe(true);
  });

  it("空批：落 lastRunAt + 建任务后直接落 done，不启动", () => {
    vi.mocked(buildLibraryTargets).mockReturnValue([] as any);
    expect(runAutoLibraryOnce(cfg(), NOW)).toEqual({
      triggered: true,
      reason: "empty",
      enqueued: 0,
      jobId: "job-1",
    });
    expect(setSetting).toHaveBeenCalledWith("fetch.library.auto.lastRunAt", String(NOW));
    expect(updateFetchJobStatus).toHaveBeenCalledWith("job-1", "done");
    expect(startFetchJob).not.toHaveBeenCalled();
  });

  it("非空批：落 lastRunAt + 启动任务 + 置会话标记", () => {
    const r = runAutoLibraryOnce(cfg(), NOW);
    expect(r).toEqual({ triggered: true, reason: "started", enqueued: 1, jobId: "job-1" });
    expect(setSetting).toHaveBeenCalledWith("fetch.library.auto.lastRunAt", String(NOW));
    expect(startFetchJob).toHaveBeenCalledWith("job-1");
    expect(setAutoSession).toHaveBeenCalledWith("library", true);
    expect(buildLibraryPlan).toHaveBeenCalledWith(expect.anything(), { limit: 500 });
  });

  it("intervalDays 夹取：<=0 视作 1、>365 视作 365", () => {
    // <=0 被夹到 1：半天前仍算「未到 1 天间隔」→ interval（未夹取时 0 天则放行）
    vi.mocked(getSetting).mockReturnValue(String(NOW - 12 * 3_600_000));
    expect(runAutoLibraryOnce(cfg({ libraryAutoIntervalDays: 0 }), NOW).reason).toBe("interval");
    // >365：370 天前已越过（被夹到 365）→ 放行 interval 闸
    vi.mocked(getSetting).mockReturnValue(String(NOW - 370 * 86_400_000));
    expect(runAutoLibraryOnce(cfg({ libraryAutoIntervalDays: 400 }), NOW).triggered).toBe(true);
  });

  it("libraryBatchLimit 为 0 → 回落 500；显式 10 → 用 10", () => {
    runAutoLibraryOnce(cfg({ libraryBatchLimit: 0 }), NOW);
    expect(buildLibraryPlan).toHaveBeenLastCalledWith(expect.anything(), { limit: 500 });
    runAutoLibraryOnce(cfg({ libraryBatchLimit: 10 }), NOW);
    expect(buildLibraryPlan).toHaveBeenLastCalledWith(expect.anything(), { limit: 10 });
  });
});

// ==================== resumeLibrarySession：重启/让渡续批恢复 ====================

describe("resumeLibrarySession — 重启/让渡续批恢复", () => {
  it("会话未激活 → 直接 false，不动标记", () => {
    vi.mocked(isAutoSessionActive).mockReturnValue(false);
    expect(resumeLibrarySession(cfg())).toBe(false);
    expect(setAutoSession).not.toHaveBeenCalled();
    expect(buildLibraryContinuation).not.toHaveBeenCalled();
  });

  it("已激活但自动续批已关闭 → 清标记并 false", () => {
    vi.mocked(isAutoSessionActive).mockReturnValue(true);
    expect(resumeLibrarySession(cfg({ libraryAutoContinue: false }))).toBe(false);
    expect(setAutoSession).toHaveBeenCalledWith("library", false);
    expect(buildLibraryContinuation).not.toHaveBeenCalled();
  });

  it("已激活 + 续批开启 + 有活动任务 → 让渡 false（不建批）", () => {
    vi.mocked(isAutoSessionActive).mockReturnValue(true);
    busyN = 1;
    expect(resumeLibrarySession(cfg({ libraryAutoContinue: true }))).toBe(false);
    expect(buildLibraryContinuation).not.toHaveBeenCalled();
  });

  it("已激活 + 无待下项 → 清标记并 true", () => {
    vi.mocked(isAutoSessionActive).mockReturnValue(true);
    vi.mocked(buildLibraryContinuation).mockReturnValue({ job: null, enqueued: 0, remaining: 0 } as any);
    expect(resumeLibrarySession(cfg({ libraryAutoContinue: true }))).toBe(true);
    expect(setAutoSession).toHaveBeenCalledWith("library", false);
    expect(startFetchJob).not.toHaveBeenCalled();
  });

  it("已激活 + 有待下项 → 开下一批并 true", () => {
    vi.mocked(isAutoSessionActive).mockReturnValue(true);
    vi.mocked(buildLibraryContinuation).mockReturnValue({
      job: { id: "next-lib" },
      enqueued: 3,
      remaining: 1,
    } as any);
    expect(resumeLibrarySession(cfg({ libraryAutoContinue: true }))).toBe(true);
    expect(setAutoSession).toHaveBeenCalledWith("library", true);
    expect(startFetchJob).toHaveBeenCalledWith("next-lib");
  });
});

// ==================== startLibraryScheduler：挂载与 tick ====================

describe("startLibraryScheduler — 挂载与 tick", () => {
  it("幂等挂载：只注册一次定时器，tick 覆盖各分支", () => {
    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout").mockImplementation((() => 0) as any);
    const setIntervalSpy = vi.spyOn(globalThis, "setInterval").mockImplementation((() => 0) as any);
    try {
      startLibraryScheduler();
      startLibraryScheduler(); // 第二次应被 started 守卫挡下
      expect(setTimeoutSpy).toHaveBeenCalledTimes(1);
      expect(setIntervalSpy).toHaveBeenCalledTimes(1);
      const tick = setTimeoutSpy.mock.calls[0][0] as () => void;

      // 关闭总开关 → 直接返回，不建任务。
      vi.mocked(currentFetchConfig).mockReturnValue(cfg({ libraryAutoEnabled: false }));
      tick();
      expect(createFetchJob).not.toHaveBeenCalled();

      // 重入守卫：tick 执行中再次调用 tick（ticking=true）应立即返回。
      let reentered = false;
      vi.mocked(currentFetchConfig).mockImplementation(() => {
        if (!reentered) {
          reentered = true;
          tick();
        }
        return cfg({ libraryAutoEnabled: false });
      });
      tick();
      expect(reentered).toBe(true);

      // 接续链：会话激活 + 有待下项 → resume 接管，不开新周期。
      vi.mocked(currentFetchConfig).mockReturnValue(cfg({ libraryAutoEnabled: true }));
      vi.mocked(isAutoSessionActive).mockReturnValue(true);
      vi.mocked(buildLibraryContinuation).mockReturnValue({
        job: { id: "cont-lib" },
        enqueued: 1,
        remaining: 0,
      } as any);
      tick();
      expect(startFetchJob).toHaveBeenCalledWith("cont-lib");

      // 正常周期：会话未激活 → resume false → runAutoLibraryOnce 建任务。
      vi.mocked(isAutoSessionActive).mockReturnValue(false);
      tick();
      expect(createFetchJob).toHaveBeenCalled();

      // 异常分支：currentFetchConfig 抛错被 tick 吞掉，不向外冒。
      vi.mocked(currentFetchConfig).mockImplementation(() => {
        throw new Error("boom");
      });
      expect(() => tick()).not.toThrow();
    } finally {
      setTimeoutSpy.mockRestore();
      setIntervalSpy.mockRestore();
    }
  });
});
