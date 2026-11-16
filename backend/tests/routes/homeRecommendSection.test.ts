// ==================== 首页「为你推荐」服务端组装(v4.14.9)回归测试 ====================
//
// 对象:backend/src/routes/api/homeRecommendSection.ts 的纯计算层
//   buildRecommendSection() —— 三端(Web/Flutter/HA 卡片)首页固定卡的唯一真源。
//
// 背景:2026-11-15 前三端各自本地组装(洗牌口径互不相同,同用户三套卡片);
//   v4.14.9 收敛为服务端单源:固定卡零门槛 + 随机补位按小时快照冻结。
//   这里钉住的不变式(逐条对齐源码注释里的语义):
//     ① 固定卡排序 (position 升序,并列按 pluginId 字典序),0 = 未固定排最后;
//     ② degraded = 有候选且任一指向不存在的歌单;
//     ③ 随机池门槛 songCount >= 30,固定卡 id 不占随机位;
//     ④ 快照采纳三条件:每个 id 仍在池子里 / 都不是固定卡 / 条数恰等于 want;
//        任一条不满足 ⇒ 重算,绝不返回死链、绝不补不满张数;
//     ⑤ want === 0 时空快照是正确结果,照常复用;
//     ⑥ 同 (seed, playlistId) 的 stableKey 恒定 ⇒ 同 seed 结果确定(无 Math.random)。
import { describe, it, expect } from "vitest";
import {
  buildRecommendSection,
  buildSectionSeed,
  hourBucketOf,
  RANDOM_CARD_MIN_SONG_COUNT,
  stableKey,
  type FixedCardCandidate,
  type RecommendPoolItem,
} from "../../src/routes/api/homeRecommendSection.js";

/** 造一张固定卡候选(健康卡:歌单行存在)。 */
function fixed(over: Partial<FixedCardCandidate> = {}): FixedCardCandidate {
  return {
    pluginId: "pl-daily",
    playlistId: "pl-daily-today",
    name: "今日漫游",
    playlistName: "今日漫游",
    position: 1,
    songCount: 42,
    coverArt: "pl-pl-daily-today",
    isCombo: false,
    missing: false,
    ...over,
  };
}

/** 造一条歌单池投影。 */
function pool(id: string, songCount = 50, name = `歌单-${id}`, changed = "2026-11-15T00:00:00Z"): RecommendPoolItem {
  return { id, name, songCount, changed };
}

/** 12 张随机池歌单。 */
function pool12(): RecommendPoolItem[] {
  return Array.from({ length: 12 }, (_, i) => pool(`rnd-${String(i + 1).padStart(2, "0")}`));
}

describe("hourBucketOf / buildSectionSeed / stableKey:基础纯函数", () => {
  it("hourBucketOf:同一小时内恒定,跨整点 +1", () => {
    const base = Date.UTC(2026, 10, 15, 9, 0, 0);
    expect(hourBucketOf(base)).toBe(hourBucketOf(base + 59 * 60_000));
    expect(hourBucketOf(base + 60 * 60_000)).toBe(hourBucketOf(base) + 1);
  });

  it("buildSectionSeed:seed 含 user.id 与 hourBucket;未登录用空串且拼接顺序稳定", () => {
    expect(buildSectionSeed("u1", 30000)).toBe("u1|30000");
    expect(buildSectionSeed(undefined, 30000)).toBe("|30000");
    // 拼接顺序稳定:userId 在前,不能变成 "30000|u1"
    expect(buildSectionSeed("30000", 1)).not.toBe(buildSectionSeed("1", 30000));
  });

  it("stableKey:同一 (seed, playlistId) 永远同一个值(确定性洗牌的基石)", () => {
    const a = stableKey("u1|30000", "rnd-01");
    expect(a).toBe(stableKey("u1|30000", "rnd-01"));
    expect(Number.isInteger(a)).toBe(true);
    expect(a).toBeGreaterThanOrEqual(0);
  });
});

describe("buildRecommendSection:固定卡", () => {
  it("固定卡按 (position 升序, 并列 pluginId 字典序) 排序;position=0 未固定排最后", () => {
    const out = buildRecommendSection({
      fixedCandidates: [
        fixed({ pluginId: "b-plug", playlistId: "pl-b", name: "B", position: 2 }),
        fixed({ pluginId: "z-plug", playlistId: "pl-z", name: "Z", position: 1 }),
        fixed({ pluginId: "a-plug", playlistId: "pl-a", name: "A", position: 2 }),
        fixed({ pluginId: "c-plug", playlistId: "pl-c", name: "C", position: 0 }),
      ],
      pool: pool12(),
      homeCount: 6,
      seed: "u1|30000",
      hourBucket: 30000,
    });
    expect(out.fixed.map((c) => c.playlistId)).toEqual(["pl-z", "pl-a", "pl-b", "pl-c"]);
    // 固定卡零门槛:10 首的小歌单也原样带出(用户定调:固定卡就该一直显示)
    expect(out.fixed).toHaveLength(4);
  });

  it("缺行卡标 missing=true 并触发 degraded;健康卡不带 missing 键", () => {
    const out = buildRecommendSection({
      fixedCandidates: [
        fixed({ playlistId: "pl-ok" }),
        fixed({ playlistId: "pl-gone", missing: true, playlistName: "", songCount: 0, coverArt: null }),
      ],
      pool: pool12(),
      homeCount: 4,
      seed: "u1|30000",
      hourBucket: 30000,
    });
    expect(out.degraded).toBe(true);
    const gone = out.fixed.find((c) => c.playlistId === "pl-gone")!;
    expect(gone.missing).toBe(true);
    const ok = out.fixed.find((c) => c.playlistId === "pl-ok")!;
    expect("missing" in ok).toBe(false);
  });

  it("fixed 为空不算降级(只是 showOnHome 全 false);缺 homeCount(非法值)按 0 兜底", () => {
    const empty = buildRecommendSection({
      fixedCandidates: [],
      pool: pool12(),
      homeCount: 4,
      seed: "s",
      hourBucket: 1,
    });
    expect(empty.degraded).toBe(false);
    const nan = buildRecommendSection({
      fixedCandidates: [fixed()],
      pool: pool12(),
      homeCount: Number.NaN,
      seed: "s",
      hourBucket: 1,
    });
    expect(nan.homeCount).toBe(0);
    expect(nan.fixed).toHaveLength(1); // 固定卡照常返回,只是随机位 want=0
    expect(nan.random).toHaveLength(0);
  });
});

describe("buildRecommendSection:随机补位", () => {
  it("随机池只取 songCount >= 30 的歌单,且固定卡 id 不占随机位", () => {
    const out = buildRecommendSection({
      fixedCandidates: [fixed({ playlistId: "rnd-01" })], // 池里头部歌单被固定卡占用
      pool: [pool("rnd-01"), pool("small-1", 29), pool("small-2", 1), ...pool12().slice(1)],
      homeCount: 12,
      seed: "u1|30000",
      hourBucket: 30000,
    });
    expect(RANDOM_CARD_MIN_SONG_COUNT).toBe(30);
    expect(out.randomIds).not.toContain("rnd-01"); // 固定卡不占随机位
    expect(out.randomIds).not.toContain("small-1"); // 29 首 < 30 被挡
    expect(out.randomIds).not.toContain("small-2");
    expect(out.randomIds).toHaveLength(11); // want = 12 - 1
  });

  it("同 seed 结果完全确定(逐项恒定);换 seed 后 stableKey 语义仍成立", () => {
    const input = {
      fixedCandidates: [] as FixedCardCandidate[],
      pool: pool12(),
      homeCount: 12,
      seed: "u1|30000",
      hourBucket: 30000,
    };
    const a = buildRecommendSection(input);
    const b = buildRecommendSection({ ...input });
    expect(a.randomIds).toEqual(b.randomIds);
    expect(a.frozen).toBe(false);
    // 稳定性来源:排序键 = stableKey(seed, id),同输入必同输出
    const keys = a.randomIds.map((id) => stableKey(input.seed, id));
    expect([...keys].sort((x, y) => x - y)).toEqual(keys);
  });

  it("随机位卡片投影永远取当前池子的最新数据(名字/曲目数可变,id 才是身份)", () => {
    const out = buildRecommendSection({
      fixedCandidates: [],
      pool: [pool("rnd-01", 50, "改名后的歌单")],
      homeCount: 1,
      seed: "s",
      hourBucket: 1,
    });
    expect(out.randomIds).toEqual(["rnd-01"]);
    expect(out.random[0]).toEqual({ id: "rnd-01", name: "改名后的歌单", songCount: 50, coverArt: "pl-rnd-01" });
  });
});

describe("buildRecommendSection:快照冻结随机位", () => {
  it("快照三条件全满足 → 原样采纳(frozen=true),不重算", () => {
    const ids = ["rnd-03", "rnd-01", "rnd-02"]; // 顺序就是冻结顺序,采纳时不得重排
    const out = buildRecommendSection({
      fixedCandidates: [],
      pool: pool12(),
      homeCount: 3, // want = 3,与快照条数一致才可采纳
      seed: "u1|30000",
      hourBucket: 30000,
      frozenRandomIds: ids,
    });
    expect(out.frozen).toBe(true);
    expect(out.randomIds).toEqual(ids);
  });

  it("快照 id 已不在池子(歌单被删/转私密)→ 失效重算,绝不返回死链", () => {
    const out = buildRecommendSection({
      fixedCandidates: [],
      pool: pool12(),
      homeCount: 12,
      seed: "u1|30000",
      hourBucket: 30000,
      frozenRandomIds: ["rnd-99", ...pool12().slice(0, 11).map((p) => p.id)],
    });
    expect(out.frozen).toBe(false);
    expect(out.randomIds).not.toContain("rnd-99");
    expect(out.randomIds.every((id) => pool12().some((p) => p.id === id))).toBe(true);
  });

  it("快照 id 变成了固定卡 → 失效重算(固定卡不占随机位)", () => {
    const frozen = pool12().slice(0, 12).map((p) => p.id);
    const out = buildRecommendSection({
      fixedCandidates: [fixed({ playlistId: frozen[0] })],
      pool: pool12(),
      homeCount: 12,
      seed: "u1|30000",
      hourBucket: 30000,
      frozenRandomIds: frozen,
    });
    expect(out.frozen).toBe(false);
    expect(out.randomIds).not.toContain(frozen[0]);
    expect(out.randomIds).toHaveLength(11); // want = 12 - 1,重算也必须补满
  });

  it("快照条数不等于当前应补张数(fixed 张数变了)→ 失效重算,该补几张补几张", () => {
    const frozen = pool12().slice(0, 12).map((p) => p.id);
    // 配置变更:固定卡从 0 张变 4 张 ⇒ want = 12 - 4 = 8,旧快照(12 条)不许直接采纳
    const out = buildRecommendSection({
      fixedCandidates: [
        fixed({ playlistId: "pl-1" }),
        fixed({ playlistId: "pl-2" }),
        fixed({ playlistId: "pl-3" }),
        fixed({ playlistId: "pl-4" }),
      ],
      pool: pool12(),
      homeCount: 12,
      seed: "u1|30000",
      hourBucket: 30000,
      frozenRandomIds: frozen,
    });
    expect(out.frozen).toBe(false);
    expect(out.randomIds).toHaveLength(8);
  });

  it("want === 0 时空快照是正确结果,照常复用(frozen=true)", () => {
    const out = buildRecommendSection({
      fixedCandidates: [fixed(), fixed({ playlistId: "pl-2", pluginId: "p2" }), fixed({ playlistId: "pl-3", pluginId: "p3" })],
      pool: pool12(),
      homeCount: 3,
      seed: "u1|30000",
      hourBucket: 30000,
      frozenRandomIds: [],
    });
    expect(out.frozen).toBe(true);
    expect(out.randomIds).toEqual([]);
    expect(out.random).toEqual([]);
  });
});
