// ==================== CPACE-X25519-SHA512 ====================
//
// draft-irtf-cfrg-cpace 密码学 PAKE,供 sendspin 配对码流程(static/dynamic)使用。
// 逐字节移植自官方 Python `cpace` 包(CPace/CPaceError/CPaceRole),与 aiosendspin
// 的 run_static_pin_server/run_dynamic_pin_server 互操作。移植对照见 cpace.test.ts
// (固定向量与 Python 端输出一致)。
//
// 要点:
//   - 生成元:SHA-512(LV(DSI,PRS,zeropad,CI,sid))[:32] → 掩顶位 → Elligator2;
//   - 标量乘:运行时走 noble X25519;低阶点用自研 Montgomery ladder 做 [8]P 检测
//     (cryptography 解码即拒小阶点,此处等价实现);
//   - MCF 标签:HMAC-SHA-512;_sides[0] 恒为 initiator 侧(Ya,ADa)。
import { randomBytes } from "node:crypto";
import { x25519 } from "@noble/curves/ed25519.js";
import { sha512 } from "@noble/hashes/sha512.js";
import { sha256 } from "@noble/hashes/sha256.js";
import { hmac } from "@noble/hashes/hmac.js";
import { chacha20poly1305 } from "@noble/ciphers/chacha.js";
import { gcm } from "@noble/ciphers/aes.js";

const Q = 2n ** 255n - 19n;
const A = 486662n;
const Z = 2n;
const FIELD_BYTES = 32;
const SHARE_SIZE = 32;
const DSI = new TextEncoder().encode("CPace255");
const DSI_ISK = new TextEncoder().encode("CPace255_ISK");
const MAC_LABEL = new TextEncoder().encode("CPaceMac");
const SID_OUTPUT_LABEL = new TextEncoder().encode("CPaceSidOutput");
const SHA512_BLOCK_BYTES = 128;
const INV2 = modInv(2n);
const LEGENDRE_POWER = (Q - 1n) / 2n;

export class CPaceError extends Error {}

export type CPaceRole = "initiator" | "responder";

function modPow(base: bigint, exp: bigint): bigint {
  let r = 1n;
  let b = ((base % Q) + Q) % Q;
  let e = exp;
  while (e > 0n) {
    if (e & 1n) r = (r * b) % Q;
    b = (b * b) % Q;
    e >>= 1n;
  }
  return r;
}

function modInv(x: bigint): bigint {
  return modPow(x, Q - 2n); // Fermat:0 映射到 0(RFC 9380 inv0)
}

/** LEB128/varint 长度前缀(Python _prepend_len 原样)。 */
function prependLen(data: Uint8Array): Uint8Array {
  let length = data.length;
  const out: number[] = [];
  for (;;) {
    out.push(length & 0x7f);
    length >>= 7;
    if (length === 0) break;
    out[out.length - 1] |= 0x80;
  }
  return new Uint8Array([...out, ...data]);
}

function lvCat(...parts: Uint8Array[]): Uint8Array {
  const bufs = parts.map(prependLen);
  const total = bufs.reduce((n, b) => n + b.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const b of bufs) {
    out.set(b, off);
    off += b.length;
  }
  return out;
}

function generatorString(prs: Uint8Array, ci: Uint8Array, sid: Uint8Array): Uint8Array {
  const lenZpad = Math.max(0, SHA512_BLOCK_BYTES - 1 - prependLen(prs).length - prependLen(DSI).length);
  return lvCat(DSI, prs, new Uint8Array(lenZpad), ci, sid);
}

function decodeU(value: Uint8Array): bigint {
  const b = new Uint8Array(value);
  b[31] &= 0x7f; // 255 位域:忽略顶位(RFC 7748)
  let u = 0n;
  for (let i = 31; i >= 0; i--) u = (u << 8n) | BigInt(b[i]);
  return u;
}

function elligator2(r: bigint): Uint8Array {
  r = ((r % Q) + Q) % Q;
  const v = ((-A * modInv((1n + Z * r * r) % Q)) % Q + Q) % Q;
  const eps = modPow((v * v * v + A * v * v + v) % Q, LEGENDRE_POWER);
  const x = (eps * v - ((1n - eps) * A % Q) * INV2) % Q;
  const xx = ((x % Q) + Q) % Q;
  const out = new Uint8Array(32);
  let t = xx;
  for (let i = 0; i < 32; i++) {
    out[i] = Number(t & 0xffn);
    t >>= 8n;
  }
  return out;
}

function calculateGenerator(prs: Uint8Array, ci: Uint8Array, sid: Uint8Array): Uint8Array {
  const h = sha512(generatorString(prs, ci, sid)).subarray(0, FIELD_BYTES);
  return elligator2(decodeU(h));
}

/** 自研 Montgomery ladder(X25519),仅用于低阶点检测([8]P,标量不钳制)。
 *  DH 本体走 noble(已审计);ladder 正确性由单测与 noble 交叉验证。 */
export function ladderMult(scalar: Uint8Array, u: Uint8Array): Uint8Array {
  const uInt = decodeU(u);
  let x1 = uInt;
  let x2 = 1n;
  let z2 = 0n;
  let x3 = uInt;
  let z3 = 1n;
  let swap = 0;
  for (let t = 254; t >= 0; t--) {
    const b = scalar.length > 0 ? scalar[t >> 3] ?? 0 : 0;
    const k = (b >> (t & 7)) & 1;
    swap ^= k;
    if (swap) {
      [x2, x3] = [x3, x2];
      [z2, z3] = [z3, z2];
    }
    swap = k;
    // Montgomery dbl/add(RFC 7748)
    const a = (x2 + z2) % Q, aa = (a * a) % Q;
    const b2 = (x2 - z2 + Q) % Q, bb = (b2 * b2) % Q;
    const e = (aa - bb + Q) % Q;
    const c = (x3 + z3) % Q, d = (x3 - z3 + Q) % Q;
    const da = (d * a) % Q, cb = (c * b2) % Q;
    x3 = ((da + cb) % Q) ** 2n % Q;
    z3 = (x1 * (((da - cb + Q) % Q) ** 2n % Q)) % Q;
    x2 = (aa * bb) % Q;
    z2 = (e * ((aa + ((A - 2n) / 4n) * e) % Q)) % Q;
  }
  if (swap) {
    [x2, x3] = [x3, x2];
    [z2, z3] = [z3, z2];
  }
  const out = (x2 * modInv(z2)) % Q;
  const buf = new Uint8Array(32);
  let t2 = out;
  for (let i = 0; i < 32; i++) {
    buf[i] = Number(t2 & 0xffn);
    t2 >>= 8n;
  }
  return buf;
}

function isLowOrderPoint(u: Uint8Array): boolean {
  if (u.length !== 32) return true;
  // [8]P == 单位元 ⟺ 阶整除 8(cryptography 解码拒收的正是这些点)
  const eight = new Uint8Array(32);
  eight[0] = 8;
  const r = ladderMult(eight, u);
  return r.every((b) => b === 0);
}

/** X25519 标量乘,低阶/全零结果返回 null(与 Python _scalar_mult_vfy 同语义)。 */
function scalarMultVfy(scalar: Uint8Array, point: Uint8Array): Uint8Array | null {
  if (point.length !== SHARE_SIZE) return null;
  if (isLowOrderPoint(point)) return null;
  let shared: Uint8Array;
  try {
    shared = x25519.getSharedSecret(scalar, point);
  } catch {
    return null;
  }
  if (shared.every((b) => b === 0)) return null; // RFC 7748 全零检查(此处强制)
  return shared;
}

export interface CPaceStartArgs {
  role: CPaceRole;
  prs: Uint8Array;
  sid: Uint8Array;
  ci?: Uint8Array;
  ad?: Uint8Array;
  /** 仅测试注入(固定标量做交叉向量);生产恒省略走 CSPRNG。 */
  scalar?: Uint8Array;
}

/** 一端 CPACE-X25519-SHA512 运行(含 MCF)。服务端取 initiator(A),客户端取 responder(B)。 */
export class CPace {
  readonly publicShare: Uint8Array;
  private scalar: Uint8Array | null;
  private readonly role: CPaceRole;
  private readonly sid: Uint8Array;
  private readonly ad: Uint8Array;
  private derived = false;
  private isk: Uint8Array | null = null;
  private macKey: Uint8Array | null = null;
  private sides: [[Uint8Array, Uint8Array], [Uint8Array, Uint8Array]] | null = null;

  private constructor(role: CPaceRole, sid: Uint8Array, ad: Uint8Array, scalar: Uint8Array, share: Uint8Array) {
    this.role = role;
    this.sid = sid;
    this.ad = ad;
    this.scalar = scalar;
    this.publicShare = share;
  }

  static start(args: CPaceStartArgs): CPace {
    const ci = args.ci ?? new Uint8Array(0);
    const ad = args.ad ?? new Uint8Array(0);
    const scalar = args.scalar ?? randomBytes(FIELD_BYTES);
    const share = scalarMultVfy(scalar, calculateGenerator(args.prs, ci, args.sid));
    if (!share) throw new CPaceError("generator encodes a low-order point");
    return new CPace(args.role, args.sid, ad, scalar, share);
  }

  /** 供交叉向量测试:用显式标量构造(与 Python CPace.__init__ 对应)。 */
  static fromScalar(role: CPaceRole, sid: Uint8Array, ad: Uint8Array, scalar: Uint8Array, prs: Uint8Array, ci: Uint8Array = new Uint8Array(0)): CPace {
    const share = scalarMultVfy(scalar, calculateGenerator(prs, ci, sid));
    if (!share) throw new CPaceError("generator encodes a low-order point");
    return new CPace(role, sid, ad, scalar, share);
  }

  derive(peerShare: Uint8Array, peerAd: Uint8Array = new Uint8Array(0)): void {
    if (this.scalar === null) throw new CPaceError("derive() may only be called once");
    const scalar = this.scalar;
    this.scalar = null; // 一次性:失败前先消费
    if (peerShare.length !== SHARE_SIZE) throw new CPaceError(`peer share must be ${SHARE_SIZE} bytes`);
    const shared = scalarMultVfy(scalar, peerShare);
    if (!shared) throw new CPaceError("peer share encodes a low-order point");
    const sides: [[Uint8Array, Uint8Array], [Uint8Array, Uint8Array]] =
      this.role === "initiator"
        ? [[this.publicShare, this.ad], [peerShare, peerAd]]
        : [[peerShare, peerAd], [this.publicShare, this.ad]];
    const s0 = lvCat(sides[0][0], sides[0][1]);
    const s1 = lvCat(sides[1][0], sides[1][1]);
    const transcript = new Uint8Array([...s0, ...s1]);
    this.sides = sides;
    this.isk = sha512(new Uint8Array([...lvCat(DSI_ISK, this.sid, shared), ...transcript]));
    this.macKey = sha512(new Uint8Array([...MAC_LABEL, ...this.sid, ...this.isk]));
    this.derived = true;
  }

  getISK(): Uint8Array {
    if (!this.derived || !this.isk) throw new CPaceError("derive() must be called first");
    return this.isk;
  }

  /** 本端确认标签(Ta/Tb,64B)。 */
  tag(): Uint8Array {
    return this.mac(true);
  }

  /** 校验对端标签;反射(双方 sames sides)直接 false。 */
  verify(peerTag: Uint8Array): boolean {
    if (!this.derived || !this.sides) throw new CPaceError("derive() must be called first");
    const [a, b] = this.sides;
    if (a[0].every((v, i) => v === b[0][i]) && a[1].every((v, i) => v === b[1][i])) return false;
    const want = this.mac(false);
    if (want.length !== peerTag.length) return false;
    let diff = 0;
    for (let i = 0; i < want.length; i++) diff |= want[i] ^ peerTag[i];
    return diff === 0;
  }

  private mac(own: boolean): Uint8Array {
    if (!this.derived || !this.sides || !this.macKey) throw new CPaceError("derive() must be called first");
    const idx = own === (this.role === "initiator") ? 0 : 1;
    const [share, ad] = this.sides[idx];
    return hmac(sha512, this.macKey, lvCat(share, ad));
  }
}

/** 配对 wrapping 密钥派生:K_wrap = SHA-256(label || sid || ISK)。 */
export function wrapKey(label: string, sid: Uint8Array, isk: Uint8Array): Uint8Array {
  const l = new TextEncoder().encode(label);
  return sha256(new Uint8Array([...l, ...sid, ...isk]));
}

/** AEAD 加/解密(wrapped_psk / wrapped_nonce_B,nonce 全零,空 AD)。
 *  suite 取连接协商套件(默认 chacha;AESGCM 硬件套件同样支持)。 */
export function aeadSeal(suite: "chacha" | "aesgcm", key: Uint8Array, plaintext: Uint8Array): Uint8Array {
  const nonce = new Uint8Array(12);
  if (suite === "aesgcm") return gcm(key, nonce).encrypt(plaintext);
  return chacha20poly1305(key, nonce).encrypt(plaintext);
}

export function aeadOpen(suite: "chacha" | "aesgcm", key: Uint8Array, ctAndTag: Uint8Array): Uint8Array | null {
  const nonce = new Uint8Array(12);
  try {
    if (suite === "aesgcm") return gcm(key, nonce).decrypt(ctAndTag);
    return chacha20poly1305(key, nonce).decrypt(ctAndTag);
  } catch {
    return null;
  }
}
