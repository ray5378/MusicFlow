import { describe, it, expect } from "vitest";
import {
  sanitizeClientId,
  buildLocalPeerId,
  clientIdOfLocalPeer,
  userIdOfLocalPeer,
  isOwnLocalPeer,
  resolveLocalPeerId,
  maskLocalPeerId,
  instanceKeyOfLocalPeer,
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

  it("maskLocalPeerId:真实行 → 对外的不可逆实例键(临时端 ID 不出服务端)", () => {
    const real = "local:u1:web-abc";
    const masked = maskLocalPeerId(real);
    // 输出里不含原 clientId,而是派生出的实例键 —— 同账号多实例因此可各占一行。
    expect(masked).not.toContain("web-abc");
    expect(masked).toMatch(/^local:u1:[0-9a-f]{12}$/);
    expect(masked).toBe(`local:u1:${instanceKeyOfLocalPeer(real)}`);
    // 旧格式(无 clientId)/ 非本机 peer 保持原样。
    expect(maskLocalPeerId("local:u1")).toBe("local:u1");
    expect(maskLocalPeerId("dlna:d1")).toBe("dlna:d1");
    expect(maskLocalPeerId("group:g1")).toBe("group:g1");
    expect(maskLocalPeerId("airplay:a1")).toBe("airplay:a1");
  });

  it("instanceKeyOfLocalPeer:同实例稳定、跨实例/跨账号可区分、旧格式无键", () => {
    const k = instanceKeyOfLocalPeer("local:u1:web-abc");
    expect(k).toMatch(/^[0-9a-f]{12}$/);
    expect(instanceKeyOfLocalPeer("local:u1:web-abc")).toBe(k);            // 稳定
    expect(instanceKeyOfLocalPeer("local:u1:web-xyz")).not.toBe(k);        // 不同实例不同
    expect(instanceKeyOfLocalPeer("local:u2:web-abc")).not.toBe(k);        // 不同账号不同
    expect(instanceKeyOfLocalPeer("local:u1")).toBe(null);                 // 旧格式无实例键
    expect(instanceKeyOfLocalPeer("dlna:d1")).toBe(null);
  });

  it("resolve 与 mask 可往返:对外实例键 → 真实行;查不到则退回本次 clientId", () => {
    const real = "local:u1:web-abc";
    const masked = maskLocalPeerId(real);
    // 入口:按实例键反查(模拟 PeerManager.resolveMaskedLocalPeerId)。
    const resolved = resolveLocalPeerId(masked, "u1", null, (uid, key) =>
      uid === "u1" && key === instanceKeyOfLocalPeer(real) ? real : null);
    expect(resolved).toBe(real);
    // 反查不到(实例已断线)→ 退回本次请求上报的 clientId 那行。
    expect(resolveLocalPeerId(masked, "u1", "web-zzz")).toBe("local:u1:web-zzz");
    // 不带反查函数时,带键的入参也退回本次 clientId(旧调用点行为不变)。
    expect(resolveLocalPeerId(masked, "u1", "web-zzz")).toBe("local:u1:web-zzz");
  });
});
