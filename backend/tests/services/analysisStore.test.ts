// P0-7:回写入库门控 + 删行联动 + 源不可达保护。
// MUST be the first import: redirects DATA_DIR to an isolated temp dir.
import "../plugins/_env.js";

import { describe, it, expect, beforeAll } from "vitest";
import { execFileSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { db, initDatabase } from "../../src/db/index.js";
import { songs } from "../../src/db/schema.js";
import { eq } from "drizzle-orm";
import {
  reportPlaybackLoudness,
  loadAnalysis,
  saveAnalysis,
  deleteAnalysis,
} from "../../src/services/audio/analysisStore.js";
import { deleteSongDb } from "../../src/routes/api/index.js";
import { scanLocalSource } from "../../src/services/source/scanner.js";
import { ffmpegBin } from "../../src/services/sendspin/encoding.js";

/** 与 loudness.test.ts 同形的 ffmpeg stderr 固件。 */
function ffmpegStderr(reportJson: string): string {
  return [
    "ffmpeg version 7.1 Copyright (c) 2000-2024 the FFmpeg developers",
    "  Stream #0:0: Audio: flac, 48000 Hz, stereo, s32",
    `[Parsed_loudnorm_0 @ 0x7f0e4c0] ${reportJson}`,
    "",
  ].join("\n");
}
const GOOD = ffmpegStderr('{\n\t"input_i" : "-9.54",\n\t"input_tp" : "-1.02"\n}');
const SILENT = ffmpegStderr('{\n\t"input_i" : "-inf",\n\t"input_tp" : "-inf"\n}');

function seedRow(id: string, type: string): void {
  db.insert(songs).values({
    id, title: `t-${id}`, artist: "a", duration: 100,
    path: type === "web" ? `web:prov:qq` : `/music/${id}.mp3`,
    contentType: "audio/mpeg", type,
    url: type === "web" ? `http://orig/${id}.mp3` : null,
    pluginEntry: type === "web" ? "prov" : null,
  } as any).run();
}

beforeAll(() => {
  initDatabase();
});

describe("reportPlaybackLoudness 入库门", () => {
  it("local 行 + 有效报告 → 入库", () => {
    seedRow("rep-local", "local");
    expect(reportPlaybackLoudness("rep-local", GOOD)).toBe(true);
    expect(loadAnalysis("rep-local")?.loudnessIntegrated).toBeCloseTo(-9.54, 2);
    deleteAnalysis("rep-local");
    db.delete(songs).where(eq(songs.id, "rep-local")).run();
  });

  it("web 行 + 有效报告 → 丢弃且 DB 无记录(D8)", () => {
    seedRow("rep-web", "web");
    expect(reportPlaybackLoudness("rep-web", GOOD)).toBe(false);
    expect(loadAnalysis("rep-web")).toBeNull();
    db.delete(songs).where(eq(songs.id, "rep-web")).run();
  });

  it("垃圾 stderr / 数字静音 / 不存在的行 → 一律 false 且无记录", () => {
    seedRow("rep-bad", "local");
    expect(reportPlaybackLoudness("rep-bad", "ffmpeg version 7.1\nno report\n")).toBe(false);
    expect(reportPlaybackLoudness("rep-bad", SILENT)).toBe(false);
    expect(reportPlaybackLoudness("no-such-row", GOOD)).toBe(false);
    expect(loadAnalysis("rep-bad")).toBeNull();
    db.delete(songs).where(eq(songs.id, "rep-bad")).run();
  });

  it("高层描述子 + extra_data round-trip(MA 全字段对齐)", () => {
    seedRow("rep-desc", "local");
    expect(saveAnalysis("rep-desc", "local", {
      danceability: 0.7, valence: 0.3, arousal: 0.9, speechiness: 0.1,
      instrumentalness: 0.8, acousticness: 0.2, brightness: 0.6,
      harmonicComplexity: 0.4, roughness: 0.15, rhythmicRegularity: 0.95,
      extraData: JSON.stringify({ provider: "x", v: 1 }),
    })).toBe(true);
    const rec = loadAnalysis("rep-desc")!;
    expect(rec.danceability).toBeCloseTo(0.7, 6);
    expect(rec.valence).toBeCloseTo(0.3, 6);
    expect(rec.rhythmicRegularity).toBeCloseTo(0.95, 6);
    expect(JSON.parse(rec.extraData!)).toEqual({ provider: "x", v: 1 });
    // 合并语义:后写响度不抹描述子
    expect(reportPlaybackLoudness("rep-desc", GOOD)).toBe(true);
    const rec2 = loadAnalysis("rep-desc")!;
    expect(rec2.loudnessIntegrated).toBeCloseTo(-9.54, 2);
    expect(rec2.danceability).toBeCloseTo(0.7, 6);
    deleteAnalysis("rep-desc");
    db.delete(songs).where(eq(songs.id, "rep-desc")).run();
  });
});

describe("删行联动清回写", () => {
  it("deleteSongDb删单曲 → 回写归零", () => {
    seedRow("del-one", "local");
    expect(saveAnalysis("del-one", "local", { loudnessIntegrated: -8 })).toBe(true);
    expect(deleteSongDb("del-one")).toBe(true);
    expect(loadAnalysis("del-one")).toBeNull();
  });

  it("本地扫描差集：文件删了 → 行删 + 回写清；源目录没了 → 抛错，回写保留", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "analysis-sweep-"));
    try {
      const mp3 = path.join(dir, "tone.mp3");
      execFileSync(ffmpegBin(), [
        "-hide_banner", "-loglevel", "error",
        "-f", "lavfi", "-i", "sine=frequency=440:duration=2:sample_rate=44100",
        "-ac", "2", "-ar", "44100", "-c:a", "libmp3lame", "-y", mp3,
      ]);
      await scanLocalSource("sweep1", { path: dir }, "full");
      const row = db.select().from(songs).all().find((r: any) => String(r.path || "").includes("tone.mp3"));
      expect(row).toBeTruthy();
      const rowId = (row as any).id as string;
      expect(saveAnalysis(rowId, "local", { loudnessIntegrated: -7 })).toBe(true);
      // 文件删掉再扫：行消失，回写跟着消失
      fs.rmSync(mp3);
      await scanLocalSource("sweep1", { path: dir }, "full");
      expect(db.select().from(songs).where(eq(songs.id, rowId)).get()).toBeUndefined();
      expect(loadAnalysis(rowId)).toBeNull();

      // 源目录整个没了：扫描直接抛错，回写不受影响
      const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), "analysis-sweep-keep-"));
      const mp32 = path.join(dir2, "keep.mp3");
      execFileSync(ffmpegBin(), [
        "-hide_banner", "-loglevel", "error",
        "-f", "lavfi", "-i", "sine=frequency=440:duration=2:sample_rate=44100",
        "-ac", "2", "-ar", "44100", "-c:a", "libmp3lame", "-y", mp32,
      ]);
      await scanLocalSource("sweep2", { path: dir2 }, "full");
      const row2 = db.select().from(songs).all().find((r: any) => String(r.path || "").includes("keep.mp3"));
      const rowId2 = (row2 as any).id as string;
      expect(saveAnalysis(rowId2, "local", { loudnessIntegrated: -6 })).toBe(true);
      fs.rmSync(dir2, { recursive: true, force: true });
      await expect(scanLocalSource("sweep2", { path: dir2 }, "full")).rejects.toThrow();
      expect(loadAnalysis(rowId2)?.loudnessIntegrated).toBeCloseTo(-6, 2);
      deleteAnalysis(rowId2);
      db.delete(songs).where(eq(songs.id, rowId2)).run();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 120_000);
});
