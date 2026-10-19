// MUST be the first import: redirects DATA_DIR to an isolated temp dir before
// the backend opens its SQLite DB at module-load time.
import "../plugins/_env.js";

import { describe, it, expect } from "vitest";
import {
  RECOMMEND_WARMER_INITIAL_MS,
  RECOMMEND_REFRESH_BACKOFF_BASE_MS,
  RECOMMEND_REFRESH_BACKOFF_MAX_MS,
  recommendRefreshBackoffMs,
} from "../../src/routes/api/recommend.js";

// 首页打开提速的两个回归护栏:
//   1) 聚合缓存预热器首轮延迟必须是「秒级」——原来是 TTL/2(≈150s)后才首次预热,
//      首页首开全靠请求路径冷拉;回归到旧值会让首开重新变慢。
//   2) 刷新失败退避必须是指数增长且封顶——固定 60s 会在上游短暂抖动时过度惩罚
//      (恢复后仍被退避锁死一分钟),而无限增长又会永久卡死。
// 只断言纯函数/常量,不建定时器、不读写 DB;模块加载期启动的预热定时器均已 unref,
// 不会阻止进程退出。

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
