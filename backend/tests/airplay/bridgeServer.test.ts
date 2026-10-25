import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  encodeAudio,
  encodeBoundary,
  encodeConfig,
  encodeHeartbeat,
} from "../../src/services/airplay/bridgeChannel.js";
import { BridgeServer } from "../../src/services/airplay/bridgeServer.js";

const CFG = { deviceId: "dev-1", protocol: "raop", rate: 48000, channels: 2, format: "s16le" as const, sessionToken: "tok-1" };

let seq = 0;
function socketPath(): string {
  return path.join(os.tmpdir(), `mfab-p2srv-${process.pid}-${seq++}.sock`);
}

function connectClient(p: string): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const s = net.connect(p);
    s.once("connect", () => resolve(s));
    s.once("error", reject);
  });
}

function sha1(b: Uint8Array): string {
  return createHash("sha1").update(b).digest("hex");
}

async function until(cond: () => boolean, what: string, timeoutMs = 4000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error(`until timeout: ${what}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

function sineS16(frames: number, startIdx = 0): Buffer {
  const buf = Buffer.alloc(frames * 4);
  for (let i = 0; i < frames; i++) {
    const v = Math.round(Math.sin((2 * Math.PI * 1000 * (startIdx + i)) / 48000) * 20000);
    buf.writeInt16LE(v, i * 4);
    buf.writeInt16LE(v, i * 4 + 2);
  }
  return buf;
}

const servers: BridgeServer[] = [];

afterEach(async () => {
  while (servers.length > 0) {
    const s = servers.pop()!;
    await s.close();
  }
});

describe("bridgeServer:CONFIG 握手(§4.1)", () => {
  it("sessionToken 不匹配 → 断连上报 rejected;改对后可正常入会", async () => {
    const events: { connected: boolean; reason?: string }[] = [];
    const server = new BridgeServer({ deviceId: "dev-1", token: "tok-1", protocol: "raop" }, { onSession: (ev) => events.push(ev) });
    servers.push(server);
    await server.listen(socketPath());

    // 错 token
    const bad = await connectClient(server.listeningOn!);
    bad.write(encodeConfig({ ...CFG, sessionToken: "wrong" }));
    await until(() => bad.destroyed === true, "bad destroyed");
    await until(() => events.some((e) => !e.connected && (e.reason ?? "").includes("sessionToken")), "rejected");
    expect(server.stats().rejected).toBe(1);
    expect(server.stats().sessionsAccepted).toBe(0);

    // 对 token:可入会并收 AUDIO
    const good = await connectClient(server.listeningOn!);
    good.write(encodeConfig(CFG));
    await until(() => server.stats().sessionsAccepted === 1, "accepted");
    good.write(encodeAudio(1, 1, 1000n, Buffer.alloc(64)));
    await until(() => server.stats().framesReceived >= 2, "audio received");
    good.destroy();
  });

  it("deviceId 不匹配 / 首帧非 CONFIG / CONFIG 超时 → 均断连", async () => {
    const server = new BridgeServer({ deviceId: "dev-1", token: "tok-1", protocol: "raop", configTimeoutMs: 150 }, {});
    servers.push(server);
    await server.listen(socketPath());

    const d1 = await connectClient(server.listeningOn!);
    d1.write(encodeConfig({ ...CFG, deviceId: "dev-2" }));
    await until(() => d1.destroyed, "deviceId mismatch");

    const d2 = await connectClient(server.listeningOn!);
    d2.write(encodeAudio(1, 1, 0n, Buffer.alloc(16))); // 未握手先发 AUDIO
    await until(() => d2.destroyed, "first frame not CONFIG");

    const d3 = await connectClient(server.listeningOn!); // 什么都不发
    await until(() => d3.destroyed, "config timeout", 3000);

    expect(server.stats().rejected).toBe(3);
    expect(server.stats().sessionsAccepted).toBe(0);
  });
});

describe("bridgeServer:帧分发与背压事件(§4.2/§4.4)", () => {
  it("AUDIO/BOUNDARY/HEARTBEAT 事件正确,payload/tsUs 字节一致", async () => {
    const audioSeen: { tsUs: bigint; generation: number; sequence: number; payload: Uint8Array }[] = [];
    const boundaries: [number, string][] = [];
    let heartbeats = 0;
    const server = new BridgeServer(
      { deviceId: "dev-1", token: "tok-1", protocol: "raop" },
      {
        onAudio: (a) => { audioSeen.push(a); },
        onBoundary: (gen, reason) => boundaries.push([gen, reason]),
        onHeartbeat: () => { heartbeats++; },
      },
    );
    servers.push(server);
    await server.listen(socketPath());

    const client = await connectClient(server.listeningOn!);
    client.write(encodeConfig(CFG));
    const p1 = Buffer.alloc(1920 * 4, 0xab);
    const p2 = Buffer.alloc(1920 * 4, 0xcd);
    client.write(encodeAudio(3, 1, 111n, p1));
    client.write(encodeBoundary(4, 2, "seek"));
    client.write(encodeHeartbeat(4, 3));
    client.write(encodeAudio(4, 4, 222n, p2));

    await until(() => audioSeen.length >= 2, "audio");
    await until(() => heartbeats >= 1, "heartbeat");
    expect(boundaries).toEqual([[4, "seek"]]);
    expect(audioSeen[0]).toMatchObject({ tsUs: 111n, generation: 3, sequence: 1 });
    expect(Buffer.from(audioSeen[0]!.payload).equals(p1)).toBe(true);
    expect(audioSeen[1]).toMatchObject({ tsUs: 222n, generation: 4, sequence: 4 });
    expect(Buffer.from(audioSeen[1]!.payload).equals(p2)).toBe(true);
    client.destroy();
  });

  it("onAudio 返回 backlog > 8s → overflow 断连", async () => {
    let overflowMs = 0;
    const server = new BridgeServer(
      { deviceId: "dev-1", token: "tok-1", protocol: "raop" },
      { onAudio: () => 9000, onOverflow: (ms) => { overflowMs = ms; } },
    );
    servers.push(server);
    await server.listen(socketPath());

    const client = await connectClient(server.listeningOn!);
    client.write(encodeConfig(CFG));
    await until(() => server.stats().sessionsAccepted === 1, "accepted");
    client.write(encodeAudio(1, 1, 0n, Buffer.alloc(64)));
    await until(() => client.destroyed, "overflow destroy");
    expect(overflowMs).toBe(9000);
    expect(server.stats().overflows).toBe(1);
    expect(server.stats().sessionsAccepted).toBe(1); // 统计不被覆盖
  });

  it("2s 无帧判 stalled(注入短阈值)", async () => {
    let stalls = 0;
    const server = new BridgeServer(
      { deviceId: "dev-1", token: "tok-1", protocol: "raop", stallAfterMs: 150, checkIntervalMs: 40 },
      { onStall: () => { stalls++; } },
    );
    servers.push(server);
    await server.listen(socketPath());

    const client = await connectClient(server.listeningOn!);
    client.write(encodeConfig(CFG));
    await until(() => stalls >= 1, "stall", 3000);
    expect(server.stats().stalls).toBeGreaterThanOrEqual(1);
    // 恢复发帧(间隔 60ms < 150ms 阈值)→ 不再新增 stall
    const before = stalls;
    for (let i = 0; i < 8; i++) {
      client.write(encodeHeartbeat(1, i + 1));
      await new Promise((r) => setTimeout(r, 60));
    }
    expect(stalls).toBe(before);
    client.destroy();
  });

  it("close 后清理 socket 文件;stats 快照正确", async () => {
    const server = new BridgeServer({ deviceId: "dev-1", token: "tok-1", protocol: "raop" }, {});
    const p = socketPath();
    await server.listen(p);
    expect(server.listeningOn).toBe(p);
    const client = await connectClient(p);
    client.write(encodeConfig(CFG));
    await until(() => server.stats().sessionsAccepted === 1, "accepted");
    client.write(encodeAudio(1, 1, 0n, Buffer.alloc(1920 * 4)));
    await until(() => server.stats().framesReceived >= 2, "frames");
    const st = server.stats();
    expect(st.bytesReceived).toBeGreaterThanOrEqual(28 + 64 + 28 + 1920 * 4);
    client.destroy();
    await server.close();
    expect(() => readFileSync(p)).toThrow(); // socket 文件已清理
  });
});

describe("bridgeServer:落盘模式(出口判据 ④)", () => {
  it("48k 正弦入 → 44.1k s16le 落盘:样本数 147/160 等效 + 非静音(RMS/频率)", async () => {
    const dumpPath = path.join(os.tmpdir(), `mfab-dump-${process.pid}-${seq++}.pcm`);
    const server = new BridgeServer({ deviceId: "dev-1", token: "tok-1", protocol: "raop", dumpPath }, {});
    servers.push(server);
    await server.listen(socketPath());

    const client = await connectClient(server.listeningOn!);
    client.write(encodeConfig(CFG));
    await until(() => server.stats().sessionsAccepted === 1, "accepted");

    // 1s 的 48k 正弦(1000Hz),分 25 帧发送,每帧 1920 帧(40ms)
    for (let i = 0; i < 25; i++) {
      client.write(encodeAudio(1, i + 1, BigInt(i * 40_000), sineS16(1920, i * 1920)));
    }
    await until(() => server.stats().framesReceived >= 26, "all audio");

    // close 排空落盘流后读回
    client.destroy();
    await server.close();
    servers.pop();

    const raw = readFileSync(dumpPath);
    expect(raw.length % 4).toBe(0);
    const outFrames = raw.length / 4;
    // ceil(48000 × 147/160) = 44100(纯整数累进,零累计误差)
    expect(Math.abs(outFrames - 44100)).toBeLessThanOrEqual(2);

    const samples = new Int16Array(raw.buffer, raw.byteOffset, raw.length >> 1);
    let sumSq = 0;
    let crossings = 0;
    for (let i = 0; i < samples.length; i += 2) { // 左声道
      const v = samples[i]! / 32768;
      sumSq += v * v;
      if (i > 0 && samples[i - 2]! < 0 && samples[i]! >= 0) crossings++;
    }
    const half = samples.length / 2;
    const rms = Math.sqrt(sumSq / half);
    expect(rms).toBeGreaterThan(0.1); // 非静音(理论峰值 20000/32768 ≈ 0.61)
    const freq = (crossings * 44100) / half;
    expect(Math.abs(freq - 1000)).toBeLessThan(50); // 1kHz 正弦经重采样频率保持
  });
});

describe("bridgeServer:协议违例与统计", () => {
  it("非法帧流(坏 magic)断连且不错位续读;BOUNDARY 非法 reason 断连", async () => {
    const server = new BridgeServer({ deviceId: "dev-1", token: "tok-1", protocol: "raop" }, {});
    servers.push(server);
    await server.listen(socketPath());

    const c1 = await connectClient(server.listeningOn!);
    c1.write(encodeConfig(CFG));
    await until(() => server.stats().sessionsAccepted === 1, "accepted");
    const junk = Buffer.alloc(28, 0x00);
    junk.write("XXXX", 0, "latin1");
    c1.write(junk);
    await until(() => c1.destroyed, "bad magic destroy");
    expect(server.stats().rejected).toBe(1);

    const c2 = await connectClient(server.listeningOn!);
    c2.write(encodeConfig(CFG));
    await until(() => server.stats().sessionsAccepted === 2, "accepted#2");
    c2.write(encodeBoundary(9, 1, "bogus"));
    await until(() => c2.destroyed, "bad reason destroy");
    expect(server.stats().rejected).toBe(2);
  });
});
