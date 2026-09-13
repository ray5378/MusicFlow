// pairServer 纯逻辑:方法名归一 + token 校验分支(不需要真实连接)。
import { describe, it, expect } from "vitest";
import { PairingCoordinator, normalizePairMethod, decodePairingToken } from "./pairServer.js";
import { PairingStore } from "./pairingStore.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

function b32enc(raw: Uint8Array): string {
  const ALPHA = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = 0;
  let acc = 0;
  let body = "";
  for (const byte of raw) {
    acc = (acc << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      body += ALPHA[(acc >> bits) & 31];
    }
  }
  if (bits > 0) body += ALPHA[(acc << (5 - bits)) & 31];
  return body.replace(/2/g, "9");
}

describe("normalizePairMethod", () => {
  it("spec 名与 9.x 短名都归一", () => {
    expect(normalizePairMethod("static_pairing_code")).toBe("static_pairing_code");
    expect(normalizePairMethod("static_pin")).toBe("static_pairing_code");
    expect(normalizePairMethod("dynamic_pairing_code")).toBe("dynamic_pairing_code");
    expect(normalizePairMethod("dynamic_pin")).toBe("dynamic_pairing_code");
    expect(normalizePairMethod("pairing_psk")).toBe("pairing_psk");
    expect(normalizePairMethod("nope")).toBeNull();
  });
});

describe("pairWithToken 校验", () => {
  it("非法 token / 身份不匹配被拒", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sendspin-pairneg-"));
    try {
      const store = await PairingStore.open(dir);
      const fakeServer: any = { clients: new Map([["cliA", { clientId: "cliA", legacy: false }]]), log: () => {} };
      const coord = new PairingCoordinator(fakeServer, store);
      await expect(coord.pairWithToken("cliA", "garbage")).rejects.toThrow();
      await expect(coord.pairWithToken("nope", "SP:0xxxx")).rejects.toThrow();
      // 合法 token 但 client_key 对不上
      const key = new Uint8Array(32).fill(0x33);
      const psk = new Uint8Array(32).fill(0x44);
      const token = "SP:0" + b32enc(new Uint8Array([...key, ...psk]));
      expect(decodePairingToken(token)?.version).toBe(0);
      await expect(coord.pairWithToken("cliA", token)).rejects.toThrow(/不匹配/);
      // legacy 连接直接拒
      fakeServer.clients.set("cliL", { clientId: "cliL", legacy: true });
      await expect(coord.pairWithToken("cliL", token)).rejects.toThrow(/legacy/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
