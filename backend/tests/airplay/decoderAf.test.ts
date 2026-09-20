// P1-3:AirPlay 解码 af 链 + 输入合规 + stderr 捕获。
// 真实 ffmpeg(lavfi 合成音),无 mock —— 与 sendspin 单测同策略。
import { describe, it, expect } from "vitest";
import { spawnDecoder, buildAirplayAf } from "../../src/services/airplay/decoder.js";

describe("buildAirplayAf(P1-3)", () => {
  it("缺省:实时 loudnorm ＋ 限制器 ＋ 44100 重采样 ＋ triangular_hp", () => {
    const { af, hasLoudnorm } = buildAirplayAf({});
    expect(hasLoudnorm).toBe(true);
    expect(af[0]).toContain("loudnorm=I=-14");
    expect(af).toContain("alimiter=limit=-1dB:level=false:asc=true:latency=true");
    // 重采样＋dither 合并进同一个 aresample(与 MA 同构,分开写跑两遍)
    expect(af).toContain("aresample=resampler=swr:osr=44100:osf=s16:dither_method=triangular_hp");
    expect(af).toContain("aformat=channel_layouts=stereo");
  });

  it("逃生舱/单源关闭 → 响度段空,输出段保留(协议硬性要求)", () => {
    process.env.AIRPLAY_LOUDNESS = "0";
    try {
      const { af } = buildAirplayAf({});
      expect(af).toEqual([
        "aresample=resampler=soxr:precision=30:osr=44100:osf=s16:dither_method=triangular_hp",
        "aformat=channel_layouts=stereo",
      ]);
    } finally {
      delete process.env.AIRPLAY_LOUDNESS;
    }
    expect(buildAirplayAf({ loudness: { enabled: false } }).af).toEqual([
      "aresample=resampler=soxr:precision=30:osr=44100:osf=s16:dither_method=triangular_hp",
      "aformat=channel_layouts=stereo",
    ]);
  });

  it("有测量值走静态 volume(播过一次的本地行)", async () => {
    const { saveAnalysis, deleteAnalysis } = await import("../../src/services/audio/analysisStore.js");
    const { db } = await import("../../src/db/index.js");
    const { songs } = await import("../../src/db/schema.js");
    const { eq } = await import("drizzle-orm");
    db.insert(songs).values({
      id: "af-ap", title: "af", artist: "a", duration: 10,
      path: "/music/af.mp3", contentType: "audio/mpeg", type: "local",
    } as any).run();
    saveAnalysis("af-ap", "local", { loudnessIntegrated: -8 });
    try {
      const { af } = buildAirplayAf({ rowId: "af-ap" });
      expect(af[0]).toBe("volume=-6dB"); // -14 - (-8)
    } finally {
      deleteAnalysis("af-ap");
      db.delete(songs).where(eq(songs.id, "af-ap")).run();
    }
  });
});

describe("spawnDecoder 输入合规 + stderr", () => {
  it("非回环 http 直接抛(SPEC §1.8),不启动进程", () => {
    expect(() => spawnDecoder("https://cdn.example.com/x.mp3")).toThrow(/SPEC §1.8/);
    expect(() => spawnDecoder("http://192.168.1.10/a.mp3")).toThrow(/SPEC §1.8/);
  });

  it("lavfi 全链跑通:播完 stderr 打出 input_i(供 P0-4 解析)", async () => {    const ff = spawnDecoder("sine=frequency=440:duration=2:sample_rate=44100", undefined, {
      inputFormat: "lavfi",
    });
    // 必须有人排 stdout,否则管道满后 ffmpeg 憋住永不退出(生产由 producer 排)。
    ff.stdout.resume();
    ff.stdout.on("data", () => {});
    await new Promise<void>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error("ffmpeg 2s 音频未在限时播完")), 15000);
      ff.on("exit", () => { clearTimeout(t); resolve(); });
    });
    const text = ((ff as any).stderrText as () => string)();
    expect(text).toContain("input_i");
  }, 20_000);
});

describe("handleAirplaySessionEnded(P0-4 AirPlay 落点)", () => {
  const GOOD = [
    "ffmpeg version 7.1",
    "[Parsed_loudnorm_0 @ 0x7f0e4c0] {\n\t\"input_i\" : \"-9.54\",\n\t\"input_tp\" : \"-1.02\"\n}",
    "",
  ].join("\n");

  it("本地行入库、网络行丢弃、空 stderr 不炸", async () => {
    const { handleAirplaySessionEnded } = await import("../../src/services/airplay/control.js");
    const { db } = await import("../../src/db/index.js");
    const { songs } = await import("../../src/db/schema.js");
    const { eq } = await import("drizzle-orm");
    const { loadAnalysis, deleteAnalysis } = await import("../../src/services/audio/analysisStore.js");
    db.insert(songs).values({
      id: "ap-local", title: "a", artist: "a", duration: 10,
      path: "/music/ap.mp3", contentType: "audio/mpeg", type: "local",
    } as any).run();
    db.insert(songs).values({
      id: "ap-web", title: "b", artist: "b", duration: 10,
      path: "web:prov:qq", contentType: "audio/mpeg", type: "web",
      url: "http://orig/b.mp3", pluginEntry: "prov",
    } as any).run();
    try {
      await handleAirplaySessionEnded("dev-local", GOOD, "ap-local");
      expect(loadAnalysis("ap-local")?.loudnessIntegrated).toBeCloseTo(-9.54, 2);
      await handleAirplaySessionEnded("dev-web", GOOD, "ap-web");
      expect(loadAnalysis("ap-web")).toBeNull();
      await handleAirplaySessionEnded("dev-empty", "", "ap-local"); // 不抛
      await handleAirplaySessionEnded("dev-noid"); // 无曲无 stderr 不抛
    } finally {
      deleteAnalysis("ap-local");
      db.delete(songs).where(eq(songs.id, "ap-local")).run();
      db.delete(songs).where(eq(songs.id, "ap-web")).run();
    }
  }, 30_000);
});
