// pairServer.ts 覆盖率补口:配对状态机的**错误收口**。
//
// 缺口背景(PairingCoordinator 每条都是"一次错就配对失败且无提示"的路径):
//   - enterCode 在设备**已锁码窗口**内再输码 → 必须拒绝(防爆破);
//   - dynamic 的 commit_B / pair-auth 的 pake_msg_2 / pair-confirm 的 client_kc
//     非法 → 由长度 / derive / 验签守卫收口,**不能把异常抛进 WS 事件回调**;
//   - 静态码 confirm 验签失败累计到上限 → 必须锁定并 abort(不是无限重试)。
//
// 2026-09-29(v4.0.63,D31/D32/D33 死代码清理)后本文件同步收敛:
//   - waitForCode() / codeWaiters 无调用点,已删除 → 不再构造"挂起等码"场景;
//   - pendingFinalize 缓存路径条件自相矛盾(finalize 只在 state !== await_confirm 时才写、
//     而缓存又要求 state === await_confirm),不可达,已删除 → finalize 抢在 auth/confirm
//     之前到达时按「直接忽略」处理,不再缓存;
//   - b64urlDecode 用 Buffer.from(..., "base64url"),非法字符静默丢弃、**永不抛**,
//     故三处防御性 try/catch 已删除;非法载荷改由长度 / derive / 验签守卫收口。
//
// 隔离:全内存假 conn / 假 store,不碰真 WS / 真 DB。
import "../plugins/_env.js";

import { describe, it, expect, vi } from "vitest";

import { PairingCoordinator } from "../../src/services/sendspin/pairServer.js";
import { CPace } from "../../src/services/sendspin/cpace.js";
import { b64urlEncode, b64urlDecode } from "../../src/services/sendspin/util.js";

const PAKE_SID_LABEL = "sendspin-pair-pake-v1";
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

describe("配对消息的非法载荷收口(靠长度 / derive / 验签守卫,不靠 catch)", () => {
  it("dynamic pair-init 的 commit_B 非法 → 解码后长度 != 32 → abort protocol_error", async () => {
    const conn = makeConn();
    const logs: string[] = [];
    const coord = new PairingCoordinator(makeServer(conn, logs), makeStore());
    await coord.start("CLIENTID", "dynamic_pin");
    // b64urlDecode("@@@") 把非法字符丢弃 → 空串,长度守卫直接收口。
    await coord.onPairMessage(conn, "client/pair-init", { pairing_index: 1, commit_B: "@@@" });
    expect(coord.getAttempt("CLIENTID")).toBeUndefined();
    expect(logs.some((l) => l.includes("protocol_error"))).toBe(true);
  });

  it("pair-auth 的 pake_msg_2 非法 → derive 抛错,静默断连且不落盘", async () => {
    const { conn, store, coord } = await staticToAwaitPeerAuth();
    await coord.onPairMessage(conn, "client/pair-auth", { pairing_index: 1, pake_msg_2: "@@@" });
    // 契约:解码异常不能冒进 WS 回调 —— 走 derive 失败分支静默断连、attempt 清掉。
    expect(conn.closed).toBe(true);
    expect(coord.getAttempt("CLIENTID")).toBeUndefined();
    expect(store.putRecord).not.toHaveBeenCalled();
  });

  it("pair-confirm 的 client_kc 非法 → 验签失败,绝不落盘", async () => {
    const { conn, store, coord } = await staticToAwaitPeerAuth();
    const client = clientFor(conn, "12345678");
    await coord.onPairMessage(conn, "client/pair-auth", { pairing_index: 1, pake_msg_2: b64urlEncode(client.publicShare) });
    await coord.onPairMessage(conn, "client/pair-confirm", { pairing_index: 1, client_kc: "@@@" });
    // 无论失败是否触发锁定,未通过验签就绝不能写下 pair 记录。
    expect(store.putRecord).not.toHaveBeenCalled();
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

describe("finalize 抢在 auth/confirm 之前到达 → 直接忽略(不再缓存)", () => {
  it("状态未到 await_confirm 的 finalize → 不落盘、无 pendingFinalize 缓存、状态机不回退", async () => {
    const { conn, store, coord } = await staticToAwaitPeerAuth();
    // 此刻 state = await_peer_auth(尚未收 pair-auth),finalize 提前到达。
    await coord.onPairMessage(conn, "client/pair-finalize", { pairing_index: 1, wrapped_psk: "AAAA" });
    // 旧实现的 pendingFinalize 缓存已随 D32 清理删除:过早到达的 finalize 一律忽略。
    expect(store.putRecord).not.toHaveBeenCalled();
    const a = (coord as any).attempts.get("CLIENTID");
    expect(a.pendingFinalize).toBeUndefined();
    expect(a.state).toBe("await_peer_auth"); // 状态机不因过早的 finalize 而回退
  });
});

describe("waitForCode 已删除(无调用点)", () => {
  it("PairingCoordinator 不再暴露 waitForCode / codeWaiters", async () => {
    const conn = makeConn();
    const coord = new PairingCoordinator(makeServer(conn), makeStore());
    await coord.start("CLIENTID", "static_pin");
    const a = (coord as any).attempts.get("CLIENTID");
    expect((coord as any).waitForCode).toBeUndefined();
    expect(a.codeWaiters).toBeUndefined();
  });
});
