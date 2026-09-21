// 锁死对象:`services/dlna/seekGuard.ts` —— 「拖动进度条后进度又跳回原位」的
// 服务端唯一防线。判定逻辑抽成纯函数就是为了这里能用最小用例钉死。
//
// 为什么必须有这组测试:这段判定的失效形态是**偶发跳回**(取决于设备何时才把
// 新位置报上来),手测极难复现、极容易"看起来是对的"就放过。CI 用固定时间轴
// 直接把"陈旧读数必须被丢掉 / 落位读数必须被采纳 / 过期必须解除"三条钉住。
import { describe, it, expect } from "vitest";
import {
  SEEK_GUARD_MS,
  SEEK_SETTLE_TOLERANCE_SEC,
  seekGuardExpired,
  seekExpectedPosition,
  isSeekReadingStale,
} from "../../src/services/dlna/seekGuard.js";

const T0 = 1_000_000; // 任意基准时刻
const guard = (target: number, at = T0) => ({ target, at });

describe("seekGuard:保护窗过期", () => {
  it("窗内未过期", () => {
    expect(seekGuardExpired(guard(100), T0 + SEEK_GUARD_MS - 1)).toBe(false);
  });

  it("恰好到窗长即过期(边界与 ha 集成 seek_guard_active 同语义)", () => {
    expect(seekGuardExpired(guard(100), T0 + SEEK_GUARD_MS)).toBe(true);
  });

  it("远超窗长必然过期", () => {
    expect(seekGuardExpired(guard(100), T0 + SEEK_GUARD_MS * 10)).toBe(true);
  });
});

describe("seekGuard:预期位置", () => {
  it("播放态按墙钟外推", () => {
    expect(seekExpectedPosition(guard(100), T0 + 5000, true)).toBeCloseTo(105, 3);
  });

  it("非播放态停在目标不动(暂停中拖动只有这一个正确读数)", () => {
    expect(seekExpectedPosition(guard(100), T0 + 5000, false)).toBe(100);
  });

  it("采样时刻早于下发时刻时不倒扣(时钟回拨/乱序调用也不该出现负前进)", () => {
    expect(seekExpectedPosition(guard(100), T0 - 5000, true)).toBe(100);
  });
});

describe("seekGuard:陈旧读数判定(核心回归)", () => {
  it("设备不报位置(<=0)不判陈旧 —— 交给外推,不能在这里拦掉", () => {
    expect(isSeekReadingStale(guard(300), T0, 0, true)).toBe(false);
    expect(isSeekReadingStale(guard(300), T0, -1, true)).toBe(false);
  });

  it("向前拖:设备仍报 seek 前的旧位置 → 判陈旧(这就是「跳回」的现场)", () => {
    // 目标 300s,设备还在 120s(DLNA Seek 尚未生效)
    expect(isSeekReadingStale(guard(300), T0 + 1000, 120, true)).toBe(true);
  });

  it("向前拖:设备已落位(目标 + 已过时间)→ 采纳", () => {
    expect(isSeekReadingStale(guard(300), T0 + 3000, 303, true)).toBe(false);
  });

  it("向前拖:设备落位但差一点点(容差内)→ 采纳", () => {
    const reported = 300 + 3 - (SEEK_SETTLE_TOLERANCE_SEC - 0.1);
    expect(isSeekReadingStale(guard(300), T0 + 3000, reported, true)).toBe(false);
  });

  it("向后拖:设备仍报 seek 前的大位置 → 也必须判陈旧(单向实现会在这里漏掉)", () => {
    // 从 200s 往回拖到 30s,设备仍报 200s
    expect(isSeekReadingStale(guard(30), T0 + 1000, 200, true)).toBe(true);
  });

  it("向后拖:设备已落位 → 采纳", () => {
    expect(isSeekReadingStale(guard(30), T0 + 2000, 32, true)).toBe(false);
  });

  it("暂停态拖动:读数等于目标即采纳(不因缺少前进量被误判陈旧)", () => {
    expect(isSeekReadingStale(guard(120), T0 + 4000, 120, false)).toBe(false);
  });

  it("暂停态拖动:读数仍是旧位置 → 判陈旧", () => {
    expect(isSeekReadingStale(guard(120), T0 + 4000, 40, false)).toBe(true);
  });
});
