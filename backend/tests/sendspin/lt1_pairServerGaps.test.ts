// pairServer.ts 覆盖率补口:配对状态机的**错误收口**与"背靠背"缓存路径。
//
// 缺口背景(PairingCoordinator 每条都是"一次错就配对失败且无提示"的路径):
//   - enterCode 在设备**已锁码窗口**内再输码 → 必须拒绝(防爆破);
//   - dynamic 的 commit_B / pair-auth 的 pake_msg_2 / pair-confirm 的 client_kc
//     解码失败 → 必须 abort 或静默断连,**不能把异常抛进 WS 事件回调**;
//   - finalize 与 confirm/auth **背靠背**到达时的缓存与消费(协议允许对端一次发两帧);
//   - 静态码 confirm 验签失败累计到上限 → 必须锁定并 abort(不是无限重试)。
//
// ⚠️ 其中三处 base64 解码 catch 在**真实实现**下是防御性死分支(旧用例已固化:
// `b64urlDecode` 对非法字符静默丢弃、从不抛错)。这里用哨兵字符串让解码抛错,专门
// 验证「万一真抛了,连接是否被正确判废」—— 这比让这三行永远黑着更有意义。
//
// 隔离:全内存假 conn / 假 store,不碰真 WS / 真 DB。
import "../plugins/_env.js";

import { describe, it, expect, vi } from "vitest";

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

import { PairingCoordinator } from "../../src/services/sendspin/pairServer.js";
import { CPace, wrapKey, aeadSeal } from "../../src/services/sendspin/cpace.js";
import { b64urlEncode, b64urlDecode } from "../../src/services/sendspin/util.js";

const PAKE_SID_LABEL = "sendspin-pair-pake-v1";
const WRAP_PSK_LABEL = "sendspin-pair-psk-wrap-v1";
const SUITE = "CHACHA20POLY1305";
const H = new Uint8Array(32).fill(7);
const enc = (s: string) => new TextEncoder().encode(s);

function sidFor(h: Uint8Array, idx: number): Uint8Array {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setUint32(0, idx >>> 0, false);
  return new Uint8Array([...enc(PAKE_SID_LABEL), ...h, ...b]);
}

function makeConn(over: any = {}) {
  const sent: Array<[string, any]> = [];
  const conn: any = {
    clientId: "CLIENTID",
    clientHello: { supported_pair_methods: { static_pin: {}, dynamic_pin: {} }, supported_roles: ["player"] },
    legacy: false,
    ready: true,
    roles: ["player"],
    noise: { handshakeHash: H },
    idx: 1,
    closed: false,
    nextPairingIndex() {
      return this.idx++;
    },
    suiteName() {
      return SUITE;
    },
    sendJson(type: string, payload: any) {
      sent.push([type, payload]);
    },
    rehandshakeTo: vi.fn(async () => undefined),
    close() {
      this.closed = true;
    },
    sent,
    ...over,
  };
  return conn;
}

function makeServer(conn?: any, logs: string[] = []) {
  const clients = new Map<string, any>();
  if (conn) clients.set(conn.clientId, conn);
  return {
    clients,
    log: (_lv: string, _msg: string) => {
      logs.push(_msg);
    },
  } as any;
}

const makeStore = () => ({ putRecord: vi.fn(async () => undefined), getRecord: vi.fn(() => undefined) }) as any;

function lastSent(conn: any, type: string): any {
  for (let i = conn.sent.length - 1; i >= 0; i--) if (conn.sent[i][0] === type) return conn.sent[i][1];
  return undefined;
}

/** 静态码流程推进到 await_peer_auth(已发 server/pair-auth)。 */
async function staticToAwaitPeerAuth() {
  const conn = makeConn();
  const store = makeStore();
  const logs: string[] = [];
  const coord = new PairingCoordinator(makeServer(conn, logs), store);
  await coord.start("CLIENTID", "static_pin");
  await coord.onPairMessage(conn, "client/pair-init", { pairing_index: 1 });
  await coord.enterCode("CLIENTID", "12345678");
  return { conn, store, logs, coord };
}

/** 与 start() 里同一码对应的客户端(responder)会话。 */
function clientFor(conn: any, code: string) {
  const client = CPace.start({ role: "responder", prs: enc(code), sid: sidFor(H, 1), ad: enc("client") });
  client.derive(b64urlDecode(lastSent(conn, "server/pair-auth").pake_msg_1), enc("server"));
  return client;
}

const wrappedPsk = (client: CPace, psk: Uint8Array) =>
  b64urlEncode(aeadSeal("chacha", wrapKey(WRAP_PSK_LABEL, sidFor(H, 1), client.getISK()), psk));

describe("enterCode:锁码窗口守卫", () => {
  it("静码失败次数达上限(窗口未过)→ 拒绝输码(防爆破)", async () => {
    const conn = makeConn();
    const coord = new PairingCoordinator(makeServer(conn), makeStore());
    await coord.start("CLIENTID", "static_pin");
    await coord.onPairMessage(conn, "client/pair-init", { pairing_index: 1 });
    const a = (coord as any).attempts.get("CLIENTID");
    a.gate.windowStartMs = Date.now(); // 窗口新鲜
    a.gate.failures = a.gate.maxFailures;
    // 契约:已锁定必须直接拒绝,不能再起一轮 PAKE(否则爆破无上限)。
    await expect(coord.enterCode("CLIENTID", "87654321")).rejects.toThrow("已锁定");
  });
});

describe("配对消息的解码失败收口", () => {
  it("dynamic pair-init 的 commit_B 解码抛错 → abort protocol_error", async () => {
    const conn = makeConn();
    const logs: string[] = [];
    const coord = new PairingCoordinator(makeServer(conn, logs), makeStore());
    await coord.start("CLIENTID", "dynamic_pin");
    await coord.onPairMessage(conn, "client/pair-init", { pairing_index: 1, commit_B: "__BAD__" });
    expect(coord.getAttempt("CLIENTID")).toBeUndefined();
    expect(logs.some((l) => l.includes("protocol_error"))).toBe(true);
  });

  it("pair-auth 的 pake_msg_2 解码抛错 → abort protocol_error", async () => {
    const { conn, coord } = await staticToAwaitPeerAuth();
    await coord.onPairMessage(conn, "client/pair-auth", { pairing_index: 1, pake_msg_2: "__BAD__" });
    expect(coord.getAttempt("CLIENTID")).toBeUndefined();
  });

  it("pair-confirm 的 client_kc 解码抛错 → abort protocol_error", async () => {
    const { conn, coord } = await staticToAwaitPeerAuth();
    const client = clientFor(conn, "12345678");
    await coord.onPairMessage(conn, "client/pair-auth", { pairing_index: 1, pake_msg_2: b64urlEncode(client.publicShare) });
    await coord.onPairMessage(conn, "client/pair-confirm", { pairing_index: 1, client_kc: "__BAD__" });
    expect(coord.getAttempt("CLIENTID")).toBeUndefined();
  });
});

describe("静态码 confirm 验签失败累计到上限 → 锁定并 abort", () => {
  it("最后一次失败触发 gate 锁定:发 pair/abort 且 attempt 被清", async () => {
    const { conn, coord, logs } = await staticToAwaitPeerAuth();
    const client = clientFor(conn, "12345678");
    await coord.onPairMessage(conn, "client/pair-auth", { pairing_index: 1, pake_msg_2: b64urlEncode(client.publicShare) });
    const a = (coord as any).attempts.get("CLIENTID");
    a.gate.failures = a.gate.maxFailures - 1;
    await coord.onPairMessage(conn, "client/pair-confirm", {
      pairing_index: 1,
      client_kc: b64urlEncode(new Uint8Array(64)), // 长度对但内容错 → 验签失败
    });
    // 契约:超限必须锁定并 abort,且给出"窗口锁定"细节(排障线索)。
    expect(lastSent(conn, "pair/abort")?.reason).toBe("pairing_code_mismatch");
    expect(coord.getAttempt("CLIENTID")).toBeUndefined();
    expect(logs.some((l) => l.includes("窗口锁定"))).toBe(true);
  });
});

describe("finalize 与 auth/confirm 背靠背到达的缓存与消费", () => {
  it("auth 处理完立刻消费已缓存的 finalize(无需等对端重发)", async () => {
    const { conn, store, coord } = await staticToAwaitPeerAuth();
    const client = clientFor(conn, "12345678");
    const psk = new Uint8Array(32).fill(5);
    (coord as any).attempts.get("CLIENTID").pendingFinalize = {
      pairing_index: 1,
      wrapped_psk: wrappedPsk(client, psk),
    };
    await coord.onPairMessage(conn, "client/pair-auth", { pairing_index: 1, pake_msg_2: b64urlEncode(client.publicShare) });
    // 契约:对端常把 auth+finalize 一起发;不消费缓存就会永远停在 await_confirm。
    expect(store.putRecord).toHaveBeenCalledWith("CLIENTID", Buffer.from(psk).toString("hex"));
    expect(coord.getAttempt("CLIENTID")).toBeUndefined();
  });

  it("confirm 处理完立刻消费已缓存的 finalize", async () => {
    const { conn, store, coord } = await staticToAwaitPeerAuth();
    const client = clientFor(conn, "12345678");
    const psk = new Uint8Array(32).fill(6);
    await coord.onPairMessage(conn, "client/pair-auth", { pairing_index: 1, pake_msg_2: b64urlEncode(client.publicShare) });
    (coord as any).attempts.get("CLIENTID").pendingFinalize = {
      pairing_index: 1,
      wrapped_psk: wrappedPsk(client, psk),
    };
    await coord.onPairMessage(conn, "client/pair-confirm", { pairing_index: 1, client_kc: b64urlEncode(client.tag()) });
    expect(store.putRecord).toHaveBeenCalledWith("CLIENTID", Buffer.from(psk).toString("hex"));
    expect(coord.getAttempt("CLIENTID")).toBeUndefined();
  });

  it("finalize 先到(状态未到 await_confirm)→ 只缓存,不落盘", async () => {
    const { conn, store, coord } = await staticToAwaitPeerAuth();
    const a = (coord as any).attempts.get("CLIENTID");
    a.state = "await_confirm";
    a.cpace = undefined; // 尚无 PAKE 会话
    await coord.onPairMessage(conn, "client/pair-finalize", { pairing_index: 1, wrapped_psk: "AAAA" });
    // 契约:必须缓存等 confirm;此刻落盘会写进一个未经 PAKE 认证的 PSK。
    expect(store.putRecord).not.toHaveBeenCalled();
    expect(a.pendingFinalize).toEqual({ pairing_index: 1, wrapped_psk: "AAAA" });
  });
});

describe("waitForCode(当前无调用点)", () => {
  it("码已就绪 → 直接 resolve;码未就绪 → 挂起并在 enterCode 时被唤醒", async () => {
    const conn = makeConn();
    const coord = new PairingCoordinator(makeServer(conn), makeStore());
    await coord.start("CLIENTID", "static_pin");
    const a = (coord as any).attempts.get("CLIENTID");
    a.codeRaw = new Uint8Array([1, 2, 3]);
    // 契约:码就绪时必须**立即**返回,不允许把已有码的轮次挂起。
    await expect((coord as any).waitForCode(a)).resolves.toBeUndefined();

    a.codeRaw = undefined;
    const pending = (coord as any).waitForCode(a);
    expect(a.codeWaiters.length).toBe(1);
    // enterCode 会唤醒所有 waiter(码到了就放行 PAKE)。
    await coord.onPairMessage(conn, "client/pair-init", { pairing_index: 1 });
    await coord.enterCode("CLIENTID", "12345678");
    await expect(pending).resolves.toBeUndefined();
  });
});
