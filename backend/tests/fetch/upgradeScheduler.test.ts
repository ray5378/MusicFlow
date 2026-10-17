// upgradeScheduler 定时自动洗版调度单元测试。
//
// 覆盖四块：
//   - todayTriggerMs：合法 HH:mm（含一位数小时 / 前后空白）与各类非法格式；
//   - runAutoUpgradeOnce：interval / time-of-day / busy 三道闸门；空批直接 done、
//     有可洗项记尝试 + 启动 + 置会话标记；hasActiveFetchJobs 查询抛错时保守判 busy；
//   - resumeUpgradeSession：会话标记 + 自动续批开关 + 活动任务 + 可洗项 的各分支；
//   - startUpgradeScheduler：幂等挂载，tick 的过期任务清理窗口 / 开关 / 接续链 / 周期触发 / 异常吞掉。
//
// 全程 vi.mock 打桩外围依赖：零真实网络 / 零真实子进程；库查询走 better-sqlite3 真实连接，
// 仅对 fetch_jobs 计数查询用 spy 控制（settings 亦已打桩）。
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ==================== 模块打桩（vi.mock 会被提升到 import 之前） ====================
vi.mock("../../src/services/settings.js", () => ({
  getSetting: vi.fn(),
  setSetting: vi.fn(),
}));
vi.mock("../../src/services/fetch/configStore.js", () => ({
  currentFetchConfig: vi.fn(),
}));
vi.mock("../../src/services/fetch/upgrade.js", () => ({
  buildUpgradeContinuation: vi.fn(),
  buildUpgradeJobConfig: vi.fn(),
  buildUpgradePlan: vi.fn(),
  buildUpgradeTargets: vi.fn(),
  recordUpgradeAttempts: vi.fn(),
  resolveUpgradeSourceIds: vi.fn(),
}));
vi.mock("../../src/services/fetch/jobStore.js", () => ({
  createFetchJob: vi.fn(),
  updateFetchJobStatus: vi.fn(),
  cleanExpiredFetchJobs: vi.fn(),
}));
vi.mock("../../src/services/fetch/jobRunner.js", () => ({
  startFetchJob: vi.fn(),
}));
vi.mock("../../src/services/fetch/autoSession.js", () => ({
  isAutoSessionActive: vi.fn(),
  setAutoSession: vi.fn(),
}));

import { sqlite } from "../../src/db/index.js";
import { getSetting, setSetting } from "../../src/services/settings.js";
import { currentFetchConfig } from "../../src/services/fetch/configStore.js";
import {
  buildUpgradeContinuation,
  buildUpgradeJobConfig,
  buildUpgradePlan,
  buildUpgradeTargets,
  recordUpgradeAttempts,
  resolveUpgradeSourceIds,
} from "../../src/services/fetch/upgrade.js";
import { cleanExpiredFetchJobs, createFetchJob, updateFetchJobStatus } from "../../src/services/fetch/jobStore.js";
import { startFetchJob } from "../../src/services/fetch/jobRunner.js";
import { isAutoSessionActive, setAutoSession } from "../../src/services/fetch/autoSession.js";
import {
  resumeUpgradeSession,
  runAutoUpgradeOnce,
  startUpgradeScheduler,
  todayTriggerMs,
} from "../../src/services/fetch/upgradeScheduler.js";
import type { FetchConfig } from "../../src/services/fetch/config.js";

// ==================== 公用件 ====================

const realPrepare = sqlite.prepare.bind(sqlite);

/** 活动任务计数：驱动 fetch_jobs 的 busy 判定（默认 0 = 无任务在跑）。 */
let busyN = 0;
let prepareSpy: any;

/** 构造「今天 hh:00」的本地时间戳，规避服务器时区差异导致的门禁抖动。 */
function local(h: number, min = 0): number {
  return new Date(2026, 0, 15, h, min, 0, 0).getTime();
}

const NOW = local(12);

/** 构造最小 FetchConfig（只填本调度器读取的字段）。 */
function cfg(over: Partial<FetchConfig> = {}): FetchConfig {
  return {
    upgradeAutoEnabled: true,
    upgradeAutoIntervalDays: 30,
    upgradeAutoTimeOfDay: "03:00",
    upgradeAutoContinue: true,
    jobRetentionDays: 30,
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
  vi.mocked(buildUpgradeJobConfig).mockReturnValue({ __upgrade: {} } as any);
  vi.mocked(resolveUpgradeSourceIds).mockReturnValue(["src-1"] as any);
  vi.mocked(buildUpgradePlan).mockReturnValue({ items: [{ songId: "s1" }] } as any);
  vi.mocked(buildUpgradeTargets).mockReturnValue([{ id: "t1" }] as any);
  vi.mocked(createFetchJob).mockReturnValue({ id: "job-1" } as any);
  vi.mocked(isAutoSessionActive).mockReturnValue(false);
  vi.mocked(buildUpgradeContinuation).mockReturnValue({ job: null, enqueued: 0, remaining: 0 } as any);
});

afterEach(() => {
  prepareSpy?.mockRestore();
});

// ==================== todayTriggerMs：时刻解析 ====================

describe("todayTriggerMs — 「HH:mm」→ 当日该时刻本地时间戳", () => {
  it("合法格式：标准 / 一位数小时 / 前后空白", () => {
    const now = local(1);
    expect(todayTriggerMs("03:05", new Date(now))).toBe(local(3, 5));
    expect(todayTriggerMs("3:05", new Date(now))).toBe(local(3, 5));
    expect(todayTriggerMs("  23:59  ", new Date(now))).toBe(local(23, 59));
  });

  it("非法格式：一律返回 0（视为永不触发）", () => {
    const now = new Date(local(1));
    for (const bad of ["", "abc", "25:00", "12:60", "12", "12:5", null as any, undefined as any]) {
      expect(todayTriggerMs(bad, now)).toBe(0);
    }
  });
});

// ==================== runAutoUpgradeOnce：闸门与建批 ====================

describe("runAutoUpgradeOnce — 闸门与建批", () => {
  it("interval 闸：距上次成功评估不足 N 天 → 不触发且不落 lastRunAt", () => {
    vi.mocked(getSetting).mockReturnValue(String(NOW - 1000));
    expect(runAutoUpgradeOnce(cfg({ upgradeAutoIntervalDays: 30 }), NOW)).toEqual({
      triggered: false,
      reason: "interval",
    });
    expect(setSetting).not.toHaveBeenCalled();
  });

  it("time-of-day 闸：非法时刻与未到点 → 均不触发", () => {
    expect(runAutoUpgradeOnce(cfg({ upgradeAutoTimeOfDay: "abc" }), local(12)).reason).toBe("time-of-day");
    expect(runAutoUpgradeOnce(cfg({ upgradeAutoTimeOfDay: "03:00" }), local(1)).reason).toBe("time-of-day");
  });

  it("busy 闸：有活动任务 → busy，且不落 lastRunAt、不建任务", () => {
    busyN = 3;
    expect(runAutoUpgradeOnce(cfg(), NOW)).toEqual({ triggered: false, reason: "busy" });
    expect(setSetting).not.toHaveBeenCalled();
    expect(createFetchJob).not.toHaveBeenCalled();
  });

  it("busy 查询抛错 → 保守视为有任务在跑（busy）", () => {
    prepareSpy.mockImplementation(((sql: any) => {
      if (String(sql).includes("fetch_jobs")) throw new Error("db down");
      return realPrepare(sql);
    }) as any);
    expect(runAutoUpgradeOnce(cfg(), NOW)).toEqual({ triggered: false, reason: "busy" });
  });

  it("intervalDays 夹取：<=0 视作 30、>365 视作 365", () => {
    // <=0：10 天前仍算「未到 30 天间隔」→ interval
    vi.mocked(getSetting).mockReturnValue(String(NOW - 10 * 86_400_000));
    expect(runAutoUpgradeOnce(cfg({ upgradeAutoIntervalDays: 0 }), NOW).reason).toBe("interval");
    // >365：370 天前已越过（被夹到 365）→ 放行 interval 闸
    vi.mocked(getSetting).mockReturnValue(String(NOW - 370 * 86_400_000));
    expect(runAutoUpgradeOnce(cfg({ upgradeAutoIntervalDays: 400 }), NOW).triggered).toBe(true);
  });

  it("有可洗项：记尝试 + 落 lastRunAt + 启动 + 置会话标记", () => {
    vi.mocked(buildUpgradePlan).mockReturnValue({ items: [{ songId: "s1" }, { songId: "s2" }] } as any);
    vi.mocked(buildUpgradeTargets).mockReturnValue([{ id: "t1" }, { id: "t2" }] as any);
    const r = runAutoUpgradeOnce(cfg(), NOW);
    expect(r).toEqual({ triggered: true, reason: "started", enqueued: 2, jobId: "job-1" });
    expect(recordUpgradeAttempts).toHaveBeenCalledWith("job-1", ["s1", "s2"]);
    expect(resolveUpgradeSourceIds).toHaveBeenCalledWith(cfg());
    expect(setSetting).toHaveBeenCalledWith("fetch.upgrade.auto.lastRunAt", String(NOW));
    expect(startFetchJob).toHaveBeenCalledWith("job-1");
    expect(setAutoSession).toHaveBeenCalledWith("upgrade", true);
  });

  it("无可洗项：只落 lastRunAt + 任务直接落 done", () => {
    vi.mocked(buildUpgradePlan).mockReturnValue({ items: [] } as any);
    vi.mocked(buildUpgradeTargets).mockReturnValue([] as any);
    expect(runAutoUpgradeOnce(cfg(), NOW)).toEqual({
      triggered: true,
      reason: "empty",
      enqueued: 0,
      jobId: "job-1",
    });
    expect(recordUpgradeAttempts).not.toHaveBeenCalled();
    expect(updateFetchJobStatus).toHaveBeenCalledWith("job-1", "done");
    expect(startFetchJob).not.toHaveBeenCalled();
  });

  it("有可洗项但 target 为空：仍记尝试，任务直接落 done", () => {
    vi.mocked(buildUpgradePlan).mockReturnValue({ items: [{ songId: "s1" }] } as any);
    vi.mocked(buildUpgradeTargets).mockReturnValue([] as any);
    const r = runAutoUpgradeOnce(cfg(), NOW);
    expect(r.reason).toBe("empty");
    expect(recordUpgradeAttempts).toHaveBeenCalledWith("job-1", ["s1"]);
    expect(startFetchJob).not.toHaveBeenCalled();
  });
});

// ==================== resumeUpgradeSession：重启/让渡续批恢复 ====================

describe("resumeUpgradeSession — 重启/让渡续批恢复", () => {
  it("会话未激活 → 直接 false，不动标记", () => {
    vi.mocked(isAutoSessionActive).mockReturnValue(false);
    expect(resumeUpgradeSession(cfg())).toBe(false);
    expect(setAutoSession).not.toHaveBeenCalled();
    expect(buildUpgradeContinuation).not.toHaveBeenCalled();
  });

  it("已激活但自动续批已关闭 → 清标记并 false", () => {
    vi.mocked(isAutoSessionActive).mockReturnValue(true);
    expect(resumeUpgradeSession(cfg({ upgradeAutoContinue: false }))).toBe(false);
    expect(setAutoSession).toHaveBeenCalledWith("upgrade", false);
    expect(buildUpgradeContinuation).not.toHaveBeenCalled();
  });

  it("已激活 + 续批开启 + 有活动任务 → 让渡 false（不建批）", () => {
    vi.mocked(isAutoSessionActive).mockReturnValue(true);
    busyN = 1;
    expect(resumeUpgradeSession(cfg({ upgradeAutoContinue: true }))).toBe(false);
    expect(buildUpgradeContinuation).not.toHaveBeenCalled();
  });

  it("已激活 + 无可洗项 → 清标记并 true", () => {
    vi.mocked(isAutoSessionActive).mockReturnValue(true);
    vi.mocked(buildUpgradeContinuation).mockReturnValue({ job: null, enqueued: 0, remaining: 0 } as any);
    expect(resumeUpgradeSession(cfg({ upgradeAutoContinue: true }))).toBe(true);
    expect(setAutoSession).toHaveBeenCalledWith("upgrade", false);
    expect(startFetchJob).not.toHaveBeenCalled();
  });

  it("已激活 + 有可洗项 → 开下一批并 true", () => {
    vi.mocked(isAutoSessionActive).mockReturnValue(true);
    vi.mocked(buildUpgradeContinuation).mockReturnValue({
      job: { id: "next-up" },
      enqueued: 2,
      remaining: 1,
    } as any);
    expect(resumeUpgradeSession(cfg({ upgradeAutoContinue: true }))).toBe(true);
    expect(setAutoSession).toHaveBeenCalledWith("upgrade", true);
    expect(startFetchJob).toHaveBeenCalledWith("next-up");
  });
});

// ==================== startUpgradeScheduler：挂载与 tick ====================

describe("startUpgradeScheduler — 挂载与 tick", () => {
  it("幂等挂载：只注册一次定时器，tick 覆盖清理 / 开关 / 接续 / 异常各分支", () => {
    const base = NOW;
    let nowVal = base;
    const nowSpy = vi.spyOn(Date, "now").mockImplementation(() => nowVal);
    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout").mockImplementation((() => 0) as any);
    const setIntervalSpy = vi.spyOn(globalThis, "setInterval").mockImplementation((() => 0) as any);
    try {
      startUpgradeScheduler();
      startUpgradeScheduler(); // 第二次应被 started 守卫挡下
      expect(setTimeoutSpy).toHaveBeenCalledTimes(1);
      expect(setIntervalSpy).toHaveBeenCalledTimes(1);
      const tick = setTimeoutSpy.mock.calls[0][0] as () => void;

      // 1) 首次 tick：清理窗口到 + 清理返回 >0（log 真分支）；总开关关闭 → 直接返回。
      vi.mocked(cleanExpiredFetchJobs).mockReturnValue(5);
      vi.mocked(currentFetchConfig).mockReturnValue(cfg({ upgradeAutoEnabled: false }));
      tick();
      expect(cleanExpiredFetchJobs).toHaveBeenCalledWith(30);
      expect(createFetchJob).not.toHaveBeenCalled();

      // 2) 推进 2h：清理窗口再到 + 清理返回 0（log 假分支）。
      nowVal = base + 2 * 3_600_000;
      vi.mocked(cleanExpiredFetchJobs).mockReturnValue(0);
      tick();

      // 3) 再推进 2h：清理抛错被内层 catch 吞掉，不影响调度。
      nowVal = base + 4 * 3_600_000;
      vi.mocked(cleanExpiredFetchJobs).mockImplementation(() => {
        throw new Error("clean boom");
      });
      tick();
      vi.mocked(cleanExpiredFetchJobs).mockReturnValue(0);

      // 4) 开启 + 会话激活 + 有可洗项 → resume 接管，开下一批。
      vi.mocked(currentFetchConfig).mockReturnValue(
        cfg({ upgradeAutoEnabled: true, upgradeAutoTimeOfDay: "00:00" }),
      );
      vi.mocked(isAutoSessionActive).mockReturnValue(true);
      vi.mocked(buildUpgradeContinuation).mockReturnValue({
        job: { id: "cont-up" },
        enqueued: 1,
        remaining: 0,
      } as any);
      tick();
      expect(startFetchJob).toHaveBeenCalledWith("cont-up");

      // 5) 会话未激活 → resume false → runAutoUpgradeOnce 建任务。
      vi.mocked(isAutoSessionActive).mockReturnValue(false);
      tick();
      expect(createFetchJob).toHaveBeenCalled();

      // 6) 重入守卫：tick 执行中再次调用 tick 应立即返回。
      let reentered = false;
      vi.mocked(currentFetchConfig).mockImplementation(() => {
        if (!reentered) {
          reentered = true;
          tick();
        }
        return cfg({ upgradeAutoEnabled: false });
      });
      tick();
      expect(reentered).toBe(true);

      // 7) 外层异常：currentFetchConfig 抛错被 tick 吞掉，不向外冒。
      vi.mocked(currentFetchConfig).mockImplementation(() => {
        throw new Error("boom");
      });
      expect(() => tick()).not.toThrow();
    } finally {
      nowSpy.mockRestore();
      setTimeoutSpy.mockRestore();
      setIntervalSpy.mockRestore();
    }
  });
});
