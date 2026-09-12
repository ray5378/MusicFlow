import { describe, it, expect } from "vitest";
import { MessageRouter, familyForType } from "./messages.js";

describe("message router", () => {
  it("family = type.split('.')[0]", () => {
    expect(familyForType("client/hello")).toBe("client");
    expect(familyForType("server/time")).toBe("server");
  });

  it("按类型派发并可返回未命中", async () => {
    const r = new MessageRouter();
    let called = "";
    r.register("client", "hello", (p) => {
      called = p.name;
    });
    await r.handle("client/hello", { name: "x" });
    expect(called).toBe("x");
    expect(await r.handle("client/other", {})).toBe(false);
  });
});