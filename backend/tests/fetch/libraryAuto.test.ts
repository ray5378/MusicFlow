// 全库下载定时自动调度 + 冷却过滤测试（对齐 upgradeScheduler.test.ts 手法，全同步不 sleep）。
import "../plugins/_env.js";

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { sqlite } from "../../src/db/index.js";
import { _resetSettingsCacheForTest, setSetting } from "../../src/services/settings.js";
import { resolveFetchConfig } from "../../src/services/fetch/config.js";
import { runAutoLibraryOnce } from "../../src/services/fetch/libraryScheduler.js";
import {
  buildLibraryPlan,
  ensureLibraryAttemptsTable,
  recordLibraryAttempts,
  resetLibraryAttempts,
} from "../../src/services/fetch/library.js";
import { createFetchJob, _resetFetchJobsForTest, getFetchJob } from "../../src/services/fetch/jobStore.js";

const LAST_RUN_KEY = "fetch.library.auto.lastRunAt";

function cfgOf(patch: Record<string, unknown> = {}) {
  return resolveFetchConfig({
    downloadRoot: "/MUSIC/DOWNLOAD",
    cacheRoot: "/MUSIC/DOWNLOADCACHE",
    libraryAutoEnabled: true,
    ...patch,
  });
}

function seedWeb(id: string): void {
  sqlite
    .prepare(
      "INSERT INTO songs (id, type, path, title, artist, album, suffix, bit_rate, duration, size) VALUES (?,?,?,?,?,?,?,?,?,?)",
    )
    .run(id, "web", "web:x:" + id, "t", "a", "al", "mp3", 128, 200, 1000);
}

// ==================== 冷却过滤 ====================

describe("buildLibraryPlan — 冷却过滤（对齐洗版）", () => {
  beforeEach(() => {
    ensureLibraryAttemptsTable();
    resetLibraryAttempts();
    sqlite.prepare("DELETE FROM songs WHERE path LIKE 'web:%'").run();
  });

  it("冷却期内已尝试的行不进 pool，cooled 计数正确", () => {
    seedWeb("cd1");
    seedWeb("cd2");
    recordLibraryAttempts("b1", ["cd1"]);
    const plan = buildLibraryPlan(cfgOf({ libraryCooldownDays: 30 }), { limit: 10 });
    expect(plan.items.map((i) => i.songId)).toEqual(["cd2"]);
    expect(plan.cooled).toBe(1);
    expect(plan.pending).toBe(1);
  });

  it("超过冷却天数（attempted_at 改到 31 天前）→ 重新可选", () => {
    seedWeb("old1");
    recordLibraryAttempts("b2", ["old1"]);
    sqlite
      .prepare("UPDATE fetch_library_attempts SET attempted_at = ? WHERE song_id = 'old1'")
      .run(new Date(Date.now() - 31 * 86_400_000).toISOString());
    const plan = buildLibraryPlan(cfgOf({ libraryCooldownDays: 30 }), { limit: 10 });
    expect(plan.items.map((i) => i.songId)).toEqual(["old1"]);
    expect(plan.cooled).toBe(0);
  });

  it("显式 songIds 点名绕过冷却（用户重试语义）", () => {
    seedWeb("hot1");
    recordLibraryAttempts("b3", ["hot1"]);
    const plan = buildLibraryPlan(cfgOf(), { limit: 10, songIds: ["hot1"] });
    expect(plan.items.map((i) => i.songId)).toEqual(["hot1"]);
    expect(plan.cooled).toBe(0);
  });
});

// ==================== 定时调度闸 ====================

describe("runAutoLibraryOnce — 触发闸", () => {
  beforeEach(() => {
    _resetSettingsCacheForTest();
    _resetFetchJobsForTest();
    setSetting(LAST_RUN_KEY, "0");
    ensureLibraryAttemptsTable();
    resetLibraryAttempts();
    sqlite.prepare("DELETE FROM songs WHERE path LIKE 'web:%'").run();
  });
  afterEach(() => {
    _resetSettingsCacheForTest();
    _resetFetchJobsForTest();
  });

  it("间隔闸：lastRunAt 很新 → 不触发", () => {
    setSetting(LAST_RUN_KEY, String(Date.now() - 1000));
    const r = runAutoLibraryOnce(cfgOf());
    expect(r.triggered).toBe(false);
    expect(r.reason).toBe("interval");
  });

  it("时刻闸：当日时刻未到 → 不触发", () => {
    const d = new Date();
    const nowMs = new Date(d.getFullYear(), d.getMonth(), d.getDate(), 10, 0).getTime();
    const r = runAutoLibraryOnce(cfgOf({ libraryAutoTimeOfDay: "23:59" }), nowMs);
    expect(r.triggered).toBe(false);
    expect(r.reason).toBe("time-of-day");
  });

  it("busy 闸：有活动任务 → 不触发", () => {
    createFetchJob({ kind: "manual", targets: { targets: [] } });
    const r = runAutoLibraryOnce(cfgOf({ libraryAutoTimeOfDay: "00:00" }));
    expect(r.triggered).toBe(false);
    expect(r.reason).toBe("busy");
  });

  it("到点触发：无目标 → 空跑落 lastRunAt，任务立即终态", () => {
    const r = runAutoLibraryOnce(cfgOf({ libraryAutoTimeOfDay: "00:00" }));
    expect(r.triggered).toBe(true);
    expect(r.reason).toBe("empty");
    expect(r.enqueued).toBe(0);
    expect(getFetchJob(r.jobId!)?.status).toBe("done");
    // 落了 lastRunAt → 下一轮被间隔闸拦住
    const r2 = runAutoLibraryOnce(cfgOf({ libraryAutoTimeOfDay: "00:00" }));
    expect(r2.reason).toBe("interval");
  });

  it("有可下目标 → 建任务、启动（PATCH19：记账移到条目终态，创建时不再预记）", () => {
    seedWeb("auto-w1");
    seedWeb("auto-w2");
    const r = runAutoLibraryOnce(cfgOf({ libraryAutoTimeOfDay: "00:00" }));
    expect(r.triggered).toBe(true);
    expect(r.reason).toBe("started");
    expect(r.enqueued).toBe(2);
    expect(getFetchJob(r.jobId!)).not.toBeNull();
    const n = sqlite
      .prepare("SELECT COUNT(*) AS n FROM fetch_library_attempts")
      .get() as { n: number };
    expect(n.n).toBe(0);
  });
});
