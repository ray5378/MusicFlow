// ==================== Phase 3 组泵出声:BLK-01 虚拟 pcm:100 组 + 桥投递 + 码率口径 ====================
//
// 机械判据钉死(§2.1/§6.2):
//   ① BLK-01 正向:members=∅ + bridges>0 ⇒ pushFrame 返回 >0(虚拟组让编码与
//      「是否存在真实 pcm 成员」完全解耦,否则上游判零产出 → maxSilentDegrade 提前切歌);
//   ② 全 flac 真实成员组:桥仍按 PCM 口径收流(不吃 flac 字节);
//   ③ clearPlayback/finishPlayback → BOUNDARY{track/stop}(§4.4);
//   ④ encodedBytesPerSec:有桥恒 ≥192000B/s(48k/s16le/2ch),FLAC 实测/名义不得低估桥吞吐;
//   ⑤ 无桥无成员 → 返回 0(原语义,行为零变化)。
import { describe, it, expect, afterEach, beforeAll } from "vitest";
import "../plugins/_env.js";
import { initDatabase } from "../../src/db/index.js";
import { setGroupDelays } from "../../src/services/group/delayCalib.js";
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

beforeAll(() => {
  if (!process.env.APP_VERSION) process.env.APP_VERSION = "1.0.0";
  // delayCalib 依赖 DB 时用内存缓存即可(落库失败被 catch,内存先更新是既有设计);
  // **绝不改 process.env.DATA_DIR** —— 会泄漏到同 worker 后续文件毒化其它测试
  // (2026-10-27 实锤:mkdtemp 隔离方案扩散 no such column 到 group/routes)。
  initDatabase();
});

/** 搭一个 ug: 组(窗口位移用例专用):真实组名 ⇒ delayCalib 可解析 gid。 */
function ugGroup(name: string, specs: Array<{ deviceId: string; protocol: string }>): SendspinGroup {
  const g = new SendspinGroup(name, { log() {} } as any);
  g.bridgeSpecs = specs.map((s) => ({ ...s, socketPath: "/tmp/x", token: "t" }));
  liveGroups.push(g);
  return g;
}

// ==================== ⑥ 投递窗口跟随桥锚点位移(手动延迟补偿的生效前提) ====================
// 修前:窗口只以 now 选帧 ⇒ anchor 后移被对齐器当「帧提前到达」drop/skip 出清,
// 补偿整体失效(2026-10-27 真机 8 秒实验:realigned 激增、deltaUs 两拍回落)。
describe("⑥ 投递窗口跟随桥锚点位移(anchorShiftUs)", () => {
  it("AP1 桥 + airplayMs=2000 ⇒ 选帧窗口整体后移 2s(audibleAt = ts + shift 落窗),投递 ts 换算不变", async () => {
    // 不 invalidate:setGroupDelays 更新内存缓存(生产 PUT 同一路径),DB 无此行不能重读
    setGroupDelays("delay-win-1", { airplayMs: 2000, airplay2Ms: 0, sendspinMs: 0 });
    const g = ugGroup("ug:delay-win-1", [{ deviceId: "ap-1", protocol: "raop" }]);
    (g as any).encoders.set("pcm:100", new PhaseEncoder([1000, 1000]));
    const b = bridgeStub("ap-1");
    g.bridges.set("ap-1", b as any);

    const ahead = BigInt(g.commonSendAheadUs());
    // shift=0 时的窗口 = [now+1.5s, now+2.5s]+ahead;+2s 后 = [now−0.5s, now+0.5s]+ahead
    // 顺序:先投新窗内帧(ring 有序,窗外帧会 break 挡住后续;生产 rebuild 换代无此卡点)
    const tsInside = nowUs() + ahead + 300_000n; // audible=ts+2s=now+2.3s ∈ [now+1.5,now+2.5]+ahead ✓
    await g.pushFrame(tsInside, PCM());
    g.bridgePushTick();
    expect(b.pushed).toHaveLength(1);
    // 投递时戳 = ts − ahead + shift(桥内时间线整体平移 ⇒ 设备晚 shift 出声)
    expect(b.pushed[0]!.ts).toBe(tsInside - ahead + 2_000_000n);

    const tsOutside = nowUs() + ahead + 2_000_000n; // 原窗内、新窗外(>hi)⇒ 不投
    await g.pushFrame(tsOutside, PCM());
    g.bridgePushTick();
    expect(b.pushed).toHaveLength(1); // 无新增
  });

  it("AP2 桥读 airplay2 格、绝不串 AP1 格(airplayMs=5000 在场也不影响窗口)", async () => {
    setGroupDelays("delay-win-2", { airplayMs: 5000, airplay2Ms: 0, sendspinMs: 0 });
    const g = ugGroup("ug:delay-win-2", [{ deviceId: "ap-2", protocol: "ap2-realtime" }]);
    (g as any).encoders.set("pcm:100", new PhaseEncoder([1000, 1000]));
    const b = bridgeStub("ap-2");
    g.bridges.set("ap-2", b as any);

    const ahead = BigInt(g.commonSendAheadUs());
    // 若误读 AP1 格(5000ms) ⇒ 窗口=[now−3.5s,now−2.5s]+ahead ⇒ ts0 落窗外不投;正确(读 0)⇒ 原窗 ⇒ 投
    const ts0 = nowUs() + ahead + 2_000_000n;
    await g.pushFrame(ts0, PCM());
    g.bridgePushTick();
    expect(b.pushed).toHaveLength(1);

    // PUT airplay2Ms=1500 ⇒ 下一 tick 窗口=[now+ahead, now+1s+ahead];新帧 ts=now+2s+ahead ⇒ 不投
    setGroupDelays("delay-win-2", { airplay2Ms: 1500 });
    const ts1 = nowUs() + ahead + 2_000_000n;
    await g.pushFrame(ts1, PCM());
    g.bridgePushTick();
    expect(b.pushed).toHaveLength(1); // 无新增:动态读生效,无需任何重建通知
  });

  it("切歌垫片按组配置:ug 组设 trackLeadMs ⇒ 新代次帧时戳整体 +Δ(esp32 下发与 ring 同源),随内容消耗归零", async () => {
    setGroupDelays("lead-g1", { trackLeadMs: 1500 });
    const g = new SendspinGroup("ug:lead-g1", { log() {} } as any);
    (g as any).encoders.set("pcm:100", new PhaseEncoder([1000, 1000, 1000]));
    const b = bridgeStub("ap-1");
    g.bridges.set("ap-1", b as any);
    liveGroups.push(g);

    g.notifyBridgeGeneration(1, "track"); // 切歌 ⇒ 垫片 Δ=1500ms(按组)
    const ahead = BigInt(g.commonSendAheadUs());
    // 打戳时 ts 已含垫片 Δ:落窗值 = ts0+Δ,取 ts0=now+1s ⇒ 落窗 now+2.5s ∈ [now+1.5,now+2.5]+ahead
    const ts0 = nowUs() + ahead + 1_000_000n;
    await g.pushFrame(ts0, PCM());
    g.bridgePushTick();
    expect(b.pushed.length).toBeGreaterThan(0);
    expect(b.pushed[0]!.ts).toBe((ts0 as bigint) + 1_500_000n - ahead);

    // 垫片被内容消耗:投递时戳增量逐帧回落(时间线连续,无跳变)
    const pushed = b.pushed.map((p: { ts: bigint }) => p.ts);
    for (let i = 1; i < pushed.length; i += 1) {
      const d = pushed[i]! - pushed[i - 1]!;
      expect(d).toBeGreaterThan(0n);
      expect(d).toBeLessThanOrEqual(1_000_000n / (SAMPLE_RATE / 1000n) * 4n);
    }
  });

  it("切歌垫片默认 0(未设置的组):无垫片,投递时戳 = ts − ahead(行为与 v4.7.2 逐字节一致)", async () => {
    const g = new SendspinGroup("g-lead-zero", { log() {} } as any);
    (g as any).encoders.set("pcm:100", new PhaseEncoder([1000]));
    const b = bridgeStub("ap-0");
    g.bridges.set("ap-0", b as any);
    liveGroups.push(g);

    g.notifyBridgeGeneration(1, "track"); // 切歌 ⇒ 组未配置 ⇒ Δ=0
    const ahead = BigInt(g.commonSendAheadUs());
    const ts0 = nowUs() + ahead + 2_000_000n;
    await g.pushFrame(ts0, PCM());
    g.bridgePushTick();
    expect(b.pushed).toHaveLength(1);
    expect(b.pushed[0]!.ts).toBe(ts0 - ahead);
  });

  it("负 shift(更早出声):窗口前移 —— 原窗内的帧改为不投,更远的未来帧提前投", async () => {
    setGroupDelays("delay-win-3", { airplayMs: -800, airplay2Ms: 0, sendspinMs: 0 });
    const g = ugGroup("ug:delay-win-3", [{ deviceId: "ap-3", protocol: "raop" }]);
    (g as any).encoders.set("pcm:100", new PhaseEncoder([1000, 1000]));
    const b = bridgeStub("ap-3");
    g.bridges.set("ap-3", b as any);

    const ahead = BigInt(g.commonSendAheadUs());
    // 新窗 = [now+1.5s,now+2.5s]+ahead+0.8s = [now+2.3s, now+3.3s]+ahead
    const tsEarly = nowUs() + ahead + 1_000_000n; // 原窗内、新窗外(<lo)⇒ 丢弃并推水位
    await g.pushFrame(tsEarly, PCM());
    g.bridgePushTick();
    expect(b.pushed).toHaveLength(0);

    const tsFar = nowUs() + ahead + 2_800_000n; // 新窗内(原窗外)⇒ 提前投
    await g.pushFrame(tsFar, PCM());
    g.bridgePushTick();
    expect(b.pushed).toHaveLength(1);
    expect(b.pushed[0]!.ts).toBe(tsFar - ahead - 800_000n); // 负 shift:投递时戳前移
  });
});

describe("① BLK-01:桥在场 ⇒ pcm:100 编码与真实成员解耦", () => {
  it("★ members=∅ + 桥在场 → pushFrame 返回 >0;补投 tick 派发,桥收 PCM 字节(可听域 ts)", async () => {
    const enc = new PhaseEncoder([1000]);
    const b = bridgeStub("ap-1");
    const g = groupWith({ "pcm:100": enc }, [b]);
    const ahead = BigInt(g.commonSendAheadUs()); // 可听域换算量(= 设备 send_ahead)
    const ts0 = nowUs() + ahead + 2_000_000n; // 原始域窗口 = [now+1.5s, now+2.5s] + ahead

    const got = await g.pushFrame(ts0, PCM());
    g.bridgePushTick(); // §6.2 窗口化:pushFrame 只入 ring,投递由补投 tick 完成

    expect(got).toBe(1000); // 判据核心:>0 —— 没有虚拟组时这里是 0 → 上游放弃本曲
    expect(enc.encodeCalls).toBe(1); // 虚拟组照常编码
    expect(g.hasBridges()).toBe(true);
    expect(b.pushed).toHaveLength(1);
    expect(b.pushed[0]!.ts).toBe(ts0 - ahead); // 可听域:X = ts − send_ahead(设备出音时刻)
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

    const ahead = BigInt(g.commonSendAheadUs()); // 可听域换算量(= 设备 send_ahead)
    const ts0 = nowUs() + ahead + 2_000_000n; // 原始域窗口 = [now+1.5s, now+2.5s] + ahead
    const got = await g.pushFrame(ts0, PCM());
    g.bridgePushTick(); // §6.2 窗口化:投递由补投 tick 完成

    expect(got).toBe(1000); // max(组累计交付): pcm 1000 > flac 800
    expect(m.sent).toHaveLength(1);
    expect(m.sent[0]!.data[0]).toBe(0xab); // 成员吃 flac 字节
    expect(b.pushed).toHaveLength(1);
    expect(b.pushed[0]!.data[0]).toBe(0xcd); // 桥吃 PCM 字节 —— 两条通路不混流
    expect(b.pushed[0]!.ts).toBe(ts0 - ahead); // 可听域:X = ts − send_ahead(设备出音时刻)
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

    const ahead = BigInt(g.commonSendAheadUs()); // 可听域换算量(= 设备 send_ahead)
    const ts0 = nowUs() + ahead + 2_000_000n; // 原始域窗口 = [now+1.5s, now+2.5s] + ahead
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
    expect(b1.pushed[0]!.ts).toBe(ts0 - ahead);
    expect(b1.pushed[1]!.ts).toBe(ts0 + BigInt(Math.round((1000 * 1_000_000) / SAMPLE_RATE)) - ahead);
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
