// Unit tests for the plugin Host context (`host.*`): the permission model and
// the call-site gating that the host enforces on behalf of the plugin.
import { describe, it, expect, afterEach } from "vitest";
import {
  KNOWN_PERMISSIONS,
  validatePermissions,
  hasPermission,
  requirePermission,
  createPluginHost,
} from "../../src/plugins/host.js";
import { resetComm } from "../../src/plugins/comm.js";
import type { PluginManifest } from "../../src/plugins/types.js";

afterEach(() => resetComm());

describe("validatePermissions", () => {
  it("accepts missing / empty permissions", () => {
    expect(validatePermissions(undefined)).toBeNull();
    expect(validatePermissions(null)).toBeNull();
    expect(validatePermissions([])).toBeNull();
  });

  it("rejects a non-array", () => {
    expect(validatePermissions("net")).toMatch(/数组/);
  });

  it("rejects non-string entries", () => {
    expect(validatePermissions(["net", 1])).toMatch(/非字符串/);
  });

  it("accepts every known exact permission", () => {
    for (const p of KNOWN_PERMISSIONS) {
      expect(validatePermissions([p])).toBeNull();
    }
  });

  it("rejects an unknown permission", () => {
    expect(validatePermissions(["bogus-perm"])).toMatch(/未知权限/);
  });

  it("accepts namespace wildcards derived from known namespaces", () => {
    // songs.* / playlists.* / fs.* all map to a real namespace.
    expect(validatePermissions(["songs.*"])).toBeNull();
    expect(validatePermissions(["playlists.*"])).toBeNull();
    expect(validatePermissions(["fs.*"])).toBeNull();
    // A wildcard for a totally unknown namespace is still rejected.
    expect(validatePermissions(["nope.*"])).toMatch(/未知权限/);
  });

  it("accepts the global grant", () => {
    expect(validatePermissions(["*"])).toBeNull();
  });
});

describe("hasPermission / requirePermission", () => {
  const manifest: PluginManifest = {
    id: "p", name: "p", version: "1", type: "lyrics", capabilities: ["lyricProvider"],
    configSchema: [], permissions: ["songs:read", "songs.*", "playlists:read"],
  };
  const host = createPluginHost(manifest, {}, "dev");

  it("matches an exact permission", () => {
    expect(hasPermission(host, "songs:read")).toBe(true);
    expect(hasPermission(host, "net")).toBe(false);
  });

  it("matches a namespace wildcard for a sub-permission", () => {
    expect(hasPermission(host, "songs:write")).toBe(true); // granted via songs.*
    expect(hasPermission(host, "playlists:read")).toBe(true); // exact grant
  });

  it("requirePermission throws only when ungranted", () => {
    expect(() => requirePermission(host, "songs:read")).not.toThrow();
    expect(() => requirePermission(host, "net")).toThrow(/缺少权限/);
  });

  it("global * grant covers every permission", () => {
    const star = createPluginHost({ ...manifest, permissions: ["*"] }, {}, "dev");
    expect(hasPermission(star, "net")).toBe(true);
    expect(hasPermission(star, "anything:at-all")).toBe(true);
  });
});

describe("createPluginHost", () => {
  it("exposes a controlled surface (no backend internals)", () => {
    const manifest: PluginManifest = {
      id: "lyr", name: "Lyr", version: "1", type: "lyrics", capabilities: ["lyricProvider"],
      configSchema: [],
    };
    const host = createPluginHost(manifest, { baseUrl: "x" }, "1.2.3");
    expect(host.pluginId).toBe("lyr");
    expect(host.version).toBe("1.2.3");
    expect(host.config).toEqual({ baseUrl: "x" });
    expect(typeof host.log).toBe("function");
    expect(typeof host.storage.get).toBe("function");
    expect(typeof host.http).toBe("function");
    expect(host.comm.id).toBe("lyr");
  });

  it("gates host.http behind the `net` permission", async () => {
    const noNet: PluginManifest = {
      id: "a", name: "a", version: "1", type: "lyrics", capabilities: ["lyricProvider"], configSchema: [],
    };
    const gated = createPluginHost(noNet, {}, "dev");
    await expect(gated.http("https://example.com")).rejects.toThrow(/缺少权限/);

    const withNet: PluginManifest = {
      id: "b", name: "b", version: "1", type: "lyrics", capabilities: ["lyricProvider"],
      configSchema: [], permissions: ["net"],
    };
    const ok = createPluginHost(withNet, {}, "dev");
    const orig = globalThis.fetch;
    (globalThis as any).fetch = async () => ({ ok: true, status: 200, json: async () => ({}) });
    try {
      const res = await ok.http("https://example.com");
      expect(res).toBeTruthy();
    } finally {
      globalThis.fetch = orig;
    }
  });

  it("gates host.comm.send/broadcast behind `inter-plugin`", () => {
    const noComm: PluginManifest = {
      id: "c", name: "c", version: "1", type: "lyrics", capabilities: ["lyricProvider"], configSchema: [],
    };
    const gated = createPluginHost(noComm, {}, "dev");
    expect(() => gated.comm.send("other", { hi: 1 })).toThrow(/inter-plugin/);
    expect(() => gated.comm.broadcast({ hi: 1 })).toThrow(/inter-plugin/);
  });
});
