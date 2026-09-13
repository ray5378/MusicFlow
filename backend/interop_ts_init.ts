// Byte-exact interop check: TS initiator (server) vs aiosendspin `noise` responder.
import { writeFileSync, readFileSync } from "node:fs";
import { b64urlDecode, b64urlEncode, bytesToHex } from "./src/services/sendspin/util.js";
import { asInitiator } from "./src/services/sendspin/handshake.js";

const SERVER_PRIV = "cDYKnCUS7_lk738XPqieSM4IERVBo_rdcyqn2jL95k0";
const CLIENT_PUB = "3WMeYmlU8UJhepk2c46J3CBU8MRU2pRWg0OtVn6ZgmY";
const PSK = "G14k28Gu2V_CpaM4qQwF30S9EPXsH0zWbL-GJydnudM";
const PSK_ID = "GFsV9tLaSQm9HcFWpKsgYQOr7wFTvNUtkmFwuVz3zoo";

const prologue = new TextEncoder().encode("");
const session = asInitiator({
  suite: "25519_ChaChaPoly_SHA256",
  localStaticPriv: b64urlDecode(SERVER_PRIV),
  remoteStaticPub: b64urlDecode(CLIENT_PUB),
  prologue,
  psk: b64urlDecode(PSK),
});

const msg1 = session.writeMessage(new TextEncoder().encode(JSON.stringify({ psk_id: PSK_ID })));
writeFileSync("/tmp/interop_msg1.b64", b64urlEncode(msg1));
console.log("MSG1_B64", b64urlEncode(msg1));
console.log("MSG1_LEN", msg1.length);

// Wait for msg2 produced by Python responder from THIS msg1 run
const deadline = Date.now() + 20000;
let msg2b64 = null;
try { msg2b64 = readFileSync("/tmp/interop_msg2.b64", "utf8").trim(); } catch {}
while (msg2b64 === null && Date.now() < deadline) {
  await new Promise((r) => setTimeout(r, 250));
  try { msg2b64 = readFileSync("/tmp/interop_msg2.b64", "utf8").trim(); } catch {}
}
if (msg2b64 === null) { console.error("no msg2 received"); process.exit(2); }
console.log("TS_READ_MSG2");
const payload = session.readMessage(b64urlDecode(msg2b64));
const hs = session.handshakeHash;
console.log("TS_PAYLOAD_MSG2", Buffer.from(payload).toString("utf8"));
console.log("TS_HANDSHAKE_HASH_HEX", bytesToHex(hs));
writeFileSync("/tmp/interop_ts_hash.txt", bytesToHex(hs));