// seek 冷静期单测:锁定「刚下发过 seek 的 peer,其 IDLE 不得被判成真结束」这条护栏。
//
// 背景(2026-09-21 真机实测):连续拖动 → 15 次 seek → sendspin 子进程 finishPlayback
// → 报 IDLE → tracker 判 idle_early → QueueController 复查探到非 PLAYING → 放行切歌
// → 位置归零(用户观感「拖动后进度条跳回去了」)。本模块就是拦住这一跳。
import { describe, it, expect, beforeEach } from "vitest";
import {
  SEEK_SETTLE_MS, seekSettleKey, markSeekIssued, lastSeekIssuedAt,
  withinSeekSettle, sinceSeekMs, clearSeekSettle, seekSettleSize,
} from "../../src/services/player/seekSettle.js";

const T0 = 1_700_000_000_000;

beforeEach(() => {
  for (const k of ["A", "AAA", "g1", "u1:c1"]) clearSeekSettle(k);
});

describe("seekSettleKey 前缀归一", () => {
  it("剥掉四种播放器前缀,与 QueueController.stripPlayerPrefix 同口径", () => {
    expect(seekSettleKey("dlna:AAA")).toBe("AAA");
    expect(seekSettleKey("group:g1")).toBe("g1");
    expect(seekSettleKey("airplay:AAA")).toBe("AAA");
    expect(seekSettleKey("sendspin:C4:9E:7E:08:75:64")).toBe("C4:9E:7E:08:75:64");
  });
  it("无前缀原样返回;local 复合 id 只剥第一段类型前缀", () => {
    expect(seekSettleKey("AAA")).toBe("AAA");
    expect(seekSettleKey("local:u1:c1")).toBe("u1:c1");
  });
  it("未知前缀不误剥(避免把裸 id 里的冒号吃掉)", () => {
    expect(seekSettleKey("weird:AAA")).toBe("weird:AAA");
  });
});

describe("冷静期判定", () => {
  it("打标后立即在冷静期内", () => {
    markSeekIssued("AAA", T0);
    expect(withinSeekSettle("AAA", T0)).toBe(true);
    expect(sinceSeekMs("AAA", T0)).toBe(0);
  });

  it("边界:距 seek 恰好 SEEK_SETTLE_MS 时已**出**冷静期(与 >= 口径一致)", () => {
    markSeekIssued("AAA", T0);
    expect(withinSeekSettle("AAA", T0 + SEEK_SETTLE_MS - 1)).toBe(true);
    expect(withinSeekSettle("AAA", T0 + SEEK_SETTLE_MS)).toBe(false);
    expect(withinSeekSettle("AAA", T0 + SEEK_SETTLE_MS + 1)).toBe(false);
  });

  it("未 seek 过 → 不在冷静期,sinceSeekMs 为 Infinity", () => {
    expect(withinSeekSettle("AAA", T0)).toBe(false);
    expect(lastSeekIssuedAt("AAA")).toBe(0);
    expect(sinceSeekMs("AAA", T0)).toBe(Number.POSITIVE_INFINITY);
  });

  it("带前缀打标、裸 id 查询(反之亦然)命中同一条记录", () => {
    markSeekIssued("sendspin:C4:9E:7E:08:75:64", T0);
    expect(withinSeekSettle("C4:9E:7E:08:75:64", T0 + 100)).toBe(true);
    // 换一条路径打标,原来那条仍能被查到
    markSeekIssued("C4:9E:7E:08:75:64", T0 + 500);
    expect(sinceSeekMs("sendspin:C4:9E:7E:08:75:64", T0 + 600)).toBe(100);
  });

  it("再次 seek 覆盖旧时刻(拖动的最后一跳决定冷静期起点)", () => {
    markSeekIssued("AAA", T0);
    markSeekIssued("AAA", T0 + 5_000);
    expect(withinSeekSettle("AAA", T0 + 5_000 + SEEK_SETTLE_MS - 1)).toBe(true);
    expect(withinSeekSettle("AAA", T0 + 5_000 + SEEK_SETTLE_MS)).toBe(false);
  });

  it("clearSeekSettle 生效(stop/play 会丢上下文,旧时刻不得压住新上下文的合法 idle_early)", () => {
    markSeekIssued("AAA", T0);
    expect(seekSettleSize()).toBeGreaterThan(0);
    clearSeekSettle("AAA");
    expect(withinSeekSettle("AAA", T0 + 1)).toBe(false);
  });

  it("不同 peer 互不干扰", () => {
    markSeekIssued("AAA", T0);
    expect(withinSeekSettle("g1", T0 + 1)).toBe(false);
  });
});
