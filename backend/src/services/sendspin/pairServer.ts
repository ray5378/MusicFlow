// ==================== Sendspin 配对服务端编排 ====================
//
// 实现 spec pairing.md 的三种配对法(服务端侧,服务端恒为 PAKE initiator/A 角):
//   - static_pairing_code:8 位固定码(无屏设备主流;码印机身,运营商在服务端输入)
//   - dynamic_pairing_code:6 位动态码(digits;设备外放/显示,运营商读后输入)+
//     qr_code token(SP:1…,码即 token,免外放)
//   - pairing_psk:配对 token(SP:0…,client_key||pairing_psk,运营商输入)
// 流程:REST 启动 → server/activate{pairing} → pair-init/auth/confirm/finalize
// → 落盘长配对 PSK → 带内 re-handshake 切到长 PSK → playback 激活。
// legacy 明文连接无配对(直接拒绝启动)。
import { randomBytes } from "node:crypto";
import { sha256 } from "@noble/hashes/sha256.js";
import { CPace, wrapKey, aeadSeal, aeadOpen } from "./cpace.js";
import { b64urlEncode, b64urlDecode } from "./util.js";
import type { SendspinConnection, SendspinServer } from "./server.js";
import type { PairingStore } from "./pairingStore.js";
import { StaticCodeGate } from "./pairing.js";

export type PairMethod = "static_pairing_code" | "dynamic_pairing_code" | "pairing_psk";
export type PairFormat = "digits" | "qr_code";

/** 线上方法标识归一(REST/内部统一用 spec 名)。 */
export function normalizePairMethod(m: string): PairMethod | null {
  if (m === "static_pairing_code" || m === "static_pin") return "static_pairing_code";
  if (m === "dynamic_pairing_code" || m === "dynamic_pin") return "dynamic_pairing_code";
  if (m === "pairing_psk") return "pairing_psk";
  return null;
}

/** 客户端方言:它 hello 里报什么方法名,activate 就回什么名。
 *  aiosendspin≤9.x 用短名(static_pin/dynamic_pin),spec 用长名。 */
function wireMethodFor(hello: any, method: PairMethod): string {
  const offered = hello && typeof hello === "object" ? (hello.supported_pair_methods ?? {}) : {};
  const keys = typeof offered === "object" && offered !== null ? Object.keys(offered) : [];
  const short = method === "static_pairing_code" ? "static_pin" : method === "dynamic_pairing_code" ? "dynamic_pin" : "pairing_psk";
  const long = method;
  if (keys.includes(short)) return short;
  if (keys.includes(long)) return long;
  // 没报或报法不明:短名优先(现存实现多为短名),长名兜底由对端 method_not_supported 表达。
  return keys.length ? keys.find((k) => normalizePairMethod(k) === method) ?? short : short;
}

/** 客户端是否短名方言(决定 activate 要不要带 format/pin_length)。 */
function isShortDialect(hello: any, method: PairMethod): boolean {
  const offered = hello && typeof hello === "object" ? (hello.supported_pair_methods ?? {}) : {};
  const keys = typeof offered === "object" && offered !== null ? Object.keys(offered) : [];
  if (!keys.length) return true;
  const short = method === "static_pairing_code" ? "static_pin" : method === "dynamic_pairing_code" ? "dynamic_pin" : "pairing_psk";
  return keys.includes(short);
}

const ATTEMPT_TIMEOUT_MS = 120_000;
const PAKE_SID_LABEL = "sendspin-pair-pake-v1";
const COMMIT_LABEL = "sendspin-pair-commit-v1";
const DERIVE_LABEL = "sendspin-pairing-code-derive-v1";
const WRAP_PSK_LABEL = "sendspin-pair-psk-wrap-v1";
const WRAP_NONCE_LABEL = "sendspin-pair-nonce-wrap-v1";

export interface PairAttemptInfo {
  clientId: string;
  method: PairMethod;
  format?: PairFormat;
  state: string;
  pendingMessage?: string;
  startedAt: number;
}

interface Attempt {
  clientId: string;
  method: PairMethod;
  format: PairFormat;
  pairingIndex: number;
  round: number;
  state: "await_init" | "await_code" | "await_peer_auth" | "await_confirm" | "done";
  code?: string; // 运营商已输入的码(digits ascii 或 qr 24B hex 标记)
  codeRaw?: Uint8Array; // CPace PRS 字节
  nonceA?: Uint8Array;
  commitB?: Uint8Array;
  cpace?: CPace;
  pendingFinalize?: any; // 与 pair-confirm 背靠背到达的 finalize 缓存
  pendingMessage?: string; // client/pair-pending 原文(展示给运营商)
  gate: StaticCodeGate;
  timer: ReturnType<typeof setTimeout>;
  codeWaiters: Array<() => void>;
  msgWaiters: Array<{ type: string; resolve: (p: any) => void }>;
}

const be32 = (n: number): Uint8Array => {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setUint32(0, n >>> 0, false);
  return b;
};

function buildSid(h: Uint8Array, pairingIndex: number): Uint8Array {
  // 注意与 spec 文本的差异:spec 写 sid = label||h||pairing_index||round,
  // 但线上实现(aiosendspin 9.x,含真实设备) sid = label||h||pairing_index(无 round)。
  // 互操作优先,跟线上实现走;round 仅用于重试计数,不进 sid。
  const l = new TextEncoder().encode(PAKE_SID_LABEL);
  return new Uint8Array([...l, ...h, ...be32(pairingIndex)]);
}

function suiteKey(suite: string): "chacha" | "aesgcm" {
  return suite.includes("AESGCM") ? "aesgcm" : "chacha";
}

/** 解析配对 token(SP:0… 64B client_key||psk / SP:1… 24B 动态码)。 */
export function decodePairingToken(input: string): { version: 0 | 1; clientKey?: Uint8Array; pairingPsk?: Uint8Array; code?: Uint8Array } | null {
  let s = (input || "").trim().toUpperCase();
  if (s.startsWith("SP:")) s = s.slice(3);
  if (s.length < 1) return null;
  const version = s[0];
  if (version !== "0" && version !== "1") return null;
  let body = s.slice(1).replace(/9/g, "2");
  while (body.length % 8 !== 0) body += "=";
  let raw: Uint8Array;
  try {
    raw = base32Decode(body);
  } catch {
    return null;
  }
  if (version === "0") {
    if (raw.length < 64) return null;
    return { version: 0, clientKey: raw.slice(0, 32), pairingPsk: raw.slice(32, 64) };
  }
  if (raw.length < 24) return null;
  return { version: 1, code: raw.slice(0, 24) };
}

const B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
function base32Decode(s: string): Uint8Array {
  let bits = 0;
  let acc = 0;
  const out: number[] = [];
  for (const ch of s) {
    if (ch === "=") break;
    const v = B32.indexOf(ch);
    if (v < 0) throw new Error("bad char");
    acc = (acc << 5) | v;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      out.push((acc >> bits) & 0xff);
    }
  }
  return new Uint8Array(out);
}

/** 动态码派生:uint256_be(sha256(label||h||nonceA||nonceB)) mod 10^6,6 位 ASCII。 */
export function deriveDynamicCode(h: Uint8Array, nonceA: Uint8Array, nonceB: Uint8Array): string {
  const l = new TextEncoder().encode(DERIVE_LABEL);
  const d = sha256(new Uint8Array([...l, ...h, ...nonceA, ...nonceB]));
  let v = 0n;
  for (const b of d) v = (v << 8n) | BigInt(b);
  return (v % 1000000n).toString().padStart(6, "0");
}

export class PairingCoordinator {
  private attempts = new Map<string, Attempt>();

  constructor(
    private server: SendspinServer,
    private store: PairingStore,
  ) {}

  getAttempt(clientId: string): PairAttemptInfo | undefined {
    const a = this.attempts.get(clientId);
    if (!a) return undefined;
    return { clientId, method: a.method, format: a.format, state: a.state, pendingMessage: a.pendingMessage, startedAt: 0 };
  }

  listAttempts(): PairAttemptInfo[] {
    return [...this.attempts.keys()].map((k) => this.getAttempt(k)!);
  }

  /** REST 启动配对:发 pairing activate,等客户端 pair-init。 */
  async start(clientId: string, method: string, format: PairFormat = "digits"): Promise<void> {
    const norm = normalizePairMethod(method);
    if (!norm || norm === "pairing_psk") throw new Error("start 仅码配对(static/dynamic);pairing_psk 走 token 接口");
    const conn = this.server.clients.get(clientId);
    if (!conn || !conn.clientId) throw new Error("客户端未连接");
    if (conn.legacy) throw new Error("legacy 明文连接无配对(配对仅加密连接可用)");
    if (this.attempts.has(clientId)) throw new Error("该客户端已有进行中的配对");
    const pairingIndex = conn.nextPairingIndex();
    const attempt: Attempt = {
      clientId,
      method: norm,
      format,
      pairingIndex,
      round: 1,
      state: "await_init",
      gate: new StaticCodeGate(),
      timer: setTimeout(() => this.abort(clientId, "attempt_timeout", true), ATTEMPT_TIMEOUT_MS),
      codeWaiters: [],
      msgWaiters: [],
    };
    this.attempts.set(clientId, attempt);
    const pairing: any = { method: wireMethodFor(conn.clientHello, norm) };
    if (norm === "dynamic_pairing_code") {
      if (isShortDialect(conn.clientHello, norm)) pairing.pin_length = 6;
      else pairing.format = format;
    }
    conn.sendJson("server/activate", { activities: ["pairing"], active_roles: [], pairing });
    this.server.log("info", `pairing started: ${clientId} method=${norm} wire=${pairing.method}`);
  }

  /** 运营商输入码(static 8 位 / dynamic 6 位,分隔符自动剥离)。 */
  async enterCode(clientId: string, code: string): Promise<void> {
    const a = this.attempts.get(clientId);
    if (!a || (a.method !== "static_pairing_code" && a.method !== "dynamic_pairing_code")) {
      throw new Error("该客户端没有等待输码的配对");
    }
    const digits = code.replace(/[\s-]/g, "");
    const wantLen = a.method === "static_pairing_code" ? 8 : 6;
    if (!new RegExp(`^\\d{${wantLen}}$`).test(digits)) throw new Error(`码长须为 ${wantLen} 位数字`);
    if (a.method === "static_pairing_code") {
      if (a.gate.expired()) a.gate.reset();
      else if (a.gate.locked()) throw new Error("该设备配对码已锁定(失败过多),等窗口过期");
    }
    a.code = digits;
    a.codeRaw = new TextEncoder().encode(digits);
    for (const w of a.codeWaiters.splice(0)) w();
    // static:输码即开跑(若 pair-init 已到);dynamic:码就绪后等 round 推进。
    if (a.method === "static_pairing_code" && a.state === "await_code") {
      void this.runStaticRound(a).catch((e) => this.abort(clientId, "pairing_code_mismatch", false, String(e?.message || e)));
    }
  }

  /** pairing-psk token 配对(SP:0…):运营商一次输入,服务端先 re-handshake 到配对 PSK。 */
  async pairWithToken(clientId: string, token: string): Promise<void> {
    const conn = this.server.clients.get(clientId);
    if (!conn || !conn.clientId) throw new Error("客户端未连接");
    if (conn.legacy) throw new Error("legacy 明文连接无配对");
    const t = decodePairingToken(token);
    if (!t || t.version !== 0 || !t.clientKey || !t.pairingPsk) throw new Error("token 非法(需 SP:0… 配对 token)");
    if (Buffer.from(t.clientKey).toString("base64url") !== clientId) throw new Error("token 与该客户端身份不匹配");
    if (this.attempts.has(clientId)) throw new Error("该客户端已有进行中的配对");
    const pairingIndex = conn.nextPairingIndex();
    const attempt: Attempt = {
      clientId, method: "pairing_psk", format: "digits", pairingIndex, round: 1,
      state: "await_init", gate: new StaticCodeGate(),
      timer: setTimeout(() => this.abort(clientId, "attempt_timeout", true), ATTEMPT_TIMEOUT_MS),
      codeWaiters: [], msgWaiters: [],
    };
    this.attempts.set(clientId, attempt);
    // 先 re-handshake 到配对 PSK,再发 pairing activate。
    await conn.rehandshakeTo(Buffer.from(t.pairingPsk).toString("hex"), "pr");
    attempt.pairingIndex = conn.nextPairingIndex();
    conn.sendJson("server/activate", {
      activities: ["pairing"], active_roles: [],
      pairing: { method: "pairing_psk" },
    });
    this.server.log("info", `pairing-psk re-handshaked: ${clientId},等 client/pair-finalize`);
  }

  /** 运营商取消。 */
  cancel(clientId: string): void {
    this.abort(clientId, "user_cancelled", false);
  }

  private abort(clientId: string, reason: string, timeout: boolean, detail?: string): void {
    const a = this.attempts.get(clientId);
    if (!a) return;
    clearTimeout(a.timer);
    this.attempts.delete(clientId);
    const conn = this.server.clients.get(clientId);
    if (conn && conn.ready) {
      conn.sendJson("pair/abort", { reason });
      // 回到 playback 激活(配对与播放互斥结束,恢复现场)。
      const hello: any = conn.clientHello ?? {};
      const supported = Array.isArray(hello.supported_roles) ? hello.supported_roles : [];
      conn.sendJson("server/activate", { activities: ["playback"], active_roles: conn.roles.length ? conn.roles : supported });
    }
    this.server.log("info", `pairing aborted: ${clientId} reason=${reason}${timeout ? " (timeout)" : ""}${detail ? ` ${detail}` : ""}`);
  }

  private finishAttempt(clientId: string): void {
    const a = this.attempts.get(clientId);
    if (!a) return;
    clearTimeout(a.timer);
    this.attempts.delete(clientId);
  }

  /** pair/* 入站总入口(由 _dispatch 转交)。 */
  async onPairMessage(conn: SendspinConnection, type: string, payload: any): Promise<void> {
    const clientId = conn.clientId;
    if (!clientId) return;
    const a = this.attempts.get(clientId);
    if (type === "pair/abort") {
      if (a) this.abort(clientId, payload?.reason || "aborted", false);
      return;
    }
    if (!a) return; // 非配对期 pair 消息:静默丢弃
    if (typeof payload?.pairing_index === "number" && payload.pairing_index < a.pairingIndex) return; // 旧轮次残留
    if (typeof payload?.pairing_index === "number" && payload.pairing_index > a.pairingIndex) {
      return this.abort(clientId, "protocol_error", false) as unknown as void;
    }
    switch (type) {
      case "client/pair-pending":
        a.pendingMessage = typeof payload?.message === "string" ? payload.message.slice(0, 200) : "等待设备端确认";
        return;
      case "client/pair-init":
        await this.onPairInit(a, conn, payload);
        return;
      case "client/pair-auth":
        await this.onPairAuth(a, conn, payload);
        return;
      case "client/pair-retry":
        await this.onPairRetry(a, conn);
        return;
      case "client/pair-confirm":
        await this.onPairConfirm(a, conn, payload);
        return;
      case "client/pair-finalize":
        await this.onPairFinalize(a, conn, payload);
        return;
      default:
        return;
    }
  }

  private async onPairInit(a: Attempt, conn: SendspinConnection, payload: any): Promise<void> {
    if (a.state !== "await_init") return;
    if (a.method === "dynamic_pairing_code") {
      const commit = typeof payload?.commit_B === "string" ? payload.commit_B : "";
      if (!commit) return this.abort(a.clientId, "protocol_error", false);
      try {
        a.commitB = b64urlDecode(commit);
      } catch {
        return this.abort(a.clientId, "protocol_error", false);
      }
      if (a.commitB.length !== 32) return this.abort(a.clientId, "protocol_error", false);
      // 首轮发 nonce_A;码由运营商从设备外放读出后输入。
      a.nonceA = randomBytes(32);
      conn.sendJson("server/pair-init", { nonce_A: b64urlEncode(a.nonceA) });
      a.state = "await_code";
      // 若码已提前输入(如 qr token),直接开跑。
      if (a.codeRaw) void this.runDynamicRound(a).catch((e) => this.abort(a.clientId, "pairing_code_mismatch", false, String(e?.message || e)));
      return;
    }
    if (a.method === "static_pairing_code") {
      a.state = "await_code";
      if (a.codeRaw) void this.runStaticRound(a).catch((e) => this.abort(a.clientId, "pairing_code_mismatch", false, String(e?.message || e)));
      return;
    }
  }

  private waitForCode(a: Attempt): Promise<void> {
    if (a.codeRaw) return Promise.resolve();
    return new Promise((resolve) => a.codeWaiters.push(resolve));
  }

  private pakeSid(conn: SendspinConnection, a: Attempt): Uint8Array {
    const h = conn.noise?.handshakeHash;
    if (!h || h.length !== 32) throw new Error("no handshake hash");
    return buildSid(h, a.pairingIndex);
  }

  private async runStaticRound(a: Attempt): Promise<void> {
    const conn = this.server.clients.get(a.clientId);
    if (!conn || !a.codeRaw) return;
    a.state = "await_peer_auth";
    const cpace = CPace.start({ role: "initiator", prs: a.codeRaw, sid: this.pakeSid(conn, a), ad: new TextEncoder().encode("server") });
    a.cpace = cpace;
    conn.sendJson("server/pair-auth", { pake_msg_1: b64urlEncode(cpace.publicShare) });
  }

  private async runDynamicRound(a: Attempt): Promise<void> {
    const conn = this.server.clients.get(a.clientId);
    if (!conn || !a.codeRaw || !a.nonceA) return;
    a.state = "await_peer_auth";
    const cpace = CPace.start({ role: "initiator", prs: a.codeRaw, sid: this.pakeSid(conn, a), ad: new TextEncoder().encode("server") });
    a.cpace = cpace;
    conn.sendJson("server/pair-auth", { pake_msg_1: b64urlEncode(cpace.publicShare) });
  }

  private async onPairAuth(a: Attempt, conn: SendspinConnection, payload: any): Promise<void> {
    if (a.state !== "await_peer_auth" || !a.cpace) return;
    let yb: Uint8Array;
    try {
      yb = b64urlDecode(String(payload?.pake_msg_2 || ""));
    } catch {
      return this.abort(a.clientId, "protocol_error", false);
    }
    try {
      a.cpace.derive(yb, new TextEncoder().encode("client"));
    } catch {
      // 低阶点等协议错误:静默断连,不存任何东西。
      try { conn.close(); } catch { /* ignore */ }
      this.finishAttempt(a.clientId);
      return;
    }
    conn.sendJson("server/pair-confirm", { server_kc: b64urlEncode(a.cpace.tag()) });
    a.state = "await_confirm";
    // finalize 常与 confirm 背靠背到达:若已缓存直接处理。
    if (a.pendingFinalize) {
      const f = a.pendingFinalize;
      a.pendingFinalize = undefined;
      await this.onPairFinalize(a, conn, f);
    }
  }

  private async onPairRetry(a: Attempt, conn: SendspinConnection): Promise<void> {
    if (a.method !== "dynamic_pairing_code" || (a.state !== "await_confirm" && a.state !== "await_peer_auth")) return;
    a.round += 1;
    a.cpace = undefined;
    a.pendingFinalize = undefined;
    // 新 round:新 server/pair-init(不带 nonce_A,复用首轮),新 CPace run。
    conn.sendJson("server/pair-init", {});
    a.state = "await_code";
    if (a.codeRaw) void this.runDynamicRound(a).catch((e) => this.abort(a.clientId, "pairing_code_mismatch", false, String(e?.message || e)));
  }

  private async onPairConfirm(a: Attempt, conn: SendspinConnection, payload: any): Promise<void> {
    if (a.state !== "await_confirm" || !a.cpace) return;
    let ckc: Uint8Array;
    try {
      ckc = b64urlDecode(String(payload?.client_kc || ""));
    } catch {
      return this.abort(a.clientId, "protocol_error", false);
    }
    if (!a.cpace.verify(ckc)) {
      if (a.method === "static_pairing_code") {
        const g = a.gate;
        g.recordFailure();
        if (g.locked()) {
          conn.sendJson("pair/abort", { reason: "pairing_code_mismatch" });
          return this.abort(a.clientId, "pairing_code_mismatch", false, "码错误次数超限,窗口锁定");
        }
      }
      conn.sendJson("pair/abort", { reason: "pairing_code_mismatch" });
      return this.abort(a.clientId, "pairing_code_mismatch", false);
    }
    if (a.method === "dynamic_pairing_code") {
      // 依次验:nonce 开示 → commitment → 码绑定。
      const wnb = typeof payload?.wrapped_nonce_B === "string" ? payload.wrapped_nonce_B : "";
      let nonceB: Uint8Array | null = null;
      try {
        const k = wrapKey(WRAP_NONCE_LABEL, this.pakeSid(conn, a), a.cpace.getISK());
        const ct = b64urlDecode(wnb);
        nonceB = aeadOpen(suiteKey(conn.suiteName()), k, ct);
      } catch { /* fallthrough → protocol error */ }
      if (!nonceB || nonceB.length !== 32 || !a.nonceA || !a.commitB) {
        try { conn.close(); } catch { /* ignore */ }
        this.finishAttempt(a.clientId);
        return;
      }
      const commit = sha256(new Uint8Array([...new TextEncoder().encode(COMMIT_LABEL), ...nonceB]));
      if (!timingEq(commit, a.commitB)) {
        try { conn.close(); } catch { /* ignore */ }
        this.finishAttempt(a.clientId);
        return;
      }
      const h = conn.noise?.handshakeHash;
      if (!h || deriveDynamicCode(h, a.nonceA, nonceB) !== a.code) {
        conn.sendJson("pair/abort", { reason: "pairing_code_mismatch" });
        return this.abort(a.clientId, "pairing_code_mismatch", false);
      }
    } else if (a.method === "static_pairing_code") {
      a.gate.failures = 0; // 成功清零
    }
    // 等 finalize(可能已缓存)。
    if (a.pendingFinalize) {
      const f = a.pendingFinalize;
      a.pendingFinalize = undefined;
      await this.onPairFinalize(a, conn, f);
    }
  }

  private async onPairFinalize(a: Attempt, conn: SendspinConnection, payload: any): Promise<void> {
    // pairing-psk 流无 PAKE 轮:finalize 即 attempt 本体,直接处理。
    if (a.method === "pairing_psk") {
      const lt = typeof payload?.long_term_psk === "string" ? payload.long_term_psk : "";
      let pskHex: string;
      try {
        const raw = b64urlDecode(lt);
        if (raw.length !== 32) throw new Error("bad len");
        pskHex = Buffer.from(raw).toString("hex");
      } catch {
        return this.abort(a.clientId, "protocol_error", false);
      }
      await this.store.putRecord(a.clientId, pskHex);
      conn.sendJson("server/pair-finalize", {});
      this.server.log("info", `pairing done: ${a.clientId} method=pairing_psk,配对记录已落盘`);
      this.finishAttempt(a.clientId);
      try {
        await conn.rehandshakeTo(pskHex, "lt");
      } catch (e) {
        this.server.log("warn", `re-handshake failed: ${a.clientId},等客户端重连 (${String((e as Error)?.message || e)})`);
      }
      return;
    }
    // confirm 还没处理完(finalize 先到):缓存。
    if (a.state !== "await_confirm" || !a.cpace) {
      if (a.state === "await_confirm") a.pendingFinalize = payload;
      return;
    }
    let pskHex: string | null = null;
    {
      const w = typeof payload?.wrapped_psk === "string" ? payload.wrapped_psk : "";
      try {
        const k = wrapKey(WRAP_PSK_LABEL, this.pakeSid(conn, a), a.cpace.getISK());
        const raw = aeadOpen(suiteKey(conn.suiteName()), k, b64urlDecode(w));
        if (!raw || raw.length !== 32) throw new Error("bad unwrap");
        pskHex = Buffer.from(raw).toString("hex");
      } catch {
        return this.abort(a.clientId, "protocol_error", false);
      }
    }
    await this.store.putRecord(a.clientId, pskHex);
    conn.sendJson("server/pair-finalize", {});
    this.server.log("info", `pairing done: ${a.clientId} method=${a.method},配对记录已落盘`);
    const method = a.method;
    this.finishAttempt(a.clientId);
    // 提到长配对 PSK(带内 re-handshake),随后恢复 playback 激活。
    try {
      await conn.rehandshakeTo(pskHex, "lt");
    } catch (e) {
      this.server.log("warn", `re-handshake failed: ${a.clientId},等客户端重连 (${String((e as Error)?.message || e)})`);
      return;
    }
    this.server.log("info", `pairing promoted: ${a.clientId} method=${method}`);
  }
}

function timingEq(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}
