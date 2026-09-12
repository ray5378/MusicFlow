import { promises as fs } from "node:fs";
import path from "node:path";
import { x25519 } from "@noble/curves/ed25519.js";
import { b64urlEncode } from "./util.js";

export interface Identity {
  privateKey: Uint8Array; // 32B
  serverId: string; // b64url(x25519.getPublicKey(priv)) = 43 chars
}

const SECRET_PREFIX = "SPKEY1:"; // 见于文件头,便于兼容迁移

export async function loadOrCreateIdentity(dir: string): Promise<Identity> {
  const file = path.join(dir, "sendspin", "identity.key");
  await fs.mkdir(path.dirname(file), { recursive: true });
  try {
    const raw = await fs.readFile(file);
    const start =
      raw[0] === 0x53 /*'S'*/ ? raw.indexOf(Buffer.from("\n", "ascii")) + 1 : 0;
    const priv = new Uint8Array(raw.subarray(start, start + 32));
    if (priv.length !== 32) throw new Error("bad key");
    return fromPrivate(priv);
  } catch {
    const priv = x25519.utils.randomSecretKey();
    await fs.writeFile(
      file,
      Buffer.concat([Buffer.from(SECRET_PREFIX + "\n", "ascii"), Buffer.from(priv)]),
      { mode: 0o600 },
    );
    return fromPrivate(priv);
  }
}

function fromPrivate(priv: Uint8Array): Identity {
  const pub = x25519.getPublicKey(priv);
  return { privateKey: priv, serverId: b64urlEncode(pub) };
}