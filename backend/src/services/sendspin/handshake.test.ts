import { describe, it, expect } from "vitest";
import { x25519 } from "@noble/curves/ed25519";
import { asInitiator, asResponder, type NoiseSession } from "./handshake.js";
import { SENTINEL_PSK_HEX } from "./constants.js";

const psk = Buffer.from(SENTINEL_PSK_HEX, "hex");
// 自环测试用任意固定 prologue(与线上 client/init+server/init 拼接无关)。
const PROLOGUE = "prologue";

/** 双方用同一套 code 自环,验证 KKpsk2 协商 + 传输加解密全对。 */
describe("sendspin handshake roundtrip", () => {
  it("initiator<->responder 完整协商并加解密", () => {
    const initPriv = x25519.utils.randomSecretKey();
    const initPub = x25519.getPublicKey(initPriv);
    const respPriv = x25519.utils.randomSecretKey();
    const respPub = x25519.getPublicKey(respPriv);

    const pro = new TextEncoder().encode(PROLOGUE);
    const initiator: NoiseSession = asInitiator({
      suite: "25519_ChaChaPoly_SHA256",
      localStaticPriv: initPriv,
      remoteStaticPub: respPub,
      prologue: pro,
      psk,
    });
    const responder: NoiseSession = asResponder({
      suite: "25519_ChaChaPoly_SHA256",
      localStaticPriv: respPriv,
      remoteStaticPub: initPub,
      prologue: pro,
      psk,
    });

    // initiator → msg1 (payload: init JSON)
    const payload1 = new TextEncoder().encode(
      JSON.stringify({ client_id: null, server_id: "initiator" }),
    );
    const msg1 = initiator.writeMessage(payload1);
    // responder 读 msg1
    const got1 = responder.readMessage(msg1);
    expect(JSON.parse(Buffer.from(got1).toString("utf8")).server_id).toBe("initiator");

    // responder → msg2 (payload: roles)
    const payload2 = new TextEncoder().encode(
      JSON.stringify({ roles: ["player@v1"], client_id: "resp-1", name: "Player1" }),
    );
    const msg2 = responder.writeMessage(payload2);
    const got2 = initiator.readMessage(msg2);
    const hello = JSON.parse(Buffer.from(got2).toString("utf8"));
    expect(hello.roles).toContain("player@v1");

    // 双方进入传输态,加解密双向互通
    expect(initiator.handshakeComplete).toBe(true);
    expect(responder.handshakeComplete).toBe(true);

    const ct = initiator.encrypt(new TextEncoder().encode("audio-frame-1"));
    expect(Buffer.from(responder.decrypt(ct)).toString("utf8")).toBe("audio-frame-1");

    const back = responder.encrypt(new TextEncoder().encode("server-hello"));
    expect(Buffer.from(initiator.decrypt(back)).toString("utf8")).toBe("server-hello");
  });
});