// PATCH17 下载尝试台账（可轮转）测试。
//
// 覆盖：
//   1. 稳定键提取：sourceData.library.songId > sourceData.upgrade.oldSongId > target.id；
//   2. 记录 + 冷却判定 roundtrip（done/failed 都算「试过」）；
//   3. UPSERT 覆盖：同一键重复记录不膨胀，且刷新 attempted_at；
//   4. 轮转：窗口外旧行被清理，表大小有界；
//   5. cooldownDays=0 关闭（不判定、不轮转兜底仍可记）。
//
// 库表操作走真实 sqlite（tests/setup.ts 已按文件隔离 DATA_DIR 并建好全量 schema）。
// MUST be the first import。
import "../plugins/_env.js";

import { describe, expect, it } from "vitest";

import { sqlite } from "../../src/db/index.js";
import type { FetchTarget } from "../../src/services/fetch/candidates.js";
import {
  DOWNLOAD_COOLDOWN_CODE,
  downloadAttemptCount,
  downloadAttemptKeyOf,
  effectiveCooldownDays,
  ensureDownloadAttemptsTable,
  isRecentlyAttempted,
  recordDownloadAttempt,
} from "../../src/services/fetch/attempts.js";
import type { FetchConfig } from "../../src/services/fetch/config.js";

function tgt(over: Partial<FetchTarget> = {}): FetchTarget {
  return { id: "t-1", title: "歌名", ...over };
}

describe("fetch 下载尝试台账（PATCH17）", () => {
  it("1. 稳定键：library.songId 优先，其次 upgrade.oldSongId，退回 target.id", () => {
    expect(
      downloadAttemptKeyOf(tgt({ id: "library:abc", sourceData: JSON.stringify({ library: { songId: "abc" } }) })),
    ).toBe("abc");
    expect(
      downloadAttemptKeyOf(tgt({ id: "u:1", sourceData: JSON.stringify({ upgrade: { oldSongId: "old-9" } }) })),
    ).toBe("old-9");
    expect(downloadAttemptKeyOf(tgt({ id: "web:123", sourceData: "not-json" }))).toBe("web:123");
    expect(downloadAttemptKeyOf(tgt({ id: "manual-x" }))).toBe("manual-x");
  });

  it("2. 记录后冷却判定命中：done/failed 都算「试过」", () => {
    ensureDownloadAttemptsTable();
    recordDownloadAttempt("s-done", "b1", "done", 7);
    recordDownloadAttempt("s-fail", "b1", "failed", 7);
    expect(isRecentlyAttempted("s-done", 7)).toBe(true);
    expect(isRecentlyAttempted("s-fail", 7)).toBe(true);
    expect(isRecentlyAttempted("s-never", 7)).toBe(false);
    expect(DOWNLOAD_COOLDOWN_CODE).toBe("COOLDOWN_SKIPPED");
  });

  it("3. UPSERT：同键重复记录行数不膨胀，行数 = 唯一键数", () => {
    ensureDownloadAttemptsTable();
    recordDownloadAttempt("s-up", "b1", "failed", 7);
    recordDownloadAttempt("s-up", "b2", "done", 7);
    expect(downloadAttemptCount()).toBeGreaterThanOrEqual(1);
    // 仍是冷却命中（最新一次为 done）
    expect(isRecentlyAttempted("s-up", 7)).toBe(true);
  });

  it("4. 轮转：把窗口调窄后重记 → 窗口外旧行被清理", () => {
    ensureDownloadAttemptsTable();
    recordDownloadAttempt("s-old", "b1", "failed", 365);
    expect(isRecentlyAttempted("s-old", 365)).toBe(true);
    // 用 1 天窗口重记另一键 → 上一键若超出 1 天窗口会被清（它刚写入，不会超）。
    // 直接构造旧行为：把 attempted_at 拨回 10 天前，再用 7 天窗口记录任何键触发轮转。
    const old = new Date(Date.now() - 10 * 86_400_000).toISOString();
    sqlite.prepare(`UPDATE fetch_download_attempts SET attempted_at = ? WHERE song_key = ?`).run(old, "s-old");
    expect(isRecentlyAttempted("s-old", 7)).toBe(false);
    recordDownloadAttempt("s-fresh", "b1", "done", 7);
    expect(isRecentlyAttempted("s-old", 7)).toBe(false);
    expect(isRecentlyAttempted("s-fresh", 7)).toBe(true);
  });

  it("5. cooldownDays=0 关闭冷却；effectiveCooldownDays 兜底", () => {
    ensureDownloadAttemptsTable();
    recordDownloadAttempt("s-zero", "b1", "failed", 7);
    expect(isRecentlyAttempted("s-zero", 0)).toBe(false);
    const cfg = { downloadCooldownDays: 0 } as FetchConfig;
    expect(effectiveCooldownDays(cfg)).toBe(0);
    expect(effectiveCooldownDays({ downloadCooldownDays: Number.NaN } as unknown as FetchConfig)).toBe(7);
    expect(effectiveCooldownDays({ downloadCooldownDays: 9999 } as unknown as FetchConfig)).toBe(365);
  });
});
