// ==================== HAP 密码学原语封装（Phase 6b 批 1）====================
//
// 全部基于 Node 内置 crypto（Ed25519/X25519/HKDF/ChaCha20-Poly1305）。
// raw 32B 密钥与 Node KeyObject 之间的 DER 包装前缀（固定常量，RFC 8410）：
//   Ed25519 PKCS8: 302e020100300506032b657004220420 + seed
//   Ed25519 SPKI : 302a300506032b6570032100 + pub
//   X25519  PKCS8: 302e020100300506032b656e04220420 + priv
//   X25519  SPKI : 302a300506032b656e032100 + pub
//
// ⚠️ 6a 契约 controllerLTSK（64B/128hex）的内部布局定案：**seed(32B) ++ pub(32B)**。
//   （pkcs8 只有 48B，64B 唯一自洽布局是 seed||pub，pub 可由 seed 推导校验。）
// 密钥值不落日志；校验一律常量时间。
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createPrivateKey,
  createPublicKey,
  diffieHellman,
  generateKeyPairSync,
  hkdfSync,
  randomBytes,
  sign as nodeSign,
  timingSafeEqual,
  verify as nodeVerify,
  type KeyObject,
} from "node:crypto";

export class HapCryptoError extends Error {}

const ED25519_PKCS8_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");
const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");
const X25519_PKCS8_PREFIX = Buffer.from("302e020100300506032b656e04220420", "hex");
const X25519_SPKI_PREFIX = Buffer.from("302a300506032b656e032100", "hex");

function assertRaw(buf: Buffer, len: number, what: string): Buffer {
  if (!Buffer.isBuffer(buf) || buf.length !== len) {
    throw new HapCryptoError(`${what} 必须是 ${len} 字节 raw，实际 ${buf?.length}`);
  }
  return buf;
}

/** raw 32B seed → Ed25519 签名私钥。 */
export function ed25519KeyFromSeed(seed: Buffer): KeyObject {
  assertRaw(seed, 32, "ed25519 seed");
  return createPrivateKey({
    key: Buffer.concat([ED25519_PKCS8_PREFIX, seed]),
    format: "der",
    type: "pkcs8",
  });
}

/** raw 32B → Ed25519 验签公钥。 */
export function ed25519KeyFromRaw(raw: Buffer): KeyObject {
  assertRaw(raw, 32, "ed25519 public key");
  return createPublicKey({ key: Buffer.concat([ED25519_SPKI_PREFIX, raw]), format: "der", type: "spki" });
}

/** Ed25519 签名（raw 64B）。 */
export function ed25519Sign(seed: Buffer, data: Buffer): Buffer {
  return nodeSign(null, data, ed25519KeyFromSeed(seed));
}

/** Ed25519 验签（raw pub + raw sig 64B）。 */
export function ed25519Verify(rawPub: Buffer, data: Buffer, sig: Buffer): boolean {
  try {
    return nodeVerify(null, data, ed25519KeyFromRaw(rawPub), sig);
  } catch {
    return false;
  }
}

/** Ed25519 raw 公钥（由 seed 推导）。 */
export function ed25519RawPublic(seed: Buffer): Buffer {
  const pub = createPublicKey(ed25519KeyFromSeed(seed));
  const der = pub.export({ format: "der", type: "spki" }) as Buffer;
  assertRaw(der, 44, "ed25519 spki der");
  return der.subarray(12);
}

/** 生成 Ed25519 keypair，返回 raw seed。 */
export function ed25519GenerateSeed(): Buffer {
  const { privateKey } = generateKeyPairSync("ed25519");
  const der = privateKey.export({ format: "der", type: "pkcs8" }) as Buffer;
  assertRaw(der, 48, "ed25519 pkcs8 der");
  return der.subarray(16);
}

/** raw 32B → X25519 私钥。 */
export function x25519KeyFromRaw(raw: Buffer): KeyObject {
  assertRaw(raw, 32, "x25519 private key");
  return createPrivateKey({
    key: Buffer.concat([X25519_PKCS8_PREFIX, raw]),
    format: "der",
    type: "pkcs8",
  });
}

/** raw 32B → X25519 公钥。 */
export function x25519PubKeyFromRaw(raw: Buffer): KeyObject {
  assertRaw(raw, 32, "x25519 public key");
  return createPublicKey({ key: Buffer.concat([X25519_SPKI_PREFIX, raw]), format: "der", type: "spki" });
}

/** 生成随机 X25519 keypair（raw）。 */
export function x25519Generate(): { privateKey: Buffer; publicKey: Buffer } {
  const { privateKey, publicKey } = generateKeyPairSync("x25519");
  const privDer = privateKey.export({ format: "der", type: "pkcs8" }) as Buffer;
  const pubDer = publicKey.export({ format: "der", type: "spki" }) as Buffer;
  assertRaw(privDer, 48, "x25519 pkcs8");
  assertRaw(pubDer, 44, "x25519 spki");
  return { privateKey: privDer.subarray(16), publicKey: pubDer.subarray(12) };
}

/** 由 raw 私钥推导 X25519 raw 公钥。 */
export function x25519RawPublic(privRaw: Buffer): Buffer {
  const pub = createPublicKey(x25519KeyFromRaw(privRaw));
  const der = pub.export({ format: "der", type: "spki" }) as Buffer;
  assertRaw(der, 44, "x25519 spki der");
  return der.subarray(12);
}

/** X25519 ECDH（raw in，raw 32B shared out）。 */
export function x25519Shared(myPrivRaw: Buffer, theirPubRaw: Buffer): Buffer {
  const shared = diffieHellman({
    privateKey: x25519KeyFromRaw(myPrivRaw),
    publicKey: x25519PubKeyFromRaw(theirPubRaw),
  });
  assertRaw(shared, 32, "x25519 shared secret");
  return shared;
}

/** HKDF-SHA-512（HAP 全线使用）。 */
export function hkdfSha512(ikm: Buffer, salt: Buffer, info: Buffer, length: number): Buffer {
  return Buffer.from(hkdfSync("sha512", ikm, salt, info, length));
}

/** ChaCha20-Poly1305 加密，16B tag 追加在密文尾部（HAP wire 格式）。 */
export function chachaEncrypt(key: Buffer, nonce: Buffer, plain: Buffer): Buffer {
  if (key.length !== 32) throw new HapCryptoError(`chacha key 必须 32B，实际 ${key.length}`);
  if (nonce.length !== 12) throw new HapCryptoError(`chacha nonce 必须 12B，实际 ${nonce.length}`);
  const cipher = createCipheriv("chacha20-poly1305", key, nonce, { authTagLength: 16 });
  return Buffer.concat([cipher.update(plain), cipher.final(), cipher.getAuthTag()]);
}

/** ChaCha20-Poly1305 解密（密文尾部 16B tag）。失败返回 null（不区分 tag/解密错）。 */
export function chachaDecrypt(key: Buffer, nonce: Buffer, enc: Buffer): Buffer | null {
  if (enc.length < 16) return null;
  const cipher = createDecipheriv("chacha20-poly1305", key, nonce, { authTagLength: 16 });
  cipher.setAuthTag(enc.subarray(enc.length - 16));
  try {
    return Buffer.concat([cipher.update(enc.subarray(0, enc.length - 16)), cipher.final()]);
  } catch {
    return null;
  }
}

/** 常量时间比较（长度不同直接 false）。 */
export function constantTimeEqual(a: Buffer, b: Buffer): boolean {
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/** SHA-512 摘要。 */
export function sha512(data: Buffer): Buffer {
  return createHash("sha512").update(data).digest();
}

/** 6a 契约：controllerLTSK 64B = seed(32B) ++ pub(32B)。解析时校验 pub 推导一致。 */
export function controllerLtskFromStorage(stored: Buffer): { seed: Buffer; publicKey: Buffer } {
  assertRaw(stored, 64, "controllerLTSK");
  const seed = stored.subarray(0, 32);
  const pub = stored.subarray(32);
  const derived = ed25519RawPublic(seed);
  if (!constantTimeEqual(derived, pub)) {
    throw new HapCryptoError("controllerLTSK 校验失败: 存储 pub 与 seed 推导不一致");
  }
  return { seed, publicKey: pub };
}

/** 组装 6a 存储 64B（seed ++ pub）。 */
export function controllerLtskToStorage(seed: Buffer): Buffer {
  return Buffer.concat([seed, ed25519RawPublic(seed)]);
}

/** 随机 32B。 */
export function random32(): Buffer {
  return randomBytes(32);
}
