// 播报(TTS)扩展:airplay(RAOP 会话)与 sendspin(服务端推流)路径。
// airplay 用 vi.mock(无硬件);sendspin 走真实 legacy 客户端 + 本地 WAV。
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import http from "node:http";
import WebSocket from "ws";

vi.mock("../../src/services/airplay/control.js", async (orig) => {
  const mod: any = await orig();
  return { ...mod, __mocked: true };
});

import { announceOnPeer, isAnnouncing } from "../../src/services/dlna/announce.js";
import * as airplayControl from "../../src/services/airplay/control.js";
import { setSendspinIdentityDir, startSendspinService, stopSendspinService, getSendspinServer } from "../../src/services/sendspin/index.js";
import { getQueueController } from "../../src/services/player/index.js";

const PORT = 18935;

/** 0.5s 440Hz 正弦单声道 16bit WAV(48k),TTS 外链替身。 */
function makeWav(): Buffer {
  const rate = 48000;
  const n = Math.floor(rate * 0.5);
  const data = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) {
    data.writeInt16LE(Math.floor(28000 * Math.sin((2 * Math.PI * 440 * i) / rate)), i * 2);
  }
  const head = Buffer.alloc(44);
  head.write("RIFF", 0); head.writeUInt32LE(36 + data.length, 4); head.write("WAVE", 8);
  head.write("fmt ", 12); head.writeUInt32LE(16, 16); head.writeUInt16LE(1, 20);
  head.writeUInt16LE(1, 22); head.writeUInt32LE(rate, 24); head.writeUInt32LE(rate * 2, 28);
  head.writeUInt16LE(2, 32); head.writeUInt16LE(16, 34); head.write("data", 36);
  head.writeUInt32LE(data.length, 40);
  return Buffer.concat([head, data]);
}

async function waitFor(fn: () => boolean, ms: number, what: string): Promise<void> {
  const t0 = Date.now();
  for (;;) {
    if (fn()) return;
    if (Date.now() - t0 > ms) throw new Error(`waitFor timeout: ${what}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

describe("announce airplay", () => {
  it("保存→播报→还原→恢复,走 RAOP 会话", async () => {
    const states = [
      { playbackState: "PLAYING", position: 10, duration: 200, volume: 70, muted: false, available: true, name: "ap", supportsRsa: false, updatedAt: 0 },
      { playbackState: "PLAYING", position: 10, duration: 200, volume: 70, muted: false, available: true, name: "ap", supportsRsa: false, updatedAt: 0 },
      { playbackState: "IDLE", position: 0, duration: 0, volume: 70, muted: false, available: true, name: "ap", supportsRsa: false, updatedAt: 0 },
    ];
    let si = 0;
    const statusSpy = vi.spyOn(airplayControl, "getAirPlayStatus").mockImplementation(((id: string) => states[Math.min(si++, states.length - 1)]) as any);
    const volCalls: Array<[string, number]> = [];
    const volSpy = vi.spyOn(airplayControl, "setAirPlayVolume").mockImplementation((async (id: string, v: number) => { volCalls.push([id, v]); }) as any);
    const castCalls: any[] = [];
    const castSpy = vi.spyOn(airplayControl, "castToAirPlayDevice").mockImplementation((async (o: any) => { castCalls.push(o); return { mediaUri: "x" }; }) as any);
    try {
      const r = await announceOnPeer({ peerId: "airplay:AP1", url: "http://127.0.0.1:9/tts.mp3", volume: 60 });
      expect(r).toEqual({ targets: 1 });
      // TTS 外链原样透传(不走曲库)
      expect(castCalls.length).toBe(1);
      expect(castCalls[0].deviceId).toBe("AP1");
      expect(castCalls[0].streamUrl).toBe("http://127.0.0.1:9/tts.mp3");
      // 音量 70→60→70
      expect(volCalls).toEqual([["AP1", 60], ["AP1", 70]]);
    } finally {
      statusSpy.mockRestore();
      volSpy.mockRestore();
      castSpy.mockRestore();
    }
  });

  it("未知 kind 拒绝", async () => {
    await expect(announceOnPeer({ peerId: "local:u1", url: "http://x/y.mp3" })).rejects.toThrow();
    expect(isAnnouncing("local:u1")).toBe(false);
  });
});

describe("announce sendspin e2e", () => {
  let tmpDir: string;
  let httpSrv: http.Server | null = null;
  let ttsUrl = "";
  let ws: WebSocket | null = null;
  const CID = "ANNOUNCE-E2E-1";
  const binaries: Buffer[] = [];

  beforeAll(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "sendspin-announce-"));
    setSendspinIdentityDir(tmpDir);
    await startSendspinService(PORT);
    // 本地 TTS 外链
    const wav = makeWav();
    httpSrv = http.createServer((req, res) => {
      res.writeHead(200, { "Content-Type": "audio/wav", "Content-Length": wav.length });
      res.end(wav);
    });
    await new Promise<void>((r) => httpSrv!.listen(0, "127.0.0.1", r));
    const addr = httpSrv!.address();
    ttsUrl = `http://127.0.0.1:${(addr as any).port}/tts.wav`;
    // legacy 直连收音频
    ws = new WebSocket(`ws://127.0.0.1:${PORT}/sendspin`);
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("no hello")), 5000);
      ws!.on("open", () => ws!.send(JSON.stringify({ type: "client/hello", payload: { client_id: CID, name: "announce-test", version: 1, supported_roles: ["player@v1"] } })));
      ws!.on("message", (data, isBinary) => {
        if (isBinary) { binaries.push(Buffer.from(data as Buffer)); return; }
        try {
          if (JSON.parse(data.toString("utf8"))?.type === "server/hello") { clearTimeout(timer); resolve(); }
        } catch { /* ignore */ }
      });
      ws!.on("error", reject);
    });
    const srv = getSendspinServer()!;
    await waitFor(() => !!srv.clients.get(CID), 5000, "legacy conn");
  }, 60000);

  afterAll(async () => {
    try { ws?.terminate(); } catch { /* ignore */ }
    httpSrv?.close();
    await stopSendspinService();
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("闲置队列播报:收到 TTS 音频,音量恢复,不污染 current", async () => {
    const srv = getSendspinServer()!;
    const conn = srv.clients.get(CID)!;
    conn.volume = 77;
    const before = binaries.length;
    const r = await announceOnPeer({ peerId: `sendspin:${CID}`, url: ttsUrl, volume: 60 });
    expect(r).toEqual({ targets: 1 });
    // TTS 音频帧到达(RAW BINARY 0x04)
    await waitFor(() => binaries.length > before, 15000, "等 TTS 音频帧");
    expect(binaries[binaries.length - 1][0]).toBe(0x04);
    // 音量恢复
    expect(conn.volume).toBe(77);
    expect(srv.group(CID).volume).toBe(100);
    // 闲置队列 current 保持空
    expect(srv.group(CID).current).toBeNull();
  }, 60000);

  it("并发播报被拒", async () => {
    const srv = getSendspinServer()!;
    // 占住播报锁:直接调两次,第二次应立即拒绝(第一次还在推 0.5s 音频时)
    const p1 = announceOnPeer({ peerId: `sendspin:${CID}`, url: ttsUrl });
    await expect(announceOnPeer({ peerId: `sendspin:${CID}`, url: ttsUrl })).rejects.toThrow(/正在播报中/);
    await p1;
    void srv;
  }, 60000);
});
