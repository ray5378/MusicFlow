// ==================== server.ts 补测共享替身(非测试文件) ====================
//
// `src/services/sendspin/server.ts` 的 `SendspinConnection` 只依赖 `ws` 的**七个面**:
//   `readyState` / `on(ev)` / `send(data,opts)` / `ping()` / `terminate()` / `close()` / `url`。
// 因此无需真起 WebSocketServer —— 用 EventEmitter 子类把 `readyState` 与事件收发显式
// 暴露出来,就能把「握手分流 / 帧分片 / 出站编码 / 错误收口」这些分支全部拉到单元层,
// 同时不碰任何真实端口/设备(真机联调另有 legacy.test.ts / dialE2E.test.ts 等集成测试)。
//
// 这里**不是**测试文件(vitest include 只收 `*.test.ts`),只被 sendspin 的补测 import。
import { EventEmitter } from "node:events";
import { x25519 } from "@noble/curves/ed25519";
import WebSocket from "ws";
import { asResponder, type NoiseSession } from "../../src/services/sendspin/handshake.js";
import { SENTINEL_PSK_HEX, PROTOCOL_VERSION } from "../../src/services/sendspin/constants.js";
import { packJsonBody } from "../../src/services/sendspin/framing.js";
import { b64urlDecode, b64urlEncode } from "../../src/services/sendspin/util.js";
import {
  DEFAULT_SUITE,
  SendspinConnection,
  SendspinServer,
  type SendspinLog,
  type SendspinServerOptions,
} from "../../src/services/sendspin/server.js";
import type { Identity } from "../../src/services/sendspin/identity.js";

/** 受控假 socket:只实现 SendspinConnection 真正用到的面。 */
export class FakeWs extends EventEmitter {
  readyState: number = WebSocket.OPEN;
  /** 出站帧流水(`binary` 反映调用方是否显式声明二进制)。 */
  sent: Array<{ data: any; binary: boolean }> = [];
  url = "";
  pingCount = 0;
  terminateCount = 0;
  /** 置 true 后 terminate() 抛错 —— 覆盖「socket 已死」的 try/catch 收口分支。 */
  throwOnTerminate = false;
  /** 置 true 后 send() 抛错 —— 覆盖下发命令的 try/catch 收口分支。 */
  throwOnSend = false;

  send(data: any, opts?: { binary?: boolean }): void {
    if (this.throwOnSend) throw new Error("socket send failed");
    this.sent.push({ data, binary: !!opts?.binary });
  }
  ping(): void {
    this.pingCount += 1;
  }
  terminate(): void {
    if (this.throwOnTerminate) throw new Error("socket already dead");
    if (this.readyState === WebSocket.CLOSED) return;
    this.terminateCount += 1;
    this.readyState = WebSocket.CLOSED;
    this.emit("close");
  }
  close(): void {
    this.terminate();
  }
  /** 第 i 个出站帧按 JSON 解析(非 JSON / 二进制返回 null);i 为负表示从末尾数。 */
  json(i = -1): any {
    const idx = i < 0 ? this.sent.length + i : i;
    const f = this.sent[idx];
    if (!f) return null;
    try {
      return JSON.parse(String(f.data));
    } catch {
      return null;
    }
  }
  /** 全部能解析成 JSON 且 type 相符的出站帧。 */
  jsonOf(type: string): any[] {
    const out: any[] = [];
    for (const f of this.sent) {
      try {
        const m = JSON.parse(String(f.data));
        if (m?.type === type) out.push(m);
      } catch {
        /* 加密帧/二进制帧解析不出 JSON,跳过 */
      }
    }
    return out;
  }
  /** 出站帧里 JSON 文本的部分(用于 server/init 这类裸字符串帧)。 */
  texts(): string[] {
    const out: string[] = [];
    for (const f of this.sent) {
      const s = String(f.data);
      try {
        JSON.parse(s);
        out.push(s);
      } catch {
        /* ignore */
      }
    }
    return out;
  }
}

export function makeIdentity(): Identity {
  const privateKey = x25519.utils.randomSecretKey();
  return { privateKey, serverId: b64urlEncode(x25519.getPublicKey(privateKey)) };
}

export interface ServerHarness {
  srv: SendspinServer;
  logs: Array<[string, string]>;
  identity: Identity;
}

/** 造一个**不监听端口**的 SendspinServer(纯内存对象,listen 由 serverListenDial.test.ts 覆盖)。 */
export function makeServer(
  opts: Partial<SendspinServerOptions> = {},
  identity: Identity = makeIdentity(),
): ServerHarness {
  const logs: Array<[string, string]> = [];
  const log: SendspinLog = (level, msg) => logs.push([level, msg]);
  const srv = new SendspinServer({ pairkeys: identity, serverName: "MF-Test", ...opts }, log);
  return { srv, logs, identity };
}

/** 日志里是否出现过含某个片段的记录。 */
export const logsContain = (logs: Array<[string, string]>, frag: string): boolean =>
  logs.some(([, m]) => m.includes(frag));

export interface ConnHarness {
  conn: SendspinConnection;
  ws: FakeWs;
}

export function makeConn(srv: SendspinServer, ws = new FakeWs()): ConnHarness {
  const conn = new SendspinConnection(srv, ws as unknown as WebSocket);
  return { conn, ws };
}

/** 明文期(TEXT)一帧。 */
export function cleartext(obj: unknown): Buffer {
  return Buffer.from(JSON.stringify(obj), "utf8");
}

/** 加密期一帧:JSON 体(带 BIN_JSON 类型字节)。 */
export function jsonBody(obj: unknown): Buffer {
  return Buffer.from(packJsonBody(obj as any));
}

/** 把一个 legacy 明文客户端驱动到 ready:发 client/hello → 收 server/hello/activate。 */
export function makeLegacyConn(
  srv: SendspinServer,
  helloPayload: Record<string, any> = {},
): ConnHarness {
  const { conn, ws } = makeConn(srv);
  void conn.onFrame(
    cleartext({
      type: "client/hello",
      payload: {
        client_id: "LEGACY-1",
        name: "Legacy Test",
        supported_roles: ["player@v1"],
        "player@v1_support": {
          supported_formats: [{ codec: "pcm" }],
          supported_commands: ["volume", "mute"],
        },
        ...helloPayload,
      },
    }),
    false,
  );
  return { conn, ws };
}

// ---------------------------------------------------------------------------
// 真实 Noise 握手对:用 asResponder 扮演客户端,和 SendspinConnection 的 initiator
// 走完 KKpsk2(msg1 → msg2),之后就能用 `responder.encrypt/decrypt` 构造真实的
// 加密期收发 —— 比塞一个 identity stub 强得多:它同时验证了 prologue / PSK 混入 /
// transport split 三处口径,任何一处错都会让后续 onFrame 解密失败。
// ---------------------------------------------------------------------------

export interface HandshakeHarness extends ConnHarness {
  responder: NoiseSession;
  clientPriv: Uint8Array;
  clientPub: Uint8Array;
  clientInitText: string;
  /** 把应答方加密后的密文扔进 conn(等价于客户端发一帧)。 */
  deliver(plaintext: Uint8Array): Promise<void>;
  /** 把应答方加密后的 JSON 消息扔进 conn。 */
  deliverJson(obj: unknown): Promise<void>;
  /** 解密 conn 的出站密文(用应答方侧会话)。 */
  receiveFromConn(ct: Uint8Array): Uint8Array;
}

export interface HandshakeOpts {
  /** 追加/覆盖 client/init payload 字段(version / client_id 会被强制覆盖)。 */
  initPayload?: Record<string, unknown>;
  /** 应答方使用的 PSK(sentinel fallback 场景要传 sentinel,而服务端用长配对 PSK)。 */
  responderPskHex?: string;
  /** 覆盖 server.pairingStore(有记录 → 走 lt 长配对 PSK)。 */
  pairingStore?: any;
  helloPayload?: Record<string, any>;
}

/** 驱动 conn 走完一次真实 Noise 握手;失败会由完成后的断言暴露(不回滚)。 */
export async function completeHandshake(
  harness: ServerHarness,
  opts: HandshakeOpts = {},
): Promise<HandshakeHarness> {
  const { srv } = harness;
  if (opts.pairingStore !== undefined) srv.pairingStore = opts.pairingStore;
  const { conn, ws } = makeConn(srv);
  const clientPriv = x25519.utils.randomSecretKey();
  const clientPub = x25519.getPublicKey(clientPriv);
  const initPayload = {
    version: PROTOCOL_VERSION,
    client_id: b64urlEncode(clientPub),
    name: "TEST-CLIENT",
    supported_roles: ["player@v1"],
    ...opts.initPayload,
  };
  const clientInitText = JSON.stringify({ type: "client/init", payload: initPayload });
  await conn.onFrame(Buffer.from(clientInitText, "utf8"), false);

  const serverInitText = String(ws.sent[0]?.data ?? "");
  const msg1Frame = ws.jsonOf("noise/handshake")[0];
  const msg1 = b64urlDecode(msg1Frame?.payload?.data ?? "");
  const prologue = Buffer.concat([
    Buffer.from(clientInitText, "utf8"),
    Buffer.from(serverInitText, "utf8"),
  ]);
  const responder = asResponder({
    suite: DEFAULT_SUITE,
    localStaticPriv: clientPriv,
    remoteStaticPub: x25519.getPublicKey(srv.identity.privateKey),
    prologue,
    psk: Buffer.from(opts.responderPskHex ?? SENTINEL_PSK_HEX, "hex"),
  });
  responder.readMessage(msg1);
  const msg2 = responder.writeMessage(new Uint8Array(0));
  await conn.onFrame(
    cleartext({ type: "noise/handshake", payload: { data: b64urlEncode(msg2) } }),
    false,
  );
  if (opts.helloPayload) {
    await conn.onFrame(
      Buffer.from(responder.encrypt(packJsonBody({ type: "client/hello", payload: opts.helloPayload }))),
      true,
    );
  }
  return {
    conn,
    ws,
    responder,
    clientPriv,
    clientPub,
    clientInitText,
    deliver: (plaintext) => conn.onFrame(Buffer.from(responder.encrypt(plaintext)), true),
    deliverJson: (obj) => conn.onFrame(Buffer.from(responder.encrypt(packJsonBody(obj as any))), true),
    receiveFromConn: (ct) => responder.decrypt(ct),
  };
}

/** 复用一个 identity(需要服务端静态密钥在多次握手中保持一致的场景)。 */
export { DEFAULT_SUITE, PROTOCOL_VERSION, SENTINEL_PSK_HEX };
