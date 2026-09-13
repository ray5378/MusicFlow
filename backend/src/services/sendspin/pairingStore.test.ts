// 配对记录存储 + token 解码。
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { PairingStore, pskIdForHex } from "./pairingStore.js";
import { decodePairingToken, deriveDynamicCode } from "./pairServer.js";
import { sha256 } from "@noble/hashes/sha256.js";

const b2h = (b: Uint8Array) => Buffer.from(b).toString("hex");

describe("PairingStore", () => {
  let dir: string;
  let store: PairingStore;
  beforeAll(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "sendspin-pstore-"));
    store = await PairingStore.open(dir);
  });
  afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

  it("put/get/remove 记录 + psk_id 公式", async () => {
    const psk = "e0".repeat(32);
    const rec = await store.putRecord("clientA", psk);
    expect(rec.pskId.length).toBe(43);
    // psk_id = b64url(sha256("sendspin-psk-id-v1" || psk)),与 aiosendspin 一致
    const want = Buffer.from(sha256(new Uint8Array([...Buffer.from("sendspin-psk-id-v1", "utf8"), ...Buffer.from(psk, "hex")]))).toString("base64url");
    expect(rec.pskId).toBe(want);
    expect(pskIdForHex(psk)).toBe(want);
    expect(store.getRecord("clientA")?.pskHex).toBe(psk);
    await new Promise((r) => setTimeout(r, 300)); // 等防抖落盘
    const reopened = await PairingStore.open(dir);
    expect(reopened.getRecord("clientA")?.pskHex).toBe(psk);
    expect(await store.removeRecord("clientA")).toBe(true);
    expect(store.getRecord("clientA")).toBeUndefined();
  });

  it("未配对批准 set/list/撤销", async () => {
    expect(store.isApproved("c1")).toBe(false);
    await store.setApproved("c1", true);
    expect(store.isApproved("c1")).toBe(true);
    expect(store.listApproved().map((x) => x.clientId)).toContain("c1");
    await store.setApproved("c1", false);
    expect(store.isApproved("c1")).toBe(false);
  });
});

describe("decodePairingToken", () => {
  it("spec 参考向量 SP:1… 解出 0xe0..0xf7", () => {
    const t = decodePairingToken("SP:14DQ6FY7E4XTOP9HJ5LV6Z3PO57YPD4XT6T97N5Y");
    expect(t?.version).toBe(1);
    const want = Array.from({ length: 24 }, (_, i) => 0xe0 + i);
    expect([...t!.code!]).toEqual(want);
  });

  it("SP:0 token 往返(client_key||psk),大小写/分隔符宽容", () => {
    const key = new Uint8Array(32).fill(0x11);
    const psk = new Uint8Array(32).fill(0x22);
    // 按 spec 编码:base32 无填充,2→9
    const raw = new Uint8Array([...key, ...psk]);
    let bits = 0;
    let acc = 0;
    let body = "";
    const ALPHA = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
    for (const byte of raw) {
      acc = (acc << 8) | byte;
      bits += 8;
      while (bits >= 5) {
        bits -= 5;
        body += ALPHA[(acc >> bits) & 31];
      }
    }
    if (bits > 0) body += ALPHA[(acc << (5 - bits)) & 31];
    const token = "sp:0" + body.replace(/2/g, "9").toLowerCase();
    const t = decodePairingToken("  " + token + " ");
    expect(t?.version).toBe(0);
    expect(b2h(t!.clientKey!)).toBe(b2h(key));
    expect(b2h(t!.pairingPsk!)).toBe(b2h(psk));
  });

  it("非法输入拒绝", () => {
    expect(decodePairingToken("")).toBeNull();
    expect(decodePairingToken("SP:9xxx")).toBeNull();
    expect(decodePairingToken("SP:0abc")).toBeNull(); // 过短
  });
});

describe("deriveDynamicCode", () => {
  it("确定性 + 6 位", () => {
    const h = new Uint8Array(32).fill(1);
    const a = new Uint8Array(32).fill(2);
    const b = new Uint8Array(32).fill(3);
    const c1 = deriveDynamicCode(h, a, b);
    expect(c1).toMatch(/^\d{6}$/);
    expect(deriveDynamicCode(h, a, b)).toBe(c1);
  });
});
