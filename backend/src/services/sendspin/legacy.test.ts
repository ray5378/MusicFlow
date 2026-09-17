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
      // codec 走协商默认 flac(2026-09-17 真机:MA 金标准用 FLAC 才进 PLAYING,
      // 已改 flac 优先 → pcm 次选 → 默认 flac,不再回退 opus/pcm)。
      expect(start.payload.player.codec).toBe("flac");
      expect(start.payload.player.sample_rate).toBe(48000);
      expect(start.payload.player.channels).toBe(2);
      expect(start.payload.player.bit_depth).toBe(16);
      // FLAC 必须带 codec_header(STREAMINFO 的 base64),否则严格客户端拒收整条 stream/start。
      expect(typeof start.payload.player.codec_header).toBe("string");
      expect(start.payload.player.codec_header.length).toBeGreaterThan(0);
      // 音频:单帧 RAW BINARY,不分片不加密。**9B 头** = [0x04][i64 μs],data 从 9 起。
      // ⚠️ 不得是 13B(多 4B send_ahead)—— 设备侧会把那 4B 当 FLAC 数据 → 每包解码失败。
      conn.sendAudio(123456789n, new Uint8Array([1, 2, 3]));
      await waitFor(() => binaries.length > 0);
      const f = binaries[0];
      expect(f[0]).toBe(0x04);
      expect(f.readBigInt64BE(1)).toBe(123456789n);
      expect([...f.subarray(9)]).toEqual([1, 2, 3]);
      expect(f.length).toBe(9 + 3);
      // 真推流:合成 20ms PCM 经组协商编码器(默认 flac)下发,legacy 端收到帧为 0x04 头。
      binaries.length = 0;
      const srv2 = getSendspinServer()!;
      const g = srv2.group("LEGACY-STREAM-1");
      g.add(conn);
      await g.pushFrame(987654321n, new Float32Array(1920));
      // 分段 FLAC:一段 = 0.5s PCM,单帧 20ms 不足以关段 → 可能暂无可发字节,
      // 断言"不报错且帧头格式正确"即可(完整段在累积到阈值后一次性发出)。
      const af = binaries[0];
      if (af) {
        expect(af[0]).toBe(0x04);
        expect(af.readBigInt64BE(1)).toBe(987654321n);
        expect(af.length).toBeGreaterThan(9);
      }
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
    // 无声明/非法声明 → 默认 flac(带 codec_header,严格客户端唯一稳妥解)。
    expect(negotiateCodec({})).toBe("flac");
    expect(negotiateCodec({ "player@v1_support": { supported_formats: [{ codec: "mp3" }] } })).toBe("flac");
    // **PCM 优先**(2026-09-17 改,真机实测):设备 FP32 解码 FLAC 每 85ms 要解
    // 4096 样本帧,CPU 峰值高且易失步;PCM 零解码(memcpy)、零攒样,是 ESPHome 最优解。
    expect(negotiateCodec({ "player@v1_support": { supported_formats: [{ codec: "opus" }, { codec: "flac" }] } })).toBe("flac");
    // 同时声明 flac+pcm → **必须选 pcm**(这是本次改动的核心断言)
    expect(negotiateCodec({ "player@v1_support": { supported_formats: [{ codec: "flac" }, { codec: "pcm" }] } })).toBe("pcm");
    expect(negotiateCodec({ "player@v1_support": { supported_formats: [{ codec: "opus" }, { codec: "pcm" }] } })).toBe("pcm");
    expect(negotiateCodec({ "player@v1_support": { supported_formats: [{ codec: "opus" }] } })).toBe("flac");
  });

  it("preferred_codec=flac 时反转为 FLAC 优先,设备不支持仍自动回落", async () => {
    const { negotiateCodec, normalizeCodecPreference } = await import("./server.js");
    const both = { "player@v1_support": { supported_formats: [{ codec: "flac" }, { codec: "pcm" }] } };
    // 偏好 flac → 即便设备也支持 pcm,仍选 flac。
    expect(negotiateCodec(both, "flac")).toBe("flac");
    // 同一个 payload,偏好 pcm → 选 pcm(与上一行构成「顺序由偏好决定」的完整对)。
    expect(negotiateCodec(both, "pcm")).toBe("pcm");
    // 偏好只是**优先**不是强制:设备不支持首选就退到另一种。
    expect(negotiateCodec({ "player@v1_support": { supported_formats: [{ codec: "pcm" }] } }, "flac")).toBe("pcm");
    expect(negotiateCodec({ "player@v1_support": { supported_formats: [{ codec: "flac" }] } }, "pcm")).toBe("flac");
    // 非法/缺失偏好一律收敛到 pcm,绝不产出 undefined 让下游走错分支。
    expect(normalizeCodecPreference(undefined)).toBe("pcm");
    expect(normalizeCodecPreference("opus")).toBe("pcm");
    expect(normalizeCodecPreference("FLAC")).toBe("flac");
  });
});
