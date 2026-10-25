// ==================== SRP-6a 客户端（HAP Pair-Setup，Phase 6b 批 1）====================
//
// 与对端 /tmp/ap2recv/ap2/pairing/srp.py（accessory 侧）逐字对齐的 **controller 侧**实现：
//   - 群组：RFC 5054 3072-bit；g=5；哈希 SHA-512。
//   - ⚠️ 对端 H() 的怪癖必须精确复刻：所有 int 先转**最小长度**大端字节串；
//     仅当调用带 pad=True（k、u 两处）才左补零到 384B；digest 走 hexdigest→int。
//       k = H(N, g, pad=True)
//       x = H(s, H("user:pass"))                      # 两层都是 digest→int
//       u = H(A, B, pad=True)
//       S(server) = (A · v^u)^b；S(client) = (B − k·v^u)^(a+u·x)
//       K = H(S)                                      # 无 pad，digest→int
//       M1 = H( H(N)^H(g), username, s, A, B, K )     # 全部最小字节串
//       M2 = H( A, M1, K )
// 纯函数 + bigint；密钥（sessionKey）只经 getter 出口，禁止落日志。
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

/** RFC 5054 3072-bit 群组素数。保留 srp.py 的分组原文逐字拷贝 + 运行时去空白，
 *  避免手工拼接抄错位（N 错一位 = 全部校验崩溃）。 */
const SRP_GROUP_N_GROUPED = `
FFFFFFFF FFFFFFFF C90FDAA2 2168C234 C4C6628B 80DC1CD1 29024E08
8A67CC74 020BBEA6 3B139B22 514A0879 8E3404DD EF9519B3 CD3A431B
302B0A6D F25F1437 4FE1356D 6D51C245 E485B576 625E7EC6 F44C42E9
A637ED6B 0BFF5CB6 F406B7ED EE386BFB 5A899FA5 AE9F2411 7C4B1FE6
49286651 ECE45B3D C2007CB8 A163BF05 98DA4836 1C55D39A 69163FA8
FD24CF5F 83655D23 DCA3AD96 1C62F356 208552BB 9ED52907 7096966D
670C354E 4ABC9804 F1746C08 CA18217C 32905E46 2E36CE3B E39E772C
180E8603 9B2783A2 EC07A28F B5C55DF0 6F4C52C9 DE2BCBF6 95581718
3995497C EA956AE5 15D22618 98FA0510 15728E5A 8AAAC42D AD33170D
04507A33 A85521AB DF1CBA64 ECFB8504 58DBEF0A 8AEA7157 5D060C7D
B3970F85 A6E1E4C7 ABF5AE8C DB0933D7 1E8C94E0 4A25619D CEE3D226
1AD2EE6B F12FFA06 D98A0864 D8760273 3EC86A64 521F2B18 177B200C
BBE11757 7A615D6C 770988C0 BAD946E2 08E24FA0 74E5AB31 43DB5BFC
E0FD108E 4B82D120 A93AD2CA FFFFFFFF FFFFFFFF`;
const N = BigInt("0x" + SRP_GROUP_N_GROUPED.replace(/\s+/g, ""));
const G = 5n;
/** PAD_L = N 的字节长度（384）。 */
const PAD_L = 384;

export class SrpAuthError extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = "SrpAuthError";
  }
}

/** 最小长度大端字节串（srp.py to_bytes）。 */
export function bigintToMinBytes(v: bigint): Buffer {
  if (v < 0n) throw new SrpAuthError("负数无最小字节串表示");
  if (v === 0n) return Buffer.from([0]);
  const hex = v.toString(16);
  const padded = hex.length % 2 === 0 ? hex : "0" + hex;
  return Buffer.from(padded, "hex");
}

function leftPad(b: Buffer, len: number): Buffer {
  if (b.length > len) throw new SrpAuthError(`左填充溢出: ${b.length} > ${len}`);
  if (b.length === len) return b;
  return Buffer.concat([Buffer.alloc(len - b.length, 0), b]);
}

function modPow(base: bigint, exp: bigint, mod: bigint): bigint {
  let result = 1n;
  let b = base % mod;
  let e = exp;
  while (e > 0n) {
    if (e & 1n) result = (result * b) % mod;
    b = (b * b) % mod;
    e >>= 1n;
  }
  return result;
}

type HashArg = bigint | Buffer | string;

/** 复刻 srp.py H(*args, sep=b'', pad)：int→最小字节串（可选 pad），str→utf8，digest→int。 */
function H(args: readonly HashArg[], pad = false): bigint {
  const bufs = args.map((a) => {
    const raw =
      typeof a === "bigint" ? bigintToMinBytes(a) : typeof a === "string" ? Buffer.from(a, "utf8") : Buffer.from(a);
    return pad ? leftPad(raw, PAD_L) : raw;
  });
  const digest = createHash("sha512").update(Buffer.concat(bufs)).digest();
  return BigInt("0x" + digest.toString("hex"));
}

/** HAP SRP-6a controller（client）。
 *  生命周期：new（固定 a）→ start(salt, serverPublic) → 读 clientPublic/proof →
 *  verifyServerProof(...) → sessionKey。 */
export class SrpClient {
  private readonly username: string;
  private readonly password: string;
  private readonly a: bigint;
  private readonly A: bigint;
  private saltInt: bigint | null = null;
  private serverB: bigint | null = null;
  private sessionK: bigint | null = null;
  private clientM1: bigint | null = null;

  constructor(username: string, password: string, opts?: { clientSecret?: bigint }) {
    this.username = username;
    this.password = password;
    // 512-bit 私钥（srp.py RANDOM_BITS），限定 < N。
    const raw =
      opts?.clientSecret !== undefined
        ? opts.clientSecret
        : BigInt("0x" + randomBytes(64).toString("hex")) % N;
    this.a = raw % N;
    this.A = modPow(G, this.a, N);
  }

  /** 收到 M2（salt + B）后调用：推导会话密钥与 client proof。
   *  B ≡ 0 (mod N) 或 B < k·v^u 属于恶意/损坏对端 → 抛 SrpAuthError。 */
  start(salt: Buffer, serverPublic: Buffer): void {
    if (salt.length === 0 || salt.length > PAD_L) throw new SrpAuthError("salt 长度非法");
    const s = BigInt("0x" + salt.toString("hex"));
    const B = BigInt("0x" + serverPublic.toString("hex"));
    if (B % N === 0n) throw new SrpAuthError("server public B ≡ 0");
    this.saltInt = s;
    this.serverB = B;

    const k = H([N, G], true);
    // x = H(s, H("user:pass")) —— 两层 digest→int，均为最小字节串参与外层哈希。
    const inner = H([`${this.username}:${this.password}`]);
    const x = H([s, inner]);
    const v = modPow(G, x, N);
    const u = H([this.A, B], true);
    // S = (B − k·v)^(a + u·x) mod N —— RFC 5054 client 公式：减 k·v（**不是** k·v^u，
    // 与 server 侧 (A·v^u)^b = g^(b(a+ux)) 恒等）。⚠️ JS % 保留被除数符号，
    // B − k·v 可为负，必须归一到正剩余域（python pow 的模语义是正剩余域）。
    const base = (((B - k * v) % N) + N) % N;
    if (base === 0n) throw new SrpAuthError("SRP 预主密钥基为 0（对端 B 无效）");
    const exp = ((this.a + u * x) % (N - 1n) + (N - 1n)) % (N - 1n);
    const S = modPow(base, exp, N);
    this.sessionK = H([S]);
    const hN = H([N]);
    const hG = H([G]);
    // ⚠️ 对端公式逐字对齐：username 是先 H(username)（digest→int→min bytes）再参与外层。
    this.clientM1 = H([(hN ^ hG), H([this.username]), s, this.A, B, this.sessionK]);
  }

  /** client 公钥 A（wire 最小字节串）。 */
  get clientPublic(): Buffer {
    return bigintToMinBytes(this.A);
  }

  /** client proof M1（wire 最小字节串）。 */
  get proof(): Buffer {
    if (this.clientM1 === null) throw new SrpAuthError("start() 未调用");
    return bigintToMinBytes(this.clientM1);
  }

  /** 校验 server proof M2 = H(A, M1, K)。常量时间比较。 */
  verifyServerProof(serverProof: Buffer): boolean {
    if (this.sessionK === null || this.clientM1 === null) throw new SrpAuthError("start() 未调用");
    const expected = bigintToMinBytes(H([this.A, this.clientM1, this.sessionK]));
    const a = Buffer.from(serverProof);
    // 长度不同直接 false（时序差异不泄漏 K 相关信息）。
    if (a.length !== expected.length) return false;
    return timingSafeEqual(a, expected);
  }

  /** SRP 会话密钥 K（最小字节串，64B）。仅派生 HKDF 用，禁止日志。 */
  get sessionKey(): Buffer {
    if (this.sessionK === null) throw new SrpAuthError("start() 未调用");
    return bigintToMinBytes(this.sessionK);
  }
}
