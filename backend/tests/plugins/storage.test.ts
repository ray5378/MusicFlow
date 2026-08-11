// Unit tests for the plugin-scoped KV storage: JSON round-trip, key listing,
// deletion, and strict per-plugin isolation.
import { describe, it, expect, beforeAll } from "vitest";
import { initDatabase } from "../../src/db/index.js";
import { makeScopedStorage, pluginStorage } from "../../src/plugins/storage.js";

beforeAll(() => initDatabase());

describe("plugin storage", () => {
  it("round-trips JSON values for a single plugin", async () => {
    const s = makeScopedStorage("store-a");
    await s.set("count", 3);
    await s.set("obj", { a: [1, 2, 3], b: "hi" });
    expect(await s.get("count")).toBe(3);
    expect(await s.get("obj")).toEqual({ a: [1, 2, 3], b: "hi" });
  });

  it("returns null for a missing key", async () => {
    const s = makeScopedStorage("store-a");
    expect(await s.get("does-not-exist")).toBeNull();
  });

  it("lists and deletes keys", async () => {
    const s = makeScopedStorage("store-b");
    await s.set("k1", 1);
    await s.set("k2", 2);
    expect((await s.keys()).sort()).toEqual(["k1", "k2"]);
    await s.delete("k1");
    expect(await s.keys()).toEqual(["k2"]);
  });

  it("isolates plugins from each other", async () => {
    const a = makeScopedStorage("iso-a");
    const b = makeScopedStorage("iso-b");
    await a.set("shared", "from-a");
    await b.set("shared", "from-b");
    expect(await a.get("shared")).toBe("from-a");
    expect(await b.get("shared")).toBe("from-b");
    expect(await a.keys()).toEqual(["shared"]);
  });

  it("clears a plugin's storage without touching others", async () => {
    const a = makeScopedStorage("clr-a");
    const b = makeScopedStorage("clr-b");
    await a.set("x", 1);
    await b.set("x", 2);
    await pluginStorage.clearPlugin("clr-a");
    expect(await a.get("x")).toBeNull();
    expect(await b.get("x")).toBe(2);
  });
});
