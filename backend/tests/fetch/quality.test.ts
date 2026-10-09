import { describe, expect, it } from "vitest";
import {
  TIER_RANK,
  classifyTier,
  effectiveBitrateKbps,
  isFakeLossless,
  meetsFloor,
  rankCandidates,
  scoreCandidate,
  shouldUpgrade,
} from "../../src/services/fetch/quality.js";
import { DEFAULT_QUALITY_CONFIG } from "../../src/services/fetch/types.js";
import type { Candidate, QualityConfig } from "../../src/services/fetch/types.js";

/** 构造一个默认合规的候选（wx 平台 mp3 320）。 */
function mk(over: Partial<Candidate> = {}): Candidate {
  return {
    id: "lx-source:wy:1",
    pluginId: "lx-source",
    platform: "wy",
    url: "https://cdn.example.com/1.mp3",
    sourceRank: 0,
    title: "爱在西元前",
    artist: "周杰伦",
    album: "范特西",
    ...over,
  };
}

function cfgOf(over: Partial<QualityConfig> = {}): QualityConfig {
  return { ...DEFAULT_QUALITY_CONFIG, ...over };
}

/** 由「目标有效比特率 + 时长」反推字节数，便于构造探针数据。 */
function bytesFor(kbps: number, durationSec: number): number {
  return Math.round((kbps * 1000 * durationSec) / 8);
}

describe("effectiveBitrateKbps", () => {
  it("正常换算:4,000,000 字节 / 100s = 320kbps", () => {
    expect(effectiveBitrateKbps(4_000_000, 100)).toBeCloseTo(320, 6);
  });

  it("duration = 0 返回 0(不可换算)", () => {
    expect(effectiveBitrateKbps(4_000_000, 0)).toBe(0);
  });

  it("字节数为 0 返回 0", () => {
    expect(effectiveBitrateKbps(0, 100)).toBe(0);
  });
});

describe("classifyTier", () => {
  it("24bit/96kHz flac → hires", () => {
    expect(classifyTier({ container: "flac", sampleRateHz: 96000, bitDepth: 24 })).toBe("hires");
  });

  it("24bit/48kHz flac 也算 hires(位深 > 16)", () => {
    expect(classifyTier({ container: "flac", sampleRateHz: 48000, bitDepth: 24 })).toBe("hires");
  });

  it("16bit/44.1kHz flac → lossless", () => {
    expect(classifyTier({ container: "flac", sampleRateHz: 44100, bitDepth: 16 })).toBe("lossless");
  });

  it("只给容器没给位深的 flac → lossless", () => {
    expect(classifyTier({ container: "flac" })).toBe("lossless");
  });

  it("320kbps mp3 → 320 档", () => {
    expect(classifyTier({ container: "mp3", bitrateKbps: 320 })).toBe("320");
  });

  it("1411kbps wav → lossless(按容器判定,不归到 320)", () => {
    expect(classifyTier({ container: "wav", bitrateKbps: 1411 })).toBe("lossless");
  });

  it("有损档位按「不超过的最近档」归类", () => {
    expect(classifyTier({ container: "mp3", bitrateKbps: 256 })).toBe("256");
    expect(classifyTier({ container: "mp3", bitrateKbps: 192 })).toBe("192");
    expect(classifyTier({ container: "mp3", bitrateKbps: 128 })).toBe("128");
    expect(classifyTier({ container: "mp3", bitrateKbps: 300 })).toBe("256");
    expect(classifyTier({ container: "mp3", bitrateKbps: 999 })).toBe("320");
  });

  it("缺字段 → unknown", () => {
    expect(classifyTier({})).toBe("unknown");
  });

  it("TIER_RANK 单调:unknown 最低、hires 最高", () => {
    expect(TIER_RANK.unknown).toBeLessThan(TIER_RANK["128"]);
    expect(TIER_RANK["320"]).toBeLessThan(TIER_RANK.lossless);
    expect(TIER_RANK.lossless).toBeLessThan(TIER_RANK.hires);
  });
});

describe("isFakeLossless", () => {
  it("meta 模式:encoder 命中 Lavc → 判假", () => {
    const c = mk({
      probed: { container: "flac", sampleRateHz: 44100, bitDepth: 16, encoder: "Lavc58.134.100 flac" },
    });
    const r = isFakeLossless(c, cfgOf({ fakeLosslessDetect: "meta" }));
    expect(r.fake).toBe(true);
    expect(r.reason).toContain("Lavc");
  });

  it("bitrate 模式:有效比特率 612kbps < 700 → 判假", () => {
    const c = mk({
      probed: { container: "flac", sampleRateHz: 44100, bitDepth: 16, bytes: bytesFor(612, 100), durationSec: 100 },
    });
    const r = isFakeLossless(c, cfgOf({ fakeLosslessDetect: "bitrate" }));
    expect(r.fake).toBe(true);
    expect(r.reason).toBe("effective 612kbps < 700");
  });

  it("spectrum 模式:未实现,恒不判假", () => {
    const c = mk({ probed: { container: "flac", bitDepth: 16 } });
    const r = isFakeLossless(c, cfgOf({ fakeLosslessDetect: "spectrum" }));
    expect(r.fake).toBe(false);
    expect(r.reason).toBe("not-implemented");
  });

  it("off:恒不判假", () => {
    const c = mk({
      probed: { container: "flac", encoder: "Lavc58", bytes: bytesFor(320, 100), durationSec: 100 },
    });
    expect(isFakeLossless(c, cfgOf({ fakeLosslessDetect: "off" })).fake).toBe(false);
  });

  it("真无损不被误判:有效比特率 900kbps 的 flac", () => {
    const c = mk({
      probed: { container: "flac", sampleRateHz: 44100, bitDepth: 16, bytes: bytesFor(900, 100), durationSec: 100 },
    });
    const r = isFakeLossless(c, cfgOf({ fakeLosslessDetect: "bitrate" }));
    expect(r.fake).toBe(false);
    expect(r.reason).toBe("effective 900kbps >= 700");
  });

  it("非无损容器不参与假无损判定", () => {
    const c = mk({ probed: { container: "mp3", bitrateKbps: 320 } });
    expect(isFakeLossless(c, cfgOf({ fakeLosslessDetect: "meta" })).fake).toBe(false);
  });
});

describe("meetsFloor", () => {
  it("合格样本:mp3 320kbps 通过默认门槛", () => {
    const c = mk({ declared: { container: "mp3", bitrateKbps: 320, durationSec: 240, sampleRateHz: 44100 } });
    expect(meetsFloor(c, cfgOf()).ok).toBe(true);
  });

  it("容器不在白名单 → 拒绝", () => {
    const c = mk({ declared: { container: "wma", bitrateKbps: 320 } });
    const r = meetsFloor(c, cfgOf({ allowedContainers: ["mp3", "flac"] }));
    expect(r.ok).toBe(false);
    expect(r.reason).toContain("wma");
  });

  it("时长过短 → 拒绝", () => {
    const c = mk({ declared: { container: "mp3", bitrateKbps: 320, durationSec: 20 } });
    const r = meetsFloor(c, cfgOf());
    expect(r.ok).toBe(false);
    expect(r.reason).toContain("短于下限");
  });

  it("采样率不足 → 拒绝", () => {
    const c = mk({ declared: { container: "mp3", bitrateKbps: 320, sampleRateHz: 22050 } });
    const r = meetsFloor(c, cfgOf());
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("采样率 22050Hz 低于下限 44100Hz");
  });

  it("档位不够 → 拒绝", () => {
    const c = mk({ declared: { container: "mp3", bitrateKbps: 192, durationSec: 240, sampleRateHz: 44100 } });
    const r = meetsFloor(c, cfgOf({ qualityFloor: "320", minBitrateKbps: 0 }));
    expect(r.ok).toBe(false);
    expect(r.reason).toContain("低于门槛");
  });

  it("比特率低于 minBitrateKbps → 拒绝", () => {
    const c = mk({ declared: { container: "mp3", bitrateKbps: 256, durationSec: 240, sampleRateHz: 44100 } });
    const r = meetsFloor(c, cfgOf({ qualityFloor: "any", minBitrateKbps: 320 }));
    expect(r.ok).toBe(false);
    expect(r.reason).toContain("低于下限 320kbps");
  });

  it("标题命中排除关键词 → 拒绝", () => {
    const c = mk({
      title: "爱在西元前 (试听版)",
      declared: { container: "mp3", bitrateKbps: 320, durationSec: 240, sampleRateHz: 44100 },
    });
    const r = meetsFloor(c, cfgOf());
    expect(r.ok).toBe(false);
    expect(r.reason).toContain("试听");
  });

  it("假无损 → 拒绝", () => {
    const c = mk({
      probed: { container: "flac", sampleRateHz: 44100, bitDepth: 16, bytes: bytesFor(320, 240), durationSec: 240 },
    });
    const r = meetsFloor(c, cfgOf({ rejectFakeLossless: true, fakeLosslessDetect: "bitrate" }));
    expect(r.ok).toBe(false);
    expect(r.reason).toContain("疑似假无损");
  });

  it("时长偏差超过容差 → 拒绝", () => {
    const c = mk({ declared: { container: "mp3", bitrateKbps: 320, durationSec: 100 } });
    const r = meetsFloor(c, cfgOf(), { durationSec: 240 });
    expect(r.ok).toBe(false);
    expect(r.reason).toContain("偏差");
  });
});

describe("rankCandidates", () => {
  const mp3 = mk({
    id: "a:wy:1",
    sourceRank: 0,
    declared: { container: "mp3", bitrateKbps: 320, durationSec: 240, sampleRateHz: 44100 },
  });
  const flac = mk({
    id: "b:qq:1",
    sourceRank: 1,
    probed: { container: "flac", sampleRateHz: 44100, bitDepth: 16, bytes: bytesFor(900, 240), durationSec: 240 },
  });

  it("preferLossless:存在真无损时剔掉有损候选", () => {
    const out = rankCandidates([mp3, flac], cfgOf({ preferLossless: true }));
    expect(out).toHaveLength(1);
    expect(out[0]?.id).toBe("b:qq:1");
  });

  it("preferLossless 关闭:两者都保留,无损排前面", () => {
    const out = rankCandidates([mp3, flac], cfgOf({ preferLossless: false }));
    expect(out).toHaveLength(2);
    expect(out[0]?.id).toBe("b:qq:1");
  });

  it("按 id 去重", () => {
    const dup = { ...mp3, url: "https://cdn.example.com/2.mp3" };
    const out = rankCandidates([mp3, dup, flac], cfgOf({ preferLossless: false }));
    expect(out).toHaveLength(2);
    expect(out.filter((c) => c.id === "a:wy:1")).toHaveLength(1);
  });

  it("过滤掉不达标的候选", () => {
    const low = mk({
      id: "c:kg:1",
      declared: { container: "mp3", bitrateKbps: 128, durationSec: 240, sampleRateHz: 44100 },
    });
    const out = rankCandidates([low, mp3], cfgOf({ preferLossless: false }));
    expect(out.map((c) => c.id)).toEqual(["a:wy:1"]);
  });

  it("scoreCandidate:档位主导,信源优先级做小额惩罚", () => {
    const highRank = mk({
      sourceRank: 5,
      declared: { container: "mp3", bitrateKbps: 320, durationSec: 240, sampleRateHz: 44100 },
    });
    expect(scoreCandidate(mp3, cfgOf())).toBeGreaterThan(scoreCandidate(highRank, cfgOf()));
    expect(scoreCandidate(flac, cfgOf())).toBeGreaterThan(scoreCandidate(mp3, cfgOf()));
  });

  it("scoreCandidate:命中排除关键词重罚", () => {
    const dirty = {
      ...mp3,
      title: "爱在西元前 DJ版",
    };
    expect(scoreCandidate(dirty, cfgOf())).toBeLessThan(scoreCandidate(mp3, cfgOf()) - 1000);
  });
});

describe("shouldUpgrade", () => {
  const cross = { upgradeCrossTierOnly: true, upgradeMinStepKbps: 64 };
  const sameTier = { upgradeCrossTierOnly: false, upgradeMinStepKbps: 64 };

  it("跨档且比特率提升足够 → true", () => {
    expect(shouldUpgrade({ tier: "320", bitrateKbps: 320 }, { tier: "lossless", bitrateKbps: 900 }, cross)).toBe(true);
  });

  it("同档(crossTierOnly) → false", () => {
    expect(shouldUpgrade({ tier: "320", bitrateKbps: 320 }, { tier: "320", bitrateKbps: 900 }, cross)).toBe(false);
  });

  it("允许同档但提升不足 → false", () => {
    expect(shouldUpgrade({ tier: "320", bitrateKbps: 320 }, { tier: "320", bitrateKbps: 330 }, sameTier)).toBe(false);
  });

  it("允许同档且提升足够 → true", () => {
    expect(shouldUpgrade({ tier: "320", bitrateKbps: 320 }, { tier: "320", bitrateKbps: 448 }, sameTier)).toBe(true);
  });

  it("降档 → false", () => {
    expect(shouldUpgrade({ tier: "lossless", bitrateKbps: 900 }, { tier: "320", bitrateKbps: 320 }, sameTier)).toBe(false);
  });

  it("比特率缺失时只比档位", () => {
    expect(shouldUpgrade({ tier: "320" }, { tier: "lossless" }, cross)).toBe(true);
  });
});
