// ==================== Phase 3 组泵出声:BLK-01 虚拟 pcm:100 组 + 桥投递 + 码率口径 ====================
//
// 机械判据钉死(§2.1/§6.2):
//   ① BLK-01 正向:members=∅ + bridges>0 ⇒ pushFrame 返回 >0(虚拟组让编码与
//      「是否存在真实 pcm 成员」完全解耦,否则上游判零产出 → maxSilentDegrade 提前切歌);
//   ② 全 flac 真实成员组:桥仍按 PCM 口径收流(不吃 flac 字节);
//   ③ clearPlayback/finishPlayback → BOUNDARY{track/stop}(§4.4);
//   ④ encodedBytesPerSec:有桥恒 ≥192000B/s(48k/s16le/2ch),FLAC 实测/名义不得低估桥吞吐;
//   ⑤ 无桥无成员 → 返回 0(原语义,行为零变化)。
import { describe, it, expect, afterEach } from "vitest";
import { SendspinGroup } from "../../src/services/sendspin/server.js";
import { SAMPLE_RATE, type EncodedChunk } from "../../src/services/sendspin/encoding.js";
import { nowUs } from "../../src/services/sendspin/clock.js";

const PCM_BYTES_PER_SEC = SAMPLE_RATE * 2 * 2; // 192000

/** 可控块编码器桩:按 plan 逐次产出样本数;data 用 fill 字节填充便于区分多组。 */
class PhaseEncoder {
  calls = 0;
  constructor(
    private readonly plan: number[],
    private readonly fill = 0xab,
  ) {}
  async encode(): Promise<EncodedChunk[]> {
    const n = this.plan[this.calls++] ?? 0;
    return n > 0 ? [{ frameSamples: n, data: new Uint8Array(Math.max(1, n / 100)).fill(this.fill) }] : [];
  }
  async flush(): Promise<EncodedChunk[]> {
    return [];
  }
  close(): void {}
  get encodeCalls(): number {
    return this.calls;
  }
}

/** 最小成员桩:只提供 pushFrame / flushAnnounceFor 真正会碰的成员面。 */
function conn(clientId: string, codec: string, gain = 100): any {
  const sent: { ts: bigint; data: Uint8Array }[] = [];
  return {
    clientId,
    codec,
    sent,
    appliedGain: () => gain,
    bufferCapacityBytes: 0,
    clientWantsStream: () => true,
    announceStream: () => {},
    sendAudio: (ts: bigint, data: Uint8Array) => sent.push({ ts, data: Uint8Array.from(data) }),
  };
}

/** 桥句柄桩(满足 SendspinBridgeHandle 面;记录投递/boundary/代次)。 */
function bridgeStub(deviceId: string, opts: { boundaryThrows?: boolean } = {}) {
  const pushed: { data: Uint8Array; ts: bigint }[] = [];
  const boundaries: string[] = [];
  const gens: Array<[number, string]> = [];
  let stopped = 0;
  return {
    deviceId,
    pushed,
    boundaries,
    gens,
    get stopCount() {
      return stopped;
    },
    pushAudio(data: Uint8Array, ts: bigint) {
      pushed.push({ data: Uint8Array.from(data), ts });
    },
    notifyGeneration(gen: number, reason: string) {
      gens.push([gen, reason]);
    },
    sendBoundary(reason: string) {
      if (opts.boundaryThrows) throw new Error(`bridge ${deviceId} boundary 失败`);
      boundaries.push(reason);
    },
    start() {},
    stop() {
      stopped++;
    },
  };
}

/** 建组:预置编码器(键 = `codec:gain`)+ 预挂桥句柄;登记 liveGroups 供收尾停表。 */
const liveGroups: SendspinGroup[] = [];
function groupWith(encoders: Record<string, PhaseEncoder>, bridges: ReturnType<typeof bridgeStub>[] = []): SendspinGroup {
  const g = new SendspinGroup("g-push", { log() {} } as any);
  for (const [key, enc] of Object.entries(encoders)) (g as any).encoders.set(key, enc);
  for (const b of bridges) g.bridges.set(b.deviceId, b as any);
  liveGroups.push(g);
  return g;
}
afterEach(() => {
  // 窗口化迁移注:pushFrame(桥在场)会起每组 250ms 补投定时器,测试收尾显式停表。
  for (const g of liveGroups.splice(0)) g.stopBridgePushTimer();
});

const PCM = (n = 1200) => new Float32Array(n);

describe("① BLK-01:桥在场 ⇒ pcm:100 编码与真实成员解耦", () => {
  it("★ members=∅ + 桥在场 → pushFrame 返回 >0;补投 tick 派发,桥收 PCM 字节(可听域 ts)", async () => {
    const enc = new PhaseEncoder([1000]);
    const b = bridgeStub("ap-1");
    const g = groupWith({ "pcm:100": enc }, [b]);
    const ts0 = nowUs() + 2_000_000n; // 投递窗口 [now+1.5s, now+2.5s] 内

    const got = await g.pushFrame(ts0, PCM());
    g.bridgePushTick(); // §6.2 窗口化:pushFrame 只入 ring,投递由补投 tick 完成

    expect(got).toBe(1000); // 判据核心:>0 —— 没有虚拟组时这里是 0 → 上游放弃本曲
    expect(enc.encodeCalls).toBe(1); // 虚拟组照常编码
    expect(g.hasBridges()).toBe(true);
    expect(b.pushed).toHaveLength(1);
    expect(b.pushed[0]!.ts).toBe(ts0); // 贴组时间线:X = 组 ts(与真实设备可听时刻同值)
  });

  it("无桥无成员 → 返回 0,虚拟组不建、编码器不创建(非桥路径行为零变化)", async () => {
    const g = new SendspinGroup("g-push", { log() {} } as any);
    expect(await g.pushFrame(0n, PCM())).toBe(0);
    expect((g as any).encoders.size).toBe(0);
  });

  it("全 flac 真实成员组:桥仍按 PCM 口径收流(字节来自 pcm:100 组,不是 flac)", async () => {
    const flac = new PhaseEncoder([800], 0xab);
    const pcm = new PhaseEncoder([1000], 0xcd);
    const b = bridgeStub("ap-1");
    const g = groupWith({ "flac:100": flac, "pcm:100": pcm }, [b]);
    const m = conn("A", "flac");
    g.add(m);

    const ts0 = nowUs() + 2_000_000n; // 投递窗口内
    const got = await g.pushFrame(ts0, PCM());
    g.bridgePushTick(); // §6.2 窗口化:投递由补投 tick 完成

    expect(got).toBe(1000); // max(组累计交付): pcm 1000 > flac 800
    expect(m.sent).toHaveLength(1);
    expect(m.sent[0]!.data[0]).toBe(0xab); // 成员吃 flac 字节
    expect(b.pushed).toHaveLength(1);
    expect(b.pushed[0]!.data[0]).toBe(0xcd); // 桥吃 PCM 字节 —— 两条通路不混流
    expect(b.pushed[0]!.ts).toBe(ts0); // 贴组时间线:X = 组 ts(与真实设备可听时刻同值)
  });

  it("多桥:同一份字节 + 相同时间戳分发给每座桥(与成员下发同源)", async () => {
    // 单次 encode 吐 2 chunk(模拟 libFLAC 攒满 2 帧补吐):逐 chunk 真实起点推进
    const enc = {
      async encode(): Promise<EncodedChunk[]> {
        return [
          { frameSamples: 1000, data: new Uint8Array(10).fill(0x01) },
          { frameSamples: 1000, data: new Uint8Array(10).fill(0x02) },
        ];
      },
      async flush(): Promise<EncodedChunk[]> {
        return [];
      },
      close() {},
    };
    const b1 = bridgeStub("ap-1");
    const b2 = bridgeStub("ap-2");
    const g = groupWith({}, [b1, b2]);
    (g as any).encoders.set("pcm:100", enc);

    const ts0 = nowUs() + 2_000_000n; // 投递窗口内(两 chunk 均落在窗内)
    await g.pushFrame(ts0, PCM());
    g.bridgePushTick(); // §6.2 窗口化:投递由补投 tick 完成

    expect(b1.pushed).toHaveLength(2);
    expect(b2.pushed).toHaveLength(2);
    for (let i = 0; i < 2; i++) {
      expect(Buffer.from(b1.pushed[i]!.data).equals(b2.pushed[i]!.data)).toBe(true);
      expect(b1.pushed[i]!.ts).toBe(b2.pushed[i]!.ts);
    }
    // 逐 chunk 时间戳按 frameSamples 推进(与成员同源)并做可听域转换,不复用组起始 ts:
    // 第 2 chunk 起点 = 第 1 chunk 时长 = 1000 样本 / 48kHz ≈ 20833µs
    expect(b1.pushed[0]!.ts).toBe(ts0);
    expect(b1.pushed[1]!.ts).toBe(ts0 + BigInt(Math.round((1000 * 1_000_000) / SAMPLE_RATE)));
  });
});

describe("② BOUNDARY 语义(§4.4)", () => {
  it("clearPlayback → BOUNDARY{track};finishPlayback → BOUNDARY{stop}", () => {
    const b = bridgeStub("ap-1");
    const g = groupWith({}, [b]);
    g.clearPlayback();
    expect(b.boundaries).toEqual(["track"]);
    g.finishPlayback();
    expect(b.boundaries).toEqual(["track", "stop"]);
  });

  it("单桥 sendBoundary 抛错不连累其余桥(逐桥隔离)", () => {
    const bad = bridgeStub("ap-bad", { boundaryThrows: true });
    const good = bridgeStub("ap-good");
    const g = groupWith({}, [bad, good]);
    expect(() => g.clearPlayback()).not.toThrow();
    expect(good.boundaries).toEqual(["track"]);
    expect(bad.boundaries).toEqual([]);
  });

  it("notifyBridgeGeneration:无桥 no-op;有桥全量分发(重锚唯一落点消费面)", () => {
    const g = groupWith({});
    expect(() => g.notifyBridgeGeneration(7, "seek")).not.toThrow(); // 无桥不抛
    const b1 = bridgeStub("ap-1");
    const b2 = bridgeStub("ap-2");
    const g2 = groupWith({}, [b1, b2]);
    g2.notifyBridgeGeneration(9, "seek");
    expect(b1.gens).toEqual([[9, "seek"]]);
    expect(b2.gens).toEqual([[9, "seek"]]);
  });
});

describe("③ encodedBytesPerSec:桥恒按 PCM 口径(≥192000B/s)", () => {
  it("无实测 + 桥在场 → PCM 名义值 192000(不因成员 codec 走 FLAC 名义)", () => {
    const g = groupWith({}, [bridgeStub("ap-1")]);
    g.add(conn("A", "flac")); // 有桥时成员 codec 不参与回落
    expect(g.encodedBytesPerSec()).toBe(PCM_BYTES_PER_SEC);
  });

  it("实测偏低(FLAC ~100kB/s)+ 桥 → 取 max = 192000", () => {
    const g = groupWith({}, [bridgeStub("ap-1")]);
    (g as any).pushedSamples = SAMPLE_RATE; // 1s
    (g as any).pushedBytes = 100_000;
    expect(g.encodedBytesPerSec()).toBe(PCM_BYTES_PER_SEC);
  });

  it("实测更高(240kB/s)+ 桥 → 原样取实测", () => {
    const g = groupWith({}, [bridgeStub("ap-1")]);
    (g as any).pushedSamples = SAMPLE_RATE;
    (g as any).pushedBytes = 240_000;
    expect(g.encodedBytesPerSec()).toBe(240_000);
  });

  it("无桥回归:实测偏低原样返回;无实测 FLAC 名义 0.7×(行为零变化)", () => {
    const g = groupWith({});
    (g as any).pushedSamples = SAMPLE_RATE;
    (g as any).pushedBytes = 100_000;
    expect(g.encodedBytesPerSec()).toBe(100_000);
    const g2 = groupWith({});
    g2.add(conn("A", "flac"));
    expect(g2.encodedBytesPerSec()).toBe(SAMPLE_RATE * 2 * 2 * 0.7);
  });
});
