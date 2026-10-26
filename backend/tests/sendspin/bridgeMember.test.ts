import { createHash, randomBytes } from "node:crypto";
import net from "node:net";

import { afterEach, describe, expect, it } from "vitest";

import {
  FRAME_TYPE,
  bridgeSocketPath,
  encodeFrame,
} from "../../src/services/airplay/bridgeChannel.js";
import { BridgeSource } from "../../src/services/airplay/bridgeSource.js";
import { BridgeServer, type BridgeServerHandlers } from "../../src/services/airplay/bridgeServer.js";
import { BridgeMember } from "../../src/services/sendspin/bridgeMember.js";

function sha1(b: Uint8Array): string {
  return createHash("sha1").update(b).digest("hex");
}

async function until(cond: () => boolean, what: string, timeoutMs = 8000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error(`until timeout: ${what}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

const members: BridgeMember[] = [];
const servers: BridgeServer[] = [];

afterEach(async () => {
  while (members.length > 0) members.pop()!.stop();
  while (servers.length > 0) {
    const s = servers.pop()!;
    await s.close();
  }
});

interface Recv {
  audio: { tsUs: bigint; generation: number; sequence: number; payload: Uint8Array }[];
  boundaries: [number, string][];
  heartbeats: number[];
}

function recvHandlers(): { recv: Recv; handlers: BridgeServerHandlers } {
  const recv: Recv = { audio: [], boundaries: [], heartbeats: [] };
  const handlers: BridgeServerHandlers = {
    onAudio: (a) => { recv.audio.push(a); },
    onBoundary: (gen, reason) => { recv.boundaries.push([gen, reason]); },
    onHeartbeat: (gen) => { recv.heartbeats.push(gen); },
  };
  return { recv, handlers };
}

interface Pair {
  server: BridgeServer;
  member: BridgeMember;
  recv: Recv;
}

/** 起一对真 net server + BridgeMember(bridgeSocketPath 真实路径,快速注入退避)。 */
async function startPair(opts: {
  heartbeatMs?: number;
  stallAfterMs?: number;
  pumpIdleMs?: number;
  schedule?: (fn: () => void, ms: number) => () => void;
} = {}): Promise<Pair> {
  const n = Math.floor(Math.random() * 1e9);
  const deviceId = `dev-${n}`;
  const token = `tok-${n}`;
  const { recv, handlers } = recvHandlers();
  const server = new BridgeServer(
    { deviceId, token, protocol: "raop", stallAfterMs: opts.stallAfterMs, checkIntervalMs: opts.stallAfterMs !== undefined ? 50 : undefined },
    handlers,
  );
  servers.push(server);
  await server.listen(bridgeSocketPath(deviceId, token));
  const member = new BridgeMember({
    deviceId,
    token,
    protocol: "raop",
    socketPath: server.listeningOn!,
    heartbeatMs: opts.heartbeatMs ?? 0,
    backoffDelayMs: () => 20, // 测试注入:快速重连
    pumpIdleMs: opts.pumpIdleMs,
    schedule: opts.schedule,
  });
  members.push(member);
  return { server, member, recv };
}

describe("bridgeMember:socket 会合 + CONFIG 握手(§4.1)", () => {
  it("真 net server:CONFIG 先行、AUDIO 逐帧字节一致、sequence 连续、tsUs 保留", async () => {
    const { server, member, recv } = await startPair();
    member.start();
    await until(() => server.stats().sessionsAccepted === 1, "accepted");

    const pcm0 = randomBytes(1920 * 4);
    const pcm1 = randomBytes(1920 * 4);
    member.pushAudio(pcm0, 1000n);
    member.pushAudio(pcm1, 50000n);
    await until(() => recv.audio.length >= 2, "audio");

    expect(recv.audio[0]).toMatchObject({ tsUs: 1000n, generation: 0, sequence: 1 });
    expect(recv.audio[1]).toMatchObject({ tsUs: 50000n, generation: 0, sequence: 2 });
    expect(Buffer.from(recv.audio[0]!.payload).equals(pcm0)).toBe(true);
    expect(Buffer.from(recv.audio[1]!.payload).equals(pcm1)).toBe(true);
    const st = member.stats();
    expect(st.droppedFrames).toBe(0);
    expect(st.sentFrames).toBeGreaterThanOrEqual(2);
  });

  it("notifyGeneration:清旧代次队列,BOUNDARY 先行,新帧 generation/sequence 重置", async () => {
    const { server, member, recv } = await startPair();
    // 未 start:旧代次帧滞留队列 → 切代次必须被清掉(时间线重置)
    member.pushAudio(Buffer.alloc(1920 * 4, 1), 1n);
    member.notifyGeneration(7, "seek");
    expect(member.generation).toBe(7);
    member.start();
    await until(() => server.stats().sessionsAccepted === 1, "accepted");
    member.pushAudio(Buffer.alloc(1920 * 4, 2), 2n);

    await until(() => recv.boundaries.length >= 1, "boundary");
    expect(recv.boundaries[0]).toEqual([7, "seek"]);
    await until(() => recv.audio.length >= 1, "audio");
    // 只剩新代次帧:BOUNDARY(gen 7, seq 1) 后 audio(gen 7, seq 2)
    expect(recv.audio.length).toBe(1);
    expect(recv.audio[0]).toMatchObject({ generation: 7, sequence: 2 });
  });

  it("心跳:无音频时也持续发 HEARTBEAT,接收端 stall 不误判", async () => {
    const { server, member, recv } = await startPair({ heartbeatMs: 30, stallAfterMs: 200 });
    member.start();
    await until(() => server.stats().sessionsAccepted === 1, "accepted");
    await new Promise((r) => setTimeout(r, 400));
    expect(recv.heartbeats.length).toBeGreaterThanOrEqual(4);
    expect(server.stats().stalls).toBe(0); // 心跳喂着,不判 stall
  });
});

describe("bridgeMember:kill/断连重连(出口判据 ②)", () => {
  it("server 端销毁 → 快速退避重连成功 → 新 generation + BOUNDARY{rehost}", async () => {
    const { server, member, recv } = await startPair();
    const states: string[] = [];
    const orig = member.stats;
    void orig;
    member.start();
    await until(() => server.stats().sessionsAccepted === 1, "accepted#1");

    member.pushAudio(randomBytes(960 * 4), 1n);
    await until(() => recv.audio.length >= 1, "audio#1");

    // 模拟对端被 kill:server 强断全部会话
    server.destroySessions();
    await until(() => server.stats().sessionsAccepted >= 2, "accepted#2", 6000);
    await until(() => recv.boundaries.length >= 1, "boundary rehost", 6000);
    expect(recv.boundaries[0]).toEqual([1, "rehost"]); // 新 generation = 0 + 1
    expect(member.generation).toBe(1);

    // 重连后新帧走新 generation
    member.pushAudio(randomBytes(960 * 4), 2n);
    await until(() => recv.audio.length >= 2, "audio#2");
    expect(recv.audio[1]).toMatchObject({ generation: 1 });

    expect(member.stats().reconnects).toBeGreaterThanOrEqual(1);
    expect(member.stats().droppedFrames).toBe(0);
    // 状态机至少经历 connecting(重连)与 live(恢复);stalled 由 source 侧测试钉住
    expect(member.stats().state).toBe("live");
    void states;
  });
});

describe("bridgeMember:吞吐与完整性(出口判据 ①:10 万随机帧往返字节一致)", () => {
  it("真 net server + BridgeSource:AUDIO/BOUNDARY/HEARTBEAT 混合,逐帧字节相等、sequence/generation 无损", async () => {
    const TOTAL = 100_000;
    const n = Math.floor(Math.random() * 1e9);
    const deviceId = `soak-${n}`;
    const token = `soak-${n}`;

    // 接收侧:按接收顺序记录逐帧 (type, generation, sequence, tsUs, hash/len)
    const recv: { type: number; gen: number; seq: number; tsUs: bigint; hash: string; len: number; payload?: Uint8Array }[] = [];
    const server = new BridgeServer(
      { deviceId, token, protocol: "raop" },
      {
        onAudio: (a) => {
          recv.push({ type: FRAME_TYPE.AUDIO, gen: a.generation, seq: a.sequence, tsUs: a.tsUs, hash: sha1(a.payload), len: a.payload.byteLength, payload: a.payload });
        },
        onBoundary: (gen, reason) => {
          const payload = Buffer.from(JSON.stringify({ reason }), "utf8");
          recv.push({ type: FRAME_TYPE.BOUNDARY, gen, seq: 0, tsUs: 0n, hash: sha1(payload), len: payload.byteLength });
        },
        onHeartbeat: (gen, sequence) => {
          recv.push({ type: FRAME_TYPE.HEARTBEAT, gen, seq: sequence, tsUs: 0n, hash: "", len: 0 });
        },
      },
    );
    servers.push(server);
    await server.listen(bridgeSocketPath(deviceId, token));

    // 发送侧:直用 BridgeSource(关闭水位断连,吞吐由 socket drain 自然限流)
    const src = new BridgeSource({
      connect: async () => {
        const sock = await new Promise<net.Socket>((resolve, reject) => {
          const s = net.connect(server.listeningOn!);
          s.once("connect", () => resolve(s));
          s.once("error", reject);
        });
        return sock;
      },
      onConnected: (sock) => {
        sock.write(encodeFrame({
          type: FRAME_TYPE.CONFIG, flags: 0, generation: 0, sequence: 0, tsUs: 0n,
          payload: Buffer.from(JSON.stringify({ deviceId, protocol: "raop", rate: 48000, channels: 2, format: "s16le", sessionToken: token }), "utf8"),
        }));
      },
      highWaterMs: 1e12, // 吞吐用例关闭水位断连;水位判定语义由 bridgeSource.test 覆盖
      hardCapMs: 1e12,
    });

    // 发送期望:逐帧记录;每 997 帧存 payload 副本做直接字节比对
    const expected: { type: number; seq: number; tsUs: bigint; hash: string; len: number; keep?: Uint8Array }[] = [];
    const reasons = ["track", "seek", "stop", "rehost"] as const;
    let sent = 0;
    src.start();
    while (sent < TOTAL) {
      // 队列 > 4MB 暂停入队(等 drain),避免无界内存
      while (sent < TOTAL && src.stats().queuedBytes < 4_000_000) {
        let type: number = FRAME_TYPE.AUDIO;
        let payload: Buffer;
        if (sent % 1000 === 999) {
          type = FRAME_TYPE.BOUNDARY;
          payload = Buffer.from(JSON.stringify({ reason: reasons[Math.floor(sent / 1000) % 4] }), "utf8");
        } else if (sent % 500 === 499) {
          type = FRAME_TYPE.HEARTBEAT;
          payload = Buffer.alloc(0);
        } else {
          // 尺寸分布:90% ≤2KB,9% ≤16KB,1% ≤128KB(随机长度,均在 1MiB 上限内)
          const r = Math.random();
          const len = r < 0.9 ? Math.floor(Math.random() * 2048)
            : r < 0.99 ? Math.floor(Math.random() * 16384)
              : Math.floor(Math.random() * 131072);
          payload = randomBytes(len);
        }
        const seqNo = sent + 1;
        const tsUs = BigInt(sent * 1000);
        expected.push({
          type, seq: seqNo, tsUs, hash: sha1(payload), len: payload.byteLength,
          keep: sent % 997 === 0 ? Buffer.from(payload) : undefined,
        });
        src.enqueue(encodeFrame({ type, flags: 0, generation: 0, sequence: seqNo, tsUs, payload }));
        sent++;
      }
      await new Promise((r) => setTimeout(r, 1));
    }

    // 等全部收到(时间余量 4 分钟)
    await until(() => server.stats().framesReceived >= TOTAL, "all frames", 240_000);

    // 逐帧对齐:type/sequence/tsUs/字节(hash)全等
    expect(recv.length).toBe(TOTAL);
    for (let i = 0; i < TOTAL; i++) {
      const r = recv[i]!;
      const e = expected[i]!;
      expect(r.type, `frame #${i} type`).toBe(e.type);
      if (e.type === FRAME_TYPE.AUDIO) {
        expect(r.seq, `frame #${i} seq`).toBe(e.seq);
        expect(r.tsUs, `frame #${i} tsUs`).toBe(e.tsUs);
        expect(r.len, `frame #${i} len`).toBe(e.len);
        expect(r.hash, `frame #${i} hash`).toBe(e.hash);
        if (e.keep) expect(Buffer.from(r.payload!).equals(e.keep), `frame #${i} bytes`).toBe(true);
      } else if (e.type === FRAME_TYPE.BOUNDARY) {
        expect(r.gen, `frame #${i} boundary gen`).toBe(0);
        expect(r.hash, `frame #${i} boundary hash`).toBe(e.hash);
      } else {
        expect(r.seq, `frame #${i} heartbeat seq`).toBe(e.seq);
      }
    }
    expect(src.stats().sentFrames).toBe(TOTAL);
    expect(src.stats().reconnects).toBe(0);
    src.stop();
  }, 300_000);
});

describe("bridgeMember:泵未在跑的过渡期 closed 即时重连(修法②a)", () => {
  /** 捕获重连延迟值,同时用真定时器照常执行。 */
  function captureSchedule(): { delays: number[]; schedule: (fn: () => void, ms: number) => () => void } {
    const delays: number[] = [];
    const schedule = (fn: () => void, ms: number): (() => void) => {
      delays.push(ms);
      const t = setTimeout(fn, ms);
      return () => clearTimeout(t);
    };
    return { delays, schedule };
  }

  it("内容尾(空闲超阈值)closed → 0ms 即时重连;对端重新监听后恢复收流", async () => {
    const { delays, schedule } = captureSchedule();
    const { server, member } = await startPair({ pumpIdleMs: 100, schedule });
    const deviceId = member.deviceId;
    const token = member["opts"]["token"] as string;
    const socketPath = server.listeningOn!; // close 后 listeningOn 归 null,提前捕获
    member.start();
    await until(() => server.stats().sessionsAccepted === 1, "accepted#1");
    member.pushAudio(Buffer.alloc(1920 * 4, 1), 1000n);
    // 空闲超阈值(过渡期):>100ms 无 push
    await new Promise((r) => setTimeout(r, 250));
    await server.close();
    // closed → 0ms 即时重连;此后 connect 失败(路径已清)照常 20ms 退避
    await until(() => delays.length >= 2 && delays[0] === 0, "immediate-then-backoff");
    expect(delays[1]).toBe(20);
    // 对端重新监听同一 socket 路径 → 下一次退避到期即接上
    const { recv: recv2, handlers: handlers2 } = recvHandlers();
    const server2 = new BridgeServer({ deviceId, token, protocol: "raop" }, handlers2);
    servers.push(server2);
    await server2.listen(socketPath);
    await until(() => server2.stats().sessionsAccepted === 1, "accepted#2");
    await until(() => recv2.boundaries.some(([, reason]) => reason === "rehost"), "rehost");
  }, 15000);

  it("播中(空闲未超阈值)closed → 不即时重连,按注入退避 20ms", async () => {
    const { delays, schedule } = captureSchedule();
    const { server, member } = await startPair({ pumpIdleMs: 300, schedule });
    member.start();
    await until(() => server.stats().sessionsAccepted === 1, "accepted");
    member.pushAudio(Buffer.alloc(1920 * 4, 1), 1000n); // 刚推过:泵在跑
    await server.close();
    await until(() => delays.length >= 1, "scheduled");
    expect(delays[0]).toBe(20); // 非即时:退避路径
    member.stop();
  }, 15000);
});
