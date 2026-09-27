// MUST be the first import: redirects DATA_DIR to an isolated temp dir before
// the backend opens its SQLite DB at module-load time.
import "../plugins/_env.js";

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// autoMatch 只依赖 4 个模块:队列控制器、内容解析、后台匹配器、WS 广播。
// 全部整体替换即可(本文件不加载 DB,故无需 _env 之外的初始化)。
const h = vi.hoisted(() => ({
  qc: {
    getContentContext: vi.fn(() => "playlist:pl1"),
    snapshot: vi.fn(() => ({ items: [] as any[] })),
    enqueue: vi.fn(async () => undefined),
  },
  match: vi.fn(),
  resolveContentSongs: vi.fn(),
  songsToQueueItems: vi.fn((rows: any[]) => rows.map((r) => ({ songId: r.id, title: r.title }))),
  broadcast: vi.fn(),
  logs: { info: [] as any[], warn: [] as any[] },
}));

vi.mock("../../src/services/player/index.js", () => ({
  getQueueController: () => h.qc,
}));

vi.mock("../../src/services/content.js", () => ({
  resolveContentSongs: (...a: any[]) => (h.resolveContentSongs as any)(...a),
  songsToQueueItems: (...a: any[]) => (h.songsToQueueItems as any)(...a),
}));

vi.mock("../../src/services/plugin/shared.js", () => ({
  matchPlaylistInBackground: (...a: any[]) => (h.match as any)(...a),
}));

vi.mock("../../src/services/ws/index.js", () => ({
  broadcastToClients: (...a: any[]) => (h.broadcast as any)(...a),
}));

vi.mock("../../src/utils/logger.js", () => ({
  createLogger: () => ({
    debug: () => {},
    info: (msg: string, meta?: any) => h.logs.info.push([msg, meta]),
    warn: (msg: string, meta?: any) => h.logs.warn.push([msg, meta]),
    error: () => {},
  }),
}));

import { runPlaylistAutoMatch } from "../../src/services/playlist/autoMatch.js";

/** 让后台匹配「立刻跑完并回调」,战果为 stats。 */
function finishingWith(stats: any) {
  return vi.fn((playlistId: string, cb: (r: any) => void) => {
    cb(stats);
    return Promise.resolve(stats);
  });
}

const okStats = (over: Record<string, any> = {}) => ({
  total: 5,
  matched: 3,
  concurrencySkipped: false,
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  h.qc.getContentContext.mockReturnValue("playlist:pl1");
  h.qc.snapshot.mockReturnValue({ items: [] });
  h.qc.enqueue.mockResolvedValue(undefined);
  h.match.mockImplementation(finishingWith(okStats()));
  h.resolveContentSongs.mockResolvedValue({ rows: [{ id: "s1", title: "A" }], name: "pl1" });
  h.songsToQueueItems.mockImplementation((rows: any[]) => rows.map((r) => ({ songId: r.id, title: r.title })));
  h.broadcast.mockImplementation(() => undefined);
  h.logs.info.length = 0;
  h.logs.warn.length = 0;
});

afterEach(() => {
  vi.useRealTimers();
});

describe("runPlaylistAutoMatch:节流窗口(同一歌单 24h 只自动跑一轮)", () => {
  it("首次调用真跑一轮并落 total/matched", async () => {
    const r = await runPlaylistAutoMatch("pl-throttle-a");
    expect(r.skipped).toBeUndefined();
    expect(r).toMatchObject({ total: 5, matched: 3, appended: 0 });
    expect(h.match).toHaveBeenCalledTimes(1);
  });

  it("窗口内第二次调用 → skipped='throttled',不再打在线源", async () => {
    await runPlaylistAutoMatch("pl-throttle-b");
    const r = await runPlaylistAutoMatch("pl-throttle-b");
    expect(r.skipped).toBe("throttled");
    expect(r.total).toBe(0);
    expect(h.match).toHaveBeenCalledTimes(1);
  });

  it("force=true 无视窗口,手点「批量匹配」总能重跑", async () => {
    await runPlaylistAutoMatch("pl-throttle-c");
    const r = await runPlaylistAutoMatch("pl-throttle-c", { force: true });
    expect(r.skipped).toBeUndefined();
    expect(h.match).toHaveBeenCalledTimes(2);
  });

  it("「什么都没匹配到」也算跑过一轮,照样吃额度", async () => {
    h.match.mockImplementation(finishingWith(okStats({ total: 0, matched: 0 })));
    await runPlaylistAutoMatch("pl-throttle-d");
    expect((await runPlaylistAutoMatch("pl-throttle-d")).skipped).toBe("throttled");
  });

  it("concurrencySkipped(被并发锁挡下的空跑)不吃额度 → 下一次仍会真跑", async () => {
    h.match.mockImplementation(finishingWith(okStats({ total: 0, matched: 0, concurrencySkipped: true })));
    await runPlaylistAutoMatch("pl-throttle-e");
    const r = await runPlaylistAutoMatch("pl-throttle-e");
    expect(r.skipped).toBeUndefined();
    expect(h.match).toHaveBeenCalledTimes(2);
  });

  it("节流表超过上限(2000)时整体清空 → 最老的歌单重新可跑", async () => {
    // 用独立前缀,避免与其他用例的 id 互相污染(文件内用例顺序被 shuffle)
    for (let i = 0; i < 2001; i++) await runPlaylistAutoMatch(`ox-${i}`);
    // 第 2001 次插入前表已满 → 清空后只剩 ox-2000,故最早的 ox-0 不再被节流
    const again = await runPlaylistAutoMatch("ox-0");
    expect(again.skipped).toBeUndefined();
  });

  it("节流表超上限且有过期项 → 先按过期删除(不必整体清空)", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    try {
      for (let i = 0; i < 2000; i++) await runPlaylistAutoMatch(`ex-${i}`);
      // 时间推进 25h(> 24h 窗口)→ 2000 条全部过期
      vi.setSystemTime(new Date("2026-01-02T01:00:00Z"));
      await runPlaylistAutoMatch("ex-2000"); // 触发 prune:全部过期被删 + 插入自己
    } finally {
      vi.useRealTimers();
    }
    // 若走的是「按过期删除」,早先的 ex-0 已被删 → 不节流
    expect((await runPlaylistAutoMatch("ex-0")).skipped).toBeUndefined();
  });
});

describe("runPlaylistAutoMatch:等批量闸的竞速与放弃", () => {
  it("后台一直不回调 → lockTimeout=true,不影响调用方(不永久挂住)", async () => {
    h.match.mockImplementation(() => new Promise(() => {}));
    const r = await runPlaylistAutoMatch("pl-lock-a", { lockWaitMs: 5 });
    expect(r.lockTimeout).toBe(true);
    expect(r.total).toBe(0);
    expect(h.logs.info.some(([m]) => String(m).includes("等批量闸超时"))).toBe(true);
  });

  it("等闸超时不吃节流额度(下播时还能再试)", async () => {
    h.match.mockImplementation(() => new Promise(() => {}));
    await runPlaylistAutoMatch("pl-lock-b", { lockWaitMs: 5 });
    h.match.mockImplementation(finishingWith(okStats()));
    const r = await runPlaylistAutoMatch("pl-lock-b", { lockWaitMs: 5 });
    expect(r.lockTimeout).toBeUndefined();
    expect(r.matched).toBe(3);
  });

  it("现状记录(缺陷台账 D19):后台匹配器 reject 也被报成 lockTimeout,且不留错误日志", async () => {
    // 现状:box 只在 onFinished 回调里赋值;底层 reject → catch(()=>resolve()) 只推进
    // 「等闸」这条 Promise,box 仍为 null → 与「等太久」走上同一条分支。
    // 于是「匹配失败」被回报成「等批量闸超时」,并只打一条 info(没有 error/warn)。
    // 影响:调用方/排障者会把失败误读为排队超时;修复后本用例应改为断言
    //       存在独立的失败回报(或至少 logger.error 被调用)。
    h.match.mockImplementation(() => Promise.reject(new Error("在线源全线 429")));
    const r = await runPlaylistAutoMatch("pl-lock-c", { lockWaitMs: 50 });
    expect(r.lockTimeout).toBe(true);
    expect(h.logs.info.some(([m]) => String(m).includes("等批量闸超时"))).toBe(true);
    expect(h.logs.warn).toEqual([]);
  });
});

describe("runPlaylistAutoMatch:播放后补齐队列", () => {
  it("标记一致时把「队列里没有的新匹配曲目」补到队尾", async () => {
    h.resolveContentSongs.mockResolvedValue({
      rows: [{ id: "s1", title: "A" }, { id: "s2", title: "B" }, { id: "s3", title: "C" }],
      name: "pl1",
    });
    h.qc.snapshot.mockReturnValue({ items: [{ songId: "s1" }] });
    const r = await runPlaylistAutoMatch("pl-append-a", { playerId: "dlna:x", contentContext: "playlist:pl1", baseUrl: "http://h:1" });
    expect(r.appended).toBe(2);
    expect(h.qc.enqueue).toHaveBeenCalledWith("dlna:x", [{ songId: "s2", title: "B" }, { songId: "s3", title: "C" }], "http://h:1");
  });

  it("队列里已全都有 → 不调 enqueue,appended 保持 0", async () => {
    h.resolveContentSongs.mockResolvedValue({ rows: [{ id: "s1", title: "A" }], name: "pl1" });
    h.qc.snapshot.mockReturnValue({ items: [{ songId: "s1" }] });
    const r = await runPlaylistAutoMatch("pl-append-b", { playerId: "p", contentContext: "playlist:pl1" });
    expect(r.appended).toBe(0);
    expect(h.qc.enqueue).not.toHaveBeenCalled();
  });

  it("没给 playerId / contentContext → 只做匹配,不做补齐", async () => {
    const r = await runPlaylistAutoMatch("pl-append-c");
    expect(r.matched).toBe(3);
    expect(h.qc.getContentContext).not.toHaveBeenCalled();
    expect(h.qc.enqueue).not.toHaveBeenCalled();
  });

  it("队列标记与传入的 contentContext 不符(用户已切内容)→ skipped='context-mismatch',不补齐", async () => {
    h.qc.getContentContext.mockReturnValue("playlist:other");
    const r = await runPlaylistAutoMatch("pl-append-d", { playerId: "p", contentContext: "playlist:pl1" });
    expect(r.skipped).toBe("context-mismatch");
    expect(r.matched).toBe(3); // 匹配本身已经跑完
    // 显式断言队列控制器被问到过(防止 mock 路径写错时本用例「假绿」)
    expect(h.qc.getContentContext).toHaveBeenCalledWith("p");
    expect(h.qc.enqueue).not.toHaveBeenCalled();
  });

  it("解析歌单失败 → warn 后返回,不影响已听的歌", async () => {
    h.resolveContentSongs.mockRejectedValue(new Error("库不可用"));
    const r = await runPlaylistAutoMatch("pl-append-e", { playerId: "p", contentContext: "playlist:pl1" });
    expect(r.appended).toBe(0);
    expect(h.qc.enqueue).not.toHaveBeenCalled();
    expect(h.logs.warn.some(([m]) => String(m).includes("解析歌单失败"))).toBe(true);
  });

  it("解析结果为空 → 不补齐(不报错)", async () => {
    h.resolveContentSongs.mockResolvedValue({ rows: [], name: "pl1" });
    const r = await runPlaylistAutoMatch("pl-append-f", { playerId: "p", contentContext: "playlist:pl1" });
    expect(r.appended).toBe(0);
    expect(h.qc.enqueue).not.toHaveBeenCalled();
  });

  it("enqueue 抛错 → warn 且 appended 仍是 0(补齐失败不改匹配战果)", async () => {
    h.qc.enqueue.mockRejectedValue(new Error("设备离线"));
    const r = await runPlaylistAutoMatch("pl-append-g", { playerId: "p", contentContext: "playlist:pl1" });
    expect(r.appended).toBe(0);
    expect(r.matched).toBe(3);
    expect(h.logs.warn.some(([m]) => String(m).includes("补齐队列失败"))).toBe(true);
  });

  it("baseUrl 缺省 → 用空串(队列侧自行回落)", async () => {
    const r = await runPlaylistAutoMatch("pl-append-h", { playerId: "p", contentContext: "playlist:pl1" });
    expect(r.appended).toBe(1);
    expect(h.qc.enqueue).toHaveBeenCalledWith("p", [{ songId: "s1", title: "A" }], "");
  });
});

describe("runPlaylistAutoMatch:WS 回执(歌单页据此刷新)", () => {
  it("本轮有新绑定(matched>0)才广播,且 payload 带回补了几首", async () => {
    const r = await runPlaylistAutoMatch("pl-ws-a", { playerId: "dlna:x", contentContext: "playlist:pl1" });
    expect(r.matched).toBe(3);
    expect(h.broadcast).toHaveBeenCalledTimes(1);
    expect(h.broadcast.mock.calls[0][0]).toEqual({
      type: "playlist_appended",
      playlistId: "pl-ws-a",
      peerId: "dlna:x",
      count: 1,
      matched: 3,
    });
  });

  it("现状:[批量匹配] 那种不带 opts 的调用不会广播(回执块在早返回之后)", async () => {
    // /v1/playlists/:id/match 走 runPlaylistAutoMatch(id) —— 只共用节流、不做服务端
    // 补齐(队列由调用方本机 diff 追加),因此也不会触发 playlist_appended 回执。
    // 这是有意为之,不是漏调;这里固定住以免将来误改。
    const r = await runPlaylistAutoMatch("pl-ws-d");
    expect(r.matched).toBe(3);
    expect(r.appended).toBe(0);
    expect(h.broadcast).not.toHaveBeenCalled();
  });

  it("没匹配到任何新曲目 → 不广播(避免前端白弹提示)", async () => {
    h.match.mockImplementation(finishingWith(okStats({ total: 4, matched: 0 })));
    await runPlaylistAutoMatch("pl-ws-b", { playerId: "p" });
    expect(h.broadcast).not.toHaveBeenCalled();
  });

  it("WS 不可用(广播抛错)→ 静默吞掉,补齐结果照常返回", async () => {
    h.broadcast.mockImplementation(() => {
      throw new Error("no ws");
    });
    const r = await runPlaylistAutoMatch("pl-ws-c", { playerId: "p", contentContext: "playlist:pl1" });
    expect(r.matched).toBe(3);
    expect(r.appended).toBe(1);
  });
});
