/** 统一 host 单调时钟(AirPlay 桥接 Phase 1)。
 *
 *  单一出处:发送侧(sendspin 泵的 tsUs)与 RAOP(NTP)必须同源可比 —— 同一宿主机上
 *  `process.hrtime.bigint()` 跨进程同源(Linux CLOCK_MONOTONIC / Windows QPC)。
 *  `sendspin/clock.ts` 现在从这里 re-export;`airplay/raop.ts` 的 `ntpNow()` 用
 *  `ntpFromHostUs(nowUs())`。
 *
 *  ⚠️ 禁止在锚点链路使用 `Date.now()` / Unix ms / `performance.now()` —— 它们只允许
 *  用于日志耗时与 UI 时间戳。
 *
 *  ⚠️ vitest 假定时器下必须用 `setNowUsOverride`:`vi.useFakeTimers()` 只接管
 *  `Date`/`setTimeout` 那几个,进程级 `process.hrtime` 照旧走真实时间(2026-09-24
 *  实测:假时间推进 2000ms,hrtime 只走了 0.4ms)。用例里设
 *  `setNowUsOverride(() => BigInt(Date.now()) * 1000n)`,用完置回 null。 */
import { hrtime } from "node:process";

let nowUsOverride: (() => bigint) | null = null;

/** 替换单调微秒时钟(null 恢复默认)。**仅测试用**。 */
export function setNowUsOverride(fn: (() => bigint) | null): void {
  nowUsOverride = fn;
}

/** 单调微秒时钟(host monotonic,不受 NTP 回拨影响)。 */
export const nowUs = (): bigint =>
  nowUsOverride ? nowUsOverride() : BigInt(hrtime.bigint() / 1000n);

/** host-monotonic µs → 32.32 定点 NTP。
 *  纪元 = 机器开机时长(任意且单调),对端只消费差值 —— RAOP 接收端通过
 *  timing/SYNC 自行学习 (ntp ↔ rtp) 映射,纪元无关。
 *  ⚠️ 纪元可达 27h+(44.1k 下 2^32/rate),转 RTP 时必须显式 `>>> 0` 截断
 *  (见 airplay/bridgeMath.ts 的 ntpToRtpMod 与 raop.ts RECORD 处 MAJ-10)。 */
export function ntpFromHostUs(us: bigint): bigint {
  const sec = us / 1_000_000n;
  const rem = us % 1_000_000n;
  const frac = (rem << 32n) / 1_000_000n;
  return (sec << 32n) | frac;
}

/** 32.32 NTP → host µs(ntpFromHostUs 的逆,截断误差 ≤1µs;测试/对齐推导用)。 */
export function ntpToHostUs(ntp: bigint): bigint {
  const sec = ntp >> 32n;
  const frac = ntp & 0xffffffffn;
  return sec * 1_000_000n + (frac * 1_000_000n >> 32n);
}
