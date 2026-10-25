// ==================== Phase 4:RaopPlayer.streamBridge 四锚点驱动(§3.3/§3.5/§4.5) ====================
//
// 钉死(出口判据可机械验证部分):
//   ① 首包 sendAt 不早于 A′−L−SAFETY 超过 5ms;可达锚点 latePackets=0(假时钟注入);
//   ② 锚点不可达(sendAt 已过期):追发不改 RTP 映射,latePackets 逐包累加;
//   ③ 四字段锚点:RTP ts 从 baseTs 起步按 352 推进;首包 0xE0 marker;
//      SYNC offset4 = headTs−L、offset8 = startNtp(elapsed=0)、offset16 = headTs;
//   ④ host 纪元 >27h(MAJ-10):baseTs 352 对齐、模域回绕安全、positionSec 正确;
//   ⑤ latencyFrames 自锚点写入(L 不归零);bridgeSkipFrames 动 startTs 不动 baseTs。
import "../plugins/_env.js";

import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it } from "vitest";

import { computeBridgeAnchors } from "../../src/services/airplay/bridgeMath.js";
import { CHUNK_LEN, RaopPlayer, type RaopBridgeAnchor, type RaopSession } from "../../src/services/airplay/raop.js";
import { RAOP_SAFETY_MS } from "../../src/services/airplay/rates.js";
import { setNowUsOverride } from "../../src/utils/hostClock.js";

const HOST = "192.168.1.50";
const RATE = 44100;
const LATENCY_FRAMES = 44100; // libraop 缺省 1s 深度(RECORD 协商,不得归零)

/** 假 UDP socket:记录每个包的发出时刻(Date.now,与 setNowUsOverride 的 Date.now 纪元一致)。 */
class FakeUdp extends EventEmitter {
  addr = HOST;
  port: number;
  closed = false;
  sent: Array<{ buf: Buffer; port: number; addr: string; atMs: number }> = [];

  constructor(port: number) {
    super();
    this.port = port;
  }

  send(buf: Buffer, ...rest: unknown[]): void {
    let payload: Buffer;
    let port: number;
    let addr: string;
    if (Buffer.isBuffer(rest[0])) {
      // send(msg, offset, length, port, addr)
      const off = rest[0] as number;
      const len = rest[1] as number;
      payload = Buffer.from(buf.subarray(off, off + len));
      port = rest[2] as number;
      addr = rest[3] as string;
    } else {
      payload = Buffer.from(buf);
      port = rest[0] as number;
      addr = rest[1] as string;
    }
    this.sent.push({ buf: payload, port, addr, atMs: Date.now() });
  }

  address() {
    return { address: this.addr, port: this.port, family: "IPv4" };
  }

  close() {
    this.closed = true;
  }
}

const players: Array<{ p: RaopPlayer; anyP: Record<string, unknown> }> = [];

function makeBridgePlayer(): { p: RaopPlayer; anyP: any; audio: FakeUdp; ctrl: FakeUdp; time: FakeUdp } {
  const p = new RaopPlayer({ host: HOST });
  const audio = new FakeUdp(6001);
  const ctrl = new FakeUdp(6002);
  const time = new FakeUdp(6003);
  const anyP = p as any;
  anyP.audioSocket = audio;
  anyP.ctrlSocket = ctrl;
  anyP.timeSocket = time;
  anyP.url = `rtsp://${HOST}:5000/1234567890`;
  players.push({ p, anyP });
  return { p, anyP, audio, ctrl, time };
}

afterEach(() => {
  // 收口:清 sync 定时器,否则进程会挂着等它触发。
  for (const { anyP } of players) {
    if (anyP.syncTimer) clearInterval(anyP.syncTimer);
  }
  players.length = 0;
  setNowUsOverride(null);
});

function fakeSession(): RaopSession {
  return { session: "test", audioPort: 7000, controlPort: 7001, timingPort: 7002 };
}

function pcmChunk(): Buffer {
  return Buffer.alloc(CHUNK_LEN * 4, 1);
}

/** 用 computeBridgeAnchors 产出四字段,并组装 streamBridge 入参。 */
function mkAnchor(anchorUs: bigint, latencyFrames = LATENCY_FRAMES, rate = RATE): { anchors: ReturnType<typeof computeBridgeAnchors>; arg: RaopBridgeAnchor } {
  const anchors = computeBridgeAnchors({ anchorUs, latencyFrames, rate, chunkLen: CHUNK_LEN });
  const arg: RaopBridgeAnchor = {
    baseTs: anchors.baseTs,
    startTs: anchors.startTs,
    headTs: anchors.headTs,
    startNtp: anchors.startNtp,
    anchorUsShifted: anchors.anchorUsShifted,
    anchorUs,
    latencyFrames,
    rate,
  };
  return { anchors, arg };
}

describe("streamBridge:发送节拍(§3.3)", () => {
  it("★ 首包 sendAt 不早于 A′−L−SAFETY 超过 5ms;可达锚点 latePackets=0", async () => {
    setNowUsOverride(() => BigInt(Date.now()) * 1000n);
    const { p, audio } = makeBridgePlayer();
    const anchorMs = Date.now() + 1200; // A 在 1.2s 后 ⇒ sendAt ≈ +150ms(未来)
    const { arg } = mkAnchor(BigInt(anchorMs) * 1000n);
    let sends = 0;
    await p.streamBridge(async () => (sends++ < 5 ? pcmChunk() : null), fakeSession(), arg);
    expect(p.bridgeLateCount).toBe(0);
    expect(audio.sent.length).toBe(5);
    const gdMs = (16 / RATE) * 1000; // 重采样群延迟 0.3628ms
    const sendAtMs = anchorMs + gdMs - (LATENCY_FRAMES / RATE) * 1000 - RAOP_SAFETY_MS;
    // 🔴 出口判据:实际首包发出时刻不得早于 sendAt 超过 5ms
    expect(audio.sent[0].atMs).toBeGreaterThanOrEqual(sendAtMs - 5);
  });

  it("★ 锚点不可达(sendAt 已过期):追发不改 RTP 映射,latePackets 逐包累加", async () => {
    setNowUsOverride(() => BigInt(Date.now()) * 1000n);
    const { p, audio } = makeBridgePlayer();
    const { arg } = mkAnchor(BigInt(Date.now() + 100) * 1000n); // sendAt ≈ 950ms 前 ⇒ 已过期
    let sends = 0;
    await p.streamBridge(async () => (sends++ < 5 ? pcmChunk() : null), fakeSession(), arg);
    expect(p.bridgeLateCount).toBe(5);
    for (let i = 0; i < 5; i++) {
      expect(audio.sent[i].buf.readUInt32BE(4)).toBe((arg.baseTs + i * CHUNK_LEN) >>> 0);
    }
  });
});

describe("streamBridge:四字段锚点(MAJ-09/§3.3)", () => {
  it("★ RTP ts 从 baseTs 起步按 352 推进;首包 0xE0 marker;SYNC 映射 (headTs−L)↔startNtp", async () => {
    setNowUsOverride(() => BigInt(Date.now()) * 1000n);
    const { p, anyP, audio, ctrl } = makeBridgePlayer();
    const { anchors, arg } = mkAnchor(BigInt(Date.now() + 1200) * 1000n); // A 在 1.2s 后 ⇒ sendAt ≈ +150ms
    let sends = 0;
    await p.streamBridge(async () => (sends++ < 3 ? pcmChunk() : null), fakeSession(), arg);
    expect(audio.sent[0].buf[0]).toBe(0x80);
    expect(audio.sent[0].buf[1]).toBe(0xe0); // 首包 marker
    expect(audio.sent[0].buf.readUInt32BE(4)).toBe(anchors.baseTs >>> 0);
    expect(audio.sent[1].buf.readUInt32BE(4)).toBe((anchors.baseTs + CHUNK_LEN) >>> 0);
    expect(audio.sent[2].buf[1]).toBe(0x60); // 非首包无 marker
    // L 自锚点写入(不得归零);RECORD 缺省深度被显式沿用
    expect(anyP.latencyFrames).toBe(LATENCY_FRAMES);
    // libraop 语义:首包后才发首条 SYNC;此刻 headTs 已被 sendChunk 推进一包
    // (offset4 = headTs−L、offset8 = startNtp + elapsed)—— 与旧 stream() 同一口径,
    // 恒定 ≤8ms 共模偏差,同组各设备一致,不影响互相对齐。
    expect(ctrl.sent.length).toBeGreaterThanOrEqual(1);
    const sync = ctrl.sent[0].buf;
    expect(sync.length).toBe(20);
    expect(sync[0] & 0x10).toBe(0x10); // first sync 标记
    expect(sync[1] & 0x7f).toBe(0x54);
    expect(sync.readUInt32BE(4)).toBe((anchors.baseTs + CHUNK_LEN - LATENCY_FRAMES) >>> 0);
    const elapsedNtp = ((BigInt(CHUNK_LEN) << 16n) / BigInt(RATE)) << 16n;
    const expectNtp = anchors.startNtp + elapsedNtp;
    expect(sync.readUInt32BE(8)).toBe(Number(expectNtp >> 32n));
    expect(sync.readUInt32BE(12)).toBe(Number(expectNtp & 0xffffffffn));
    expect(sync.readUInt32BE(16)).toBe((anchors.baseTs + CHUNK_LEN) >>> 0);
  });

  it("★ host 纪元 >27h(MAJ-10):baseTs 352 对齐 + 模域回绕安全 + positionSec 正确", async () => {
    const bootUs = 100_000n * 1_000_000n; // 开机 27.78h(> 2^32/44100 ≈ 27.05h)
    const t0 = Date.now();
    setNowUsOverride(() => bootUs + BigInt((Date.now() - t0) * 1000));
    const { p, anyP, audio } = makeBridgePlayer();
    const { anchors, arg } = mkAnchor(bootUs + 1_200_000n);
    expect(anchors.baseTs % CHUNK_LEN).toBe(0);
    expect(anchors.baseTs).toBeLessThanOrEqual(0xffffffff);
    let sends = 0;
    await p.streamBridge(async () => (sends++ < 3 ? pcmChunk() : null), fakeSession(), arg);
    expect(p.bridgeLateCount).toBe(0);
    expect(audio.sent[0].buf.readUInt32BE(4)).toBe(anchors.baseTs >>> 0);
    // 3 包后内容位置 ≈ 3·352/44100 ≈ 23.9ms(ts2ms 毫秒精度)
    expect(p.positionSec).toBeCloseTo(0.024, 2);
    expect(anyP.latencyFrames).toBe(LATENCY_FRAMES);
  });
});

describe("bridgeSkipFrames / negotiatedLatencyFrames(§4.5 裁头支撑)", () => {
  it("★ 裁头前移 startTs、baseTs 不动(positionSec = 内容位置语义保持,MAJ-09)", () => {
    const { p, anyP } = makeBridgePlayer();
    const { anchors } = mkAnchor(BigInt(Date.now() + 1_000_000) * 1000n);
    anyP.baseTs = anchors.baseTs;
    anyP.startTs = anchors.startTs;
    anyP.headTs = anchors.headTs;
    anyP.startNtp = anchors.startNtp;
    p.bridgeSkipFrames(700);
    expect(anyP.startTs).toBe((anchors.baseTs + 700) >>> 0);
    expect(anyP.baseTs).toBe(anchors.baseTs >>> 0);
    expect(anyP.headTs).toBe(anchors.headTs >>> 0);
    p.bridgeSkipFrames(0);
    p.bridgeSkipFrames(-5);
    p.bridgeSkipFrames(Number.NaN);
    expect(anyP.startTs).toBe((anchors.baseTs + 700) >>> 0); // 无效输入不动
  });

  it("negotiatedLatencyFrames:RECORD 协商深度的唯一出口(缺省 1s)", () => {
    const { p } = makeBridgePlayer();
    expect(p.negotiatedLatencyFrames).toBe(RATE);
  });
});
