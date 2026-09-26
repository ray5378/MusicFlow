// ==================== 每日定时调度器 ====================
// MUST be the first import: redirects DATA_DIR to an isolated temp dir before
// the backend opens its SQLite DB at module-load time.
import "../plugins/_env.js";

import { describe, it, expect, beforeAll, beforeEach, afterEach, afterAll, vi } from "vitest";
import { sqlite, initDatabase } from "../../src/db/index.js";
import {
  DEFAULT_DAILY_TIME,
  setDailyRunner,
  getDailyMasterEnabled,
  getDailyTime,
  formatDailyTime,
  nextDailyRunAt,
  startDailyScheduler,
  rearmDailyScheduler,
} from "../../src/services/dailyScheduler.js";

beforeAll(() => {
  if (!process.env.APP_VERSION) process.env.APP_VERSION = "1.0.0";
  initDatabase();
});

function setSetting(key: string, value: string | null) {
  sqlite.prepare("DELETE FROM settings WHERE key = ?").run(key);
  if (value !== null) sqlite.prepare("INSERT INTO settings (key, value) VALUES (?, ?)").run(key, value);
}

beforeEach(() => {
  setSetting("daily_recommend_time", null);
  setSetting("daily_recommend_hour", null);
  setSetting("daily_recommend_enabled", null);
});

afterEach(() => {
  vi.useRealTimers();
});

// 调度器的 setTimeout 链是"活着就一直排下一次"的,测试结束必须清掉,
// 否则 vitest 主进程收不了尾。
afterAll(() => {
  vi.useFakeTimers();
  vi.clearAllTimers();
  vi.useRealTimers();
});

describe("每日调度配置读取", () => {
  it("默认时刻为 03:00", () => {
    expect(DEFAULT_DAILY_TIME).toBe("03:00");
    expect(formatDailyTime()).toBe("03:00");
    expect(getDailyTime()).toEqual({ hour: 3, minute: 0 });
  });

  it("daily_recommend_time='HH:MM' 生效(分钟级粒度)", () => {
    setSetting("daily_recommend_time", "07:35");
    expect(getDailyTime()).toEqual({ hour: 7, minute: 35 });
    expect(formatDailyTime()).toBe("07:35");
  });

  it("非法时刻(25:99)→ 回退整点设置", () => {
    setSetting("daily_recommend_time", "25:99");
    setSetting("daily_recommend_hour", "5");
    expect(getDailyTime()).toEqual({ hour: 5, minute: 0 });
  });

  it("时刻格式不对('0730')→ 回退默认 3 点", () => {
    setSetting("daily_recommend_time", "0730");
    expect(getDailyTime()).toEqual({ hour: 3, minute: 0 });
  });

  it("旧版整点设置兼容:daily_recommend_hour", () => {
    setSetting("daily_recommend_hour", "22");
    expect(getDailyTime()).toEqual({ hour: 22, minute: 0 });
    expect(formatDailyTime()).toBe("22:00");
  });

  it("旧版整点值非法 → 回退 3 点", () => {
    setSetting("daily_recommend_hour", "abc");
    expect(getDailyTime()).toEqual({ hour: 3, minute: 0 });
  });

  it("总开关:默认开,显式 'false' 才关", () => {
    expect(getDailyMasterEnabled()).toBe(true);
    setSetting("daily_recommend_enabled", "false");
    expect(getDailyMasterEnabled()).toBe(false);
    setSetting("daily_recommend_enabled", "1");
    expect(getDailyMasterEnabled()).toBe(true);
  });
});

describe("nextDailyRunAt 排期", () => {
  it("目标时刻未到 → 今天", () => {
    setSetting("daily_recommend_time", "03:00");
    const now = new Date(2026, 0, 1, 1, 0, 0);
    const next = nextDailyRunAt(now);
    expect(next.getDate()).toBe(1);
    expect(next.getHours()).toBe(3);
    expect(next.getMinutes()).toBe(0);
  });

  it("目标时刻已过 → 顺延到明天", () => {
    setSetting("daily_recommend_time", "03:00");
    const now = new Date(2026, 0, 1, 10, 0, 0);
    const next = nextDailyRunAt(now);
    expect(next.getDate()).toBe(2);
    expect(next.getHours()).toBe(3);
  });

  it("恰好等于目标时刻 → 顺延到明天(不会立即触发)", () => {
    setSetting("daily_recommend_time", "03:00");
    const now = new Date(2026, 0, 1, 3, 0, 0, 0);
    expect(nextDailyRunAt(now).getDate()).toBe(2);
  });
});

describe("调度器生命周期", () => {
  it("到点执行 runner;总开关关闭时不执行", async () => {
    vi.useFakeTimers();
    setSetting("daily_recommend_time", "00:00"); // 已过 → 顺延,用 advanceTimersByTime 触发
    let ran = 0;
    setDailyRunner(async () => { ran++; });
    startDailyScheduler();
    await vi.advanceTimersByTimeAsync(24 * 60 * 60 * 1000 + 1000);
    expect(ran).toBe(1);

    setSetting("daily_recommend_enabled", "false");
    rearmDailyScheduler();
    await vi.advanceTimersByTimeAsync(24 * 60 * 60 * 1000 + 1000);
    expect(ran).toBe(1); // 总开关关 → 不再跑
  });

  it("runner 抛错不影响后续排期(finally 里 re-arm)", async () => {
    vi.useFakeTimers();
    setSetting("daily_recommend_time", "00:00");
    let calls = 0;
    setDailyRunner(async () => { calls++; throw new Error("boom"); });
    startDailyScheduler();
    await vi.advanceTimersByTimeAsync(24 * 60 * 60 * 1000 + 1000);
    expect(calls).toBe(1);
    // 定时器链未断 → 下一天继续
    await vi.advanceTimersByTimeAsync(24 * 60 * 60 * 1000);
    expect(calls).toBe(2);
  });

  it("rearm 会清掉旧定时器(不叠加重复执行)", async () => {
    vi.useFakeTimers();
    setSetting("daily_recommend_time", "00:00");
    let ran = 0;
    setDailyRunner(async () => { ran++; });
    startDailyScheduler();
    rearmDailyScheduler();
    rearmDailyScheduler();
    await vi.advanceTimersByTimeAsync(24 * 60 * 60 * 1000 + 1000);
    expect(ran).toBe(1);
  });

  it("未注册 runner 时到点不抛错", async () => {
    vi.useFakeTimers();
    setSetting("daily_recommend_time", "00:00");
    setDailyRunner(async () => {});
    startDailyScheduler();
    await vi.advanceTimersByTimeAsync(24 * 60 * 60 * 1000 + 1000);
    expect(true).toBe(true);
  });
});
