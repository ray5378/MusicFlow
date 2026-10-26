// ==================== AP2 realtime 双出口(Phase 6b · T03)====================
//
// 两组用例,都不连设备、不起进程:
//   A. runAp2OutputLoop(纯驱动 + 假时钟):节拍公式 / 迟到丢弃 / 错误收敛 / 暂停零发送;
//   B. BridgeSession(注入假 AP2 会话):48k 直通不重采样 / 锚点只落一次 / 链路断 ⇒ degraded;
//      并用 RAOP(44100 + 有重采样器)做**对照断言**,证明两条出口互不污染。
//
// MUST be the first import: bridgeSession 链路会碰 DB(deviceState)。
import "../plugins/_env.js";

import { afterEach, describe, expect, it, vi } from "vitest";

// computeBridgeAnchors 被 planBridgeAnchor 唯一调用一次 ⇒ 用它数「锚点落了几次」
// (planBridgeAnchor 本身定义在 bridgeSession.ts 内,不在 bridgeMath 里)。
vi.mock("../../src/services/airplay/bridgeMath.js", async (importOriginal) => {
  const actual = await importOriginal<any>();
  return { ...actual, computeBridgeAnchors: vi.fn(actual.computeBridgeAnchors) };
});

import { bridgeSocketPath } from "../../src/services/airplay/bridgeChannel.js";
import {
  BridgeSession,
  runAp2OutputLoop,
  type Ap2OutputDeps,
  type Ap2SessionLike,
} from "../../src/services/airplay/bridgeSession.js";
import { computeBridgeAnchors } from "../../src/services/airplay/bridgeMath.js";
import { AP2_EFFECTIVE_LATENCY_FRAMES } from "../../src/services/airplay/rates.js";
import { AP2_SEND_ERROR_LIMIT } from "../../src/services/airplay/ap2/ap2Stream.js";
import { nowUs } from "../../src/utils/hostClock.js";

const ANCHOR = 1_000_000n;
const RATE = 48000;
const SPF = 352;
/** L_eff(帧) → µs:与实现同一份换算口径(round(frames/rate·1e6))。 */
const L_EFF_US = Math.round((AP2_EFFECTIVE_LATENCY_FRAMES / RATE) * 1e6);
/** 首块 sendAt = A − L_eff。 */
const SEND_AT_0 = ANCHOR - BigInt(L_EFF_US);
/** 每块步进 ≈ 352/48000 s = 7333.33µs(允许 ±1µs 取整)。 */
const STEP_US = (SPF / RATE) * 1e6;

// ---------------------------------------------------------------------------
// A. runAp2OutputLoop(假时钟)
// ---------------------------------------------------------------------------

interface LoopHarness {
  deps: Ap2OutputDeps;
  sends: Array<{ at: bigint; len: number }>;
  sleeps: number[];
  lateSkips: Array<{ total: number; lagUs: number }>;
  rebases: number[];
  pulls: () => number;
  setNow: (v: bigint) => void;
}

function mkLoop(over: Partial<Ap2OutputDeps> = {}, chunkCount = 8): LoopHarness {
  let t = 0n;
  let pulled = 0;
  const chunks: Buffer[] = [];
  for (let i = 0; i < chunkCount; i++) chunks.push(Buffer.alloc(SPF * 4, i + 1));
  const sends: Array<{ at: bigint; len: number }> = [];
  const sleeps: number[] = [];
  const lateSkips: Array<{ total: number; lagUs: number }> = [];
  const rebases: number[] = [];
  const deps: Ap2OutputDeps = {
    pull: async () => (pulled < chunks.length ? chunks[pulled++]! : null),
    send: (pcm) => {
      sends.push({ at: t, len: pcm.length });
      return { sent: 1, errors: 0, state: "open" };
    },
    nowUs: () => t,
    sleepUs: async (us) => {
      sleeps.push(us);
      t += BigInt(Math.max(0, Math.round(us)));
    },
    shouldStop: () => false,
    isPaused: () => false,
    anchorUs: ANCHOR,
    rate: RATE,
    spf: SPF,
    lEffFrames: AP2_EFFECTIVE_LATENCY_FRAMES,
    onLateSkip: (total, lagUs) => lateSkips.push({ total, lagUs }),
    onRebase: (lagUs) => rebases.push(lagUs),
    ...over,
  };
  return {
    deps,
    sends,
    sleeps,
    lateSkips,
    rebases,
    pulls: () => pulled,
    setNow: (v: bigint) => { t = v; },
  };
}

describe("runAp2OutputLoop · 发送节拍(唯一锚点)", () => {
  it("★ 首块 sendAt = A − L_eff;此后每块单调递增 ≈ spf/rate(不另起时间线)", async () => {
    const h = mkLoop();
    const r = await runAp2OutputLoop(h.deps);
    expect(r.stopReason).toBe("eof");
    expect(r.chunks).toBe(8);
    expect(r.lateSkipped).toBe(0);
    expect(h.sends[0]!.at).toBe(SEND_AT_0);
    for (let i = 1; i < h.sends.length; i++) {
      const step = Number(h.sends[i]!.at - h.sends[i - 1]!.at);
      expect(h.sends[i]!.at > h.sends[i - 1]!.at).toBe(true);
      expect(Math.abs(step - STEP_US)).toBeLessThanOrEqual(1);
    }
    expect(h.sleeps.length).toBeGreaterThanOrEqual(8);
  });

  it("★ 节拍不含 RAOP_SAFETY_MS(否则 AP2 恒早 50ms):首块提前量恰为 L_eff", async () => {
    const h = mkLoop();
    await runAp2OutputLoop(h.deps);
    const lead = Number(ANCHOR - h.sends[0]!.at);
    expect(lead).toBe(L_EFF_US);
    expect(lead).not.toBe(L_EFF_US + 50_000);
  });

  it("每块恰好 352 帧(1408B,48k 直通口径)", async () => {
    const h = mkLoop();
    await runAp2OutputLoop(h.deps);
    for (const s of h.sends) expect(s.len).toBe(SPF * 4);
  });
});

describe("runAp2OutputLoop · 迟到/中止/降级", () => {
  it("★ 迟到超阈值 ⇒ 丢块并计数(ev=ap2-late-skip 语义),不补静音、不前移锚点", async () => {
    const h = mkLoop({ rebaseUs: 10_000_000 });
    h.setNow(900_000n); // 墙钟已远超全部 sendAt
    const r = await runAp2OutputLoop(h.deps);
    expect(r.chunks).toBe(0);
    expect(r.lateSkipped).toBe(8);
    expect(h.sends).toHaveLength(0);
    expect(h.lateSkips).toHaveLength(8);
    expect(h.lateSkips[0]!.total).toBe(1);
    expect(h.lateSkips[7]!.total).toBe(8);
  });

  it("轻微迟到(< 阈值)照发(等价 RAOP 追发),不计 skip", async () => {
    const h = mkLoop();
    h.setNow(SEND_AT_0 + 5_000n); // 5ms 迟到 < 30ms 阈值
    const r = await runAp2OutputLoop(h.deps);
    expect(r.lateSkipped).toBe(0);
    expect(r.chunks).toBe(8);
    expect(h.sends[0]!.at).toBe(SEND_AT_0 + 5_000n);
  });

  it("★ 长饥饿 ⇒ 只前移发送参考(pacing rebase),不动锚点、不丢块", async () => {
    const h = mkLoop({ rebaseUs: 100_000 });
    h.setNow(900_000n);
    const r = await runAp2OutputLoop(h.deps);
    expect(h.rebases).toHaveLength(1);
    expect(h.rebases[0]).toBe(Number(900_000n - SEND_AT_0));
    expect(r.lateSkipped).toBe(0);
    expect(r.chunks).toBe(8);
    expect(h.sends[0]!.at).toBe(900_000n); // 恢复首块立即发
  });

  it("★ 会话状态非 open(failLink)⇒ 循环立刻退出,不再拉块", async () => {
    const h = mkLoop({ send: () => ({ sent: 0, errors: 1, state: "error" }) });
    const r = await runAp2OutputLoop(h.deps);
    expect(r.stopReason).toBe("link-loss");
    expect(r.chunks).toBe(1);
    expect(h.pulls()).toBe(1);
  });

  it("★ 连续发送错误达 AP2_SEND_ERROR_LIMIT ⇒ 判出口不可达并退出", async () => {
    let errors = 0;
    const h = mkLoop(
      {
        send: () => {
          errors++;
          return { sent: 0, errors, state: "open" };
        },
      },
      AP2_SEND_ERROR_LIMIT + 5,
    );
    const r = await runAp2OutputLoop(h.deps);
    expect(r.stopReason).toBe("link-loss");
    expect(r.chunks).toBe(AP2_SEND_ERROR_LIMIT);
    expect(h.pulls()).toBe(AP2_SEND_ERROR_LIMIT);
  });

  it("成功发送会清零连续错误计数(偶发错误不误判降级)", async () => {
    let total = 0;
    let n = 0;
    const h = mkLoop({
      send: () => {
        n++;
        // 每 3 块夹一次错误:累计错误涨,但连续计数始终 < 上限
        if (n % 3 === 0) total++;
        return { sent: 1, errors: total, state: "open" };
      },
    });
    const r = await runAp2OutputLoop(h.deps);
    expect(r.stopReason).toBe("eof");
    expect(r.chunks).toBe(8);
  });

  it("★ 暂停期零发送、零拉块(不写静音)", async () => {
    let stopChecks = 0;
    const h = mkLoop({
      isPaused: () => true,
      // 循环顶部的 shouldStop 计数:前 3 次放行(让 3 个暂停切片落地),第 4 次收工。
      shouldStop: () => ++stopChecks > 3,
    });
    const r = await runAp2OutputLoop(h.deps);
    expect(r.chunks).toBe(0);
    expect(h.sends).toHaveLength(0);
    expect(h.pulls()).toBe(0);
    expect(h.sleeps.length).toBe(3); // 暂停期只睡等待切片
  });

  it("shouldStop(aborted)⇒ 立即退出,不拉块", async () => {
    const h = mkLoop({ shouldStop: () => true });
    const r = await runAp2OutputLoop(h.deps);
    expect(h.pulls()).toBe(0);
    expect(r.chunks).toBe(0);
  });

  it("供给 null ⇒ eof 退出", async () => {
    const h = mkLoop({ pull: async () => null });
    const r = await runAp2OutputLoop(h.deps);
    expect(r.stopReason).toBe("eof");
    expect(r.chunks).toBe(0);
  });

  it("错误上限与 ap2/ap2Stream.ts 同源(AP2_SEND_ERROR_LIMIT = 20)", () => {
    expect(AP2_SEND_ERROR_LIMIT).toBe(20);
  });
});

// ---------------------------------------------------------------------------
// B. BridgeSession 双出口(注入假 AP2 会话,零网络)
// ---------------------------------------------------------------------------

interface FakeAp2 extends Ap2SessionLike {
  opened: number;
  closed: number;
  pumped: Buffer[];
  failAfter: number;
  state: "open" | "error";
  errors: number;
}

function mkFakeAp2(opts: { failAfter?: number } = {}): FakeAp2 {
  const f: FakeAp2 = {
    opened: 0,
    closed: 0,
    pumped: [],
    failAfter: opts.failAfter ?? Number.POSITIVE_INFINITY,
    state: "open",
    errors: 0,
    async open() {
      f.opened++;
      return {};
    },
    pump(pcm: Buffer) {
      f.pumped.push(pcm);
      if (f.pumped.length > f.failAfter) {
        f.state = "error";
        f.errors++;
        throw new Error("udp unreachable(注入)");
      }
      return 1;
    },
    async close() {
      f.closed++;
    },
    get currentState() {
      return f.state;
    },
    get stats() {
      return {
        sent: f.pumped.length,
        errors: f.errors,
        lastError: f.state === "error" ? "udp unreachable(注入)" : null,
        linkLoss: f.state === "error" ? "udp-unreachable" : null,
      };
    },
  };
  return f;
}

const live: BridgeSession[] = [];

function mkSession(opts: Partial<ConstructorParameters<typeof BridgeSession>[0]> = {}): BridgeSession {
  const n = Math.floor(Math.random() * 1e9);
  const s = new BridgeSession({
    deviceId: `ap2-${n}`,
    token: `ap2-${n}`,
    protocol: "ap2-realtime",
    socketPath: bridgeSocketPath(`ap2-${n}`, `ap2-${n}`),
    host: "127.0.0.1",
    port: 5000,
    waitDataMs: 10,
    statsIntervalMs: 0,
    ap2: { controllerId: "AABBCCDDEEFF0011" },
    ...opts,
  });
  live.push(s);
  return s;
}

afterEach(async () => {
  while (live.length > 0) await live.pop()!.stop().catch(() => {});
});

describe("BridgeSession · AP2 分支建链", () => {
  it("★ protocol=ap2-realtime ⇒ 建 Ap2StreamSession(48k 直通:outRate 48000、无重采样器)", async () => {
    const fake = mkFakeAp2();
    const factory = vi.fn(() => fake);
    const s = mkSession({ ap2SessionFactory: factory });
    await s.start();
    expect(fake.opened).toBe(1);
    expect(s.outRate).toBe(48000);
    expect((s as any).resampler).toBeNull(); // 直通 ⇒ resampled=false ⇒ 不做群延迟补偿
    expect(factory).toHaveBeenCalledTimes(1);
    const opts = (factory.mock.calls[0] as unknown as [Record<string, unknown>])[0];
    expect(opts.sourceRate).toBe(48000);
    expect(opts.preferredRate).toBe(48000);
    expect(opts.spf).toBe(352);
    expect(opts.controllerId).toBe("AABBCCDDEEFF0011");
  });

  it("对照:protocol=raop ⇒ outRate 44100 + 147/160 重采样器(两条出口互不污染)", async () => {
    const s = mkSession({ protocol: "raop", dry: true });
    await s.start();
    expect(s.outRate).toBe(44100);
    expect((s as any).resampler).not.toBeNull();
    expect((s as any).ap2Session).toBeNull();
  });

  it("对照:ap2-realtime 的 48k 直通字节原样(不经重采样/不混静音)", async () => {
    const s = mkSession({ dry: true });
    await s.start();
    const raw = Buffer.alloc(SPF * 4, 9);
    (s as any).ingest(raw);
    const chunk = await (s as any).pullOutChunk();
    expect(chunk.length).toBe(SPF * 4);
    expect(chunk.every((b: number) => b === 9)).toBe(true);
  });

  it("AP2 载荷缺失(无 controllerId)⇒ 抛错并带 stage=payload(主进程据此回落 solo)", async () => {
    const s = mkSession({ ap2: undefined, ap2SessionFactory: () => mkFakeAp2() });
    await expect(s.start()).rejects.toMatchObject({ stage: "payload" });
  });

  it("建链失败 ⇒ 抛出(带 stage)且不残留会话", async () => {
    const boom = mkFakeAp2();
    boom.open = async () => {
      const e = new Error("SETUP 被拒") as Error & { stage?: string };
      e.stage = "setup";
      throw e;
    };
    const s = mkSession({ ap2SessionFactory: () => boom });
    await expect(s.start()).rejects.toMatchObject({ stage: "setup" });
    expect((s as any).ap2Session).toBeNull();
  });
});

describe("BridgeSession · 双出口分流(同一锚点,只落一次)", () => {
  it("★ 起流走 runAp2Output:锚点只算一次(第二次调用被一次性守卫挡住)", async () => {
    const fake = mkFakeAp2();
    const s = mkSession({ ap2SessionFactory: () => fake });
    await s.start();
    const spy = computeBridgeAnchors as unknown as { mockClear: () => void; mock: { calls: unknown[] } };
    spy.mockClear();
    // 首帧 tsUs 设到「未来 300ms」:可达(A − L − SAFETY ≥ now)⇒ 不触发可达性重锚。
    (s as any).firstFrameTsUs = nowUs() + 300_000n;
    await (s as any).maybeBeginStream();
    await (s as any).maybeBeginStream(); // aligner 非空 ⇒ 早退,不再落锚点
    expect(spy.mock.calls).toHaveLength(1);
    expect((s as any).aligner).not.toBeNull();
    const snap = s.snapshot();
    expect(snap.anchored).toBe(true);
    expect(snap.anchorUs).not.toBeNull();
    expect(snap.degraded).toBe(false);
    expect(snap.ap2LateSkips).toBe(0);
  });

  it("★ 发送期链路断(pump 抛错)⇒ 循环退出 + snapshot.degraded=true(主进程据此摘桥)", async () => {
    const fake = mkFakeAp2({ failAfter: 0 }); // 第一块就炸
    const s = mkSession({ ap2SessionFactory: () => fake });
    await s.start();
    (s as any).firstFrameTsUs = nowUs() + 300_000n; // ≈70ms 后到 sendAt
    await (s as any).maybeBeginStream();
    const deadline = Date.now() + 5000;
    while (s.snapshot().degraded !== true && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(s.snapshot().degraded).toBe(true);
    expect(s.snapshot().linkLoss).toBe("udp-unreachable");
    expect(fake.pumped.length).toBeGreaterThanOrEqual(1);
    const n = fake.pumped.length; // 循环已退出:不再有新块
    await new Promise((r) => setTimeout(r, 120));
    expect(fake.pumped.length).toBe(n);
  });

  it("stop() 会回收 AP2 会话(幂等)", async () => {
    const fake = mkFakeAp2();
    const s = mkSession({ ap2SessionFactory: () => fake });
    await s.start();
    await s.stop();
    await s.stop();
    expect(fake.closed).toBeGreaterThanOrEqual(1);
    expect(s.listeningOn).toBeNull();
  });
});
