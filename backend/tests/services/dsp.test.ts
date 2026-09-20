// ==================== P4-4：DSP 滤镜链（③ 段，D6 四项） ====================
//
// 三层各锁一段，都属"错了不报错、只是听着不对/白烧 CPU"：
//   ① **零开销**：空配置不许往 ffmpeg 链里加任何滤镜（否则每首歌白过一遍滤镜图）；
//   ② **顺序**：preamp → 音色 → 参量 EQ → Balance → 输出增益（顺序错了听感完全不同）；
//   ③ **数值**：六种参量 EQ 的 biquad 系数**逐个 golden 比对**。
//
// ⚠️ golden 值怎么来的（不是"照着实现抄的"）：用 MA 自己的公式在 Python 里独立复算一遍
//   （`music-assistant/server@76c2fcb`，`helpers/dsp.py` 的 `filter_to_ffmpeg_params` /
//   `_pass_biquad_params`，`a = sqrt(10^(g/20))`、`alpha = sin(w0)/(2q)`），再按本仓
//   `fmtNum` 的「10 位小数去尾零」口径打印。所以这是**两份独立实现互证**，
//   而不是"改了实现顺手改期望值"。改公式必须同时说明 Python 侧为什么变。
import { describe, it, expect } from "vitest";
import {
  TONE_BANDS,
  buildFilterChain,
  butterworthSectionQs,
  dbToGain,
  eqBandFilter,
  eqBandFilters,
  fmtNum,
  hasDspWork,
  normalizeDspConfig,
  passOrder,
  type DspConfig,
} from "../../src/services/audio/dsp.js";

const F48 = { sampleRate: 48000, channels: 2 };
const F44 = { sampleRate: 44100, channels: 2 };

// ---- Python 侧复算出来的 golden（见文件头注释）----
const G = {
  peak1k6q07: "biquad=b0=1.131695105:b1=-1.9828897227:b2=0.868304895:a0=1.0660039054:a1=-1.9828897227:a2=0.9339960946",
  peak1k6q07FL: "biquad=b0=1.131695105:b1=-1.9828897227:b2=0.868304895:a0=1.0660039054:a1=-1.9828897227:a2=0.9339960946:c=FL",
  lowShelf100m4: "biquad=b0=1.6030487124:b1=-3.1770236198:b2=1.5742310638:a0=1.6068169792:a1=-3.1769487077:a2=1.5705377091",
  highShelf8000p3: "biquad=b0=4.3763490166:b1=-2.621343359:b2=1.0129209924:a0=3.524737653:a1=-1.4515766571:a2=0.6947656542",
  notch60q4: "biquad=b0=1:b1=-1.9999383153:b2=1:a0=1.0009817376:a1=-1.9999383153:a2=0.9990182624",
  highPass80: "biquad=b0=0.9999725847:b1=-1.9999451694:b2=0.9999725847:a0=1.0074057879:a1=-1.9998903387:a2=0.9925942121",
  lowPass12000: "biquad=b0=0.5:b1=1:b2=0.5:a0=1.7072135785:a1=0:a2=0.2927864215",
  // P4-5 级联陡度（MA `HighLowPassFilter`）：order = slope/6 节，每节 Q 不同。
  // 注意 slope=12 的 hp80 **与上面 `highPass80`（q=0.707）不同** —— 它用的是精确
  // Butterworth 极点 Q 0.7071067811865475，见下面 `butterworthSectionQs` 那条用例。
  hp80s12: "biquad=b0=0.9999725847:b1=-1.9999451694:b2=0.9999725847:a0=1.0074046696:a1=-1.9998903387:a2=0.9925953304",
  hp80s24a: "biquad=b0=0.9999725847:b1=-1.9999451694:b2=0.9999725847:a0=1.009674667:a1=-1.9998903387:a2=0.990325333",
  hp80s24b: "biquad=b0=0.9999725847:b1=-1.9999451694:b2=0.9999725847:a0=1.0040073783:a1=-1.9998903387:a2=0.9959926217",
  lp12k48a: "biquad=b0=0.5:b1=1:b2=0.5:a0=1.9807852804:a1=0:a2=0.0192147196",
  lp12k48b: "biquad=b0=0.5:b1=1:b2=0.5:a0=1.8314696123:a1=0:a2=0.1685303877",
  lp12k48c: "biquad=b0=0.5:b1=1:b2=0.5:a0=1.555570233:a1=0:a2=0.444429767",
  lp12k48d: "biquad=b0=0.5:b1=1:b2=0.5:a0=1.195090322:a1=0:a2=0.804909678",
};

describe("P4-1 零开销：空配置不加任何滤镜", () => {
  it("null / undefined / {} / 全 0 一律 []", () => {
    expect(buildFilterChain(null, F48)).toEqual([]);
    expect(buildFilterChain(undefined, F48)).toEqual([]);
    expect(buildFilterChain({}, F48)).toEqual([]);
    expect(
      buildFilterChain(
        {
          preampDb: 0,
          gainDb: 0,
          balance: 0,
          perChannelPreampDb: { FL: 0, FR: 0 },
          tone: { bassDb: 0, midDb: 0, trebleDb: 0 },
          parametricEq: { bands: [] },
        },
        F48,
      ),
    ).toEqual([]);
  });

  it("hasDspWork 与 buildFilterChain 结论一致（都是 0 才算没活）", () => {
    expect(hasDspWork({})).toBe(false);
    expect(hasDspWork({ tone: { bassDb: 0 } })).toBe(false);
    expect(hasDspWork({ tone: { bassDb: 1 } })).toBe(true);
    expect(hasDspWork({ gainDb: -0.5 })).toBe(true);
    expect(hasDspWork({ balance: 1 })).toBe(true);
    expect(hasDspWork({ perChannelPreampDb: { FR: 2 } })).toBe(true);
    expect(hasDspWork({ parametricEq: { bands: [{ type: "peak", frequency: 100, gainDb: 3, q: 1 }] } })).toBe(true);
    // 全部段都 disabled → 等于没配置
    expect(hasDspWork({ parametricEq: { bands: [{ type: "peak", frequency: 100, gainDb: 3, q: 1, enabled: false }] } })).toBe(false);
  });
});

describe("P4-1 顺序：preamp → 音色 → 参量 EQ → Balance → 输出增益", () => {
  const cfg: DspConfig = {
    preampDb: -6,
    tone: { bassDb: 3, midDb: 0, trebleDb: -2 },
    parametricEq: { bands: [{ type: "peak", frequency: 1000, gainDb: 6, q: 0.7 }] },
    balance: 30,
    gainDb: 2,
  };

  it("四项齐全时的片段顺序逐项固定", () => {
    expect(buildFilterChain(cfg, F48)).toEqual([
      "volume=-6dB",
      "equalizer=frequency=100:width=200:width_type=h:gain=3",
      "equalizer=frequency=9000:width=18000:width_type=h:gain=-2",
      G.peak1k6q07,
      "pan=stereo|FL=0.7*FL|FR=FR",
      "volume=2dB",
    ]);
  });

  it("只有 preamp 与输出增益时，两个 volume 一前一后", () => {
    const out = buildFilterChain({ preampDb: -6, gainDb: 3 }, F48);
    expect(out).toEqual(["volume=-6dB", "volume=3dB"]);
  });

  it("链尾是输出增益：Balance 之后不再有任何音色滤镜", () => {
    const out = buildFilterChain({ tone: { bassDb: 3 }, balance: -20, gainDb: 1 }, F48);
    expect(out[out.length - 1]).toBe("volume=1dB");
    expect(out[out.length - 2]).toBe("pan=stereo|FL=FL|FR=0.8*FR");
  });
});

describe("P4-1 三段音色（MA `ToneControlFilter`）", () => {
  it("三段 frequency/width 常量照 MA：100/200、900/1800、9000/18000，width_type=h", () => {
    expect(TONE_BANDS.map((b) => [b.frequency, b.width])).toEqual([[100, 200], [900, 1800], [9000, 18000]]);
    const out = buildFilterChain({ tone: { bassDb: 4, midDb: -3, trebleDb: 2 } }, F48);
    expect(out).toEqual([
      "equalizer=frequency=100:width=200:width_type=h:gain=4",
      "equalizer=frequency=900:width=1800:width_type=h:gain=-3",
      "equalizer=frequency=9000:width=18000:width_type=h:gain=2",
    ]);
  });

  it("某一段为 0 → 该段**不加滤镜**（不是加个 gain=0）", () => {
    expect(buildFilterChain({ tone: { midDb: 4 } }, F48)).toEqual([
      "equalizer=frequency=900:width=1800:width_type=h:gain=4",
    ]);
    expect(buildFilterChain({ tone: { bassDb: 0, midDb: 0, trebleDb: 0 } }, F48)).toEqual([]);
  });

  it("小数增益按 fmtNum 口径（不出现 3.5000000000000004 这种）", () => {
    expect(buildFilterChain({ tone: { bassDb: 3.5 } }, F48)).toEqual([
      "equalizer=frequency=100:width=200:width_type=h:gain=3.5",
    ]);
  });
});

describe("P4-1 参量 EQ：biquad 系数与 MA 独立复算逐字符一致", () => {
  it("PEAK / LOW_SHELF / HIGH_SHELF / NOTCH / HIGH_PASS / LOW_PASS 六种", () => {
    expect(eqBandFilter({ type: "peak", frequency: 1000, gainDb: 6, q: 0.7 }, 48000)).toBe(G.peak1k6q07);
    expect(eqBandFilter({ type: "low_shelf", frequency: 100, gainDb: -4, q: 0.7 }, 44100)).toBe(G.lowShelf100m4);
    expect(eqBandFilter({ type: "high_shelf", frequency: 8000, gainDb: 3, q: 0.7 }, 44100)).toBe(G.highShelf8000p3);
    expect(eqBandFilter({ type: "notch", frequency: 60, q: 4 }, 48000)).toBe(G.notch60q4);
    expect(eqBandFilter({ type: "high_pass", frequency: 80, q: 0.707 }, 48000)).toBe(G.highPass80);
    expect(eqBandFilter({ type: "low_pass", frequency: 12000, q: 0.707 }, 48000)).toBe(G.lowPass12000);
  });

  it("PEAK 增益 0 dB ⇒ 分子分母完全相等（纯直通），系数仍是 MA 的形状", () => {
    const s = eqBandFilter({ type: "peak", frequency: 1000, gainDb: 0, q: 0.7 }, 48000) as string;
    const v = Object.fromEntries(s.replace("biquad=", "").split(":").map((kv) => kv.split("=")));
    expect(v.b0).toBe(v.a0);
    expect(v.b1).toBe(v.a1);
    expect(v.b2).toBe(v.a2);
  });

  it("`channel` 非 all 加 `:c=<通道>`；`enabled:false` / 非法频率 / 未知类型一律跳过", () => {
    expect(eqBandFilter({ type: "peak", frequency: 1000, gainDb: 6, q: 0.7, channel: "FL" }, 48000)).toBe(G.peak1k6q07FL);
    expect(eqBandFilter({ type: "peak", frequency: 1000, gainDb: 6, q: 0.7, enabled: false }, 48000)).toBeNull();
    expect(eqBandFilter({ type: "peak", frequency: 0, gainDb: 6, q: 0.7 }, 48000)).toBeNull();
    expect(eqBandFilter({ type: "peak", frequency: NaN, gainDb: 6, q: 0.7 }, 48000)).toBeNull();
    expect(eqBandFilter({ type: "bogus" as any, frequency: 1000, q: 1 }, 48000)).toBeNull();
  });

  it("多段按配置顺序串接（PEAK 在前、NOTCH 在后）", () => {
    const out = buildFilterChain(
      {
        parametricEq: {
          bands: [
            { type: "peak", frequency: 1000, gainDb: 6, q: 0.7 },
            { type: "notch", frequency: 60, q: 4 },
            { type: "peak", frequency: 2000, gainDb: 3, q: 1, enabled: false },
          ],
        },
      },
      F48,
    );
    expect(out).toEqual([G.peak1k6q07, G.notch60q4]);
  });
});

describe("P4-1 Gain / Balance", () => {
  it("Balance 只衰减一侧、另一侧原样（源码注释：避免正增益造削波）", () => {
    expect(buildFilterChain({ balance: 30 }, F48)).toEqual(["pan=stereo|FL=0.7*FL|FR=FR"]);
    expect(buildFilterChain({ balance: -45 }, F48)).toEqual(["pan=stereo|FL=FL|FR=0.55*FR"]);
    // 左端到底 = 右侧全静音
    expect(buildFilterChain({ balance: -100 }, F48)).toEqual(["pan=stereo|FL=FL|FR=0*FR"]);
  });

  it("Balance 系数恒 ≤ 1（绝不出现 >1 的正增益）", () => {
    for (const b of [-100, -50, -10, 10, 50, 100]) {
      const out = buildFilterChain({ balance: b }, F48);
      const coef = Number(out[0].match(/=([\d.]+)\*/)![1]);
      expect(coef).toBeLessThanOrEqual(1);
      expect(coef).toBeGreaterThanOrEqual(0);
    }
  });

  it("越界的 balance 被钳到 ±100（滑块不该能造出负系数）", () => {
    expect(buildFilterChain({ balance: 300 }, F48)).toEqual(["pan=stereo|FL=0*FL|FR=FR"]);
    expect(buildFilterChain({ balance: -300 }, F48)).toEqual(["pan=stereo|FL=FL|FR=0*FR"]);
  });

  it("单声道源走 MA 的另一套写法（mono 没有 FL/FR 可 pan）", () => {
    expect(buildFilterChain({ balance: 30 }, { sampleRate: 48000, channels: 1 })).toEqual([
      "pan=stereo|FL=0.7*c0|FR=c0",
    ]);
  });

  it("分声道前置增益走 pan（volume 只能整条流一起动），0 的一侧写恒等 `FL=FL`", () => {
    expect(buildFilterChain({ perChannelPreampDb: { FR: -3.5 } }, F48)).toEqual([
      "pan=stereo|FL=FL|FR=0.6683439176*FR",
    ]);
    // 有分声道值时不再单独发 preamp 的 volume：它叠加进每一侧
    expect(buildFilterChain({ preampDb: 6, perChannelPreampDb: { FR: -3.5 } }, F48)).toEqual([
      "pan=stereo|FL=1.995262315*FL|FR=1.3335214322*FR",
    ]);
  });

  it("dbToGain 就是 MA 的 `10 ** (db/20)`", () => {
    expect(fmtNum(dbToGain(6))).toBe("1.995262315");
    expect(fmtNum(dbToGain(-3.5))).toBe("0.6683439176");
    expect(fmtNum(dbToGain(0))).toBe("1");
  });
});

describe("P4-1 分组禁用（照 plan §3.3 的 MA 约束）", () => {
  it("成组后 per-player DSP 整体禁用，即使配置非空", () => {
    const loud: DspConfig = { preampDb: -6, tone: { bassDb: 5 }, balance: 20, gainDb: 2 };
    expect(buildFilterChain(loud, F48)).not.toEqual([]);
    expect(buildFilterChain(loud, F48, { grouped: true })).toEqual([]);
    // grouped 缺省 = 不分组
    expect(buildFilterChain(loud, F48, {})).not.toEqual([]);
  });
});

describe("fmtNum：滤镜参数里的数字文本必须稳定", () => {
  it("整数不带小数点、负零归零、非有限值归 0", () => {
    expect(fmtNum(1)).toBe("1");
    expect(fmtNum(-0)).toBe("0");
    expect(fmtNum(0)).toBe("0");
    expect(fmtNum(NaN)).toBe("0");
    expect(fmtNum(Infinity)).toBe("0");
    expect(fmtNum(0.7071067811865476)).toBe("0.7071067812");
    expect(fmtNum(-1.9828897227468877)).toBe("-1.9828897227");
  });
});

// ==================== P4-5：高/低通的陡度（对齐 MA `HighLowPassFilter`） ====================
//
// MA 有**两个**高/低通入口，别混（`helpers/dsp.py` + `music-assistant-models@1.1.212`）：
//   ① 参量 EQ band 的 `high_pass`/`low_pass`：单节、用 band 的 `q`（`ParametricEQBand.q` **默认 1.0**）；
//   ② 独立的 `HighLowPassFilter`：用 `slope`（12/24/48 dB/oct）⇒ `order = slope/6` 节
//      **级联 Butterworth**，第 s 节 `q = 1/(2·cos(π(2s+1)/(2·order)))`（`dsp.py:237-249`）。
// 本仓 `EqBand.slope` 就是 ②，不填即等价 ① —— 故下面既锁级联，也锁"不填仍是单节"。
describe("P4-5 高/低通陡度：slope ⇒ 级联 Butterworth（MA `HighLowPassFilter`）", () => {
  it("passOrder：只认 12/24/48（MA `HighLowPassSlope`），其余一律 0", () => {
    expect(passOrder(12)).toBe(2);
    expect(passOrder(24)).toBe(4);
    expect(passOrder(48)).toBe(8);
    expect(passOrder(0)).toBe(0);
    expect(passOrder(18)).toBe(0); // 非 6 的整数倍
    expect(passOrder(-12)).toBe(0);
    expect(passOrder(undefined)).toBe(0);
    expect(passOrder("24")).toBe(0); // 只认数字（字符串转换是 normalizeDspConfig 那一层的事）
  });

  it("butterworthSectionQs：各节极点 Q 与 MA 公式复算一致", () => {
    expect(butterworthSectionQs(2)).toEqual([0.7071067811865475]);
    expect(butterworthSectionQs(4)).toEqual([0.541196100146197, 1.3065629648763764]);
    expect(butterworthSectionQs(8)).toEqual([
      0.5097955791041592,
      0.6013448869350453,
      0.8999762231364156,
      2.5629154477415055,
    ]);
    // 奇数阶 / 过小 → 空（不能拼出"半个节"）
    expect(butterworthSectionQs(3)).toEqual([]);
    expect(butterworthSectionQs(1)).toEqual([]);
    expect(butterworthSectionQs(0)).toEqual([]);
    expect(butterworthSectionQs(NaN)).toEqual([]);
  });

  it("给了 slope 就展成 order 节（golden 与 Python 独立复算逐字符一致）", () => {
    expect(eqBandFilters({ type: "high_pass", frequency: 80, slope: 12, q: 1 }, 48000)).toEqual([G.hp80s12]);
    expect(eqBandFilters({ type: "high_pass", frequency: 80, slope: 24, q: 1 }, 48000)).toEqual([
      G.hp80s24a,
      G.hp80s24b,
    ]);
    expect(eqBandFilters({ type: "low_pass", frequency: 12000, slope: 48, q: 1 }, 48000)).toEqual([
      G.lp12k48a,
      G.lp12k48b,
      G.lp12k48c,
      G.lp12k48d,
    ]);
  });

  it("级联 ≠ 把同一节重复 N 次（各节 Q 不同，这正是 Butterworth 的要点）", () => {
    const cascaded = eqBandFilters({ type: "high_pass", frequency: 80, slope: 24, q: 1 }, 48000);
    expect(cascaded).toHaveLength(2);
    expect(cascaded[0]).not.toBe(cascaded[1]);
    const single = eqBandFilters({ type: "high_pass", frequency: 80, q: 1 }, 48000);
    expect(single).toHaveLength(1);
    expect(cascaded).not.toContain(single[0]);
  });

  it("slope 生效时 band 的 q 被忽略（改 q 结果不变）", () => {
    const a = eqBandFilters({ type: "low_pass", frequency: 500, slope: 24, q: 0.3 }, 48000);
    const b = eqBandFilters({ type: "low_pass", frequency: 500, slope: 24, q: 12 }, 48000);
    expect(a).toEqual(b);
  });

  it("不给 slope ⇒ 仍是单节、用 band 的 q（MA 参量 EQ band 语义）", () => {
    expect(eqBandFilters({ type: "high_pass", frequency: 80, q: 0.707 }, 48000)).toEqual([G.highPass80]);
    expect(eqBandFilters({ type: "low_pass", frequency: 12000, q: 0.707 }, 48000)).toEqual([G.lowPass12000]);
    // 单节入口 = 首片
    expect(eqBandFilter({ type: "high_pass", frequency: 80, q: 0.707 }, 48000)).toBe(G.highPass80);
  });

  it("buildFilterChain 把级联逐节落链（顺序即节序）", () => {
    const chain = buildFilterChain(
      { parametricEq: { bands: [{ type: "high_pass", frequency: 80, slope: 24 }] } },
      F48,
    );
    expect(chain).toEqual([G.hp80s24a, G.hp80s24b]);
  });

  it("normalizeDspConfig：合法 slope 保留，非法值丢弃（不静默回落 12）", () => {
    const ok = normalizeDspConfig({ parametricEq: { bands: [{ type: "high_pass", frequency: 80, slope: 24 }] } });
    expect(ok?.parametricEq?.bands?.[0]?.slope).toBe(24);
    const bad = normalizeDspConfig({ parametricEq: { bands: [{ type: "low_pass", frequency: 80, slope: 18 }] } });
    expect(bad?.parametricEq?.bands?.[0]?.slope).toBeUndefined();
  });
});
