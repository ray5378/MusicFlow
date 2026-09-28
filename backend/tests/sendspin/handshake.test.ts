// ==================== Noise KKpsk2 握手核心:分支补测 ====================
//
// `sendspin/handshake.ts` 是 aiosendspin `noise/session.py` 的逐字节镜像(它 Σ 两个
// sendspin 特有偏离,详见文件头)。有专门的配对链路测试(pairServer*.test.ts)在**集成层**
// 验证「配对能成」—— 但集成层只走得到主路径的一两个分支,下面这几条仍然全黑:
//
//   · 第二套 cipher suite(AESGCM)。它不只是换个常量:AES 的 nonce 是**大端**计数器,
//     ChaCha 是**小端**(nonceTo12 的 if/else)。写错方向 AES-GCM 会直接拒签 ——
//     表现为「配对偶发失败且日志看不出原因」,是这类代码最典型的坑。
//   · protocolName 恰好 32 字节那条(SymmetricState 构造函数里的 <= HASHLEN 分叉)。
//     `Noise_KKpsk2_25519_AESGCM_SHA256` 正好 32 字符,AESGCM 一套反而是唯一走这条的。
//   · TOK_S 的写/读分支(writeMessage 的 270、readMessage 的 302-306)`测不到`:
//     KKpsk2 的两条 pattern 是 [E,ES,SS] 与 [E,EE,SE,PSK],**都不含 `s` token** ——
//     KK 模式下静态公钥本来就靠预置共享、从不在线上传(`SS` 直接用 dh(s,rs) 证明),
//     所以这五行的 `s` 分支是留给参考库全 token 循环的死代码。它对应的是 2 条
//     pattern 之外的另一种 pattern;真要覆盖只能临时改 pattern,那测的是构造出来的
//     场景而不是现网协议。已确认不覆盖,理由留档。
//   · ephemeralPriv 取回器:Sentinel Fallback 重放 msg2 时**必须复用原 e**,
//     取出的是副本(改它不影响内部状态)。
//   · handshakePayload1 的 psk_id 派生:哨兵 PSK 用固定 id,普通 PSK 用「域分隔前缀 +
//     原始字节」的 sha256 —— 客户端的 psk_resolver 就按这个 b64url 值去查表,
//     派生口径一改,所有长配对记录立刻失配。
import { describe, it, expect } from "vitest";
import { x25519 } from "@noble/curves/ed25519";
import {
  asInitiator,
  asResponder,
  CipherState,
  handshakePayload1,
  NOISE_SUITES,
  type NoiseSuite,
} from "../../src/services/sendspin/handshake.js";
import { SENTINEL_PSK_HEX } from "../../src/services/sendspin/constants.js";

const enc = new TextEncoder();
const PROLOGUE = enc.encode("musicflow");
const PSK = new Uint8Array(32).fill(0x07);

const keys = () => {
  const a = x25519.utils.randomSecretKey();
  const b = x25519.utils.randomSecretKey();
  return {
    aPriv: a,
    bPriv: b,
    aPub: x25519.getPublicKey(a),
    bPub: x25519.getPublicKey(b),
  };
};

interface Trip {
  initOut: Uint8Array;
  respIn: Uint8Array;
  respOut: Uint8Array;
  initIn: Uint8Array;
}

/** 跑完一轮 KKpsk2:发起方(服务端)写 msg1 / 读 msg2,响应方反之。 */
function handshake(suite: NoiseSuite, k = keys(), pin?: Uint8Array): Trip & { init: any; resp: any } {
  const init = asInitiator({
    suite,
    localStaticPriv: k.aPriv,
    remoteStaticPub: k.bPub,
    prologue: PROLOGUE,
    psk: PSK,
    ephemeralPriv: pin,
  });
  const resp = asResponder({
    suite,
    localStaticPriv: k.bPriv,
    remoteStaticPub: k.aPub,
    prologue: PROLOGUE,
    psk: PSK,
  });
  const initOut = init.writeMessage(handshakePayload1(SENTINEL_PSK_HEX));
  const respIn = resp.readMessage(initOut);
  const respOut = resp.writeMessage(enc.encode('{"hello":1}'));
  const initIn = init.readMessage(respOut);
  return { initOut, respIn, respOut, initIn, init, resp };
}

describe("CipherState:无密钥时的直通语义", () => {
  it("hasKey=false,加解密原样返回(NK/N 阶段靠这个不炸)", () => {
    const cs = new CipherState("25519_ChaChaPoly_SHA256");
    expect(cs.hasKey()).toBe(false);
    expect(cs.encryptWithAd(enc.encode("ad"), enc.encode("plain"))).toEqual(enc.encode("plain"));
    expect(cs.decryptWithAd(enc.encode("ad"), enc.encode("cipher"))).toEqual(enc.encode("cipher"));
  });

  it("initializeKey 后 hasKey=true 且计数从 0 起", () => {
    const cs = new CipherState("25519_AESGCM_SHA256");
    const k = new Uint8Array(32).fill(9);
    cs.initializeKey(k);
    expect(cs.hasKey()).toBe(true);
    const ad = new Uint8Array(0);
    const c1 = cs.encryptWithAd(ad, enc.encode("x"));
    const c2 = cs.encryptWithAd(ad, enc.encode("x"));
    expect(c1).not.toEqual(c2); // 计数器在走
  });
});

describe("两套 suite 的完整握手往返", () => {
  it.each(NOISE_SUITES)("%s:msg1/msg2 互通且双方派生出同一 handshakeHash", (suite) => {
    const { respIn, initIn, init, resp } = handshake(suite);
    expect(new TextDecoder().decode(respIn)).toContain("psk_id");
    expect(new TextDecoder().decode(initIn)).toBe('{"hello":1}');
    expect(init.handshakeComplete).toBe(true);
    expect(resp.handshakeComplete).toBe(true);
    expect(init.handshakeHash.length).toBe(32);
    // 双方混_hash 必须一致,否则后面加解密必错 —— 这是整套镜像的**总校验和**。
    expect(Buffer.from(resp.handshakeHash).toString("hex")).toBe(
      Buffer.from(init.handshakeHash).toString("hex"),
    );
  });

  it.each(NOISE_SUITES)("%s:握手未完成时 encrypt/decrypt 明确报错(不静默返回原样)", (suite) => {
    const k = keys();
    const init = asInitiator({ suite, localStaticPriv: k.aPriv, remoteStaticPub: k.bPub, prologue: PROLOGUE, psk: PSK });
    expect(() => init.encrypt(enc.encode("x"))).toThrow(/not complete/);
    expect(() => init.decrypt(new Uint8Array(0))).toThrow(/not complete/);
  });

  it("AESGCM 的 nonce 走大端计数器(与 ChaCha 的字节序不同)", () => {
    // 若 nonceTo12 的大端/小端分叉被写反,AES-GCM 会在收端**直接拒签**——
    // 表现为「配对偶发失败、日志只有一句 decrypt error」。所以这条必须是活的。
    const { init, resp } = handshake("25519_AESGCM_SHA256");
    const pt = enc.encode("payload");
    const ct1 = init.encrypt(pt);
    const ct2 = init.encrypt(pt);
    expect(ct1).not.toEqual(ct2);
    // 收端用同一计数器推进必须能还原,两次都要对(证明双方对计数方向的理解一致)。
    expect(Buffer.from(resp.decrypt(ct1)).toString()).toBe("payload");
    expect(Buffer.from(resp.decrypt(ct2)).toString()).toBe("payload");
  });
});

describe("ephemeralPriv:取的是副本,预置才生效", () => {
  it("两个角色的 e 都是惰性 mint:任何收发之前取回都是 null", () => {
    const k = keys();
    const init = asInitiator({
      suite: "25519_ChaChaPoly_SHA256",
      localStaticPriv: k.aPriv,
      remoteStaticPub: k.bPub,
      prologue: PROLOGUE,
      psk: PSK,
    });
    const resp = asResponder({
      suite: "25519_ChaChaPoly_SHA256",
      localStaticPriv: k.bPriv,
      remoteStaticPub: k.aPub,
      prologue: PROLOGUE,
      psk: PSK,
    });
    // e 只在轮到自己 write 含 `e` token 的那条消息时才生成 —— 读方永远不会 mint。
    expect(init.ephemeralPriv).toBeNull();
    expect(resp.ephemeralPriv).toBeNull();
    // 各自写完自己那条含 e 的消息后才有了 e,两边都是 32 字节。
    const done = handshake("25519_ChaChaPoly_SHA256", k);
    expect(done.init.ephemeralPriv!.length).toBe(32);
    expect(done.resp.ephemeralPriv!.length).toBe(32);
  });

  it("未预置时 msg1 发出后取回的是 32 字节", () => {
    const k = keys();
    const init = asInitiator({
      suite: "25519_ChaChaPoly_SHA256",
      localStaticPriv: k.aPriv,
      remoteStaticPub: k.bPub,
      prologue: PROLOGUE,
      psk: PSK,
    });
    init.writeMessage(handshakePayload1(SENTINEL_PSK_HEX));
    const e = init.ephemeralPriv;
    expect(e).not.toBeNull();
    expect(e!.length).toBe(32);
  });

  it("取出的是副本(改动它不影响内部状态,重放才不会污染)", () => {
    const { init } = handshake("25519_ChaChaPoly_SHA256");
    const e = init.ephemeralPriv!;
    e.fill(0xff);
    expect(init.ephemeralPriv).not.toEqual(e);
  });

  it("预置 ephemeral 后取回的正是它(Sentinel Fallback 复用同一 e 使 EE 对上)", () => {
    const pin = x25519.utils.randomSecretKey();
    const { init } = handshake("25519_ChaChaPoly_SHA256", keys(), pin);
    expect(Buffer.from(init.ephemeralPriv!).toString("hex")).toBe(
      Buffer.from(pin).toString("hex"),
    );
  });
});

describe("handshakePayload1:psk_id 派生", () => {
  it("哨兵 PSK → 固定 psk_id(与 SENTINEL_PSK_ID_HEX 对应)", () => {
    const b = handshakePayload1(SENTINEL_PSK_HEX.toUpperCase());
    const j = JSON.parse(new TextDecoder().decode(b));
    expect(j.psk_id).toBe("GFsV9tLaSQm9HcFWpKsgYQOr7wFTvNUtkmFwuVz3zoo");
    expect(j.psk_category).toBe("sn");
  });

  it("普通 PSK → 域分隔前缀 + 原始字节的 sha256(大小写不敏感)", () => {
    const h = "1122334455667788990011223344556677889900aabbccddeeff00112233445566";
    const j = JSON.parse(new TextDecoder().decode(handshakePayload1(h.toUpperCase())));
    expect(j.psk_id).toBe("zO6-EWXmWgH6vz3Tw51OpdKqIIe7vNUSPIm5wp-TOag");
  });

  it("psk_category 原样带出(sn 默认 / lt 长配对 / pr)", () => {
    const cats = (["sn", "lt", "pr"] as const).map((c) =>
      JSON.parse(new TextDecoder().decode(handshakePayload1(SENTINEL_PSK_HEX, c))).psk_category,
    );
    expect(cats).toEqual(["sn", "lt", "pr"]);
  });

  it("id 派生对输入大小写不敏感(PSK hex 常被记成大写)", () => {
    const h = "1122334455667788990011223344556677889900aabbccddeeff00112233445566";
    const lower = JSON.parse(new TextDecoder().decode(handshakePayload1(h))).psk_id;
    const upper = JSON.parse(new TextDecoder().decode(handshakePayload1(h.toUpperCase()))).psk_id;
    expect(lower).toBe(upper);
  });
});
