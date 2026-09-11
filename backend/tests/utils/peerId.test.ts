import { describe, it, expect } from "vitest";
import {
  sanitizeClientId,
  buildLocalPeerId,
  clientIdOfLocalPeer,
  userIdOfLocalPeer,
  isOwnLocalPeer,
  resolveLocalPeerId,
  maskLocalPeerId,
} from "../../src/utils/peerId.js";

describe("临时端 ID 编解码(peerId)", () => {
  it("sanitizeClientId 只放行安全字符且有长度上限", () => {
    expect(sanitizeClientId("web-1a2b3c")).toBe("web-1a2b3c");
    expect(sanitizeClientId("A_b-9")).toBe("A_b-9");
    expect(sanitizeClientId("  web-abc  ")).toBe("web-abc");
    // 非法:含冒号(会撑坏 peerId 结构)、空串、超长、非字符串。
    expect(sanitizeClientId("web:abc")).toBe(null);
    expect(sanitizeClientId("")).toBe(null);
    expect(sanitizeClientId("x".repeat(33))).toBe(null);
    expect(sanitizeClientId(undefined)).toBe(null);
    expect(sanitizeClientId(123)).toBe(null);
  });

  it("buildLocalPeerId:有 clientId 走新格式,缺省/非法退回旧格式", () => {
    expect(buildLocalPeerId("u1", "web-abc")).toBe("local:u1:web-abc");
    expect(buildLocalPeerId("u1")).toBe("local:u1");
    expect(buildLocalPeerId("u1", null)).toBe("local:u1");
    expect(buildLocalPeerId("u1", "bad:id")).toBe("local:u1");
  });

  it("user/clientId 解析:新旧格式都能拆对", () => {
    expect(userIdOfLocalPeer("local:u1")).toBe("u1");
    expect(userIdOfLocalPeer("local:u1:web-abc")).toBe("u1");
    expect(clientIdOfLocalPeer("local:u1")).toBe(null);
    expect(clientIdOfLocalPeer("local:u1:web-abc")).toBe("web-abc");
    expect(userIdOfLocalPeer("dlna:d1")).toBe(null);
    expect(clientIdOfLocalPeer("dlna:d1")).toBe(null);
  });

  it("isOwnLocalPeer:同账号任意实例算自己的,别人的不算", () => {
    expect(isOwnLocalPeer("local:u1", "u1")).toBe(true);
    expect(isOwnLocalPeer("local:u1:web-abc", "u1")).toBe(true);
    expect(isOwnLocalPeer("local:u2:web-abc", "u1")).toBe(false);
    // 前缀相同但 userId 不是完整段 → 不算(防 local:u1x 冒充 local:u1)。
    expect(isOwnLocalPeer("local:u1x:web-abc", "u1")).toBe(false);
    expect(isOwnLocalPeer("local:u1", "")).toBe(false);
  });

  it("resolveLocalPeerId:对外视角 → 真实行(仅本机 peer)", () => {
    // 客户端只发 local:u1,服务端换成自己那条真实行。
    expect(resolveLocalPeerId("local:u1", "u1", "web-abc")).toBe("local:u1:web-abc");
    expect(resolveLocalPeerId("local:u1", "u1", null)).toBe("local:u1");
    // 别人账号的本机播放器原样交给权限层拦(不做越权换算)。
    expect(resolveLocalPeerId("local:u2", "u1", "web-abc")).toBe("local:u2");
    // 非本机 peer 不受影响。
    expect(resolveLocalPeerId("dlna:d1", "u1", "web-abc")).toBe("dlna:d1");
    expect(resolveLocalPeerId("group:g1", "u1", "web-abc")).toBe("group:g1");
    // 未登录不换算。
    expect(resolveLocalPeerId("local:u1", "", "web-abc")).toBe("local:u1");
  });

  it("maskLocalPeerId:真实行 → 对外视角(临时端 ID 不出服务端)", () => {
    expect(maskLocalPeerId("local:u1:web-abc")).toBe("local:u1");
    expect(maskLocalPeerId("local:u1")).toBe("local:u1");
    expect(maskLocalPeerId("dlna:d1")).toBe("dlna:d1");
    expect(maskLocalPeerId("group:g1")).toBe("group:g1");
    expect(maskLocalPeerId("airplay:a1")).toBe("airplay:a1");
  });

  it("resolve 与 mask 互为往返(同一个端点来回一趟不变形状)", () => {
    const canonical = "local:u1";
    const real = resolveLocalPeerId(canonical, "u1", "web-abc");
    expect(real).toBe("local:u1:web-abc");
    expect(maskLocalPeerId(real)).toBe(canonical);
  });
});
