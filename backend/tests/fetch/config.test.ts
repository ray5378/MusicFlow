// ==================== MusicFetch 任务级配置（config.ts）单测 ====================
//
// config.ts 是「零 IO 纯函数」模块，本文件覆盖它对外暴露的两个函数：
//   1. resolveFetchConfig：默认合并、naming/quality 一层深合并、数值夹取、
//      白名单回落、数组浅拷贝隔离；
//   2. validateFetchPaths：路径形态校验（空 / 非绝对 / 同一 / 互为祖先）与 OK 分支。
import { describe, expect, it } from "vitest";

import {
  DEFAULT_FETCH_CONFIG,
  resolveFetchConfig,
  validateFetchPaths,
} from "../../src/services/fetch/config.js";
import { DEFAULT_NAMING_CONFIG } from "../../src/services/fetch/naming.js";
import { DEFAULT_QUALITY_CONFIG } from "../../src/services/fetch/types.js";

describe("resolveFetchConfig — 默认与深合并", () => {
  it("无参：与默认配置等值，且 naming/quality 是独立拷贝", () => {
    const c = resolveFetchConfig();
    expect(c).toEqual(DEFAULT_FETCH_CONFIG);
    expect(c.naming).not.toBe(DEFAULT_FETCH_CONFIG.naming);
    expect(c.quality).not.toBe(DEFAULT_FETCH_CONFIG.quality);
  });

  it("naming 一层深合并：只覆盖显式给的子字段", () => {
    const c = resolveFetchConfig({ naming: { fileTemplate: "{title}" } });
    expect(c.naming.fileTemplate).toBe("{title}");
    expect(c.naming.dirTemplate).toBe(DEFAULT_NAMING_CONFIG.dirTemplate);
    expect(c.naming.padTrackNumber).toBe(DEFAULT_NAMING_CONFIG.padTrackNumber);
  });

  it("quality 一层深合并：只覆盖显式给的子字段", () => {
    const c = resolveFetchConfig({ quality: { minDurationSec: 42 } });
    expect(c.quality.minDurationSec).toBe(42);
    expect(c.quality.qualityFloor).toBe(DEFAULT_QUALITY_CONFIG.qualityFloor);
  });

  it("数组字段浅拷贝：改返回值不污染默认常量", () => {
    const c = resolveFetchConfig({
      sourcePriority: ["a"],
      ssrfTrustedHosts: ["h"],
      syncToPlaylistIds: ["p"],
    });
    c.sourcePriority.push("b");
    c.ssrfTrustedHosts.push("h2");
    c.syncToPlaylistIds.push("p2");
    expect(DEFAULT_FETCH_CONFIG.sourcePriority).toEqual([]);
    expect(DEFAULT_FETCH_CONFIG.ssrfTrustedHosts).toEqual([]);
    expect(DEFAULT_FETCH_CONFIG.syncToPlaylistIds).toEqual([]);

    const d = resolveFetchConfig();
    expect(d.sourcePriority).not.toBe(DEFAULT_FETCH_CONFIG.sourcePriority);
    expect(d.ssrfTrustedHosts).not.toBe(DEFAULT_FETCH_CONFIG.ssrfTrustedHosts);
    expect(d.syncToPlaylistIds).not.toBe(DEFAULT_FETCH_CONFIG.syncToPlaylistIds);
  });
});

describe("resolveFetchConfig — 数值夹取与白名单回落", () => {
  it("jobRetentionDays：0..3650 夹取，非有限数回落默认", () => {
    expect(resolveFetchConfig({ jobRetentionDays: -5 }).jobRetentionDays).toBe(0);
    expect(resolveFetchConfig({ jobRetentionDays: 5000 }).jobRetentionDays).toBe(3650);
    expect(resolveFetchConfig({ jobRetentionDays: 12.9 }).jobRetentionDays).toBe(12);
    expect(resolveFetchConfig({ jobRetentionDays: Number.NaN }).jobRetentionDays).toBe(
      DEFAULT_FETCH_CONFIG.jobRetentionDays,
    );
    expect(
      resolveFetchConfig({ jobRetentionDays: "30" as unknown as number }).jobRetentionDays,
    ).toBe(DEFAULT_FETCH_CONFIG.jobRetentionDays);
  });

  it("maxConcurrentJobs：1..16 夹取", () => {
    expect(resolveFetchConfig({ maxConcurrentJobs: 0 }).maxConcurrentJobs).toBe(1);
    expect(resolveFetchConfig({ maxConcurrentJobs: 99 }).maxConcurrentJobs).toBe(16);
    expect(resolveFetchConfig({ maxConcurrentJobs: Number.NaN }).maxConcurrentJobs).toBe(
      DEFAULT_FETCH_CONFIG.maxConcurrentJobs,
    );
  });

  it("maxConcurrentTargets：1..64 夹取", () => {
    expect(resolveFetchConfig({ maxConcurrentTargets: 0 }).maxConcurrentTargets).toBe(1);
    expect(resolveFetchConfig({ maxConcurrentTargets: 999 }).maxConcurrentTargets).toBe(64);
    expect(resolveFetchConfig({ maxConcurrentTargets: 3.7 }).maxConcurrentTargets).toBe(3);
  });

  it("maxConcurrentTranscodes：1..16 夹取", () => {
    expect(resolveFetchConfig({ maxConcurrentTranscodes: 0 }).maxConcurrentTranscodes).toBe(1);
    expect(resolveFetchConfig({ maxConcurrentTranscodes: 99 }).maxConcurrentTranscodes).toBe(16);
  });

  it("deadSongPurgeThreshold：0..20 夹取，非有限数回落默认", () => {
    expect(resolveFetchConfig({ deadSongPurgeThreshold: -3 }).deadSongPurgeThreshold).toBe(0);
    expect(resolveFetchConfig({ deadSongPurgeThreshold: 99 }).deadSongPurgeThreshold).toBe(20);
    expect(
      resolveFetchConfig({ deadSongPurgeThreshold: Number.POSITIVE_INFINITY })
        .deadSongPurgeThreshold,
    ).toBe(DEFAULT_FETCH_CONFIG.deadSongPurgeThreshold);
  });

  it("tagRepairIntervalHours：1..8760 夹取", () => {
    expect(resolveFetchConfig({ tagRepairIntervalHours: 0 }).tagRepairIntervalHours).toBe(1);
    expect(resolveFetchConfig({ tagRepairIntervalHours: 99999 }).tagRepairIntervalHours).toBe(8760);
    expect(resolveFetchConfig({ tagRepairIntervalHours: Number.NaN }).tagRepairIntervalHours).toBe(
      DEFAULT_FETCH_CONFIG.tagRepairIntervalHours,
    );
  });

  it("tagRepairScope：仅接受三个白名单值，其余回落 both", () => {
    expect(resolveFetchConfig({ tagRepairScope: "download" }).tagRepairScope).toBe("download");
    expect(resolveFetchConfig({ tagRepairScope: "lossless" }).tagRepairScope).toBe("lossless");
    expect(resolveFetchConfig({ tagRepairScope: "both" }).tagRepairScope).toBe("both");
    expect(resolveFetchConfig({ tagRepairScope: "nope" as never }).tagRepairScope).toBe("both");
  });

  it("chineseVariant：仅接受两个白名单值，其余回落 simplified", () => {
    expect(resolveFetchConfig({ chineseVariant: "traditional" }).chineseVariant).toBe(
      "traditional",
    );
    expect(resolveFetchConfig({ chineseVariant: "simplified" }).chineseVariant).toBe("simplified");
    expect(resolveFetchConfig({ chineseVariant: "bogus" as never }).chineseVariant).toBe(
      "simplified",
    );
  });
});

describe("validateFetchPaths", () => {
  it("绝对路径且互不包含 → ok，无 errors/warnings", () => {
    const r = validateFetchPaths(
      resolveFetchConfig({ downloadRoot: "/MUSIC/DOWNLOAD", cacheRoot: "/MUSIC/DOWNLOADCACHE" }),
    );
    expect(r.ok).toBe(true);
    expect(r.errors).toEqual([]);
    expect(r.warnings).toEqual([]);
  });

  it("互不包含的兄弟目录 → ok", () => {
    expect(
      validateFetchPaths(resolveFetchConfig({ downloadRoot: "/a/b", cacheRoot: "/a/c" })).ok,
    ).toBe(true);
  });

  it("downloadRoot 非绝对路径 → 报错", () => {
    const r = validateFetchPaths(resolveFetchConfig({ downloadRoot: "rel/dl" }));
    expect(r.ok).toBe(false);
    expect(r.errors.join("|")).toContain("downloadRoot 必须是绝对路径");
  });

  it("cacheRoot 非绝对路径 → 报错", () => {
    const r = validateFetchPaths(resolveFetchConfig({ cacheRoot: "rel/ca" }));
    expect(r.errors.join("|")).toContain("cacheRoot 必须是绝对路径");
  });

  it("路径为空串（纯空白）→ 报错", () => {
    const r = validateFetchPaths(resolveFetchConfig({ downloadRoot: "   ", cacheRoot: "" }));
    expect(r.errors.join("|")).toContain("downloadRoot 为空");
    expect(r.errors.join("|")).toContain("cacheRoot 为空");
  });

  it("字段非字符串 → 视为空（typeof 分支）", () => {
    const cfg = {
      ...DEFAULT_FETCH_CONFIG,
      downloadRoot: 123 as unknown as string,
      cacheRoot: null as unknown as string,
    };
    const r = validateFetchPaths(cfg);
    expect(r.errors.join("|")).toContain("downloadRoot 为空");
    expect(r.errors.join("|")).toContain("cacheRoot 为空");
  });

  it("两路径相同 → 报错", () => {
    const r = validateFetchPaths(resolveFetchConfig({ downloadRoot: "/a/b", cacheRoot: "/a/b" }));
    expect(r.errors.join("|")).toContain("不能是同一路径");
  });

  it("cacheRoot 位于 downloadRoot 之内 → 报错", () => {
    const r = validateFetchPaths(resolveFetchConfig({ downloadRoot: "/a", cacheRoot: "/a/b" }));
    expect(r.errors.join("|")).toContain("cacheRoot 位于 downloadRoot 之内");
  });

  it("downloadRoot 位于 cacheRoot 之内 → 报错", () => {
    const r = validateFetchPaths(resolveFetchConfig({ downloadRoot: "/a/b", cacheRoot: "/a" }));
    expect(r.errors.join("|")).toContain("downloadRoot 位于 cacheRoot 之内");
  });
});
