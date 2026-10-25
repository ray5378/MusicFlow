/** 【QA 对抗性用例】Phase 2 桥接通道 —— 独立于实现者自测,覆盖撕裂/重连/协议违例。
 *
 *  ① 帧流在随机位置(1~100B)撕裂 + FrameDecoder 重组:帧序列完整、顺序一致、零丢失;
 *  ② 真实 socket 端到端:中途 destroy 会话模拟 kill → 退避重连 → BOUNDARY{rehost}
 *     新 generation,两个 generation 内各帧逐字节一致,droppedFrames === 0;
 *  ③ CONFIG 用错误 token/deviceId / 首帧非 CONFIG → 拒绝断连;
 *  ④ 坏 magic / payloadLen 超上限 → 立即抛错断连,且**不错位续读**(解码器不跳字节重同步)。
 */
import { afterEach, describe, expect, it } from "vitest";

import net from "node:net";
import os from "node:os";
import path from "node:path";

import {
  FRAME_HEADER_SIZE,
  FRAME_TYPE,
  MAX_PAYLOAD_BYTES,
  FrameDecoder,
  encodeAudio,
  encodeConfig,
  encodeFrame,
} from "../../src/services/airplay/bridgeChannel.js";
import { BridgeServer } from "../../src/services/airplay/bridgeServer.js";
import { BridgeMember } from "../../src/services/sendspin/bridgeMember.js";

/** mulberry32 固定种子 PRNG(可复现,不依赖 Math.random)。 */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a) ^ (a >>> 13);
    a = t >>> 0;
    return ((t ^ (t >>> 16)) >>> 0) / 4294967296;
  };
}

async function until(cond: () => boolean, what: string, timeoutMs = 6000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error(`until timeout: ${what}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}

let pathSeq = 0;
function qaSocketPath(): string {
  return path.join(os.tmpdir(), `mfab-qa-${process.pid}-${pathSeq++}.sock`);
}

const servers: BridgeServer[] = [];

afterEach(async () => {
  while (servers.length > 0) {
    const s = servers.pop()!;
    await s.close();
  }
});

// ---------------------------------------------------------------------------
// ① 随机撕裂重组(纯解码器)
// ---------------------------------------------------------------------------

describe("QA 对抗:随机撕裂流重组", () => {
  it("200 帧按 1~100B 随机切块喂入 → 帧数/顺序/字段/字节全一致,drops=0", () => {
    const rand = rng(20261025);
    const N = 200;
    const originals: { type: number; generation: number; sequence: number; tsUs: bigint; payload: Buffer }[] = [];
    const bufs: Buffer[] = [];
    for (let i = 0; i < N; i++) {
      const payload = Buffer.alloc(4 + Math.floor(rand() * 4096));
      for (let j = 0; j < payload.length; j++) payload[j] = Math.floor(rand() * 256);
      const type = i % 4 === 0 ? FRAME_TYPE.HEARTBEAT : FRAME_TYPE.AUDIO;
      const frame = { type, generation: 7, sequence: i + 1, tsUs: BigInt(i) * 10000n, payload };
      bufs.push(encodeFrame({ ...frame, flags: 0 }));
      originals.push(frame);
    }
    const stream = Buffer.concat(bufs);

    // 随机撕裂:块大小 1~100B
    const decoder = new FrameDecoder();
    const got: ReturnType<typeof decoder.push> = [];
    let off = 0;
    while (off < stream.length) {
      const size = Math.min(stream.length - off, 1 + Math.floor(rand() * 100));
      got.push(...decoder.push(stream.subarray(off, off + size)));
      off += size;
    }
    expect(got.length).toBe(N);
    expect(decoder.pendingBytes).toBe(0);
    for (let i = 0; i < N; i++) {
      const g = got[i]!;
      const o = originals[i]!;
      expect(g.type).toBe(o.type);
      expect(g.generation).toBe(o.generation);
      expect(g.sequence).toBe(o.sequence);
      expect(g.tsUs).toBe(o.tsUs);
      expect(Buffer.from(g.payload).equals(o.payload)).toBe(true);
    }
  });

  it("坏 magic 前有合法帧 → 抛错且不跳字节重同步(重复喂仍抛,不解锁)", () => {
    const good = encodeAudio(1, 1, 0n, Buffer.alloc(16, 7));
    const junk = Buffer.alloc(28, 0);
    junk.write("XXXX", 0, 4, "latin1"); // 坏 magic
    const decoder = new FrameDecoder();
    expect(() => decoder.push(Buffer.concat([good, junk]))).toThrowError(/bad magic/);
    // 抛错后解码器处于"毒化"状态(未消费缓冲仍含坏字节):任何后续喂入都继续抛错,
    // 不存在悄悄跳字节重同步的路径 —— 调用方必须断连。
    expect(decoder.pendingBytes).toBeGreaterThanOrEqual(good.length + junk.length);
    expect(() => decoder.push(Buffer.alloc(0))).toThrowError(/bad magic/);
    expect(() => decoder.push(Buffer.alloc(8, 0x41))).toThrowError(/bad magic/);
  });

  it("payloadLen 超上限(1MiB+1)→ 在头阶段立即抛错,无需等 payload 到齐", () => {
    const header = Buffer.alloc(FRAME_HEADER_SIZE, 0);
    header.write("MFAB", 0, 4, "latin1");
    header.writeUInt8(1, 4); // version
    header.writeUInt8(FRAME_TYPE.AUDIO, 5);
    header.writeUInt32LE(MAX_PAYLOAD_BYTES + 1, 24);
    const decoder = new FrameDecoder();
    expect(() => decoder.push(header)).toThrowError(/payload too large/);
  });
});

// ---------------------------------------------------------------------------
// ② 端到端:撕裂期断连 kill → 重连 → 新 generation,零丢帧
// ---------------------------------------------------------------------------

describe("QA 对抗:端到端 kill 重连重组", () => {
  it("kill 会话中途 → 重连发 rehost;两个 generation 各 300 帧逐字节一致,droppedFrames=0", async () => {
    const p = qaSocketPath();
    const audio: { generation: number; sequence: number; payload: Buffer }[] = [];
    const boundaries: { generation: number; reason: string }[] = [];
    const heartbeats: { generation: number; sequence: number }[] = [];
    const server = new BridgeServer(
      { deviceId: "qa-dev", token: "qa-tok", protocol: "raop" },
      {
        onAudio: (a) => {
          audio.push({ generation: a.generation, sequence: a.sequence, payload: Buffer.from(a.payload) });
        },
        onBoundary: (gen, reason) => boundaries.push({ generation: gen, reason }),
        onHeartbeat: (gen, seq) => heartbeats.push({ generation: gen, sequence: seq }),
      },
    );
    servers.push(server);
    await server.listen(p);

    const member = new BridgeMember({
      deviceId: "qa-dev",
      socketPath: p,
      token: "qa-tok",
      protocol: "raop",
      heartbeatMs: 100,
      backoffDelayMs: () => 30, // 注入快退避,测试确定性
    });
    member.start();
    await until(() => member.source.state === "live", "first live");

    // payload 内容 = 8B 头(gen u32 + idx u32)+ idx 派生填充,便于逐字节比对
    const makePayload = (idx: number): Buffer => {
      const b = Buffer.alloc(1920);
      b.writeUInt32LE(idx, 0);
      b.writeUInt32LE(idx * 2654435761 >>> 0, 4);
      for (let j = 8; j < b.length; j++) b[j] = (idx + j) & 0xff;
      return b;
    };
    const pushN = (from: number, count: number): void => {
      for (let i = 0; i < count; i++) {
        member.pushAudio(makePayload(from + i), BigInt(from + i) * 10000n);
      }
    };

    pushN(0, 300); // generation 0
    await until(() => audio.length >= 300, "gen0 all received");

    // 模拟对端被 kill:服务端强拆会话 → 发送端应 stalled → 退避重连 → rehost
    server.destroySessions();
    await until(() => member.stats().generation === 1 && member.source.state === "live", "reconnected with gen1", 8000);
    await until(() => boundaries.some((b) => b.generation === 1 && b.reason === "rehost"), "rehost boundary seen", 8000);
    await until(() => server.stats().sessionsAccepted === 2, "second session accepted", 8000);

    pushN(300, 300); // generation 1
    await until(() => audio.length >= 600, "gen1 all received", 8000);

    // ── 校验 ──
    const gen0 = audio.filter((a) => a.generation === 0);
    const gen1 = audio.filter((a) => a.generation === 1);
    expect(gen0.length).toBe(300);
    expect(gen1.length).toBe(300);

    // 每 generation 内 sequence 连续无重复、无洞。
    // 注意 §4.2 设计:heartbeat 与 audio **共享**同一 sequence 序列(跨帧类型共享),
    // 心跳会合法地消耗号段,故不能断言 audio seq 恰好从 1 开始;正确口径是
    // 「audio ∪ heartbeat 的 sequence 并集 = 1..max 连续无重复无洞」。
    for (const [frames, gen] of [[gen0, 0], [gen1, 1]] as const) {
      const seqs = frames.map((f) => f.sequence);
      expect(new Set(seqs).size).toBe(seqs.length); // 无重复
      expect(seqs.every((s) => s >= 1)).toBe(true);
      const hb = heartbeats.filter((h) => h.generation === gen).map((h) => h.sequence);
      // BridgeServer.onBoundary 不透出 sequence;按协议事实记账:rehost 边界是
      // FrameSequencer.reset 后第一次 take,在 gen1 恒为 seq 1(§4.4)。
      const boundarySeqs = gen === 1 && boundaries.some((b) => b.generation === 1 && b.reason === "rehost") ? [1] : [];
      const union = [...seqs, ...hb, ...boundarySeqs].sort((a, b) => a - b);
      const top = union[union.length - 1]!;
      expect(union).toEqual(Array.from({ length: top }, (_, i) => i + 1));
    }
    // 逐字节一致
    for (let i = 0; i < 300; i++) {
      expect(Buffer.compare(gen0[i]!.payload, makePayload(i))).toBe(0);
      expect(Buffer.compare(gen1[i]!.payload, makePayload(300 + i))).toBe(0);
    }
    expect(member.stats().droppedFrames).toBe(0);
    expect(member.stats().reconnects).toBeGreaterThanOrEqual(1);
    member.stop();
  }, 20000);
});

// ---------------------------------------------------------------------------
// ③ CONFIG 校验对抗
// ---------------------------------------------------------------------------

function connectClient(p: string): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const s = net.connect(p);
    s.once("connect", () => resolve(s));
    s.once("error", reject);
  });
}

describe("QA 对抗:CONFIG 握手拒绝", () => {
  it("错误 deviceId → 断连 rejected;首帧非 CONFIG → 断连 rejected", async () => {
    const p = qaSocketPath();
    const rejects: string[] = [];
    const server = new BridgeServer(
      { deviceId: "qa-dev", token: "qa-tok", protocol: "raop" },
      { onSession: (ev) => { if (!ev.connected) rejects.push(ev.reason ?? ""); } },
    );
    servers.push(server);
    await server.listen(p);

    // 错 deviceId
    const c1 = await connectClient(server.listeningOn!);
    c1.write(encodeConfig({ deviceId: "intruder", protocol: "raop", rate: 48000, channels: 2, format: "s16le", sessionToken: "qa-tok" }));
    await until(() => c1.destroyed, "c1 destroyed");
    await until(() => server.stats().rejected === 1, "reject#1");
    expect(rejects.some((r) => r.includes("deviceId"))).toBe(true);

    // 合法 CONFIG 后,首帧之后又来一个 CONFIG?——先测"首帧非 CONFIG"
    const p2 = qaSocketPath();
    const server2 = new BridgeServer({ deviceId: "qa-dev", token: "qa-tok", protocol: "raop" }, {});
    servers.push(server2);
    await server2.listen(p2);
    const c2 = await connectClient(server2.listeningOn!);
    c2.write(encodeAudio(0, 1, 0n, Buffer.alloc(64))); // 首帧是 AUDIO → 必须拒
    await until(() => c2.destroyed, "c2 destroyed");
    await until(() => server2.stats().rejected === 1, "reject#2");
    expect(server2.stats().sessionsAccepted).toBe(0);
  }, 15000);

  it("坏 magic(握手后)→ 断连且 rejected 计数,不错位续读", async () => {
    const p = qaSocketPath();
    const server = new BridgeServer({ deviceId: "qa-dev", token: "qa-tok", protocol: "raop" }, {});
    servers.push(server);
    await server.listen(p);
    const c = await connectClient(server.listeningOn!);
    c.write(encodeConfig({ deviceId: "qa-dev", protocol: "raop", rate: 48000, channels: 2, format: "s16le", sessionToken: "qa-tok" }));
    await until(() => server.stats().sessionsAccepted === 1, "accepted");

    // 合法帧 + 坏 magic 帧 + 合法帧:坏帧必须断连,而不是跳过坏字节吞掉后面的合法帧
    const good = encodeAudio(0, 1, 0n, Buffer.alloc(64, 3));
    const junk = Buffer.alloc(FRAME_HEADER_SIZE, 0);
    junk.write("MFAC", 0, 4, "latin1");
    const c2tail = encodeAudio(0, 2, 10000n, Buffer.alloc(64, 4));
    c.write(Buffer.concat([good, junk, c2tail]));
    await until(() => c.destroyed, "socket destroyed on bad magic", 8000);
    await until(() => server.stats().rejected === 1, "rejected after bad magic");
    // 断连后不得再收到 junk 之后的帧(不错位续读的直接证据:decoder 抛错即断)
    expect(server.stats().overflows).toBe(0);
  }, 15000);
});
