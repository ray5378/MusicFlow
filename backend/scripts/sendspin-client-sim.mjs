// ==================== Sendspin 忠实协议客户端(模拟真实播放器) ====================
// 扮演 Noise KKpsk2 **responder**(服务器是 initiator)。用于 P1#6 真实设备复测:
//   ws://127.0.0.1:38927/sendspin + client/init → server/init+msg1 → msg2 → client/hello
//   → server/activate → 持续收加密音频 (BIN_PLAYER_AUDIO) 并应答计时。
// 用法: node scripts/sendspin-client-sim.mjs <server_id> <psk_hex> [ws_url]
import WebSocket from "ws";
import { x25519 } from "@noble/curves/ed25519";
import { asResponder } from "../src/services/sendspin/handshake.js";
import { PROTOCOL_VERSION, BIN_JSON, BIN_PLAYER_AUDIO } from "../src/services/sendspin/constants.js";
import { b64urlEncode, b64urlDecode } from "../src/services/sendspin/util.js";
import * as framing from "../src/services/sendspin/framing.js";

const serverId = process.argv[2];
const pskHex = process.argv[3];
const WS_URL = process.argv[4] ?? "ws://127.0.0.1:38927/sendspin";
if (!serverId || !pskHex) { console.error("usage: node sendspin-client-sim.mjs <server_id> <psk_hex> [ws_url]"); process.exit(1); }

const serverPub = b64urlDecode(serverId);
const psk = Buffer.from(pskHex, "hex");
const clientPriv = x25519.utils.randomSecretKey();
const clientPub = x25519.getPublicKey(clientPriv);
const clientId = b64urlEncode(clientPub);
const name = "sim-speaker-" + clientId.slice(0, 8);

console.log(`[client] connecting ${WS_URL} server_id=${serverId.slice(0, 12)}... name=${name}`);

const ws = new WebSocket(WS_URL);
let noise = null;
let phase = 0; // 0 init sent, 1 await msg2 send
let clientInitText = "";
let serverInitText = "";
let activated = false;
let received = { audioChunks: 0, jsonMsgs: 0 };

function sendCleartext(obj) {
  ws.send(JSON.stringify(obj));
}
function sendEncryptedBody(body) {
  if (!noise) return;
  try { ws.send(Buffer.from(noise.encrypt(body))); } catch (e) { console.error("[client] encrypt fail", e.message); }
}
function replyJson(type, payload) {
  sendEncryptedBody(framing.packJsonBody({ type, payload: payload ?? {} }));
}

ws.on("open", () => {
  const payload = { version: PROTOCOL_VERSION, suite: "25519_ChaChaPoly_SHA256", client_id: clientId };
  clientInitText = JSON.stringify({ type: "client/init", payload });
  sendCleartext({ type: "client/init", payload });
  console.log("[client] sent client/init", JSON.stringify(payload));
});

ws.on("message", (data, isBinary) => {
  if (!isBinary) {
    const text = data.toString("utf8");
    let msg; try { msg = JSON.parse(text); } catch { console.error("[client] bad cleartext", text.slice(0, 80)); return; }
    if (msg.type === "server/init") {
      serverInitText = text; // 原文原样,拼接进 prologue
      noise = asResponder({
        suite: "25519_ChaChaPoly_SHA256",
        localStaticPriv: clientPriv,
        remoteStaticPub: serverPub, // initiator(服务器)静态公钥
        prologue: new Uint8Array(Buffer.concat([Buffer.from(clientInitText, "utf8"), Buffer.from(serverInitText, "utf8")])),
        psk,
      });
      console.log("[client] got server/init; noise responder ready");
    } else if (msg.type === "noise/handshake") {
      const msg1Ct = b64urlDecode(msg.payload.data);
      let payload;
      try { payload = noise.readMessage(msg1Ct); } catch (e) { console.error("[client] readMessage failed", e.message); ws.terminate(); return; }
      const msg2Ct = noise.writeMessage(new Uint8Array(0));
      sendCleartext({ type: "noise/handshake", payload: { data: b64urlEncode(msg2Ct) } });
      console.log("[client] handshake complete → msg2 sent, entering encrypted transport");
    }
    return;
  }
  // 加密期
  let plain;
  try { plain = Buffer.from(noise.decrypt(data)); } catch (e) { console.error("[client] transport decrypt fail", e.message); return; }
  if (plain.length === 0) return;
  const t = plain[0];
  if (t === BIN_JSON) {
    received.jsonMsgs++;
    const m = framing.unpackJsonBody(plain);
    if (m.type === "server/hello") {
      console.log("[client] server/hello:", JSON.stringify(m.payload));
      // 宣告角色:player(真实播放器) + controller + metadata
      const roles = ["player@v1", "controller@v1", "metadata@v1", "artwork@v1"];
      replyJson("client/hello", { name, supported_roles: roles, protocol_version: PROTOCOL_VERSION });
      console.log("[client] sent client/hello roles=", roles.join(","));
      activated = false; // 等 server/activate
    } else if (m.type === "server/activate") {
      activated = true;
      console.log("[client] === ACTIVATED roles=", m.payload?.active_roles?.join(",") ?? m.payload?.activities?.join(","));
    } else if (m.type === "server/state") {
      if (received.jsonMsgs % 10 === 0) console.log(`[client] server/state pos=${m.payload?.position_ms} group=${m.payload?.group?.id?.slice(0,8)}`);
    } else if (m.type === "server/time") {
      console.log("[client] server/time");
    } else {
      if (received.jsonMsgs < 8) console.log("[client] json msg:", m.type);
    }
  } else if (t === BIN_PLAYER_AUDIO) {
    received.audioChunks++;
    const { timestampUs, data: chunk } = framing.parseAudioChunk(plain);
    if (received.audioChunks % 50 === 0) console.log(`[client] audio chunks=${received.audioChunks} ts=${timestampUs} bytes=${chunk.length} active=${activated}`);
  } else {
    if (received.jsonMsgs + received.audioChunks < 20) console.log("[client] bin type", t);
  }
});

ws.on("error", (e) => { console.error("[client] ws error", e.message); });
ws.on("close", (c) => { console.log(`[client] closed code=${c} after audio=${received.audioChunks} json=${received.jsonMsgs}`); process.exit(0); });