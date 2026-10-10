// 媒体源每日定时增量扫描 + 下载源名归一 + songCount 测试。
// runBatchJob mock 掉（调度器只负责闸门与触发，不真跑扫描子进程）。
import "../plugins/_env.js";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../src/batch/runner.js", () => ({
  runBatchJob: vi.fn().mockResolvedValue({ result: { added: 1, updated: 2, removed: 0, skipped: 0 } }),
}));

import { sqlite } from "../../src/db/index.js";
import { _resetSettingsCacheForTest, setSetting, getSetting } from "../../src/services/settings.js";
import { runScanSchedulerOnce } from "../../src/services/source/scanScheduler.js";
import { ensureDownloadSource } from "../../src/services/fetch/source.js";
import { countSourceSongs } from "../../src/routes/api/sources.js";

function insSource(id: string, name: string, type: string, config: Record<string, unknown>): void {
  sqlite
    .prepare(
      "INSERT INTO media_sources (id, name, type, enabled, config, created_at, updated_at) VALUES (?,?,?,1,?,?,?)",
    )
    .run(id, name, type, JSON.stringify(config), new Date().toISOString(), new Date().toISOString());
}

function delSource(id: string): void {
  sqlite.prepare("DELETE FROM media_sources WHERE id = ?").run(id);
}

function dayAt(hour: number, minute: number): number {
  const d = new Date();
  return new Date(d.getFullYear(), d.getMonth(), d.getDate(), hour, minute).getTime();
}

describe("runScanSchedulerOnce — 闸门", () => {
  const SID = "scan-test-src";

  beforeEach(() => {
    _resetSettingsCacheForTest();
    delSource(SID);
    // vitest shuffle 模式用例乱序：webdav 用例可能先跑并落下当日 lastRunAt，
    // 不清 key 会让「到点触发」用例被当日闸拦住（同一 SID）。
    setSetting("scan.auto.lastRunAt." + SID, "0");
  });
  afterEach(() => {
    _resetSettingsCacheForTest();
    delSource(SID);
  });

  it("enabled + scanAutoEnabled + 到点 → 触发并落当日 lastRunAt", () => {
    insSource(SID, "测试源", "local", { path: "/x", scanAutoEnabled: true, scanAutoTimeOfDay: "00:00" });
    const nowMs = dayAt(23, 0);
    const r = runScanSchedulerOnce(nowMs);
    expect(r).toEqual([SID]);
    expect(getSetting(`scan.auto.lastRunAt.${SID}`, "0")).toBe(String(nowMs));
    // 当日已跑 → 不再触发
    const r2 = runScanSchedulerOnce(nowMs + 60_000);
    expect(r2).toEqual([]);
  });

  it("未到点 → 不触发", () => {
    insSource(SID, "测试源", "local", { path: "/x", scanAutoEnabled: true, scanAutoTimeOfDay: "23:59" });
    const r = runScanSchedulerOnce(dayAt(10, 0));
    expect(r).toEqual([]);
  });

  it("scanAutoEnabled 缺省/false → 不触发", () => {
    insSource(SID, "测试源", "local", { path: "/x" });
    insSource(SID + "-off", "关源", "local", { path: "/x", scanAutoEnabled: false });
    const r = runScanSchedulerOnce(dayAt(23, 0));
    expect(r).toEqual([]);
  });

  it("webdav 源也参与", () => {
    insSource(SID, "网盘", "webdav", { url: "http://x/dav", scanAutoEnabled: true, scanAutoTimeOfDay: "00:00" });
    const r = runScanSchedulerOnce(dayAt(23, 0));
    expect(r).toEqual([SID]);
  });
});

describe("ensureDownloadSource — 名字对齐", () => {
  it("dl- 源传入新名 → 既有行名更新；非 dl- 源不改", () => {
    delSource("dl-tol-align");
    insSource("dl-tol-align", "旧名", "local", { path: "/MUSIC/TOL-ALIGN" });
    const r = ensureDownloadSource("/MUSIC/TOL-ALIGN", "已下载流媒体音质");
    expect(r.sourceId).toBe("dl-tol-align");
    const row = sqlite.prepare("SELECT name FROM media_sources WHERE id = ?").get("dl-tol-align") as { name: string };
    expect(row.name).toBe("已下载流媒体音质");
    delSource("dl-tol-align");
  });
});

describe("countSourceSongs", () => {
  it("按 l:/w: 前缀并集计数", () => {
    const SID = "cnt-test-src";
    sqlite.prepare("DELETE FROM songs WHERE path LIKE 'l:%' OR path LIKE 'w:%'").run();
    const ins = sqlite.prepare(
      "INSERT INTO songs (id, type, path, title, artist, album, suffix, bit_rate, duration, size) VALUES (?,?,?,?,?,?,?,?,?,?)",
    );
    ins.run("c1", "local", `l:${SID}:a.flac`, "t", "a", "al", "flac", 600, 200, 1000);
    ins.run("c2", "local", `l:${SID}:b.flac`, "t", "a", "al", "flac", 600, 200, 1000);
    ins.run("c3", "webdav", `w:${SID}:c.mp3`, "t", "a", "al", "mp3", 128, 200, 1000);
    ins.run("c4", "local", "l:other-src:d.flac", "t", "a", "al", "flac", 600, 200, 1000);
    expect(countSourceSongs(SID)).toBe(3);
    expect(countSourceSongs("other-src")).toBe(1);
    expect(countSourceSongs("no-such")).toBe(0);
    sqlite.prepare("DELETE FROM songs WHERE path LIKE 'l:%' OR path LIKE 'w:%'").run();
  });
});
