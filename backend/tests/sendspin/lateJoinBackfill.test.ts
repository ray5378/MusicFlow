// ==================== late-join 回填:播中加入的成员立即出声 ====================
//
// 背景(2026-09-24 真机):播放中把 Sendspin 播放器加入群组,新成员要等**一整个预填充
// 水位**(30s 档实测 ≈29s)才出声 —— 「加入新设备要很久才发出声音」。
//
// 根因不是代码写错,而是**只给新成员发未来帧**:组时间线游标领先墙钟一个水位深度
// (预填充把设备缓冲灌深 = 抗抖动余量),新成员收到的首帧时间戳在 30s 之后,只能干等。
//
// 参考实现(MA 的同步内核 aiosendspin `server/push_stream.py`)的做法:
//   - 组内保留**尚未播到**的音频缓存(`_pcm_chunk_cache` / `_role_chunk_cache`,
//     按 `ts + duration <= now` 逐出);
//   - 新角色 `on_role_join` 时把「起点 ≥ late-join 目标时刻」的缓存 chunk **立即回放**
//     (`_send_cached_chunks_to_role`),之后无缝接上实时流;
//   - 目标时刻用 `now + lead`(MA `LATE_JOINER_MIN_LEAD_US = 100_000`)。
//
// 本仓等价实现 = `SendspinGroup.seedLateJoin`。本文件锁死其语义:
//   ① 有缓存 → 立刻回填「还没播到」的音频,首帧**不在过去**、且**很快**出声;
//   ② 缓存里只剩已播过的 → 不回填(宁可退回等未来帧,也不塞过期音频);
//   ③ 设备报 available:false → 不回填(音频必须跟在 stream/start 之后);
//   ④ 回填量受设备容量钳制(不把设备一次灌满 → 逐帧拒收);
//   ⑤ 成员数增加不影响每批时间线推进量(同 codec+gain 共享一个编码器)。
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { SendspinGroup } from "../../src/services/sendspin/server.js";
import { setNowUsOverride } from "../../src/services/sendspin/clock.js";
import { SAMPLE_RATE } from "../../src/services/sendspin/encoding.js";
import { PREFILL_BUFFER_MAX_MS } from "../../src/services/sendspin/constants.js";

const MS = 1000n;
/** 帧长:4096 单声道样本 = 85.33ms(libFLAC 默认块大小,真机同款)。 */
const FRAME_SAMPLES = 4096;
const FRAME_US = BigInt(Math.round((FRAME_SAMPLES * 1_000_000) / SAMPLE_RATE));
/** 设备默认 send_ahead(未协商时 ESPHome 侧默认 800ms,见 group.ts DEFAULT_MIN_BUFFER_MS)。 */
const SEND_AHEAD_US = 800_000n;

let fakeNow = 1_000_000_000n;
beforeEach(() => {
  fakeNow = 1_000_000_000n;
  setNowUsOverride(() => fakeNow);
});
afterEach(() => setNowUsOverride(null));

/** 定量编码器桩:每批产出一帧(真机 FLAC 攒满一块即吐,这里简化为恒产出)。 */
class FixedEncoder {
  calls = 0;
  constructor(private readonly samples = FRAME_SAMPLES, private readonly bytes = 400) {}
  async encode(): Promise<any[]> {
    this.calls++;
    return [{ frameSamples: this.samples, data: new Uint8Array(this.bytes) }];
  }
  async flush(): Promise<any[]> {
    return [];
  }
  close(): void {}
}

/** 最小成员桩:补齐 pushFrame / seedLateJoin 真正会碰的成员面。 */
function conn(clientId: string, codec = "flac", opts: { wants?: boolean; capacity?: number } = {}): any {
  const sent: { ts: bigint; len: number }[] = [];
  return {
    clientId,
    codec,
    sent,
    appliedGain: () => 100,
    bufferCapacityBytes: opts.capacity ?? 0,
    clientWantsStream: () => opts.wants !== false,
    announceStream: () => {},
    sendAudio: (ts: bigint, data: Uint8Array) => sent.push({ ts, len: data.length }),
  };
}

function groupWith(encoders: Record<string, FixedEncoder> = { "flac:100": new FixedEncoder() }): SendspinGroup {
  const g = new SendspinGroup("ug:g1", { log() {} } as any);
  for (const [key, enc] of Object.entries(encoders)) (g as any).encoders.set(key, enc);
  return g;
}

const PCM = (n = 1200) => new Float32Array(n);

/** 模拟「预填充后的时间线」:锚点 = 墙钟 + send_ahead,随后每帧推进 FRAME_US。 */
async function fill(g: SendspinGroup, frames: number): Promise<bigint> {
  let ts = fakeNow + SEND_AHEAD_US; // = streamEngine 的锚点公式(首帧即在此)
  for (let i = 0; i < frames; i++) {
    await g.pushFrame(ts, PCM());
    ts += FRAME_US;
  }
  return ts; // 组游标(下一帧的起点)
}

describe("late-join 回填:立即出声,不再空等一个预填充水位", () => {
  it("★ 播中加入者立刻拿到「还没播到」的音频,首帧不在过去且约 0.1s 内出声", async () => {
    const g = groupWith();
    const a = conn("A");
    g.add(a);
    const cursorEnd = await fill(g, 350); // ≈29.9s 深 —— 正是新成员要等的量

    const b = conn("B");
    g.add(b);
    const n = g.seedLateJoin(b);

    expect(n).toBeGreaterThan(0);
    expect(b.sent.length).toBeGreaterThan(0);

    const first = b.sent[0].ts;
    // ① 首帧**不是**组游标:旧行为下新成员只从游标之后收帧 → 要等 ~29.9s
    expect(first).toBeLessThan(cursorEnd);
    // ② 必须「还没过期」:设备按 `ts − send_ahead` 决定何时播 ⇒ 播放时刻 ≥ now
    //    (否则设备收到即吐字节 → 缓冲空 → 一进来就 underrun)
    expect(Number(first) - Number(SEND_AHEAD_US)).toBeGreaterThanOrEqual(Number(fakeNow));
    // ③ 而且要**很快**出声(≈100ms 级),不是再等一个水位
    const delayUs = Number(first) - Number(SEND_AHEAD_US) - Number(fakeNow);
    expect(delayUs).toBeLessThanOrEqual(200_000);
    // ④ 补齐了「它本该已经收到的整段」:一直回填到组游标附近
    expect(Number(cursorEnd) - Number(first)).toBeGreaterThan(25_000_000);
  });

  it("回填截止于组游标:不会凭空生成游标之外的音频", async () => {
    const g = groupWith();
    g.add(conn("A"));
    const cursorEnd = await fill(g, 40);

    const b = conn("B");
    g.add(b);
    g.seedLateJoin(b);

    const last = b.sent[b.sent.length - 1].ts;
    expect(last).toBeLessThan(cursorEnd);
    expect(Number(cursorEnd) - Number(last)).toBeLessThanOrEqual(Number(FRAME_US));
  });

  it("刚起播(水位还没立起来)⇒ 不回填,退回等未来帧", async () => {
    const g = groupWith();
    g.add(conn("A"));
    await fill(g, 1); // 只有一帧,墙钟还在它之前 → 缓存里没有「未来」可补

    const b = conn("B");
    g.add(b);
    expect(g.seedLateJoin(b)).toBe(0);
    expect(b.sent.length).toBe(0);
  });
});

describe("late-join 回填的边界", () => {
  it("缓存里只剩已播过的音频 ⇒ 不回填(不塞过期音频)", async () => {
    const g = groupWith();
    g.add(conn("A"));
    await fill(g, 1);

    // 墙钟跳到该帧早已播完之后(超出 KEEP_PAST = 1s 的保留尾巴)
    fakeNow += 5_000n * MS;
    await g.pushFrame(fakeNow - 3_000n * MS, PCM()); // 再推一帧 → 触发逐出

    const b = conn("B");
    g.add(b);
    expect(g.seedLateJoin(b)).toBe(0);
    expect(b.sent.length).toBe(0);
  });

  it("设备报 available:false ⇒ 不回填(音频必须跟在 stream/start 之后)", async () => {
    const g = groupWith();
    g.add(conn("A"));
    await fill(g, 40);

    const b = conn("B", "flac", { wants: false });
    g.add(b);
    expect(g.seedLateJoin(b)).toBe(0);
    expect(b.sent.length).toBe(0);
  });

  it("回填量受设备容量钳制(不把设备一次灌满 → 逐帧拒收)", async () => {
    const g = groupWith();
    // 成员宣告 200KB 容量:实测码率 = 400B / (4096/48000 s) ≈ 4687 B/s
    //   ⇒ 可用时长 = 0.6 × 200000 / 4687 ≈ 25.6s(小于环里约 29.9s)
    g.add(conn("A", "flac", { capacity: 200_000 }));
    await fill(g, 350);

    expect(g.capacityLimitedPrefillMs()).toBeLessThan(PREFILL_BUFFER_MAX_MS);

    const b = conn("B");
    g.add(b);
    const n = g.seedLateJoin(b);
    const spanMs = (n * Number(FRAME_US)) / 1000;

    expect(n).toBeLessThan(350); // 没有把整环都灌过去
    expect(spanMs).toBeLessThanOrEqual(g.capacityLimitedPrefillMs() + 100); // ≈ 容量上界(一帧容差)
  });

  it("不同 gain 的成员各有缓存:回填只取自己所属编码组的字节", async () => {
    const g = groupWith({ "flac:100": new FixedEncoder(FRAME_SAMPLES, 400), "flac:40": new FixedEncoder(FRAME_SAMPLES, 900) });
    g.add(conn("A", "flac", { capacity: 0 }));
    const aLow = { ...conn("L", "flac"), appliedGain: () => 40 };
    g.add(aLow);
    await fill(g, 40);

    const b = conn("B");
    g.add(b);
    g.seedLateJoin(b);
    // B 是 gain=100 → 必须拿到 400B 的 chunk,而不是 gain=40 的 900B
    expect(b.sent.length).toBeGreaterThan(0);
    expect(b.sent.every((s: any) => s.len === 400)).toBe(true);
  });
});

describe("成员变更不改变时间线推进量", () => {
  it("★ 播中加入同 codec+gain 成员后,每批推进量不变、同批时间戳一致", async () => {
    const g = groupWith();
    const a = conn("A");
    g.add(a);
    const ts0 = fakeNow + SEND_AHEAD_US;
    const alone = await g.pushFrame(ts0, PCM());
    const afterA = a.sent[a.sent.length - 1].ts;

    // 播中加入:同 codec+gain ⇒ **共享同一个编码器**(不再各建一个 ⇒ 没有块相位错开)
    const b = conn("B");
    g.add(b);
    g.seedLateJoin(b);
    const withPeer = await g.pushFrame(ts0 + FRAME_US, PCM());

    expect(withPeer).toBe(alone); // 推进量不因成员数翻倍(旧实现:并集多算 ≈2×)
    expect(b.sent[b.sent.length - 1].ts).toBe(afterA + FRAME_US); // 同批时间戳一致
  });
});
