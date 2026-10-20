// P1-3:AirPlay 解码 af 链 + 输入合规 + stderr 捕获。
// 真实 ffmpeg(lavfi 合成音),无 mock —— 与 sendspin 单测同策略。
import { describe, it, expect } from "vitest";
import { spawnDecoder, buildAirplayAf } from "../../src/services/airplay/decoder.js";

describe("buildAirplayAf(2026-10-20 修订:解码侧只做 RAOP 输出段,不再二次归一)", () => {
  // 44.1k/16bit/stereo 与 dither 合并进同一条 aresample(与 MA 同构);链中已无 loudnorm → 走 soxr。
  const OUTPUT_ONLY = [
    "aresample=resampler=soxr:precision=30:osr=44100:osf=s16:dither_method=triangular_hp",
    "aformat=channel_layouts=stereo",
  ];

  it("只返回输出段,绝不含 loudnorm / alimiter(同一段音频不再归一两遍)", () => {
    const af = buildAirplayAf();
    expect(af).toEqual(OUTPUT_ONLY);
    expect(af.some((f) => f.includes("loudnorm"))).toBe(false);
    expect(af.some((f) => f.includes("alimiter"))).toBe(false);
  });

  it("逃生舱不再改变解码 af(响度归一已整体挪到出流侧公共链路)", () => {
    process.env.AIRPLAY_LOUDNESS = "0";
    try {
      expect(buildAirplayAf()).toEqual(OUTPUT_ONLY);
    } finally {
      delete process.env.AIRPLAY_LOUDNESS;
    }
    expect(buildAirplayAf()).toEqual(OUTPUT_ONLY);
  });
});

describe("spawnDecoder 输入合规 + stderr", () => {
  it("非回环 http 直接抛(SPEC §1.8),不启动进程", () => {
    expect(() => spawnDecoder("https://cdn.example.com/x.mp3")).toThrow(/SPEC §1.8/);
    expect(() => spawnDecoder("http://192.168.1.10/a.mp3")).toThrow(/SPEC §1.8/);
  });

  it("lavfi 全链跑通:链中已无 loudnorm,stderr 不再产出 input_i", async () => {    const ff = spawnDecoder("sine=frequency=440:duration=2:sample_rate=44100", undefined, {
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
    expect(text).not.toContain("input_i");
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
