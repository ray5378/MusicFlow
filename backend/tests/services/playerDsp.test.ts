// ==================== P4-2：per-player DSP 配置的存取（③ 段） ====================
//
// 纯函数层（`audio/dsp.ts`）已由 `dsp.test.ts` 逐字符锁住（含与 MA 独立复算的 golden），
// 这里只锁**存取**这一层：
//   ① 落地形状：写进去的必须是**归一化后**的配置（字符串/NaN/非法段一律不准进库）；
//   ② 空配置 = 删行：库里不留"等于没配置"的行（否则设置面板会显示一堆"已启用但什么都没配"）；
//   ③ 出流入口 `playerDspFilters` 的三种返回形态（无配置 / 单曲 / flow）。
//
// 每个 `it` 自带前置状态（清表）——本仓开了 `sequence.shuffle`，不依赖执行顺序。
import { describe, it, expect, beforeEach } from "vitest";
import { db } from "../../src/db/index.js";
import { playerDspConfigs } from "../../src/db/schema.js";
import {
  DSP_ANCHOR_FORMAT,
  getPlayerDspConfig,
  isPeerGrouped,
  listPlayerDspConfigs,
  playerDspFilters,
  setPlayerDspConfig,
} from "../../src/services/playerDsp.js";

const P = "dlna:test-device-a";
const Q = "dlna:test-device-b";

beforeEach(() => {
  db.delete(playerDspConfigs).run();
});

describe("P4-2 存取往返", () => {
  it("写入即读回：只留非 0 字段（0 / 空段不占位）", () => {
    const saved = setPlayerDspConfig(P, {
      preampDb: -6,
      tone: { bassDb: 4, midDb: 0, trebleDb: -2 },
      balance: -30,
      gainDb: 0,
    });
    expect(saved).toEqual({
      preampDb: -6,
      tone: { bassDb: 4, trebleDb: -2 },
      balance: -30,
    });
    expect(getPlayerDspConfig(P)).toEqual(saved);
  });

  it("同一 peerId 反复写 = 覆盖（不是插入第二行）", () => {
    setPlayerDspConfig(P, { tone: { bassDb: 4 } });
    setPlayerDspConfig(P, { gainDb: 3 });
    expect(getPlayerDspConfig(P)).toEqual({ gainDb: 3 });
    expect(db.select().from(playerDspConfigs).all()).toHaveLength(1);
  });

  it("未知 peerId / 空 peerId 一律 null（不抛）", () => {
    expect(getPlayerDspConfig("dlna:never-written")).toBeNull();
    expect(getPlayerDspConfig("")).toBeNull();
    expect(setPlayerDspConfig("", { gainDb: 3 })).toBeNull();
  });
});

describe("P4-2 归一化：坏值绝不进库", () => {
  it("字符串数字被接受、非数字被丢弃、未知段类型被丢弃", () => {
    const saved = setPlayerDspConfig(P, {
      preampDb: "abc",
      tone: { bassDb: "3" },
      parametricEq: {
        bands: [
          { type: "bogus", frequency: 100, gainDb: 6 },
          { type: "peak", frequency: 1000, gainDb: 6, q: 0.7 },
          { type: "peak", frequency: 0, gainDb: 6, q: 1 },
        ],
      },
    });
    expect(saved).toEqual({
      tone: { bassDb: 3 },
      parametricEq: { bands: [{ type: "peak", frequency: 1000, gainDb: 6, q: 0.7 }] },
    });
    // 落库的是 JSON 文本，读回必须与写入的归一化结果逐字段一致（没有 NaN 漏出去）
    expect(JSON.parse(db.select().from(playerDspConfigs).all()[0].config)).toEqual(saved);
  });

  it("非法 balance 被钳到 ±100；非对象请求体一律当空配置", () => {
    expect(setPlayerDspConfig(P, { balance: 999 })?.balance).toBe(100);
    expect(setPlayerDspConfig(P, null)).toBeNull();
    expect(setPlayerDspConfig(P, "nope")).toBeNull();
    expect(setPlayerDspConfig(P, [1, 2])).toBeNull();
  });

  it("全 0 / 空配置 → 删行（库里不留'等于没配置'的行）", () => {
    setPlayerDspConfig(P, { tone: { bassDb: 4 } });
    expect(getPlayerDspConfig(P)).not.toBeNull();

    expect(setPlayerDspConfig(P, { tone: { bassDb: 0 }, balance: 0, preampDb: 0 })).toBeNull();
    expect(getPlayerDspConfig(P)).toBeNull();
    expect(db.select().from(playerDspConfigs).all()).toHaveLength(0);

    // 只有 disabled 段的 EQ 同样等于没配置
    expect(
      setPlayerDspConfig(P, { parametricEq: { bands: [{ type: "peak", frequency: 100, gainDb: 3, q: 1, enabled: false }] } }),
    ).toBeNull();
    expect(db.select().from(playerDspConfigs).all()).toHaveLength(0);
  });
});

describe("P4-2 批量读取（设置面板一次拿全）", () => {
  it("只回非空配置，键就是 peerId", () => {
    setPlayerDspConfig(P, { tone: { bassDb: 4 } });
    setPlayerDspConfig(Q, { balance: 20 });
    setPlayerDspConfig("dlna:cleared", { gainDb: 0 });
    expect(listPlayerDspConfigs()).toEqual({
      [P]: { tone: { bassDb: 4 } },
      [Q]: { balance: 20 },
    });
  });
});

describe("P4-2 出流入口 playerDspFilters", () => {
  it("无 peerId / 无配置 → 空链（零开销，不往 ffmpeg 加任何滤镜）", () => {
    expect(playerDspFilters(undefined)).toEqual([]);
    expect(playerDspFilters(null)).toEqual([]);
    expect(playerDspFilters(123 as any)).toEqual([]);
    expect(playerDspFilters("")).toEqual([]);
    expect(playerDspFilters("dlna:never-written")).toEqual([]);
  });

  it("单曲管道：链首补 aresample + aformat（biquad 系数与采样率绑定，必须先锚定）", () => {
    setPlayerDspConfig(P, { tone: { bassDb: 4 } });
    expect(playerDspFilters(P)).toEqual([
      "aresample=48000",
      "aformat=channel_layouts=stereo",
      "equalizer=frequency=100:width=200:width_type=h:gain=4",
    ]);
  });

  it("flow 会话：解码段已 -ar 48000 -ac 2 ⇒ 不再补 resample/aformat", () => {
    setPlayerDspConfig(P, { tone: { bassDb: 4 } });
    expect(playerDspFilters(P, { flow: true })).toEqual([
      "equalizer=frequency=100:width=200:width_type=h:gain=4",
    ]);
  });

  it("锚定格式固定 48000 / 立体声（与 DSP_FILTER_RATE 同源）", () => {
    expect(DSP_ANCHOR_FORMAT).toEqual({ sampleRate: 48000, channels: 2 });
  });

  it("isPeerGrouped 对未成组设备为 false（成组禁用在纯函数层锁定，见 dsp.test.ts）", () => {
    expect(isPeerGrouped("dlna:never-grouped")).toBe(false);
    expect(isPeerGrouped("")).toBe(false);
  });
});
