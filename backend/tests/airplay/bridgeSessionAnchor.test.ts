// ==================== Phase 4:桥会话锚点/对齐/stats tick(§3.3/§3.5/§4.5/§10.5) ====================
//
// 钉死:
//   ① BridgeTimelineAligner:漂移方向(落后补静音 / 超前裁头)、>1ms 记 realigned、
//      10ms 阈值内不动作、欠料超上限走 skip(不物化静音);
//   ② planBridgeAnchor:可达 = 首帧 tsUs 原样 + 群延迟补偿方向(A′ = A + 0.3627ms,MIN-01);
//      不可达 = max(now + warmLead, 首帧) 重锚;48k 直通零补偿;
//   ③ stats tick(§10.5):一行 JSON 字段齐全,clock 恒 local-rtp-ntp;
//   ④ anchor report(§3.5):scheduledAnchorUs 上报、无 ack 伪造;
//   ⑤ ★ 1kHz 正弦经完整驱动链(dry):基频偏差 ≤0.5%(出口判据)。
import "../plugins/_env.js";

import { afterEach, describe, expect, it, vi } from "vitest";

import { bridgeSocketPath } from "../../src/services/airplay/bridgeChannel.js";
import {
  BridgeSession,
  BridgeTimelineAligner,
  planBridgeAnchor,
  type BridgeAlignAction,
} from "../../src/services/airplay/bridgeSession.js";
import { BRIDGE_WARM_START_LEAD_US, RAOP_SAFETY_MS } from "../../src/services/airplay/rates.js";
import { ntpToHostUs } from "../../src/utils/hostClock.js";

const sessions: BridgeSession[] = [];

function mkSession(opts: Partial<ConstructorParameters<typeof BridgeSession>[0]> = {}): BridgeSession {
  const n = Math.floor(Math.random() * 1e9);
  const s = new BridgeSession({
    deviceId: `bs4-${n}`,
    token: `bs4-${n}`,
    protocol: "raop",
    socketPath: bridgeSocketPath(`bs4-${n}`, `bs4-${n}`),
    dry: true,
    waitDataMs: 50,
    ...opts,
  });
  sessions.push(s);
  return s;
}

afterEach(async () => {
  while (sessions.length > 0) await sessions.pop()!.stop().catch(() => {});
});

// ---------------------------------------------------------------------------
// BridgeTimelineAligner(§4.5)
// ---------------------------------------------------------------------------

describe("BridgeTimelineAligner", () => {
  const A = 1_000_000_000n;
  const RATE = 44100;
  /** 帧步进:tsUs +20408µs ⇔ 目标内容 +900 帧(≈20.4ms;double rounding 误差 <0.1 帧)。 */
  const STEP_US = 20408n;
  const SIZE = 900;

  function tsUsFor(frames: number): bigint {
    return A + BigInt(Math.round((frames / RATE) * 1e6));
  }

  /** 模拟真实 resampleIn 次序:onFrame(内部已计入补静音)→ produced(本帧实际输出帧数)。 */
  function step(a: BridgeTimelineAligner, tsUs: bigint, outFrames = SIZE): BridgeAlignAction {
    const act = a.onFrame(tsUs);
    a.produced(outFrames);
    return act;
  }

  function feed(a: BridgeTimelineAligner, n: number): void {
    for (let i = 0; i < n; i++) step(a, tsUsFor(i * SIZE));
  }

  it("稳态:逐帧 ≈20.4ms 步进,无补/裁动作,残差 <5 帧", () => {
    const a = new BridgeTimelineAligner(A, RATE);
    let act: BridgeAlignAction | null = null;
    for (let i = 0; i < 50; i++) act = step(a, tsUsFor(i * SIZE));
    expect(act!.insertFrames).toBe(0);
    expect(act!.dropFrames).toBe(0);
    expect(act!.skipFrames).toBe(0);
    expect(Math.abs(act!.diff)).toBeLessThan(5);
    expect(a.realignments).toBe(0);
  });

  it("★ 内容落后 20ms(有洞)→ 补静音 882 帧 + realigned;续帧恢复无动作", () => {
    const a = new BridgeTimelineAligner(A, RATE);
    feed(a, 10);
    expect(a.contentPos).toBe(10 * SIZE);
    const act = step(a, tsUsFor(10 * SIZE + 882)); // 时间线空洞 20ms
    expect(act.insertFrames).toBeGreaterThanOrEqual(880);
    expect(act.insertFrames).toBeLessThanOrEqual(884);
    expect(act.dropFrames).toBe(0);
    expect(act.realigned).toBe(true);
    // pos = 静音补齐后的 target + 本帧输出
    expect(a.contentPos).toBe(10 * SIZE + act.insertFrames + SIZE);
    // 续帧无动作(对齐已重同步)
    const act2 = step(a, tsUsFor(10 * SIZE + 882 + SIZE));
    expect(act2.insertFrames).toBe(0);
    expect(act2.dropFrames).toBe(0);
    expect(act2.realigned).toBe(false);
  });

  it("★ 内容超前 20ms(重叠)→ 裁头 882 帧(pos 不推进,输出被丢弃)且 RTP 自洽无需跳帧", () => {
    const a = new BridgeTimelineAligner(A, RATE);
    feed(a, 10);
    const act = a.onFrame(tsUsFor(10 * SIZE - 882)); // tsUs 倒回 20ms
    expect(act.dropFrames).toBeGreaterThanOrEqual(880);
    expect(act.dropFrames).toBeLessThanOrEqual(884);
    expect(act.insertFrames).toBe(0);
    expect(act.realigned).toBe(true);
    expect(a.contentPos).toBe(10 * SIZE); // 裁头不推进内容位置
    expect(a.pendingDrops).toBe(act.dropFrames);
    const consumed = a.takeDrop(SIZE); // 从本帧输出中丢弃
    expect(consumed).toBe(act.dropFrames);
    a.produced(SIZE - consumed); // 只追加未裁部分
    expect(a.contentPos).toBe(10 * SIZE + SIZE - consumed); // 追加流连续,自动回落源时间线
    // 续帧无动作(裁头后对齐已重同步,无需补静音)
    const act2 = step(a, tsUsFor(10 * SIZE - 882 + SIZE));
    expect(act2.insertFrames).toBe(0);
    expect(act2.dropFrames).toBe(0);
  });

  it("★ 欠料超上限(3s)→ skip:不物化静音,内容位置直接跳到 target", () => {
    const a = new BridgeTimelineAligner(A, RATE);
    feed(a, 5);
    expect(a.contentPos).toBe(5 * SIZE);
    const act = a.onFrame(tsUsFor(5 * SIZE + 132300)); // 3s 空洞
    expect(act.insertFrames).toBe(0);
    expect(act.skipFrames).toBe(act.diff);
    expect(act.skipFrames).toBeGreaterThan(RATE * 2); // 超 2s 上限
    expect(a.contentPos).toBe(5 * SIZE + act.skipFrames);
    expect(a.pendingDrops).toBe(0);
    a.produced(SIZE); // 本帧输出
    const act2 = step(a, tsUsFor(5 * SIZE + 132300 + SIZE));
    expect(act2.insertFrames).toBe(0);
    expect(act2.dropFrames).toBe(0);
  });

  it("1ms < drift ≤ 10ms → 只记 realigned 不动作;≤1ms 不记", () => {
    // 5ms(220 帧 < 441 阈值):无动作但记 realigned
    const a = new BridgeTimelineAligner(A, RATE);
    feed(a, 10);
    const act5ms = a.onFrame(tsUsFor(10 * SIZE + 220));
    expect(act5ms.insertFrames).toBe(0);
    expect(act5ms.dropFrames).toBe(0);
    expect(act5ms.realigned).toBe(true);
    expect(a.realignments).toBe(1);
    // 13 帧(≈295µs):无动作也不记
    const b = new BridgeTimelineAligner(A, RATE);
    feed(b, 10);
    const actSubMs = b.onFrame(tsUsFor(10 * SIZE + 13));
    expect(actSubMs.realigned).toBe(false);
    expect(b.realignments).toBe(0);
    expect(Math.abs(b.lastDriftUs)).toBeLessThanOrEqual(1000);
  });

  it("padded:欠料静音补块占据内容时间线", () => {
    const a = new BridgeTimelineAligner(A, RATE);
    a.padded(352);
    expect(a.contentPos).toBe(352);
    a.padded(0);
    expect(a.contentPos).toBe(352);
  });
});

// ---------------------------------------------------------------------------
// planBridgeAnchor(§3.3 可达性 + MIN-01 符号)
// ---------------------------------------------------------------------------

describe("planBridgeAnchor", () => {
  const RATE = 44100;
  const LATENCY = 44100;
  const L_US = 1_000_000;
  const SAFETY_US = RAOP_SAFETY_MS * 1000;

  it("★ 可达:A = 首帧 tsUs 原样;baseTs 352 对齐;A′ = A + 0.3627ms(MIN-01 补偿方向)", () => {
    const now = 5_000_000_000n;
    const first = now + BigInt(L_US + SAFETY_US) + 500_000n;
    const plan = planBridgeAnchor({ firstFrameTsUs: first, latencyFrames: LATENCY, rate: RATE, resampled: true, nowUs: now });
    expect(plan.reAnchored).toBe(false);
    expect(plan.anchorUs).toBe(first);
    expect(plan.anchors.baseTs % 352).toBe(0);
    expect(plan.anchors.startTs).toBe(plan.anchors.baseTs);
    expect(plan.anchors.headTs).toBe(plan.anchors.baseTs);
    // 群延迟补偿:16/44100·1e6 = 362.81µs → 363µs;方向 = 锚点后移(脉冲单测钉过符号)
    expect(Number(plan.anchors.anchorUsShifted - plan.anchorUs)).toBe(363);
    // startNtp = ntpFromHostUs(A′ − L)(host µs 往返误差 ≤1µs)
    const lUs = BigInt(Math.round((LATENCY / RATE) * 1e6));
    const roundTrip = ntpToHostUs(plan.anchors.startNtp);
    expect(Math.abs(Number(plan.anchors.anchorUsShifted - lUs - roundTrip))).toBeLessThanOrEqual(1);
  });

  it("★ 不可达(A−L−SAFETY < now):A = now + warmLead 重锚,commandedLeadUs = warmLead", () => {
    const now = 5_000_000_000n;
    const first = now + 100_000n; // 首帧已近,但 A−L−SAFETY 早已过去
    const plan = planBridgeAnchor({ firstFrameTsUs: first, latencyFrames: LATENCY, rate: RATE, resampled: true, nowUs: now });
    expect(plan.reAnchored).toBe(true);
    expect(plan.anchorUs).toBe(now + BigInt(BRIDGE_WARM_START_LEAD_US));
    expect(plan.commandedLeadUs).toBe(BigInt(BRIDGE_WARM_START_LEAD_US));
  });

  it("★ 48k 直通(resampled=false):A′ = A,零群延迟补偿", () => {
    const now = 5_000_000_000n;
    const first = now + BigInt(L_US + SAFETY_US) + 500_000n;
    const plan = planBridgeAnchor({ firstFrameTsUs: first, latencyFrames: LATENCY, rate: 48000, resampled: false, nowUs: now });
    expect(plan.anchors.anchorUsShifted).toBe(plan.anchorUs);
  });
});

// ---------------------------------------------------------------------------
// stats tick(§10.5)/ anchor report(§3.5)
// ---------------------------------------------------------------------------

function parseLoggedJson(spy: { mock: { calls: unknown[][] } }, marker: string): Record<string, unknown> {
  const lines = spy.mock.calls.map((c) => c.map(String).join(" ")) as string[];
  const line = lines.find((l) => l.includes(marker));
  expect(line).toBeTruthy();
  return JSON.parse(line!.slice(line!.indexOf("{"))) as Record<string, unknown>;
}

describe("stats tick / anchor report", () => {
  it("★ tick:一行 JSON,§10.5 字段齐全,clock=local-rtp-ntp(两台成员同源判据)", () => {
    const s = mkSession();
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      (s as any).connected = true;
      (s as any).generation = 7;
      (s as any).emitStatsTick();
      const obj = parseLoggedJson(spy, '"ev":"tick"');
      expect(obj.clock).toBe("local-rtp-ntp");
      expect(obj.dev).toBe(s.deviceId);
      expect(obj.gen).toBe(7);
      expect(obj.state).toBe("connected");
      expect(obj.mapping).toBeUndefined(); // mapping 只属于 anchor 事件
      for (const k of ["queueMs", "maxQueueMs", "late", "realigned", "driftUs", "deltaUs", "deltaP95Us", "samples", "anchorUs", "leadUs"]) {
        expect(k in obj).toBe(true);
      }
    } finally {
      spy.mockRestore();
    }
  });

  it("★ anchor report:scheduledAnchorUs 上报 + mapping + 无 ack 伪造(§3.5)", () => {
    const s = mkSession();
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      const now = 5_000_000_000n;
      const plan = planBridgeAnchor({
        firstFrameTsUs: now + 3_000_000n,
        latencyFrames: 44100,
        rate: 44100,
        resampled: true,
        nowUs: now,
      });
      (s as any).emitAnchorReport(plan, 44100);
      const obj = parseLoggedJson(spy, '"ev":"anchor"');
      expect(obj.mapping).toBe("local-rtp-ntp");
      expect(obj.scheduledAnchorUs).toBe(Number(plan.anchorUs));
      expect(obj.commandedLeadUs).toBe(3_000_000);
      expect(obj.latePackets).toBe(0);
      expect(obj.latencyFrames).toBe(44100);
      expect("acked" in obj).toBe(false); // 绝不假装收到设备播放确认
    } finally {
      spy.mockRestore();
    }
  });

  it("snapshot:含锚点/代次/latePackets(状态通道上报口)", async () => {
    const s = mkSession();
    await s.start();
    const snap = s.snapshot();
    expect(snap.anchored).toBe(false);
    expect(snap.anchorUs).toBeNull();
    expect(snap.generation).toBe(0);
    expect(snap.latePackets).toBe(0);
    expect(snap.stats.silenceChunks).toBe(0);
    expect(snap.streaming).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 完整驱动链(§8 Phase 4 出口判据)
// ---------------------------------------------------------------------------

describe("完整驱动链(dry)", () => {
  it("★ 1kHz 正弦 48k→(对齐旁路+147/160 重采样+352 帧出块)→44.1k:基频偏差 ≤0.5%", async () => {
    const s = mkSession({ waitDataMs: 20 });
    await s.start();
    const inRate = 48000;
    const durSec = 5;
    const total = durSec * inRate;
    const step = 960;
    const t0 = 1_000_000_000n;
    for (let off = 0; off < total; off += step) {
      const n = Math.min(step, total - off);
      const buf = Buffer.alloc(n * 4);
      for (let i = 0; i < n; i++) {
        const v = Math.round(Math.sin((2 * Math.PI * 1000 * (off + i)) / inRate) * 12000);
        buf.writeInt16LE(v, i * 4);
        buf.writeInt16LE(v, i * 4 + 2);
      }
      (s as any).ingestAudio({
        tsUs: t0 + BigInt(Math.round((off / inRate) * 1e6)),
        generation: 1,
        sequence: off / step + 1,
        payload: new Uint8Array(buf),
      });
    }
    // 排空:队列空且余料不足一个 chunk 即停(重采样尾巴按 Phase 1 口径丢弃)
    const chunks: Buffer[] = [];
    for (;;) {
      if ((s as any).inBytes === 0 && (s as any).outBuf.length < 1408) break;
      const c = await (s as any).pullChunk();
      if (!c) break;
      chunks.push(c);
    }
    const all = Buffer.concat(chunks);
    const frames = all.length >> 2;
    expect(frames).toBeGreaterThan(durSec * 44100 * 0.99);
    // 过零计数测基频(左声道正过零次数 / 时长)
    let crossings = 0;
    let prev = all.readInt16LE(0);
    for (let i = 1; i < frames; i++) {
      const v = all.readInt16LE(i * 4);
      if (prev < 0 && v >= 0) crossings++;
      prev = v;
    }
    const freq = crossings / (frames / 44100);
    expect(Math.abs(freq - 1000) / 1000).toBeLessThanOrEqual(0.005);
    // 稳态喂料:零静音补块、零对齐动作
    expect(s.stats.silenceChunks).toBe(0);
    expect(s.stats.framesIn).toBe(total);
    expect(s.stats.insertedFrames).toBe(0);
    expect(s.stats.droppedFrames).toBe(0);
    expect(s.stats.realignments).toBe(0);
  });
});
