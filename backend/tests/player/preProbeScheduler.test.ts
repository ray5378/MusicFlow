// 服务端预探测守卫(2026-09-11)。
//
// 锁的是方案 v4/v5 的四组定案:
//   A. peek 纯度 —— 预探测绝不允许推进洗牌游标(否则每探一次 = 偷偷跳一首歌)
//   B. 枯竭判据是「连续无源 ≥ M、命中即归零」—— 不是「累计扫满 M」
//      (ray 定案:[死×49,可,死×49,可,死×49,可] 必须凑齐 3 首、不报枯竭;
//       把"归零"删掉这条必须转红)
//   C. 触底 ≠ 枯竭 —— order 末尾 / shuffle 轮次末 / 队列太短一律静默,
//      否则每次播到歌单末尾都会误报「大面积无源」
//   D. playCurrent 留队列跳过 + 绕过圈上限(= 队列长度)——
//      留队列删除了旧实现的隐式终止条件(摘除→队列变短→自然收敛),
//      没有上限的整队死源 + all/shuffle 就是无限循环
//
// MUST be the first import: redirects DATA_DIR to an isolated temp dir.
import "../plugins/_env.js";

import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import { initDatabase, db, sqlite } from "../../src/db/index.js";
import { songs } from "../../src/db/schema.js";
import { eq } from "drizzle-orm";
import { registerPlugin, unregisterPlugin } from "../../src/plugins/registry.js";
import { clearStreamFallbackCache, ensurePlayableStream } from "../../src/services/source/online/streamFallback.js";
import {
  peekUpcomingPositions,
  PreProbeScheduler,
  type PreProbeStatus,
} from "../../src/services/player/preProbeScheduler.js";
import { QueueController } from "../../src/services/player/QueueController.js";
import { PlaybackState } from "../../src/services/player/types.js";
import type { UniversalPlayer } from "../../src/services/player/UniversalPlayer.js";
import { readPreProbeConfig } from "../../src/services/plugin/core/preProbe.js";

// ---- 可控的时间:只位移 Date.now(),不 fake timers(避免 AbortSignal.timeout 挂死) ----
let nowShift = 0;
const realNow = Date.now;
beforeAll(() => { Date.now = () => realNow() + nowShift; });

// ---- 可控的探测:原链 URL 带 /alive/ → 206,带 /dead/ → 404(触发换源搜索) ----
vi.stubGlobal("fetch", async (url: string) => {
  const u = String(url);
  if (u.includes("/dead/")) return new Response("gone", { status: 404 });
  return new Response("bytes", { status: 206 });
});

// ---- 可控的探测:预热阶段决定每首歌的"命运",扫描阶段全部命中缓存(0 次真实探测) ----
const PROVIDER = "preprobe-test";
let providerCands: any[] = [];
const searchCalls: string[] = [];

const manifestOf = {
  id: PROVIDER,
  name: PROVIDER,
  version: "1.0.0",
  type: "source",
  capabilities: ["search", "stream"],
  platforms: ["netease"],
  configSchema: [],
  permissions: ["net"],
  sourcePreference: ["netease"],
} as const;

const provider = {
  id: PROVIDER,
  manifest: manifestOf,
  search: async (_c: any, p: any) => {
    searchCalls.push(String(p?.query || p?.id || ""));
    return { songs: providerCands };
  },
  streamUrl: (_c: any, song: any) => `http://gm:18080/m?id=${song.id}`,
};

/** 声明 preProbe 能力 → isCapabilityEnabled("preProbe") 为 true(内存注册表)。 */
const gateManifest = {
  id: "preprobe-gate",
  name: "preprobe-gate",
  version: "1.0.0",
  type: "sync",
  capabilities: ["preProbe", "streamFallback"],
  configSchema: [],
  permissions: [],
} as const;

beforeAll(() => {
  initDatabase();
  registerPlugin(manifestOf as any, provider);
  registerPlugin(gateManifest as any, {});
  // provider 也要有 DB 行:resolveStreamProvider 按「DB 已启用的源插件」解析,
  // 只有内存注册 → configured 为 null → findFallbackStream 在 search 之前就返回。
  sqlite.prepare(`
    INSERT INTO plugins (id, name, version, description, manifest, enabled, config, created_at, updated_at)
    VALUES (?, ?, '1.0.0', '', ?, 1, '{}', ?, ?)
    ON CONFLICT(id) DO UPDATE SET enabled = 1, manifest = excluded.manifest, config = '{}'
  `).run(PROVIDER, PROVIDER, JSON.stringify(manifestOf), new Date().toISOString(), new Date().toISOString());
  // 配置行(默认参数):readPreProbeConfig() 走 DB plugins 表。
  sqlite.prepare(`
    INSERT INTO plugins (id, name, version, description, manifest, enabled, config, created_at, updated_at)
    VALUES ('core-pre-probe', 'core-pre-probe', '1.0.0', '', '{}', 1, '{}', ?, ?)
    ON CONFLICT(id) DO UPDATE SET enabled = 1, config = '{}'
  `).run(new Date().toISOString(), new Date().toISOString());
});

beforeEach(() => {
  nowShift = 0;
  providerCands = [];
  searchCalls.length = 0;
  clearStreamFallbackCache();
  db.delete(songs).run();
  unregisterPlugin("preprobe-gate");
  registerPlugin(gateManifest as any, {});
});

/** seed 一首歌。dead = 预热成"所有平台都无候选"(→ 负缓存);alive = 有候选且 206(→ 正缓存)。 */
function seed(id: string, dead: boolean, duration?: number) {
  db.insert(songs).values({
    id,
    title: `t-${id}`,
    artist: "a",
    album: "al",
    duration: duration ?? 0,
    path: `web:${PROVIDER}:netease`,
    contentType: "audio/mpeg",
    suffix: "mp3",
    type: "web",
    url: `http://orig/${id}.mp3`,
    pluginEntry: PROVIDER,
    sourceData: JSON.stringify({ title: `t-${id}`, artist: "a", source: "netease" }),
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  }).run();
  if (dead) {
    providerCands = [];
    // 原链也 404 → 换源搜索同样空 → 负缓存 unplayable
    db.update(songs).set({ url: `http://gm:18080/dead/${id}.mp3` }).where(eq(songs.id, id)).run();
  } else {
    providerCands = [{ id, name: `t-${id}`, artist: "a", source: "netease" }];
    db.update(songs).set({ url: `http://gm:18080/alive/${id}.mp3` }).where(eq(songs.id, id)).run();
  }
  // 必须在 url 更新**之后**取行(含 url),否则预热用的是 insert 时的 orig URL
  const songRow = db.select().from(songs).where(eq(songs.id, id)).get() as any;
  return ensurePlayableStream(songRow);
}

type Q = Parameters<typeof peekUpcomingPositions>[0];

function queueOf(items: number[], playMode: Q["playMode"], currentIndex: number, shuffle?: { order: number[]; pos: number }): Q {
  return {
    // duration=0:不触发 T 时间窗截断 —— 计数判据用例专注「连续无源」本身
    items: items.map(i => ({ songId: `s${i}`, duration: 0 })),
    currentIndex,
    playMode,
    shuffleOrder: shuffle?.order,
    shufflePos: shuffle?.pos,
  };
}

// ==================== A. peek 纯度 ====================
describe("peekUpcomingPositions 纯度与模式边界", () => {
  it("peek 绝不修改输入(shuffleOrder/shufflePos/currentIndex 原样)", () => {
    const q = queueOf([0, 1, 2, 3, 4], "shuffle", 1, { order: [1, 3, 0, 4, 2], pos: 0 });
    const before = JSON.stringify(q);
    peekUpcomingPositions(q, 150);
    expect(JSON.stringify(q)).toBe(before);
  });

  it("shuffle 沿序列取,序列走到底 → reachedEnd 且**不重洗**(重洗=改状态)", () => {
    const q = queueOf([0, 1, 2], "shuffle", 0, { order: [0, 2, 1], pos: 0 });
    const r = peekUpcomingPositions(q, 150);
    expect(r.positions).toEqual([2, 1]);
    expect(r.reachedEnd).toBe(true);
    expect(q.shufflePos).toBe(0); // 未被推进
  });

  it("all 回绕一轮:不含当前曲、不重复", () => {
    const q = queueOf([0, 1, 2, 3], "all", 1);
    const r = peekUpcomingPositions(q, 150);
    expect(r.positions).toEqual([2, 3, 0]);
    expect(r.reachedEnd).toBe(true);
    expect(r.positions).not.toContain(1);
  });

  it("order 播到末尾:剩余位置不足 M 也如实返回(触底不是故障)", () => {
    const q = queueOf([0, 1, 2], "order", 1);
    const r = peekUpcomingPositions(q, 150);
    expect(r.positions).toEqual([2]);
    expect(r.reachedEnd).toBe(true);
  });

  it("one 模式窗口退化为 1 首(下一首永远是当前曲)", () => {
    const q = queueOf([0, 1, 2], "one", 1);
    const r = peekUpcomingPositions(q, 150);
    expect(r.positions).toEqual([1]);
  });
});

// ==================== B. 枯竭判据:连续无源、命中归零 ====================
describe("扫描:连续无源计数(命中即归零)", () => {
  function makeScheduler(): PreProbeScheduler {
    const s = new PreProbeScheduler();
    return s;
  }

  it("健康队列:凑够 N 首即停,静默(ready=N, exhausted=false)", async () => {
    for (const i of [0, 1, 2, 3]) seed(`s${i}`, false);
    const s = makeScheduler();
    const q = queueOf([0, 1, 2, 3], "all", 0);
    await (s as any).scan("d1", q, readPreProbeConfig());
    const st = s.status("d1");
    expect(st.ready).toBe(3);
    expect(st.exhausted).toBe(false);
    expect(st.scanned).toBe(3); // 恰好 N 次,不浪费
  });

  it("[死×49,可,死×49,可,死×49,可](N=3,M=50):必须凑齐 3 首、未报枯竭 —— 归零的关键用例", async () => {
    // 队列 0..149:0..48 死,49 活,50..98 死,99 活,100..148 死,149 活。
    // 当前曲 = 0(死歌,不占位置流):all 模式位置流 = 1..149,恰好覆盖三首活歌。
    for (let i = 0; i < 150; i++) {
      const alive = i === 49 || i === 99 || i === 149;
      seed(`s${i}`, !alive);
    }
    const q: Q = {
      // duration=0:本用例专注「连续无源归零」判据,不让 T 时间窗截断干扰
      items: Array.from({ length: 150 }, (_, i) => ({ songId: `s${i}`, duration: 0 })),
      currentIndex: 0, playMode: "all",
    };
    const s = makeScheduler();
    await (s as any).scan("d1", q, readPreProbeConfig());
    const st = s.status("d1");
    expect(st.ready).toBe(3);
    expect(st.exhausted).toBe(false); // 把"归零"删掉,这里会变 true
  }, 30000);

  it("[死×50]:第 50 位判枯竭并进入冷却", async () => {
    for (let i = 0; i < 60; i++) seed(`s${i}`, true);
    const { getCachedPlayability } = await import("../../src/services/source/online/streamFallback.js");

    const q = queueOf(Array.from({ length: 60 }, (_, i) => i), "all", 0);
    const s = makeScheduler();
    await (s as any).scan("d1", q, readPreProbeConfig());
    const st = s.status("d1");
    expect(st.exhausted).toBe(true);
    expect(st.misses).toBeGreaterThanOrEqual(50);
    expect(st.cooldownUntil).not.toBeNull();
  });

  it("枯竭冷却:schedule 在冷却期内不再扫描,位移到期后恢复", async () => {
    for (let i = 0; i < 60; i++) seed(`s${i}`, true);
    const q = queueOf(Array.from({ length: 60 }, (_, i) => i), "all", 0);
    const s = makeScheduler();
    let done = 0;
    s.onScanComplete = () => done++;
    const getQ = () => q;
    s.schedule("d1", getQ);
    await vi.waitFor(() => expect(done).toBe(1));
    expect(s.status("d1").exhausted).toBe(true);
    // 冷却期内再触发 → 不扫
    s.schedule("d1", getQ);
    await new Promise(r => setTimeout(r, 30));
    expect(done).toBe(1);
    // 位移过冷却(90s)
    nowShift += 91 * 1000;
    s.schedule("d1", getQ);
    await vi.waitFor(() => expect(done).toBe(2));
  });

  it("闸1×闸2 交互:负缓存已过期但同曲冷却未过 → 沿用上次判定,不真实重探", async () => {
    seed("x1", true);
    const q: Q = { items: [{ songId: "x1", duration: 0 }], currentIndex: 0, playMode: "one" };
    const s = makeScheduler();
    // 时间线设计(对预热命中与否不敏感,全部用相对断言):
    //   T1 = 首次真实探测时刻。预热不写 lastProbeAt → 首次真实探测必发生在
    //   「负缓存过期后的第一次 scan」。
    nowShift += 46 * 1000;                       // 负缓存(45s)必已过期
    await (s as any).scan("d1", q, readPreProbeConfig());
    const base = searchCalls.length;             // T1 已发生,记基数
    const { getCachedPlayability } = await import("../../src/services/source/online/streamFallback.js");
    expect(getCachedPlayability("x1")).toBe("unplayable"); // T1 重新写了负缓存
    // T1+15s:负缓存(45s)未过期 → 命中 → 不重探
    nowShift += 15 * 1000;
    await (s as any).scan("d1", q, readPreProbeConfig());
    expect(searchCalls.length).toBe(base);
    // T1+50s:负缓存已过期,但同曲冷却(60s)未过 → **沿用「不可播」判定,不真实重探**
    nowShift += 35 * 1000;
    await (s as any).scan("d1", q, readPreProbeConfig());
    expect(searchCalls.length).toBe(base);
    // T1+65s:同曲冷却也过了 → 允许真实重探
    nowShift += 15 * 1000;
    await (s as any).scan("d1", q, readPreProbeConfig());
    expect(searchCalls.length).toBe(base + 1);
  });
});

// ==================== C. 触底 ≠ 枯竭 ====================
describe("触底一律静默", () => {
  it("队列总长 < M 且含死源:触底不上报(order 末尾不足)", async () => {
    seed("s0", true); seed("s1", false);
    const s = new PreProbeScheduler();
    const q = queueOf([0, 1], "order", 0);
    await (s as any).scan("d1", q, readPreProbeConfig());
    expect(s.status("d1").exhausted).toBe(false);
  });

  it("shuffle 轮次末尾(序列剩余不足):不重洗、不上报", async () => {
    seed("s0", true); seed("s1", true); // 剩余 2 个位置都是死的,但总共 < M
    const s = new PreProbeScheduler();
    const q = queueOf([0, 1, 2], "shuffle", 0, { order: [0, 1, 2], pos: 0 });
    await (s as any).scan("d1", q, readPreProbeConfig());
    expect(s.status("d1").exhausted).toBe(false);
    expect(q.shufflePos).toBe(0);
  });

  it("向前覆盖超 T 分钟:静默截断,不算枯竭", async () => {
    // T=8min=480s;每首 200s → 第 3 首就超(covered 400 + 200 > 480)
    seed("s0", false, 200); seed("s1", false, 200); seed("s2", false, 200);
    const s = new PreProbeScheduler();
    const q = queueOf([0, 1, 2], "order", 0);
    await (s as any).scan("d1", q, readPreProbeConfig());
    expect(s.status("d1").exhausted).toBe(false);
  });
});

// ==================== D. playCurrent 留队列跳过 + 绕圈上限 ====================
describe("QueueController:留队列跳过与绕圈上限", () => {
  function makePlayer(id: string): UniversalPlayer & { calls: string[] } {
    const calls: string[] = [];
    return {
      playerId: `dlna:${id}`,
      name: id,
      attachProtocol: () => {},
      getProtocol: () => { throw new Error("unused"); },
      playMedia: async () => { calls.push("playMedia"); return { mediaUri: "u" }; },
      stop: async () => { calls.push("stop"); },
      pause: async () => {}, resume: async () => {}, seek: async () => {}, setVolume: async () => {},
      pollState: async () => ({ playerId: `dlna:${id}`, playbackState: PlaybackState.PLAYING, position: 0, duration: 0, updatedAt: realNow() }),
      calls,
    } as unknown as UniversalPlayer & { calls: string[] };
  }
  const ctrl = {
    beginOptimistic: () => {}, endOptimistic: () => {},
    reportState: () => {}, resetTracker: () => {},
  };

  function setup(items: Array<{ id: string; dead: boolean }>, mode: "all" | "order" | "shuffle") {
    const qc = new QueueController();
    const player = makePlayer("dd");
    qc.registerPlayer("dd", player, ctrl as any);
    const seeded = items.map(it => { seed(it.id, it.dead); return { songId: it.id, title: it.id, mime: "audio/mpeg" }; });
    qc.setQueue("dd", seeded, 0, "http://base");
    qc.setPlayMode("dd", mode);
    return { qc, player, seeded };
  }

  it("死源被跳过但**留在队列**(items.length 不变,shuffleOrder 不重建)", async () => {
    // 全部提前预热(含死歌),playCurrent 只消费缓存
    const { qc, player, seeded } = setup(
      [{ id: "k1", dead: true }, { id: "k2", dead: true }, { id: "k3", dead: false }, { id: "k4", dead: false }],
      "order",
    );
    searchCalls.length = 0; // 清零:之后不允许再真实探测
    await qc.next("dd", "http://base");
    expect(player.calls).toContain("playMedia");
    const snap = qc.snapshot("dd");
    expect(snap.items).toHaveLength(seeded.length); // 留队列:不摘除
    expect(snap.currentIndex).toBe(2); // 跳过了 k1,k2(k0=k1 是 index0)
  }, 20000);

  it("整队死源 + all 模式:绕过圈上限(= 队列长度)内停止,不 markEnded、不删队列", async () => {
    const items = Array.from({ length: 4 }, (_, i) => ({ id: `z${i}`, dead: true }));
    const { qc, player } = setup(items, "all");
    const snapBefore = qc.snapshot("dd");
    searchCalls.length = 0;
    // 带超时守护:若绕圈上限缺失,这里会无限循环,test 自己挂到 timeout
    await Promise.race([
      qc.next("dd", "http://base"),
      new Promise((_, rej) => setTimeout(() => rej(new Error("绕圈上限缺失:playCurrent 未在队列长度步内停止")), 15000)),
    ]);
    expect(player.calls).not.toContain("playMedia"); // 全死,一首都没播出去
    const snap = qc.snapshot("dd");
    expect(snap.items).toHaveLength(4); // 不删队列
    expect(snap.ended).toBe(false); // 不 markEnded(保留现场)
    expect(snap.preProbe?.exhausted).toBe(true); // 上报
  }, 30000);
});
