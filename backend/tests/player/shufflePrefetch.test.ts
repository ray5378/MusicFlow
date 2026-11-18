// shuffle 预取错歌的回归锁（2026-11-18）
//
// 背景：`prefetchUpcoming` 直接读 QueueData 的 shuffleOrder/shufflePos，而洗牌序列
// 只在**真切歌**（shuffleNextIndex → ensureShuffleReady）时才惰性重建。队列增删后
// 到下一次切歌之间，预取按**过期序列**取位置 ⇒ 灌进 membuf 的是一首根本不会被播
// 的歌。240 现场：实际播 9b7c115f（潇洒走一回），预取却在 14:36:59 灌 efb30357
// （LOLA MONTEZ），切歌时真正的下一首零准备，桥侧补 2134ms 静音。
//
// 修法两层：
//   ① `peekUpcomingPositions` 的 shuffle 分支校验 `shuffleLen`，过期即放弃
//      （宁可少预取，绝不预取错歌 —— 与 QueueController.peekNext 同一口径）；
//   ② `QueueController.schedulePrefetch` 先 `ensureShuffleForLookahead` 让序列就绪。
// 本文件锁 ①的全部模式行为 + ②的调用顺序。
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { peekUpcomingPositions, type QueuePeekSource } from "../../src/services/player/preProbeScheduler.js";

const N = 6;
const items = Array.from({ length: N }, (_, i) => ({ songId: `s${i}`, duration: 200 }));

/** 构造 peek 源：默认 shuffle、序列 [2,4,0,5,1,3]、当前停在下标 2（pos=0）。 */
function mk(over: Partial<QueuePeekSource> = {}): QueuePeekSource {
  return {
    items,
    currentIndex: 2,
    playMode: "shuffle",
    shuffleOrder: [2, 4, 0, 5, 1, 3],
    shufflePos: 0,
    shuffleLen: N,
    ...over,
  };
}

describe("shuffle 序列一致性（预取错歌根因）", () => {
  it("序列与队列一致 ⇒ 按 order 取后续位置", () => {
    // pos=0 指向当前曲(2)，往后是 4、0
    expect(peekUpcomingPositions(mk(), 2).positions).toEqual([4, 0]);
  });

  it("shuffleLen 与 items.length 不等（队列增删后未重建）⇒ 放弃预测", () => {
    const r = peekUpcomingPositions(mk({ shuffleLen: N - 1 }), 2);
    expect(r.positions).toEqual([]);
    expect(r.reachedEnd).toBe(true);
  });

  it("无 shuffleLen 时退化为 order.length 判断：长度不符同样放弃", () => {
    const r = peekUpcomingPositions(
      mk({ shuffleLen: undefined, shuffleOrder: [2, 4, 0, 5] }),
      2,
    );
    expect(r.positions).toEqual([]);
  });

  it("无 shuffleLen 且 order 长度正确 ⇒ 照旧可用（老快照/测试替身兼容）", () => {
    const r = peekUpcomingPositions(mk({ shuffleLen: undefined }), 2);
    expect(r.positions).toEqual([4, 0]);
  });

  it("序列为空 ⇒ 放弃预测（不是从 0 开始猜）", () => {
    const r = peekUpcomingPositions(mk({ shuffleOrder: [], shuffleLen: 0 }), 2);
    expect(r.positions).toEqual([]);
  });

  it("走到序列末尾 ⇒ 空 + reachedEnd（绝不在这里重洗）", () => {
    const r = peekUpcomingPositions(mk({ shufflePos: 5 }), 2);
    expect(r.positions).toEqual([]);
    expect(r.reachedEnd).toBe(true);
    // 只读红线：入参一个字段都不能被改
    const src = mk({ shufflePos: 5 });
    peekUpcomingPositions(src, 2);
    expect(src.shufflePos).toBe(5);
    expect(src.shuffleOrder).toEqual([2, 4, 0, 5, 1, 3]);
  });
});

describe("其他 playMode 的预取链路不变", () => {
  it("order：沿下标前进，到末尾停", () => {
    expect(peekUpcomingPositions(mk({ playMode: "order", currentIndex: 2 }), 10).positions).toEqual([3, 4, 5]);
    const atEnd = peekUpcomingPositions(mk({ playMode: "order", currentIndex: 5 }), 10);
    expect(atEnd.positions).toEqual([]);
    expect(atEnd.reachedEnd).toBe(true);
  });

  it("all：回绕且一轮内不重复（最多 n-1 个）", () => {
    const r = peekUpcomingPositions(mk({ playMode: "all", currentIndex: 4 }), 10);
    expect(r.positions).toEqual([5, 0, 1, 2, 3]);
    expect(r.positions).not.toContain(4);
    expect(r.reachedEnd).toBe(true);
  });

  it("one：只回当前曲（供预探测判可播性；预取由缓存闸门拦下）", () => {
    const r = peekUpcomingPositions(mk({ playMode: "one" }), 3);
    expect(r.positions).toEqual([2]);
    expect(r.reachedEnd).toBe(true);
  });

  it("空队列 / currentIndex<0 ⇒ 空且 reachedEnd", () => {
    expect(peekUpcomingPositions(mk({ items: [] }), 2).positions).toEqual([]);
    expect(peekUpcomingPositions(mk({ currentIndex: -1 }), 2).positions).toEqual([]);
  });
});

describe("one 模式不预取（与 peekNext 的 one ⇒ -1 同口径）", () => {
  it("prefetchUpcoming 在 one 下直接短路，不占串行通道", async () => {
    const { prefetchUpcoming, prefetchStats, resetPrefetchForTest } = await import(
      "../../src/services/source/prefetchCache.js"
    );
    resetPrefetchForTest();
    const before = prefetchStats();
    prefetchUpcoming(mk({ playMode: "one" }), 1);
    const after = prefetchStats();
    expect(after.queued).toBe(before.queued);
    expect(after.inflight).toBe(before.inflight);
    expect(after.running).toBe(before.running);
  });
});

describe("QueueController.schedulePrefetch 顺序锁", () => {
  const src = fs.readFileSync(
    path.join(fileURLToPath(new URL("../../src/services/player", import.meta.url)), "QueueController.ts"),
    "utf8",
  );

  it("先 ensureShuffleForLookahead，再 prefetchUpcoming", () => {
    const seg = src.slice(
      src.indexOf("private schedulePrefetch("),
      src.indexOf("private schedulePrefetch(") + 1200,
    );
    const ensureAt = seg.indexOf("ensureShuffleForLookahead(q)");
    const prefetchAt = seg.indexOf("prefetchUpcoming(q)");
    expect(ensureAt).toBeGreaterThanOrEqual(0);
    expect(prefetchAt).toBeGreaterThan(ensureAt);
  });
});
