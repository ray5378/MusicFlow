/**
 * 自动匹配候选链 buildMatchCandidates() —— 候选怎么挑出来的。
 *
 *  这是「歌单导入 / 播放补齐」换源兜底的**唯一产地**:matchPlaylistInBackground
 *  先调它拼出 [首选, ...其它已启用 search 插件],再整条链交给 match 层的
 *  searchBestMatchWithFallback()。所以这里要钉死的是「谁能进链、谁必须被排除」,
 *  换源兜底本身由 matchFallback.test.ts 覆盖。
 *
 *  之所以单独测:这个函数读的是插件注册表(全局单例),出问题是「静默少一个兜底源」
 *  —— 不会报错、只会让兜底悄悄失效,靠端到端很难发现。
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

/** 注册表 mock 的可变状态(vi.mock 在 import 提升期就要用,故 hoisted)。 */
const { reg } = vi.hoisted(() => ({ reg: { plugins: [] as any[], configs: {} as Record<string, any> } }));

vi.mock("../src/plugins/registry.js", () => ({
  getEnabledByCapability: () => reg.plugins,
  getPluginConfig: (id: string) => reg.configs[id] ?? null,
  firstEnabledByCapability: () => undefined,
}));

import { buildMatchCandidates } from "../src/services/plugin/shared.js";
import { SEARCH_FALLBACK_PLUGIN_ID as SEARCH_ID } from "../src/services/plugin/core/searchFallbackPlugin.js";

/** 造一个「已启用 + 有 search」的插件描述。 */
function plugin(id: string, opts: { withSearch?: boolean; config?: any } = {}) {
  return {
    manifest: { id },
    impl: opts.withSearch === false ? {} : { search: async () => ({ songs: [] }) },
  };
}

/**
 * 摆好注册表状态。**入链的候选必须带插件配置**(buildMatchCandidates 会跳过没配置的
 * 插件),故这里对未显式指定的插件自动补一个空配置;显式给 null 的保持 null,
 * 用来复现「插件装了但没配置/中途被禁用」的情形。
 */
function reset(plugins: any[], configs: Record<string, any> = {}) {
  reg.configs = { ...configs };
  reg.plugins = plugins.map((p) => {
    const id = p.manifest.id as string;
    if (!Object.prototype.hasOwnProperty.call(reg.configs, id)) reg.configs[id] = {};
    return p;
  });
}

const GO = "go-music-dl";
const LX = "lx-source";
const NETEASE = "netease";

beforeEach(() => reset([]));

describe("buildMatchCandidates 自动匹配候选链", () => {
  it("默认(配置未播种):首选在前 + 最多一个兜底(maxCandidates 默认 2)", async () => {
    reset([plugin(GO), plugin(LX), plugin(NETEASE)]);
    const got = await buildMatchCandidates(GO, { a: 1 }, { search: async () => ({ songs: [] }) });
    // 默认 2 = 首选 1 + 兜底 1,第三个不进链(与 maxCandidates=2 那条用例同源的口径)
    expect(got.map((c) => c.providerId)).toEqual([GO, LX]);
    // 首选的原始对象原样透传、不被替换
    expect(got[0]!.config).toEqual({ a: 1 });
  });

  it("放开 maxCandidates:其它已启用 search 插件全部进链", async () => {
    reset([plugin(GO), plugin(LX), plugin(NETEASE)], { [SEARCH_ID]: { maxCandidates: 4 } });
    const got = await buildMatchCandidates(GO, {}, plugin(GO).impl);
    expect(got.map((c) => c.providerId)).toEqual([GO, LX, NETEASE]);
  });

  it("排除本尊:首选插件本身也在启用列表里时,链里只出现一次", async () => {
    reset([plugin(GO), plugin(LX)]);
    const got = await buildMatchCandidates(GO, {}, plugin(GO).impl);
    expect(got.map((c) => c.providerId)).toEqual([GO, LX]);
  });

  it("没有插件配置的跳过(中途被禁用)", async () => {
    reset([plugin(LX), plugin(NETEASE)], { [LX]: null, [NETEASE]: { k: 1 } });
    const got = await buildMatchCandidates(GO, {}, plugin(GO).impl);
    expect(got.map((c) => c.providerId)).toEqual([GO, NETEASE]);
  });

  it("不支持 search 的插件跳过(能力不符)", async () => {
    reset([plugin(LX, { withSearch: false }), plugin(NETEASE)]);
    const got = await buildMatchCandidates(GO, {}, plugin(GO).impl);
    expect(got.map((c) => c.providerId)).toEqual([GO, NETEASE]);
  });

  it("maxCandidates=2:只补一个兜底,第三个不进链", async () => {
    reset([plugin(LX), plugin(NETEASE), plugin("qq")], {
      [SEARCH_ID]: { maxCandidates: 2 },
    });
    const got = await buildMatchCandidates(GO, {}, plugin(GO).impl);
    expect(got.map((c) => c.providerId)).toEqual([GO, LX]);
  });

  it("maxCandidates=1:不再拼任何兜底候选", async () => {
    reset([plugin(LX), plugin(NETEASE)], { [SEARCH_ID]: { maxCandidates: 1 } });
    const got = await buildMatchCandidates(GO, {}, plugin(GO).impl);
    expect(got.map((c) => c.providerId)).toEqual([GO]);
  });

  it("兜底整体关掉(enabled=false):退化为只有首选,与改动前等价", async () => {
    reset([plugin(LX), plugin(NETEASE)], { [SEARCH_ID]: { enabled: false } });
    const got = await buildMatchCandidates(GO, {}, plugin(GO).impl);
    expect(got.map((c) => c.providerId)).toEqual([GO]);
  });

  it("空结果与抛错的兜底开关都关掉:同样不拼兜底", async () => {
    reset([plugin(LX), plugin(NETEASE)], {
      [SEARCH_ID]: { fallbackOnEmpty: false, fallbackOnError: false },
    });
    const got = await buildMatchCandidates(GO, {}, plugin(GO).impl);
    expect(got.map((c) => c.providerId)).toEqual([GO]);
  });

  it("一个兜底源都没有:链里只有首选(不报错)", async () => {
    reset([]);
    const got = await buildMatchCandidates(GO, {}, plugin(GO).impl);
    expect(got.length).toBe(1);
    expect(got[0]!.providerId).toBe(GO);
  });
});
