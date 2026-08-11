// Unit tests for the inter-plugin communication bus: on/off subscription,
// targeted send, broadcast, and the `inter-plugin` permission gate.
import { describe, it, expect, afterEach } from "vitest";
import { createComm, resetComm } from "../../src/plugins/comm.js";

afterEach(() => resetComm());

describe("comm bus", () => {
  it("delivers a targeted send to the recipient's listener only", () => {
    const a = createComm("plugin-a", ["inter-plugin"]);
    const b = createComm("plugin-b", ["inter-plugin"]);
    const received: any[] = [];
    b.on((m) => received.push(m));
    a.send("plugin-b", { hello: "b" });
    expect(received).toEqual([{ hello: "b" }]);
  });

  it("broadcast reaches every other listener but not the sender", () => {
    const a = createComm("plugin-a", ["inter-plugin"]);
    const b = createComm("plugin-b", ["inter-plugin"]);
    const c = createComm("plugin-c", ["inter-plugin"]);
    const got: string[] = [];
    b.on((m) => got.push(`b:${m.v}`));
    c.on((m) => got.push(`c:${m.v}`));
    a.broadcast({ v: 1 });
    expect(got.sort()).toEqual(["b:1", "c:1"]);
  });

  it("stops delivering after off()", () => {
    const a = createComm("plugin-a", ["inter-plugin"]);
    const b = createComm("plugin-b", ["inter-plugin"]);
    const received: any[] = [];
    const h = (m: any) => received.push(m);
    b.on(h);
    a.send("plugin-b", 1);
    b.off(h);
    a.send("plugin-b", 2);
    expect(received).toEqual([1]);
  });

  it("a handler error is swallowed and does not break delivery", () => {
    const a = createComm("plugin-a", ["inter-plugin"]);
    const b = createComm("plugin-b", ["inter-plugin"]);
    const good: any[] = [];
    b.on(() => { throw new Error("boom"); });
    b.on((m) => good.push(m));
    expect(() => a.send("plugin-b", 7)).not.toThrow();
    expect(good).toEqual([7]);
  });

  it("blocks send/broadcast without the inter-plugin permission", () => {
    const a = createComm("plugin-a", []);
    const b = createComm("plugin-b", []);
    b.on(() => {});
    expect(() => a.send("plugin-b", 1)).toThrow(/inter-plugin/);
    expect(() => a.broadcast(1)).toThrow(/inter-plugin/);
  });

  it("tolerates sending to a plugin with no listeners", () => {
    const a = createComm("plugin-a", ["inter-plugin"]);
    expect(() => a.send("nobody", 1)).not.toThrow();
  });
});
