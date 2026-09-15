import { describe, it, expect } from "vitest";
import { pickInstanceConnections } from "../../src/services/ws/index.js";

// Web / HA 遥控本机实例(安卓 / Windows / 其它浏览器标签页)的**定向投递**语义。
// 这是「点一下切到另一台客户端并遥控它」链路的最底一环:指令必须只落到目标实例,
// 绝不能被同账号的其它连接收到(网页标签页、另一台手机都在同一账号下)。
describe("本机实例定向投递 pickInstanceConnections", () => {
  const conn = (userId: string, clientId: string | null) =>
    ({ __user: { id: userId } as any, __clientId: clientId });

  it("精确命中同用户的同实例", () => {
    const a = conn("u1", "web-aaa");
    const b = conn("u1", "app-bbb");
    const c = conn("u2", "app-bbb");
    expect(pickInstanceConnections([a, b, c], "u1", "app-bbb")).toEqual([b]);
  });

  it("同账号的其它实例不被误伤(指令不串给网页标签页)", () => {
    const web = conn("u1", "web-aaa");
    const app = conn("u1", "app-bbb");
    const hit = pickInstanceConnections([web, app], "u1", "app-bbb");
    expect(hit).toContain(app);
    expect(hit).not.toContain(web);
  });

  it("跨用户绝不命中", () => {
    expect(pickInstanceConnections([conn("u2", "app-bbb")], "u1", "app-bbb")).toEqual([]);
  });

  it("缺失 clientId 时不做「发全部连接」的降级", () => {
    const noId = conn("u1", null);
    const withId = conn("u1", "web-aaa");
    // 目标没上报 clientId(旧格式 peerId local:<uid>)→ 宁可不投递
    expect(pickInstanceConnections([noId, withId], "u1", null)).toEqual([]);
    // 调用方没给出 userId → 同样空集
    expect(pickInstanceConnections([noId, withId], "", "web-aaa")).toEqual([]);
  });

  it("目标离线(无连接)返回空集,调用方据此回 delivered:false", () => {
    expect(pickInstanceConnections([], "u1", "web-aaa")).toEqual([]);
  });
});
