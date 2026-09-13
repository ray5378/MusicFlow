import { x25519 } from "@noble/curves/ed25519";
import { asInitiator, asResponder, NoiseSession } from "./src/services/sendspin/handshake.js";
import { PROLOGUE } from "./src/services/sendspin/server.js";
import { SENTINEL_PSK_HEX } from "./src/services/sendspin/constants.js";

const psk = Buffer.from(SENTINEL_PSK_HEX, "hex");
const initPriv = x25519.utils.randomSecretKey();
const initPub = x25519.getPublicKey(initPriv);
const respPriv = x25519.utils.randomSecretKey();
const respPub = x25519.getPublicKey(respPriv);
const pro = new TextEncoder().encode(PROLOGUE);

const initiator: any = asInitiator({ suite: "25519_ChaChaPoly_SHA256", localStaticPriv: initPriv, remoteStaticPub: respPub, prologue: pro, psk });
const responder: any = asResponder({ suite: "25519_ChaChaPoly_SHA256", localStaticPriv: respPriv, remoteStaticPub: initPub, prologue: pro, psk });

const ssI = initiator.hs.ss;
const ssR = responder.hs.ss;
const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");

console.log("after construct");
console.log("  init h", hex(ssI.h), "ck", hex(ssI.ck), "hasKey", ssI.cs.hasKey());
console.log("  resp h", hex(ssR.h), "ck", hex(ssR.ck), "hasKey", ssR.cs.hasKey());

// manually mix psk (step1) on both to inspect symmetry
initiator.hs.mixPsk(psk);
responder.hs.mixPsk(psk);
console.log("after psk mix");
console.log("  init h", hex(ssI.h), "ck", hex(ssI.ck), "hasKey", ssI.cs.hasKey(), "ckey", ssI.cs.k ? hex(ssI.cs.k) : "none");
console.log("  resp h", hex(ssR.h), "ck", hex(ssR.ck), "hasKey", ssR.cs.hasKey(), "ckey", ssR.cs.k ? hex(ssR.cs.k) : "none");