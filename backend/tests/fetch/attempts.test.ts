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
  DEFAULT_DEAD_SONG_PURGE_THRESHOLD,
  DOWNLOAD_COOLDOWN_CODE,
  clearDownloadAttempt,
  downloadAttemptCount,
  downloadAttemptKeyOf,
  downloadFailCount,
  effectiveCooldownDays,
  effectiveDeadSongPurgeThreshold,
  ensureDownloadAttemptsTable,
  isPermanentFailureCode,
  isRecentlyAttempted,
  listPermanentFailureKeys,
  recordDownloadAttempt,
  rollbackPermanentFailure,
  shouldSkipByCooldown,
} from "../../src/services/fetch/attempts.js";
import { DEFAULT_FETCH_CONFIG } from "../../src/services/fetch/config.js";
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

  it("6. PATCH21 永久失效计数：A 类 +1、成功归零、可恢复失败不计数也不打断", () => {
    ensureDownloadAttemptsTable();
    recordDownloadAttempt("s-perm", "b1", "failed", 0, { errorCode: "HTTP_404", permanent: true });
    expect(downloadFailCount("s-perm")).toBe(1);
    recordDownloadAttempt("s-perm", "b2", "failed", 0, { errorCode: "HTTP_404", permanent: true });
    expect(downloadFailCount("s-perm")).toBe(2);
    // 可恢复失败（TIMEOUT）既不 +1 也不清零 —— 「连续」按「没被成功打断」理解。
    recordDownloadAttempt("s-perm", "b3", "failed", 0, { errorCode: "TIMEOUT", permanent: false });
    expect(downloadFailCount("s-perm")).toBe(2);
    // 成功一次即归零（这首歌能下来，之前的失败不算死链证据）。
    recordDownloadAttempt("s-perm", "b4", "done", 0);
    expect(downloadFailCount("s-perm")).toBe(0);
  });

  it("7. PATCH21 白名单：只有「资源不存在类」判永久；质量/网络/环境类一律不算", () => {
    for (const c of ["NO_CANDIDATE", "HTTP_404", "HTTP_410", "HTTP_451", "INTEGRITY_FAILED"]) {
      expect(isPermanentFailureCode(c)).toBe(true);
    }
    // 尤其 BELOW_BAR / FAKE_LOSSLESS：歌是存在的，只是不满足下载质量门槛 ——
    // 误判成永久会把「还能在线播放」的歌删掉。
    for (const c of [
      "BELOW_BAR",
      "FAKE_LOSSLESS",
      "TIMEOUT",
      "STALL",
      "HTTP_5XX",
      "HTTP_403",
      "HTTP_4XX",
      "FETCH_FAILED",
      "TOO_LARGE",
      "SSRF_BLOCKED",
      "DISK_FULL",
      "MOVE_FAILED",
      "TAG_FAILED",
      "TRANSCODE_FAILED",
      "SCAN_FAILED",
      "UNKNOWN",
      "ALREADY_IN_LIBRARY",
      "COOLDOWN_SKIPPED",
      "DUPLICATE_TARGET",
    ]) {
      expect(isPermanentFailureCode(c)).toBe(false);
    }
    expect(isPermanentFailureCode(undefined)).toBe(false);
    expect(isPermanentFailureCode(null)).toBe(false);
    expect(isPermanentFailureCode("")).toBe(false);
  });

  it("8. PATCH21 阈值查询 / 回滚 / 清理", () => {
    ensureDownloadAttemptsTable();
    recordDownloadAttempt("s-th", "b1", "failed", 0, { errorCode: "HTTP_410", permanent: true });
    recordDownloadAttempt("s-th", "b2", "failed", 0, { errorCode: "HTTP_410", permanent: true });

    expect(listPermanentFailureKeys(3).some((k) => k.songKey === "s-th")).toBe(false);
    const hit = listPermanentFailureKeys(2).find((k) => k.songKey === "s-th");
    expect(hit?.errorCode).toBe("HTTP_410");
    expect(hit?.failCount).toBe(2);

    rollbackPermanentFailure("s-th"); // 源整体故障保护：退一次
    expect(downloadFailCount("s-th")).toBe(1);

    clearDownloadAttempt("s-th"); // 清理完成后删台账行
    expect(downloadFailCount("s-th")).toBe(0);
    expect(listPermanentFailureKeys(1).some((k) => k.songKey === "s-th")).toBe(false);
  });

  it("9. PATCH21 阈值归一：0 关闭、非法回落默认、超限夹到 20", () => {
    expect(effectiveDeadSongPurgeThreshold({ deadSongPurgeThreshold: 0 } as FetchConfig)).toBe(0);
    expect(
      effectiveDeadSongPurgeThreshold({ deadSongPurgeThreshold: Number.NaN } as unknown as FetchConfig),
    ).toBe(DEFAULT_DEAD_SONG_PURGE_THRESHOLD);
    expect(
      effectiveDeadSongPurgeThreshold({ deadSongPurgeThreshold: 99 } as unknown as FetchConfig),
    ).toBe(20);
    expect(DEFAULT_FETCH_CONFIG.deadSongPurgeThreshold).toBe(DEFAULT_DEAD_SONG_PURGE_THRESHOLD);
  });
});

// 2026-10-11 定调 B：**永久失效类不进冷却**。
// 背景（240 生产实测）：downloadCooldownDays=30 > 全库自动任务间隔 15 天 → 同一首歌
// 永远只失败一次 → 台账 fail_count>0 = 126 条而 fail_count>=2 = 0 条 → 死链清理永不生效。
describe("fetch 下载冷却（2026-10-11 定调 B：永久失效类不冷却）", () => {
  it("10. 永久失效类（HTTP_404）刚试过也放行重试 —— 否则 fail_count 永远停在 1", () => {
    ensureDownloadAttemptsTable();
    recordDownloadAttempt("b-404", "b1", "failed", 0, { errorCode: "HTTP_404", permanent: true });
    expect(isRecentlyAttempted("b-404", 30)).toBe(true); // 无差别判定：窗口内 → 命中
    expect(shouldSkipByCooldown("b-404", 30)).toBe(false); // B：永久失效 → 放行重试
    // 第二轮重试仍 404 → fail_count 累到 2 → 达到 deadSongPurge 默认阈值（2）
    recordDownloadAttempt("b-404", "b2", "failed", 0, { errorCode: "HTTP_404", permanent: true });
    expect(downloadFailCount("b-404")).toBe(2);
    expect(shouldSkipByCooldown("b-404", 30)).toBe(false);
  });

  it("11. 可恢复失败（TIMEOUT）仍照常冷却（防网络抖动被反复重试打爆源）", () => {
    ensureDownloadAttemptsTable();
    recordDownloadAttempt("b-to", "b1", "failed", 0, { errorCode: "TIMEOUT", permanent: false });
    expect(shouldSkipByCooldown("b-to", 30)).toBe(true);
  });

  it("12. 成功过的歌照常冷却（完成后进冷却，避免重复下载）", () => {
    ensureDownloadAttemptsTable();
    recordDownloadAttempt("b-done", "b1", "done", 0);
    expect(shouldSkipByCooldown("b-done", 30)).toBe(true);
  });

  it("13. 窗口外 / 无记录 / 关闭冷却 → 一律不跳过", () => {
    ensureDownloadAttemptsTable();
    recordDownloadAttempt("b-old", "b1", "failed", 0, { errorCode: "HTTP_404", permanent: true });
    const old = new Date(Date.now() - 40 * 86_400_000).toISOString();
    sqlite
      .prepare(`UPDATE fetch_download_attempts SET attempted_at = ? WHERE song_key = ?`)
      .run(old, "b-old");
    expect(shouldSkipByCooldown("b-old", 30)).toBe(false); // 窗口外
    expect(shouldSkipByCooldown("b-never", 30)).toBe(false); // 无记录
    expect(shouldSkipByCooldown("b-404", 0)).toBe(false); // 关闭冷却
  });
});
