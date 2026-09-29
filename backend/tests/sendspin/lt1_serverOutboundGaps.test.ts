// server.ts 覆盖率补口(离线白盒):出站编码/分片、握手分支收口、心跳与重拨单飞。
//
// 缺口背景(全部此前零覆盖):
//   - 心跳看门狗:第一拍 ping、第二拍仍无 pong → terminate;非 OPEN 状态必须跳过。
//     漏判 = 死连接永不回收(幽灵连接占着 clientId,设备重连被拒);
//   - sendBinary/sendAudio 的 legacy / 加密两条出站路径(legacy 走裸 BINARY);
//   - _sendPlain 的**分片**路径(载荷 > 64KB 时必须切帧,否则单帧超限被对端丢弃);
//   - announceStream 在 codec=flac 且尚未有真实头时回落**合成 STREAMINFO**;
//   - sendPlayerCommand / _enc / fail / close 的 try-catch 收口(不许外抛打断调用方);
//   - re-handshake 30s 超时必须 reject 并清空状态(否则后续配对永远"已在进行中");
//   - 畸形 base64 的噪声消息必须 fail/abort 而不是把异常抛进事件循环;
//   - dialPlayer 同目标单飞(双连接会被设备仲裁踢掉一个)。
//
// 隔离:全部走 _connStubs 的受控假 socket,**不监听端口**(listen/dial 网络面另有
// serverListenDialGaps.test.ts)。唯一替身是 util.b64urlDecode —— 真实实现对非法字符
// 静默丢弃、从不抛错,故「畸形 base64」这几处 catch 是**防御性死分支**;这里仅让哨兵
// 字符串抛错以验证「万一真抛了,收口是否把连接正确判废」,其余输入仍走真实实现。
import "../plugins/_env.js";

import { describe, it, expect, vi, afterEach } from "vitest";

vi.mock("../../src/services/sendspin/util.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/services/sendspin/util.js")>();
  return {
    ...actual,
    b64urlDecode: (s: string) => {
      if (s === "__BAD__") throw new Error("malformed base64");
      return actual.b64urlDecode(s);
    },
  };
});

import {
  SendspinConnection,
  DEFAULT_SUITE,
} from "../../src/services/sendspin/server.js";
import { MAX_TRANSPORT_PLAINTEXT } from "../../src/services/sendspin/constants.js";
import { jsonBody } from "./_connStubs.js";
import { makeServer, makeConn, makeLegacyConn, logsContain } from "./_connStubs.js";

/** 给非 legacy 连接装一个"透明"噪声层:加密即原样返回,便于检查明文出站帧。 */
const stubNoise = (conn: SendspinConnection, over: any = {}) =>
  ((conn as any).noise = { handshakeHash: new Uint8Array(32).fill(1), encrypt: (b: Uint8Array) => b, ...over });

afterEach(() => {
  vi.useRealTimers();
});

describe("server:套件名与配对序号", () => {
  it("suiteName 恒为默认套件(配对 AEAD 选型依据)", () => {
    const { srv } = makeServer();
    const { conn, ws } = makeConn(srv);
    expect(conn.suiteName()).toBe(DEFAULT_SUITE);
    ws.terminate();
  });

  it("nextPairingIndex 每次自增(PAKE sid 必须每轮不同,否则可重放)", () => {
    const { srv } = makeServer();
    const { conn, ws } = makeConn(srv);
    const a = conn.nextPairingIndex();
    const b = conn.nextPairingIndex();
    expect(b).toBe(a + 1);
    ws.terminate();
  });
});

describe("server:心跳看门狗", () => {
  it("第一拍 ping;第二拍仍无 pong → terminate(死连接必须回收)", () => {
    vi.useFakeTimers();
    const { srv } = makeServer();
    const { ws } = makeConn(srv);
    vi.advanceTimersByTime(10_000);
    expect(ws.pingCount).toBe(1); // 首拍:alive 初始 true → ping 并置 false
    // 修复后容错单次抖动:需连续 HEARTBEAT_MAX_MISSES=3 拍未回 pong 才摔牌(≈30s 宽限)。
    vi.advanceTimersByTime(30_000); // 第二/三/四拍仍无 pong ⇒ misses 累到 3 ⇒ 第 4 拍 terminate
    // 契约:连续 3 拍未回 pong ⇒ 判定对端已死,terminate 释放 clientId。
    expect(ws.terminateCount).toBe(1);
  });

  it("readyState 非 OPEN(拨号握手中/已关闭)→ 本拍跳过,不 ping 不 terminate", () => {
    vi.useFakeTimers();
    const { srv } = makeServer();
    const { ws } = makeConn(srv);
    ws.readyState = 2; // CLOSING:拨号握手中/已关闭
    vi.advanceTimersByTime(10_000);
    // 契约:CONNECTING/CLOSING 上 ping() 会抛;必须早退而不是把异常抛进定时器。
    expect(ws.pingCount).toBe(0);
    expect(ws.terminateCount).toBe(0);
  });
});

describe("server:sendBinary / sendAudio 双路径出站", () => {
  it("legacy 连接:sendBinary 走裸 BINARY 单帧(binary=true)", () => {
    const { srv } = makeServer();
    const { conn, ws } = makeLegacyConn(srv);
    conn.sendBinary(new Uint8Array([1, 2, 3]));
    const last = ws.sent.at(-1)!;
    expect(last.binary).toBe(true);
    expect(Array.from(last.data)).toEqual([1, 2, 3]);
    ws.terminate();
  });

  it("加密连接:sendBinary 走 _sendPlain(噪声层加密封装)", () => {
    const { srv } = makeServer();
    const { conn, ws } = makeConn(srv);
    stubNoise(conn);
    conn.sendBinary(new Uint8Array([9, 8, 7]));
    expect(Array.from(ws.sent.at(-1)!.data)).toEqual([9, 8, 7]);
    ws.terminate();
  });

  it("socket 已非 OPEN:sendBinary/sendAudio 一律静默丢弃(不抛)", () => {
    const { srv } = makeServer();
    const { conn, ws } = makeConn(srv);
    stubNoise(conn);
    ws.readyState = 3; // CLOSED
    const before = ws.sent.length;
    conn.sendBinary(new Uint8Array([1]));
    conn.sendAudio(1n, new Uint8Array([2]));
    expect(ws.sent.length).toBe(before);
    ws.terminate();
  });

  it("加密连接:sendAudio 帧头为 9B(0x04 + 8B 大端时间戳)", () => {
    const { srv } = makeServer();
    const { conn, ws } = makeConn(srv);
    stubNoise(conn);
    conn.sendAudio(0x0102030405060708n, new Uint8Array([0xaa, 0xbb]));
    const out = Buffer.from(ws.sent.at(-1)!.data);
    expect(out[0]).toBe(0x04);
    expect(out.readBigInt64BE(1)).toBe(0x0102030405060708n);
    expect(out[9]).toBe(0xaa);
    ws.terminate();
  });
});

describe("server:_sendPlain 分片(载荷 > 单帧上限)", () => {
  it("超过 MAX_TRANSPORT_PLAINTEXT 的载荷被切成多帧,每帧不超限,重组逐字节还原", () => {
    const { srv } = makeServer();
    const { conn, ws } = makeConn(srv);
    stubNoise(conn);
    const body = new Uint8Array(MAX_TRANSPORT_PLAINTEXT + 5000);
    for (let i = 0; i < body.length; i++) body[i] = (i * 7) & 0xff;
    conn.sendBinary(body);
    const frames = ws.sent.map((f) => Buffer.from(f.data));
    // 契约:任何单帧都不得超过传输层上限(否则对端丢弃整帧 → 音频无声且无报错)。
    expect(frames.length).toBeGreaterThanOrEqual(2);
    for (const f of frames) expect(f.length).toBeLessThanOrEqual(MAX_TRANSPORT_PLAINTEXT);
    // 首帧头 = [MORE, type],续帧头 = 1B;重组后必须逐字节等于原始 body。
    const type = frames[0][1];
    const rest = Buffer.concat([frames[0].subarray(2), ...frames.slice(1).map((f) => f.subarray(1))]);
    const rebuilt = Buffer.concat([Buffer.from([type]), rest]);
    expect(Buffer.compare(rebuilt, Buffer.from(body))).toBe(0);
    ws.terminate();
  });

  it("恰好等于上限的载荷不切帧(边界不多切)", () => {
    const { srv } = makeServer();
    const { conn, ws } = makeConn(srv);
    stubNoise(conn);
    conn.sendBinary(new Uint8Array(MAX_TRANSPORT_PLAINTEXT));
    expect(ws.sent).toHaveLength(1);
    ws.terminate();
  });
});

describe("server:announceStream 的 FLAC 头回落", () => {
  it("codec=flac 且无组(尚未起播)→ 用合成 STREAMINFO 宣告,不能缺 codec_header", () => {
    const { srv } = makeServer();
    const { conn, ws } = makeLegacyConn(srv);
    conn.codec = "flac";
    (conn as any).group = null;
    conn.announceStream();
    const msg = ws.jsonOf("stream/start").at(-1)!;
    // 契约:缺 codec_header 时设备无法初始化解码器 → 日志全绿但无声。
    expect(typeof msg.payload.player.codec_header).toBe("string");
    expect(msg.payload.player.codec_header.length).toBeGreaterThan(0);
    ws.terminate();
  });
});

describe("server:出站/收口的 try-catch", () => {
  it("sendPlayerCommand:底层 send 抛错 → 返回 false,不外抛(路由层不炸)", () => {
    const { srv } = makeServer();
    const { conn, ws } = makeLegacyConn(srv); // legacy hello 已宣告 volume/mute
    expect(conn.supportsCommand("volume")).toBe(true);
    ws.throwOnSend = true;
    expect(conn.sendPlayerCommand({ command: "volume", volume: 50 })).toBe(false);
    ws.terminate();
  });

  it("sendPlayerCommand:设备未宣告该命令 → 直接 false,绝不硬发", () => {
    const { srv } = makeServer();
    const { conn, ws } = makeLegacyConn(srv, {
      "player@v1_support": { supported_formats: [{ codec: "pcm" }], supported_commands: [] },
    });
    expect(conn.sendPlayerCommand({ command: "mute", mute: true })).toBe(false);
    ws.terminate();
  });

  it("_enc:噪声层加密抛错 → 静默丢弃该帧(不把异常抛进调用方)", () => {
    const { srv } = makeServer();
    const { conn, ws } = makeConn(srv);
    stubNoise(conn, {
      encrypt: () => {
        throw new Error("enc boom");
      },
    });
    const before = ws.sent.length;
    expect(() => conn.sendJson("whatever")).not.toThrow();
    expect(ws.sent.length).toBe(before);
    ws.terminate();
  });

  it("fail():terminate 抛错也必须吞掉(收口不能二次抛)", () => {
    const { srv, logs } = makeServer();
    const { conn, ws } = makeConn(srv);
    ws.throwOnTerminate = true;
    expect(() => (conn as any).fail("协议错误")).not.toThrow();
    expect(logsContain(logs, "协议错误")).toBe(true);
  });

  it("close():terminate 抛错也必须吞掉", () => {
    const { srv } = makeServer();
    const { conn, ws } = makeConn(srv);
    ws.throwOnTerminate = true;
    expect(() => conn.close()).not.toThrow();
  });
});

describe("server:re-handshake 错误收口", () => {
  it("30s 未收到 msg2 → reject 并清空 rehandshaking(否则永久卡在已在进行中)", async () => {
    vi.useFakeTimers();
    const { srv } = makeServer();
    const { conn, ws } = makeConn(srv);
    stubNoise(conn);
    (conn as any).hsRemotePub = new Uint8Array(32).fill(2);
    conn.legacy = false;
    const p = conn.rehandshakeTo("ab".repeat(32), "sn");
    const assertion = expect(p).rejects.toThrow("re-handshake timeout");
    await vi.advanceTimersByTimeAsync(30_000);
    await assertion;
    expect((conn as any).rehandshaking).toBeNull();
    ws.terminate();
  });

  it("msg2 解码抛错 → 走 failRehandshake:reject 且状态清空", () => {
    const { srv } = makeServer();
    const { conn, ws } = makeConn(srv);
    const reject = vi.fn();
    (conn as any).rehandshaking = {
      session: {} as any,
      category: "sn",
      resolve: vi.fn(),
      reject,
      timer: setTimeout(() => {}, 1000),
    };
    (conn as any).onRehandshakeMsg2("__BAD__");
    expect(reject).toHaveBeenCalledTimes(1);
    expect(String(reject.mock.calls[0][0].message)).toContain("malformed re-handshake");
    expect((conn as any).rehandshaking).toBeNull();
    ws.terminate();
  });

  it("msg2 认证失败(readMessage 抛)→ failRehandshake 带 auth failed 原因", () => {
    const { srv } = makeServer();
    const { conn, ws } = makeConn(srv);
    const reject = vi.fn();
    (conn as any).rehandshaking = {
      session: {
        readMessage: () => {
          throw new Error("auth failed");
        },
      } as any,
      category: "sn",
      resolve: vi.fn(),
      reject,
      timer: setTimeout(() => {}, 1000),
    };
    (conn as any).onRehandshakeMsg2("AAAA");
    expect(reject).toHaveBeenCalledTimes(1);
    expect(String(reject.mock.calls[0][0].message)).toContain("auth failed");
    ws.terminate();
  });
});

describe("server:握手/分发错误收口", () => {
  it("completeHandshake:畸形 base64 → fail(不把解码异常抛进事件循环)", () => {
    const { srv, logs } = makeServer();
    const { conn } = makeConn(srv);
    expect(() => (conn as any).completeHandshake("__BAD__")).not.toThrow();
    expect(logsContain(logs, "malformed noise message 2 payload encoding")).toBe(true);
  });

  it("re-handshake 期间收到 client/hello → 仍按激活处理(协议期允许)", () => {
    const { srv } = makeServer();
    const { conn, ws } = makeConn(srv);
    stubNoise(conn);
    (conn as any).clientId = "C-RH";
    (conn as any).rehandshaking = {
      session: {} as any,
      category: "sn",
      resolve: vi.fn(),
      reject: vi.fn(),
      timer: setTimeout(() => {}, 1000),
    };
    (conn as any)._dispatch(jsonBody({ type: "client/hello", payload: { name: "新名", supported_roles: ["player@v1"] } }));
    // 契约:re-handshake 只禁「应用消息」,hello 必须放行 —— 否则换完密钥设备无法重新激活。
    expect((conn as any).name).toBe("新名");
    expect((conn as any).roles.length).toBeGreaterThan(0);
    ws.terminate();
  });

  it("凭证失配(sentinelMismatch)→ 空激活、不注册 peer,等重新配对", () => {
    const { srv, logs } = makeServer();
    const { conn, ws } = makeLegacyConn(srv);
    (conn as any).sentinelMismatch = true;
    (conn as any).onClientHello({ name: "被扣留" });
    const msg = ws.jsonOf("server/activate").at(-1)!;
    // 契约:失配设备不许拿到 playback 能力(否则绕过配对就能播)。
    expect(msg.payload.activities).toEqual([]);
    expect((conn as any).roles).toEqual([]);
    expect(logsContain(logs, "credential mismatch held")).toBe(true);
    ws.terminate();
  });
});

describe("server:dialPlayer 同目标单飞", () => {
  it("同 URL 已有在飞的拨号 → 直接复用该 promise,不另开 socket", async () => {
    const { srv, logs } = makeServer();
    const existing = {} as SendspinConnection;
    (srv as any).pendingDials.set("dial:ws://10.0.0.9:8928/sendspin", Promise.resolve(existing));
    const got = await srv.dialPlayer("ws://10.0.0.9:8928/sendspin");
    // 契约:并发重拨会形成双连接 → 设备仲裁踢掉一个(another_server 风暴)。
    expect(got).toBe(existing);
    expect(logsContain(logs, "已在进行中,复用")).toBe(true);
  });
});
