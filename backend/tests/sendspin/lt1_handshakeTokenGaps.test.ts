// handshake.ts 覆盖率补口:token 分派里 `s`(静态公钥)分支。
//
// ⚠️ 说明:KKpsk2 的两条消息模板是 [e,es,ss] / [e,ee,se,psk],**都不含 `s`**,
// 所以 `TOK_S` 处理分支在现行协议下不可达。之所以仍然覆盖它:这是**通用噪声 token
// 分派器**的一部分,一旦将来换 pattern(如 KK 的变体)就会立刻生效;留一份"若被调用
// 行为是否正确"的断言,比让这几行永远黑着更能防止有人顺手删除或写反。
//
// 锁定契约:
//   1) write 侧 `s` = 用当前密钥加密本地静态公钥后追加(无密钥时 = 明文 32B);
//   2) read 侧 `s` = 依 `hasKey()` 决定读 32B(明文)还是 32+16B(带 tag),解出后写入 rs。
import "../plugins/_env.js";

import { describe, it, expect } from "vitest";
import { x25519 } from "@noble/curves/ed25519";
import { asInitiator, asResponder } from "../../src/services/sendspin/handshake.js";
import { SENTINEL_PSK_HEX } from "../../src/services/sendspin/constants.js";

const SUITE = "25519_ChaChaPoly_SHA256" as const;
const psk = Buffer.from(SENTINEL_PSK_HEX, "hex");

function pair() {
  const s1 = x25519.utils.randomSecretKey();
  const s2 = x25519.utils.randomSecretKey();
  const init = asInitiator({ suite: SUITE, localStaticPriv: s1, remoteStaticPub: x25519.getPublicKey(s2), prologue: new Uint8Array(0), psk });
  const resp = asResponder({ suite: SUITE, localStaticPriv: s2, remoteStaticPub: x25519.getPublicKey(s1), prologue: new Uint8Array(0), psk });
  return { init, resp };
}

describe("HandshakeState token 分派:`s` 分支(现行 pattern 不含,防御性保留)", () => {
  it("write 侧 `s`:无密钥时把本地静态公钥以明文追加(32B + payload)", () => {
    const { init } = pair();
    const hs: any = (init as any).hs;
    hs.messagePatterns = [["s"]];
    const payload = new Uint8Array([1, 2, 3]);
    const out = init.writeMessage(payload);
    // 32B 静态公钥在前 + 3B 明文 payload(尚未 mixKey ⇒ encryptAndHash 为透传)
    expect(out.length).toBe(32 + 3);
    expect(Array.from(out.subarray(32))).toEqual([1, 2, 3]);
  });

  it("read 侧 `s`:无密钥时按 32B 明文读入并写入 rs", () => {
    const { resp } = pair();
    const hs: any = (resp as any).hs;
    hs.messagePatterns = [["s"]];
    const wire = new Uint8Array(32).fill(0x5a);
    const payload = resp.readMessage(wire);
    expect(payload.length).toBe(0); // 32B 全被 `s` 吃掉,payload 为空
    // 契约:解出的远端静态公钥必须落到 rs,后续 ss/dh 才能用它。
    expect(Array.from(hs.rs)).toEqual(Array.from(wire));
  });
});
