// stream.ts 覆盖率补口:SendspinStreamSession 的**时间线单源**接口。
//
// 缺口背景:session 只暴露一个 `nowUs()`,它把时间戳推进的时钟**收敛到唯一的
// `timeline` 字段** —— 这样测试/嵌入式可以整体换掉时钟,而不用打补丁改各处调用点。
// 既有测试全都自带 timeline,默认实现(defaultMonotonicUs)与转发方法从未被执行。
//
// 守住的产品契约:
//   1) nowUs() 必须**逐次**转发到 timeline.monotonicUs()(不是缓存首值 —— 缓存会让
//      时间戳在长时间会话里冻结);
//   2) 默认 timeline 必须单调不减且量级为「进程启动起的微秒」,否则锚点会算到远古。
import "../plugins/_env.js";

import { describe, it, expect } from "vitest";
import { SendspinStreamSession } from "../../src/services/sendspin/stream.js";

describe("SendspinStreamSession 时间线单源", () => {
  it("nowUs() 逐次转发到自定义 timeline(不缓存,可被驱动前进)", () => {
    const s = new SendspinStreamSession();
    let t = 1_000n;
    s.timeline = { monotonicUs: () => t };
    expect(s.nowUs()).toBe(1_000n);
    t = 2_500n;
    // 契约:第二次调用必须看到新值 —— 若实现缓存了首值,时间线会永久冻结。
    expect(s.nowUs()).toBe(2_500n);
  });

  it("默认时钟:单调不减,量级为进程内单调微秒(不足以卡死锚点)", () => {
    const s = new SendspinStreamSession();
    const a = s.nowUs();
    const b = s.nowUs();
    expect(typeof a).toBe("bigint");
    expect(b >= a).toBe(true);
    // 契约:默认实现是 hrtime 派生的**单调**微秒,不得为 0/负数(0 会让首帧锚点算到过去)。
    expect(a > 0n).toBe(true);
  });
});
