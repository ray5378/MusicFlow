// ==================== P5-3：离线预测量（可选优化层，默认关） ====================
//
// 只锁三件事，都是做错就会静默错的地方：
//   ① **命令**必须只分析不出音频（`-f null -`），且用与实时路径同一个 loudnorm 参数；
//   ② **候选集**只含 local 行、只含「还没测过」的（重复触发必须幂等，web 行永不入选）；
//   ③ **默认关**（plan §3.2：预测量是可选优化，不是前置条件）。
// 末段跑真 ffmpeg 端到端：生成一个已知电平的 wav → 测 → 值落在合理区间且落库。
//
// 每个 `it` 自带前置状态（清表 + 复位模块级运行态）——本仓开了 `sequence.shuffle`。
import { describe, it, expect, beforeEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { sqlite, db } from "../../src/db/index.js";
import { songs } from "../../src/db/schema.js";
import { resolveFfmpeg } from "../../src/services/transcode.js";
import { loadAnalysis, saveAnalysis } from "../../src/services/audio/analysisStore.js";
import {
  MEASURE_DEFAULT_LIMIT,
  MEASURE_MAX_LIMIT,
  buildMeasureArgs,
  getMeasureStatus,
  isOfflineMeasureEnabled,
  listMeasureCandidates,
  measurableLocalPath,
  measureCounts,
  normalizeLimit,
  resetOfflineMeasureStateForTests,
  runOfflineMeasure,
  setOfflineMeasureEnabled,
  startOfflineMeasure,
} from "../../src/services/audio/offlineMeasure.js";

/** songs 在 audio_analysis 上有 FK（无 CASCADE）⇒ 先删测量值再删行。 */
beforeEach(() => {
  sqlite.prepare("DELETE FROM audio_analysis").run();
  db.delete(songs).run();
  setOfflineMeasureEnabled(false);
  resetOfflineMeasureStateForTests();
});

function insertSong(id: string, p: string, type: string): void {
  db.insert(songs).values({ id, title: id, path: p, type }).run();
}

describe("P5-3 纯函数：命令组装 / limit / 可测路径", () => {
  it("测量命令只分析不出音频，且复用实时路径的 loudnorm 参数", () => {
    const args = buildMeasureArgs("/music/a.flac");
    expect(args[args.indexOf("-i") + 1]).toBe("/music/a.flac");
    expect(args).toContain("-nostdin");
    const af = args[args.indexOf("-af") + 1];
    expect(af).toContain("loudnorm=I=-14");
    expect(af).toContain("print_format=json");
    // 输出必须是 null muxer —— 一旦变成 pipe:1 就是把整首歌再导一遍（纯浪费）
    expect(args.slice(-3)).toEqual(["-f", "null", "-"]);
    expect(args.join(" ")).not.toContain("pipe:1");
  });

  it("limit 归一化：非法值回落默认、超限钳到上限、小数取整", () => {
    expect(normalizeLimit(undefined)).toBe(MEASURE_DEFAULT_LIMIT);
    expect(normalizeLimit("abc")).toBe(MEASURE_DEFAULT_LIMIT);
    expect(normalizeLimit(0)).toBe(MEASURE_DEFAULT_LIMIT);
    expect(normalizeLimit(-3)).toBe(MEASURE_DEFAULT_LIMIT);
    expect(normalizeLimit(7.9)).toBe(7);
    expect(normalizeLimit(999999)).toBe(MEASURE_MAX_LIMIT);
  });

  it("可测路径只认 `l:` 前缀（webdav 的 `w:` / 相对路径一律不可测）", () => {
    expect(measurableLocalPath("l:src1:/music/a.flac")).toBe("/music/a.flac");
    expect(measurableLocalPath("w:src1:/music/a.flac")).toBeNull();
    expect(measurableLocalPath("web:plug:netease")).toBeNull();
    expect(measurableLocalPath("/music/a.flac")).toBeNull();
    expect(measurableLocalPath("")).toBeNull();
    expect(measurableLocalPath(null)).toBeNull();
  });
});

describe("P5-3 开关：默认关", () => {
  it("缺省关，置位后状态随之变化", () => {
    expect(isOfflineMeasureEnabled()).toBe(false);
    expect(getMeasureStatus().enabled).toBe(false);

    setOfflineMeasureEnabled(true);
    expect(isOfflineMeasureEnabled()).toBe(true);
    expect(getMeasureStatus().enabled).toBe(true);

    setOfflineMeasureEnabled(false);
    expect(isOfflineMeasureEnabled()).toBe(false);
  });

  it("开关关闭时手动触发不启动（reason=disabled，不静默吞）", () => {
    expect(startOfflineMeasure(5)).toEqual({ started: false, reason: "disabled" });
  });
});

describe("P5-3 候选集与统计", () => {
  it("只选 local 且未测量的行：web / webdav / 非 l: 路径都不入选", () => {
    insertSong("s-local-1", "l:s1:/music/a.flac", "local");
    insertSong("s-local-2", "l:s1:/music/b.flac", "local");
    insertSong("s-web", "web:plug:netease", "web");
    insertSong("s-webdav", "w:s1:/music/c.flac", "webdav");
    insertSong("s-relative", "/music/d.flac", "local");

    expect(listMeasureCandidates(50).map((c) => c.id).sort()).toEqual(["s-local-1", "s-local-2"]);
    expect(measureCounts()).toEqual({ total: 2, measured: 0, pending: 2 });
  });

  it("已测量过的行不再入选（重复触发是幂等的）", () => {
    insertSong("s-local-1", "l:s1:/music/a.flac", "local");
    insertSong("s-local-2", "l:s1:/music/b.flac", "local");

    saveAnalysis("s-local-1", "local", { loudnessIntegrated: -14.2 });
    expect(listMeasureCandidates(50).map((c) => c.id)).toEqual(["s-local-2"]);
    expect(measureCounts()).toEqual({ total: 2, measured: 1, pending: 1 });
  });

  it("limit 真的会被 SQL 用上", () => {
    for (let i = 0; i < 5; i++) insertSong(`s-${i}`, `l:s1:/music/${i}.flac`, "local");
    expect(listMeasureCandidates(2)).toHaveLength(2);
  });

  it("D8 双保险：web 行即便显式调用 saveAnalysis 也写不进去", () => {
    insertSong("s-web", "web:plug:netease", "web");
    expect(saveAnalysis("s-web", "web", { loudnessIntegrated: -14 })).toBe(false);
    expect(loadAnalysis("s-web")).toBeNull();
  });
});

describe("P5-3 执行层（真 ffmpeg）", () => {
  it("端到端：测出集成响度并落进 audio_analysis", async () => {
    const wav = path.join(process.env.DATA_DIR as string, "measure-probe.wav");
    const gen = spawnSync(
      resolveFfmpeg(),
      ["-hide_banner", "-nostdin", "-f", "lavfi", "-i", "sine=frequency=1000:duration=2", "-af", "volume=-20dB", "-y", wav],
      { encoding: "utf8" },
    );
    expect(gen.status).toBe(0);
    expect(fs.existsSync(wav)).toBe(true);

    insertSong("s-e2e", `l:s1:${wav}`, "local");
    setOfflineMeasureEnabled(true);

    const summary = await runOfflineMeasure({ limit: 10 });
    expect(summary.considered).toBe(1);
    expect(summary.measured).toBe(1);
    expect(summary.failed).toBe(0);
    expect(summary.total).toBe(1);
    expect(summary.pending).toBe(0);

    const rec = loadAnalysis("s-e2e");
    expect(rec).not.toBeNull();
    // 生成时压了 -20dB，实测约 -41 LUFS；区间放宽到不依赖 ffmpeg 版本细节
    expect(rec!.loudnessIntegrated as number).toBeGreaterThan(-46);
    expect(rec!.loudnessIntegrated as number).toBeLessThan(-36);
    expect(rec!.truePeak).not.toBeNull();
  });

  it("文件不存在 → 计 failed，不抛（整批不中断）", async () => {
    insertSong("s-missing", "l:s1:/nonexistent/definitely-not-here-xyz.flac", "local");
    setOfflineMeasureEnabled(true);

    const summary = await runOfflineMeasure({ limit: 5 });
    expect(summary.considered).toBe(1);
    expect(summary.measured).toBe(0);
    expect(summary.failed).toBe(1);
    expect(loadAnalysis("s-missing")).toBeNull();
  });

  it("running 闸门：一批在跑时第二次触发被拒（busy）", async () => {
    insertSong("s-missing", "l:s1:/nonexistent/definitely-not-here-xyz.flac", "local");
    setOfflineMeasureEnabled(true);

    expect(startOfflineMeasure(1).started).toBe(true);
    expect(startOfflineMeasure(1)).toEqual({ started: false, reason: "busy" });

    // 收尾：等后台任务收摊，避免把悬挂 promise 留给下一个用例
    for (let i = 0; i < 100 && getMeasureStatus().running; i++) {
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(getMeasureStatus().running).toBe(false);
  });
});
