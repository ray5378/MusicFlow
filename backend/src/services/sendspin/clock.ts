import { hrtime } from "node:process";

/** 测试接缝:替换单调时钟实现(默认用 host monotonic)。
 *
 *  ⚠️ **vitest 假定时器下必须用它**:`vi.useFakeTimers()` 只接管 `Date`/`setTimeout`
 *  那几个,进程级 `process.hrtime` **照旧走真实时间**(2026-09-24 实测:假时间推进
 *  2000ms,hrtime 只走了 0.4ms;显式把 `hrtime` 加进 `toFake` 也无效)。
 *  而推流时间线既用 `Date.now()` 定 pace 锚点、又用 `nowUs()` 算「设备缓冲深度」
 *  (= cursorUs − nowUs())。两者不联动时,假时钟一跑,cursorUs 随实产样本飞涨而
 *  nowUs() 几乎不动 → 深度虚大 → 上报的**可听位置**(已推送 − 深度)恒被钳到 0,
 *  「位置是否推进」类断言全废。
 *  用例里应设 `setNowUsOverride(() => BigInt(Date.now()) * 1000n)`,用完置回 null。 */
let nowUsOverride: (() => bigint) | null = null;

/** 替换单调微秒时钟(null 恢复默认)。**仅测试用**。 */
export function setNowUsOverride(fn: (() => bigint) | null): void {
  nowUsOverride = fn;
}

/** 单调微秒时钟 (host monotonic, 不受 NTP 回拨影响) */
export const nowUs = (): bigint =>
  nowUsOverride ? nowUsOverride() : BigInt(hrtime.bigint() / 1000n);

export function buildServerTime(clientTransmitted: bigint) {
  return {
    type: "server/time",
    payload: {
      client_transmitted: clientTransmitted,
      server_received: nowUs(),
      server_transmitted: nowUs(),
    },
  };
}