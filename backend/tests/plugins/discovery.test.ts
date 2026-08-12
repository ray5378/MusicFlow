import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import {
  validateManifest,
  compareVersion,
  isAppVersionCompatible,
  safeResolve,
  discoverExternalPlugins,
} from "../../src/plugins/discovery.js";
import { registerPlugin, getPlugin } from "../../src/plugins/registry.js";

const tmp = path.join(os.tmpdir(), `mfv2-plugins-${Date.now()}-${Math.floor(Math.random() * 1e6)}`);

function writePlugin(id: string, body: string) {
  const dir = path.join(tmp, id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "index.js"), body, "utf8");
}

beforeAll(() => {
  fs.mkdirSync(tmp, { recursive: true });

  // 1) A fully valid importer plugin (QuickJS 沙箱契约)。
  writePlugin(
    "valid-plugin",
    `globalThis.__mfPlugin = {
      manifest: {
        id: "valid-plugin",
        name: "Valid Plugin",
        version: "1.0.0",
        type: "importer",
        description: "a valid test plugin",
        capabilities: ["playlistImport"],
        configSchema: [],
      },
      create() { return { canHandle: () => false, fetchPlaylist: async () => ({}) }; },
    };`,
  );

  // 2) Invalid manifest (illegal capability + bad id via missing field).
  writePlugin(
    "badmanifest",
    `globalThis.__mfPlugin = {
      manifest: {
        id: "badmanifest",
        name: "Bad",
        version: "1.0.0",
        type: "importer",
        capabilities: ["notARealCapability"],
        configSchema: [],
      },
      create() { return {}; },
    };`,
  );

  // 3) Requires a newer app than what we'll scan with.
  writePlugin(
    "oldversion",
    `globalThis.__mfPlugin = {
      manifest: {
        id: "oldversion",
        name: "Old Version",
        version: "1.0.0",
        type: "importer",
        capabilities: ["playlistImport"],
        minAppVersion: "2.0.0",
        configSchema: [],
      },
      create() { return {}; },
    };`,
  );

  // 4) Conflicts with an already-registered id.
  writePlugin(
    "conflict-plugin",
    `globalThis.__mfPlugin = {
      manifest: {
        id: "conflict-plugin",
        name: "Conflict",
        version: "1.0.0",
        type: "importer",
        capabilities: ["playlistImport"],
        configSchema: [],
      },
      create() { return {}; },
    };`,
  );

  // 5) A plain file (not a directory) — discovery should skip it.
  fs.writeFileSync(path.join(tmp, "not-a-dir.js"), "export const x = 1;", "utf8");
});

afterAll(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("validateManifest", () => {
  it("accepts a well-formed manifest", () => {
    expect(
      validateManifest({
        id: "abc-1",
        name: "X",
        version: "1.0.0",
        type: "source",
        capabilities: ["search"],
        configSchema: [],
      }),
    ).toBeNull();
  });
  it("rejects missing / malformed id", () => {
    expect(validateManifest({ name: "X", version: "1", type: "source", capabilities: ["search"], configSchema: [] })).toMatch(/id/);
    expect(validateManifest({ id: "-bad", name: "X", version: "1", type: "source", capabilities: ["search"], configSchema: [] })).toMatch(/id/);
    expect(validateManifest({ id: "has space", name: "X", version: "1", type: "source", capabilities: ["search"], configSchema: [] })).toMatch(/id/);
  });
  it("rejects illegal type", () => {
    expect(validateManifest({ id: "p", name: "X", version: "1", type: "widget", capabilities: ["search"], configSchema: [] })).toMatch(/type/);
  });
  it("rejects empty / illegal capabilities", () => {
    expect(validateManifest({ id: "p", name: "X", version: "1", type: "source", capabilities: [], configSchema: [] })).toMatch(/capabilities/);
    expect(validateManifest({ id: "p", name: "X", version: "1", type: "source", capabilities: ["bogus"], configSchema: [] })).toMatch(/capabilities/);
  });
  it("rejects non-array configSchema", () => {
    expect(validateManifest({ id: "p", name: "X", version: "1", type: "source", capabilities: ["search"], configSchema: {} })).toMatch(/configSchema/);
  });
});

describe("compareVersion", () => {
  it("orders semver-ish strings", () => {
    expect(compareVersion("1.0.0", "1.0.0")).toBe(0);
    expect(compareVersion("1.2.0", "1.1.9")).toBeGreaterThan(0);
    expect(compareVersion("1.1.0", "1.2.0")).toBeLessThan(0);
    expect(compareVersion("2.0", "1.9.9")).toBeGreaterThan(0);
    expect(compareVersion("1.0", "1.0.1")).toBeLessThan(0);
  });
});

describe("isAppVersionCompatible", () => {
  it("dev builds accept anything", () => {
    expect(isAppVersionCompatible({ id: "x", name: "x", version: "1", type: "source", capabilities: [], configSchema: [], minAppVersion: "99.0.0" }, "dev")).toBe(true);
  });
  it("missing minAppVersion is always compatible", () => {
    expect(isAppVersionCompatible({ id: "x", name: "x", version: "1", type: "source", capabilities: [], configSchema: [] }, "1.0.0")).toBe(true);
  });
  it("respects the floor", () => {
    const m = { id: "x", name: "x", version: "1", type: "source", capabilities: [], configSchema: [], minAppVersion: "1.5.0" };
    expect(isAppVersionCompatible(m, "1.5.0")).toBe(true);
    expect(isAppVersionCompatible(m, "1.4.9")).toBe(false);
    expect(isAppVersionCompatible(m, "2.0.0")).toBe(true);
  });
});

describe("safeResolve (path-traversal guard)", () => {
  it("keeps paths inside the root", () => {
    expect(safeResolve("/data/plugins", "my-plugin")).toBe(path.resolve("/data/plugins", "my-plugin", "index.js"));
  });
  it("rejects escape attempts", () => {
    expect(safeResolve("/data/plugins", "../evil")).toBeNull();
    expect(safeResolve("/data/plugins", "../../etc")).toBeNull();
  });
});

describe("discoverExternalPlugins", () => {
  it("loads valid plugins, skips invalid / too-old / conflicting / non-dir", async () => {
    // Pre-register a conflicting id so the conflict guard triggers.
    registerPlugin(
      { id: "conflict-plugin", name: "Builtin", version: "1", type: "importer", capabilities: ["playlistImport"], configSchema: [] },
      {},
    );

    const loaded = await discoverExternalPlugins("1.0.0", tmp);
    expect(loaded).toBe(1); // only valid-plugin
    expect(getPlugin("valid-plugin")).toBeDefined();
    expect(getPlugin("badmanifest")).toBeUndefined();
    expect(getPlugin("oldversion")).toBeUndefined(); // needs 2.0.0
    expect(getPlugin("conflict-plugin")).toBeDefined(); // the pre-registered builtin wins
  });

  it("returns 0 when the root is absent", async () => {
    expect(await discoverExternalPlugins("1.0.0", path.join(os.tmpdir(), "does-not-exist-xyz"))).toBe(0);
  });
});
