import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { rmSync } from "node:fs";
import { loadOrCreateIdentity, type Identity } from "./identity.js";
import { b64urlDecode } from "./util.js";

const DIR = "/tmp/mf-sendspin-test";

describe("identity", () => {
  let id: Identity;
  beforeEach(async () => {
    rmSync(DIR, { recursive: true, force: true });
    id = await loadOrCreateIdentity(DIR);
  });
  afterEach(() => rmSync(DIR, { recursive: true, force: true }));

  it("生成 32 字节 X25519 私钥与 43 字符公钥 id", () => {
    expect(id.privateKey.length).toBe(32);
    expect(id.serverId.length).toBe(43);
    expect(b64urlDecode(id.serverId).length).toBe(32);
  });
  it("二次加载复用同一身份(持久化)", async () => {
    const again = await loadOrCreateIdentity(DIR);
    expect(again.privateKey).toEqual(id.privateKey);
    expect(again.serverId).toBe(id.serverId);
  });
});