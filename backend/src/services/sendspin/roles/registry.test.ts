import { describe, it, expect, afterEach } from "vitest";
import "./index.js"; // 装配注册副作用
import { roleFamily, sortRoleIds, negotiateRoles, ROLE_IDS } from "./registry.js";

describe("role registry", () => {
  afterEach(() => {});

  it("装配后注册了七角色", () => {
    expect(ROLE_IDS.length).toBeGreaterThanOrEqual(7);
  });

  it("role_family = id.split('@')[0]", () => {
    expect(roleFamily("player@v1")).toBe("player");
  });

  it("激活序: player 先于 controller, 其余按 client 序", () => {
    // 注册 player + controller + metadata + color 缺一不可,故先注册全部常见角色
    const client = ["color@v1", "controller@v1", "metadata@v1", "player@v1"];
    const negotiated = negotiateRoles(client);
    expect(negotiated).toEqual(["player@v1", "controller@v1", "color@v1", "metadata@v1"]);
  });

  it("server 未注册的 family 不激活", () => {
    expect(negotiateRoles(["player@v1"])).toEqual(["player@v1"]);
  });

  it("ROLE_IDS 覆盖七角色", () => {
    expect(ROLE_IDS.length).toBeGreaterThanOrEqual(7);
    expect(ROLE_IDS).toContain("player@v1");
    expect(ROLE_IDS).toContain("controller@v1");
    expect(ROLE_IDS).toContain("source@v1");
  });
});