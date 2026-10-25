// ==================== AP2 传输层（Phase 6b 批 2）跨实现验证 ====================
//
// 测试向量由 230 床 venv 生成（tests/fixtures/ap2/transport_vectors.json）：
//   - bplist：bed venv biplist（对端同款）独立编码 → TS bplistDecode 语义还原。
//   - HAPSocket：pycryptodome 按对端 hap.py HAPSocket 语义（nonce = pack("Q",n).rjust(12)、
//     AAD = 2B LE 长度）独立生成完整帧 → TS HapCipher/HapChannel 逐字节一致 / 可解密。
// TS 侧实现（bplist.ts / hapSocket.ts / rtspClient.ts）完全独立，固定随机数跨实现比对。
//
// MUST be the first import: 在 backend 模块加载前把 DATA_DIR 指到隔离临时目录。
import "../plugins/_env.js";

import { readFileSync } from "node:fs";
import { createConnection, createServer, type AddressInfo, type Socket } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  BplistError,
  bplistDecode,
  bplistEncode,
  type PlistValue,
} from "../../src/services/airplay/ap2/bplist.js";
import { hkdfSha512 } from "../../src/services/airplay/ap2/hapCrypto.js";
import { HapChannel, HapCipher } from "../../src/services/airplay/ap2/hapSocket.js";
import {
  Ap2RtspClient,
  buildRequest,
  HttpFramer,
  RTSP_USER_AGENT,
  RtspError,
  type RtspCommonHeaders,
} from "../../src/services/airplay/ap2/rtspClient.js";

const vec = JSON.parse(
  readFileSync(
    path.resolve(fileURLToPath(import.meta.url), "..", "..", "fixtures", "ap2", "transport_vectors.json"),
    "utf8",
  ),
) as {
  meta: Record<string, string>;
  hkdf: { ikm: string; salt: string; write_key: string; read_key: string };
  bplist: { hex: string; expect: unknown }[];
  hapsocket: {
    shared_key: string; write_key: string; read_key: string;
    out: {
      single: { counter: number; plain: string; frame: string };
      multi: { counter: number; plain: string; frames: string[] };
      after_multi: { counter: number; plain: string; frame: string };
    };
    in: { frames: string[]; plains: string[] };
  };
};

const fromHex = (h: string): Buffer => Buffer.from(h, "hex");

const COMMON: RtspCommonHeaders = {
  dacpId: "ABCDEF0123456789",
  activeRemote: "1234567890",
  hkp: 4,
};

/** 轮询等待谓词成立（本地 socket 测试用）。 */
async function until(pred: () => boolean, ms = 2000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!pred()) {
    if (Date.now() > deadline) throw new Error("本地测试等待超时");
    await new Promise((r) => setTimeout(r, 5));
  }
}

/** 起一对本地 TCP socket（127.0.0.1 随机端口）。 */
async function socketPair(): Promise<{ client: Socket; server: Socket; close: () => void }> {
  const srv = createServer();
  await new Promise<void>((resolve) => srv.listen(0, "127.0.0.1", resolve));
  const port = (srv.address() as AddressInfo).port;
  const serverGot = new Promise<Socket>((resolve) => srv.once("connection", resolve));
  const client = createConnection({ host: "127.0.0.1", port });
  const server = await serverGot;
  return {
    client,
    server,
    close: () => {
      client.destroy();
      server.destroy();
      srv.close();
    },
  };
}

/** bplist 解码结果 → 与 python tagged JSON 同构的规范化形态。 */
function normalize(v: PlistValue): unknown {
  if (Buffer.isBuffer(v)) return { __data__: v.toString("hex") };
  if (Array.isArray(v)) return v.map(normalize);
  if (v !== null && typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v)) out[k] = normalize(val);
    return out;
  }
  return v;
}

// ---------------------------------------------------------------------------
// bplist
// ---------------------------------------------------------------------------
describe("bplist 跨实现（biplist 编码 → TS 解码语义还原）", () => {
  it.each(vec.bplist.map((s, i) => [i, s] as const))("样例 #%i 解码与自编码往返", (_i, sample) => {
    const blob = fromHex(sample.hex);
    expect(blob.subarray(0, 8).toString("ascii")).toBe("bplist00");
    const decoded = bplistDecode(blob);
    expect(normalize(decoded)).toEqual(sample.expect);
    // 自编码 → 再解码 → 语义不变（编码器自洽闭合）
    const re = bplistDecode(bplistEncode(decoded));
    expect(normalize(re)).toEqual(sample.expect);
  });

  it("Date 编解码往返（AP2 未用但实现保留）", () => {
    const d = new Date(Date.UTC(2025, 0, 2, 3, 4, 5));
    const out = bplistDecode(bplistEncode(d));
    expect(out instanceof Date).toBe(true);
    expect((out as Date).getTime()).toBe(d.getTime());
  });

  it("负数 int / 超长字符串（2B 长度标记）编解码往返", () => {
    const root = { neg: -12345, long: "x".repeat(300) };
    const out = bplistDecode(bplistEncode(root)) as Record<string, PlistValue>;
    expect(out.neg).toBe(-12345);
    expect(out.long).toBe("x".repeat(300));
  });

  it("非法输入报 BplistError", () => {
    expect(() => bplistDecode(Buffer.from("not a plist at all!!!!"))).toThrow(BplistError);
    const blob = bplistEncode({ a: 1 });
    expect(() => bplistDecode(blob.subarray(0, 20))).toThrow(BplistError); // 截断
  });
});

// ---------------------------------------------------------------------------
// HAPSocket
// ---------------------------------------------------------------------------
describe("HAPSocket 帧格式跨实现（pycryptodome 独立加密 → TS 逐字节一致）", () => {
  const hs = vec.hapsocket;
  const sharedKey = fromHex(hs.shared_key);

  it("HKDF 派生双向密钥与对端一致（controller 视角：发=Write、收=Read）", () => {
    const sharedKey = fromHex(vec.hapsocket.shared_key);
    expect(hkdfSha512(sharedKey, Buffer.from("Control-Salt", "ascii"),
      Buffer.from("Control-Write-Encryption-Key", "utf8"), 32)).toEqual(fromHex(vec.hkdf.write_key));
    expect(hkdfSha512(sharedKey, Buffer.from("Control-Salt", "ascii"),
      Buffer.from("Control-Read-Encryption-Key", "utf8"), 32)).toEqual(fromHex(vec.hkdf.read_key));
  });

  it("单块加密帧逐字节一致（counter 0）", () => {
    const cipher = new HapCipher(sharedKey);
    const frame = cipher.encryptBlock(fromHex(hs.out.single.plain));
    expect(frame).toEqual(fromHex(hs.out.single.frame));
    expect(cipher.outCounter).toBe(1);
  });

  it("跨块两次加密计数推进一致（0x400 满块 + 余块 + 下一调用）", () => {
    const cipher = new HapCipher(sharedKey);
    const plain = fromHex(hs.out.multi.plain);
    expect(cipher.encryptBlock(plain.subarray(0, 0x400))).toEqual(fromHex(hs.out.multi.frames[0]!));
    expect(cipher.encryptBlock(plain.subarray(0x400))).toEqual(fromHex(hs.out.multi.frames[1]!));
    expect(cipher.encryptBlock(fromHex(hs.out.after_multi.plain))).toEqual(fromHex(hs.out.after_multi.frame));
    expect(cipher.outCounter).toBe(3);
  });

  it("超限块抛错（> 0x400）", () => {
    const cipher = new HapCipher(sharedKey);
    expect(() => cipher.encryptBlock(Buffer.alloc(0x401))).toThrow(/超限/);
  });

  it("解密对端（python 加密）的收方向帧", () => {
    const cipher = new HapCipher(sharedKey);
    for (let i = 0; i < hs.in.frames.length; i++) {
      const frame = fromHex(hs.in.frames[i]!);
      const blockLen = frame.readUInt16LE(0);
      expect(cipher.decryptBlock(blockLen, frame.subarray(2))).toEqual(fromHex(hs.in.plains[i]!));
    }
    expect(cipher.inCounter).toBe(hs.in.frames.length);
  });
});

describe("HapChannel 本地 TCP 集成（对端字节流 = python 生成的帧）", () => {
  it("出方向：write 自动分块，线上字节与对端帧逐字节一致", async () => {
    const hs = vec.hapsocket;
    const pair = await socketPair();
    try {
      const client = new HapChannel(pair.client, fromHex(hs.shared_key));
      const got: Buffer[] = [];
      let gotLen = 0;
      pair.server.on("data", (c: Buffer) => {
        got.push(c);
        gotLen += c.length;
      });
      client.write(fromHex(hs.out.multi.plain)); // 2048B → 2 帧
      client.write(fromHex(hs.out.after_multi.plain)); // counter 2 帧
      await until(() => gotLen >= fromHex(hs.out.multi.frames[0]!).length
        + fromHex(hs.out.multi.frames[1]!).length + fromHex(hs.out.after_multi.frame).length);
      expect(Buffer.concat(got)).toEqual(Buffer.concat([
        fromHex(hs.out.multi.frames[0]!),
        fromHex(hs.out.multi.frames[1]!),
        fromHex(hs.out.after_multi.frame),
      ]));
    } finally {
      pair.close();
    }
  });

  it("收方向：半帧跨包到达可重组，明文按序解出", async () => {
    const hs = vec.hapsocket;
    const pair = await socketPair();
    try {
      const client = new HapChannel(pair.client, fromHex(hs.shared_key));
      const plains: Buffer[] = [];
      client.on("data", (p: Buffer) => plains.push(p));
      const f0 = fromHex(hs.in.frames[0]!);
      const f1 = fromHex(hs.in.frames[1]!);
      // 帧 0 故意拆两半到达（重组路径），帧 1 整帧到达
      pair.server.write(f0.subarray(0, 10));
      pair.server.write(Buffer.concat([f0.subarray(10), f1]));
      await until(() => plains.length === 2);
      expect(plains).toEqual([fromHex(hs.in.plains[0]!), fromHex(hs.in.plains[1]!)]);
    } finally {
      pair.close();
    }
  });

  it("全双工：controller 角色与 accessory 角色明文往返", async () => {
    const pair = await socketPair();
    try {
      const key = Buffer.alloc(32, 0x77);
      const a = new HapChannel(pair.client, key, "controller");
      const b = new HapChannel(pair.server, key, "accessory");
      const gotB: Buffer[] = [];
      const gotA: Buffer[] = [];
      b.on("data", (p: Buffer) => {
        gotB.push(p);
        b.write(Buffer.from("RTSP/1.0 200 OK\r\n\r\n", "ascii"));
      });
      a.on("data", (p: Buffer) => gotA.push(p));
      a.write(Buffer.from("OPTIONS * RTSP/1.0\r\n\r\n", "ascii"));
      await until(() => gotB.length === 1 && gotA.length === 1);
      expect(Buffer.concat(gotB).toString("ascii")).toContain("OPTIONS");
      expect(Buffer.concat(gotA).toString("ascii")).toContain("200 OK");
    } finally {
      pair.close();
    }
  });

  it("对端 tag 篡改 → error 且通道销毁", async () => {
    const hs = vec.hapsocket;
    const pair = await socketPair();
    try {
      const client = new HapChannel(pair.client, fromHex(hs.shared_key));
      const errors: Error[] = [];
      client.on("error", (e: Error) => errors.push(e));
      const f0 = fromHex(hs.in.frames[0]!);
      f0[f0.length - 1] ^= 0x01; // 破坏 tag 最后一字节
      pair.server.write(f0);
      await until(() => errors.length === 1);
      expect(errors[0]!.message).toContain("解密失败");
      expect(client.closed).toBe(true);
    } finally {
      pair.close();
    }
  });
});

// ---------------------------------------------------------------------------
// RTSP
// ---------------------------------------------------------------------------
describe("RTSP 请求构造与响应解析", () => {
  it("buildRequest 头序与字节全等（pair-verify 形态）", () => {
    const body = Buffer.alloc(77, 0xAB);
    const wire = buildRequest({
      method: "POST",
      url: "/pair-verify",
      cseq: 3,
      common: COMMON,
      contentType: "application/pairing+tlv8",
      body,
    });
    const expected =
      "POST /pair-verify RTSP/1.0\r\n" +
      "CSeq: 3\r\n" +
      `User-Agent: ${RTSP_USER_AGENT}\r\n` +
      `DACP-ID: ${COMMON.dacpId}\r\n` +
      `Active-Remote: ${COMMON.activeRemote}\r\n` +
      `X-Apple-HKP: ${COMMON.hkp}\r\n` +
      "Content-Type: application/pairing+tlv8\r\n" +
      "Content-Length: 77\r\n\r\n";
    expect(wire).toEqual(Buffer.concat([Buffer.from(expected, "latin1"), body]));
  });

  it("HttpFramer：头/体跨包、背靠背两报文", () => {
    const msg1 = Buffer.from("RTSP/1.0 200 OK\r\nCSeq: 1\r\nContent-Length: 4\r\n\r\nabcd", "latin1");
    const msg2 = Buffer.from("RTSP/1.0 401 Unauthorized\r\nCSeq: 2\r\nContent-Length: 0\r\n\r\n", "latin1");
    const framer = new HttpFramer();
    framer.push(msg1.subarray(0, 12));
    expect(framer.extract()).toBeNull();
    framer.push(Buffer.concat([msg1.subarray(12), msg2]));
    const r1 = framer.extract();
    expect(r1).not.toBeNull();
    expect(r1!.body.toString("ascii")).toBe("abcd");
    expect(r1!.head).toContain("200 OK");
    const r2 = framer.extract();
    expect(r2).not.toBeNull();
    expect(r2!.body.length).toBe(0);
    expect(framer.extract()).toBeNull();
  });
});

describe("Ap2RtspClient 加密通道端到端（本地假 accessory，双侧 HAPSocket 跨实现）", () => {
  const SHARED = fromHex(vec.hapsocket.shared_key);

  function startFakeAccessory(
    handler: (startLine: string) => { status: number; body?: Buffer; reply?: boolean },
  ): Promise<{ port: number; close: () => void }> {
    return new Promise((resolve) => {
      const srv = createServer((sock) => {
        const chan = new HapChannel(sock, SHARED, "accessory"); // 假 accessory：方向与 controller 相反
        const framer = new HttpFramer();
        chan.on("data", (plain: Buffer) => {
          framer.push(plain);
          const got = framer.extract();
          if (!got) return;
          const startLine = got.head.split("\r\n")[0]!;
          const want = handler(startLine);
          if (want.reply === false) return; // 显式不回包（超时用例）；undefined = 正常回包
          const body = want.body ?? Buffer.alloc(0);
          const head =
            `RTSP/1.0 ${want.status} ${want.status === 200 ? "OK" : "Not Found"}\r\n` +
            `CSeq: 1\r\nContent-Length: ${body.length}\r\n\r\n`;
          chan.write(Buffer.concat([Buffer.from(head, "latin1"), body]));
        });
      });
      srv.listen(0, "127.0.0.1", () => {
        resolve({
          port: (srv.address() as AddressInfo).port,
          close: () => srv.close(),
        });
      });
    });
  }

  it("SETUP 请求 → 加密往返 → 响应解析（bplist body）", async () => {
    const responseBody = bplistEncode({
      streams: [{ controlPort: 7202, dataPort: 7200, streamID: 1, type: 96 }],
    });
    const acc = await startFakeAccessory((startLine) => {
      expect(startLine).toContain("SETUP ");
      return { status: 200, body: responseBody };
    });
    const client = new Ap2RtspClient();
    try {
      await client.connect("127.0.0.1", acc.port);
      client.upgradeToEncrypted(SHARED);
      const resp = await client.request({
        method: "SETUP",
        url: "rtsp://127.0.0.1/9876543210",
        common: COMMON,
        contentType: "application/x-apple-binary-plist",
        body: bplistEncode({ streams: [] }),
      });
      expect(resp.status).toBe(200);
      expect(resp.headers.get("cseq")).toBe("1");
      const decoded = bplistDecode(resp.body) as { streams: { streamID: number }[] };
      expect(decoded.streams[0]!.streamID).toBe(1);
      expect(client.encrypted).toBe(true);
    } finally {
      client.destroy();
      acc.close();
    }
  });

  it("非 2xx 响应抛 RtspError（带 status）", async () => {
    const acc = await startFakeAccessory(() => ({ status: 404 }));
    const client = new Ap2RtspClient();
    try {
      await client.connect("127.0.0.1", acc.port);
      client.upgradeToEncrypted(SHARED);
      await expect(client.request({
        method: "POST",
        url: "/auth-setup",
        common: COMMON,
      })).rejects.toMatchObject({ status: 404 });
    } finally {
      client.destroy();
      acc.close();
    }
  });

  it("对端不应答 → 按超时报错", async () => {
    const acc = await startFakeAccessory(() => ({ status: 200, reply: false }));
    const client = new Ap2RtspClient();
    try {
      await client.connect("127.0.0.1", acc.port);
      client.upgradeToEncrypted(SHARED);
      await expect(client.request({
        method: "SETUP",
        url: "rtsp://127.0.0.1/x",
        common: COMMON,
        timeoutMs: 120,
      })).rejects.toThrow(/超时/);
    } finally {
      client.destroy();
      acc.close();
    }
  });

  it("RtspError 语义（status 默认 0）", () => {
    const e = new RtspError("plain");
    expect(e.status).toBe(0);
    expect(e.name).toBe("RtspError");
  });
});
