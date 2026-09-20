// ==================== ② 段「响度归一化」：设置项读写 + 判定落点 ====================
//
// 这一节锁两件都不会"报错"、只会悄悄不生效的事：
//
// ① **设置读写**：缺省（开 / -14）、区间夹取（对齐 MA `CONF_ENTRY_VOLUME_NORMALIZATION_TARGET`
//    的 `range=(-30, -5)`、`default_value=-14`）、非法值忽略而不是打回整次保存。
//
// ② **`normalization` 不是 `enabled`（本节最重要的一条）**：
//    - `normalization:false` = 只摘掉 ② 段（不加 loudnorm、不加静态增益），
//      **③ 段 DSP 与 ⑤ 段限制器必须还在** —— 用户关掉"音量归一化"不该顺带丢音色与削波保护；
//    - `enabled:false` = **整条链的逃生舱**（单测对拍 / 老命令逐字节一致），连 DSP 一起丢。
//    这两条接反了，点一下开关就会同时失去音色，而且**没有任何报错**。
//
// 每个 `it` 自带前置状态（清 settings 表 + 清 5s TTL 缓存）——本仓开了 `sequence.shuffle`。
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { sqlite, db } from "../../src/db/index.js";
import { songs } from "../../src/db/schema.js";
import { eq } from "drizzle-orm";
import { _resetSettingsCacheForTest, setSetting } from "../../src/services/settings.js";
import {
  DEFAULT_TARGET_LUFS,
  NORMALIZATION_ENABLED_KEY,
  NORMALIZATION_TARGET_KEY,
  TARGET_LUFS_MAX,
  TARGET_LUFS_MIN,
  clampTargetLufs,
  readNormalizationSettings,
  updateNormalizationSettings,
} from "../../src/services/audio/normalization.js";
import {
  DEFAULT_TARGET_LUFS as PIPELINE_DEFAULT_TARGET_LUFS,
  resolveLoudnessAf,
} from "../../src/services/audio/pipeline.js";
import { deleteAnalysis, saveAnalysis } from "../../src/services/audio/analysisStore.js";

beforeEach(() => {
  sqlite.prepare("DELETE FROM settings").run();
  _resetSettingsCacheForTest();
});

/** 造一行 local 歌（`audio_analysis` 有外键，回写前必须先有 songs 行）。 */
function seedSong(id: string, fileName: string): void {
  db.insert(songs).values({
    id, title: fileName, artist: "a", duration: 10,
    path: `/music/${fileName}.mp3`, contentType: "audio/mpeg", type: "local",
  } as any).run();
}

function dropSong(id: string): void {
  deleteAnalysis(id);
  db.delete(songs).where(eq(songs.id, id)).run();
}

describe("设置项：缺省与区间（对齐 MA 的 ConfigEntry）", () => {
  it("空库缺省 = 开 + -14，且区间常量与 MA 逐项一致", () => {
    // 常量即对齐契约：改了就等于与 MA 脱钩。
    expect([TARGET_LUFS_MIN, TARGET_LUFS_MAX, DEFAULT_TARGET_LUFS]).toEqual([-30, -5, -14]);
    // pipeline.ts 仍 re-export 同一个缺省值（老引用不许飘）。
    expect(PIPELINE_DEFAULT_TARGET_LUFS).toBe(DEFAULT_TARGET_LUFS);
    expect(readNormalizationSettings()).toEqual({ enabled: true, targetLufs: -14 });
  });

  it("键名是 `loudness.normalization` / `loudness.targetLufs`（改名等于用户配置失效）", () => {
    expect(NORMALIZATION_ENABLED_KEY).toBe("loudness.normalization");
    expect(NORMALIZATION_TARGET_KEY).toBe("loudness.targetLufs");
    setSetting(NORMALIZATION_TARGET_KEY, "-20");
    _resetSettingsCacheForTest();
    expect(readNormalizationSettings().targetLufs).toBe(-20);
  });

  it("目标响度夹到 [-30, -5]：越界夹边界，非数值回退缺省", () => {
    expect(clampTargetLufs(-99)).toBe(TARGET_LUFS_MIN);
    expect(clampTargetLufs(0)).toBe(TARGET_LUFS_MAX);
    expect(clampTargetLufs(-14.6)).toBe(-15); // 先取整再夹
    expect(clampTargetLufs(-14.4)).toBe(-14);
    expect(clampTargetLufs("-18")).toBe(-18); // 字符串数字照样认（设置库里存的就是字符串）
    expect(clampTargetLufs("abc")).toBe(DEFAULT_TARGET_LUFS);
    expect(clampTargetLufs(NaN)).toBe(DEFAULT_TARGET_LUFS);
    expect(clampTargetLufs(null)).toBe(DEFAULT_TARGET_LUFS);
    expect(clampTargetLufs(undefined)).toBe(DEFAULT_TARGET_LUFS);
  });

  it("库里的脏值也夹（读到 -99 不能把 loudnorm 目标设成 -99）", () => {
    setSetting(NORMALIZATION_TARGET_KEY, "-99");
    setSetting(NORMALIZATION_ENABLED_KEY, "1");
    _resetSettingsCacheForTest();
    expect(readNormalizationSettings().targetLufs).toBe(TARGET_LUFS_MIN);
  });
});

describe("部分更新：逐项提交，手抖的字段不打回整次保存", () => {
  it("只改传进来的字段", () => {
    updateNormalizationSettings({ targetLufs: -20 });
    expect(readNormalizationSettings()).toEqual({ enabled: true, targetLufs: -20 });
    updateNormalizationSettings({ enabled: false });
    expect(readNormalizationSettings()).toEqual({ enabled: false, targetLufs: -20 });
  });

  it("越界的目标响度夹到边界并落库（面板回显的就是真正生效的值）", () => {
    expect(updateNormalizationSettings({ targetLufs: -100 }).targetLufs).toBe(TARGET_LUFS_MIN);
    expect(updateNormalizationSettings({ targetLufs: -1 }).targetLufs).toBe(TARGET_LUFS_MAX);
  });

  it("非数值目标响度忽略（保留旧值），非对象入参不改任何东西也不抛", () => {
    updateNormalizationSettings({ targetLufs: -20 });
    for (const bad of ["abc", {}, null, undefined]) {
      expect(updateNormalizationSettings({ targetLufs: bad }).targetLufs).toBe(-20);
    }
    for (const bad of [null, undefined, "x", 42, ["enabled"]]) {
      expect(updateNormalizationSettings(bad)).toEqual({ enabled: true, targetLufs: -20 });
    }
  });

  it("非布尔的 enabled 忽略（'0' / 0 / null 都不算关）", () => {
    for (const bad of ["0", 0, null, undefined, "false"]) {
      expect(updateNormalizationSettings({ enabled: bad }).enabled).toBe(true);
    }
    expect(updateNormalizationSettings({ enabled: false }).enabled).toBe(false);
  });
});

describe("② 段开关：只摘响度，不丢 DSP / 限制器", () => {
  const DSP = "equalizer=f=100:t=q:w=1:g=3";

  it("normalization:false → 无 loudnorm、无静态增益，但 DSP 与限制器照旧", () => {
    const af = resolveLoudnessAf({ normalization: false, extraFilters: [DSP] });
    expect(af).toEqual([DSP, expect.stringContaining("alimiter=")]);
    expect(af.some((f) => f.startsWith("loudnorm"))).toBe(false);
    expect(af.some((f) => f.startsWith("volume="))).toBe(false);
    expect(af).toHaveLength(2);
  });

  it("enabled:false（整条链逃生舱）→ 连 DSP 一起丢（与上面恰好相反，别写反）", () => {
    expect(resolveLoudnessAf({ enabled: false, extraFilters: [DSP] })).toEqual([]);
  });

  it("缺省（什么都不传）→ 实时 loudnorm + 限制器（现状不变）", () => {
    const af = resolveLoudnessAf({});
    expect(af[0]).toContain("loudnorm");
    expect(af[0]).toContain(`I=${DEFAULT_TARGET_LUFS}`);
    expect(af[af.length - 1]).toContain("alimiter=");
  });
});

describe("全局设置真的进了决策（缺省读设置，调用方可覆盖）", () => {
  const ID = "norm-global";

  beforeEach(() => { seedSong(ID, "norm-global"); });
  afterEach(() => { dropSong(ID); });

  it("目标响度取自设置：库里 -20、测得 -10 → volume=-10dB", () => {
    saveAnalysis(ID, "local", { loudnessIntegrated: -10 });
    setSetting(NORMALIZATION_TARGET_KEY, "-20");
    _resetSettingsCacheForTest();
    expect(resolveLoudnessAf({ rowId: ID })[0]).toBe("volume=-10dB");
  });

  it("设置关掉 ② 段 → 该走静态增益的场景也不再有 volume=，但限制器还在", () => {
    saveAnalysis(ID, "local", { loudnessIntegrated: -10 });
    setSetting(NORMALIZATION_ENABLED_KEY, "0");
    _resetSettingsCacheForTest();
    const af = resolveLoudnessAf({ rowId: ID });
    expect(af.some((f) => f.startsWith("volume="))).toBe(false);
    expect(af.some((f) => f.startsWith("loudnorm"))).toBe(false);
    expect(af[af.length - 1]).toContain("alimiter=");
  });

  it("调用方显式传的值优先于设置（单测/特殊通道要对拍老命令）", () => {
    saveAnalysis(ID, "local", { loudnessIntegrated: -10 });
    setSetting(NORMALIZATION_TARGET_KEY, "-20");
    setSetting(NORMALIZATION_ENABLED_KEY, "0");
    _resetSettingsCacheForTest();
    // 设置全关也不影响显式传参的调用方
    expect(resolveLoudnessAf({ rowId: ID, normalization: true, targetLoudness: -16 })[0]).toBe("volume=-6dB");
  });
});
