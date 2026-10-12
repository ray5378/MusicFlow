// ==================== 预取/判官运行时配置(prefetchConfig)回归守卫 ====================
//
// 用户 2026-10-12 拍板「不要完全写死」:下一首内存预取的各档参数 + 完整性判官的两条
// 判死线全部搬到 settings 表(prefetch.settings),前端「插件管理 → 媒体获取」页
// 即存即生效。本文件锁:
//   ① 无记录 ⇒ 回落 env/模块默认(默认值即文档值);
//   ② 无记录时 env 兜底(判官三项 env);
//   ③ settings 优先于 env(UI 保存过后 env 不再覆盖);
//   ④ 越界/坏值 clamp(单字段坏不掉整包);
//   ⑤ PUT 合并语义 + 落库即时生效;
//   ⑥ 坏 JSON / 非数值字段不坏包;
//   ⑦ 恢复默认 = 删记录回落 env/默认。
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { sqlite } from "../../src/db/index.js";
import { _resetSettingsCacheForTest } from "../../src/services/settings.js";
import {
  PREFETCH_NUM_SPECS,
  PREFETCH_SETTINGS_KEY,
  getPrefetchSettings,
  resetPrefetchSettings,
  setPrefetchSettings,
} from "../../src/services/source/prefetchConfig.js";
// 判官入口按 settings 读(委托链的端到端断言放 prefetchCache.test.ts ⑨,这里只测配置层)。
import { prefetchIntegrityConfig } from "../../src/services/source/prefetchCache.js";

function clearSettings(): void {
  sqlite.prepare("DELETE FROM settings WHERE key = ?").run(PREFETCH_SETTINGS_KEY);
  _resetSettingsCacheForTest();
}

beforeEach(() => {
  clearSettings();
});

afterEach(() => {
  delete process.env.PREFETCH_INTEGRITY_DELTA_SEC;
  delete process.env.PREFETCH_INTEGRITY_DELTA_SEC_BITRATE;
  delete process.env.PREFETCH_INTEGRITY_OFF;
  clearSettings();
});

describe("prefetchConfig 读优先级与钳制", () => {
  it("① 无记录:全部回落模块默认(默认值即文档值)", () => {
    const s = getPrefetchSettings();
    expect(s.lookahead).toBe(1);
    expect(s.concurrency).toBe(1);
    expect(s.budgetRatio).toBe(0.5);
    expect(s.deadlineSec).toBe(120);
    expect(s.stallSec).toBe(30);
    expect(s.entryTtlSec).toBe(600);
    expect(s.maxAltSources).toBe(3);
    expect(s.integrityEnabled).toBe(true);
    expect(s.integrityDeltaSec).toBe(15);
    expect(s.integrityBitrateDeltaSec).toBe(80);
    expect(s.minAudioKB).toBe(64);
  });

  it("② 无记录时 env 兜底:判官三项 env 生效", () => {
    process.env.PREFETCH_INTEGRITY_OFF = "1";
    process.env.PREFETCH_INTEGRITY_DELTA_SEC = "30";
    process.env.PREFETCH_INTEGRITY_DELTA_SEC_BITRATE = "120";
    const s = getPrefetchSettings();
    expect(s.integrityEnabled).toBe(false);
    expect(s.integrityDeltaSec).toBe(30);
    expect(s.integrityBitrateDeltaSec).toBe(120);
    // 判官入口(prefetchCache)读到的就是这套值。
    expect(prefetchIntegrityConfig()).toEqual({
      enabled: false,
      deltaSec: 30,
      bitrateDeltaSec: 120,
    });
  });

  it("③ settings 优先于 env:UI 保存过后 env 不再覆盖", () => {
    process.env.PREFETCH_INTEGRITY_DELTA_SEC = "30";
    setPrefetchSettings({ integrityDeltaSec: 45 });
    expect(getPrefetchSettings().integrityDeltaSec).toBe(45);
    expect(prefetchIntegrityConfig().deltaSec).toBe(45);
  });

  it("④ 越界值 clamp 到范围端(单字段坏不掉整包)", () => {
    const s = setPrefetchSettings({
      lookahead: 99, // > 5 ⇒ 5
      concurrency: 0, // < 1 ⇒ 1
      budgetRatio: 2, // > 1 ⇒ 1
      deadlineSec: -5, // < 10 ⇒ 10
      stallSec: 9999, // > 300 ⇒ 300
      entryTtlSec: 1, // < 60 ⇒ 60
      maxAltSources: 100, // > 8 ⇒ 8
      integrityDeltaSec: 0, // < 1 ⇒ 1
      integrityBitrateDeltaSec: 99999, // > 1800 ⇒ 1800
      minAudioKB: 1, // < 8 ⇒ 8
    });
    expect(s.lookahead).toBe(5);
    expect(s.concurrency).toBe(1);
    expect(s.budgetRatio).toBe(1);
    expect(s.deadlineSec).toBe(10);
    expect(s.stallSec).toBe(300);
    expect(s.entryTtlSec).toBe(60);
    expect(s.maxAltSources).toBe(8);
    expect(s.integrityDeltaSec).toBe(1);
    expect(s.integrityBitrateDeltaSec).toBe(1800);
    expect(s.minAudioKB).toBe(8);
  });

  it("⑤ 合并语义:只改带上来的字段,其余保持现值,且落库即时生效", () => {
    setPrefetchSettings({ lookahead: 3, integrityDeltaSec: 40 });
    const s = setPrefetchSettings({ stallSec: 90 });
    expect(s.lookahead).toBe(3); // 保持
    expect(s.integrityDeltaSec).toBe(40); // 保持
    expect(s.stallSec).toBe(90); // 新值
    expect(getPrefetchSettings()).toEqual(s); // 读回一致
  });

  it("⑥ 坏 JSON 回落 env/默认(不抛、不坏包)", () => {
    setPrefetchSettings({ lookahead: 2 });
    sqlite
      .prepare("INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES (?,?,?)")
      .run(PREFETCH_SETTINGS_KEY, "{not-json", new Date().toISOString());
    _resetSettingsCacheForTest();
    expect(getPrefetchSettings().lookahead).toBe(1); // 回落默认
  });

  it("⑦ 非数值字段被忽略(不写进 next,不污染别的字段)", () => {
    const s = setPrefetchSettings({ lookahead: 2, stallSec: "abc" as any });
    expect(s.lookahead).toBe(2);
    expect(s.stallSec).toBe(30); // 默认,没被 "abc" 污染
  });

  it("⑧ 恢复默认:删记录 ⇒ 回落 env/默认", () => {
    process.env.PREFETCH_INTEGRITY_DELTA_SEC = "25";
    setPrefetchSettings({ lookahead: 4, integrityDeltaSec: 40 });
    const s = resetPrefetchSettings();
    expect(s.lookahead).toBe(1);
    expect(s.integrityDeltaSec).toBe(25); // env 兜底回来了
  });

  it("⑨ 范围规格表自洽:min ≤ def ≤ max(前端同范围校验的依据)", () => {
    for (const [k, spec] of Object.entries(PREFETCH_NUM_SPECS)) {
      expect(spec.min, k).toBeLessThanOrEqual(spec.def);
      expect(spec.def, k).toBeLessThanOrEqual(spec.max);
    }
  });
});
