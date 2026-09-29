// ==================== 覆盖率 C 类缺口:DSP 单声道 balance 衰减 + 分声道前置增益归一化 ====================
//
// 目标:src/services/audio/dsp.ts
//   ① buildFilterChain 381 行:单声道源 + balance ≤ 0 的右声道衰减分支
//      `pan=stereo|FL=c0|FR=${attenuation}*c0`(mono 没有 FL/FR 可 pan,照 MA 另一套写法);
//   ② normalizeDspConfig 433-438:perChannelPreampDb 的 FL/FR 组装分支 ——
//      非零值保留、零值丢弃、双零则字段不产出。
//
// 调用手法照抄 tests/services/dsp.test.ts:纯函数直调,断言 ffmpeg `-af` 片段串。
import { describe, it, expect } from "vitest";
import {
  buildFilterChain,
  normalizeDspConfig,
} from "../../src/services/audio/dsp.js";

const MONO = { sampleRate: 48000, channels: 1 };
const STEREO = { sampleRate: 48000, channels: 2 };

describe("buildFilterChain:单声道源的 Balance(381 行分支)", () => {
  it("mono + balance<0 → 衰减系数写进右声道 c0,左声道恒等", () => {
    expect(buildFilterChain({ balance: -30 }, MONO)).toEqual([
      "pan=stereo|FL=c0|FR=0.7*c0",
    ]);
  });

  it("mono + balance=-100 → 右声道完全静音(系数 0)", () => {
    expect(buildFilterChain({ balance: -100 }, MONO)).toEqual([
      "pan=stereo|FL=c0|FR=0*c0",
    ]);
  });

  it("多声道源(6ch)没有 c0 之外的合法写法 → balance 不产出任何 pan 片段", () => {
    expect(buildFilterChain({ balance: -30 }, { sampleRate: 48000, channels: 6 })).toEqual([]);
  });
});

describe("normalizeDspConfig:perChannelPreampDb 组装分支(433-438)", () => {
  it("FL/FR 都非零 → 两个字段都保留", () => {
    const out = normalizeDspConfig({ perChannelPreampDb: { FL: 3, FR: -2 } });
    expect(out?.perChannelPreampDb).toEqual({ FL: 3, FR: -2 });
  });

  it("只有 FL 非零(FR=0 / 字符串数字)→ 只保留 FL,零值丢弃", () => {
    const out = normalizeDspConfig({ perChannelPreampDb: { FL: "3", FR: 0 } });
    expect(out?.perChannelPreampDb).toEqual({ FL: 3 });
  });

  it("只有 FR 非零 → 只保留 FR", () => {
    const out = normalizeDspConfig({ perChannelPreampDb: { FL: 0, FR: -2 } });
    expect(out?.perChannelPreampDb).toEqual({ FR: -2 });
  });

  it("FL/FR 全零 → 字段不产出;再无其它配置时整体归 null(零开销)", () => {
    expect(normalizeDspConfig({ perChannelPreampDb: { FL: 0, FR: 0 } })).toBeNull();
  });

  it("归一化后的分声道配置直接落成 pan 链:零的一侧写恒等 FL=FL(不写 1*FL)", () => {
    const flOnly = normalizeDspConfig({ perChannelPreampDb: { FL: 3 } })!;
    expect(buildFilterChain(flOnly, STEREO)).toEqual([
      "pan=stereo|FL=1.4125375446*FL|FR=FR",
    ]);
    const frOnly = normalizeDspConfig({ perChannelPreampDb: { FR: -2 } })!;
    expect(buildFilterChain(frOnly, STEREO)).toEqual([
      "pan=stereo|FL=FL|FR=0.7943282347*FR",
    ]);
  });
});
