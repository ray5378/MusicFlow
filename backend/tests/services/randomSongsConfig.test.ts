// 「随机歌曲」插件的配置解析容错。
//
// 🔴 为什么必须锁在单测里:这份配置是**用户手填的自由文本**,而它下面接的是
//   `Math.min(raw, 500)` / `>= 1900` / 起始-结束交换这些**静默兜底**逻辑 ——
//   任何一处不兜底,用户填个 0 或 1800 就会让整个「随心听」歌单直接空掉或 500 首。
//   线上出问题时日志里只会看到「歌单是空的」,看不出是配置被夹掉了还是别的原因,
//   所以这里把「什么输入会被吃成什么值」逐条钉死。
//
// 手法:只把 sqlite 换成按 SQL 内容分派的替身(本文件要钉的只是配置解析,
// 抽取/落库那部分由 randomSongs 自己的用例覆盖)。
import "../plugins/_env.js";
import { describe, it, expect, vi, beforeEach } from "vitest";

const H = vi.hoisted(() => ({ pluginRow: null as any }));

vi.mock("../../src/db/index.js", () => ({
  sqlite: {
    prepare: (sql: string) => {
      const s = String(sql);
      if (s.includes("FROM plugins")) {
        // 照抄源码的 WHERE enabled = 1:替身也得守约束,否则测出来的是替身的行为。
        return {
          get: () => (H.pluginRow && H.pluginRow.enabled === 1 ? H.pluginRow : undefined),
          run: () => {},
          all: () => [],
        };
      }
      return { get: () => undefined, run: () => {}, all: () => [] };
    },
    transaction: (f: any) => f,
  },
}));

import { getRandomSongsConfig, DEFAULT_SONG_COUNT, MAX_SONG_COUNT, DEFAULT_REFRESH_MINUTES } from "../../src/services/plugin/randomSongs.js";

/** 造一行插件配置(config 是 JSON 字符串,enabled=1 才会被查到)。 */
function withConfig(cfg: any, enabled = 1) {
  H.pluginRow = {
    name: "random-songs",
    enabled,
    config: cfg === undefined ? null : typeof cfg === "string" ? cfg : JSON.stringify(cfg),
  };
}

beforeEach(() => {
  H.pluginRow = null;
});

describe("getRandomSongsConfig:非法配置一律静默兜底,绝不把坏值带进抽取", () => {
  it("插件行不存在 / config 为 null ⇒ 全默认", () => {
    H.pluginRow = null;
    expect(getRandomSongsConfig()).toEqual({
      count: DEFAULT_SONG_COUNT,
      refreshMinutes: DEFAULT_REFRESH_MINUTES,
      genre: undefined,
      fromYear: undefined,
      toYear: undefined,
    });
  });

  it("插件行存在但 config 为 {} (从未配过) ⇒ 全默认", () => {
    withConfig({});
    expect(getRandomSongsConfig().count).toBe(DEFAULT_SONG_COUNT);
    expect(getRandomSongsConfig().refreshMinutes).toBe(DEFAULT_REFRESH_MINUTES);
  });

  it("config 是坏 JSON ⇒ 全默认(不让解析异常冒出去)", () => {
    withConfig("{ 这不是 json");
    expect(getRandomSongsConfig().count).toBe(DEFAULT_SONG_COUNT);
    expect(getRandomSongsConfig().refreshMinutes).toBe(DEFAULT_REFRESH_MINUTES);
  });

  it("插件被停用(enabled=0)⇒ 查不到行,按默认处理", () => {
    withConfig({ count: 7 }, 0);
    expect(getRandomSongsConfig().count).toBe(DEFAULT_SONG_COUNT);
  });

  it("count 非法(非数字 / 0 / 负数)⇒ 回落默认,不留 0 或 NaN", () => {
    for (const bad of ["abc", "", 0, -5, Number.NaN]) {
      withConfig({ count: bad });
      const c = getRandomSongsConfig();
      expect(c.count).toBe(DEFAULT_SONG_COUNT);
      expect(Number.isFinite(c.count)).toBe(true);
    }
  });

  it("count 超出上限 ⇒ 夹到 MAX_SONG_COUNT(不是报错,是夹紧)", () => {
    withConfig({ count: 99999 });
    expect(getRandomSongsConfig().count).toBe(MAX_SONG_COUNT);
  });

  it("count 是数字字符串 ⇒ 按数字对待(表单填进来的常常是字符串)", () => {
    withConfig({ count: "12" });
    expect(getRandomSongsConfig().count).toBe(12);
  });

  it("refreshMinutes 非法 / 超限 ⇒ 分别回落默认与夹到 1440", () => {
    withConfig({ refreshMinutes: 0 });
    expect(getRandomSongsConfig().refreshMinutes).toBe(DEFAULT_REFRESH_MINUTES);
    withConfig({ refreshMinutes: -3 });
    expect(getRandomSongsConfig().refreshMinutes).toBe(DEFAULT_REFRESH_MINUTES);
    withConfig({ refreshMinutes: 99999 });
    expect(getRandomSongsConfig().refreshMinutes).toBe(1440);
  });

  it("genre 是空白串 ⇒ 归一成 undefined(否则会拼出 `流派= ` 这种空过滤)", () => {
    withConfig({ genre: "   " });
    expect(getRandomSongsConfig().genre).toBeUndefined();
    withConfig({ genre: "摇滚" });
    expect(getRandomSongsConfig().genre).toBe("摇滚");
  });

  it("起始年份早于 1900 / 晚于今年 ⇒ 整条忽略(不夹、不报错)", () => {
    const thisYear = new Date().getFullYear();
    withConfig({ fromYear: 1800 });
    expect(getRandomSongsConfig().fromYear).toBeUndefined();
    withConfig({ fromYear: thisYear + 5 });
    expect(getRandomSongsConfig().fromYear).toBeUndefined();
    withConfig({ fromYear: 2000 });
    expect(getRandomSongsConfig().fromYear).toBe(2000);
  });

  it("起始 > 结束时两者交换(用户填反了也不至于取到空结果)", () => {
    withConfig({ fromYear: 2020, toYear: 2010 });
    const c = getRandomSongsConfig();
    expect(c.fromYear).toBe(2010);
    expect(c.toYear).toBe(2020);
  });

  it("正常配置 ⇒ 原样透出(不夹不算,避免悄悄改掉用户填的值)", () => {
    withConfig({ count: 24, refreshMinutes: 5, genre: "爵士", fromYear: 1990, toYear: 2020 });
    expect(getRandomSongsConfig()).toEqual({
      count: 24,
      refreshMinutes: 5,
      genre: "爵士",
      fromYear: 1990,
      toYear: 2020,
    });
  });
});
