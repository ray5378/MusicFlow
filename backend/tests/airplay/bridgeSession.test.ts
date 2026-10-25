// ==================== Phase 3:BridgeSession(桥出声中间态)dry 管线 + BridgeSessionManager ====================
//
// 钉死(spec §4.5 / Phase 3 中间态口径):
//   ① dry 模式:不做 RTSP 握手,只起 MFAB listener —— bridgePrepare 阶段即可用,
//      主进程"先监听后握手"的顺序依赖点;
//   ② producer 管线:48k s16le ingest → 147/160 重采样 → 44.1k 352 帧(1408B)chunk;
//   ③ 48k 协商(ap2-buffered/ap2-realtime)直通:无重采样,字节原样;
//   ④ 欠料:waitDataMs 超时补静音块(宁出静音不断流,保持 RTP 时钟连续);
//   ⑤ manager:同 deviceId 新 prepare 拆旧(新流语义);stop/stopAll 幂等。
import "../plugins/_env.js";

import { afterEach, describe, expect, it } from "vitest";
import { bridgeSocketPath } from "../../src/services/airplay/bridgeChannel.js";
import { BridgeSession, BridgeSessionManager } from "../../src/services/airplay/bridgeSession.js";

const sessions: BridgeSession[] = [];

function mkSession(opts: Partial<ConstructorParameters<typeof BridgeSession>[0]> = {}): BridgeSession {
  const n = Math.floor(Math.random() * 1e9);
  const s = new BridgeSession({
    deviceId: `bs-${n}`,
    token: `bs-${n}`,
    protocol: "raop",
    socketPath: bridgeSocketPath(`bs-${n}`, `bs-${n}`),
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

describe("BridgeSession dry 模式", () => {
  it("start 只起 listener(不握手 RAOP);stop 后 listeningOn 归 null(幂等)", async () => {
    const s = mkSession();
    await s.start();
    expect(s.listeningOn).toBeTruthy();
    expect(s.deviceId).toBe(s.opts.deviceId);
    await s.stop();
    expect(s.listeningOn).toBeNull();
    await s.stop(); // 幂等
  });

  it("★ 48k→44.1k 重采样:960 帧 48k ingest → 产出 352 帧(1408B)44.1k chunk", async () => {
    const s = mkSession();
    await s.start();
    const in0 = Buffer.alloc(960 * 4, 7);
    (s as any).ingest(in0); // 48k s16le/2ch,960 帧 = 7680B
    const chunk = await (s as any).pullChunk();
    expect(chunk).not.toBeNull();
    expect(chunk.length).toBe(1408); // 352 帧 × 4B —— RAOP chunkLen 口径
    expect(s.stats.chunksOut).toBe(1);
    expect(s.stats.silenceChunks).toBe(0);
    expect(s.stats.framesIn).toBe(960);
  });

  it("48k 协商直通(ap2-buffered):无重采样,字节原样进出", async () => {
    const s = mkSession({ protocol: "ap2-buffered" });
    await s.start();
    const raw = Buffer.alloc(1408, 3); // 恰好 352 帧
    (s as any).ingest(raw);
    const chunk = await (s as any).pullChunk();
    expect(chunk.length).toBe(1408);
    expect(chunk.every((b: number) => b === 3)).toBe(true); // 字节原样(直通无静音混入)
  });

  it("★ 欠料:waitDataMs 超时 → 1408B 静音块(保持 RTP 时钟连续,宁出静音不断流)", async () => {
    const s = mkSession({ waitDataMs: 30 });
    await s.start();
    const t0 = Date.now();
    const chunk = await (s as any).pullChunk();
    expect(chunk.length).toBe(1408);
    expect(chunk.every((b: number) => b === 0)).toBe(true); // 纯静音
    expect(s.stats.silenceChunks).toBe(1);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(25); // 确实等过,不是立刻补
  });

  it("欠料补齐语义:可用余料并入静音块一起交付(outBuf 清零,余料不重复下发)", async () => {
    const s = mkSession({ waitDataMs: 30 });
    await s.start();
    const in1 = Buffer.alloc(100 * 4, 5); // 100 帧 48k → 重采样后 ~92 帧,不足 352 帧
    (s as any).ingest(in1);
    const chunk = await (s as any).pullChunk();
    expect(chunk.length).toBe(1408); // 可用部分 + 静音补满
    expect(s.stats.silenceChunks).toBe(1);
    const leftover = (s as any).outBuf as Buffer;
    expect(leftover.length).toBe(0); // 余料已并入本 chunk,不清空会重复下发
  });
});

describe("BridgeSessionManager", () => {
  it("★ 同 deviceId 重复 prepare → 旧会话先拆(新流语义);list/has 口径正确", async () => {
    const m = new BridgeSessionManager();
    const p1 = await m.prepare({ deviceId: "d1", token: "t1", protocol: "raop", socketPath: bridgeSocketPath("d1", "t1"), dry: true });
    expect(p1.listening).toBe(true);
    expect(p1.socketPath).toBeTruthy();
    expect(m.has("d1")).toBe(true);

    const p2 = await m.prepare({ deviceId: "d1", token: "t2", protocol: "raop", socketPath: bridgeSocketPath("d1", "t2"), dry: true });
    expect(p2.listening).toBe(true);
    expect(m.list()).toHaveLength(1); // 旧的已拆
    expect(m.list()[0]!.token).toBe("t2");
    expect(m.has("d1")).toBe(true);
    expect(m.has("dX")).toBe(false);
    expect(m.list()[0]!.stats.framesIn).toBe(0); // 诊断快照口径

    await m.stop("t2");
    expect(m.list()).toHaveLength(0);
    expect(m.has("d1")).toBe(false);
  });

  it("stop 未知 token no-op;stopAll 幂等;不同 deviceId 共存", async () => {
    const m = new BridgeSessionManager();
    await m.stop("nope"); // 未知道具 no-op
    await m.prepare({ deviceId: "dA", token: "tA", protocol: "raop", socketPath: bridgeSocketPath("dA", "tA"), dry: true });
    await m.prepare({ deviceId: "dB", token: "tB", protocol: "raop", socketPath: bridgeSocketPath("dB", "tB"), dry: true });
    expect(m.list()).toHaveLength(2);
    expect(m.has("dA")).toBe(true);
    expect(m.has("dB")).toBe(true);
    await m.stopAll();
    expect(m.list()).toHaveLength(0);
    await m.stopAll(); // 幂等
  });
});
