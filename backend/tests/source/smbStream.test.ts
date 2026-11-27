import { describe, it, expect, beforeAll } from "vitest";
import { createHmac } from "node:crypto";
import { sqlite } from "../../src/db/index.js";
import {
  mintSmbStreamUrl,
  resolveSmbStream,
  resetSmbStreamsForTest,
} from "../../src/services/source/smbStream.js";

// SMB → 回环 token：无状态签名 token，跨进程可验签；签名不符/过期/源不存在返回 null。
describe("smbStream（无状态签名 token）", () => {
  const SOURCE_ID = "smb-test-source";
  const SECRET = "test-secret-do-not-use";

  beforeAll(() => {
    process.env.MUSICFLOW_SMBSTREAM_SECRET = SECRET;
    resetSmbStreamsForTest();
    // 建一个 SMB 源行，供 resolveSmbStream 从 DB 读配置（media_sources / type / config）
    sqlite.prepare("INSERT OR REPLACE INTO media_sources (id, name, type, enabled, config, kind, created_at) VALUES (?,?,?,?,?,?,?)")
      .run(SOURCE_ID, "SMB", "smb", 1, JSON.stringify({
        host: "127.0.0.1", share: "music", username: "u", password: "p", domain: "WORKGROUP",
      }), "music", new Date().toISOString());
  });

  function tokenOf(url: string): string {
    return url.split("/rest/smbstream/")[1];
  }

  it("mint 出回环 URL，payload.签名 两段齐全", () => {
    const url = mintSmbStreamUrl(SOURCE_ID, {} as any, "/a b/歌.flac");
    expect(url).toMatch(/\/rest\/smbstream\/[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
  });

  it("mint → resolve 往返成功，路径归一、配置从 DB 读出", () => {
    const token = tokenOf(mintSmbStreamUrl(SOURCE_ID, {} as any, "\\a\\b\\song.flac"));
    const entry = resolveSmbStream(token);
    expect(entry).not.toBeNull();
    expect(entry!.sourceId).toBe(SOURCE_ID);
    expect(entry!.filePath).toContain("song.flac");
    expect(entry!.expiresAt).toBeGreaterThan(Date.now());
    expect(entry!.config.host).toBe("127.0.0.1");
    expect(entry!.config.share).toBe("music");
  });

  it("签名被篡改 → null", () => {
    const token = tokenOf(mintSmbStreamUrl(SOURCE_ID, {} as any, "/a.flac"));
    const dot = token.lastIndexOf(".");
    const tampered = token.slice(0, dot) + "." + ("X".repeat(Math.max(1, token.length - dot - 1)));
    expect(resolveSmbStream(tampered)).toBeNull();
  });

  it("畸形 token（无点号 / 空签名）→ null", () => {
    expect(resolveSmbStream("no-dot")).toBeNull();
    expect(resolveSmbStream(".")).toBeNull();
    expect(resolveSmbStream("payload.")).toBeNull();
  });

  it("payload 非 JSON → null", () => {
    const payload = Buffer.from("not json", "utf8").toString("base64url");
    const sig = createHmac("sha256", SECRET).update(payload).digest("base64url");
    expect(resolveSmbStream(`${payload}.${sig}`)).toBeNull();
  });

  it("不存在的源 → null", () => {
    const token = tokenOf(mintSmbStreamUrl("smb-missing", {} as any, "/a.flac"));
    expect(resolveSmbStream(token)).toBeNull();
  });

  it("resetSmbStreamsForTest 是 no-op（无状态 token 无内存状态可清）", () => {
    expect(() => { resetSmbStreamsForTest(); resetSmbStreamsForTest(); }).not.toThrow();
  });
});
