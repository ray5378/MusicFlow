// ==================== Noise KKpsk2 handshake (Sendspin variant) ====================
//
// Byte-for-byte mirror of the reference `aiosendspin/noise/session.py` stack —
// the `noiseprotocol` Python library (module `noise`) with handshake pattern
// `Noise_KKpsk2_25519_<ChaChaPoly|AESGCM>_SHA256`.
//
// Two Sendspin-specific deviations, copied faithfully so we interoperate:
//   1. At every `e` token (write AND read) of a *_psk* handshake, after
//      MixHash(e.pub) the library ALSO does MixKey(e.pub).
//   2. `mix_key_and_hash` (used at the `psk` token) derives `num_outputs=3`
//      and uses output2 as the hash-to-mix and output3 as the new key.
//
// The server plays the Noise **initiator** (writes msg1, reads msg2) with the
// client's static public key pre-shared (`rs`) and the pairing PSK known
// up-front — exactly like aiosendspin's `NoiseSession.as_initiator`.

import { x25519 } from "@noble/curves/ed25519";
import { sha256 } from "@noble/hashes/sha256";
import { hmac } from "@noble/hashes/hmac";
import { chacha20poly1305 } from "@noble/ciphers/chacha.js";
import { aes256gcm } from "@noble/ciphers/aes.js";
import { bytesToHex } from "./util.js";
import { SENTINEL_PSK_HEX, SENTINEL_PSK_ID_HEX } from "./constants.js";

export type NoiseSuite = "25519_ChaChaPoly_SHA256" | "25519_AESGCM_SHA256";

export const NOISE_SUITES: readonly NoiseSuite[] = Object.freeze([
  "25519_ChaChaPoly_SHA256",
  "25519_AESGCM_SHA256",
]);

const HASHLEN = 32;
const PKLEN = 32;
const TAGLEN = 16;
const NONCELEN = 12;

// ---- token constants ----
const TOK_E = "e";
const TOK_S = "s";
const TOK_ES = "es";
const TOK_EE = "ee";
const TOK_SE = "se";
const TOK_SS = "ss";
const TOK_PSK = "psk";

const xxconcat = (...arrs: Uint8Array[]): Uint8Array => {
  let len = 0;
  for (const a of arrs) len += a.length;
  const out = new Uint8Array(len);
  let o = 0;
  for (const a of arrs) {
    out.set(a, o);
    o += a.length;
  }
  return out;
};

/** NKHDF per the reference library: HMAC-HASH chaining, no separate salt,
 *  chaining_key plays the HMAC key role. */
function noiseHkdf(ck: Uint8Array, ikm: Uint8Array, num: 2 | 3): Uint8Array[] {
  const temp = hmac(sha256, ck, ikm);
  const o1 = hmac(sha256, temp, Uint8Array.of(0x01));
  const o2 = hmac(sha256, temp, xxconcat(o1, Uint8Array.of(0x02)));
  if (num === 2) return [o1, o2];
  const o3 = hmac(sha256, temp, xxconcat(o2, Uint8Array.of(0x03)));
  return [o1, o2, o3];
}

/** 12-byte AEAD nonce. AESGCM: 4 zero bytes + 8-byte big-endian counter.
 *  ChaCha: 4 zero bytes + 8-byte little-endian counter (mirrors the library). */
function nonceTo12(n: number, suite: NoiseSuite): Uint8Array {
  const out = new Uint8Array(NONCELEN);
  const big = suite === "25519_AESGCM_SHA256";
  let v = n;
  const bytes = new Uint8Array(8);
  for (let i = 0; i < 8; i++) {
    bytes[i] = v & 0xff;
    v = Math.floor(v / 256);
  }
  if (big) {
    for (let i = 0; i < 8; i++) out[8 + i] = bytes[7 - i];
  } else {
    out.set(bytes, 8);
  }
  return out;
}

function seal(suite: NoiseSuite, key: Uint8Array, nonce: Uint8Array, ad: Uint8Array, pt: Uint8Array): Uint8Array {
  const c = suite === "25519_ChaChaPoly_SHA256" ? chacha20poly1305(key, nonce, ad) : aes256gcm(key, nonce, ad);
  return c.encrypt(pt);
}

function open(suite: NoiseSuite, key: Uint8Array, nonce: Uint8Array, ad: Uint8Array, ct: Uint8Array): Uint8Array {
  const c = suite === "25519_ChaChaPoly_SHA256" ? chacha20poly1305(key, nonce, ad) : aes256gcm(key, nonce, ad);
  return c.decrypt(ct);
}

/** CipherState — spec §5.1. */
export class CipherState {
  k: Uint8Array | null = null;
  n = 0;
  constructor(private readonly suite: NoiseSuite) {}

  hasKey(): boolean {
    return this.k !== null;
  }

  initializeKey(key: Uint8Array): void {
    this.k = key;
    this.n = 0;
  }

  encryptWithAd(ad: Uint8Array, plaintext: Uint8Array): Uint8Array {
    if (!this.k) return plaintext;
    const ct = seal(this.suite, this.k, nonceTo12(this.n, this.suite), ad, plaintext);
    this.n += 1;
    return ct;
  }

  decryptWithAd(ad: Uint8Array, ciphertext: Uint8Array): Uint8Array {
    if (!this.k) return ciphertext;
    const pt = open(this.suite, this.k, nonceTo12(this.n, this.suite), ad, ciphertext);
    this.n += 1;
    return pt;
  }
}

/** SymmetricState — spec §5.2. */
class SymmetricState {
  h: Uint8Array;
  ck: Uint8Array;
  cs: CipherState;
  constructor(suite: NoiseSuite, protocolName: Uint8Array) {
    this.cs = new CipherState(suite);
    if (protocolName.length <= HASHLEN) {
      this.h = new Uint8Array(HASHLEN);
      this.h.set(protocolName);
    } else {
      this.h = new Uint8Array(sha256(protocolName));
    }
    this.ck = new Uint8Array(this.h);
  }

  mixHash(data: Uint8Array): void {
    this.h = new Uint8Array(sha256(xxconcat(this.h, data)));
  }

  mixKey(input: Uint8Array): void {
    const [ck, tempK] = noiseHkdf(this.ck, input, 2);
    this.ck = ck;
    this.cs.initializeKey(tempK);
  }

  mixKeyAndHash(input: Uint8Array): void {
    const [ck, tempH, tempK] = noiseHkdf(this.ck, input, 3);
    this.ck = ck;
    this.mixHash(tempH);
    this.cs.initializeKey(tempK);
  }

  encryptAndHash(plaintext: Uint8Array): Uint8Array {
    const ct = this.cs.encryptWithAd(this.h, plaintext);
    this.mixHash(ct);
    return ct;
  }

  decryptAndHash(ciphertext: Uint8Array): Uint8Array {
    const pt = this.cs.decryptWithAd(this.h, ciphertext);
    this.mixHash(ciphertext);
    return pt;
  }

  split(): [CipherState, CipherState] {
    const [k1, k2] = noiseHkdf(this.ck, new Uint8Array(0), 2);
    const c1 = new CipherState(this.cs.suite);
    const c2 = new CipherState(this.cs.suite);
    c1.initializeKey(k1);
    c2.initializeKey(k2);
    return [c1, c2];
  }
}

function toPub(priv: Uint8Array): Uint8Array {
  return x25519.getPublicKey(priv);
}

function dh(front: Uint8Array, back: Uint8Array): Uint8Array {
  return x25519.getSharedSecret(front, back);
}

/** HandshakeState — spec §5.3, replicating the reference library's token logic. */
class HandshakeState {
  private readonly ss: SymmetricState;
  private readonly initiator: boolean;
  private s: Uint8Array; // local static priv
  private sPub: Uint8Array;
  private rs: Uint8Array; // remote static pub
  private e: Uint8Array | null = null;
  private ePub: Uint8Array | null = null;
  private re: Uint8Array | null = null;
  private messagePatterns: string[][];
  private complete = false;
  private tx: CipherState | null = null;
  private rx: CipherState | null = null;

  constructor(
    suite: NoiseSuite,
    initiator: boolean,
    localStaticPriv: Uint8Array,
    remoteStaticPub: Uint8Array,
    prologue: Uint8Array,
    protocolName: Uint8Array,
  ) {
    this.initiator = initiator;
    this.s = localStaticPriv;
    this.sPub = toPub(localStaticPriv);
    this.rs = remoteStaticPub;
    this.ss = new SymmetricState(suite, protocolName);
    this.ss.mixHash(prologue);

    // pre-messages: KK pre-shares both statics. Initiator's static mixed first.
    this.ss.mixHash(this.sPub);
    this.ss.mixHash(this.rs);

    // Pattern tokens (KKpsk2, psk2 modifier appends PSK to message 2).
    this.messagePatterns = [
      [TOK_E, TOK_ES, TOK_SS],
      [TOK_E, TOK_EE, TOK_SE, TOK_PSK],
    ];
  }

  private isPsk = true; // only KKpsk* used here

  private mixPsk(psk: Uint8Array): void {
    this.ss.mixKeyAndHash(psk);
  }

  writeMessage(payload: Uint8Array): Uint8Array {
    const msg = new Uint8Array(0);
    const pattern = this.messagePatterns.shift()!;
    const out: Uint8Array[] = [];
    for (const token of pattern) {
      if (token === TOK_E) {
        this.e = this.e ?? x25519.utils.randomSecretKey();
        this.ePub = toPub(this.e);
        out.push(this.ePub);
        this.ss.mixHash(this.ePub);
        if (this.isPsk) this.ss.mixKey(this.ePub);
      } else if (token === TOK_S) {
        out.push(this.ss.encryptAndHash(this.sPub));
      } else if (token === TOK_EE) {
        this.ss.mixKey(dh(this.e!, this.re!));
      } else if (token === TOK_ES) {
        const a = this.initiator ? dh(this.e!, this.rs) : dh(this.s, this.re!);
        this.ss.mixKey(a);
      } else if (token === TOK_SE) {
        const a = this.initiator ? dh(this.s, this.re!) : dh(this.e!, this.rs);
        this.ss.mixKey(a);
      } else if (token === TOK_SS) {
        this.ss.mixKey(dh(this.s, this.rs));
      } else if (token === TOK_PSK) {
        // caller pre-mixes via setPsk below on the initiator; responder sets per-message
      }
    }
    void msg;
    out.push(this.ss.encryptAndHash(payload));
    if (this.messagePatterns.length === 0) this.finalizeSplit();
    return xxconcat(...out);
  }

  readMessage(message: Uint8Array): Uint8Array {
    let rest = new Uint8Array(message);
    const pattern = this.messagePatterns.shift()!;
    for (const token of pattern) {
      if (token === TOK_E) {
        this.re = rest.subarray(0, PKLEN);
        rest = rest.subarray(PKLEN);
        this.ss.mixHash(this.re);
        if (this.isPsk) this.ss.mixKey(this.re);
      } else if (token === TOK_S) {
        const klen = this.ss.cs.hasKey() ? PKLEN + TAGLEN : PKLEN;
        const temp = rest.subarray(0, klen);
        rest = rest.subarray(klen);
        const rsPub = this.ss.decryptAndHash(temp);
        this.rs = new Uint8Array(rsPub);
      } else if (token === TOK_EE) {
        this.ss.mixKey(dh(this.e!, this.re!));
      } else if (token === TOK_ES) {
        const a = this.initiator ? dh(this.e!, this.rs) : dh(this.s, this.re!);
        this.ss.mixKey(a);
      } else if (token === TOK_SE) {
        const a = this.initiator ? dh(this.s, this.re!) : dh(this.e!, this.rs);
        this.ss.mixKey(a);
      } else if (token === TOK_SS) {
        this.ss.mixKey(dh(this.s, this.rs));
      } else if (token === TOK_PSK) {
        // psk set via setPsk before this message is processed
      }
    }
    const payload = this.ss.decryptAndHash(rest);
    if (this.messagePatterns.length === 0) this.finalizeSplit();
    return payload;
  }

  private finalizeSplit(): void {
    const [c1, c2] = this.ss.split();
    // initiator: c1 = encrypt (tx), c2 = decrypt (rx); responder reversed.
    this.tx = this.initiator ? c1 : c2;
    this.rx = this.initiator ? c2 : c1;
    this.complete = true;
  }

  get isComplete(): boolean {
    return this.complete;
  }
  get handshakeHash(): Uint8Array {
    return this.ss.h;
  }
  get encryptState(): CipherState | null {
    return this.tx;
  }
  get decryptState(): CipherState | null {
    return this.rx;
  }
}

/** Pre-mix the PSK into the state at the psk token position for THIS step.
 *  Because psk2 mixes before the second (final) message, we inject it right
 *  before reading/writing that message. On both roles the primary PSK is
 *  supplied up-front (as the reference does for the initiator). */
function pskForStep(stepIndex: number, psk: Uint8Array | null): Uint8Array | null {
  // psk2 → mixed when stepIndex === 1 (the second message)
  return stepIndex === 1 ? psk : null;
}

// ---- public API ----

export interface NoiseSessionInputs {
  suite: NoiseSuite;
  initiator: boolean;
  localStaticPriv: Uint8Array;
  remoteStaticPub: Uint8Array;
  prologue: Uint8Array;
  psk: Uint8Array;
}

/** High-level Noise session mirroring `NoiseSession` from the reference. */
export class NoiseSession {
  private hs: HandshakeState;
  private psk: Uint8Array;
  private step = 0; // handshake message counter (0-based)
  constructor(private readonly suite: NoiseSuite, inputs: NoiseSessionInputs) {
    this.psk = inputs.psk;
    const protocolName = new TextEncoder().encode(`Noise_KKpsk2_${suite}`);
    this.hs = new HandshakeState(
      suite,
      inputs.initiator,
      inputs.localStaticPriv,
      inputs.remoteStaticPub,
      inputs.prologue,
      protocolName,
    );
  }

  /** Produce the next outgoing handshake message containing `payload`.
   *  For the server (initiator) step 0 => msg1. */
  writeMessage(payload: Uint8Array): Uint8Array {
    const step = this.step;
    this.step += 1;
    const psk = pskForStep(step, this.psk);
    if (psk) (this.hs as any).mixPsk(psk);
    return this.hs.writeMessage(payload);
  }

  /** Consume the next incoming handshake message; returns decrypted payload. */
  readMessage(ciphertext: Uint8Array): Uint8Array {
    const step = this.step;
    this.step += 1;
    const psk = pskForStep(step, this.psk);
    if (psk) (this.hs as any).mixPsk(psk);
    return this.hs.readMessage(ciphertext);
  }

  get handshakeComplete(): boolean {
    return this.hs.isComplete;
  }
  get handshakeHash(): Uint8Array {
    return this.hs.handshakeHash;
  }

  encrypt(plaintext: Uint8Array): Uint8Array {
    const cs = this.hs.encryptState;
    if (!cs) throw new Error("handshake not complete");
    return cs.encryptWithAd(new Uint8Array(0), plaintext);
  }

  decrypt(ciphertext: Uint8Array): Uint8Array {
    const cs = this.hs.decryptState;
    if (!cs) throw new Error("handshake not complete");
    return cs.decryptWithAd(new Uint8Array(0), ciphertext);
  }
}

/** Create a server-side (initiator) Noise session against a paired client. */
export function asInitiator(args: {
  suite: NoiseSuite;
  localStaticPriv: Uint8Array;
  remoteStaticPub: Uint8Array;
  prologue: Uint8Array;
  psk: Uint8Array;
}): NoiseSession {
  return new NoiseSession(args.suite, {
    suite: args.suite,
    initiator: true,
    localStaticPriv: args.localStaticPriv,
    remoteStaticPub: args.remoteStaticPub,
    prologue: args.prologue,
    psk: args.psk,
  });
}

/** The plaintext JSON payload sent as handshake msg1. */
export function handshakePayload1(pskHex: string): Uint8Array {
  const pskId = pskHex === SENTINEL_PSK_HEX ? SENTINEL_PSK_ID_HEX : "";
  return new TextEncoder().encode(
    JSON.stringify({ psk_id: pskId, psk_category: "sn" }),
  );
}