// legacy 明文客户端直通(对齐 MA allow_legacy_clients)。
//
// 前加密时代客户端(ESPHome/sendspin-cpp、aiosendspin<7)发明文 client/hello,
// 无 Noise 握手:服务端回明文 server/hello 即激活,全程 TEXT/RAW BINARY。
// 配对不可用,peer 标记 unencrypted。
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import WebSocket from "ws";
import { setSendspinIdentityDir, startSendspinService, stopSendspinService, getSendspinServer } from "./index.js";
import { getPeerManager } from "../peer.js";

const PORT = 18927;
const URL = `ws://127.0.0.1:${PORT}/sendspin`;
const LEGACY_ID = "AA:BB:CC:DD:EE:FF";
const LEGACY_NAME = "Speaker Media Player";

function connectHello(payload: any): Promise<{ ws: WebSocket; hello: any }> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(URL);
    const timer = setTimeout(() => { try { ws.terminate(); } catch {} reject(new Error("no server/hello")); }, 5000);
    ws.on("error", (e) => { clearTimeout(timer); reject(e); });
    ws.on("close", () => { clearTimeout(timer); reject(new Error("closed before server/hello")); });
    ws.on("open", () => ws.send(JSON.stringify({ type: "client/hello", payload })));
    ws.on("message", (data, isBinary) => {
      if (isBinary) return;
      try {
        const msg = JSON.parse(data.toString("utf8"));
        if (msg?.type === "server/hello") {
          clearTimeout(timer);
          resolve({ ws, hello: msg.payload });
        }
      } catch { /* ignore */ }
    });
  });
}

async function waitFor(fn: () => boolean, ms = 3000): Promise<void> {
  const t0 = Date.now();
  for (;;) {
    if (fn()) return;
    if (Date.now() - t0 > ms) throw new Error("waitFor timeout");
    await new Promise((r) => setTimeout(r, 50));
  }
}

describe("sendspin legacy 明文直通", () => {
  let tmpDir: string;

  beforeAll(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "sendspin-legacy-"));
    setSendspinIdentityDir(tmpDir);
    await startSendspinService(PORT);
  });

  afterAll(async () => {
    await stopSendspinService();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("明文 client/hello → 明文 server/hello,激活并注册 peer(名=hello名,unencrypted)", async () => {
    const { ws, hello } = await connectHello({
      client_id: LEGACY_ID,
      name: LEGACY_NAME,
      version: 1,
      supported_roles: ["player@v1"],
    });
    try {
      // server/hello 字段需齐(sendspin-cpp 严格校验缺字段即拒收)。
      expect(typeof hello.server_id).toBe("string");
      expect(hello.server_id.length).toBe(43);
      expect(typeof hello.name).toBe("string");
      expect(hello.version).toBe(1);
      expect(hello.active_roles).toContain("player@v1");
      // connection_reason 必须在且合法(discovery/playback 二选一):
      // sendspin-cpp 要求五字段齐全,缺失或非法都判整个 hello 作废(2026-09-17 真机)。
      expect(["discovery", "playback"]).toContain(hello.connection_reason);
      // 连接标记 legacy,peer 注册且名为 hello 名、标 unencrypted。
      const srv = getSendspinServer()!;
      await waitFor(() => srv.clients.get(LEGACY_ID)?.legacy === true);
      await waitFor(() => {
        const p = getPeerManager().get(`sendspin:${LEGACY_ID}`);
        return !!p && p.name === LEGACY_NAME && p.available === true && p.unencrypted === true;
      });
    } finally {
      ws.terminate();
    }
    // 断开后 peer 移除(与加密路径一致)。
    await waitFor(() => getPeerManager().get(`sendspin:${LEGACY_ID}`) === undefined);
  });

  it("stream/start 明文下发 + 音频 RAW BINARY 直通(0x04 头)", async () => {
    const { ws } = await connectHello({
      client_id: "LEGACY-STREAM-1",
      name: "legacy-stream",
      version: 1,
      supported_roles: ["player@v1"],
    });
    const srv = getSendspinServer()!;
    await waitFor(() => !!srv.clients.get("LEGACY-STREAM-1"));
    const conn = srv.clients.get("LEGACY-STREAM-1")!;
    const texts: any[] = [];
    const binaries: Buffer[] = [];
    ws.on("message", (data, isBinary) => {
      if (isBinary) binaries.push(Buffer.from(data as Buffer));
      else {
        try { texts.push(JSON.parse(data.toString("utf8"))); } catch { /* ignore */ }
      }
    });
    try {
      conn.announceStream();
      await waitFor(() => texts.some((m) => m?.type === "stream/start"));
      const start = texts.find((m) => m?.type === "stream/start");
      // stream/start player 对象字段需齐(sendspin-cpp 校验缺字段即拒收)。
      expect(start.payload.player.codec).toBe("pcm");
      expect(start.payload.player.sample_rate).toBe(48000);
      expect(start.payload.player.channels).toBe(2);
      expect(start.payload.player.bit_depth).toBe(16);
      // 音频:单帧 RAW BINARY,不分片不加密。
      conn.sendAudio(123456789n, new Uint8Array([1, 2, 3]));
      await waitFor(() => binaries.length > 0);
      const f = binaries[0];
      expect(f[0]).toBe(0x04);
      expect(f.readBigInt64BE(1)).toBe(123456789n);
      expect([...f.subarray(9)]).toEqual([1, 2, 3]);
      // 真推流:合成 20ms PCM 经组 opus 编码下发,legacy 端收到可解音频帧。
      binaries.length = 0;
      const srv2 = getSendspinServer()!;
      const g = srv2.group("LEGACY-STREAM-1");
      g.add(conn);
      await g.pushFrame(987654321n, new Float32Array(1920));
      await waitFor(() => binaries.length > 0);
      const af = binaries[0];
      expect(af[0]).toBe(0x04);
      expect(af.readBigInt64BE(1)).toBe(987654321n);
      expect(af.length).toBeGreaterThan(9); // pcm 编码体非空
    } finally {
      ws.terminate();
    }
  });

  it("allowLegacyClients=false 时明文 hello 被拒(连接直接断开)", async () => {
    const srv = getSendspinServer()!;
    srv.allowLegacyClients = false;
    try {
      await expect(connectHello({
        client_id: "LEGACY-DENIED-1",
        name: "denied",
        version: 1,
        supported_roles: ["player@v1"],
      })).rejects.toThrow();
      expect(srv.clients.get("LEGACY-DENIED-1")).toBeUndefined();
      expect(getPeerManager().get("sendspin:LEGACY-DENIED-1")).toBeUndefined();
    } finally {
      srv.allowLegacyClients = true;
    }
  });
});

describe("negotiateCodec 键名兼容", () => {
  it("9.x 别名 player@v1_support 与老 player_support 都认", async () => {
    const { negotiateCodec } = await import("./server.js");
    const fmts = [{ codec: "flac", channels: 2, sample_rate: 48000, bit_depth: 16 }];
    expect(negotiateCodec({ "player@v1_support": { supported_formats: fmts } })).toBe("flac");
    expect(negotiateCodec({ player_support: { supported_formats: fmts } })).toBe("flac");
    expect(negotiateCodec({})).toBe("pcm");
    expect(negotiateCodec({ "player@v1_support": { supported_formats: [{ codec: "mp3" }] } })).toBe("pcm");
    // ESPHome 声明 flac/opus/pcm:默认应落在 pcm(跳过 opus)。
    expect(negotiateCodec({ "player@v1_support": { supported_formats: [{ codec: "opus" }, { codec: "flac" }] } })).toBe("flac");
    expect(negotiateCodec({ "player@v1_support": { supported_formats: [{ codec: "opus" }] } })).toBe("pcm");
  });
});
