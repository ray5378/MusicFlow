import { describe, it, expect } from "vitest";
import {
  PAUSE_STOP_SETTLE_MS,
  pauseStopSettleKey,
  markPauseStopIssued,
  withinPauseStopSettle,
} from "../../../src/services/player/pauseStopSettle.js";

// 背景(2026-09-30 真机):暂停满 30s 看门狗转 stop → QueueController idle_early 复查
// 探到「设备确实停了」→ 放行切歌。看门狗的 stop 被当成曲目播完 → 暂停后自己切下一首。
// 本模块 = 判据层:看门狗转 stop 打标,冷静期内的 IDLE 按「暂停超时停」解释,不放行。
// 完整链路与真机日志见 src/services/player/pauseStopSettle.ts 顶部。

describe("pauseStopSettle", () => {
  it("key 归一化:sendspin 组名 ug:<gid> 与 QC 侧 group:<gid> 必须归到同一个 key", () => {
    // 两侧不同前缀、同一台设备 → 若 key 不一致,标的与查的不是一条记录,判据永远不命中。
    expect(pauseStopSettleKey("ug:ab7fca6f")).toBe(pauseStopSettleKey("group:ab7fca6f"));
    expect(pauseStopSettleKey("ug:ab7fca6f")).toBe("ab7fca6f");
    // 单设备:playerCore 侧裸 clientId,QC 侧 sendspin: 前缀。
    expect(pauseStopSettleKey("C4:9E:7E:08:75:64")).toBe(pauseStopSettleKey("sendspin:C4:9E:7E:08:75:64"));
    // 其余前缀与 seekSettleKey 对齐;未知前缀不剥(避免吃掉裸 id 里本就有的冒号)。
    expect(pauseStopSettleKey("dlna:abc")).toBe("abc");
    expect(pauseStopSettleKey("airplay:x")).toBe("x");
    expect(pauseStopSettleKey("local:u:p")).toBe("u:p");
    expect(pauseStopSettleKey("weird:abc")).toBe("weird:abc");
    expect(pauseStopSettleKey("abc")).toBe("abc");
  });

  it("冷静期窗口:标记后 <PAUSE_STOP_SETTLE_MS 命中,到期即失效", () => {
    const id = "ug:t1";
    const at = 1_000_000;
    expect(withinPauseStopSettle(id, at)).toBe(false); // 从未标记
    markPauseStopIssued(id, at);
    expect(withinPauseStopSettle(id, at)).toBe(true);
    expect(withinPauseStopSettle(id, at + PAUSE_STOP_SETTLE_MS - 1)).toBe(true);
    expect(withinPauseStopSettle(id, at + PAUSE_STOP_SETTLE_MS)).toBe(false);
  });

  it("重复标记刷新窗口(第二次暂停重新起算)", () => {
    const id = "ug:t2";
    const t0 = 2_000_000;
    markPauseStopIssued(id, t0);
    expect(withinPauseStopSettle(id, t0 + PAUSE_STOP_SETTLE_MS - 1)).toBe(true);
    markPauseStopIssued(id, t0 + PAUSE_STOP_SETTLE_MS + 5_000); // 第一次已过期后再次转停
    expect(withinPauseStopSettle(id, t0 + PAUSE_STOP_SETTLE_MS + 5_000 + PAUSE_STOP_SETTLE_MS - 1)).toBe(true);
    expect(withinPauseStopSettle(id, t0 + PAUSE_STOP_SETTLE_MS + 5_000 + PAUSE_STOP_SETTLE_MS)).toBe(false);
  });

  it("单设备与组互不串扰(裸 id 各自独立)", () => {
    markPauseStopIssued("ug:g1", 3_000_000);
    expect(withinPauseStopSettle("group:g1", 3_000_001)).toBe(true);
    expect(withinPauseStopSettle("group:g2", 3_000_001)).toBe(false);
    expect(withinPauseStopSettle("sendspin:C4:9E:7E:08:75:64", 3_000_001)).toBe(false);
  });
});
