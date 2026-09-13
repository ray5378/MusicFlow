// CPACE-X25519-SHA512 移植正确性:固定向量与官方 Python `cpace` 包输出逐字节一致。
//
// 向量生成: cpace-0.1.0, prs=b"12345678", sid=bytes(range(32)), ci=b"",
//   scalarA=bytes(i%256), scalarB=bytes((i*7+1)%256), adA=b"server", adB=b"client"。
import { describe, it, expect } from "vitest";
import { x25519 } from "@noble/curves/ed25519.js";
import { CPace, ladderMult, wrapKey, aeadSeal, aeadOpen, CPaceError } from "./cpace.js";

const hex = (s: string) => new Uint8Array(Buffer.from(s, "hex"));
const b2h = (b: Uint8Array) => Buffer.from(b).toString("hex");

const PRS = new TextEncoder().encode("12345678");
const SID = new Uint8Array(Array.from({ length: 32 }, (_, i) => i));
const SA = new Uint8Array(Array.from({ length: 32 }, (_, i) => i % 256));
const SB = new Uint8Array(Array.from({ length: 32 }, (_, i) => (i * 7 + 1) % 256));

const SHARE_A = "6746b88b18fee501da144edfbd24756e2c55eca554366d4c5bae165a46b1717a";
const SHARE_B = "028e6548fab5c33eae70c3963eacd8822bd2b6c61340d8fa9c28754611f1451a";
const ISK = "8cd1d9c05cf875a571573871457ac427ea4f021a4262b62a9a0870c449d7ff85313b30a6289315b93c49d8d6c4013db5080561613e0774067849857198d29e86";
const TAG_A = "9c3dda9aee88197fe07d55027b128853f93f65c4bdf09638d9e5a0e6820fd24b7395930ad52f52835943dece04b2de4a271a401a477cce5a73918ae315eaf94c";
const TAG_B = "7dca5f9b44fe00fe8091900d60756e1355589e879cf473e89365ef429a3f27e8429fe8cb85b05652d6227501d5954c21aa9b153c7805f151d33cb502facd81f2";

describe("CPACE-X25519-SHA512 与官方 Python 包互操作", () => {
  it("固定标量:双方 share/ISK/确认标签与 Python 一致", () => {
    const A = CPace.fromScalar("initiator", SID, new TextEncoder().encode("server"), SA, PRS);
    const B = CPace.fromScalar("responder", SID, new TextEncoder().encode("client"), SB, PRS);
    expect(b2h(A.publicShare)).toBe(SHARE_A);
    expect(b2h(B.publicShare)).toBe(SHARE_B);
    A.derive(B.publicShare, new TextEncoder().encode("client"));
    B.derive(A.publicShare, new TextEncoder().encode("server"));
    expect(b2h(A.getISK())).toBe(ISK);
    expect(b2h(B.getISK())).toBe(ISK);
    expect(b2h(A.tag())).toBe(TAG_A);
    expect(b2h(B.tag())).toBe(TAG_B);
    expect(A.verify(B.tag())).toBe(true);
    expect(B.verify(A.tag())).toBe(true);
    // 反射/错标签拒绝
    expect(A.verify(A.tag())).toBe(false);
    expect(B.verify(hex(TAG_A).slice(0, 63))).toBe(false);
  });

  it("随机一轮:TS initiator ↔ TS responder 自洽", () => {
    const sid = new Uint8Array(32).fill(7);
    const prs = new TextEncoder().encode("87654321");
    const A = CPace.start({ role: "initiator", prs, sid, ad: new TextEncoder().encode("server") });
    const B = CPace.start({ role: "responder", prs, sid, ad: new TextEncoder().encode("client") });
    A.derive(B.publicShare, new TextEncoder().encode("client"));
    B.derive(A.publicShare, new TextEncoder().encode("server"));
    expect(A.verify(B.tag())).toBe(true);
    expect(B.verify(A.tag())).toBe(true);
    expect(b2h(A.getISK())).toBe(b2h(B.getISK()));
  });

  it("ladder 与 noble X25519 交叉一致(20 组随机向量)", () => {
    for (let i = 0; i < 20; i++) {
      // noble 内部按 RFC 7748 钳制标量;ladder 不钳制,对比前同样钳制。
      const s = new Uint8Array(x25519.utils.randomPrivateKey());
      s[0] &= 248;
      s[31] &= 127;
      s[31] |= 64;
      const p = x25519.getPublicKey(x25519.utils.randomPrivateKey());
      expect(b2h(ladderMult(s, p))).toBe(b2h(x25519.getSharedSecret(s, p)));
    }
  });

  it("低阶点拒绝:全零/小阶 share 抛错", () => {
    const A = CPace.start({ role: "initiator", prs: PRS, sid: SID });
    expect(() => A.derive(new Uint8Array(32))).toThrow(CPaceError);
    // u=1(4 阶点)同样拒绝
    const one = new Uint8Array(32);
    one[0] = 1;
    const B = CPace.start({ role: "initiator", prs: PRS, sid: SID });
    expect(() => B.derive(one)).toThrow(CPaceError);
  });

  it("wrapping 密钥派生 + AEAD roundtrip", () => {
    const sid = new Uint8Array(32).fill(3);
    const isk = new Uint8Array(64).fill(9);
    const k = wrapKey("sendspin-pair-psk-wrap-v1", sid, isk);
    expect(k.length).toBe(32);
    const pt = new Uint8Array(32).fill(0xab);
    for (const suite of ["chacha", "aesgcm"] as const) {
      const ct = aeadSeal(suite, k, pt);
      expect(ct.length).toBe(48);
      expect(aeadOpen(suite, k, ct)).toEqual(pt);
      const bad = new Uint8Array(ct);
      bad[0] ^= 1;
      expect(aeadOpen(suite, k, bad)).toBeNull();
    }
  });
});
