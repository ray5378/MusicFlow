// membuf 主动回收(周期清扫)回归守卫(2026-10-08 审计补强)。
// 契约:
//   1. 消费过的条目(resolveMemStream 后,有 lastReadAt)空闲超过 IDLE_RECYCLE_MS(120s)即被回收
//      —— membuf 条目按设计不复用(每次新 stream 请求都重新整曲缓冲),滞留即死重;
//   2. 从未消费的条目按 TTL(10min)回收 —— 给 ffmpeg 留足起播窗口;
//   3. 消费后 120s 内不回收(覆盖 ffmpeg 同 token Range 重连间隔:秒级);
//   4. 清扫返回水位(removed/remaining/totalBytes)供运维观测。
// 时间轴统一注入(sweepMemStreams(now) / resolveMemStream(token, now)),不依赖真实时钟。
import { describe, it, expect, beforeEach } from "vitest";
import {
  registerMemStream,
  resolveMemStream,
  sweepMemStreams,
  resetMemStreamsForTest,
  MEM_STREAM_IDLE_RECYCLE_MS,
} from "../../src/services/source/bufferedFetch.js";

const MB = 1024 * 1024;
const T0 = 1_700_000_000_000;

beforeEach(() => {
  resetMemStreamsForTest();
});

describe("sweepMemStreams 主动回收", () => {
  it("消费过的条目:空闲 120s 内保留,超时回收", () => {
    const token = registerMemStream(Buffer.alloc(1 * MB));
    resolveMemStream(token, T0); // 消费 → lastReadAt=T0(此后不再消费)
    // T0+119s:空闲 119s < 120s → 保留(不 resolve,避免续期干扰断言)
    expect(sweepMemStreams(T0 + MEM_STREAM_IDLE_RECYCLE_MS - 1000).removed).toBe(0);
    // T0+121s:空闲超阈 → 回收
    const r = sweepMemStreams(T0 + MEM_STREAM_IDLE_RECYCLE_MS + 1000);
    expect(r.removed).toBe(1);
    expect(resolveMemStream(token, T0 + MEM_STREAM_IDLE_RECYCLE_MS + 1000)).toBeNull();
  });

  it("从未消费的条目:按 TTL 保留(TTL 内不回收)", () => {
    const token = registerMemStream(Buffer.alloc(1 * MB));
    expect(sweepMemStreams(T0 + 9 * 60_000).removed).toBe(0);
    expect(resolveMemStream(token, T0 + 9 * 60_000)).not.toBeNull();
  });

  it("混合场景:早停消费的死重被回收,在用条目保留,水位正确", () => {
    const dead = registerMemStream(Buffer.alloc(2 * MB));
    const alive = registerMemStream(Buffer.alloc(3 * MB));
    resolveMemStream(dead, T0); // dead 消费于 T0 后停止
    resolveMemStream(alive, T0);
    sweepMemStreams(T0 + 100_000);
    resolveMemStream(alive, T0 + 100_000); // alive 持续被读(Range 重连)
    const r = sweepMemStreams(T0 + MEM_STREAM_IDLE_RECYCLE_MS + 5000);
    expect(r.removed).toBe(1);
    expect(resolveMemStream(dead, T0 + MEM_STREAM_IDLE_RECYCLE_MS + 5000)).toBeNull();
    expect(resolveMemStream(alive, T0 + MEM_STREAM_IDLE_RECYCLE_MS + 5000)).not.toBeNull();
    expect(r.remaining).toBe(1);
    expect(r.totalBytes).toBe(3 * MB);
  });

  it("消费内连续读取(间隔<120s)不误删,最后一次消费 121s 后回收", () => {
    const token = registerMemStream(Buffer.alloc(1 * MB));
    // 模拟一次流请求的连续 Range 读取:每 30s 一次 GET,共 5 次 = 2.5min
    let t = T0;
    for (let i = 0; i < 5; i++) {
      t += 30_000;
      expect(sweepMemStreams(t).removed).toBe(0);
      expect(resolveMemStream(token, t)).not.toBeNull();
    }
    const r = sweepMemStreams(t + MEM_STREAM_IDLE_RECYCLE_MS + 1000);
    expect(r.removed).toBe(1);
    expect(resolveMemStream(token, t + MEM_STREAM_IDLE_RECYCLE_MS + 1000)).toBeNull();
  });
});
