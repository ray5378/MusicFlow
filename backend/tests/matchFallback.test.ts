/**
 * 自动匹配链路(歌单导入 / 播放补齐)的跨插件兜底。
 *
 *  改的是什么:matchPlaylistInBackground 原先只挑一个 matcher
 *  (firstEnabledByCapability("search") 只取 [0]),首选插件搜索空/报错时,其他装好
 *  的源插件根本不会被碰到 —— 本次把候选链接进 matchUnmatchedPlaylistEntries。
 *
 *  重点验证两件事:
 *  1. 兜底真的会换插件(而不是被批内缓存短路 / 被开关挡住);
 *  2. 单候选时与改动前逐字段等价(绝大多数部署只有一个搜索插件)。
 */
import { describe, it, expect, vi } from "vitest";
import {
  searchBestMatchWithFallback,
  type MatchProviderCandidate,
} from "../src/services/source/online/match.js";


const WANT = { entryId: 1, title: "测试歌", artist: "测试歌手" };

/** 造一个 provider:给定 songs(或抛错),记录被调用次数。 */
function provider(songs: any[] | null, err?: Error) {
  const search = vi.fn(async () => {
    if (err) throw err;
    return { songs: songs ?? [] };
  });
  return { search };
}

function cand(id: string, p: any, config: any = {}): MatchProviderCandidate {
  return { providerId: id, config, provider: p };
}

/** 能通过导入门禁的候选(标题 + 歌手强制相等,专辑/时长按需)。 */
const HIT = { id: "h1", source: "netease", name: "测试歌", artist: "测试歌手", album: "", duration: 200 };

const DEFAULT_CFG = {
  enabled: true,
  maxCandidates: 2,
  budgetMs: 6000,
  fallbackOnEmpty: true,
  fallbackOnError: true,
};

/** 开关通过 cfgOverride 注入(不写库,免得污染其它用例的插件配置)。 */
describe("searchBestMatchWithFallback 跨插件兜底", () => {
  it("单候选:与改动前等价,直接返回该候选结果", async () => {
    const p = provider([HIT]);
    const out = await searchBestMatchWithFallback([cand("go-music-dl", p)], WANT);
    expect(p.search).toHaveBeenCalledTimes(1);
    expect(out.status).toBe("matched");
    expect(out.best).toBe(HIT);
  });

  it("首候选命中:不发第二个插件的请求(兜底候选零开销)", async () => {
    const first = provider([HIT]);
    const second = provider([HIT]);
    const out = await searchBestMatchWithFallback(
      [cand("go-music-dl", first), cand("lx-source", second)],
      WANT,
    );
    expect(out.status).toBe("matched");
    expect(first.search).toHaveBeenCalledTimes(1);
    expect(second.search).not.toHaveBeenCalled();
  });

  it("首候选空结果:自动改用第二个插件并命中", async () => {
    const first = provider([]);
    const second = provider([HIT]);
    const out = await searchBestMatchWithFallback(
      [cand("go-music-dl", first), cand("lx-source", second)],
      WANT,
    );
    expect(out.status).toBe("matched");
    expect(out.best).toBe(HIT);
  });

  it("首候选抛错:自动改用第二个插件并命中", async () => {
    const first = provider(null, new Error("上游 403"));
    const second = provider([HIT]);
    const out = await searchBestMatchWithFallback(
      [cand("go-music-dl", first), cand("lx-source", second)],
      WANT,
    );
    expect(out.status).toBe("matched");
  });

  it("全部耗尽:返回最后一个候选的结果并带上兜底轨迹", async () => {
    const first = provider([]);
    const second = provider([]);
    const out = await searchBestMatchWithFallback(
      [cand("go-music-dl", first), cand("lx-source", second)],
      WANT,
    );
    expect(out.status).toBe("no-match");
    // 轨迹必须能看出是两个插件都试过(不是笼统一句「搜索失败」)
    expect(out.message).toContain("go-music-dl");
    expect(out.message).toContain("lx-source");
  });

  it("候选为空:明确报「无可用的在线匹配插件」,不静默返回空", async () => {
    const out = await searchBestMatchWithFallback([], WANT);
    expect(out.status).toBe("error");
    expect(out.message).toContain("无可用的在线匹配插件");
  });

  it("批内缓存:主候选空结果写入缓存后,兜底候选仍必须真的发起搜索", async () => {
    const first = provider([]);
    const second = provider([HIT]);
    const cache = new Map<string, any>();
    const out = await searchBestMatchWithFallback(
      [cand("go-music-dl", first), cand("lx-source", second)],
      WANT,
      cache,
    );
    expect(out.status).toBe("matched");
    // 缓存 key 若不带 providerId,第二个插件会被主候选的 no-match 短路 → 这条就红
    expect(second.search).toHaveBeenCalledTimes(1);
  });

  it("批内缓存:主候选被导入门禁挡下(这条会写缓存)后,兜底候选仍必须真的发起搜索", async () => {
    // 空搜索结果那一支是「不写缓存」的,真正会写缓存路径的是:候选搜到了但没过门禁。
    // 缓存 key 若不带 providerId,这里的 no-match 会把 lx-source 直接短路掉。
    const first = provider([{ ...HIT, name: "不是这首歌" }]);
    const second = provider([HIT]);
    const cache = new Map<string, any>();
    const out = await searchBestMatchWithFallback(
      [cand("go-music-dl", first), cand("lx-source", second)],
      WANT,
      cache,
    );
    expect(out.status).toBe("matched");
    expect(second.search).toHaveBeenCalledTimes(1);
  });

  it("批内缓存:同一插件内重复的 (title,artist) 仍只搜一次", async () => {
    const first = provider([HIT]);
    const cache = new Map<string, any>();
    await searchBestMatchWithFallback([cand("go-music-dl", first)], WANT, cache);
    const out = await searchBestMatchWithFallback([cand("go-music-dl", first)], WANT, cache);
    expect(first.search).toHaveBeenCalledTimes(1);
    expect(out.status).toBe("matched");
  });

  it("fallbackOnError 关掉:首候选抛错后不再换插件", async () => {
    const first = provider(null, new Error("上游 403"));
    const second = provider([HIT]);
    const out = await searchBestMatchWithFallback(
      [cand("go-music-dl", first), cand("lx-source", second)],
      WANT,
      undefined,
      { fallbackOnError: false },
    );
    expect(out.status).toBe("error");
    expect(first.search).toHaveBeenCalledTimes(1);
    expect(second.search).not.toHaveBeenCalled();
  });

  it("fallbackOnEmpty 关掉:首候选空结果后不再换插件", async () => {
    const first = provider([]);
    const second = provider([HIT]);
    const out = await searchBestMatchWithFallback(
      [cand("go-music-dl", first), cand("lx-source", second)],
      WANT,
      undefined,
      { fallbackOnEmpty: false },
    );
    expect(out.status).toBe("no-match");
    expect(second.search).not.toHaveBeenCalled();
  });

  it("首选慢/超时不吃兜底预算:第二候选仍会被触达并命中", async () => {
    // 首选光搜索就 300ms(> budgetMs 120ms)。修复前预算从「进函数」就开始计时,
    // 兜底闸门在发请求之前就被 remain() <= 0 拦掉 → 第二候选一个请求都发不出去。
    const slow = {
      search: vi.fn(async () => {
        await new Promise((r) => setTimeout(r, 300));
        return { songs: [] };
      }),
    };
    const second = provider([HIT]);
    const out = await searchBestMatchWithFallback(
      [cand("slow-src", slow), cand("lx-source", second)],
      WANT,
      undefined,
      { budgetMs: 120, maxCandidates: 2 },
    );
    expect(slow.search).toHaveBeenCalledTimes(1);
    expect(second.search).toHaveBeenCalledTimes(1);
    expect(out.status).toBe("matched");
    expect(out.best).toBe(HIT);
  });

  it("兜底候选自身超预算:该跳按失败记轨迹,且不再碰第三候选", async () => {
    // 第二候选光搜索就 300ms(> budgetMs 120ms)→ 该跳被预算掐断(收敛成失败,
    // 不把异常冒给调用方),且此时兜底预算已归零,第三候选连请求都不该发出
    // (maxCandidates 放成 3,让「不碰第三」只可能由预算闸门导致)。
    const first = provider([]);
    const slow = {
      search: vi.fn(async () => {
        await new Promise((r) => setTimeout(r, 300));
        return { songs: [] };
      }),
    };
    const third = provider([HIT]);
    const out = await searchBestMatchWithFallback(
      [cand("go-music-dl", first), cand("lx-source", slow), cand("netease", third)],
      WANT,
      undefined,
      { budgetMs: 120, maxCandidates: 3 },
    );
    expect(first.search).toHaveBeenCalledTimes(1);
    expect(slow.search).toHaveBeenCalledTimes(1);
    expect(third.search).not.toHaveBeenCalled();
    expect(out.status).toBe("error");
    // 超预算那一跳必须留在轨迹里(能看出是「超预算」而不是笼统的空结果)
    expect(out.message).toContain("超过兜底预算");
  });

  it("双闸门:maxCandidates=2 时第三个候选不许被碰(总开关 / 最多试几个)", async () => {
    const first = provider([]);
    const second = provider([]);
    const third = provider([HIT]);
    const out = await searchBestMatchWithFallback(
      [cand("go-music-dl", first), cand("lx-source", second), cand("netease", third)],
      WANT,
      undefined,
      { maxCandidates: 2 },
    );
    expect(out.status).toBe("no-match");
    expect(first.search).toHaveBeenCalledTimes(1);
    expect(second.search).toHaveBeenCalledTimes(1);
    expect(third.search).not.toHaveBeenCalled();
  });

  it("兜底整体关掉:退化为单候选,不碰其它插件", async () => {
    const first = provider([]);
    const second = provider([HIT]);
    const out = await searchBestMatchWithFallback(
      [cand("go-music-dl", first), cand("lx-source", second)],
      WANT,
      undefined,
      { enabled: false },
    );
    expect(out.status).toBe("no-match");
    expect(second.search).not.toHaveBeenCalled();
  });
});
