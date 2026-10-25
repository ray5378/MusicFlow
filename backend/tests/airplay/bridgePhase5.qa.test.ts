// ==================== Phase 5 QA:生命周期 / 暂停 / 重锚 / 残留清理 ====================
//
// 出口判据(可机械验证部分,§Phase 5):
//   ① 连续 seek 3 次:每次新 generation(ev:"gen")+ 新 scheduledAnchorUs(ev:"anchor"),
//      且旧 generation 帧丢弃计数 > 0(BLK-02 核心判据);
//   ② rehost(只动 timelineReseed 分量)→ 同样新 generation + 新锚点(R1 专项);
//   ③ stop 边界 → 停推流不重锚,RAOP 会话交给编排侧 bridgeStop;
//   ④ 链路 stall(sendspin 子进程崩溃)→ 立刻停推流,airplay 侧无残留播放;
//   ⑤ 暂停/恢复:暂停期 player.pause 冻结(不写静音不计 late),≤45s 恢复按「继续」,
//      >45s 按「锚点不可达」重锚(§5.4);
//   ⑥ streamBridge pacing rebase:恢复段 lag >2s 不计 latePackets(RTP 映射不动);
//   ⑦ mfab 残留 socket 清理:死链删除、活 listener 保留。
import "../plugins/_env.js";

import net from "node:net";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  cleanupStaleBridgeSockets,
  bridgeSocketPath,
  encodeHeartbeat,
  FrameDecoder,
  FRAME_FLAG_PAUSED,
  FRAME_TYPE,
} from "../../src/services/airplay/bridgeChannel.js";
import { BridgeSession } from "../../src/services/airplay/bridgeSession.js";
import { BridgeServer } from "../../src/services/airplay/bridgeServer.js";
import { CHUNK_LEN, RaopPlayer, type RaopSession } from "../../src/services/airplay/raop.js";
import { nowUs, setNowUsOverride } from "../../src/utils/hostClock.js";
import { EventEmitter } from "node:events";

// ---------------------------------------------------------------------------

const sessions: BridgeSession[] = [];
let servers: BridgeServer[] = [];

afterEach(async () => {
  while (sessions.length > 0) await sessions.pop()!.stop().catch(() => {});
  for (const s of servers.splice(0)) await s.close().catch(() => {});
  setNowUsOverride(null);
  vi.restoreAllMocks();
});

/** 生命周期测试会话:不起 listener(start 不调),直接注入 player/连接态驱动内部状态机。 */
function mkLifecycleSession(): BridgeSession {
  const n = Math.floor(Math.random() * 1e9);
  const s = new BridgeSession({
    deviceId: `bp5-${n}`,
    token: `bp5-${n}`,
    protocol: "raop",
    socketPath: bridgeSocketPath(`bp5-${n}`, `bp5-${n}`),
    waitDataMs: 30,
  });
  sessions.push(s);
  return s;
}

function fakePlayer() {
  return {
    negotiatedLatencyFrames: 44100,
    streamBridge: vi.fn(() => new Promise<void>(() => { /* 常驻,不触发重连 */ })),
    pause: vi.fn(),
    resume: vi.fn(),
    flush: vi.fn(),
    forceClose: vi.fn(),
    stop: vi.fn(async () => {}),
    isStreaming: true,
    bridgeLateCount: 0,
  };
}

/** 注入连接态 + 假 player,绕过 RTSP。 */
function injectConnected(s: BridgeSession, player: ReturnType<typeof fakePlayer>): void {
  (s as any).connected = true;
  (s as any).player = player;
  (s as any).raopSession = { session: "t", audioPort: 7000, controlPort: 7001, timingPort: 7002 } as RaopSession;
}

function feed(s: BridgeSession, tsUs: bigint, generation: number, frames = 960): void {
  (s as any).ingestAudio({
    tsUs,
    generation,
    sequence: 1,
    payload: new Uint8Array(frames * 4),
  });
}

/** 抓取 `[airplay-bridge] {...}` JSON 事件行。 */
function bridgeEvents(spy: { mock: { calls: unknown[][] } }): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  for (const call of spy.mock.calls) {
    const line = call.map(String).join(" ");
    const i = line.indexOf("[airplay-bridge] ");
    if (i < 0) continue;
    const json = line.slice(i + "[airplay-bridge] ".length);
    if (json.startsWith("{")) out.push(JSON.parse(json) as Record<string, unknown>);
  }
  return out;
}

const anchorOf = (evs: Array<Record<string, unknown>>) => evs.filter((e) => e.ev === "anchor");
const genEvs = (evs: Array<Record<string, unknown>>) => evs.filter((e) => e.ev === "gen");

// ---------------------------------------------------------------------------
// ①② 代次重锚(BLK-02 / R1)
// ---------------------------------------------------------------------------

describe("代次与热复用收口(§Phase 5 BLK-02/R1)", () => {
  it("★ 连续 seek 3 次:每次新 generation + 新 scheduledAnchorUs,旧 generation 帧丢弃计数 > 0", async () => {
    const s = mkLifecycleSession();
    const player = fakePlayer();
    injectConnected(s, player);
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    const base = 1_000_000_000n;

    // 代次 100:首帧立锚
    feed(s, base, 100);
    expect((s as any).aligner).not.toBeNull();

    for (let k = 1; k <= 3; k++) {
      const gen = 100 + k;
      // 旧代次在途帧:BOUNDARY 前入队的(队列清空路径)
      feed(s, base + BigInt(k) * 10_000_000n, gen - 1);
      // BOUNDARY{seek}
      (s as any).onBoundary(gen, "seek");
      // 旧代次在途帧:BOUNDARY 后到的(generation 门控丢弃路径)
      feed(s, base + BigInt(k) * 15_000_000n, gen - 1);
      // 新代次首帧 → 新锚点
      feed(s, base + BigInt(k) * 20_000_000n, gen);
    }
    const evs = bridgeEvents(spy);
    expect(genEvs(evs).map((e) => e.reason)).toEqual(["seek", "seek", "seek"]);
    expect(genEvs(evs).map((e) => Number(e.gen))).toEqual([101, 102, 103]);
    const anchors = anchorOf(evs);
    expect(anchors.length).toBe(4); // 初始 1 次 + 每次 seek 重锚 1 次
    const us = anchors.map((e) => Number(e.scheduledAnchorUs));
    expect(new Set(us).size).toBe(4); // ★ 每次都是新 scheduledAnchorUs
    expect([...us].sort((a, b) => a - b)).toEqual(us); // 单调递增
    // ★ BLK-02 核心判据:旧 generation 帧丢弃计数 > 0
    expect(s.stats.staleFramesDropped).toBeGreaterThan(0);
    // 热复用:streamBridge 在同一(假)player 上重启,未重建会话
    expect(player.streamBridge).toHaveBeenCalledTimes(4);
    expect(player.flush).toHaveBeenCalledTimes(3);
  });

  it("★ rehost(只动 timelineReseed)→ 同样新 generation + 新锚点(R1 防漏判)", async () => {
    const s = mkLifecycleSession();
    injectConnected(s, fakePlayer());
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    const base = 2_000_000_000n;
    feed(s, base, 500);
    (s as any).onBoundary(501, "rehost");
    feed(s, base + 30_000_000n, 501);
    const evs = bridgeEvents(spy);
    expect(genEvs(evs).map((e) => e.reason)).toEqual(["rehost"]);
    expect(anchorOf(evs).length).toBe(2);
    expect(anchorOf(evs)[1].scheduledAnchorUs).not.toBe(anchorOf(evs)[0].scheduledAnchorUs);
  });

  it("stop 边界:停推流(flush),保留会话等编排侧 bridgeStop;seek 后不产生第二次 airplay 会话", () => {
    const s = mkLifecycleSession();
    const player = fakePlayer();
    injectConnected(s, player);
    feed(s, 3_000_000_000n, 10);
    (s as any).onBoundary(11, "stop");
    expect(player.flush).toHaveBeenCalledTimes(1);
    expect((s as any).aligner).toBeNull();
    expect((s as any).streamAborted).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// ④ stall(sendspin 子进程崩溃 → 无残留播放)
// ---------------------------------------------------------------------------

describe("链路 stall(§5.2 sendspin 子进程崩溃)", () => {
  it("★ stall → 立刻停推流 + 复位锚点(不写静音,等 BOUNDARY{rehost} 重锚)", () => {
    const s = mkLifecycleSession();
    const player = fakePlayer();
    injectConnected(s, player);
    feed(s, 4_000_000_000n, 20);
    expect((s as any).aligner).not.toBeNull();
    (s as any).onLinkStall();
    expect(player.flush).toHaveBeenCalledTimes(1);
    expect((s as any).aligner).toBeNull();
    expect((s as any).streamAborted).toBe(true);
    expect(s.snapshot().anchored).toBe(false);
    // 重连成功后 BridgeMember 发 BOUNDARY{rehost} → 重锚路径可达(喂新帧)
    (s as any).onBoundary(21, "rehost");
    feed(s, 4_100_000_000n, 21);
    expect((s as any).aligner).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// ⑤ 暂停/恢复(§5.4)
// ---------------------------------------------------------------------------

describe("暂停/恢复(§5.4)", () => {
  it("★ 暂停:player.pause 冻结 + 快照 paused=true;恢复 ≤45s 按「继续」(锚点不重立)", () => {
    const s = mkLifecycleSession();
    const player = fakePlayer();
    injectConnected(s, player);
    feed(s, 5_000_000_000n, 30);
    const anchorBefore = (s as any).anchors;
    (s as any).onBridgeHeartbeat(true);
    expect(player.pause).toHaveBeenCalledTimes(1);
    expect(s.snapshot().paused).toBe(true);
    // 暂停期:不重锚、不重启推流
    expect((s as any).aligner).not.toBeNull();
    // 恢复(短暂暂停)
    (s as any).pausedAtUs = null; // 清零模拟 heldUs=0
    (s as any).onBridgeHeartbeat(false);
    expect(player.resume).toHaveBeenCalledTimes(1);
    expect((s as any).anchors).toBe(anchorBefore); // 原 A/B 不动
    expect(s.snapshot().paused).toBe(false);
  });

  it("★ 暂停 >45s 恢复 → 按「锚点不可达」重锚(§5.4 末段)", () => {
    const s = mkLifecycleSession();
    const player = fakePlayer();
    injectConnected(s, player);
    feed(s, 6_000_000_000n, 40);
    (s as any).onBridgeHeartbeat(true);
    // 伪造 50s 前暂停
    (s as any).pausedAtUs = nowUs() - 50_000_000n;
    (s as any).onBridgeHeartbeat(false);
    expect(player.resume).toHaveBeenCalledTimes(1);
    expect(player.flush).toHaveBeenCalledTimes(1); // 重锚:推流重启
    expect((s as any).aligner).toBeNull();
    expect((s as any).firstFrameTsUs).toBeNull();
    // 新代次语义:下一帧重立锚(可达性检查走「不可达重锚」路径)
    feed(s, 6_050_000_000n, 40);
    expect((s as any).aligner).not.toBeNull();
  });

  it("重复同值 pause/resume 幂等", () => {
    const s = mkLifecycleSession();
    const player = fakePlayer();
    injectConnected(s, player);
    (s as any).onBridgeHeartbeat(true);
    (s as any).onBridgeHeartbeat(true);
    expect(player.pause).toHaveBeenCalledTimes(1);
    (s as any).onBridgeHeartbeat(false);
    (s as any).onBridgeHeartbeat(false);
    expect(player.resume).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// ⑥ streamBridge pacing rebase(恢复段不计 latePackets)
// ---------------------------------------------------------------------------

/** 假 UDP socket(记录发送时刻;与 setNowUsOverride 的 Date.now 纪元一致)。 */
class FakeUdp extends EventEmitter {
  addr = "192.168.1.50";
  port: number;
  closed = false;
  sent: Array<{ buf: Buffer; port: number; addr: string; atMs: number }> = [];
  constructor(port: number) { super(); this.port = port; }
  send(buf: Buffer, ...rest: unknown[]): void {
    const payload = Buffer.isBuffer(rest[0]) ? Buffer.from(buf.subarray(rest[0] as number, (rest[0] as number) + (rest[1] as number))) : Buffer.from(buf);
    const port = (Buffer.isBuffer(rest[0]) ? rest[2] : rest[0]) as number;
    const addr = (Buffer.isBuffer(rest[0]) ? rest[3] : rest[1]) as string;
    this.sent.push({ buf: payload, port, addr, atMs: Date.now() });
  }
  address() { return { address: this.addr, port: this.port, family: "IPv4" }; }
  close() { this.closed = true; }
}

function mkRaopPlayer(): { p: RaopPlayer; anyP: any; audio: FakeUdp; ctrl: FakeUdp } {
  const p = new RaopPlayer({ host: "192.168.1.50" });
  const audio = new FakeUdp(6001);
  const ctrl = new FakeUdp(6002);
  const anyP = p as any;
  anyP.audioSocket = audio;
  anyP.ctrlSocket = ctrl;
  anyP.timeSocket = new FakeUdp(6003);
  anyP.url = "rtsp://192.168.1.50:5000/x";
  return { p, anyP, audio, ctrl };
}

describe("streamBridge 暂停/恢复行为(§5.4)", () => {
  it("★ 暂停期:不出包、不取料、不计 latePackets;恢复后续流", async () => {
    setNowUsOverride(() => BigInt(Date.now()) * 1000n);
    const { p, anyP, audio } = mkRaopPlayer();
    servers.push({ close: async () => { if (anyP.syncTimer) clearInterval(anyP.syncTimer); } } as unknown as BridgeServer);
    const { computeBridgeAnchors } = await import("../../src/services/airplay/bridgeMath.js");
    const anchorUs = BigInt(Date.now() + 1200) * 1000n;
    const anchors = computeBridgeAnchors({ anchorUs, latencyFrames: 44100, rate: 44100, chunkLen: CHUNK_LEN });
    let pulls = 0;
    const producer = async (): Promise<Buffer | null> => {
      pulls++;
      return Buffer.alloc(CHUNK_LEN * 4, 1);
    };
    const done = p.streamBridge(producer, { session: "t", audioPort: 7000, controlPort: 7001, timingPort: 7002 }, {
      baseTs: anchors.baseTs, startTs: anchors.startTs, headTs: anchors.headTs,
      startNtp: anchors.startNtp, anchorUsShifted: anchors.anchorUsShifted, anchorUs,
      latencyFrames: 44100, rate: 44100,
    });
    // 立刻暂停:producer 不再被拉,包不发
    p.pause();
    const pullsAtPause = pulls;
    const sentAtPause = audio.sent.length;
    await new Promise((r) => setTimeout(r, 300));
    expect(pulls).toBe(pullsAtPause);
    expect(audio.sent.length).toBe(sentAtPause);
    expect(p.bridgeLateCount).toBe(0); // ★ 暂停期不计 latePackets
    // 恢复 → 续流(短暂停的恢复追赶属正常 late 计数,不在此断言)
    p.resume();
    await new Promise((r) => setTimeout(r, 250));
    expect(pulls).toBeGreaterThan(pullsAtPause);
    p.forceClose();
    await done.catch(() => {});
    expect(audio.sent.length).toBeGreaterThan(sentAtPause);
  });

  it("★ 恢复段 sendAt 落后 >2s:pacing rebase,不计 latePackets(RTP 映射不动)", async () => {
    setNowUsOverride(() => BigInt(Date.now()) * 1000n);
    const { p, anyP, audio } = mkRaopPlayer();
    servers.push({ close: async () => { if (anyP.syncTimer) clearInterval(anyP.syncTimer); } } as unknown as BridgeServer);
    const { computeBridgeAnchors } = await import("../../src/services/airplay/bridgeMath.js");
    // A 在 3s 前(模拟暂停 3s 后恢复,内容时间线未变而墙钟已前跳)
    const anchorUs = BigInt(Date.now() - 3000) * 1000n;
    const anchors = computeBridgeAnchors({ anchorUs, latencyFrames: 44100, rate: 44100, chunkLen: CHUNK_LEN });
    let sends = 0;
    const producer = async (): Promise<Buffer | null> => (sends++ < 5 ? Buffer.alloc(CHUNK_LEN * 4, 1) : null);
    await p.streamBridge(producer, { session: "t", audioPort: 7000, controlPort: 7001, timingPort: 7002 }, {
      baseTs: anchors.baseTs, startTs: anchors.startTs, headTs: anchors.headTs,
      startNtp: anchors.startNtp, anchorUsShifted: anchors.anchorUsShifted, anchorUs,
      latencyFrames: 44100, rate: 44100,
    });
    expect(audio.sent.length).toBe(5);
    // ★ rebase 路径:不计 latePackets(<2s 的迟到才计)
    expect(p.bridgeLateCount).toBe(0);
    // RTP 时间戳连续(rebase 不动映射)
    for (let i = 0; i < 5; i++) {
      expect(audio.sent[i].buf.readUInt32BE(4)).toBe((anchors.baseTs + i * CHUNK_LEN) >>> 0);
    }
  });
});

// ---------------------------------------------------------------------------
// ⑦ mfab 残留 socket 清理(§5.2 主进程重启)
// ---------------------------------------------------------------------------

describe("cleanupStaleBridgeSockets(§5.2)", () => {
  it("★ 死链删除,活 listener 保留,返回清理数", async () => {
    const dir = path.join(os.tmpdir(), `mfab-p5test-${Math.floor(Math.random() * 1e9)}`);
    fs.mkdirSync(dir, { recursive: true });
    try {
      // 活 listener
      const livePath = path.join(dir, "live.sock");
      const srv = new BridgeServer({ deviceId: "d", token: "t", protocol: "raop" }, {});
      servers.push(srv);
      await srv.listen(livePath);
      // 死链(普通文件,connect 必被拒)
      const deadPath = path.join(dir, "dead.sock");
      fs.writeFileSync(deadPath, "");

      const removed = await cleanupStaleBridgeSockets({ dir, probeTimeoutMs: 500 });
      expect(removed).toBeGreaterThanOrEqual(1);
      expect(fs.existsSync(deadPath)).toBe(false);   // 死链已清
      expect(fs.existsSync(livePath)).toBe(true);    // ★ 活 listener 不动
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// HEARTBEAT pause 标志(§5.4 线格式)
// ---------------------------------------------------------------------------

describe("HEARTBEAT pause 标志(线格式)", () => {
  it("★ paused=true → flags bit1;解码侧可还原(airplay 侧据此冻结推流)", () => {
    const pausedFrame = encodeHeartbeat(7, 1, true);
    const normalFrame = encodeHeartbeat(7, 2, false);
    const dec = new FrameDecoder();
    const frames = dec.push(Buffer.concat([pausedFrame, normalFrame]));
    expect(frames.length).toBe(2);
    expect(frames[0].type).toBe(FRAME_TYPE.HEARTBEAT);
    expect(frames[0].flags & FRAME_FLAG_PAUSED).toBe(FRAME_FLAG_PAUSED);
    expect(frames[1].flags & FRAME_FLAG_PAUSED).toBe(0);
    expect(frames[0].generation).toBe(7);
  });
});
