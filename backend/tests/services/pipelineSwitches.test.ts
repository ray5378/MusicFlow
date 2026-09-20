// ==================== P5-1/P5-2：音频管道开关（D9 语义的单元锁） ====================
//
// 开关本身没什么"算法"，但它挂着一个**容易写错的语义**：关闭 = 滤镜链为空，
// **不是**回到「绕过管道」。这里逐条锁住判定顺序（全局 ∧ 通道 ∧ 设备回退），
// 因为一旦判定写反，症状是"关不干净"或"关过头"，两种都不会报错。
//
// 每个 `it` 自带前置状态（清 settings 表 + 清缓存）——本仓开了 `sequence.shuffle`，
// 5s TTL 的内存缓存会让同文件后续用例读到旧值（settings.ts 的 `_resetSettingsCacheForTest`
// 就是为这个存在的）。
import { describe, it, expect, beforeEach } from "vitest";
import { sqlite } from "../../src/db/index.js";
import { _resetSettingsCacheForTest, setSetting } from "../../src/services/settings.js";
import {
  PIPELINE_CHANNELS,
  PIPELINE_CHANNEL_KEYS,
  PIPELINE_GLOBAL_KEY,
  dlnaFallbackKey,
  isChannelEnabled,
  isDlnaEffectsEnabled,
  isDlnaFallback,
  isPipelineEnabled,
  readPipelineSwitches,
  setDlnaFallback,
  updatePipelineSwitches,
} from "../../src/services/audio/pipelineSwitches.js";

beforeEach(() => {
  sqlite.prepare("DELETE FROM settings").run();
  _resetSettingsCacheForTest();
});

describe("P5-1 缺省全开（加开关不改现状）", () => {
  it("空库时全局与四个通道都开", () => {
    expect(isPipelineEnabled()).toBe(true);
    for (const ch of PIPELINE_CHANNELS) expect(isChannelEnabled(ch)).toBe(true);
    expect(readPipelineSwitches()).toEqual({
      enabled: true,
      channels: { http: true, dlna: true, sendspin: true, airplay: true },
    });
  });

  it("通道键就是 P2 起沿用的 `pipeline.http`（老配置继续有效）", () => {
    expect(PIPELINE_CHANNEL_KEYS.http).toBe("pipeline.http");
    expect(PIPELINE_GLOBAL_KEY).toBe("pipeline.enabled");
    // 直接写老键 = 关掉该通道（不需要任何迁移）
    setSetting("pipeline.http", "0");
    _resetSettingsCacheForTest();
    expect(isChannelEnabled("http")).toBe(false);
    expect(isChannelEnabled("dlna")).toBe(true);
  });
});

describe("P5-1 全局总开关：一键回到「逐首播放 + 无滤镜」", () => {
  it("全局关 ⇒ 所有通道都关（通道自己的开关保持原值不算数）", () => {
    updatePipelineSwitches({ channels: { http: true, dlna: true, sendspin: true, airplay: true } });
    expect(isChannelEnabled("dlna")).toBe(true);
    updatePipelineSwitches({ enabled: false });
    for (const ch of PIPELINE_CHANNELS) expect(isChannelEnabled(ch)).toBe(false);
    // 通道各自的设置没有被全局开关改写（重新打开全局即恢复）
    updatePipelineSwitches({ enabled: true });
    for (const ch of PIPELINE_CHANNELS) expect(isChannelEnabled(ch)).toBe(true);
  });

  it("全局关但通道原本就是关的：重开全局后它仍是关（两层各记各的）", () => {
    updatePipelineSwitches({ channels: { airplay: false } });
    updatePipelineSwitches({ enabled: false });
    updatePipelineSwitches({ enabled: true });
    expect(isChannelEnabled("airplay")).toBe(false);
    expect(isChannelEnabled("http")).toBe(true);
  });
});

describe("P5-1 部分更新：非法输入不抛、不打回整次保存", () => {
  it("未知通道名 / 非布尔值一律忽略，已合法的字段照常落库", () => {
    const snap = updatePipelineSwitches({
      enabled: true,
      channels: { http: false, bogus: false, dlna: "yes", sendspin: 0, airplay: true },
    });
    expect(snap.channels).toEqual({ http: false, dlna: true, sendspin: true, airplay: true });
  });

  it("非对象入参（null / 字符串 / 数组）→ 不改任何东西，也不抛", () => {
    updatePipelineSwitches({ channels: { http: false } });
    for (const bad of [null, undefined, "x", 42, ["http"]]) {
      const snap = updatePipelineSwitches(bad);
      expect(snap.channels.http).toBe(false);
    }
  });

  it("`channels` 传数组时不按对象遍历（数组的 length 等键不该被当通道名）", () => {
    const snap = updatePipelineSwitches({ channels: ["http"] });
    expect(snap.channels.http).toBe(true);
  });
});

describe("P5-2 DLNA 单设备回退", () => {
  it("按设备独立：A 回退不影响 B，也不影响其它通道", () => {
    setDlnaFallback("dev-a", true);
    expect(isDlnaFallback("dev-a")).toBe(true);
    expect(isDlnaFallback("dev-b")).toBe(false);
    expect(isDlnaEffectsEnabled("dev-a")).toBe(false);
    expect(isDlnaEffectsEnabled("dev-b")).toBe(true);
    expect(isChannelEnabled("http")).toBe(true);
  });

  it("缺省不回退；空 deviceId 既不回退也不可设置（幂等，不抛）", () => {
    expect(isDlnaFallback("")).toBe(false);
    expect(isDlnaFallback(null)).toBe(false);
    expect(isDlnaEffectsEnabled("")).toBe(true);
    setDlnaFallback("", true);
    expect(isDlnaFallback("")).toBe(false);
  });

  it("设备回退与通道开关是**相乘**的：通道关掉时每台设备都不带滤镜链", () => {
    setDlnaFallback("dev-a", true);
    updatePipelineSwitches({ channels: { dlna: false } });
    expect(isDlnaEffectsEnabled("dev-a")).toBe(false);
    expect(isDlnaEffectsEnabled("dev-b")).toBe(false);
    // HTTP 通道不受 DLNA 通道开关影响
    expect(isChannelEnabled("http")).toBe(true);
  });

  it("回退可取消（写 0 而不是删行，保留「我确实设过」的可观测性）", () => {
    setDlnaFallback("dev-a", true);
    setDlnaFallback("dev-a", false);
    expect(isDlnaFallback("dev-a")).toBe(false);
    expect(isDlnaEffectsEnabled("dev-a")).toBe(true);
  });

  it("设置键按设备 id 拼前缀（deviceId 不是 cast token）", () => {
    expect(dlnaFallbackKey("abc")).toBe("pipeline.dlna.fallback.abc");
    setDlnaFallback("abc", true);
    _resetSettingsCacheForTest();
    const r = sqlite.prepare("SELECT value FROM settings WHERE key = ?").get("pipeline.dlna.fallback.abc") as { value: string };
    expect(r.value).toBe("1");
  });
});
