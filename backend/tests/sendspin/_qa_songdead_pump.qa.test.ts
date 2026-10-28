// ==================== QA 独立反证：onUnplayable 失联路径（严过关） ====================
//
// 实现者声称「泵在组内 WeakMap 复用、rehost/移交搬同一对象、seek 重建沿用初始那个」。
// 本文件专门找**反例**：只要泵对象被换成新的，回传口就是 null —— 而 pumpFor 的
// 「不传 = 不动已有的」语义只在**同一个泵**上成立。
import { describe, it, expect, vi } from "vitest";

// 插件配置在单测里读不到（与 songUnplayableSink.test.ts 同款兜底）。
vi.mock("../../src/services/sendspin/index.js", () => ({
  readSendspinPluginConfig: () => {
    throw new Error("no plugin config in unit test");
  },
}));

import { pumpFor, peekPump, stopGroupPump } from "../../src/services/sendspin/streamEngine.js";

const srv = () => ({ log: () => {} }) as any;

describe("QA② onUnplayable 装填语义：找「回传口丢了」的路径", () => {
  it("同一泵内：不传 = 沿用既有回传口（seek 重建路径依赖它）", () => {
    const g: any = { name: "qa-g-same" };
    const sink = vi.fn();
    const p1 = pumpFor(srv(), g, sink);
    expect(p1.onUnplayable).toBe(sink);
    // 模拟 seekCore → playCore（不传 onUnplayable）
    const p2 = pumpFor(srv(), g);
    expect(p2).toBe(p1);
    expect(p2.onUnplayable).toBe(sink);
    stopGroupPump(g);
  });

  it("★ 反例：泵被摘除（stopGroupPump）后重建 ⇒ 新泵**不继承**旧回传口", () => {
    const g: any = { name: "qa-g-new" };
    const sink = vi.fn();
    const p1 = pumpFor(srv(), g, sink);
    stopGroupPump(g); // 组空/断开清理：WeakMap 键被删
    const p2 = pumpFor(srv(), g); // 模拟**任何**未装填就取泵的路径
    expect(p2).not.toBe(p1);
    // 🔴 失联证据：新泵 onUnplayable 恒为 null。凡是「先取泵、后起播」的顺序
    //    （而不是 playCore 里「取泵即装填」），判死都不会回传主进程。
    expect(p2.onUnplayable).toBeNull();
    stopGroupPump(g);
  });

  it("★ 反例：先 pumpFor（无 sink）建泵，再 playCore 传 sink ⇒ 仍可补装（当前实现安全）", () => {
    const g: any = { name: "qa-g-late" };
    const p0 = pumpFor(srv(), g); // 建泵，无 sink
    expect(p0.onUnplayable).toBeNull();
    const sink = vi.fn();
    const p1 = pumpFor(srv(), g, sink); // playCore 起播时装填
    expect(p1).toBe(p0);
    expect(p1.onUnplayable).toBe(sink);
    stopGroupPump(g);
  });

  it("peekPump 不建泵（移交判定不能凭空造泵）；不存在的组读到 undefined", () => {
    const g: any = { name: "qa-g-peek" };
    expect(peekPump(g)).toBeUndefined();
    const p = pumpFor(srv(), g);
    expect(peekPump(g)).toBe(p);
    stopGroupPump(g);
  });
});
