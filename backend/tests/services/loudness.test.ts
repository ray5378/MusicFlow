// P0 三个纯函数的单测 —— 失败容忍必须与 MA 一致，故逐条锚 ffmpeg 的真实输出形态。
// 对齐对象（dev 76c2fcb）：parse_loudnorm=helpers/audio.py:881-901、
// get_normalization_mode=helpers/audio.py:904-960。
import { describe, it, expect } from "vitest";
import {
  parseLoudnorm,
  chooseMode,
  computeGainDb,
  type NormalizationPreference,
} from "../../src/services/audio/loudness.js";

/** 造一段像模像样的 ffmpeg stderr：loudnorm 报告是「最后一块 JSON」，位置不固定。 */
function ffmpegStderr(reportJson: string, extraFilter = ""): string {
  return [
    "ffmpeg version 7.1 Copyright (c) 2000-2024 the FFmpeg developers",
    "  Stream #0:0: Audio: flac, 48000 Hz, stereo, s32",
    extraFilter,
    `[Parsed_loudnorm_0 @ 0x7f0e4c0] ${reportJson}`,
    "",
  ].join("\n");
}

describe("parseLoudnorm —— ffmpeg loudnorm 报告解析", () => {
  it("正常报告取 input_i / input_tp", () => {
    const out = ffmpegStderr(
      '{\n\t"input_i" : "-9.54",\n\t"input_tp" : "-1.02",\n\t"input_lra" : "5.30",\n\t"target_tp" : "-1.00"\n}',
    );
    expect(parseLoudnorm(out)).toEqual({ inputI: -9.54, inputTp: -1.02 });
  });

  it("数字静音(input_i = -inf)返回 null —— 没有电平可校正", () => {
    const out = ffmpegStderr('{\n\t"input_i" : "-inf",\n\t"input_tp" : "-inf"\n}');
    expect(parseLoudnorm(out)).toBeNull();
  });

  it("JSON 解析失败返回 null", () => {
    const out = ffmpegStderr('{\n\t"input_i" : "-9.54",'); // 被截断，无闭合
    expect(parseLoudnorm(out)).toBeNull();
  });

  it("没有 loudnorm 标记返回 null", () => {
    expect(parseLoudnorm("ffmpeg version 7.1\n没有任何报告\n")).toBeNull();
  });

  it("缺 input_i 字段返回 null", () => {
    const out = ffmpegStderr('{\n\t"input_tp" : "-1.02"\n}');
    expect(parseLoudnorm(out)).toBeNull();
  });

  it("input_tp 缺失时只丢该字段，input_i 仍可用", () => {
    const out = ffmpegStderr('{\n\t"input_i" : "-14.20"\n}');
    expect(parseLoudnorm(out)).toEqual({ inputI: -14.2, inputTp: null });
  });

  it("接受 bytes 输入（ffmpeg stderr 常以 Buffer 形式给到调用方）", () => {
    const out = Buffer.from(ffmpegStderr('{\n\t"input_i" : "-11.11",\n\t"input_tp" : "-0.50"\n}'));
    expect(parseLoudnorm(out)).toEqual({ inputI: -11.11, inputTp: -0.5 });
  });

  it("多个 loudnorm 标记取最后一个（rfind 语义：报告是 filter 最后的输出）", () => {
    const out = [
      '[Parsed_loudnorm_0 @ 0x1] {\n"input_i" : "-30.00",\n"input_tp" : "-9.00"\n}',
      '[Parsed_loudnorm_1 @ 0x2] {\n"input_i" : "-8.00",\n"input_tp" : "-1.00"\n}',
    ].join("\n");
    expect(parseLoudnorm(out)).toEqual({ inputI: -8, inputTp: -1 });
  });
});

describe("chooseMode —— 归一化模式决策（顺序照 MA get_normalization_mode）", () => {
  const base = {
    enabled: true,
    preference: "measurement_only" as NormalizationPreference,
    targetLoudness: -16,
    measuredLoudness: -14.2,
  };

  it("未启用 → disabled", () => {
    expect(chooseMode({ ...base, enabled: false })).toBe("disabled");
  });

  it("直播/实时源 → disabled（响度归上游负责）", () => {
    expect(chooseMode({ ...base, liveSource: true })).toBe("disabled");
  });

  it("源侧已对齐 → source（不再二次校正）", () => {
    expect(chooseMode({ ...base, sourceNormalized: true })).toBe("source");
  });

  it("短音效 → disabled（照 MA SOUND_EFFECT，动态压缩不碰短片段）", () => {
    expect(chooseMode({ ...base, isSoundEffect: true })).toBe("disabled");
    expect(chooseMode({ ...base, isSoundEffect: true, measuredLoudness: -9 })).toBe("disabled");
  });

  it("没设目标响度 → disabled", () => {
    expect(chooseMode({ ...base, targetLoudness: null })).toBe("disabled");
    expect(chooseMode({ ...base, targetLoudness: Number.NaN })).toBe("disabled");
  });

  it("无测量 + fallback_dynamic → dynamic（首次播放即生效的关键支路）", () => {
    expect(
      chooseMode({ ...base, measuredLoudness: null, preference: "fallback_dynamic" }),
    ).toBe("dynamic");
  });

  it("无测量 + measurement_only → disabled", () => {
    expect(
      chooseMode({ ...base, measuredLoudness: null, preference: "measurement_only" }),
    ).toBe("disabled");
  });

  it("无测量 + fallback_fixed_gain → fixed_gain", () => {
    expect(
      chooseMode({ ...base, measuredLoudness: null, preference: "fallback_fixed_gain" }),
    ).toBe("fixed_gain");
  });

  it("无测量 + dynamic → dynamic（直通原倾向）", () => {
    expect(chooseMode({ ...base, measuredLoudness: null, preference: "dynamic" })).toBe("dynamic");
  });

  it("已测量 + measurement_only / fallback_* → measurement_only", () => {
    for (const preference of ["measurement_only", "fallback_dynamic", "fallback_fixed_gain"]) {
      expect(chooseMode({ ...base, preference: preference as NormalizationPreference })).toBe(
        "measurement_only",
      );
    }
  });

  it("已测量 + fixed_gain / dynamic → 按原倾向直通（无视测量）", () => {
    expect(chooseMode({ ...base, preference: "fixed_gain" })).toBe("fixed_gain");
    expect(chooseMode({ ...base, preference: "dynamic" })).toBe("dynamic");
  });
});

describe("computeGainDb —— 静态增益(全面对齐 MA,不限幅)", () => {
  it("目标比实测低则衰减（负增益）", () => {
    expect(computeGainDb(-16, -9.5)).toBeCloseTo(-6.5, 5);
  });

  it("目标比实测高则提升（正增益）", () => {
    expect(computeGainDb(-16, -22)).toBeCloseTo(6, 5);
  });

  it("大差值不限幅(照 MA 裸差值 round 2 位,削波由⑤限制器兜底)", () => {
    // -16 - (-40) = +24 dB,照 MA 原样输出
    expect(computeGainDb(-16, -40)).toBe(24);
    expect(computeGainDb(-16, 0)).toBe(-16);
    expect(computeGainDb(-14.567, -9.123)).toBeCloseTo(-5.44, 2);
  });

  it("任一侧缺失或非有限 → 0 dB（拿不到依据就不动音量）", () => {
    expect(computeGainDb(null, -9.5)).toBe(0);
    expect(computeGainDb(-16, null)).toBe(0);
    expect(computeGainDb(Number.NaN, -9.5)).toBe(0);
    expect(computeGainDb(-16, Number.POSITIVE_INFINITY)).toBe(0);
  });
});
