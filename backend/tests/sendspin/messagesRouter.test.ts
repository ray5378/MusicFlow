// ==================== messages 路由注册补测 ====================
//
// 缺口:messages.ts 的 registerMessage（family.type 键写入 MessageActions）与
// MessageRouter.handlers getter 未覆盖。契约:
//   - registerMessage 写成 `${family}.${type}` 键，供 server 侧按「角色家族+类型」查表；
//   - handlers 返回已注册条数（健康检查/断言用）；
//   - MessageRouter.handle 未命中返回 false（不抛、不误吞），命中把 ctx 透传给 action。
import "../plugins/_env.js";
import { describe, it, expect } from "vitest";
import { MessageRouter, familyForType, registerMessage, type MessageActions } from "../../src/services/sendspin/messages.js";

describe("registerMessage(family.type 表)", () => {
  it("键 = `${family}.${type}`，值 = action；可直接调用", () => {
    const router: MessageActions = {};
    let got: any = null;
    registerMessage(router, "client", "hello", (p, ctx) => {
      got = { p, ctx };
    });
    expect(Object.keys(router)).toEqual(["client.hello"]);
    router["client.hello"]({ n: 1 }, { srv: "x" });
    expect(got).toEqual({ p: { n: 1 }, ctx: { srv: "x" } });
  });

  it("同 family 不同 type 互不覆盖；异步 action 同样登录", async () => {
    const router: MessageActions = {};
    const hits: string[] = [];
    registerMessage(router, "server", "time", () => hits.push("time"));
    registerMessage(router, "server", "state", async () => hits.push("state"));
    expect(Object.keys(router).sort()).toEqual(["server.state", "server.time"]);
    await router["server.state"](null, null);
    router["server.time"](null, null);
    expect(hits).toEqual(["state", "time"]);
  });
});

describe("MessageRouter", () => {
  it("handlers getter 反映注册数量（初始 0）", () => {
    const r = new MessageRouter();
    expect(r.handlers).toBe(0);
    r.register("client", "hello", () => {});
    expect(r.handlers).toBe(1);
    r.register("client", "hello", () => {}); // 同类型覆盖，不增长
    expect(r.handlers).toBe(1);
    r.register("client", "bye", () => {});
    expect(r.handlers).toBe(2);
  });

  it("handle 命中返回 true 并透传构造期 ctx；未命中返回 false", async () => {
    const ctx = { srv: "S" };
    const r = new MessageRouter(ctx);
    let seen: any = null;
    r.register("client", "cmd", (p, c) => {
      seen = { p, c };
    });
    expect(await r.handle("client/cmd", { a: 1 })).toBe(true);
    expect(seen).toEqual({ p: { a: 1 }, c: ctx });
    expect(await r.handle("client/missing", {})).toBe(false);
  });

  it("familyForType 取首个 '/' 前缀（无分隔符时原样返回）", () => {
    expect(familyForType("client/hello")).toBe("client");
    expect(familyForType("noSlash")).toBe("noSlash");
    expect(familyForType("a/b/c")).toBe("a");
  });
});
