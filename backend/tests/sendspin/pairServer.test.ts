// MUST be the first import: redirects DATA_DIR to an isolated temp dir before
// the backend opens its SQLite DB at module-load time.
import "../plugins/_env.js";

import { describe, it, expect, vi } from "vitest";
import { sha256 } from "@noble/hashes/sha256.js";
import {
  PairingCoordinator,
  normalizePairMethod,
  decodePairingToken,
  deriveDynamicCode,
} from "../../src/services/sendspin/pairServer.js";
import { CPace, wrapKey, aeadSeal } from "../../src/services/sendspin/cpace.js";
import { b64urlEncode, b64urlDecode } from "../../src/services/sendspin/util.js";

// ---- 与 pairServer.ts 内部常量保持一致(测试侧重建,源码改动会在此暴露) ----
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

// ---- base32(RFC4648, 无 padding 语义由解码侧补位) ----
const B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
function b32Encode(bytes: Uint8Array): string {
  let bits = 0;
  let acc = 0;
  let out = "";
  for (const byte of bytes) {
    acc = (acc << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      out += B32[(acc >> bits) & 31];
    }
  }
  if (bits > 0) out += B32[(acc << (5 - bits)) & 31];
  return out;
}

// ---- 假连接 / 假 server / 假 store ----
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

function makeServer(conn?: any) {
  const clients = new Map<string, any>();
  if (conn) clients.set(conn.clientId, conn);
  return { clients, log: () => undefined } as any;
}

function makeStore() {
  return { putRecord: vi.fn(async () => undefined), getRecord: vi.fn(() => undefined) } as any;
}

function lastSent(conn: any, type: string): any {
  for (let i = conn.sent.length - 1; i >= 0; i--) if (conn.sent[i][0] === type) return conn.sent[i][1];
  return undefined;
}

// ==================== 纯函数 ====================
describe("pairServer 纯函数", () => {
  it("normalizePairMethod: 长短名归一 + 未知返回 null", () => {
    expect(normalizePairMethod("static_pairing_code")).toBe("static_pairing_code");
    expect(normalizePairMethod("static_pin")).toBe("static_pairing_code");
    expect(normalizePairMethod("dynamic_pairing_code")).toBe("dynamic_pairing_code");
    expect(normalizePairMethod("dynamic_pin")).toBe("dynamic_pairing_code");
    expect(normalizePairMethod("pairing_psk")).toBe("pairing_psk");
    expect(normalizePairMethod("nope")).toBeNull();
    expect(normalizePairMethod("")).toBeNull();
  });

  it("decodePairingToken: SP:0… 解出 client_key + pairing_psk", () => {
    const raw = new Uint8Array(64).fill(3);
    const t = decodePairingToken("SP:0" + b32Encode(raw));
    expect(t).not.toBeNull();
    expect(t!.version).toBe(0);
    expect(t!.clientKey!.length).toBe(32);
    expect(t!.pairingPsk!.length).toBe(32);
  });

  it("decodePairingToken: 小写 sp: 前缀与前后空白均容错", () => {
    const raw = new Uint8Array(64).fill(5);
    const t = decodePairingToken("  sp:0" + b32Encode(raw).toLowerCase() + " ");
    expect(t).not.toBeNull();
    expect(t!.clientKey!.length).toBe(32);
  });

  it("decodePairingToken: 非法版本 / 空串 / 非法字符一律 null", () => {
    expect(decodePairingToken("SP:2" + b32Encode(new Uint8Array(64)))).toBeNull();
    expect(decodePairingToken("")).toBeNull();
    expect(decodePairingToken("SP:0" + b32Encode(new Uint8Array(10)))).toBeNull();
    expect(decodePairingToken("SP:0!!!!")).toBeNull();
  });

  it("decodePairingToken: SP:1… 解出 24B 动态码", () => {
    const raw = new Uint8Array(24).fill(9);
    const t = decodePairingToken("SP:1" + b32Encode(raw));
    expect(t).not.toBeNull();
    expect(t!.version).toBe(1);
    expect(t!.code!.length).toBe(24);
    expect(decodePairingToken("SP:1" + b32Encode(new Uint8Array(8)))).toBeNull();
  });

  it("deriveDynamicCode: 6 位定长、同输入确定性、nonce 变化则码变化", () => {
    const h = new Uint8Array(32).fill(1);
    const a = new Uint8Array(32).fill(2);
    const b = new Uint8Array(32).fill(3);
    const c1 = deriveDynamicCode(h, a, b);
    expect(c1).toMatch(/^\d{6}$/);
    expect(deriveDynamicCode(h, a, b)).toBe(c1);
    expect(deriveDynamicCode(h, a, new Uint8Array(32).fill(4))).not.toBe(c1);
  });
});

// ==================== start ====================
describe("PairingCoordinator.start", () => {
  it("拒绝 pairing_psk(须走 token 接口)与未知方法", async () => {
    const conn = makeConn();
    const c = new PairingCoordinator(makeServer(conn), makeStore());
    await expect(c.start("CLIENTID", "pairing_psk")).rejects.toThrow();
    await expect(c.start("CLIENTID", "bogus")).rejects.toThrow();
    expect(conn.sent.length).toBe(0);
  });

  it("客户端未连接 / legacy 明文 / 重复 start 均拒绝", async () => {
    const empty = new PairingCoordinator(makeServer(), makeStore());
    await expect(empty.start("CLIENTID", "static_pin")).rejects.toThrow();

    const legacy = makeConn({ legacy: true });
    const c1 = new PairingCoordinator(makeServer(legacy), makeStore());
    await expect(c1.start("CLIENTID", "static_pin")).rejects.toThrow();

    const conn = makeConn();
    const c2 = new PairingCoordinator(makeServer(conn), makeStore());
    await c2.start("CLIENTID", "static_pin");
    await expect(c2.start("CLIENTID", "static_pin")).rejects.toThrow();
  });

  it("static: 短名方言回 static_pin", async () => {
    const conn = makeConn();
    const c = new PairingCoordinator(makeServer(conn), makeStore());
    await c.start("CLIENTID", "static_pairing_code");
    const act = lastSent(conn, "server/activate");
    expect(act.pairing.method).toBe("static_pin");
    expect(c.getAttempt("CLIENTID")?.method).toBe("static_pairing_code");
  });

  it("dynamic: 短名方言带 pin_length=6,长名方言带 format", async () => {
    const short = makeConn();
    const c1 = new PairingCoordinator(makeServer(short), makeStore());
    await c1.start("CLIENTID", "dynamic_pin");
    expect(lastSent(short, "server/activate").pairing.pin_length).toBe(6);

    const long = makeConn({ clientHello: { supported_pair_methods: { dynamic_pairing_code: {} } } });
    const c2 = new PairingCoordinator(makeServer(long), makeStore());
    await c2.start("CLIENTID", "dynamic_pairing_code", "qr_code");
    const act = lastSent(long, "server/activate").pairing;
    expect(act.method).toBe("dynamic_pairing_code");
    expect(act.format).toBe("qr_code");
  });

  it("客户端未报 supported_pair_methods: 短名兜底", async () => {
    const conn = makeConn({ clientHello: {} });
    const c = new PairingCoordinator(makeServer(conn), makeStore());
    await c.start("CLIENTID", "static_pairing_code");
    expect(lastSent(conn, "server/activate").pairing.method).toBe("static_pin");
  });
});

// ==================== enterCode ====================
describe("PairingCoordinator.enterCode", () => {
  it("无进行中配对 / 码长不符 均拒绝", async () => {
    const conn = makeConn();
    const c = new PairingCoordinator(makeServer(conn), makeStore());
    await expect(c.enterCode("CLIENTID", "12345678")).rejects.toThrow();
    await c.start("CLIENTID", "static_pin");
    await expect(c.enterCode("CLIENTID", "1234")).rejects.toThrow();
    await c.cancel("CLIENTID");
    await c.start("CLIENTID", "dynamic_pin");
    await expect(c.enterCode("CLIENTID", "12345678")).rejects.toThrow();
  });

  it("分隔符自动剥离,且 static 输码即发起 PAKE", async () => {
    const conn = makeConn();
    const c = new PairingCoordinator(makeServer(conn), makeStore());
    await c.start("CLIENTID", "static_pin");
    await c.onPairMessage(conn, "client/pair-init", { pairing_index: 1 });
    await c.enterCode("CLIENTID", "1234-5678");
    expect(c.getAttempt("CLIENTID")?.state).toBe("await_peer_auth");
    const auth = lastSent(conn, "server/pair-auth");
    expect(typeof auth?.pake_msg_1).toBe("string");
    expect(b64urlDecode(auth.pake_msg_1).length).toBeGreaterThan(0);
  });
});

// ==================== pairWithToken ====================
describe("PairingCoordinator.pairWithToken", () => {
  const key = new Uint8Array(32).fill(11);
  const psk = new Uint8Array(32).fill(22);
  const clientId = Buffer.from(key).toString("base64url");
  const goodToken = "SP:0" + b32Encode(new Uint8Array([...key, ...psk]));

  it("未连接 / legacy / 非法 token / 身份不匹配 / 重复 均拒绝", async () => {
    const c0 = new PairingCoordinator(makeServer(), makeStore());
    await expect(c0.pairWithToken(clientId, goodToken)).rejects.toThrow();

    const legacy = makeConn({ clientId, legacy: true });
    const c1 = new PairingCoordinator(makeServer(legacy), makeStore());
    await expect(c1.pairWithToken(clientId, goodToken)).rejects.toThrow();

    const conn = makeConn({ clientId });
    const c2 = new PairingCoordinator(makeServer(conn), makeStore());
    await expect(c2.pairWithToken(clientId, "not-a-token")).rejects.toThrow();
    await expect(c2.pairWithToken(clientId, "SP:1" + b32Encode(new Uint8Array(24)))).rejects.toThrow();
    await expect(c2.pairWithToken("other-client", goodToken)).rejects.toThrow();
    await c2.pairWithToken(clientId, goodToken);
    await expect(c2.pairWithToken(clientId, goodToken)).rejects.toThrow();
  });

  it("合法 token: 先 re-handshake 到配对 PSK,再发 pairing activate", async () => {
    const conn = makeConn({ clientId });
    const c = new PairingCoordinator(makeServer(conn), makeStore());
    await c.pairWithToken(clientId, goodToken);
    expect(conn.rehandshakeTo).toHaveBeenCalledWith(Buffer.from(psk).toString("hex"), "pr");
    expect(lastSent(conn, "server/activate").pairing.method).toBe("pairing_psk");
  });

  it("pairing-psk 流: finalize 落盘长 PSK 并 re-handshake 到 lt", async () => {
    const conn = makeConn({ clientId });
    const store = makeStore();
    const c = new PairingCoordinator(makeServer(conn), store);
    await c.pairWithToken(clientId, goodToken);
    const lt = new Uint8Array(32).fill(33);
    await c.onPairMessage(conn, "client/pair-finalize", {
      pairing_index: 2,
      long_term_psk: b64urlEncode(lt),
    });
    expect(store.putRecord).toHaveBeenCalledWith(clientId, Buffer.from(lt).toString("hex"));
    expect(lastSent(conn, "server/pair-finalize")).toBeDefined();
    expect(conn.rehandshakeTo).toHaveBeenCalledWith(Buffer.from(lt).toString("hex"), "lt");
  });

  it("pairing-psk finalize 长度非法 → protocol_error 且不落盘", async () => {
    const conn = makeConn({ clientId });
    const store = makeStore();
    const c = new PairingCoordinator(makeServer(conn), store);
    await c.pairWithToken(clientId, goodToken);
    await c.onPairMessage(conn, "client/pair-finalize", {
      pairing_index: 2,
      long_term_psk: b64urlEncode(new Uint8Array(8)),
    });
    expect(store.putRecord).not.toHaveBeenCalled();
    expect(c.getAttempt(clientId)).toBeUndefined();
  });
});

// ==================== onPairMessage 分拣 ====================
describe("PairingCoordinator.onPairMessage 分拣", () => {
  it("无 clientId 静默返回", async () => {
    const c = new PairingCoordinator(makeServer(), makeStore());
    await c.onPairMessage({ clientId: undefined } as any, "client/pair-init", {});
  });

  it("非配对期 pair 消息静默丢弃", async () => {
    const conn = makeConn();
    const c = new PairingCoordinator(makeServer(conn), makeStore());
    await c.onPairMessage(conn, "client/pair-init", {});
    expect(c.getAttempt("CLIENTID")).toBeUndefined();
  });

  it("旧轮次残留忽略;未来轮次 → protocol_error", async () => {
    const conn = makeConn();
    const c = new PairingCoordinator(makeServer(conn), makeStore());
    await c.start("CLIENTID", "static_pin");
    await c.onPairMessage(conn, "client/pair-init", { pairing_index: 0 });
    expect(c.getAttempt("CLIENTID")).toBeDefined();
    await c.onPairMessage(conn, "client/pair-init", { pairing_index: 99 });
    expect(c.getAttempt("CLIENTID")).toBeUndefined();
  });

  it("pair/abort 结束配对并恢复 playback 激活", async () => {
    const conn = makeConn();
    const c = new PairingCoordinator(makeServer(conn), makeStore());
    await c.start("CLIENTID", "static_pin");
    await c.onPairMessage(conn, "pair/abort", { reason: "user" });
    expect(c.getAttempt("CLIENTID")).toBeUndefined();
    expect(lastSent(conn, "server/activate").activities).toEqual(["playback"]);
  });

  it("client/pair-pending 记录待确认文案", async () => {
    const conn = makeConn();
    const c = new PairingCoordinator(makeServer(conn), makeStore());
    await c.start("CLIENTID", "static_pin");
    await c.onPairMessage(conn, "client/pair-pending", { pairing_index: 1, message: "请在设备上确认" });
    expect(c.getAttempt("CLIENTID")?.pendingMessage).toBe("请在设备上确认");
    await c.onPairMessage(conn, "client/pair-pending", { pairing_index: 1 });
    expect(c.getAttempt("CLIENTID")?.pendingMessage).toBe("等待设备端确认");
  });

  it("未知 pair 类型无副作用", async () => {
    const conn = makeConn();
    const c = new PairingCoordinator(makeServer(conn), makeStore());
    await c.start("CLIENTID", "static_pin");
    const before = conn.sent.length;
    await c.onPairMessage(conn, "client/pair-unknown", { pairing_index: 1 });
    expect(conn.sent.length).toBe(before);
  });
});

// ==================== client/pair-init ====================
describe("PairingCoordinator client/pair-init", () => {
  it("dynamic: 缺 commit_B / 非法 base64 / 长度非 32B 均 protocol_error", async () => {
    for (const bad of [undefined, "!!!not-b64!!!", b64urlEncode(new Uint8Array(16))]) {
      const conn = makeConn();
      const c = new PairingCoordinator(makeServer(conn), makeStore());
      await c.start("CLIENTID", "dynamic_pin");
      const payload: any = { pairing_index: 1 };
      if (bad !== undefined) payload.commit_B = bad;
      await c.onPairMessage(conn, "client/pair-init", payload);
      expect(c.getAttempt("CLIENTID"), String(bad)).toBeUndefined();
    }
  });

  it("dynamic: 合法 commit_B → 回 nonce_A 并进入 await_code", async () => {
    const conn = makeConn();
    const c = new PairingCoordinator(makeServer(conn), makeStore());
    await c.start("CLIENTID", "dynamic_pin");
    await c.onPairMessage(conn, "client/pair-init", {
      pairing_index: 1,
      commit_B: b64urlEncode(new Uint8Array(32).fill(4)),
    });
    const init = lastSent(conn, "server/pair-init");
    expect(b64urlDecode(init.nonce_A).length).toBe(32);
    expect(c.getAttempt("CLIENTID")?.state).toBe("await_code");
  });

  it("state 非 await_init 时 pair-init 被忽略", async () => {
    const conn = makeConn();
    const c = new PairingCoordinator(makeServer(conn), makeStore());
    await c.start("CLIENTID", "static_pin");
    await c.onPairMessage(conn, "client/pair-init", { pairing_index: 1 });
    const before = conn.sent.length;
    await c.onPairMessage(conn, "client/pair-init", { pairing_index: 1 });
    expect(conn.sent.length).toBe(before);
  });
});

// ==================== 完整 PAKE 流程 ====================
/** 起一轮配对并把服务端推进到 await_peer_auth(已发出 pake_msg_1)。 */
async function beginStaticRound() {
  const conn = makeConn();
  const store = makeStore();
  const coord = new PairingCoordinator(makeServer(conn), store);
  const h = conn.noise.handshakeHash as Uint8Array;
  const code = "12345678";
  await coord.start("CLIENTID", "static_pin");
  await coord.onPairMessage(conn, "client/pair-init", { pairing_index: 1 });
  await coord.enterCode("CLIENTID", code);
  const sid = sidFor(h, 1);
  const client = CPace.start({ role: "responder", prs: enc(code), sid, ad: enc("client") });
  const serverShare = b64urlDecode(lastSent(conn, "server/pair-auth").pake_msg_1);
  client.derive(serverShare, enc("server"));
  return { conn, store, coord, client, sid, h };
}

describe("PairingCoordinator 完整 static 配对流程", () => {
  it("init → code → auth → confirm → finalize 落盘 + re-handshake 到长 PSK", async () => {
    const { conn, store, coord, client, sid } = await beginStaticRound();
    await coord.onPairMessage(conn, "client/pair-auth", {
      pairing_index: 1,
      pake_msg_2: b64urlEncode(client.publicShare),
    });
    const serverKc = b64urlDecode(lastSent(conn, "server/pair-confirm").server_kc);
    expect(client.verify(serverKc)).toBe(true);
    expect(coord.getAttempt("CLIENTID")?.state).toBe("await_confirm");

    await coord.onPairMessage(conn, "client/pair-confirm", {
      pairing_index: 1,
      client_kc: b64urlEncode(client.tag()),
    });
    const psk = new Uint8Array(32).fill(77);
    const k = wrapKey(WRAP_PSK_LABEL, sid, client.getISK());
    await coord.onPairMessage(conn, "client/pair-finalize", {
      pairing_index: 1,
      wrapped_psk: b64urlEncode(aeadSeal("chacha", k, psk)),
    });
    expect(store.putRecord).toHaveBeenCalledWith("CLIENTID", Buffer.from(psk).toString("hex"));
    expect(lastSent(conn, "server/pair-finalize")).toBeDefined();
    expect(conn.rehandshakeTo).toHaveBeenCalledWith(Buffer.from(psk).toString("hex"), "lt");
    expect(coord.getAttempt("CLIENTID")).toBeUndefined();
  });

  it("码错: confirm 校验失败 → pair/abort + 结束配对", async () => {
    const { conn, coord, client } = await beginStaticRound();
    await coord.onPairMessage(conn, "client/pair-auth", {
      pairing_index: 1,
      pake_msg_2: b64urlEncode(client.publicShare),
    });
    await coord.onPairMessage(conn, "client/pair-confirm", {
      pairing_index: 1,
      client_kc: b64urlEncode(new Uint8Array(32).fill(1)),
    });
    expect(lastSent(conn, "pair/abort").reason).toBe("pairing_code_mismatch");
    expect(coord.getAttempt("CLIENTID")).toBeUndefined();
  });

  it("pair-auth 载荷非法 base64 → protocol_error", async () => {
    const { conn, coord } = await beginStaticRound();
    await coord.onPairMessage(conn, "client/pair-auth", { pairing_index: 1, pake_msg_2: "@@@" });
    expect(coord.getAttempt("CLIENTID")).toBeUndefined();
  });

  it("低阶点/协议错误:derive 抛错 → 静默断连且不落盘", async () => {
    const { conn, coord, store } = await beginStaticRound();
    await coord.onPairMessage(conn, "client/pair-auth", {
      pairing_index: 1,
      pake_msg_2: b64urlEncode(new Uint8Array(32)),
    });
    expect(conn.closed).toBe(true);
    expect(coord.getAttempt("CLIENTID")).toBeUndefined();
    expect(store.putRecord).not.toHaveBeenCalled();
  });

  it("finalize 抢在 confirm 前到达:state 已 await_confirm 且 cpace 就绪 → 直接落盘", async () => {
    const { conn, store, coord, client, sid } = await beginStaticRound();
    const psk = new Uint8Array(32).fill(88);
    const k = wrapKey(WRAP_PSK_LABEL, sid, client.getISK());
    const wrapped = b64urlEncode(aeadSeal("chacha", k, psk));
    await coord.onPairMessage(conn, "client/pair-auth", {
      pairing_index: 1,
      pake_msg_2: b64urlEncode(client.publicShare),
    });
    // onPairFinalize 只在 state !== await_confirm 时才写 pendingFinalize,而缓存又要求
    // state === await_confirm —— 条件自相矛盾,pendingFinalize 缓存路径实际不可达。现状固化。
    await coord.onPairMessage(conn, "client/pair-finalize", { pairing_index: 1, wrapped_psk: wrapped });
    expect(store.putRecord).toHaveBeenCalledWith("CLIENTID", Buffer.from(psk).toString("hex"));
    expect(coord.getAttempt("CLIENTID")).toBeUndefined();
    expect(conn.rehandshakeTo).toHaveBeenCalledWith(Buffer.from(psk).toString("hex"), "lt");
  });

  it("finalize 的 wrapped_psk 解不开 → protocol_error 且不落盘", async () => {
    const { conn, coord, client, store } = await beginStaticRound();
    await coord.onPairMessage(conn, "client/pair-auth", {
      pairing_index: 1,
      pake_msg_2: b64urlEncode(client.publicShare),
    });
    await coord.onPairMessage(conn, "client/pair-confirm", {
      pairing_index: 1,
      client_kc: b64urlEncode(client.tag()),
    });
    await coord.onPairMessage(conn, "client/pair-finalize", {
      pairing_index: 1,
      wrapped_psk: b64urlEncode(new Uint8Array(8)),
    });
    expect(store.putRecord).not.toHaveBeenCalled();
    expect(coord.getAttempt("CLIENTID")).toBeUndefined();
  });
});

describe("PairingCoordinator dynamic digits 流程(现状固化)", () => {
  it("pair-init 后回 nonce_A 并进入 await_code", async () => {
    const conn = makeConn();
    const coord = new PairingCoordinator(makeServer(conn), makeStore());
    await coord.start("CLIENTID", "dynamic_pin");
    const nonceB = new Uint8Array(32).fill(42);
    const commitB = sha256(new Uint8Array([...enc(COMMIT_LABEL), ...nonceB]));
    await coord.onPairMessage(conn, "client/pair-init", { pairing_index: 1, commit_B: b64urlEncode(commitB) });
    expect(b64urlDecode(lastSent(conn, "server/pair-init").nonce_A).length).toBe(32);
    expect(coord.getAttempt("CLIENTID")?.state).toBe("await_code");
  });

  it("[已确知缺口] dynamic digits:运营商后输码不推进 PAKE(仅 static 有推进路径)", async () => {
    const conn = makeConn();
    const coord = new PairingCoordinator(makeServer(conn), makeStore());
    const h = conn.noise.handshakeHash as Uint8Array;
    await coord.start("CLIENTID", "dynamic_pin");
    const nonceB = new Uint8Array(32).fill(42);
    const commitB = sha256(new Uint8Array([...enc(COMMIT_LABEL), ...nonceB]));
    await coord.onPairMessage(conn, "client/pair-init", { pairing_index: 1, commit_B: b64urlEncode(commitB) });
    const nonceA = b64urlDecode(lastSent(conn, "server/pair-init").nonce_A);
    await coord.enterCode("CLIENTID", deriveDynamicCode(h, nonceA, nonceB));
    // 现状:enterCode 仅对 static 触发 runStaticRound,dynamic 停在 await_code 且未发 pair-auth
    expect(coord.getAttempt("CLIENTID")?.state).toBe("await_code");
    expect(lastSent(conn, "server/pair-auth")).toBeUndefined();
  });
});

// ==================== retry / cancel ====================
describe("PairingCoordinator retry 与 cancel", () => {
  it("非 dynamic 方法的 pair-retry 被忽略", async () => {
    const { conn, coord } = await beginStaticRound();
    const before = conn.sent.length;
    await coord.onPairMessage(conn, "client/pair-retry", { pairing_index: 1 });
    expect(conn.sent.length).toBe(before);
  });

  it("dynamic 在 await_code(非允许状态)收到 retry 被忽略", async () => {
    const conn = makeConn();
    const coord = new PairingCoordinator(makeServer(conn), makeStore());
    await coord.start("CLIENTID", "dynamic_pin");
    await coord.onPairMessage(conn, "client/pair-init", {
      pairing_index: 1,
      commit_B: b64urlEncode(new Uint8Array(32).fill(6)),
    });
    const before = conn.sent.length;
    await coord.onPairMessage(conn, "client/pair-retry", { pairing_index: 1 });
    expect(conn.sent.length).toBe(before);
  });

  it("cancel 结束配对;无 attempt 时 cancel 不抛", async () => {
    const conn = makeConn();
    const coord = new PairingCoordinator(makeServer(conn), makeStore());
    expect(() => coord.cancel("CLIENTID")).not.toThrow();
    await coord.start("CLIENTID", "static_pin");
    coord.cancel("CLIENTID");
    expect(coord.getAttempt("CLIENTID")).toBeUndefined();
    expect(coord.listAttempts()).toEqual([]);
  });

  it("listAttempts 反映进行中的配对", async () => {
    const conn = makeConn();
    const coord = new PairingCoordinator(makeServer(conn), makeStore());
    await coord.start("CLIENTID", "static_pin");
    expect(coord.listAttempts().length).toBe(1);
    expect(coord.listAttempts()[0].method).toBe("static_pairing_code");
  });
});
