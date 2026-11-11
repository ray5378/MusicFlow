import { describe, expect, it } from "vitest";
import { buildSmbConfig, normalizeSmbPath } from "../../src/services/source/smbClient.js";
import { parseSongPath } from "../../src/utils/localSourceProbe.js";

describe("SMB 配置与路径归一", () => {
  it("归一共享内路径：反斜杠/重复斜杠/尾部斜杠统一成绝对 / 路径", () => {
    expect(normalizeSmbPath("\\Music\\Jay\\a.flac")).toBe("/Music/Jay/a.flac");
    expect(normalizeSmbPath("Music//a.flac")).toBe("/Music/a.flac");
    expect(normalizeSmbPath("/Music/Jay/")).toBe("/Music/Jay");
    expect(normalizeSmbPath("")).toBe("/");
    expect(normalizeSmbPath("/")).toBe("/");
  });

  it("buildSmbConfig 校验必填 host/share，并补默认端口/域/根路径", () => {
    expect(buildSmbConfig({})).toBeNull();
    expect(buildSmbConfig({ host: "192.168.1.2" })).toBeNull();
    expect(buildSmbConfig({ share: "Music" })).toBeNull();

    const cfg = buildSmbConfig({
      host: "\\\\192.168.1.2\\",
      share: "\\Music\\",
      username: "u",
      password: "p",
      root_path: "Media\\Lossless\\",
    });
    expect(cfg).toEqual({
      host: "192.168.1.2",
      share: "Music",
      port: 445,
      username: "u",
      password: "p",
      domain: "WORKGROUP",
      root_path: "/Media/Lossless",
    });
  });

  it("保留显式端口与域", () => {
    const cfg = buildSmbConfig({ host: "nas", share: "music", port: 1445, domain: "HOME" });
    expect(cfg?.port).toBe(1445);
    expect(cfg?.domain).toBe("HOME");
    expect(cfg?.root_path).toBe("/");
  });
});

describe("SMB 歌曲路径解析", () => {
  it("s:<sourceId>:<共享内路径> 解析为 smb 类型", () => {
    expect(parseSongPath("s:abc123:/Music/Jay/a.flac")).toEqual({
      type: "s",
      sourceId: "abc123",
      filePath: "/Music/Jay/a.flac",
    });
  });

  it("l:/w: 前缀解析不变（回归）", () => {
    expect(parseSongPath("l:src:/data/a.mp3")).toEqual({ type: "l", sourceId: "src", filePath: "/data/a.mp3" });
    expect(parseSongPath("w:src:/dav/a.mp3")).toEqual({ type: "w", sourceId: "src", filePath: "/dav/a.mp3" });
    expect(parseSongPath("bad-path")).toBeNull();
  });
});
