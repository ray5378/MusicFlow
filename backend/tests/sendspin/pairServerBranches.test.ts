// MUST be the first import: redirects DATA_DIR to an isolated temp dir before
// the backend opens its SQLite DB at module-load time.
import "../plugins/_env.js";

import { describe, it, expect, vi } from "vitest";
import { sha256 } from "@noble/hashes/sha256.js";
import {
  PairingCoordinator,
  decodePairingToken,
  deriveDynamicCode,
} from "../../src/services/sendspin/pairServer.js";
import { CPace, wrapKey, aeadSeal } from "../../src/services/sendspin/cpace.js";
import { b64urlEncode, b64urlDecode } from "../../src/services/sendspin/util.js";

const PAKE_SID_LABEL = "sendspin-pair-pake-v1";
const COMMIT_LABEL = "sendspin-pair-commit-v1";
const WRAP_PSK_LABEL = "sendspin-pair-psk-wrap-v1";
const WRAP_NONCE_LABEL = "sendspin-pair-nonce-wrap-v1";
const SUITE = "CHACHA20POLY1305";
const enc = (s: string) => new TextEncoder().encode(s);

function sidFor(h: Uint8Array, idx: number): Uint8Array {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setUint32(0, idx >>> 0, false);
  return new Uint8Array([...enc(PAKE_SID_LABEL), ...h, ...b]);
}

const B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
function b32Encode(bytes: Uint8Array): string {
  let bits = 0, acc = 0, out = "";
  for (const byte of bytes) {
    acc = (acc << 8) | byte;
    bits += 8;
    while (bits >= 5) { bits -= 5; out += B32[(acc >> bits) & 31]; }
  }
  if (bits > 0) out += B32[(acc << (5 - bits)) & 31];
  return out;
}

function makeConn(over: any = {}) {
  const sent: Array<[string, any]> = [];
  const conn: any = {
    clientId: "CLIENTID",
    clientHello: { supported_pair_methods: { static_pin: {}, dynamic_pin: {} }, supported_roles: ["player"] },
    legacy: false,
    ready: true,
    roles: ["player"],
    noise: { handshakeHash: new Uint8Array(32).fill(7) },
    idx: 1,
    closed: false,
    nextPairingIndex() { return this.idx++; },
    suiteName() { return SUITE; },
    sendJson(type: string, payload: any) { sent.push([type, payload]); },
    rehandshakeTo: vi.fn(async () => undefined),
    close() { this.closed = true; },
    sent,
    ...over,
  };
  return conn;
}

function makeServer(conn?: any, logs: string[] = []) {
  const clients = new Map<string, any>();
  if (conn) clients.set(conn.clientId, conn);
  return { clients, log: (_lv: string, msg: string) => { logs.push(msg); } } as any;
}

function makeStore() {
  return { putRecord: vi.fn(async () => undefined), getRecord: vi.fn(() => undefined) } as any;
}

function lastSent(conn: any, type: string): any {
  for (let i = conn.sent.length - 1; i >= 0; i--) if (conn.sent[i][0] === type) return conn.sent[i][1];
  return undefined;
}

const H = new Uint8Array(32).fill(7);

/** dynamic 唯一能推进 PAKE 的顺序:运营商**先**输码 → 设备**后**发 pair-init。 */
async function beginDynamicRound(nonceB: Uint8Array, code: string) {
  const conn = makeConn();
  const store = makeStore();
  const logs: string[] = [];
  const coord = new PairingCoordinator(makeServer(conn, logs), store);
  const commitB = sha256(new Uint8Array([...enc(COMMIT_LABEL), ...nonceB]));
  await coord.start("CLIENTID", "dynamic_pin");
  await coord.enterCode("CLIENTID", code);
  await coord.onPairMessage(conn, "client/pair-init", { pairing_index: 1, commit_B: b64urlEncode(commitB) });
  const nonceA = b64urlDecode(lastSent(conn, "server/pair-init").nonce_A);
  const client = CPace.start({ role: "responder", prs: enc(code), sid: sidFor(H, 1), ad: enc("client") });
  client.derive(b64urlDecode(lastSent(conn, "server/pair-auth").pake_msg_1), enc("server"));
  return { conn, store, logs, coord, client, nonceA, nonceB, commitB };
}

/**
 * dynamic 成功路径:码必须按本轮 nonce_A 派生,而 nonce_A 是本轮 init 才随机出来的
 * (运营商先输码 → 设备后发 init)。非 1 的 pairingIndex 意味着先探测一次 nonce_A,
 * cancel 重开,好让 init 落在 await_init 上。
 */
async function dynamicFlowWithCode(nonceB: Uint8Array, code: string, pairingIndex: number) {
  const conn = makeConn();
  const store = makeStore();
  const logs: string[] = [];
  const coord = new PairingCoordinator(makeServer(conn, logs), store);
  const commitB = sha256(new Uint8Array([...enc(COMMIT_LABEL), ...nonceB]));
  await coord.start("CLIENTID", "dynamic_pin");
  if (pairingIndex > 1) {
    await coord.onPairMessage(conn, "client/pair-init", { pairing_index: 1, commit_B: b64urlEncode(commitB) });
    await coord.cancel("CLIENTID");
    await coord.start("CLIENTID", "dynamic_pin");
  }
  await coord.enterCode("CLIENTID", code);
  await coord.onPairMessage(conn, "client/pair-init", { pairing_index: pairingIndex, commit_B: b64urlEncode(commitB) });
  const nonceA = b64urlDecode(lastSent(conn, "server/pair-init").nonce_A);
  const client = CPace.start({ role: "responder", prs: enc(code), sid: sidFor(H, pairingIndex), ad: enc("client") });
  client.derive(b64urlDecode(lastSent(conn, "server/pair-auth").pake_msg_1), enc("server"));
  return { conn, store, logs, coord, client, nonceA, nonceB };
}

/** 把一轮 dynamic 推进到 await_confirm(客户端已完成 auth)。 */
async function toAwaitConfirm(r: Awaited<ReturnType<typeof beginDynamicRound>>) {
  await r.coord.onPairMessage(r.conn, "client/pair-auth", {
    pairing_index: 1,
    pake_msg_2: b64urlEncode(r.client.publicShare),
  });
  const serverKc = b64urlDecode(lastSent(r.conn, "server/pair-confirm").server_kc);
  expect(r.client.verify(serverKc)).toBe(true);
  expect(r.coord.getAttempt("CLIENTID")?.state).toBe("await_confirm");
}

describe("PairingCoordinator dynamic 活路径(runDynamicRound)", () => {
  it("先输码再 init:init 后立刻发起 PAKE 并进入 await_peer_auth", async () => {
    const nonceB = new Uint8Array(32).fill(42);
    const { conn, coord } = await beginDynamicRound(nonceB, "123456");
    expect(coord.getAttempt("CLIENTID")?.state).toBe("await_peer_auth");
    expect(lastSent(conn, "server/pair-auth")).toBeDefined();
  });

  it("跨 attempt nonce 必须重新随机(真实守卫):旧轮 nonce_A 派生的码在新一轮必然不符 ⇒ 码错误收场", async () => {
    const nonceB = new Uint8Array(32).fill(42);
    const conn = makeConn();
    const store = makeStore();
    const coord = new PairingCoordinator(makeServer(conn), store);
    const commitB = sha256(new Uint8Array([...enc(COMMIT_LABEL), ...nonceB]));

    // 第 1 轮:设备发 init → 服务端出 nonce_A#1 → 运营商据此读码。
    await coord.start("CLIENTID", "dynamic_pin");
    await coord.onPairMessage(conn, "client/pair-init", { pairing_index: 1, commit_B: b64urlEncode(commitB) });
    const nonceA1 = b64urlDecode(lastSent(conn, "server/pair-init").nonce_A);
    const code = deriveDynamicCode(H, nonceA1, nonceB);
    await coord.cancel("CLIENTID");

    // 第 2 轮(活路径:码先到,init 触发 PAKE)。
    await coord.start("CLIENTID", "dynamic_pin");
    await coord.enterCode("CLIENTID", code);
    await coord.onPairMessage(conn, "client/pair-init", { pairing_index: 2, commit_B: b64urlEncode(commitB) });
    const nonceA2 = b64urlDecode(lastSent(conn, "server/pair-init").nonce_A);
    expect(Buffer.compare(Buffer.from(nonceA1), Buffer.from(nonceA2))).not.toBe(0);
    expect(coord.getAttempt("CLIENTID")?.state).toBe("await_peer_auth");

    const client = CPace.start({ role: "responder", prs: enc(code), sid: sidFor(H, 2), ad: enc("client") });
    client.derive(b64urlDecode(lastSent(conn, "server/pair-auth").pake_msg_1), enc("server"));
    await coord.onPairMessage(conn, "client/pair-auth", { pairing_index: 2, pake_msg_2: b64urlEncode(client.publicShare) });
    const k = wrapKey(WRAP_NONCE_LABEL, sidFor(H, 2), client.getISK());
    await coord.onPairMessage(conn, "client/pair-confirm", {
      pairing_index: 2,
      client_kc: b64urlEncode(client.tag()),
      wrapped_nonce_B: b64urlEncode(aeadSeal("chacha", k, nonceB)),
    });
    // nonce 开示与 commitment 都通过了,卡在最后一步「码与 nonce_A 派生的那条不是同一条」。
    expect(coord.getAttempt("CLIENTID")).toBeUndefined();
    expect(store.putRecord).not.toHaveBeenCalled();
    expect(lastSent(conn, "pair/abort")?.reason).toBe("pairing_code_mismatch");
  });

  it("[已修复 D34] dynamic 卡在第 1 轮后:await_code 状态下重发 pair-init 会被接受并推进 PAKE", async () => {
    const nonceB = new Uint8Array(32).fill(42);
    const conn = makeConn();
    const coord = new PairingCoordinator(makeServer(conn), makeStore());
    const commitB = sha256(new Uint8Array([...enc(COMMIT_LABEL), ...nonceB]));

    await coord.start("CLIENTID", "dynamic_pin");
    await coord.onPairMessage(conn, "client/pair-init", { pairing_index: 1, commit_B: b64urlEncode(commitB) });
    const nonceA = b64urlDecode(lastSent(conn, "server/pair-init").nonce_A);
    // 运营商读到这个 nonce_A 后输码。
    await coord.enterCode("CLIENTID", deriveDynamicCode(H, nonceA, nonceB));
    expect(coord.getAttempt("CLIENTID")?.state).toBe("await_code");
    expect(lastSent(conn, "server/pair-auth")).toBeUndefined();

    // 修复前:第 2 次 pair-init 被 await_code 挡下,既不重生成 nonce_A 也不触发
    // runDynamicRound —— dynamic 走不通日常时序。修复后:await_code 下重发 init 会被接受、
    // 复用同一个 nonce_A,并立即推进 PAKE。
    const before = conn.sent.length;
    await coord.onPairMessage(conn, "client/pair-init", { pairing_index: 1, commit_B: b64urlEncode(commitB) });
    expect(coord.getAttempt("CLIENTID")?.state).toBe("await_peer_auth");
    expect(lastSent(conn, "server/pair-auth")).toBeDefined();
    expect(conn.sent.length).toBeGreaterThan(before);
    // nonce_A 已下发过 ⇒ 重发 init 不再重复下发 server/pair-init。
    expect(conn.sent.slice(before).some(([t]) => t === "server/pair-init")).toBe(false);
  });

  it("dynamic confirm:解不开 wrapped_nonce_B ⇒ 静默断连且不落盘", async () => {
    const nonceB = new Uint8Array(32).fill(42);
    const r = await beginDynamicRound(nonceB, "123456");
    await toAwaitConfirm(r);
    const k = wrapKey(WRAP_NONCE_LABEL, sidFor(H, 1), r.client.getISK());
    await r.coord.onPairMessage(r.conn, "client/pair-confirm", {
      pairing_index: 1,
      client_kc: b64urlEncode(r.client.tag()),
      wrapped_nonce_B: b64urlEncode(aeadSeal("chacha", k, new Uint8Array(8))),
    });
    expect(r.conn.closed).toBe(true);
    expect(r.coord.getAttempt("CLIENTID")).toBeUndefined();
    expect(r.store.putRecord).not.toHaveBeenCalled();
  });

  it("dynamic confirm:nonceB 解出来了但和承诺的那条不是同一个 ⇒ commitment 比对失败,静默断连", async () => {
    const nonceB = new Uint8Array(32).fill(42);
    const r = await beginDynamicRound(nonceB, "123456");
    await toAwaitConfirm(r);
    const k = wrapKey(WRAP_NONCE_LABEL, sidFor(H, 1), r.client.getISK());
    // 正确密钥解出一个长度对、内容不同的 nonceB ⇒ sha256(COMMIT_LABEL||nonceB) ≠ a.commitB
    await r.coord.onPairMessage(r.conn, "client/pair-confirm", {
      pairing_index: 1,
      client_kc: b64urlEncode(r.client.tag()),
      wrapped_nonce_B: b64urlEncode(aeadSeal("chacha", k, new Uint8Array(32).fill(43))),
    });
    expect(r.conn.closed).toBe(true);
    expect(r.coord.getAttempt("CLIENTID")).toBeUndefined();
    expect(r.store.putRecord).not.toHaveBeenCalled();
  });
});

describe("PairingCoordinator.onPairRetry(404-410)", () => {
  it("await_peer_auth 时 retry:清 cpace、重发 pair-init、再用同一码重开 PAKE", async () => {
    const nonceB = new Uint8Array(32).fill(42);
    const { conn, coord } = await beginDynamicRound(nonceB, "123456");
    const auth1 = lastSent(conn, "server/pair-auth").pake_msg_1;
    await coord.onPairMessage(conn, "client/pair-retry", { pairing_index: 1 });
    expect(conn.sent.some(([t]: [string, any]) => t === "server/pair-init")).toBe(true);
    expect(coord.getAttempt("CLIENTID")?.state).toBe("await_peer_auth");
    const auth2 = lastSent(conn, "server/pair-auth").pake_msg_1;
    expect(auth2).toBeDefined();
    expect(auth2).not.toBe(auth1);
    // 重开的是全新 CPace 实例(旧 publicShare 用不了),新一轮 auth 仍须自洽。
    const client2 = CPace.start({ role: "responder", prs: enc("123456"), sid: sidFor(H, 1), ad: enc("client") });
    client2.derive(b64urlDecode(auth2), enc("server"));
    await coord.onPairMessage(conn, "client/pair-auth", { pairing_index: 1, pake_msg_2: b64urlEncode(client2.publicShare) });
    const serverKc = b64urlDecode(lastSent(conn, "server/pair-confirm").server_kc);
    expect(client2.verify(serverKc)).toBe(true);
  });
});

/** static 成功一轮,停在 await_confirm(已发 server/pair-confirm)。 */
async function beginStaticRound() {
  const conn = makeConn();
  const store = makeStore();
  const logs: string[] = [];
  const coord = new PairingCoordinator(makeServer(conn, logs), store);
  const code = "12345678";
  await coord.start("CLIENTID", "static_pin");
  await coord.onPairMessage(conn, "client/pair-init", { pairing_index: 1 });
  await coord.enterCode("CLIENTID", code);
  const client = CPace.start({ role: "responder", prs: enc(code), sid: sidFor(H, 1), ad: enc("client") });
  client.derive(b64urlDecode(lastSent(conn, "server/pair-auth").pake_msg_1), enc("server"));
  await coord.onPairMessage(conn, "client/pair-auth", { pairing_index: 1, pake_msg_2: b64urlEncode(client.publicShare) });
  return { conn, store, logs, coord, client };
}

describe("re-handshake 失败(488-489 / 518-520)", () => {
  const key = new Uint8Array(32).fill(11);
  const psk = new Uint8Array(32).fill(22);
  const clientId = Buffer.from(key).toString("base64url");
  const goodToken = "SP:0" + b32Encode(new Uint8Array([...key, ...psk]));

  it("pairing-psk finalize 后 re-handshake 失败:只告警,不抛,配对记录仍已落盘", async () => {
    const conn = makeConn({ clientId });
    // pairWithToken 的 pr 握手必须成功,失败的是后面 finalize 的 lt 握手。
    conn.rehandshakeTo.mockResolvedValueOnce(undefined);
    conn.rehandshakeTo.mockRejectedValueOnce(new Error("链路断了"));
    const logs: string[] = [];
    const store = makeStore();
    const coord = new PairingCoordinator(makeServer(conn, logs), store);
    await coord.pairWithToken(clientId, goodToken);
    const lt = new Uint8Array(32).fill(33);
    await coord.onPairMessage(conn, "client/pair-finalize", { pairing_index: 2, long_term_psk: b64urlEncode(lt) });
    expect(store.putRecord).toHaveBeenCalledWith(clientId, Buffer.from(lt).toString("hex"));
    expect(logs.some((l) => l.includes("re-handshake failed"))).toBe(true);
    expect(logs.some((l) => l.includes("pairing done"))).toBe(true);
  });

  it("码配对的 finalize 后 re-handshake 失败:落盘照做,就地 return 不打 promote", async () => {
    const r = await beginStaticRound();
    const psk = new Uint8Array(32).fill(77);
    const k = wrapKey(WRAP_PSK_LABEL, sidFor(H, 1), r.client.getISK());
    await r.coord.onPairMessage(r.conn, "client/pair-confirm", {
      pairing_index: 1,
      client_kc: b64urlEncode(r.client.tag()),
    });
    r.conn.rehandshakeTo.mockRejectedValueOnce(new Error("链路断了"));
    await r.coord.onPairMessage(r.conn, "client/pair-finalize", {
      pairing_index: 1,
      wrapped_psk: b64urlEncode(aeadSeal("chacha", k, psk)),
    });
    expect(r.store.putRecord).toHaveBeenCalledWith("CLIENTID", Buffer.from(psk).toString("hex"));
    // 518-520:warn 日志有,promote 日志没有(被 return 挡住)。
    expect(r.logs.some((l) => l.includes("re-handshake failed"))).toBe(true);
    expect(r.logs.some((l) => l.includes("pairing promoted"))).toBe(false);
    expect(r.coord.getAttempt("CLIENTID")).toBeUndefined();
  });
});

describe("不可达分支固化(死代码 / 死 catch)", () => {
  it("b64urlDecode 对非法字符不抛错 ⇒ 三处 catch 都是死分支,非法输入靠长度检查兜底", () => {
    expect(() => b64urlDecode("!!!not-b64!!!")).not.toThrow();
    expect(() => b64urlDecode("@@@")).not.toThrow();
    expect(b64urlDecode("!!!not-b64!!!").length).toBeLessThan(16);
  });

  it("静态码:错码累计 5 次才锁定(前 4 次保留 attempt 可重试)(已修复 D30)", async () => {
    const conn = makeConn();
    const store = makeStore();
    const coord = new PairingCoordinator(makeServer(conn), store);
    await coord.start("CLIENTID", "static_pin");
    await coord.onPairMessage(conn, "client/pair-init", { pairing_index: 1 });

    // 一轮错码:输码开跑 PAKE → 用**正确码**派生一个自洽的 pake_msg_2(保证服务端 derive
    // 成功、能走到 confirm)→ 再提交一个**错误** client_kc,让 verify 失败、记一次失败。
    const wrongRound = async () => {
      await coord.enterCode("CLIENTID", "12345678");
      const client = CPace.start({ role: "responder", prs: enc("12345678"), sid: sidFor(H, 1), ad: enc("client") });
      client.derive(b64urlDecode(lastSent(conn, "server/pair-auth").pake_msg_1), enc("server"));
      await coord.onPairMessage(conn, "client/pair-auth", { pairing_index: 1, pake_msg_2: b64urlEncode(client.publicShare) });
      await coord.onPairMessage(conn, "client/pair-confirm", { pairing_index: 1, client_kc: b64urlEncode(new Uint8Array(32).fill(1)) });
    };

    // 第 1 次错码:只记数,**保留 attempt**(state 回 await_code),不再首次不符即 abort。
    await wrongRound();
    expect(coord.getAttempt("CLIENTID")).toBeDefined();
    expect(coord.getAttempt("CLIENTID")?.state).toBe("await_code");
    expect(store.putRecord).not.toHaveBeenCalled();

    // 再错 4 次,累计到第 5 次才锁定并 abort(attempt 被删)。
    await wrongRound();
    await wrongRound();
    await wrongRound();
    await wrongRound();
    expect(coord.getAttempt("CLIENTID")).toBeUndefined();
    expect(store.putRecord).not.toHaveBeenCalled();
    // 顺带:SP:1(24B 动态码)token 的纯解码守卫,与本锁定流程无关。
    expect(decodePairingToken("SP:1" + b32Encode(new Uint8Array(24)))).not.toBeNull();
  });

  it("waitForCode 无调用点:码一旦就绪就在 init 里被直接消化,不存在挂起等码这一环节", async () => {
    const nonceB = new Uint8Array(32).fill(42);
    const { conn, coord } = await beginDynamicRound(nonceB, "111222");
    // 若存在 waiter 入口,dynamic 在码未到时会挂起在 await_code 等唤醒。
    // 现状是:码与 init 同一条链路上被即时消费,state 直接跳到 await_peer_auth。
    expect(coord.getAttempt("CLIENTID")?.state).toBe("await_peer_auth");
    expect(coord.listAttempts()[0]?.startedAt).toBe(0);
    // 且 dynamic 在 await_code 期间再等也不会有任何 waiter 被唤醒。
    const before = conn.sent.length;
    await new Promise((r) => setTimeout(r, 0));
    expect(conn.sent.length).toBe(before);
  });
});
