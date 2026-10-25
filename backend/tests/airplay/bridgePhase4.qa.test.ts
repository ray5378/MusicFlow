// ==================== 【QA 对抗性用例】Phase 4 时间线映射+对齐+无 ack 语义 ====================
//
// ① RTP 32 位回绕两侧(MAJ-10):baseTs 取 ≤2^32 的最大 352 对齐值,流中途越过 2^32 →
//    RTP 时间戳连续回绕、sendAt 判据仍成立、positionSec 正确;baseTs=0 边界;
// ② drift 双方向(§4.5):落后 20ms → 补静音恰 882 帧(=3528B);超前 20ms → 裁头 882 帧
//    且续帧零动作;落后 3s → skip(不物化静音)+ 滞留旧帧按 drop 出清;
// ③ 迟到:producer 中途阻塞越过 sendAt → latePackets 递增且 RTP 时间戳连续(追发不改映射);
// ④ 1kHz 正弦完整驱动链(dry ingest→重采样→352 出块)落盘测频 ±0.5% + 时长/RMS;
// ⑤ §4.5 对齐参照修正验证:outBuf 常驻 pending 场景,「已追加输出内容前沿」口径零误判,
//    而文档字面「已写入 RAOP」口径会恒偏 pending ⇒ 假校正(数学演示钉住)。
import "../plugins/_env.js";

import { EventEmitter } from "node:events";

import { afterEach, describe, expect, it } from "vitest";

import {
  computeBridgeAnchors,
  ntpToRtpMod,
  rtpAt,
} from "../../src/services/airplay/bridgeMath.js";
import {
  BridgeTimelineAligner,
  BridgeSession,
} from "../../src/services/airplay/bridgeSession.js";
import { CHUNK_LEN, RaopPlayer, type RaopBridgeAnchor, type RaopSession } from "../../src/services/airplay/raop.js";
import { RAOP_SAFETY_MS } from "../../src/services/airplay/rates.js";
import { ntpFromHostUs, setNowUsOverride } from "../../src/utils/hostClock.js";

const HOST = "192.0.2.1"; // TEST-NET-1,不触真网
const RATE = 44100;
const LATENCY_FRAMES = 44100;
const MAX_U32 = 0xffffffff;
/** ≤ 2^32−1 的最大 352 对齐值(RTP 回绕前最后一个对齐 base)。 */
const LAST_ALIGNED_BEFORE_WRAP = Math.floor((MAX_U32 + 1) / CHUNK_LEN) * CHUNK_LEN - CHUNK_LEN;

class FakeUdp extends EventEmitter {
  sent: Array<{ buf: Buffer; atMs: number }> = [];
  constructor(public port: number) {
    super();
  }
  send(buf: Buffer, ...rest: unknown[]): void {
    let payload: Buffer;
    if (Buffer.isBuffer(rest[0])) payload = Buffer.from(buf.subarray(rest[0] as number, rest[1] as number));
    else payload = Buffer.from(buf);
    this.sent.push({ buf: payload, atMs: Date.now() });
  }
  address() {
    return { address: HOST, port: this.port, family: "IPv4" };
  }
  close() {}
}

const cleanup: Array<() => void> = [];
afterEach(() => {
  while (cleanup.length) cleanup.pop()!();
  setNowUsOverride(null);
});

function makeBridgePlayer(): { p: RaopPlayer; anyP: any; audio: FakeUdp } {
  const p = new RaopPlayer({ host: HOST });
  const audio = new FakeUdp(6001);
  const anyP = p as any;
  anyP.audioSocket = audio;
  anyP.ctrlSocket = new FakeUdp(6002);
  anyP.timeSocket = new FakeUdp(6003);
  anyP.url = `rtsp://${HOST}:5000/1234567890`;
  cleanup.push(() => {
    if (anyP.syncTimer) clearInterval(anyP.syncTimer);
  });
  return { p, anyP, audio };
}

const fakeSession = (): RaopSession => ({ session: "qa4", audioPort: 7000, controlPort: 7001, timingPort: 7002 });
const pcmChunk = (): Buffer => Buffer.alloc(CHUNK_LEN * 4, 1);

function mkAnchorArg(anchorUs: bigint, opts: { rtpBase?: number; latencyFrames?: number } = {}): RaopBridgeAnchor {
  const anchors = computeBridgeAnchors({
    anchorUs,
    latencyFrames: opts.latencyFrames ?? LATENCY_FRAMES,
    rate: RATE,
    chunkLen: CHUNK_LEN,
    ...(opts.rtpBase !== undefined ? { rtpBase: opts.rtpBase } : {}),
  });
  return {
    baseTs: anchors.baseTs,
    startTs: anchors.startTs,
    headTs: anchors.headTs,
    startNtp: anchors.startNtp,
    anchorUsShifted: anchors.anchorUsShifted,
    anchorUs,
    latencyFrames: opts.latencyFrames ?? LATENCY_FRAMES,
    rate: RATE,
  };
}

// ---------------------------------------------------------------------------
// ① RTP 32 位回绕两侧(MAJ-10)
// ---------------------------------------------------------------------------

describe("QA① RTP 回绕两侧:流中越过 2^32 连续性 + sendAt + positionSec", () => {
  it("baseTs 取回绕前最后对齐值 → 100 包跨 2^32:RTP ts 公式连续、sendAt 不早发、positionSec 含跨回绕内容", async () => {
    const bootUs = 100_000n * 1_000_000n; // 纪元 >27h
    const t0 = Date.now();
    setNowUsOverride(() => bootUs + BigInt((Date.now() - t0) * 1000));
    const { p, audio } = makeBridgePlayer();
    expect(LAST_ALIGNED_BEFORE_WRAP % CHUNK_LEN).toBe(0);
    expect(LAST_ALIGNED_BEFORE_WRAP).toBeGreaterThan(MAX_U32 - 4 * CHUNK_LEN); // 确实贴着回绕线
    const arg = mkAnchorArg(bootUs + 1_200_000n, { rtpBase: LAST_ALIGNED_BEFORE_WRAP });
    expect(arg.baseTs).toBe(LAST_ALIGNED_BEFORE_WRAP);

    const N = 100; // 35200 帧 ≈ 0.8s → 必然越过 2^32
    let sends = 0;
    await p.streamBridge(async () => (sends++ < N ? pcmChunk() : null), fakeSession(), arg);

    expect(audio.sent.length).toBe(N);
    // 全程 (baseTs + i·352) mod 2^32 连续 —— 含回绕点两侧
    for (let i = 0; i < N; i++) {
      expect(audio.sent[i]!.buf.readUInt32BE(4)).toBe((arg.baseTs + i * CHUNK_LEN) >>> 0);
    }
    // 至少一个包已回绕到小值(确证真的跨过了 2^32)
    const wrapped = audio.sent.filter((s) => s.buf.readUInt32BE(4) < N * CHUNK_LEN);
    expect(wrapped.length).toBeGreaterThan(0);
    // sendAt 判据在回绕场景下不劣化:首包不早于 A′−L−SAFETY 超 5ms
    const gdMs = (16 / RATE) * 1000;
    const sendAtMs = t0 + 1200 + gdMs - (LATENCY_FRAMES / RATE) * 1000 - RAOP_SAFETY_MS;
    expect(audio.sent[0]!.atMs).toBeGreaterThanOrEqual(sendAtMs - 5);
    // positionSec:100 包后内容位置 ≈ 35200/44100 ≈ 0.798s(ts2ms 毫秒精度)
    expect(p.positionSec).toBeGreaterThan(0.79);
    expect(p.positionSec).toBeLessThan(0.81);
    expect(p.bridgeLateCount).toBe(0);
  }, 20000);

  it("baseTs=0 边界 + rtpAt/ntpToRtpMod 回绕纯函数:对齐恒保持、两侧一致", () => {
    // ntpToRtpMod:先 >>>0 再 352 对齐 —— 贴回绕线的 ntp 也必须出对齐值
    const usNearWrap = BigInt(Math.floor((MAX_U32 + 1) * 1e6 / RATE)); // 恰好映射到 2^32 附近
    for (const delta of [-3n, -1n, 0n, 1n, 3n]) {
      const ts = ntpToRtpMod(ntpFromHostUs(usNearWrap + delta), RATE, CHUNK_LEN);
      expect(ts % CHUNK_LEN).toBe(0);
      expect(ts).toBeGreaterThanOrEqual(0);
      expect(ts).toBeLessThanOrEqual(MAX_U32);
    }
    // rtpAt 跨回绕:baseTs 贴线 + 目标越过 2^32 → 结果 = 低侧值(连续回绕)
    const base = LAST_ALIGNED_BEFORE_WRAP;
    const t0 = 1_000_000n;
    const across = rtpAt(t0 + BigInt(Math.round((3 * CHUNK_LEN / RATE) * 1e6)), t0, base, RATE);
    expect(across).toBe((base + 3 * CHUNK_LEN) >>> 0);
    expect(across).toBeLessThan(CHUNK_LEN * 4); // 已回绕到低侧
    // baseTs=0:352 对齐恒 0,不产生负值
    expect(ntpToRtpMod(0n, RATE, CHUNK_LEN)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// ② drift 双方向(§4.5)
// ---------------------------------------------------------------------------

describe("QA② drift 双方向:补静音精确 / 裁头不跳帧 / 超限 skip", () => {
  const A = 5_000_000_000n;
  const a = () => new BridgeTimelineAligner(A, RATE);
  const tsUsFor = (frames: number): bigint => A + BigInt(Math.round((frames / RATE) * 1e6));
  const SIZE = 900; // ≈20.4ms/帧输出

  it("落后 20ms(有洞)→ 补静音恰 882 帧(=3528B 静音字节),续帧恢复零动作", () => {
    const al = a();
    for (let i = 0; i < 10; i++) {
      const act = al.onFrame(tsUsFor(i * SIZE));
      expect(act.insertFrames).toBe(0);
      al.produced(SIZE);
    }
    expect(al.contentPos).toBe(9000);
    const act = al.onFrame(tsUsFor(9000 + 882)); // 20000µs 整空洞
    expect(act.insertFrames).toBe(882); // 882·4 = 3528 字节静音,精确
    expect(act.dropFrames).toBe(0);
    expect(act.skipFrames).toBe(0);
    expect(act.realigned).toBe(true); // >1ms 记 realigned
    expect(al.contentPos).toBe(9882); // 静音占据真实时间线
    al.produced(SIZE);
    const next = al.onFrame(tsUsFor(9882 + SIZE));
    expect(next.insertFrames).toBe(0);
    expect(next.dropFrames).toBe(0);
  });

  it("超前 20ms(重叠)→ 裁头 882 帧、pos 不推进、RTP 无需跳帧,续帧零动作", () => {
    const al = a();
    for (let i = 0; i < 10; i++) {
      al.onFrame(tsUsFor(i * SIZE));
      al.produced(SIZE);
    }
    // 重叠帧:源时间线倒退 882 帧
    const act = al.onFrame(tsUsFor(9000 - 882));
    expect(act.dropFrames).toBe(882);
    expect(act.insertFrames).toBe(0);
    expect(act.skipFrames).toBe(0);
    expect(al.contentPos).toBe(9000); // 裁头不推进 pos
    // 裁头从重采样输出中出清(真实 resampleIn 次序):900 帧输出裁 882,余 18 追加
    expect(al.takeDrop(900)).toBe(882);
    expect(al.pendingDrops).toBe(0);
    al.produced(SIZE - 882);
    expect(al.contentPos).toBe(9018);
    // 续帧回到源时间线 → 零动作(RTP 时间线自洽,无需 bridgeSkipFrames)
    const next = al.onFrame(tsUsFor(9018));
    expect(next.insertFrames).toBe(0);
    expect(next.dropFrames).toBe(0);
    expect(next.skipFrames).toBe(0);
  });

  it("落后 3s(>2s 上限)→ skip 不物化静音;滞留旧帧按 drop 出清后归零", () => {
    const al = a();
    for (let i = 0; i < 10; i++) {
      al.onFrame(tsUsFor(i * SIZE));
      al.produced(SIZE);
    }
    const act = al.onFrame(tsUsFor(9000 + 3 * RATE)); // 3s 空洞 > 2s cap
    expect(act.skipFrames).toBe(3 * RATE); // 直接跳,不 insert
    expect(act.insertFrames).toBe(0);
    expect(al.contentPos).toBe(9000 + 3 * RATE);
    // 跳段前发出的在途旧帧(tsUs 仍在跳段前时间线)→ 按 drop 出清,绝不混入新时间线
    const stale = al.onFrame(tsUsFor(9900));
    expect(stale.dropFrames).toBe(9000 + 3 * RATE - 9900);
    al.produced(0); // 旧帧输出被全部裁掉
    // 新时间线帧 → 零动作
    const fresh = al.onFrame(tsUsFor(9000 + 3 * RATE));
    expect(fresh.insertFrames).toBe(0);
    expect(fresh.dropFrames).toBe(0);
    expect(fresh.skipFrames).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// ⑤ §4.5 对齐参照修正:前沿口径 vs 文档字面「已写入 RAOP」口径
// ---------------------------------------------------------------------------

describe("QA⑤ outBuf 常驻 pending:前沿口径零误判,字面口径必然假校正", () => {
  it("启动 lead 阶段 RAOP 未消费 → 真实实现(前沿)零补零裁;字面口径 diff 恒 = pending >> 阈值", () => {
    const A = 5_000_000_000n;
    const al = new BridgeTimelineAligner(A, RATE);
    const tsUsFor = (frames: number): bigint => A + BigInt(Math.round((frames / RATE) * 1e6));
    let written = 0; // 模拟「已写入 RAOP」的帧数(落后于追加前沿 = outBuf pending)
    for (let i = 0; i < 40; i++) {
      const act = al.onFrame(tsUsFor(i * 900));
      expect(act.insertFrames).toBe(0); // 前沿口径:pending 不构成漂移,零动作
      expect(act.dropFrames).toBe(0);
      al.produced(900);
      if (i % 2 === 0) written += 900; // RAOP 消费慢一拍:pending 累积至 ~40 帧级
    }
    const pending = 40 * 900 - written;
    // 字面口径 diff = target − written = pending —— 远超 441 阈值 ⇒ 每帧都会假触发
    expect(pending).toBeGreaterThan(441);
    // 前沿口径残差恒 <5 帧(与稳态同水平)
    expect(Math.abs(al.lastDriftUs)).toBeLessThan(200);
  });
});

// ---------------------------------------------------------------------------
// ③ 迟到:producer 阻塞越过 sendAt
// ---------------------------------------------------------------------------

describe("QA③ producer 阻塞越过 sendAt → latePackets 递增且 RTP 连续", () => {
  it("第 3 包阻塞 300ms → 后续包全 late;RTP ts 恒 = baseTs+i·352(追发不改映射)", async () => {
    setNowUsOverride(() => BigInt(Date.now()) * 1000n);
    const { p, audio } = makeBridgePlayer();
    const arg = mkAnchorArg(BigInt(Date.now() + 1_200) * 1000n); // 可达锚点
    let sends = 0;
    const producer = async (): Promise<Buffer | null> => {
      if (sends >= 6) return null;
      sends++;
      if (sends === 3) await new Promise((r) => setTimeout(r, 300)); // 阻塞越过 sendAt(3..5)
      return pcmChunk();
    };
    await p.streamBridge(producer, fakeSession(), arg);

    expect(audio.sent.length).toBe(6);
    expect(p.bridgeLateCount).toBeGreaterThanOrEqual(3); // 包 3/4/5 迟到
    for (let i = 0; i < 6; i++) {
      // RTP 时间戳连续:迟到只影响发送时刻,不改映射
      expect(audio.sent[i]!.buf.readUInt32BE(4)).toBe((arg.baseTs + i * CHUNK_LEN) >>> 0);
    }
    // 迟到段相邻包发送间隔 < 8ms(追发,不按节拍硬等)
    const lateGaps: number[] = [];
    for (let i = 4; i < 6; i++) lateGaps.push(audio.sent[i]!.atMs - audio.sent[i - 1]!.atMs);
    for (const gap of lateGaps) expect(gap).toBeLessThan(50);
  }, 20000);
});

// ---------------------------------------------------------------------------
// ④ 1kHz 正弦完整驱动链(dry)落盘测频
// ---------------------------------------------------------------------------

describe("QA④ 1kHz 正弦完整驱动链落盘:测频 ±0.5% + 时长 + RMS", () => {
  it("5s 1kHz/48k → dry ingest → 147/160 重采样 → 352 帧出块 → 频率 1000Hz ±0.5%", async () => {
    const n = Math.floor(Math.random() * 1e9);
    const s = new BridgeSession({
      deviceId: `qa4-${n}`,
      token: `qa4-${n}`,
      protocol: "raop",
      socketPath: `qa4-${n}.sock`,
      dry: true,
      waitDataMs: 50,
    });
    cleanup.push(() => {
      void s.stop().catch(() => {});
    });
    const SECONDS = 5;
    const IN_RATE = 48000;
    const total = IN_RATE * SECONDS;
    // 20ms/帧(960 输入样本)逐帧 ingest(tsUs=0 → 干跑链路,对齐旁路,纯重采样+出块)
    for (let off = 0; off < total; off += 960) {
      const cnt = Math.min(960, total - off);
      const buf = Buffer.alloc(cnt * 4);
      for (let i = 0; i < cnt; i++) {
        const v = Math.round(Math.sin((2 * Math.PI * 1000 * (off + i)) / IN_RATE) * 20000);
        buf.writeInt16LE(v, i * 4);
        buf.writeInt16LE(v, i * 4 + 2);
      }
      s.ingest(buf);
    }
    // 逐 352 帧出块,收集至目标内容帧数(220500 = 5s@44.1k)为止 —— 最后一整块之后
    // 的 pullChunk 会因输入耗尽补整块静音,不能计入时长口径
    const targetFrames = Math.round((total / IN_RATE) * RATE);
    const out: Buffer[] = [];
    let acc = 0;
    for (let i = 0; i < 800 && acc < targetFrames; i++) {
      const chunk = await (s as unknown as { pullChunk(): Promise<Buffer | null> }).pullChunk();
      if (chunk === null) break;
      out.push(chunk);
      acc += chunk.length >> 2;
    }
    const pcm = Buffer.concat(out);
    const sampleFrames = Math.floor(pcm.length / 4);
    const durationSec = sampleFrames / RATE;
    let sumSq = 0;
    let crossings = 0;
    let prev = 0;
    for (let i = 0; i < sampleFrames; i++) {
      const v = pcm.readInt16LE(i * 4);
      sumSq += v * v;
      if ((v >= 0) !== (prev >= 0)) crossings++;
      prev = v;
    }
    const rmsDbfs = 20 * Math.log10(Math.sqrt(sumSq / sampleFrames) / 32768);
    const freq = crossings / 2 / durationSec;
    expect(Math.abs(durationSec - SECONDS) / SECONDS).toBeLessThanOrEqual(0.005); // 时长 ±0.5%
    expect(rmsDbfs).toBeGreaterThan(-40);
    expect(Math.abs(freq - 1000) / 1000).toBeLessThanOrEqual(0.005); // 测频 ±0.5%
    // 输入耗尽后仅收尾块(残余 <352 帧)合法补齐一次;中途欠料会 ≥2 且破坏 RMS/测频
    expect(s.stats.silenceChunks).toBeLessThanOrEqual(1);
  }, 30000);
});
