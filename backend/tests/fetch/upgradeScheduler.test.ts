// 定时自动洗版调度器：时间闸与触发语义（全同步、不 sleep，可测）。
import "../plugins/_env.js";

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { sqlite } from "../../src/db/index.js";
import { _resetSettingsCacheForTest, setSetting } from "../../src/services/settings.js";
import { resolveFetchConfig } from "../../src/services/fetch/config.js";
import { runAutoUpgradeOnce, todayTriggerMs } from "../../src/services/fetch/upgradeScheduler.js";
import { ensureUpgradeAttemptsTable } from "../../src/services/fetch/upgrade.js";
import { _resetFetchJobsForTest, getFetchJob } from "../../src/services/fetch/jobStore.js";

const LAST_RUN_KEY = "fetch.upgrade.auto.lastRunAt";

function cfgOf(patch: Record<string, unknown> = {}) {
  return resolveFetchConfig({
    downloadRoot: "/MUSIC/DOWNLOAD",
    cacheRoot: "/MUSIC/DOWNLOADCACHE",
    upgradeAutoEnabled: true,
    ...patch,
  });
}

describe("todayTriggerMs", () => {
  const d = new Date(2026, 9, 10, 15, 0); // 本地 2026-10-10 15:00

  it("解析 HH:mm 为今日本地时刻", () => {
    expect(todayTriggerMs("03:00", d)).toBe(new Date(2026, 9, 10, 3, 0).getTime());
    expect(todayTriggerMs("3:05", d)).toBe(new Date(2026, 9, 10, 3, 5).getTime());
  });

  it("非法格式返回 0（永不触发）", () => {
    expect(todayTriggerMs("24:00", d)).toBe(0);
    expect(todayTriggerMs("abc", d)).toBe(0);
    expect(todayTriggerMs("", d)).toBe(0);
  });
});

describe("runAutoUpgradeOnce — 触发闸", () => {
  beforeEach(() => {
    _resetSettingsCacheForTest();
    _resetFetchJobsForTest();
    setSetting(LAST_RUN_KEY, "0");
    ensureUpgradeAttemptsTable();
    sqlite.prepare("DELETE FROM fetch_upgrade_attempts").run();
    sqlite.prepare("DELETE FROM songs WHERE path LIKE 'l:%' OR path LIKE 'w:%'").run();
  });
  afterEach(() => {
    _resetSettingsCacheForTest();
    _resetFetchJobsForTest();
  });

  it("间隔闸：lastRunAt 很新 → 不触发", () => {
    setSetting(LAST_RUN_KEY, String(Date.now() - 1000));
    const r = runAutoUpgradeOnce(cfgOf());
    expect(r.triggered).toBe(false);
    expect(r.reason).toBe("interval");
  });

  it("时刻闸：当日时刻未到 → 不触发", () => {
    const d = new Date();
    const nowMs = new Date(d.getFullYear(), d.getMonth(), d.getDate(), 10, 0).getTime();
    const r = runAutoUpgradeOnce(cfgOf({ upgradeAutoTimeOfDay: "23:59" }), nowMs);
    expect(r.triggered).toBe(false);
    expect(r.reason).toBe("time-of-day");
  });

  it("到点触发：无目标 → 空跑落 lastRunAt，任务立即终态", () => {
    const r = runAutoUpgradeOnce(cfgOf({ upgradeAutoTimeOfDay: "00:00" }));
    expect(r.triggered).toBe(true);
    expect(r.enqueued).toBe(0);
    expect(getFetchJob(r.jobId!)?.status).toBe("done");
    // 落了 lastRunAt → 下一轮被间隔闸拦住
    const r2 = runAutoUpgradeOnce(cfgOf({ upgradeAutoTimeOfDay: "00:00" }));
    expect(r2.reason).toBe("interval");
  });

  it("有可洗目标 → 建任务、记冷却、启动", () => {
    const ins = sqlite.prepare(
      "INSERT INTO songs (id, type, path, title, artist, album, suffix, bit_rate, duration, size) VALUES (?,?,?,?,?,?,?,?,?,?)",
    );
    ins.run("auto-lo", "local", "l:auto-src:/dl/a.flac", "t", "a", "al", "flac", 600, 200, 15_000_000);
    const r = runAutoUpgradeOnce(cfgOf({ upgradeAutoTimeOfDay: "00:00", upgradeSourceIds: ["auto-src"] }));
    expect(r.triggered).toBe(true);
    expect(r.enqueued).toBe(1);
    expect(getFetchJob(r.jobId!)).not.toBeNull();
    const n = sqlite
      .prepare("SELECT COUNT(*) AS n FROM fetch_upgrade_attempts WHERE song_id = 'auto-lo'")
      .get() as { n: number };
    expect(n.n).toBe(1);
  });
});
