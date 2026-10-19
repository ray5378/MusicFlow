// MUST be the first import: redirects DATA_DIR to an isolated temp dir before
// the backend opens its SQLite DB at module-load time.
import "../plugins/_env.js";

import { describe, it, expect, vi } from "vitest";
import {
  RECOMMEND_WARMER_INITIAL_MS,
  RECOMMEND_REFRESH_BACKOFF_BASE_MS,
  RECOMMEND_REFRESH_BACKOFF_MAX_MS,
  recommendRefreshBackoffMs,
  startRecommendCacheWarmer,
} from "../../src/routes/api/recommend.js";
import { RECOMMEND_CACHE_TTL_MS } from "../../src/routes/api/shared.js";

// 首页打开提速的两个回归护栏:
//   1) 聚合缓存预热器首轮延迟必须是「秒级」——原来是 TTL/2(≈150s)后才首次预热,
//      首页首开全靠请求路径冷拉;回归到旧值会让首开重新变慢。
//   2) 刷新失败退避必须是指数增长且封顶——固定 60s 会在上游短暂抖动时过度惩罚
//      (恢复后仍被退避锁死一分钟),而无限增长又会永久卡死。
// 只断言纯函数/常量与「递归调度的时间参数」,不真跑定时器、不读写 DB;
// 模块加载期启动的预热定时器均已 unref,不会阻止进程退出。

describe("recommendRefreshBackoffMs 指数退避", () => {
  it("按连续失败次数翻倍增长,并在上限封顶", () => {
    expect(recommendRefreshBackoffMs(1)).toBe(3000);
    expect(recommendRefreshBackoffMs(2)).toBe(6000);
    expect(recommendRefreshBackoffMs(3)).toBe(12000);
    expect(recommendRefreshBackoffMs(4)).toBe(24000);
    expect(recommendRefreshBackoffMs(5)).toBe(48000);
    // 2^5 * 3000 = 96000 > 60000,封顶
    expect(recommendRefreshBackoffMs(6)).toBe(60000);
    expect(recommendRefreshBackoffMs(7)).toBe(60000);
    expect(recommendRefreshBackoffMs(100)).toBe(60000);
  });

  it("失败次数 <= 0 视为首轮:返回有限值 3000,绝不出现 NaN/Infinity", () => {
    expect(recommendRefreshBackoffMs(0)).toBe(3000);
    expect(Number.isFinite(recommendRefreshBackoffMs(0))).toBe(true);
    expect(recommendRefreshBackoffMs(-1)).toBe(3000);
  });
});

describe("预热器首轮延迟常量", () => {
  it("RECOMMEND_WARMER_INITIAL_MS 为秒级有限值(不得回退到旧的 ~150000)", () => {
    expect(Number.isFinite(RECOMMEND_WARMER_INITIAL_MS)).toBe(true);
    expect(RECOMMEND_WARMER_INITIAL_MS).toBeGreaterThanOrEqual(1000);
    expect(RECOMMEND_WARMER_INITIAL_MS).toBeLessThanOrEqual(10000);
  });

  it("退避基准必须小于上限(否则退避无增长空间)", () => {
    expect(RECOMMEND_REFRESH_BACKOFF_BASE_MS).toBeLessThan(RECOMMEND_REFRESH_BACKOFF_MAX_MS);
  });
});

// 行为级单测:拦截 setTimeout,直接读「调度参数」,验证递归预热的时序契约 ——
// 首轮 4s、之后 re-arm 为 TTL/2、且重复调用幂等。这样即使第一次 tick 的业务体
// 因插件/DB 缺失而抛错(被 try/catch 吞掉),finally 的 re-arm 仍会被断言到,
// 保证「异常不断链」这条设计不回归。
describe("startRecommendCacheWarmer 递归调度时序", () => {
  it("首轮 RECOMMEND_WARMER_INITIAL_MS,re-arm 恒为 TTL/2,且幂等", () => {
    const calls: Array<{ fn: () => void; ms: number | undefined }> = [];
    const spy = vi.spyOn(globalThis, "setTimeout").mockImplementation(((
      fn: () => void,
      ms?: number,
    ) => {
      calls.push({ fn, ms });
      // 形如 Node Timeout 的最小替身:预热器只用到 unref()。
      return { unref() {} } as any;
    }) as any);

    try {
      startRecommendCacheWarmer();
      // 幂等:已有定时器时重复 start 不重复挂表(否则每次调用都会叠加一个预热器)。
      startRecommendCacheWarmer();
      expect(calls.length).toBe(1);
      // 首轮必须是「秒级」初始延迟,而不是旧实现的 TTL/2(≈150s)。
      expect(calls[0].ms).toBe(RECOMMEND_WARMER_INITIAL_MS);
      expect(calls[0].ms).toBeLessThan(RECOMMEND_CACHE_TTL_MS / 2);

      // 触发首轮 tick:finally 里必须 re-arm,且间隔恰为 TTL/2。
      calls[0].fn();
      expect(calls.length).toBe(2);
      expect(calls[1].ms).toBe(RECOMMEND_CACHE_TTL_MS / 2);

      // 再触发一轮:递归稳定,仍是 TTL/2(证明不是「只 re-arm 一次」)。
      calls[1].fn();
      expect(calls.length).toBe(3);
      expect(calls[2].ms).toBe(RECOMMEND_CACHE_TTL_MS / 2);
    } finally {
      spy.mockRestore();
    }
  });
});
